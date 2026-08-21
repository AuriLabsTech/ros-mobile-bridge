// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * Teardown settle before the socket close.
 *
 * `disconnect()` drains the control-priority outbox before closing, and that
 * drain is what carries a release-the-joystick zero Twist to the robot on the
 * way out. Up to 0.1.10 the drain and the close landed in the same tick.
 * `rosbridge_server` discards ops it has received but not yet processed when
 * the connection goes away, so any slow op the consumer wrote just in front of
 * the drain -- an `unsubscribe` is the measured case -- was enough to leave the
 * safety publish unprocessed. The failure has the worst shape a teleop app
 * has: the last instruction the robot received is "keep moving".
 *
 * Measured on a rig and then isolated with no client library in the path:
 * drain-then-close loses the zero 3/3, and 20 ms of settle keeps it 3/3.
 *
 * These tests pin that the close waits, that the drain is on the wire before
 * it does, and that a teardown with nothing at risk still closes immediately.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import { RosbridgeClient } from '../src/RosbridgeClient';
import {
  installMockWebSocket,
  withFakeTimers,
  type MockWebSocketHandle,
  type MockWebSocket,
} from './_helpers/mock-websocket';

const TWIST = 'geometry_msgs/msg/Twist';

/** The measured settle. Kept in step with TEARDOWN_SETTLE_MS in the client. */
const SETTLE_MS = 20;

describe('RosbridgeClient — settle between the teardown drain and the close', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  async function connectedClient(): Promise<{
    client: RosbridgeClient;
    socket: MockWebSocket;
  }> {
    const client = new RosbridgeClient();
    const promise = client.connect('ws://localhost:9090');
    const socket = ws.last();
    socket.simulateOpen();
    await promise;
    return { client, socket };
  }

  function publishedTopics(socket: MockWebSocket): string[] {
    return socket.sentJson.filter((m) => m.op === 'publish').map((m) => m.topic as string);
  }

  it('holds the socket open until the drain has had time to be processed', async () => {
    await withFakeTimers(async () => {
      const { client, socket } = await connectedClient();
      client.publish('/cmd_vel', TWIST, { linear: { x: 0.5 } }, { priority: 'control' });

      const teardown = client.disconnect();

      // The drain is already on the wire, and the socket is still open: this
      // is the window the server needs and never had.
      expect(publishedTopics(socket)).toContain('/cmd_vel');
      expect(socket.readyState).toBe(1);

      await vi.advanceTimersByTimeAsync(SETTLE_MS);
      await teardown;

      expect(socket.readyState).toBe(3);
    });
  });

  it('the settle does not cost the drain: every control topic is written before the close', async () => {
    await withFakeTimers(async () => {
      const { client, socket } = await connectedClient();
      for (const topic of ['/cmd_vel', '/robot2/cmd_vel', '/robot3/cmd_vel']) {
        client.publish(topic, TWIST, { linear: { x: 0.5 } }, { priority: 'control' });
      }

      const teardown = client.disconnect();
      const writtenBeforeClose = new Set(publishedTopics(socket));

      await vi.advanceTimersByTimeAsync(SETTLE_MS);
      await teardown;

      expect(writtenBeforeClose).toEqual(
        new Set(['/cmd_vel', '/robot2/cmd_vel', '/robot3/cmd_vel']),
      );
    });
  });

  it('a teardown that drained nothing closes immediately', async () => {
    await withFakeTimers(async () => {
      const { client, socket } = await connectedClient();
      client.subscribe('/state', () => {});

      // Nothing control-priority was ever published, so nothing is at risk and
      // there is nothing to wait for. No timer advance here on purpose: this
      // resolves on microtasks or the test times out.
      await client.disconnect();

      expect(socket.readyState).toBe(3);
    });
  });

  it('an involuntary close is not delayed: only the intentional teardown settles', async () => {
    await withFakeTimers(async () => {
      const { client, socket } = await connectedClient();
      client.publish('/cmd_vel', TWIST, { linear: { x: 0.5 } }, { priority: 'control' });

      const statuses: string[] = [];
      client.onStatusChange((s) => statuses.push(s));

      // The socket dies under us. There is no drain to protect, and delaying
      // here would only slow the reconnect down, so the status moves without
      // any timer having to run.
      socket.simulateClose(1006, 'connection lost');

      // The listener replays the current status on registration, so the last
      // entry is what the close produced, with no timer advance in between.
      expect(statuses[0]).toBe('connected');
      expect(statuses[statuses.length - 1]).not.toBe('connected');
    });
  });
});

describe('FoxgloveClient — teardown is deliberately not delayed', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  it('closes in the same tick as the drain, as it always has', async () => {
    const client = new FoxgloveClient();
    const promise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(
      JSON.stringify({ op: 'serverInfo', name: 'test-server', capabilities: ['publish'] }),
    );
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertise',
        channels: [
          {
            id: 1,
            topic: '/chatter',
            encoding: 'json',
            schemaName: 'std_msgs/msg/String',
            schema: '',
          },
        ],
      }),
    );
    await promise;

    client.ensureAdvertised('/cmd_vel', TWIST);
    client.publish('/cmd_vel', TWIST, { linear: { x: 0.5 } }, { priority: 'control' });

    // The settle is a rosbridge fix for a rosbridge behaviour: the server
    // discarding ops it has not yet processed. The same teardown row passed on
    // Foxglove on the rig that failed here, so this path is left alone rather
    // than given an unmeasured delay. Revisit only with a measurement.
    await client.disconnect();

    expect(socket.readyState).toBe(3);
  });
});
