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
import {
  disconnectUnderFakeTimers,
  installMockWebSocket,
  type MockWebSocketHandle,
} from './_helpers/mock-websocket';

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

  it('after an unexpected drop, a subscribe made on reconnect before discovery answers goes out untyped, then typed once discovery names it', async () => {
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
      expect(await client.getAvailableTopics()).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_500);
      const socket2 = ws.last();
      expect(socket2).not.toBe(socket);
      socket2.simulateOpen();

      // No type from the lost connection: the same as right after a first connect.
      const frame = lastSubscribe(socket2);
      expect(frame.topic).toBe('/model/drone/pose');
      expect('type' in frame).toBe(false);
      const subscribeCount = (): number =>
        socket2.sentJson.filter((m) => m.op === 'subscribe').length;
      const before = subscribeCount();

      respondTopics(socket2, ['/model/drone/pose'], ['geometry_msgs/msg/PoseStamped']);
      await vi.advanceTimersByTimeAsync(0);
      expect(subscribeCount()).toBe(before + 1);
      const resent = lastSubscribe(socket2);
      expect(resent.topic).toBe('/model/drone/pose');
      expect(resent.type).toBe('geometry_msgs/msg/PoseStamped');

      await disconnectUnderFakeTimers(client);
    } finally {
      vi.useRealTimers();
    }
  });

  it('after an unexpected drop, a resubscribed topic missing from the first discovery answer gets its type at the next topics refresh', async () => {
    vi.useFakeTimers();
    try {
      const client = new RosbridgeClient({ discoveryRefreshMs: 30_000 });
      const p = client.connect('ws://localhost:9090');
      const socket = ws.last();
      socket.simulateOpen();
      await p;
      respondTopics(socket, ['/odom'], ['nav_msgs/msg/Odometry']);
      await flush();

      client.onStatusChange((s) => {
        if (s === 'connected') client.subscribe('/odom', () => {});
      });
      socket.simulateClose(1006, 'gone');
      await vi.advanceTimersByTimeAsync(1_500);
      const socket2 = ws.last();
      socket2.simulateOpen();
      await vi.advanceTimersByTimeAsync(0);
      // The robot is still starting: /odom has no publisher yet.
      respondTopics(socket2, ['/rosout'], ['rcl_interfaces/msg/Log']);
      await vi.advanceTimersByTimeAsync(0);
      expect('type' in lastSubscribe(socket2)).toBe(false);

      await vi.advanceTimersByTimeAsync(30_000);
      respondTopics(
        socket2,
        ['/odom', '/rosout'],
        ['nav_msgs/msg/Odometry', 'rcl_interfaces/msg/Log'],
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(lastSubscribe(socket2).type).toBe('nav_msgs/msg/Odometry');

      await disconnectUnderFakeTimers(client);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a topic discovery lists without a type still takes the consumer hint', async () => {
    const client = new RosbridgeClient();
    const p = client.connect('ws://localhost:9090');
    const socket = ws.last();
    socket.simulateOpen();
    await p;
    respondTopics(socket, ['/model/drone/pose'], []);
    await flush();

    client.subscribe('/model/drone/pose', () => {}, {
      schemaName: 'geometry_msgs/msg/PoseStamped',
    });
    expect(lastSubscribe(socket).type).toBe('geometry_msgs/msg/PoseStamped');
  });
});
