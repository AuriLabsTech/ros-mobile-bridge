// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * Edge cases of `getTopicEndpoints` on rosbridge: a second bridge on the
 * robot, and a lookup queued across a reconnect.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RosbridgeClient } from '../src/RosbridgeClient';
import { installMockWebSocket, type MockWebSocketHandle } from './_helpers/mock-websocket';

type Socket = ReturnType<MockWebSocketHandle['last']>;

interface Graph {
  topics: Array<[string, string]>;
  pubs: Record<string, string[]>;
  subs: Record<string, string[]>;
  hold?: (service: string) => boolean;
}

const LOOKUP_SERVICES = new Set(['/rosapi/topics', '/rosapi/publishers', '/rosapi/subscribers']);

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function topicOf(call: Record<string, unknown>): string | undefined {
  return (call.args as { topic?: string } | undefined)?.topic;
}

function values(graph: Graph, service: string, topic: string | undefined): unknown {
  if (service === '/rosapi/topics') {
    return { topics: graph.topics.map((t) => t[0]), types: graph.topics.map((t) => t[1]) };
  }
  if (service === '/rosapi/publishers') return { publishers: graph.pubs[topic ?? ''] ?? [] };
  if (service === '/rosapi/subscribers') return { subscribers: graph.subs[topic ?? ''] ?? [] };
  return {};
}

/** Answer every rosapi call the client sends on `socket` until it stops asking. */
async function serve(socket: Socket, graph: Graph, answered: Set<string>): Promise<void> {
  for (let round = 0; round < 100; round++) {
    await tick();
    await tick();
    const open = socket.sentJson.filter(
      (m) =>
        m.op === 'call_service' &&
        LOOKUP_SERVICES.has(m.service as string) &&
        !answered.has(m.id as string) &&
        !graph.hold?.(m.service as string),
    );
    if (open.length === 0) return;
    for (const call of open) {
      answered.add(call.id as string);
      socket.simulateMessage(
        JSON.stringify({
          op: 'service_response',
          id: call.id,
          service: call.service,
          result: true,
          values: values(graph, call.service as string, topicOf(call)),
        }),
      );
    }
  }
}

describe('RosbridgeClient getTopicEndpoints: edge cases', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  async function connected(graph: Graph) {
    const client = new RosbridgeClient({
      latencyProbeMs: 0,
      discoveryRefreshMs: 0,
      readTopicEndpoints: true,
    });
    const p = client.connect('ws://localhost:9090');
    const socket = ws.last();
    socket.simulateOpen();
    await p;
    const answered = new Set<string>();
    await serve(socket, graph, answered);
    return { client, socket, answered };
  }

  // ADR 0025 decision 5: every publisher of a `client_count` topic is taken
  // for a bridge, this client's own or not.
  it('a second rosbridge with its own client_count is left out like this one', async () => {
    const graph: Graph = {
      topics: [
        ['/client_count', 'std_msgs/msg/Int32'],
        ['/ops/client_count', 'std_msgs/msg/Int32'],
        ['/cmd_in', 'std_msgs/msg/Bool'],
      ],
      pubs: {
        '/client_count': ['/rosbridge_websocket'],
        '/ops/client_count': ['/ops/rosbridge_websocket'],
      },
      subs: { '/cmd_in': ['/cmd_listener', '/ops/rosbridge_websocket', '/rosbridge_websocket'] },
    };
    const { client, socket, answered } = await connected(graph);

    const pending = client.getTopicEndpoints(['/cmd_in']);
    await serve(socket, graph, answered);

    expect(await pending).toEqual([
      {
        topic: '/cmd_in',
        publishers: [],
        subscribers: ['/cmd_listener'],
      },
    ]);
  });

  it('a lookup queued behind one on a lost connection rejects, never answers from the next', async () => {
    const graphA: Graph = {
      topics: [['/client_count', 'std_msgs/msg/Int32']],
      pubs: { '/client_count': ['/rosbridge_websocket'] },
      subs: {},
    };
    const { client, socket, answered } = await connected(graphA);

    // Hold the first lookup's /rosapi/topics so a second one queues behind it.
    const held: Graph = { ...graphA, hold: () => true };
    const first = client.getTopicEndpoints(['/a']);
    const second = client.getTopicEndpoints(['/b']);
    first.catch(() => {});
    second.catch(() => {});
    await serve(socket, held, answered);

    socket.simulateClose(1006, 'gone');
    const again = client.connect('ws://localhost:9090');
    const socket2 = ws.last();
    socket2.simulateOpen();
    await again.catch(() => {});
    const graphB: Graph = {
      topics: [
        ['/client_count', 'std_msgs/msg/Int32'],
        ['/b', 'std_msgs/msg/Bool'],
      ],
      pubs: { '/client_count': ['/rosbridge_websocket'], '/b': ['/robot_b_node'] },
      subs: {},
    };
    await serve(socket2, graphB, new Set());

    await expect(first).rejects.toThrow('Not connected');
    await expect(second).rejects.toThrow('Not connected');
  });
});
