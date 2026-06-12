import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import { installMockWebSocket, type MockWebSocketHandle } from './_helpers/mock-websocket';

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
