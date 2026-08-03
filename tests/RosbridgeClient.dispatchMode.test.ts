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

  it('latest-only delivers the last frame of a burst after the topic falls silent', async () => {
    const { client, socket } = await connectedClient();
    vi.useFakeTimers();

    const received: RosMessage[] = [];
    client.subscribe('/state', (m) => received.push(m), {
      dispatchMode: 'latest-only',
      maxFrequency: 10, // 100 ms window
      disableAdaptive: true,
    });

    // First frame opens the window and is delivered on the drain.
    socket.simulateMessage(publishFrame('/state', 1));
    vi.advanceTimersByTime(1);
    expect(received).toHaveLength(1);

    // Second frame lands inside the window. Correctly gated for now.
    socket.simulateMessage(publishFrame('/state', 2));
    vi.advanceTimersByTime(1);
    expect(received).toHaveLength(1);

    // The topic now falls silent: no later frame will restate it. The gated
    // frame must still arrive once its window closes.
    vi.advanceTimersByTime(200);

    expect(received).toHaveLength(2);
    expect(received[1]!.data).toEqual({ seq: 2 });
  });

  it('latest-only conflates a burst to the newest frame with a cap in force', async () => {
    const { client, socket } = await connectedClient();
    vi.useFakeTimers();

    const received: RosMessage[] = [];
    client.subscribe('/state', (m) => received.push(m), {
      dispatchMode: 'latest-only',
      maxFrequency: 10, // 100 ms window
      disableAdaptive: true,
    });

    // Three frames in the same tick, all inside one window. Conflation is the
    // mode's defining capability and must not switch off because a cap is set:
    // the survivor is the newest frame, not the one that opened the window.
    socket.simulateMessage(publishFrame('/state', 1));
    socket.simulateMessage(publishFrame('/state', 2));
    socket.simulateMessage(publishFrame('/state', 3));

    vi.advanceTimersByTime(200);

    expect(received).toHaveLength(1);
    expect(received[0]!.data).toEqual({ seq: 3 });
  });

  it('latest-only does not deliver a gated frame before its window closes', async () => {
    const { client, socket } = await connectedClient();
    vi.useFakeTimers();

    const received: RosMessage[] = [];
    client.subscribe('/state', (m) => received.push(m), {
      dispatchMode: 'latest-only',
      maxFrequency: 10, // 100 ms window
      disableAdaptive: true,
    });

    socket.simulateMessage(publishFrame('/state', 1));
    vi.advanceTimersByTime(1);
    expect(received).toHaveLength(1); // window opens here

    socket.simulateMessage(publishFrame('/state', 2));
    vi.advanceTimersByTime(90); // 91 ms since delivery, still inside the window
    expect(received).toHaveLength(1);

    vi.advanceTimersByTime(20); // past 100 ms
    expect(received).toHaveLength(2);
  });

  it('latest-only sets the delivery clock at delivery, so the cap holds across trailing frames', async () => {
    const { client, socket } = await connectedClient();
    vi.useFakeTimers();

    const stamps: number[] = [];
    client.subscribe('/state', () => stamps.push(Date.now()), {
      dispatchMode: 'latest-only',
      maxFrequency: 10, // 100 ms window
      disableAdaptive: true,
    });

    // A 25 Hz trickle against a 10 Hz cap: every frame after the first lands
    // inside an open window, so delivery is paced by the drain, not by arrival.
    for (let i = 0; i < 6; i++) {
      socket.simulateMessage(publishFrame('/state', i));
      vi.advanceTimersByTime(40);
    }
    vi.advanceTimersByTime(200);

    // A 10 Hz cap fed at 25 Hz should deliver at 10 Hz: a steady 100 ms
    // cadence. Stamping the clock at stash time instead of at delivery makes
    // each drain re-arm against a clock the next arrival keeps pushing
    // forward, which stretches the cadence and loses deliveries.
    expect(stamps.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i]! - stamps[i - 1]!).toBe(100);
    }
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
