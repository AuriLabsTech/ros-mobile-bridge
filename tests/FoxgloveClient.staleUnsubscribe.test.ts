// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * An unsubscribe closure acts at most once.
 *
 * Foxglove closures already route by `(topic, callback)` against the live
 * subscription, so a stale closure with a distinct callback detaches nothing.
 * What that routing cannot tell apart is a consumer that reuses one stable
 * callback (a memoized handler is the ordinary case): unsubscribe, subscribe
 * again with the same function, and a second call of the first closure used
 * to detach the new registration and take the topic off the wire. The
 * rosbridge twin of this is in `RosbridgeClient.staleUnsubscribe.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import { installMockWebSocket, type MockWebSocketHandle } from './_helpers/mock-websocket';

const CAM = '/cam';

describe('FoxgloveClient — stale unsubscribe closures', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  async function connectedClient(): Promise<FoxgloveClient> {
    const client = new FoxgloveClient();
    const promise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertise',
        channels: [
          { id: 1, topic: CAM, encoding: 'cdr', schemaName: 'demo/msg/Frame', schema: 'uint8 a' },
        ],
      }),
    );
    await promise;
    return client;
  }

  it('a second call of the same closure is a no-op even when the callback is reused', async () => {
    const client = await connectedClient();
    const onMessage = (): void => {};
    const unsubOld = client.subscribe(CAM, onMessage);
    unsubOld();
    client.subscribe(CAM, onMessage);

    unsubOld();

    expect(client.getSubscriptionState(CAM)).toBe('active');
  });
});
