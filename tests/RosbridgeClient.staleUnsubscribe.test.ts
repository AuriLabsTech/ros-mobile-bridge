// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * An unsubscribe closure that outlives the subscription it was issued for must
 * not tear down the topic's current subscription.
 *
 * Up to 0.1.13 each closure captured the callbacks map of the subscription
 * entry that existed when `subscribe()` returned. Once that entry was replaced
 * (a reconnect clears every entry and the consumer resubscribes, or the topic
 * is unsubscribed and subscribed again), a late call found its stale map
 * empty and unsubscribed the topic by name: the live entry was destroyed, an
 * `unsubscribe` frame went on the wire, and the healthy consumer went silent
 * with nothing to observe. Closures now route by `(topic, callback)` against
 * the live entry, as the Foxglove client does, and act at most once.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RosbridgeClient } from '../src/RosbridgeClient';
import { installMockWebSocket, type MockWebSocketHandle } from './_helpers/mock-websocket';

type Socket = ReturnType<MockWebSocketHandle['last']>;

const CAM = '/cam';
const CAM_OPTS = { schemaName: 'sensor_msgs/msg/CompressedImage' };

describe('RosbridgeClient — stale unsubscribe closures', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  async function connect(client: RosbridgeClient): Promise<Socket> {
    const promise = client.connect('ws://localhost:9090');
    const socket = ws.last();
    socket.simulateOpen();
    await promise;
    return socket;
  }

  function unsubscribeFrames(socket: Socket): number {
    return socket.sentJson.filter((m) => m.op === 'unsubscribe' && m.topic === CAM).length;
  }

  it("a sibling's pre-reconnect closure does not kill a healed subscription", async () => {
    const client = new RosbridgeClient();
    await connect(client);
    const unsubA = client.subscribe(CAM, () => {}, CAM_OPTS);
    const unsubB = client.subscribe(CAM, () => {}, CAM_OPTS);

    await client.disconnect();
    const socket = await connect(client);

    // A heals per the reconnect contract: drop the old closure, resubscribe.
    unsubA();
    client.subscribe(CAM, () => {}, CAM_OPTS);
    expect(client.getSubscriptionState(CAM)).toBe('active');

    // B unmounts later and calls the closure it got before the reconnect.
    unsubB();

    expect(client.getSubscriptionState(CAM)).toBe('active');
    expect(unsubscribeFrames(socket)).toBe(0);
  });

  it('calling a closure again after resubscribing does not kill the new subscription', async () => {
    const client = new RosbridgeClient();
    const socket = await connect(client);
    const unsubOld = client.subscribe(CAM, () => {}, CAM_OPTS);
    unsubOld();
    client.subscribe(CAM, () => {}, CAM_OPTS);
    const framesBefore = unsubscribeFrames(socket);

    unsubOld();

    expect(client.getSubscriptionState(CAM)).toBe('active');
    expect(unsubscribeFrames(socket)).toBe(framesBefore);
  });

  it('a second call of the same closure is a no-op even when the callback is reused', async () => {
    const client = new RosbridgeClient();
    await connect(client);
    const onMessage = (): void => {};
    const unsubOld = client.subscribe(CAM, onMessage, CAM_OPTS);
    unsubOld();
    client.subscribe(CAM, onMessage, CAM_OPTS);

    unsubOld();

    expect(client.getSubscriptionState(CAM)).toBe('active');
  });

  it('the live closure still unsubscribes, and the last one out takes the topic off the wire', async () => {
    const client = new RosbridgeClient();
    const socket = await connect(client);
    const unsubA = client.subscribe(CAM, () => {}, CAM_OPTS);
    const unsubB = client.subscribe(CAM, () => {}, CAM_OPTS);

    unsubA();
    expect(client.getSubscriptionState(CAM)).toBe('active');
    unsubB();
    expect(client.getSubscriptionState(CAM)).toBe('none');
    expect(unsubscribeFrames(socket)).toBe(1);
  });
});
