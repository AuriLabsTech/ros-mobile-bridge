// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * `getTopicEndpoints` on Foxglove WebSocket (ADR 0025 decisions 5 and 7).
 *
 * With `readTopicEndpoints` on and the `connectionGraph` capability present,
 * the client listens to the graph from connect, treats the deltas only as
 * evidence that the bridge rebuilt its map, and reads the bridge's whole
 * cached map through a fresh unsubscribe and subscribe when asked. Every rule
 * that cannot be met fails toward not known: no rebuild seen yet, a read that
 * is ambiguous or unanswered, a bridge whose name the evidence does not pin.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import type { ProtocolClientOptions } from '../src/types';
import { installMockWebSocket, type MockWebSocketHandle } from './_helpers/mock-websocket';

type Socket = ReturnType<MockWebSocketHandle['last']>;

const BRIDGE = '/robot1/robot_bridge';
const PLACEHOLDER = '_NODE_NAMESPACE_UNKNOWN_/_NODE_NAME_UNKNOWN_';

interface Frame {
  pubs?: Record<string, string[]>;
  subs?: Record<string, string[]>;
  removed?: string[];
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
    removedTopics: f.removed ?? [],
    removedServices: [],
  });
}

const EMPTY_FRAME = graphFrame({});

/** The robot's graph once the app subscribes `/sensor_out` and advertises `/cmd_in`. */
const SNAPSHOT: Frame = {
  pubs: {
    '/rosout': ['/sensor', '/cmd_listener', BRIDGE],
    '/sensor_out': ['/sensor'],
    '/cmd_in': [BRIDGE],
    '/chatter': ['/_ros2cli_18'],
  },
  subs: {
    '/sensor_out': [BRIDGE],
    '/cmd_in': ['/cmd_listener'],
    '/parameter_events': [BRIDGE],
  },
};

function graphOps(socket: Socket): string[] {
  return socket.sentJson
    .map((m) => m.op as string)
    .filter((op) => op === 'subscribeConnectionGraph' || op === 'unsubscribeConnectionGraph');
}

