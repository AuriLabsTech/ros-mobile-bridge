// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * Foxglove pre-advertise subscribe (RMB-51): the wire frame requires a
 * `channelId`, so a subscribe on a topic the bridge has not advertised cannot
 * be expressed yet. Historically `subscribe()` warned and returned a no-op
 * closure: nothing was recorded, and a consumer that subscribed before the
 * topic appeared never received messages, with no way to ask the client what
 * happened.
 *
 * The contract now: `subscribe()` on an unknown topic (while connected)
 * records a pending subscription that activates automatically when the
 * channel advertises. Pending behaves like active in every consumer-visible
 * way except delivery: the returned closure cancels it, a second subscribe
 * merges into it, and `cleanup()` clears it on disconnect (the reconnect
 * contract is unchanged: the consumer resubscribes). `getSubscriptionState`
 * reports 'none' | 'pending' | 'active' so an app can render a "waiting for
 * topic" state. `subscribe()` while not connected stays a warn + no-op.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import {
  installMockWebSocket,
  foxgloveMessageDataFrame,
  type MockWebSocketHandle,
} from './_helpers/mock-websocket';

type Socket = ReturnType<MockWebSocketHandle['last']>;

const CHATTER = '/chatter';

/** JSON-encoded channel advertisement for `topic`. */
function advertise(socket: Socket, id: number, topic: string): void {
  socket.simulateMessage(
    JSON.stringify({
      op: 'advertise',
      channels: [
        { id, topic, encoding: 'json', schemaName: 'std_msgs/msg/String', schema: '' },
      ],
    }),
  );
}

/** Every `subscribe` op sent on `socket`, in order. */
function subscribeOps(socket: Socket): Array<{
  subscriptions: Array<{ id: number; channelId: number }>;
}> {
  return socket.sentJson.filter((m) => m.op === 'subscribe') as Array<{
    subscriptions: Array<{ id: number; channelId: number }>;
  }>;
}

/** Deliver a JSON payload on `subscriptionId` via the binary messageData frame. */
function deliver(socket: Socket, subscriptionId: number, payload: Record<string, unknown>): void {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  socket.simulateMessage(foxgloveMessageDataFrame(subscriptionId, 0n, bytes));
}

