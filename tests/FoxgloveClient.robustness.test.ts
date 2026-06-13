import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import { installMockWebSocket, type MockWebSocketHandle } from './_helpers/mock-websocket';
import { CircuitBreaker } from '../src/CircuitBreaker';

describe('FoxgloveClient — robustness against bad inbound data (F1)', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  async function openWithServerInfo() {
    const client = new FoxgloveClient();
    const connectPromise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    return { client, socket, connectPromise };
  }

  it('does not throw (or crash the host) on a malformed advertise frame', async () => {
    const { socket } = await openWithServerInfo();
    // `channels` missing entirely, and `channels` present but not an array.
    expect(() => socket.simulateMessage(JSON.stringify({ op: 'advertise' }))).not.toThrow();
    expect(() =>
      socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: 'nope' })),
    ).not.toThrow();
  });

  it('does not throw on malformed unadvertise / advertiseServices frames', async () => {
    const { socket } = await openWithServerInfo();
    expect(() => socket.simulateMessage(JSON.stringify({ op: 'unadvertise' }))).not.toThrow();
    expect(() =>
      socket.simulateMessage(JSON.stringify({ op: 'advertiseServices' })),
    ).not.toThrow();
    expect(() =>
      socket.simulateMessage(JSON.stringify({ op: 'unadvertise', channelIds: 7 })),
    ).not.toThrow();
  });

  it('a malformed advertise still completes the handshake (degrades to zero topics), and a later valid advertise works', async () => {
    const { client, socket, connectPromise } = await openWithServerInfo();
    // Malformed advertise arrives first — must not wedge the handshake.
    socket.simulateMessage(JSON.stringify({ op: 'advertise' }));
    await expect(connectPromise).resolves.toBeUndefined();

    // A subsequent valid advertise is processed normally.
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertise',
        channels: [
          { id: 1, topic: '/t', encoding: 'json', schemaName: 'std_msgs/msg/String', schema: '' },
        ],
      }),
    );
    const topics = await client.getAvailableTopics();
    expect(topics.map((t) => t.topic)).toContain('/t');
  });
});

describe('FoxgloveClient — connect() never hangs (F2)', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    ws.restore();
  });

  it('rejects on an endpoint that opens the socket but never speaks the protocol', async () => {
    const client = new FoxgloveClient();
    const connectPromise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1'); // opens, then silence

    let rejected: unknown = null;
    connectPromise.catch((e) => {
      rejected = e;
    });

    await vi.advanceTimersByTimeAsync(10_001); // past CONNECTION_TIMEOUT_MS

    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).message).toMatch(/timeout/i);
  });

  it('rejects when the socket closes before the handshake completes', async () => {
    const client = new FoxgloveClient();
    const connectPromise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');

    const assertion = expect(connectPromise).rejects.toThrow(/closed|handshake/i);
    socket.simulateClose(1006, 'gone'); // close before serverInfo/advertise
    await assertion;
  });
});

describe('FoxgloveClient — no zombie reconnect on initial-connect failure (F9)', () => {
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
    const client = new FoxgloveClient();
    const connectPromise = client.connect('ws://localhost:8765');
    const socket = ws.last();

    const assertion = expect(connectPromise).rejects.toThrow();
    socket.simulateError('connection refused'); // initial connect fails
    await assertion;

    const socketsAfterFailure = ws.getInstances().length;
    await vi.advanceTimersByTimeAsync(20_000); // past any reconnect backoff window
    // No new socket constructed => no background reconnect loop left running.
    expect(ws.getInstances().length).toBe(socketsAfterFailure);
  });
});

describe('FoxgloveClient — breaker teardown on disconnect (F8)', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    ws.restore();
  });

  it('destroys every subscription breaker on connection teardown', async () => {
    const destroySpy = vi.spyOn(CircuitBreaker.prototype, 'destroy');

    const client = new FoxgloveClient();
    const connectPromise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertise',
        channels: [
          { id: 1, topic: '/a', encoding: 'json', schemaName: 'std_msgs/msg/String', schema: '' },
          { id: 2, topic: '/b', encoding: 'json', schemaName: 'std_msgs/msg/String', schema: '' },
        ],
      }),
    );
    await connectPromise;

    client.subscribe('/a', () => {});
    client.subscribe('/b', () => {});

    // Two subscriptions => two breakers; none torn down yet.
    destroySpy.mockClear();
    await client.disconnect();

    // Connection-level cleanup destroys both. Combined with CircuitBreaker's
    // tested "destroy clears the cooldown timer", no breaker timer can survive
    // to fire half_open into the next connection (where ids are reused).
    expect(destroySpy).toHaveBeenCalledTimes(2);
  });
});
