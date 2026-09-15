// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * `disconnect()` unadvertises every channel this client advertised, before it
 * closes the socket.
 *
 * This has been the behaviour since the first release and nothing pinned it,
 * which is the only reason this file exists. The cost of losing it is not
 * visible in any test that watches for a stuck value on the client side:
 * `foxglove_bridge` gives a client publisher `Lifespan: Infinite` and
 * `TRANSIENT_LOCAL` durability, so a client that closes without unadvertising
 * leaves a publisher on the robot's graph that never goes away, holding the
 * last sample it wrote. A node that starts minutes later and asks for durable
 * history reads that sample as if it were current. On a `/cmd_vel` channel
 * that sample is the operator's last stick position.
 *
 * Measured on a real graph, 2026-08-31: two clients disconnected without
 * unadvertising left the publisher count at 2 with nobody connected, and a
 * fresh `RELIABLE + TRANSIENT_LOCAL` subscriber read `linear.x: 0.446` more
 * than two minutes later, one latched sample per leaked publisher. An explicit
 * unadvertise cleared it within about 0.3 s. rosbridge cannot leak the same
 * way: its client publishers carry a 1 s `Lifespan`, so the sample expires
 * before any new subscriber finishes matching.
 *
 * The ordering assertion below matters as much as the frame itself. The zero
 * Twist that `disconnect()` publishes goes through the control outbox, and the
 * drain that flushes it must stay ahead of anything else the teardown sends.
 * Losing that drain zero is a safety property; leaking a publisher is a narrow
 * hygiene bug. Do not let a future edit trade the first for the second.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import {
  installMockWebSocket,
  type MockWebSocketHandle,
  type MockWebSocket,
} from './_helpers/mock-websocket';

const TWIST = 'geometry_msgs/msg/Twist';

describe('FoxgloveClient — teardown unadvertises before closing', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  async function connected(): Promise<{ client: FoxgloveClient; socket: MockWebSocket }> {
    const client = new FoxgloveClient();
    const promise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(
      JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: ['clientPublish'] }),
    );
    socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [] }));
    await promise;
    return { client, socket };
  }

  /** Every `unadvertise` op the client sent, in order. */
  function unadvertises(socket: MockWebSocket): Array<{ channelIds: number[] }> {
    return socket.sentJson.filter((m) => m.op === 'unadvertise') as Array<{
      channelIds: number[];
    }>;
  }

  /** The channel ids the client claimed, read off its own `advertise` ops. */
  function advertisedIds(socket: MockWebSocket): number[] {
    return socket.sentJson
      .filter((m) => m.op === 'advertise' && Array.isArray(m.channels))
      .flatMap((m) => (m.channels as Array<{ id: number }>).map((c) => c.id));
  }

  it('sends one batched unadvertise carrying every advertised channel', async () => {
    const { client, socket } = await connected();

    client.ensureAdvertised('/cmd_vel', TWIST);
    client.ensureAdvertised('/robot_2/cmd_vel', TWIST);
    const ids = advertisedIds(socket);
    expect(ids).toHaveLength(2);

    await client.disconnect();

    const frames = unadvertises(socket);
    // One frame, not one per channel: the op takes an array and the teardown
    // has every id in hand at once.
    expect(frames).toHaveLength(1);
    expect([...frames[0]!.channelIds].sort()).toEqual([...ids].sort());
  });

  it('sends it before closing the socket', async () => {
    const { client, socket } = await connected();
    client.ensureAdvertised('/cmd_vel', TWIST);

    await client.disconnect();

    expect(unadvertises(socket)).toHaveLength(1);
    expect(socket.readyState).toBe(3 /* CLOSED */);
  });

  it('sends it after the control-outbox drain, never before', async () => {
    // The zero Twist is queued by `safePublishZeroTwist()` and written by the
    // synchronous `flushControlOutbox('all')` that runs before `cleanup()`.
    // A binary MESSAGE_DATA frame on the wire ahead of the unadvertise is what
    // that ordering looks like from outside.
    const { client, socket } = await connected();
    // The drain zero only exists if a Twist actually went out this session,
    // which is what arms `safePublishZeroTwist()`.
    client.publish(
      '/cmd_vel',
      TWIST,
      { linear: { x: 0.4, y: 0, z: 0 }, angular: { x: 0, y: 0, z: 0 } },
      {
        priority: 'control',
      },
    );

    const before = socket.sentMessages.length;
    await client.disconnect();
    const after = socket.sentMessages.slice(before);

    const firstBinary = after.findIndex((m) => typeof m !== 'string');
    const firstUnadvertise = after.findIndex(
      (m) => typeof m === 'string' && m.includes('"unadvertise"'),
    );

    expect(firstBinary).toBeGreaterThanOrEqual(0);
    expect(firstUnadvertise).toBeGreaterThanOrEqual(0);
    expect(firstBinary).toBeLessThan(firstUnadvertise);
  });

  it('sends nothing when no channel was ever advertised', async () => {
    const { client, socket } = await connected();
    await client.disconnect();
    expect(unadvertises(socket)).toEqual([]);
  });

  it('does not re-unadvertise a channel the consumer already released', async () => {
    // `unadvertise(topic)` drops the topic from the advertised set before
    // sending its own single-id frame, so a widget that unmounts first is
    // simply no longer in the set the teardown reads.
    const { client, socket } = await connected();
    client.ensureAdvertised('/cmd_vel', TWIST);
    client.ensureAdvertised('/robot_2/cmd_vel', TWIST);
    const ids = advertisedIds(socket);

    client.unadvertise('/cmd_vel');
    await client.disconnect();

    const frames = unadvertises(socket);
    expect(frames).toHaveLength(2);
    expect(frames[0]!.channelIds).toEqual([ids[0]]);
    expect(frames[1]!.channelIds).toEqual([ids[1]]);
  });

  it('sends nothing when the socket is already gone', async () => {
    // An unexpected drop, as opposed to a `disconnect()`. There is no socket
    // to say goodbye on, so the leak this file is about is unavoidable on that
    // path by any client. Asserted so nobody later "fixes" it by writing to a
    // closed socket.
    const { client, socket } = await connected();
    client.ensureAdvertised('/cmd_vel', TWIST);

    socket.simulateClose(1006, 'abnormal');
    await client.disconnect();

    expect(unadvertises(socket)).toEqual([]);
  });
});