describe('FoxgloveClient — pre-advertise subscribe (RMB-51)', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  async function connectedClient(): Promise<{ client: FoxgloveClient; socket: Socket }> {
    const client = new FoxgloveClient();
    const promise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [] }));
    await promise;
    return { client, socket };
  }

  it('records a pending subscription for an unknown topic and reports it via getSubscriptionState', async () => {
    const { client, socket } = await connectedClient();

    expect(client.getSubscriptionState(CHATTER)).toBe('none');

    const unsubscribe = client.subscribe(CHATTER, () => {});

    expect(typeof unsubscribe).toBe('function');
    expect(client.getSubscriptionState(CHATTER)).toBe('pending');
    // Nothing can go on the wire yet: the frame needs a channelId.
    expect(subscribeOps(socket)).toHaveLength(0);
  });

  it('activates a pending subscription when the channel advertises, and delivers', async () => {
    const { client, socket } = await connectedClient();

    const received: Array<Record<string, unknown>> = [];
    client.subscribe(CHATTER, (msg) => {
      received.push(msg.data as Record<string, unknown>);
    });

    advertise(socket, 7, CHATTER);

    const ops = subscribeOps(socket);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.subscriptions[0]!.channelId).toBe(7);
    expect(client.getSubscriptionState(CHATTER)).toBe('active');

    deliver(socket, ops[0]!.subscriptions[0]!.id, { data: 'hi' });
    expect(received).toEqual([{ data: 'hi' }]);
  });

  it('a cancelled pending subscription activates nothing when the topic later advertises', async () => {
    const { client, socket } = await connectedClient();

    const unsubscribe = client.subscribe(CHATTER, () => {});
    unsubscribe();
    expect(client.getSubscriptionState(CHATTER)).toBe('none');

    advertise(socket, 7, CHATTER);

    expect(subscribeOps(socket)).toHaveLength(0);
    expect(client.getSubscriptionState(CHATTER)).toBe('none');
  });

  it('merges a second subscriber into the pending entry and removes per callback', async () => {
    const { client, socket } = await connectedClient();

    const seenA: string[] = [];
    const seenB: string[] = [];
    client.subscribe(CHATTER, (m) => seenA.push((m.data as { data: string }).data));
    const unsubB = client.subscribe(CHATTER, (m) => seenB.push((m.data as { data: string }).data));

    // Removing one callback leaves the other pending.
    unsubB();
    expect(client.getSubscriptionState(CHATTER)).toBe('pending');

    advertise(socket, 3, CHATTER);

    // One subscription for the topic; only the surviving callback delivers.
    const ops = subscribeOps(socket);
    expect(ops).toHaveLength(1);
    deliver(socket, ops[0]!.subscriptions[0]!.id, { data: 'x' });
    expect(seenA).toEqual(['x']);
    expect(seenB).toEqual([]);
  });

  it('a closure obtained while pending unsubscribes the activated subscription', async () => {
    const { client, socket } = await connectedClient();

    const unsubscribe = client.subscribe(CHATTER, () => {});
    advertise(socket, 5, CHATTER);
    expect(client.getSubscriptionState(CHATTER)).toBe('active');

    unsubscribe();

    expect(client.getSubscriptionState(CHATTER)).toBe('none');
    const unsubOps = socket.sentJson.filter((m) => m.op === 'unsubscribe');
    expect(unsubOps).toHaveLength(1);
  });

  it('clears pending subscriptions on disconnect (reconnect contract unchanged)', async () => {
    const { client } = await connectedClient();

    client.subscribe(CHATTER, () => {});
    expect(client.getSubscriptionState(CHATTER)).toBe('pending');

    await client.disconnect();
    expect(client.getSubscriptionState(CHATTER)).toBe('none');

    // Reconnect with the topic present from the start: the old pending must
    // not resurrect itself — resubscribing after reconnect is the consumer's.
    const promise = client.connect('ws://localhost:8765');
    const socket2 = ws.last();
    socket2.simulateOpen('foxglove.websocket.v1');
    socket2.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    advertise(socket2, 1, CHATTER);
    await promise;

    expect(subscribeOps(socket2)).toHaveLength(0);
    expect(client.getSubscriptionState(CHATTER)).toBe('none');
  });

  it('subscribe while not connected warns and returns a no-op closure (no pending created)', async () => {
    const warnings: unknown[][] = [];
    const client = new FoxgloveClient({
      logger: {
        log: () => {},
        warn: (...args: unknown[]) => warnings.push(args),
        error: () => {},
      },
    });

    const unsubscribe = client.subscribe(CHATTER, () => {});

    expect(typeof unsubscribe).toBe('function');
    unsubscribe(); // must not throw
    expect(client.getSubscriptionState(CHATTER)).toBe('none');
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('ignores SubscribeOptions.schemaName (the wire needs an advertised channel regardless)', async () => {
    const { client, socket } = await connectedClient();

    // The hint changes nothing on this transport: the subscription is pending
    // until the channel advertises, exactly as without it.
    client.subscribe(CHATTER, () => {}, { schemaName: 'std_msgs/msg/String' });

    expect(client.getSubscriptionState(CHATTER)).toBe('pending');
    expect(subscribeOps(socket)).toHaveLength(0);

    advertise(socket, 4, CHATTER);
    expect(client.getSubscriptionState(CHATTER)).toBe('active');
    expect(subscribeOps(socket)).toHaveLength(1);
  });

  it('applies the recorded SubscribeOptions when a pending subscription activates', async () => {
    const { client, socket } = await connectedClient();

    // 1 Hz cap recorded while pending; must throttle after activation.
    const received: unknown[] = [];
    client.subscribe(CHATTER, (m) => received.push(m.data), { maxFrequency: 1 });

    advertise(socket, 2, CHATTER);
    const subId = subscribeOps(socket)[0]!.subscriptions[0]!.id;

    deliver(socket, subId, { data: 'first' });
    deliver(socket, subId, { data: 'second' }); // within the 1000 ms window
    expect(received).toEqual([{ data: 'first' }]);
  });
});
