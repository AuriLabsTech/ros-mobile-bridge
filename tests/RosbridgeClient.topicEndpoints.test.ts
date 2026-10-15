// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * `getTopicEndpoints` on rosbridge (ADR 0025, decision 6 as amended
 * 2026-10-14): careful `rosapi` lookups behind `readTopicEndpoints`, off by
 * default. One question in flight at a time, a timeout on each, the first
 * failure ends the lookup, the bridge's own endpoints left out on evidence
 * (the publisher of `client_count`), never `node_details`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RosbridgeClient } from '../src/RosbridgeClient';
import { installMockWebSocket, type MockWebSocketHandle } from './_helpers/mock-websocket';

type Socket = ReturnType<MockWebSocketHandle['last']>;

interface Graph {
  topics: Array<[string, string]>;
  pubs: Record<string, string[]>;
  subs: Record<string, string[]>;
  /** Return true to answer this call with a failure frame. */
  fail?: (service: string, topic: string | undefined) => boolean;
  /** Return true to leave this call unanswered. */
  hold?: (service: string, topic: string | undefined) => boolean;
}

const LOOKUP_SERVICES = new Set([
  '/rosapi/topics',
  '/rosapi/publishers',
  '/rosapi/subscribers',
  '/rosapi/node_details',
  '/rosapi/nodes',
]);

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * Answers the client's graph calls from `graph` until it stops asking.
 * Records every lookup call in order and the most calls ever in flight.
 */
type CallLog = Array<{ service: string; topic?: string | undefined; timeout?: number | undefined }>;

function topicOf(call: Record<string, unknown>): string | undefined {
  return (call.args as { topic?: string } | undefined)?.topic;
}

/** Lookup calls the client has sent and the fake rosapi has not answered. */
function openCalls(socket: Socket, answered: Set<string>): Array<Record<string, unknown>> {
  return socket.sentJson.filter(
    (m) =>
      m.op === 'call_service' &&
      LOOKUP_SERVICES.has(m.service as string) &&
      !answered.has(m.id as string),
  );
}

/** What the fake rosapi answers `service` with, from `graph`. */
function rosapiValues(graph: Graph, service: string, topic: string | undefined): unknown {
  if (graph.fail?.(service, topic)) return 'Timeout exceeded while waiting for service response';
  if (service === '/rosapi/topics') {
    return { topics: graph.topics.map((t) => t[0]), types: graph.topics.map((t) => t[1]) };
  }
  if (service === '/rosapi/publishers') return { publishers: graph.pubs[topic ?? ''] ?? [] };
  if (service === '/rosapi/subscribers') return { subscribers: graph.subs[topic ?? ''] ?? [] };
  return {};
}

function respond(socket: Socket, graph: Graph, call: Record<string, unknown>): void {
  const service = call.service as string;
  const values = rosapiValues(graph, service, topicOf(call));
  socket.simulateMessage(
    JSON.stringify({
      op: 'service_response',
      id: call.id,
      service,
      result: typeof values !== 'string',
      values,
    }),
  );
}

/**
 * Answers the client's graph calls from `graph` until it stops asking.
 * Records every lookup call in order and the most calls ever in flight.
 */
async function serveRosapi(
  socket: Socket,
  graph: Graph,
  answered: Set<string>,
  log: CallLog,
): Promise<{ maxInFlight: number }> {
  let maxInFlight = 0;
  const answerable = (): Array<Record<string, unknown>> =>
    openCalls(socket, answered).filter((c) => !graph.hold?.(c.service as string, topicOf(c)));
  for (let round = 0; round < 200; round++) {
    await tick();
    maxInFlight = Math.max(maxInFlight, openCalls(socket, answered).length);
    let ready = answerable();
    if (ready.length === 0) {
      // Give pending microtasks one more tick before deciding the client is done.
      await tick();
      ready = answerable();
      if (ready.length === 0) break;
    }
    for (const call of ready) {
      answered.add(call.id as string);
      log.push({
        service: call.service as string,
        topic: topicOf(call),
        timeout: call.timeout as number | undefined,
      });
      respond(socket, graph, call);
    }
  }
  return { maxInFlight };
}

const GRAPH: Graph = {
  topics: [
    ['/client_count', 'std_msgs/msg/Int32'],
    ['/connected_clients', 'rosbridge_msgs/msg/ConnectedClients'],
    ['/cmd_in', 'std_msgs/msg/Bool'],
    ['/sensor_out', 'std_msgs/msg/Float32'],
    ['/both', 'std_msgs/msg/Bool'],
  ],
  pubs: {
    '/client_count': ['/rosbridge_websocket'],
    '/cmd_in': [],
    '/sensor_out': ['/sensor'],
    '/both': ['/relay', '/rosbridge_websocket'],
  },
  subs: {
    '/cmd_in': ['/cmd_listener'],
    '/sensor_out': ['/rosbridge_websocket'],
    '/both': ['/relay'],
  },
};

