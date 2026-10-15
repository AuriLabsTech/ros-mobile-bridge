// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * Edge cases of `getTopicEndpoints` on Foxglove WebSocket: stale or false
 * evidence of the bridge's name, a lookup queued across a reconnect, and an
 * advertised channel the graph map does not have yet. Each test states the
 * answer ADR 0025 asks for: evidence that does not pin the bridge is not known.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import { installMockWebSocket, type MockWebSocketHandle } from './_helpers/mock-websocket';

type Socket = ReturnType<MockWebSocketHandle['last']>;

const BRIDGE = '/foxglove_bridge';

interface Frame {
  pubs?: Record<string, string[]>;
  subs?: Record<string, string[]>;
}

function graphFrame(f: Frame): string {
  return JSON.stringify({
    op: 'connectionGraphUpdate',
    publishedTopics: Object.entries(f.pubs ?? {}).map(([name, publisherIds]) => ({
      name,
      publisherIds,
    })),
    subscribedTopics: Object.entries(f.subs ?? {}).map(([name, subscriberIds]) => ({
      name,
      subscriberIds,
    })),
    advertisedServices: [],
    removedTopics: [],
    removedServices: [],
  });
}

const CHANNELS = [
  {
    id: 1,
    topic: '/scan',
    encoding: 'cdr',
    schemaName: 'std_msgs/msg/Float32',
    schema: 'float32 data',
  },
  {
    id: 2,
    topic: '/cmd_in',
    encoding: 'cdr',
    schemaName: 'std_msgs/msg/Bool',
    schema: 'bool data',
  },
];

describe('FoxgloveClient getTopicEndpoints: edge cases', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    vi.useFakeTimers();
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
    vi.useRealTimers();
  });

  async function connected(
    capabilities: string[] = ['clientPublish', 'connectionGraph'],
  ): Promise<{ client: FoxgloveClient; socket: Socket }> {
    const client = new FoxgloveClient({ readTopicEndpoints: true });
    const promise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.sdk.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: '', capabilities }));
    socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: CHANNELS }));
    await promise;
    socket.simulateMessage(graphFrame({})); // the initial snapshot
    return { client, socket };
  }

  /** A rebuild after the touches, then let them settle past two seconds. */
  async function rebuildAndSettle(socket: Socket, frame: Frame): Promise<void> {
    socket.simulateMessage(graphFrame(frame));
    await vi.advanceTimersByTimeAsync(2_500);
  }

  /** Ask, answer the fresh read with one frame, let the settle window run out. */
  async function ask(client: FoxgloveClient, socket: Socket, topics: string[], frame: Frame) {
    const pending = client.getTopicEndpoints(topics);
    await vi.advanceTimersByTimeAsync(0);
    socket.simulateMessage(graphFrame(frame));
    await vi.advanceTimersByTimeAsync(5_000);
    return pending;
  }

  it('a subscription whose channel was unadvertised is no evidence of the bridge', async () => {
    const { client, socket } = await connected();
    client.subscribe('/scan', () => {});
    await rebuildAndSettle(socket, { subs: { '/scan': [BRIDGE, '/slam_toolbox'] } });

    // The lidar driver restarts: the bridge drops the channel and its ROS subscriber.
    socket.simulateMessage(JSON.stringify({ op: 'unadvertise', channelIds: [1] }));

    const answer = await ask(client, socket, ['/scan', '/odom'], {
      subs: { '/scan': ['/slam_toolbox'], '/odom': [BRIDGE] },
    });

    // The only touch left describes a side the bridge is no longer on, so
    // nothing pins the bridge: not known. Not "/slam_toolbox is the bridge".
    expect(answer).toEqual([
      { topic: '/scan', publishers: null, subscribers: null },
      { topic: '/odom', publishers: null, subscribers: null },
    ]);
  });

  it('an advertise on a bridge without clientPublish is no evidence of the bridge', async () => {
    const { client, socket } = await connected(['connectionGraph']);
    expect(client.getPublishPermission()).toBe('refused');
    client.ensureAdvertised('/cmd_in', 'std_msgs/msg/Bool');
    await rebuildAndSettle(socket, { pubs: { '/cmd_in': ['/teleop_twist_keyboard'] } });

    const answer = await ask(client, socket, ['/cmd_in'], {
      pubs: { '/cmd_in': ['/teleop_twist_keyboard'] },
      subs: { '/cmd_in': ['/cmd_listener'] },
    });

    // The bridge refused to publish, so it is not on /cmd_in: the touch pins
    // nothing, and the real publisher must not be hidden as "the bridge".
    expect(answer).toEqual([{ topic: '/cmd_in', publishers: null, subscribers: null }]);
  });

  it('a lookup queued behind one on a lost connection rejects, never answers from the next', async () => {
    const { client, socket } = await connected();
    client.subscribe('/scan', () => {});
    await rebuildAndSettle(socket, { subs: { '/scan': [BRIDGE] } });

    const first = client.getTopicEndpoints(['/scan']);
    const second = client.getTopicEndpoints(['/cmd_in']);
    first.catch(() => {});
    second.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);

    socket.simulateClose(1006, 'gone');
    const again = client.connect('ws://localhost:8765');
    const socket2 = ws.last();
    socket2.simulateOpen('foxglove.sdk.v1');
    socket2.simulateMessage(
      JSON.stringify({
        op: 'serverInfo',
        name: '',
        capabilities: ['clientPublish', 'connectionGraph'],
      }),
    );
    socket2.simulateMessage(JSON.stringify({ op: 'advertise', channels: CHANNELS }));
    await again.catch(() => {});
    socket2.simulateMessage(graphFrame({}));
    socket2.simulateMessage(graphFrame({ pubs: { '/cmd_in': ['/robot_b'] } }));
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(first).rejects.toThrow('Not connected');
    await expect(second).rejects.toThrow('Not connected');
  });

  it('an advertised channel is no proof of a publisher: the map decides', async () => {
    const { client, socket } = await connected();
    client.subscribe('/scan', () => {});
    await rebuildAndSettle(socket, { subs: { '/scan': [BRIDGE] } });

    // foxglove_bridge advertises a topic that only has subscribers too (the
    // integration fixture's /endpoints/cmd_in), so a channel the map lists no
    // publisher for has nobody publishing it, not an unknown publisher.
    const answer = await ask(client, socket, ['/cmd_in'], {
      subs: { '/scan': [BRIDGE], '/cmd_in': ['/cmd_listener'] },
    });

    expect(answer).toEqual([{ topic: '/cmd_in', publishers: [], subscribers: ['/cmd_listener'] }]);
  });
});
