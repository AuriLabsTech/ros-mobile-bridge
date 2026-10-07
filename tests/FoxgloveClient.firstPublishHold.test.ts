// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * The first publish on a topic is held, and nothing overtakes it.
 *
 * On Foxglove the first `publish()` to a topic advertises a client channel and
 * holds the message for about 150 ms, so `foxglove_bridge` has created the ROS
 * publisher before data arrives. Up to 0.1.15 the topic counted as advertised
 * the moment the hold began, so a second publish inside the window went
 * straight to the wire, ahead of the held one, and a `disconnect()` inside the
 * window closed the socket with the held message still on its timer. A stop
 * published right after a move could be overtaken by the move; a stop
 * published as the first message of a fresh connection could be lost
 * (ADR 0018, 2026-10-07 amendment).
 *
 * The mock socket ignores every send after `close()`, so a frame present in
 * `sentMessages` is a frame that went out before the close.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import {
  installMockWebSocket,
  withFakeTimers,
  type MockWebSocketHandle,
  type MockWebSocket,
} from './_helpers/mock-websocket';

const TWIST = 'geometry_msgs/msg/Twist';
const MOVE = { linear: { x: 0.5, y: 0, z: 0 }, angular: { x: 0, y: 0, z: 0 } };
const ZERO = { linear: { x: 0, y: 0, z: 0 }, angular: { x: 0, y: 0, z: 0 } };

/** The first-publish hold in the client. */
const HOLD_MS = 150;

describe('FoxgloveClient — first-publish hold', () => {
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

  /** The JSON payloads of every MESSAGE_DATA frame the client sent, in order. */
  function payloads(socket: MockWebSocket): unknown[] {
    return socket.sentBinary
      .map((buf) => new DataView(buf))
      .filter((v) => v.getUint8(0) === 0x01)
      .map((v) => JSON.parse(new TextDecoder().decode(new Uint8Array(v.buffer, 5))));
  }

  it('still holds the first publish before it reaches the wire', async () => {
    await withFakeTimers(async () => {
      const { client, socket } = await connected();
      client.publish('/cmd_vel', TWIST, MOVE);

      await vi.advanceTimersByTimeAsync(HOLD_MS - 1);
      expect(payloads(socket)).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(payloads(socket)).toEqual([MOVE]);
    });
  });

  it('a second publish inside the window reaches the wire after the held one', async () => {
    await withFakeTimers(async () => {
      const { client, socket } = await connected();
      client.publish('/cmd_vel', TWIST, MOVE);
      client.publish('/cmd_vel', TWIST, ZERO);

      await vi.advanceTimersByTimeAsync(HOLD_MS);

      expect(payloads(socket)).toEqual([MOVE, ZERO]);
    });
  });

  it('a disconnect() inside the window sends the held message and the control queue before closing', async () => {
    await withFakeTimers(async () => {
      const { client, socket } = await connected();
      // A fresh connection: the consumer's stop is the first message on the
      // topic, so it is the held one. The control publish on a second,
      // already-advertised topic rides the outbox. Order across topics is not
      // promised (the outbox may flush on its own tick during the wait), only
      // that both are on the wire before the close.
      client.ensureAdvertised('/robot2/cmd_vel', TWIST);
      client.publish('/cmd_vel', TWIST, ZERO, { priority: 'control' });
      client.publish('/robot2/cmd_vel', TWIST, MOVE, { priority: 'control' });

      const teardown = client.disconnect();
      expect(socket.readyState).toBe(1);

      await vi.advanceTimersByTimeAsync(HOLD_MS);
      await teardown;

      expect(payloads(socket)).toHaveLength(2);
      expect(payloads(socket)).toEqual(expect.arrayContaining([ZERO, MOVE]));
      expect(socket.readyState).toBe(3);
    });
  });

  it('a stop published inside the window behind a move survives a disconnect() in the same window', async () => {
    await withFakeTimers(async () => {
      const { client, socket } = await connected();
      client.publish('/cmd_vel', TWIST, MOVE);
      client.publish('/cmd_vel', TWIST, ZERO, { priority: 'control' });

      const teardown = client.disconnect();
      await vi.advanceTimersByTimeAsync(HOLD_MS);
      await teardown;

      expect(payloads(socket)).toEqual([MOVE, ZERO]);
      expect(socket.readyState).toBe(3);
    });
  });

  it('disconnect() waits no longer than the rest of the hold', async () => {
    await withFakeTimers(async () => {
      const { client, socket } = await connected();
      client.publish('/cmd_vel', TWIST, ZERO);
      await vi.advanceTimersByTimeAsync(HOLD_MS - 10);

      const teardown = client.disconnect();
      await vi.advanceTimersByTimeAsync(10);
      await teardown;

      expect(payloads(socket)).toEqual([ZERO]);
      expect(socket.readyState).toBe(3);
    });
  });

  it('a hold cut short by a lost connection never fires into the next connection', async () => {
    await withFakeTimers(async () => {
      const { client, socket } = await connected();
      client.publish('/old_topic', TWIST, MOVE);
      socket.simulateClose(1006, 'connection lost');

      // The consumer reconnects at once. Channel ids restart at 1 on the new
      // connection, so a stale hold firing late would land MOVE on whatever
      // topic claims id 1 next.
      const reconnect = client.connect('ws://localhost:8765');
      const nextSocket = ws.last();
      expect(nextSocket).not.toBe(socket);
      nextSocket.simulateOpen('foxglove.websocket.v1');
      nextSocket.simulateMessage(
        JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: ['clientPublish'] }),
      );
      nextSocket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [] }));
      await reconnect;
      client.ensureAdvertised('/new_topic', TWIST);

      await vi.advanceTimersByTimeAsync(HOLD_MS);

      expect(payloads(socket)).toEqual([]);
      expect(payloads(nextSocket)).toEqual([]);
      await client.disconnect();
    });
  });
});
