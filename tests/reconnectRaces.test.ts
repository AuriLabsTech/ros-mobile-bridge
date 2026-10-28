// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * A connect() the consumer makes while the automatic reconnect is pending
 * replaces that reconnect: one socket, and the consumer's promise settles.
 * Both clients, since the reconnect cycle is the same shape on each.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import { RosbridgeClient } from '../src/RosbridgeClient';
import {
  disconnectUnderFakeTimers,
  installMockWebSocket,
  type MockWebSocketHandle,
} from './_helpers/mock-websocket';

type Socket = ReturnType<MockWebSocketHandle['last']>;

const quiet = { logger: { log() {}, warn() {}, error() {} } };

const transports = [
  {
    name: 'FoxgloveClient',
    make: () => new FoxgloveClient(quiet),
    open: (s: Socket): void => {
      s.simulateOpen('foxglove.sdk.v1');
      s.simulateMessage(JSON.stringify({ op: 'serverInfo', name: '', capabilities: [] }));
      s.simulateMessage(JSON.stringify({ op: 'advertise', channels: [] }));
    },
  },
  {
    name: 'RosbridgeClient',
    make: () => new RosbridgeClient(quiet),
    open: (s: Socket): void => s.simulateOpen(),
  },
];

describe.each(transports)('$name: a connect() during the reconnect wait', ({ make, open }) => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    vi.useFakeTimers();
    ws = installMockWebSocket();
  });

  afterEach(() => {
    ws.restore();
    vi.useRealTimers();
  });

  async function connectedThenDropped(client: ReturnType<typeof make>): Promise<void> {
    const first = client.connect('ws://robot:9090');
    open(ws.last());
    await first;
    ws.last().simulateClose(1006, 'gone'); // arms the 1 s reconnect
  }

  it('connect() after the drop cancels the pending reconnect and settles', async () => {
    const client = make();
    let status = '';
    client.onStatusChange((s) => (status = s));
    await connectedThenDropped(client);
    expect(status).toBe('disconnected');

    let settled = false;
    void client.connect('ws://robot:9090').then(() => (settled = true));
    const mine = ws.last();
    await vi.advanceTimersByTimeAsync(1_100); // past the reconnect delay
    expect(ws.getInstances()).toHaveLength(2);

    open(mine);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    expect(status).toBe('connected');

    await disconnectUnderFakeTimers(client);
  });

  it('a status listener that connects on disconnected is not followed by a second socket', async () => {
    const client = make();
    const first = client.connect('ws://robot:9090');
    open(ws.last());
    await first;

    let status = '';
    let listenerConnect: Promise<void> | null = null;
    client.onStatusChange((s) => {
      status = s;
      if (s === 'disconnected') listenerConnect = client.connect('ws://robot:9090');
    });
    ws.last().simulateClose(1006, 'gone');
    expect(listenerConnect).not.toBeNull();
    const mine = ws.last();

    await vi.advanceTimersByTimeAsync(1_100); // past the reconnect delay
    expect(ws.getInstances()).toHaveLength(2);

    open(mine);
    await expect(listenerConnect).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ws.getInstances()).toHaveLength(2);
    expect(status).toBe('connected');

    await disconnectUnderFakeTimers(client);
  });

  it('a status listener that connects on error after a failed reconnect attempt gets a working connection', async () => {
    const client = make();
    await connectedThenDropped(client);
    await vi.advanceTimersByTimeAsync(1_100); // the reconnect attempt opens its socket
    expect(ws.getInstances()).toHaveLength(2);

    let status = '';
    let listenerConnect: Promise<void> | null = null;
    client.onStatusChange((s) => {
      status = s;
      if (s === 'error' && listenerConnect === null) {
        listenerConnect = client.connect('ws://robot:9090');
      }
    });
    ws.last().simulateError('refused');
    expect(listenerConnect).not.toBeNull();
    expect(ws.getInstances()).toHaveLength(3);
    const mine = ws.last();

    open(mine);
    await expect(listenerConnect).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ws.getInstances()).toHaveLength(3);
    expect(status).toBe('connected');

    await disconnectUnderFakeTimers(client);
  });

  it('a listener connect() that fails during the reconnect cycle leaves the cycle running', async () => {
    const client = make();
    const first = client.connect('ws://robot:9090');
    open(ws.last());
    await first;

    let status = '';
    let listenerConnect: Promise<void> | null = null;
    client.onStatusChange((s) => {
      status = s;
      if (s === 'disconnected' && listenerConnect === null) {
        listenerConnect = client.connect('ws://robot:9090');
      }
    });
    ws.last().simulateClose(1006, 'gone'); // the bridge restarts
    expect(listenerConnect).not.toBeNull();
    ws.last().simulateError('refused'); // still down
    await expect(listenerConnect).rejects.toThrow();

    await vi.advanceTimersByTimeAsync(20_000); // the backoff tries again
    expect(ws.getInstances().length).toBeGreaterThan(2);
    open(ws.last());
    await vi.advanceTimersByTimeAsync(0);
    expect(status).toBe('connected');

    await disconnectUnderFakeTimers(client);
  });

  it('a status listener that connects on the error ending the last attempt gets a working connection', async () => {
    const client = make();
    await connectedThenDropped(client);

    let status = '';
    let listenerConnect: Promise<void> | null = null;
    for (let attempt = 1; attempt <= client.maxReconnectAttempts; attempt++) {
      // Exactly this attempt's backoff (1, 2, 4, 8, 16 s), short of its
      // connection timeout, so it opens its socket and no more.
      await vi.advanceTimersByTimeAsync(1_000 * 2 ** (attempt - 1) + 50);
      expect(ws.getInstances()).toHaveLength(1 + attempt);
      if (attempt === client.maxReconnectAttempts) {
        client.onStatusChange((s) => {
          status = s;
          if (s === 'error' && listenerConnect === null) {
            listenerConnect = client.connect('ws://robot:9090');
          }
        });
      }
      ws.last().simulateError('refused');
    }
    expect(listenerConnect).not.toBeNull();
    const sockets = ws.getInstances().length;
    expect(status).toBe('connecting');

    open(ws.last());
    await expect(listenerConnect).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ws.getInstances()).toHaveLength(sockets);
    expect(status).toBe('connected');

    await disconnectUnderFakeTimers(client);
  });

  it('a connect() during the wait that is aborted ends the cycle', async () => {
    const client = make();
    await connectedThenDropped(client);
    expect(client.reconnectAttempt).toBe(1);

    const controller = new AbortController();
    const mine = client.connect('ws://robot:9090', { signal: controller.signal });
    controller.abort();
    await expect(mine).rejects.toThrow();
    expect(client.reconnectAttempt).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ws.getInstances()).toHaveLength(2);
  });

  it('a connect() to another address during the wait starts afresh: a failure is not retried', async () => {
    const client = make();
    await connectedThenDropped(client);

    const elsewhere = client.connect('ws://other:9090');
    ws.last().simulateError('refused');
    await expect(elsewhere).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ws.getInstances()).toHaveLength(2);
    expect(client.reconnectAttempt).toBe(0);
  });

  it('a status listener that disconnects on disconnected stops the reconnect', async () => {
    const client = make();
    const first = client.connect('ws://robot:9090');
    open(ws.last());
    await first;

    client.onStatusChange((s) => {
      if (s === 'disconnected') void client.disconnect();
    });
    ws.last().simulateClose(1006, 'gone');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ws.getInstances()).toHaveLength(1);
  });
});
