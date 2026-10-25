// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * The order in which each client calls its listeners and settles its
 * promises, as one list a consumer can check a hand-written test double
 * against. Each `it` names one rule; the per-transport differences are
 * spelled out rather than hidden.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import { RosbridgeClient } from '../src/RosbridgeClient';
import type { ProtocolClientOptions } from '../src/types';
import {
  findSentServiceCallRequest,
  installMockWebSocket,
  type MockWebSocketHandle,
} from './_helpers/mock-websocket';

type Socket = ReturnType<MockWebSocketHandle['last']>;

function channel(id: number, topic: string): Record<string, unknown> {
  return { id, topic, encoding: 'json', schemaName: 'std_msgs/msg/String', schema: '' };
}

/** Answer the latest rosbridge `call_service` to `service` with `values`. */
function answer(socket: Socket, service: string, values: Record<string, unknown>): void {
  const calls = socket.sentJson.filter((m) => m.op === 'call_service' && m.service === service);
  const last = calls[calls.length - 1] as { id: string } | undefined;
  if (!last) throw new Error(`no ${service} call to answer`);
  socket.simulateMessage(
    JSON.stringify({ op: 'service_response', id: last.id, result: true, values }),
  );
}

function answerTopics(socket: Socket, names: string[]): void {
  answer(socket, '/rosapi/topics', {
    topics: names,
    types: names.map(() => 'std_msgs/msg/String'),
  });
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('event order', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  describe.each([
    ['Foxglove', (options?: ProtocolClientOptions) => new FoxgloveClient(options)],
    ['rosbridge', (options?: ProtocolClientOptions) => new RosbridgeClient(options)],
  ] as const)('%s', (_name, make) => {
    it('onStatusChange calls the listener with the current status before it returns', () => {
      const client = make();
      const seen: string[] = [];
      client.onStatusChange((s) => seen.push(s));
      seen.push('returned');
      expect(seen).toEqual(['disconnected', 'returned']);
    });

    it('onServicesChange calls the listener with the current list before it returns; onTopicsChange does not', () => {
      const client = make();
      const seen: string[] = [];
      client.onServicesChange((s) => seen.push(`services:${s.length}`));
      client.onTopicsChange((t) => seen.push(`topics:${t.length}`));
      seen.push('returned');
      expect(seen).toEqual(['services:0', 'returned']);
    });

    it('a status listener that throws does not stop the next one', async () => {
      const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const client = make({ logger });
      let registered = false;
      client.onStatusChange(() => {
        if (registered) throw new Error('listener bug');
      });
      registered = true;
      const seen: string[] = [];
      client.onStatusChange((s) => seen.push(s));
      void client.connect('ws://localhost:1').catch(() => {});
      expect(seen).toEqual(['disconnected', 'connecting']);
      expect(logger.error).toHaveBeenCalled();
      await client.disconnect();
    });

    it("a service call on the wire rejects with 'Connection closed' when the connection drops, after the status listener hears 'disconnected'", async () => {
      const client = make();
      const seen: string[] = [];
      client.onStatusChange((s) => seen.push(s));
      const connected = client.connect('ws://localhost:1');
      const socket = ws.last();
      if (client instanceof FoxgloveClient) {
        socket.simulateOpen('foxglove.websocket.v1');
        socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
        socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [] }));
        socket.simulateMessage(
          JSON.stringify({
            op: 'advertiseServices',
            services: [{ id: 1, name: '/x', type: 'std_srvs/srv/Trigger' }],
          }),
        );
      } else {
        socket.simulateOpen();
      }
      await connected;
      const call = client.callService('/x', {}, { timeoutMs: 60_000 }).then(
        () => seen.push('call-resolved'),
        (err: Error) => seen.push(`call-rejected:${err.message}`),
      );
      const onWire =
        client instanceof FoxgloveClient
          ? findSentServiceCallRequest(socket) !== null
          : socket.sentJson.some((m) => m.op === 'call_service' && m.service === '/x');
      expect(onWire).toBe(true);
      socket.simulateClose(1006, 'gone');
      await call;
      expect(seen.slice(-2)).toEqual(['disconnected', 'call-rejected:Connection closed']);
      await client.disconnect();
    });
  });

  it("Foxglove: on connect, 'connected', then the first topic list, then the code after `await connect()`", async () => {
    const client = new FoxgloveClient();
    const seen: string[] = [];
    client.onStatusChange((s) => seen.push(`status:${s}`));
    client.onTopicsChange((t) => seen.push(`topics:${t.length}`));
    const connected = client.connect('ws://localhost:8765').then(() => seen.push('resolved'));
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [channel(1, '/a')] }));
    await connected;
    expect(seen).toEqual([
      'status:disconnected',
      'status:connecting',
      'status:connected',
      'topics:1',
      'resolved',
    ]);
    await client.disconnect();
  });

  it("rosbridge: on connect, 'connected', then the code after `await connect()`, then the first topic list when discovery answers", async () => {
    const client = new RosbridgeClient();
    const seen: string[] = [];
    client.onStatusChange((s) => seen.push(`status:${s}`));
    client.onTopicsChange((t) => seen.push(`topics:${t.length}`));
    const connected = client.connect('ws://localhost:9090').then(() => seen.push('resolved'));
    const socket = ws.last();
    socket.simulateOpen();
    // Discovery answers before anything awaits connect(), so the order below
    // is the client's, not the test's.
    answerTopics(socket, ['/a']);
    await connected;
    await flush();
    expect(seen).toEqual([
      'status:disconnected',
      'status:connecting',
      'status:connected',
      'resolved',
      'topics:1',
    ]);
    await client.disconnect();
  });

  it('rosbridge: getAvailableTopics() calls onTopicsChange before it resolves when the answer changes the list, and not at all when it does not', async () => {
    const client = new RosbridgeClient();
    const connected = client.connect('ws://localhost:9090');
    const socket = ws.last();
    socket.simulateOpen();
    await connected;
    answerTopics(socket, ['/a']);
    await flush();

    const seen: string[] = [];
    client.onTopicsChange((t) => seen.push(`topics:${t.length}`));

    const same = client.getAvailableTopics().then((t) => seen.push(`resolved:${t.length}`));
    answerTopics(socket, ['/a']);
    await same;
    const changed = client.getAvailableTopics().then((t) => seen.push(`resolved:${t.length}`));
    answerTopics(socket, ['/a', '/b']);
    await changed;

    expect(seen).toEqual(['resolved:1', 'topics:2', 'resolved:2']);
    await client.disconnect();
  });

  it('Foxglove: getAvailableTopics() resolves from what the bridge advertised and calls no listener', async () => {
    const client = new FoxgloveClient();
    const connected = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [channel(1, '/a')] }));
    await connected;

    const seen: string[] = [];
    client.onTopicsChange((t) => seen.push(`topics:${t.length}`));
    const sent = socket.sentMessages.length;
    await client.getAvailableTopics().then((t) => seen.push(`resolved:${t.length}`));
    expect(seen).toEqual(['resolved:1']);
    expect(socket.sentMessages.length).toBe(sent);
    await client.disconnect();
  });
});