describe('RosbridgeClient — getTopicEndpoints', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  async function connected(
    options?: ConstructorParameters<typeof RosbridgeClient>[0],
  ): Promise<{ client: RosbridgeClient; socket: Socket; answered: Set<string> }> {
    const client = new RosbridgeClient({ latencyProbeMs: 0, discoveryRefreshMs: 0, ...options });
    const p = client.connect('ws://localhost:9090');
    const socket = ws.last();
    socket.simulateOpen();
    await p;
    // Answer on-connect discovery so it does not count as a lookup call.
    const answered = new Set<string>();
    await serveRosapi(socket, GRAPH, answered, []);
    return { client, socket, answered };
  }

  it('answers not known everywhere and asks nothing when the switch is off', async () => {
    const { client, socket } = await connected();
    const before = socket.sentJson.length;

    const answer = await client.getTopicEndpoints(['/cmd_in', '/sensor_out']);

    expect(answer).toEqual([
      { topic: '/cmd_in', publishers: null, subscribers: null },
      { topic: '/sensor_out', publishers: null, subscribers: null },
    ]);
    expect(socket.sentJson.length).toBe(before);
  });

  it('with the switch off and no list, covers every discovered topic, not known', async () => {
    const { client } = await connected();
    const answer = await client.getTopicEndpoints();
    expect(answer.map((e) => e.topic)).toEqual([...GRAPH.topics.map((t) => t[0])].sort());
    expect(answer.every((e) => e.publishers === null && e.subscribers === null)).toBe(true);
  });

  it('asks about the named topics one at a time and leaves the bridge out', async () => {
    const { client, socket, answered } = await connected({ readTopicEndpoints: true });
    const log: Array<{ service: string; topic?: string; timeout?: number }> = [];

    const pending = client.getTopicEndpoints(['/cmd_in', '/sensor_out', '/both', '/cmd_in']);
    const { maxInFlight } = await serveRosapi(socket, GRAPH, answered, log);
    const answer = await pending;

    expect(answer).toEqual([
      { topic: '/cmd_in', publishers: [], subscribers: ['/cmd_listener'] },
      { topic: '/sensor_out', publishers: ['/sensor'], subscribers: [] },
      { topic: '/both', publishers: ['/relay'], subscribers: ['/relay'] },
    ]);
    expect(maxInFlight).toBe(1);
    expect(log.map((c) => `${c.service} ${c.topic ?? ''}`.trim())).toEqual([
      '/rosapi/topics',
      '/rosapi/publishers /client_count',
      '/rosapi/publishers /cmd_in',
      '/rosapi/subscribers /cmd_in',
      '/rosapi/publishers /sensor_out',
      '/rosapi/subscribers /sensor_out',
      '/rosapi/publishers /both',
      '/rosapi/subscribers /both',
    ]);
    expect(log.every((c) => typeof c.timeout === 'number' && c.timeout > 0)).toBe(true);
  });

  it('answers a named topic the robot does not have as nobody, without asking', async () => {
    const { client, socket, answered } = await connected({ readTopicEndpoints: true });
    const log: Array<{ service: string; topic?: string }> = [];

    const pending = client.getTopicEndpoints(['/no_such']);
    await serveRosapi(socket, GRAPH, answered, log);

    expect(await pending).toEqual([{ topic: '/no_such', publishers: [], subscribers: [] }]);
    expect(log.some((c) => c.topic === '/no_such')).toBe(false);
  });

  it('without a list, covers every topic the robot lists, sorted', async () => {
    const { client, socket, answered } = await connected({ readTopicEndpoints: true });
    const pending = client.getTopicEndpoints();
    await serveRosapi(socket, GRAPH, answered, []);
    const answer = await pending;

    expect(answer.map((e) => e.topic)).toEqual(GRAPH.topics.map((t) => t[0]).sort());
    expect(answer.find((e) => e.topic === '/client_count')).toEqual({
      topic: '/client_count',
      publishers: [],
      subscribers: [],
    });
  });

  it('stops at the first failed question; what is not answered is not known', async () => {
    const { client, socket, answered } = await connected({ readTopicEndpoints: true });
    const log: Array<{ service: string; topic?: string }> = [];
    const graph: Graph = {
      ...GRAPH,
      fail: (service, topic) => service === '/rosapi/subscribers' && topic === '/cmd_in',
    };

    const pending = client.getTopicEndpoints(['/cmd_in', '/sensor_out']);
    await serveRosapi(socket, graph, answered, log);

    expect(await pending).toEqual([
      { topic: '/cmd_in', publishers: [], subscribers: null },
      { topic: '/sensor_out', publishers: null, subscribers: null },
    ]);
    expect(log.some((c) => c.topic === '/sensor_out')).toBe(false);
  });

  it('answers not known when the bridge has no client_count topic to name it', async () => {
    const { client, socket, answered } = await connected({ readTopicEndpoints: true });
    const log: Array<{ service: string; topic?: string }> = [];
    const graph: Graph = {
      ...GRAPH,
      topics: GRAPH.topics.filter((t) => t[0] !== '/client_count'),
    };

    const pending = client.getTopicEndpoints(['/cmd_in']);
    await serveRosapi(socket, graph, answered, log);

    expect(await pending).toEqual([{ topic: '/cmd_in', publishers: null, subscribers: null }]);
    expect(log.map((c) => c.service)).toEqual(['/rosapi/topics']);
  });

  it('names a namespaced bridge from <ns>/client_count, and only an Int32 one', async () => {
    const { client, socket, answered } = await connected({ readTopicEndpoints: true });
    const graph: Graph = {
      topics: [
        ['/robot1/client_count', 'std_msgs/msg/Int32'],
        ['/other/client_count', 'std_msgs/msg/String'],
        ['/sensor_out', 'std_msgs/msg/Float32'],
      ],
      pubs: {
        '/robot1/client_count': ['/robot1/rosbridge_websocket'],
        '/other/client_count': ['/talker'],
        '/sensor_out': ['/sensor', '/robot1/rosbridge_websocket'],
      },
      subs: { '/sensor_out': ['/talker'] },
    };

    const pending = client.getTopicEndpoints(['/sensor_out']);
    await serveRosapi(socket, graph, answered, []);

    expect(await pending).toEqual([
      { topic: '/sensor_out', publishers: ['/sensor'], subscribers: ['/talker'] },
    ]);
  });

  it('a failed /rosapi/topics makes everything not known', async () => {
    const { client, socket, answered } = await connected({ readTopicEndpoints: true });
    const graph: Graph = { ...GRAPH, fail: (service) => service === '/rosapi/topics' };
    const pending = client.getTopicEndpoints(['/cmd_in']);
    await serveRosapi(socket, graph, answered, []);
    expect(await pending).toEqual([{ topic: '/cmd_in', publishers: null, subscribers: null }]);
  });

  it('rejects when not connected', async () => {
    const client = new RosbridgeClient({ readTopicEndpoints: true });
    await expect(client.getTopicEndpoints(['/a'])).rejects.toThrow('Not connected');
  });

  it('rejects when the connection closes mid-lookup', async () => {
    const { client, socket, answered } = await connected({ readTopicEndpoints: true });
    const graph: Graph = {
      ...GRAPH,
      hold: (service, topic) => service === '/rosapi/subscribers' && topic === '/cmd_in',
    };
    const pending = client.getTopicEndpoints(['/cmd_in']);
    pending.catch(() => {});
    await serveRosapi(socket, graph, answered, []);

    await client.disconnect();

    await expect(pending).rejects.toThrow('Not connected');
  });

  it('a second call for the same topics shares the running lookup', async () => {
    const { client, socket, answered } = await connected({ readTopicEndpoints: true });
    const log: Array<{ service: string; topic?: string }> = [];

    const a = client.getTopicEndpoints(['/cmd_in']);
    const b = client.getTopicEndpoints(['/cmd_in']);
    await serveRosapi(socket, GRAPH, answered, log);

    expect(await a).toEqual(await b);
    expect(log.filter((c) => c.service === '/rosapi/topics')).toHaveLength(1);
  });

  it('a call for other topics waits for the running lookup, never overlapping it', async () => {
    const { client, socket, answered } = await connected({ readTopicEndpoints: true });
    const log: Array<{ service: string; topic?: string }> = [];

    const a = client.getTopicEndpoints(['/cmd_in']);
    const b = client.getTopicEndpoints(['/sensor_out']);
    const { maxInFlight } = await serveRosapi(socket, GRAPH, answered, log);

    expect(await a).toEqual([{ topic: '/cmd_in', publishers: [], subscribers: ['/cmd_listener'] }]);
    expect(await b).toEqual([{ topic: '/sensor_out', publishers: ['/sensor'], subscribers: [] }]);
    expect(maxInFlight).toBe(1);
    expect(log.filter((c) => c.service === '/rosapi/topics')).toHaveLength(2);
  });

  it('never calls node_details or nodes', async () => {
    const { client, socket, answered } = await connected({ readTopicEndpoints: true });
    const log: Array<{ service: string; topic?: string }> = [];
    const pending = client.getTopicEndpoints();
    await serveRosapi(socket, GRAPH, answered, log);
    await pending;
    expect(
      log.some((c) => c.service === '/rosapi/node_details' || c.service === '/rosapi/nodes'),
    ).toBe(false);
  });
});
