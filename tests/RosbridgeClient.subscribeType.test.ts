// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * rosbridge subscribe type-string handling: when a topic is subscribed before
 * topic discovery has populated `discoveredTopics`, the message type is unknown.
 * The client must OMIT the `type` field rather than send `type:""` — a stock
 * `rosbridge_server` runs `get_message_class("")`, throws
 * InvalidTypeStringException, logs a rosout ERROR, and silently never
 * establishes the subscription (zero delivery, no self-heal until reconnect).
 * Omitting the field lets rosbridge resolve the type from the live publisher.
 * When the type IS known, it must still be sent verbatim.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RosbridgeClient } from '../src/RosbridgeClient';
import { installMockWebSocket, type MockWebSocketHandle } from './_helpers/mock-websocket';

type Socket = ReturnType<MockWebSocketHandle['last']>;

/** Respond to the most recent `/rosapi/topics` call on `socket`. */
function respondTopics(socket: Socket, names: string[], types: string[]): void {
  const calls = socket.sentJson.filter(
    (m) => m.op === 'call_service' && m.service === '/rosapi/topics',
  );
  const last = calls[calls.length - 1] as { id: string } | undefined;
  if (!last) throw new Error('no /rosapi/topics call to respond to');
  socket.simulateMessage(
    JSON.stringify({
      op: 'service_response',
      id: last.id,
      result: true,
      values: { topics: names, types },
    }),
  );
}

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

/** The most recent `subscribe` frame sent on `socket`. */
function lastSubscribe(socket: Socket): Record<string, unknown> {
  const subs = socket.sentJson.filter((m) => m.op === 'subscribe');
  const last = subs[subs.length - 1];
  if (!last) throw new Error('no subscribe frame sent');
  return last as Record<string, unknown>;
}

describe('RosbridgeClient — subscribe type string', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  it('omits `type` when subscribing before the topic type is discovered (startup race)', async () => {
    const client = new RosbridgeClient();
    const p = client.connect('ws://localhost:9090');
    const socket = ws.last();
    socket.simulateOpen();
    await p;

    // Subscribe immediately: discoveredTopics is still empty at this instant.
    client.subscribe('/model/drone/pose', () => {});

    const frame = lastSubscribe(socket);
    expect(frame.topic).toBe('/model/drone/pose');
    // The field must be absent — NOT present as an empty string. rosbridge
    // rejects `type:""` and silently drops the subscription.
    expect('type' in frame).toBe(false);
    expect(frame.type).not.toBe('');
  });

  it('includes `type` verbatim when the message type is already discovered', async () => {
    const client = new RosbridgeClient();
    const p = client.connect('ws://localhost:9090');
    const socket = ws.last();
    socket.simulateOpen();
    await p;

    respondTopics(socket, ['/model/drone/pose'], ['geometry_msgs/msg/PoseStamped']);
    await flush();

    client.subscribe('/model/drone/pose', () => {});

    const frame = lastSubscribe(socket);
    expect(frame.topic).toBe('/model/drone/pose');
    expect(frame.type).toBe('geometry_msgs/msg/PoseStamped');
  });

  it('after an unexpected drop, a subscribe made on reconnect before discovery answers carries the type the lost connection discovered', async () => {
    vi.useFakeTimers();
    try {
      const client = new RosbridgeClient();
      const p = client.connect('ws://localhost:9090');
      const socket = ws.last();
      socket.simulateOpen();
      await p;
      respondTopics(socket, ['/model/drone/pose'], ['geometry_msgs/msg/PoseStamped']);
      await flush();

      // Resubscribe on 'connected', as the onStatusChange TSDoc asks: discovery
      // for the new connection has not answered yet.
      client.onStatusChange((s) => {
        if (s === 'connected') client.subscribe('/model/drone/pose', () => {});
      });
      socket.simulateClose(1006, 'gone');
      // The lists themselves still empty at the drop.
      expect(await client.getAvailableTopics()).toEqual([]);
      // Long enough for the first reconnect attempt to time out: the type
      // outlives a failed attempt.
      await vi.advanceTimersByTimeAsync(20_000);
      const socket2 = ws.last();
      expect(socket2).not.toBe(socket);
      socket2.simulateOpen();

      const frame = lastSubscribe(socket2);
      expect(frame.topic).toBe('/model/drone/pose');
      expect(frame.type).toBe('geometry_msgs/msg/PoseStamped');

      const done = client.disconnect();
      await vi.advanceTimersByTimeAsync(5_000);
      await done;
    } finally {
      vi.useRealTimers();
    }
  });

  it("after an unexpected drop, a reconnect whose discovery answers with no topics forgets the lost connection's types", async () => {
    vi.useFakeTimers();
    try {
      const client = new RosbridgeClient();
      const p = client.connect('ws://localhost:9090');
      const socket = ws.last();
      socket.simulateOpen();
      await p;
      respondTopics(socket, ['/model/drone/pose'], ['geometry_msgs/msg/PoseStamped']);
      await flush();

      socket.simulateClose(1006, 'gone');
      await vi.advanceTimersByTimeAsync(1_500);
      const socket2 = ws.last();
      expect(socket2).not.toBe(socket);
      socket2.simulateOpen();
      // A different robot behind the same host, publishing nothing yet: every
      // bounded retry of the reconnect's discovery answers empty.
      for (let i = 0; i < 10; i++) {
        respondTopics(socket2, [], []);
        await vi.advanceTimersByTimeAsync(5_000);
      }

      client.subscribe('/model/drone/pose', () => {});
      expect('type' in lastSubscribe(socket2)).toBe(false);

      const done = client.disconnect();
      await vi.advanceTimersByTimeAsync(5_000);
      await done;
    } finally {
      vi.useRealTimers();
    }
  });
});
