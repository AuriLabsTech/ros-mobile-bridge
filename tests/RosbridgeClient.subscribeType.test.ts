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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RosbridgeClient } from '../src/RosbridgeClient';
import {
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

    respondTopics(
      socket,
      ['/model/drone/pose'],
      ['geometry_msgs/msg/PoseStamped'],
    );
    await flush();

    client.subscribe('/model/drone/pose', () => {});

    const frame = lastSubscribe(socket);
    expect(frame.topic).toBe('/model/drone/pose');
    expect(frame.type).toBe('geometry_msgs/msg/PoseStamped');
  });
});
