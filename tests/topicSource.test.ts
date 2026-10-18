// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * `TopicInfo.source` is this client's own advertising, read whenever a topic
 * list is handed out, and the client's own advertising never fires
 * `onTopicsChange` (ADR 0029).
 *
 * On rosbridge the value used to be stored with the `/rosapi/topics` answer,
 * and a poll whose names and types had not moved kept the old list, so a
 * topic the robot already published stayed `'robot'` after this client began
 * publishing to it, and `'app'` after it stopped.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import { RosbridgeClient } from '../src/RosbridgeClient';
import type { TopicInfo } from '../src/types';
import { installMockWebSocket, type MockWebSocketHandle } from './_helpers/mock-websocket';

type Socket = ReturnType<MockWebSocketHandle['last']>;

const TWIST = 'geometry_msgs/msg/Twist';
const LOG = 'rcl_interfaces/msg/Log';

const sourceOf = (topics: TopicInfo[], topic: string): TopicInfo['source'] =>
  topics.find((t) => t.topic === topic)?.source;

describe('RosbridgeClient topic source (ADR 0029)', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  /** Answer the most recent `/rosapi/topics` call on `socket`. */
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

  async function listTopics(client: RosbridgeClient, socket: Socket): Promise<TopicInfo[]> {
    const pending = client.getAvailableTopics();
    respondTopics(socket, ['/cmd_vel', '/rosout'], [TWIST, LOG]);
    return pending;
  }

  async function connected(): Promise<{ client: RosbridgeClient; socket: Socket }> {
    const client = new RosbridgeClient();
    const promise = client.connect('ws://localhost:9090');
    const socket = ws.last();
    socket.simulateOpen();
    await promise;
    // On-connect discovery: the robot already publishes /cmd_vel.
    respondTopics(socket, ['/cmd_vel', '/rosout'], [TWIST, LOG]);
    await Promise.resolve();
    await Promise.resolve();
    return { client, socket };
  }

  it("reports 'app' once this client publishes to a topic the robot already lists", async () => {
    const { client, socket } = await connected();
    expect(sourceOf(await listTopics(client, socket), '/cmd_vel')).toBe('robot');

    client.publish('/cmd_vel', TWIST, { linear: { x: 0 } });

    expect(sourceOf(await listTopics(client, socket), '/cmd_vel')).toBe('app');
  });

  it("reports 'robot' again once this client unadvertises a topic the robot still lists", async () => {
    const { client, socket } = await connected();
    client.ensureAdvertised('/cmd_vel', TWIST);
    expect(sourceOf(await listTopics(client, socket), '/cmd_vel')).toBe('app');

    client.unadvertise('/cmd_vel');

    expect(sourceOf(await listTopics(client, socket), '/cmd_vel')).toBe('robot');
  });

  it('marks the cached list from its own publishing when the rosapi read fails', async () => {
    const { client, socket } = await connected();
    client.publish('/cmd_vel', TWIST, { linear: { x: 0 } });

    const pending = client.getAvailableTopics();
    const calls = socket.sentJson.filter(
      (m) => m.op === 'call_service' && m.service === '/rosapi/topics',
    );
    const last = calls[calls.length - 1] as { id: string };
    socket.simulateMessage(
      JSON.stringify({ op: 'service_response', id: last.id, result: false, values: 'rosapi gone' }),
    );

    expect(sourceOf(await pending, '/cmd_vel')).toBe('app');
  });

  it('does not fire onTopicsChange for its own publish, and the next graph change carries the fresh source', async () => {
    const { client, socket } = await connected();
    const seen: TopicInfo[][] = [];
    client.onTopicsChange((t) => seen.push(t));

    client.publish('/cmd_vel', TWIST, { linear: { x: 0 } });
    await listTopics(client, socket);
    expect(seen).toHaveLength(0);

    const pending = client.getAvailableTopics();
    respondTopics(socket, ['/cmd_vel', '/rosout', '/odom'], [TWIST, LOG, 'nav_msgs/msg/Odometry']);
    await pending;

    expect(seen).toHaveLength(1);
    expect(sourceOf(seen[0]!, '/cmd_vel')).toBe('app');
    expect(sourceOf(seen[0]!, '/odom')).toBe('robot');
  });
});

describe('FoxgloveClient topic source (ADR 0029)', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  it("reports 'app' on the next read after its own advertise, without firing onTopicsChange", async () => {
    const client = new FoxgloveClient();
    const seen: TopicInfo[][] = [];
    client.onTopicsChange((t) => seen.push(t));
    const promise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(
      JSON.stringify({
        op: 'serverInfo',
        name: 'm',
        capabilities: ['clientPublish'],
        supportedEncodings: ['json'],
      }),
    );
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertise',
        channels: [{ id: 1, topic: '/cmd_vel', encoding: 'cdr', schemaName: TWIST, schema: '' }],
      }),
    );
    await promise;
    expect(seen).toHaveLength(1);
    expect(sourceOf(await client.getAvailableTopics(), '/cmd_vel')).toBe('robot');

    client.ensureAdvertised('/cmd_vel', TWIST);
    expect(sourceOf(await client.getAvailableTopics(), '/cmd_vel')).toBe('app');

    client.unadvertise('/cmd_vel');
    expect(sourceOf(await client.getAvailableTopics(), '/cmd_vel')).toBe('robot');
    expect(seen).toHaveLength(1);
  });
});
