// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * rosbridge pre-advertise subscribe: a subscribe on a topic discovery has not
 * typed yet goes out typeless, and whether it ever establishes at the bridge
 * is invisible to the client (a rejected subscribe produces a rosout ERROR
 * server-side and no `status` op). The subscription is therefore *pending*:
 * established-ness cannot be confirmed yet. It becomes active when the client
 * can confirm establishment: a typed subscribe frame went out (the type was
 * known at subscribe time, was supplied via `SubscribeOptions.schemaName`, or
 * the discovery self-heal re-subscribed), or delivery was observed on the
 * typeless frame (the bridge resolved the type from a live publisher).
 *
 * `getSubscriptionState` reports 'none' | 'pending' | 'active'. Active means
 * establishment, not delivery: a quiet topic is active, and a breaker-paused
 * subscription stays active (breaker state has its own observer).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RosbridgeClient } from '../src/RosbridgeClient';
import {
  installMockWebSocket,
  type MockWebSocketHandle,
} from './_helpers/mock-websocket';

type Socket = ReturnType<MockWebSocketHandle['last']>;

const TF = '/tf';
const TF_TYPE = 'tf2_msgs/msg/TFMessage';

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

/** Flush the microtask chain (callService resolve -> .then -> setTopicsIfChanged). */
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

/** Every `subscribe` frame sent on `socket` for `topic`, in order. */
function subscribeFrames(socket: Socket, topic: string): Record<string, unknown>[] {
  return socket.sentJson.filter(
    (m) => m.op === 'subscribe' && m.topic === topic,
  ) as Record<string, unknown>[];
}

describe('RosbridgeClient — pending subscriptions and getSubscriptionState', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  async function connectedClient(): Promise<{ client: RosbridgeClient; socket: Socket }> {
    const client = new RosbridgeClient();
    const promise = client.connect('ws://localhost:9090');
    const socket = ws.last();
    socket.simulateOpen();
    await promise;
    return { client, socket };
  }

  it('reports pending for a typeless subscribe and active for a typed one', async () => {
    const { client, socket } = await connectedClient();
    respondTopics(socket, [TF], [TF_TYPE]);
    await flush();

    expect(client.getSubscriptionState('/late')).toBe('none');

    // Unknown to discovery: frame goes out typeless; establishment unknowable.
    client.subscribe('/late', () => {});
    expect(client.getSubscriptionState('/late')).toBe('pending');

    // Known to discovery: frame carries the type; establishment confirmed.
    client.subscribe(TF, () => {});
    expect(client.getSubscriptionState(TF)).toBe('active');
  });

  it('promotes a pending subscription to active on first observed delivery', async () => {
    const { client, socket } = await connectedClient();

    client.subscribe('/late', () => {});
    expect(client.getSubscriptionState('/late')).toBe('pending');

    // The bridge resolved the type from a live publisher and delivers on the
    // typeless subscription: establishment is confirmed by the delivery.
    socket.simulateMessage(
      JSON.stringify({ op: 'publish', topic: '/late', msg: { data: 1 } }),
    );
    expect(client.getSubscriptionState('/late')).toBe('active');
  });

  it('promotes on delivery observed by the pre-parse fast path (latest-only subscriber)', async () => {
    const { client, socket } = await connectedClient();

    client.subscribe('/late', () => {}, { dispatchMode: 'latest-only' });
    expect(client.getSubscriptionState('/late')).toBe('pending');

    // A latest-only subscriber is served exclusively by the pre-parse path;
    // promotion must happen on frame arrival there, not only in handlePublish.
    socket.simulateMessage(
      JSON.stringify({ op: 'publish', topic: '/late', msg: { data: 1 } }),
    );
    expect(client.getSubscriptionState('/late')).toBe('active');
  });

  it('promotes when the discovery self-heal re-subscribes typed, before any delivery', async () => {
    const { client, socket } = await connectedClient();

    // Subscribe before the on-connect discovery resolves: typeless, pending.
    client.subscribe(TF, () => {});
    expect(client.getSubscriptionState(TF)).toBe('pending');

    // Discovery learns the type; the self-heal sends the typed subscribe.
    // Establishment is now confirmed even though the topic is quiet.
    respondTopics(socket, [TF], [TF_TYPE]);
    await flush();

    expect(subscribeFrames(socket, TF)).toHaveLength(2);
    expect(client.getSubscriptionState(TF)).toBe('active');
  });

  it('sends a consumer-supplied schemaName while discovery is silent, and reports active', async () => {
    const { client, socket } = await connectedClient();
    respondTopics(socket, ['/rosout'], ['rcl_interfaces/msg/Log']);
    await flush();

    // Discovery does not know /mode_gated yet; the hint types the frame, which
    // registers the subscription server-side even before a publisher exists.
    client.subscribe('/mode_gated', () => {}, { schemaName: 'std_msgs/msg/Bool' });

    const frames = subscribeFrames(socket, '/mode_gated');
    expect(frames).toHaveLength(1);
    expect(frames[0]!.type).toBe('std_msgs/msg/Bool');
    expect(client.getSubscriptionState('/mode_gated')).toBe('active');
  });

  it('ignores the hint when discovery already knows the type', async () => {
    const { client, socket } = await connectedClient();
    respondTopics(socket, [TF], [TF_TYPE]);
    await flush();

    client.subscribe(TF, () => {}, { schemaName: 'std_msgs/msg/Bool' });

    const frames = subscribeFrames(socket, TF);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.type).toBe(TF_TYPE);
    expect(client.getSubscriptionState(TF)).toBe('active');
  });

  it('clears subscription state on disconnect', async () => {
    const { client } = await connectedClient();

    client.subscribe('/late', () => {});
    expect(client.getSubscriptionState('/late')).toBe('pending');

    await client.disconnect();
    expect(client.getSubscriptionState('/late')).toBe('none');
  });

  it('subscribe while not connected warns and returns a no-op closure', async () => {
    const warnings: unknown[][] = [];
    const client = new RosbridgeClient({
      logger: {
        log: () => {},
        warn: (...args: unknown[]) => warnings.push(args),
        error: () => {},
      },
    });

    const unsubscribe = client.subscribe(TF, () => {});

    expect(typeof unsubscribe).toBe('function');
    unsubscribe(); // must not throw
    expect(client.getSubscriptionState(TF)).toBe('none');
    expect(warnings.length).toBeGreaterThan(0);
  });
});
