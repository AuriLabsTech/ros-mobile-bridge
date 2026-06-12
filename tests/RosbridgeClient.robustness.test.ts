import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RosbridgeClient } from '../src/RosbridgeClient';
import { installMockWebSocket, type MockWebSocketHandle } from './_helpers/mock-websocket';

describe('RosbridgeClient — connection teardown hygiene (F7)', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  it('detaches all WS handlers before closing, so a late onclose cannot fire into the next connection', async () => {
    const client = new RosbridgeClient();
    const promise = client.connect('ws://localhost:9090');
    const socket = ws.last();
    socket.simulateOpen();
    await promise;

    // Handlers are attached while the connection is live.
    expect(socket.onclose).not.toBeNull();
    expect(socket.onmessage).not.toBeNull();

    await client.disconnect();

    // After teardown every handler is detached — a delayed onclose from this
    // (now-dead) socket is a no-op rather than tearing down a later connection.
    expect(socket.onopen).toBeNull();
    expect(socket.onmessage).toBeNull();
    expect(socket.onerror).toBeNull();
    expect(socket.onclose).toBeNull();
  });
});

describe('RosbridgeClient — no zombie reconnect on initial-connect failure (F9)', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    ws.restore();
  });

  it('rejects the initial connect and does not start a background reconnect loop', async () => {
    const client = new RosbridgeClient();
    const connectPromise = client.connect('ws://localhost:9090');
    const socket = ws.last();

    const assertion = expect(connectPromise).rejects.toThrow();
    socket.simulateError('connection refused');
    await assertion;

    const socketsAfterFailure = ws.getInstances().length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ws.getInstances().length).toBe(socketsAfterFailure);
  });
});
