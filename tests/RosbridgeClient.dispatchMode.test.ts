import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RosbridgeClient } from '../src/RosbridgeClient';
import type { RosMessage } from '../src/types';
import { installMockWebSocket, type MockWebSocketHandle } from './_helpers/mock-websocket';

describe('RosbridgeClient — dispatchMode', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });

  afterEach(() => {
    vi.useRealTimers();
    ws.restore();
  });

  async function connectedClient() {
    const client = new RosbridgeClient();
    const promise = client.connect('ws://localhost:9090');
    const socket = ws.last();
    socket.simulateOpen();
    await promise;
    return { client, socket };
  }

  function publishFrame(topic: string, seq: number): string {
    return JSON.stringify({ op: 'publish', topic, msg: { seq } });
  }

  it('immediate (default) delivers synchronously, with no timer to drain', async () => {
    const { client, socket } = await connectedClient();

    const received: RosMessage[] = [];
    client.subscribe('/state', (m) => received.push(m)); // default: immediate

    socket.simulateMessage(publishFrame('/state', 7));

    expect(received).toHaveLength(1);
    expect(received[0]!.data).toEqual({ seq: 7 });
  });

  it('latest-only defers off-tick and conflates a burst to the newest frame', async () => {
    const { client, socket } = await connectedClient();
    vi.useFakeTimers();

    const received: RosMessage[] = [];
    client.subscribe('/state', (m) => received.push(m), {
      dispatchMode: 'latest-only',
      disableAdaptive: true,
    });

    socket.simulateMessage(publishFrame('/state', 1));
    socket.simulateMessage(publishFrame('/state', 2));
    socket.simulateMessage(publishFrame('/state', 3));

    // Deferred — nothing parsed or delivered yet.
    expect(received).toHaveLength(0);

    vi.runOnlyPendingTimers();

    expect(received).toHaveLength(1);
    expect(received[0]!.data).toEqual({ seq: 3 });
  });

  it('latest-only discards the pending frame on unsubscribe — no post-teardown delivery', async () => {
    const { client, socket } = await connectedClient();
    vi.useFakeTimers();

    const received: RosMessage[] = [];
    const unsubscribe = client.subscribe('/state', (m) => received.push(m), {
      dispatchMode: 'latest-only',
      disableAdaptive: true,
    });

    socket.simulateMessage(publishFrame('/state', 1));
    expect(received).toHaveLength(0); // armed, not yet drained

    unsubscribe();
    vi.runOnlyPendingTimers();

    expect(received).toHaveLength(0);
  });

  it('latest-only discards the pending frame on disconnect', async () => {
    const { client, socket } = await connectedClient();
    vi.useFakeTimers();

    const received: RosMessage[] = [];
    client.subscribe('/state', (m) => received.push(m), {
      dispatchMode: 'latest-only',
      disableAdaptive: true,
    });

    socket.simulateMessage(publishFrame('/state', 1));
    expect(received).toHaveLength(0);

    await client.disconnect();
    vi.runOnlyPendingTimers();

    expect(received).toHaveLength(0);
  });

  it('a throwing latest-only callback is contained and does not wedge future delivery', async () => {
    const { client, socket } = await connectedClient();
    vi.useFakeTimers();

    let calls = 0;
    client.subscribe(
      '/state',
      () => {
        calls++;
        if (calls === 1) throw new Error('boom');
      },
      { dispatchMode: 'latest-only', disableAdaptive: true },
    );

    socket.simulateMessage(publishFrame('/state', 1));
    vi.runOnlyPendingTimers(); // first drain throws, is caught
    expect(calls).toBe(1);

    socket.simulateMessage(publishFrame('/state', 2));
    vi.runOnlyPendingTimers(); // not wedged
    expect(calls).toBe(2);
  });
});
