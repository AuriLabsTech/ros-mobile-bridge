import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RosbridgeClient } from '../src/RosbridgeClient';
import type { ConnectionStatus } from '../src/types';
import {
  installMockWebSocket,
  MockWebSocket,
  withFakeTimers,
  type MockWebSocketHandle,
} from './_helpers/mock-websocket';

describe('RosbridgeClient connect abort (ADR 0003)', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });

  afterEach(() => {
    ws.restore();
  });

  it('rejects immediately on a pre-aborted signal without creating a socket', async () => {
    const client = new RosbridgeClient();
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.connect('ws://localhost:9090', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(ws.getInstances().length).toBe(0);
    expect(client.isConnected).toBe(false);
  });

  it('aborting mid-attempt closes the socket, rejects, and leaves clean state with no reconnect', async () => {
    await withFakeTimers(async () => {
      const client = new RosbridgeClient();
      const statuses: ConnectionStatus[] = [];
      client.onStatusChange((s) => statuses.push(s));
      const controller = new AbortController();

      const promise = client.connect('ws://localhost:9090', { signal: controller.signal });
      const socket = ws.last();
      // The socket never opens — abort lands while CONNECTING.

      controller.abort();

      await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
      expect(socket.readyState).toBe(MockWebSocket.CLOSED);
      expect(client.isConnected).toBe(false);
      expect(client.getLastError()).toBeNull();
      expect(statuses[statuses.length - 1]).toBe('disconnected');

      // Well past the connection timeout and every reconnect backoff step:
      // no new socket may appear.
      vi.advanceTimersByTime(60_000);
      expect(ws.getInstances().length).toBe(1);
    });
  });

  it('disconnect() during an in-flight attempt rejects the pending connect with AbortError', async () => {
    const client = new RosbridgeClient();
    const promise = client.connect('ws://localhost:9090'); // no signal involved

    await client.disconnect();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(client.isConnected).toBe(false);
    expect(client.getLastError()).toBeNull();
  });

  it('passes a custom abort(reason) value through to the rejection, fetch-style', async () => {
    const client = new RosbridgeClient();
    const controller = new AbortController();
    const promise = client.connect('ws://localhost:9090', { signal: controller.signal });

    const reason = new Error('screen unmounted');
    controller.abort(reason);

    await expect(promise).rejects.toBe(reason);
  });

  it('ignores an abort after connect resolved — the signal governs the attempt, not the connection', async () => {
    const client = new RosbridgeClient();
    const controller = new AbortController();
    const promise = client.connect('ws://localhost:9090', { signal: controller.signal });
    const socket = ws.last();
    socket.simulateOpen();
    await promise;
    expect(client.isConnected).toBe(true);

    controller.abort();

    expect(client.isConnected).toBe(true);
    expect(socket.readyState).toBe(MockWebSocket.OPEN);

    await client.disconnect();
  });

  it('pre-handles the cancellation so fire-and-forget connect() sees no unhandled rejection', async () => {
    const client = new RosbridgeClient();
    void client.connect('ws://localhost:9090'); // promise deliberately not retained

    await client.disconnect();

    // Give the unhandled-rejection queue a macrotask to flush; vitest fails
    // the test file if the cancellation rejection was not pre-handled.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.isConnected).toBe(false);
  });

  it('a connect() while already connecting early-returns and its signal is ignored', async () => {
    const client = new RosbridgeClient();
    const first = client.connect('ws://localhost:9090');
    const socket = ws.last();

    const controller = new AbortController();
    await client.connect('ws://other:9999', { signal: controller.signal });
    controller.abort(); // must not touch the in-flight attempt

    socket.simulateOpen();
    await first;

    expect(client.isConnected).toBe(true);
    expect(ws.getInstances().length).toBe(1);

    await client.disconnect();
  });
});