describe('FoxgloveClient — getTopicEndpoints', () => {
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
    options: ProtocolClientOptions = { readTopicEndpoints: true },
    capabilities: string[] = ['clientPublish', 'connectionGraph'],
  ): Promise<{ client: FoxgloveClient; socket: Socket }> {
    const client = new FoxgloveClient(options);
    const promise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.sdk.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: '', capabilities }));
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertise',
        channels: [
          {
            id: 1,
            topic: '/sensor_out',
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
        ],
      }),
    );
    await promise;
    return { client, socket };
  }

  /** Subscribe and advertise like an app with one display and one button, then let it settle. */
  async function touchAndSettle(client: FoxgloveClient, socket: Socket): Promise<void> {
    if (graphOps(socket).length > 0) socket.simulateMessage(EMPTY_FRAME); // initial snapshot
    client.subscribe('/sensor_out', () => {});
    client.ensureAdvertised('/cmd_in', 'std_msgs/msg/Bool');
    socket.simulateMessage(graphFrame({ subs: { '/sensor_out': [BRIDGE] } })); // a rebuild
    await vi.advanceTimersByTimeAsync(2_500);
  }

  /** Ask, answer the fresh read with `frames`, and let the settle window run out. */
  async function ask(
    client: FoxgloveClient,
    socket: Socket,
    topics: string[] | undefined,
    frames: Frame[],
  ): Promise<Awaited<ReturnType<FoxgloveClient['getTopicEndpoints']>>> {
    const opsBefore = graphOps(socket).length;
    const pending = client.getTopicEndpoints(topics);
    await vi.advanceTimersByTimeAsync(0);
    const opsAfter = graphOps(socket).slice(opsBefore);
    if (frames.length > 0) {
      expect(opsAfter).toEqual(['unsubscribeConnectionGraph', 'subscribeConnectionGraph']);
    }
    for (const f of frames) socket.simulateMessage(graphFrame(f));
    await vi.advanceTimersByTimeAsync(5_000);
    return pending;
  }

  it('with the switch off, never listens and answers not known', async () => {
    const { client, socket } = await connected({});
    client.subscribe('/sensor_out', () => {});

    const answer = await client.getTopicEndpoints(['/sensor_out']);

    expect(answer).toEqual([{ topic: '/sensor_out', publishers: null, subscribers: null }]);
    expect(graphOps(socket)).toEqual([]);
  });

  it('with the switch off and no list, covers every channel, not known', async () => {
    const { client } = await connected({});
    expect(await client.getTopicEndpoints()).toEqual([
      { topic: '/cmd_in', publishers: null, subscribers: null },
      { topic: '/sensor_out', publishers: null, subscribers: null },
    ]);
  });

  it('listens from connect when the switch is on and the bridge offers the graph', async () => {
    const { socket } = await connected();
    expect(graphOps(socket)).toEqual(['subscribeConnectionGraph']);
  });

  it('does not listen when the bridge lacks the connectionGraph capability', async () => {
    const { client, socket } = await connected({ readTopicEndpoints: true }, ['clientPublish']);
    await touchAndSettle(client, socket);
    expect(graphOps(socket)).toEqual([]);
    expect(await client.getTopicEndpoints(['/sensor_out'])).toEqual([
      { topic: '/sensor_out', publishers: null, subscribers: null },
    ]);
  });

  it('answers not known until a rebuild has been seen, and reads nothing', async () => {
    const { client, socket } = await connected();
    socket.simulateMessage(graphFrame(SNAPSHOT)); // the initial frame is the cache, not a rebuild
    client.subscribe('/sensor_out', () => {});
    await vi.advanceTimersByTimeAsync(2_500);

    const answer = await ask(client, socket, ['/sensor_out'], []);

    expect(answer).toEqual([{ topic: '/sensor_out', publishers: null, subscribers: null }]);
    expect(graphOps(socket)).toEqual(['subscribeConnectionGraph']);
  });

  it('reads the cached map fresh and leaves the bridge out, without knowing its name', async () => {
    const { client, socket } = await connected();
    await touchAndSettle(client, socket);

    const answer = await ask(
      client,
      socket,
      ['/sensor_out', '/cmd_in', '/chatter', '/nothing'],
      [SNAPSHOT],
    );

    expect(answer).toEqual([
      { topic: '/sensor_out', publishers: ['/sensor'], subscribers: [] },
      { topic: '/cmd_in', publishers: [], subscribers: ['/cmd_listener'] },
      { topic: '/chatter', publishers: ['/_ros2cli_18'], subscribers: [] },
      { topic: '/nothing', publishers: [], subscribers: [] },
    ]);
  });

  it('without a list, covers every topic in the map and every channel, sorted', async () => {
    const { client, socket } = await connected();
    await touchAndSettle(client, socket);

    const answer = await ask(client, socket, undefined, [SNAPSHOT]);

    expect(answer.map((e) => e.topic)).toEqual([
      '/chatter',
      '/cmd_in',
      '/parameter_events',
      '/rosout',
      '/sensor_out',
    ]);
    expect(answer.find((e) => e.topic === '/parameter_events')).toEqual({
      topic: '/parameter_events',
      publishers: [],
      subscribers: [],
    });
  });

  it('a second frame inside the read window makes the read ambiguous: not known', async () => {
    const { client, socket } = await connected();
    await touchAndSettle(client, socket);

    const answer = await ask(
      client,
      socket,
      ['/sensor_out'],
      [{ subs: { '/sensor_out': [BRIDGE] } }, SNAPSHOT],
    );

    expect(answer).toEqual([{ topic: '/sensor_out', publishers: null, subscribers: null }]);
  });

  it('a read the bridge never answers is not known', async () => {
    const { client, socket } = await connected();
    await touchAndSettle(client, socket);

    const answer = await ask(client, socket, ['/sensor_out'], []);

    expect(graphOps(socket).slice(-2)).toEqual([
      'unsubscribeConnectionGraph',
      'subscribeConnectionGraph',
    ]);
    expect(answer).toEqual([{ topic: '/sensor_out', publishers: null, subscribers: null }]);
  });

  it('touches younger than two seconds name no bridge: not known, and nothing is read', async () => {
    const { client, socket } = await connected();
    socket.simulateMessage(EMPTY_FRAME);
    socket.simulateMessage(EMPTY_FRAME); // a rebuild
    client.subscribe('/sensor_out', () => {});

    const answer = await ask(client, socket, ['/sensor_out'], []);

    expect(answer).toEqual([{ topic: '/sensor_out', publishers: null, subscribers: null }]);
    expect(graphOps(socket)).toEqual(['subscribeConnectionGraph']);
  });

  it('an app that has touched no topic names no bridge: not known', async () => {
    const { client, socket } = await connected();
    socket.simulateMessage(EMPTY_FRAME);
    socket.simulateMessage(EMPTY_FRAME); // a rebuild caused by someone else
    await vi.advanceTimersByTimeAsync(2_500);

    const answer = await ask(client, socket, ['/sensor_out'], []);

    expect(answer).toEqual([{ topic: '/sensor_out', publishers: null, subscribers: null }]);
  });

  it('another node on every touched topic leaves the bridge ambiguous: not known', async () => {
    const { client, socket } = await connected();
    await touchAndSettle(client, socket);
    client.unadvertise('/cmd_in');

    const answer = await ask(
      client,
      socket,
      ['/sensor_out'],
      [{ ...SNAPSHOT, subs: { ...SNAPSHOT.subs, '/sensor_out': [BRIDGE, '/recorder'] } }],
    );

    expect(answer).toEqual([{ topic: '/sensor_out', publishers: null, subscribers: null }]);
  });

  it('a side still carrying the placeholder id is not known', async () => {
    const { client, socket } = await connected();
    await touchAndSettle(client, socket);

    const answer = await ask(
      client,
      socket,
      ['/sensor_out', '/cmd_in'],
      [{ ...SNAPSHOT, pubs: { ...SNAPSHOT.pubs, '/sensor_out': ['/sensor', PLACEHOLDER] } }],
    );

    expect(answer).toEqual([
      { topic: '/sensor_out', publishers: null, subscribers: [] },
      { topic: '/cmd_in', publishers: [], subscribers: ['/cmd_listener'] },
    ]);
  });

  it('leaves out its own bridge, not a second bridge named /foxglove_bridge', async () => {
    const { client, socket } = await connected();
    await touchAndSettle(client, socket);

    const answer = await ask(
      client,
      socket,
      ['/sensor_out', '/cmd_in'],
      [
        {
          pubs: { ...SNAPSHOT.pubs, '/cmd_in': [BRIDGE] },
          subs: { ...SNAPSHOT.subs, '/sensor_out': [BRIDGE, '/foxglove_bridge'] },
        },
      ],
    );

    expect(answer).toEqual([
      { topic: '/sensor_out', publishers: ['/sensor'], subscribers: ['/foxglove_bridge'] },
      { topic: '/cmd_in', publishers: [], subscribers: ['/cmd_listener'] },
    ]);
  });

  it('keeps listening after a read, so the next read needs no new rebuild', async () => {
    const { client, socket } = await connected();
    await touchAndSettle(client, socket);
    await ask(client, socket, ['/sensor_out'], [SNAPSHOT]);

    const answer = await ask(client, socket, ['/sensor_out'], [SNAPSHOT]);

    expect(answer).toEqual([{ topic: '/sensor_out', publishers: ['/sensor'], subscribers: [] }]);
    expect(graphOps(socket).at(-1)).toBe('subscribeConnectionGraph');
  });

  it('rejects when not connected', async () => {
    const client = new FoxgloveClient({ readTopicEndpoints: true });
    await expect(client.getTopicEndpoints(['/a'])).rejects.toThrow('Not connected');
  });

  it('rejects when the connection closes during a read', async () => {
    const { client, socket } = await connected();
    await touchAndSettle(client, socket);
    const pending = client.getTopicEndpoints(['/sensor_out']);
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);

    await client.disconnect();
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(pending).rejects.toThrow('Not connected');
  });

  it('starts over on reconnect: no rebuild seen on the new connection yet', async () => {
    const { client, socket } = await connected();
    await touchAndSettle(client, socket);
    await client.disconnect();

    const again = client.connect('ws://localhost:8765');
    const socket2 = ws.last();
    socket2.simulateOpen('foxglove.sdk.v1');
    socket2.simulateMessage(
      JSON.stringify({ op: 'serverInfo', name: '', capabilities: ['connectionGraph'] }),
    );
    socket2.simulateMessage(JSON.stringify({ op: 'advertise', channels: [] }));
    await again;
    socket2.simulateMessage(graphFrame(SNAPSHOT));

    const answer = await ask(client, socket2, ['/sensor_out'], []);
    expect(answer).toEqual([{ topic: '/sensor_out', publishers: null, subscribers: null }]);
    expect(graphOps(socket2)).toEqual(['subscribeConnectionGraph']);
  });
});
