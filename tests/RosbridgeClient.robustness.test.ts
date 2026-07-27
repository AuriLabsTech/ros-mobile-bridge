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

    // After teardown a delayed event from this (now-dead) socket is a no-op
    // rather than tearing down a later connection: onopen/onmessage/onclose
    // are detached outright, while onerror keeps a no-op listener because an
    // unlistened 'error' crashes the host on the ws package.
    expect(socket.onopen).toBeNull();
    expect(socket.onmessage).toBeNull();
    expect(socket.onclose).toBeNull();
    expect(() => socket.simulateError('late error from dead socket')).not.toThrow();
  });
});

describe('RosbridgeClient — error events on a torn-down socket cannot crash the host', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  it('swallows the error the ws package emits when a mid-handshake socket is closed', async () => {
    const client = new RosbridgeClient();
    const controller = new AbortController();
    const promise = client.connect('ws://localhost:9090', { signal: controller.signal });
    const socket = ws.last();

    // The socket never opens — teardown lands while CONNECTING. On the ws
    // package, close() in this state emits 'error' ("WebSocket was closed
    // before the connection was established") after cleanup has run.
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });

    expect(() =>
      socket.simulateError('WebSocket was closed before the connection was established'),
    ).not.toThrow();
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

describe('RosbridgeClient — malformed publish frames do not crash (F1 parity)', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  async function connectedSubscribed() {
    const client = new RosbridgeClient();
    const promise = client.connect('ws://localhost:9090');
    const socket = ws.last();
    socket.simulateOpen();
    await promise;
    client.subscribe('/chaos', () => {});
    return { client, socket };
  }

  // Hostile / buggy publish frames (from a chaos/fuzz server, rosbridge mode). Each
  // must be swallowed: no throw out of the message handler, connection intact.
  const malformedFrames = [
    '{"op":"publish","topic":"/chaos","msg":"not-an-object"}',
    '{"op":"publish","topic":"/chaos"}',
    '{"op":"publish","msg":{"x":1}}',
    '{"op":"publish","topic":123,"msg":{}}',
    '{"op":"publish","topic":"/chaos","msg":[1,2]}',
    'not valid json at all',
    '{"op":"publish"',
    '{}',
    '{"op":12345}',
  ];

  it('swallows every malformed publish frame and stays connected', async () => {
    const { client, socket } = await connectedSubscribed();
    for (const frame of malformedFrames) {
      expect(() => socket.simulateMessage(frame)).not.toThrow();
    }
    expect(client.isConnected).toBe(true);
  });
});
