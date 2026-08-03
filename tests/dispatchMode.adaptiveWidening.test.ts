/**
 * `latest-only` trailing delivery, fourth clause: a drain armed under one
 * interval must not deliver early if the adaptive throttle widens the interval
 * before the drain fires. The drain re-checks the window and re-arms for the
 * remainder instead.
 *
 * Widening is driven the way the Layer 1 regression gate drives it — by mocking
 * the `EventLoopMonitor` module boundary, the same injection point
 * `throttle.scenarios.test.ts` uses. Observation stays at the public seam: the
 * subscribe callback, never the tracker or the entry state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import { RosbridgeClient } from '../src/RosbridgeClient';
import type { RosMessage } from '../src/types';
import {
  installMockWebSocket,
  foxgloveMessageDataFrame,
  type MockWebSocketHandle,
} from './_helpers/mock-websocket';

// `vi.hoisted` + `vi.mock` are hoisted above the imports by vitest's transform,
// so the mocked lag getters are in place before the clients resolve the module.
const lag = vi.hoisted(() => ({ max: 0, sustained: 0 }));
vi.mock('../src/EventLoopMonitor', () => ({
  getMaxLagMs: () => lag.max,
  getSustainedLagMs: () => lag.sustained,
  setModeGetter: () => {},
}));

// `auto` boots at the 200 ms bucket. A max-lag reading past the 200 ms
// threshold moves it to the 1000 ms bucket on the next `recordBytes`. Both
// numbers come from `DEFAULT_PRESETS`, which is `@experimental` — the test
// asserts on relative behavior (delivery is deferred, not dropped), so a
// rebalance changes the timing but not the outcome.
const WIDENING_LAG_MS = 250;

describe('latest-only — a widening adaptive interval defers, never delivers early', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    lag.max = 0;
    lag.sustained = 0;
    ws = installMockWebSocket();
  });

  afterEach(() => {
    vi.useRealTimers();
    ws.restore();
  });

  it('FoxgloveClient re-arms the drain instead of firing on a stale deadline', async () => {
    const client = new FoxgloveClient({ getThrottleMode: () => 'auto' });
    const connectPromise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertise',
        channels: [
          { id: 5, topic: '/raw', encoding: 'cdr', schemaName: 'sensor_msgs/msg/Image', schema: '' },
        ],
      }),
    );
    await connectPromise;
    vi.useFakeTimers();

    const received: RosMessage[] = [];
    client.subscribe('/raw', (m) => received.push(m), { dispatchMode: 'latest-only' });

    const frame = (tag: number) =>
      foxgloveMessageDataFrame(1, 0n, new Uint8Array(8).fill(tag));

    // First frame opens the window.
    socket.simulateMessage(frame(0xa1));
    vi.advanceTimersByTime(1);
    expect(received).toHaveLength(1);

    // Second frame is gated and arms a drain against the *current* interval.
    vi.advanceTimersByTime(49);
    socket.simulateMessage(frame(0xb2));

    // The JS thread now stalls. The next frame's accounting widens the cap.
    lag.max = WIDENING_LAG_MS;
    vi.advanceTimersByTime(50);
    socket.simulateMessage(frame(0xc3));

    // Past the deadline the first drain was armed for, but inside the widened
    // window. Delivering here would honor a cap the throttle has already
    // replaced.
    vi.advanceTimersByTime(200);
    expect(received).toHaveLength(1);

    // Deferred, not dropped: it arrives once the widened window closes.
    vi.advanceTimersByTime(1000);
    expect(received).toHaveLength(2);
    expect(Array.from(received[1]!.data as Uint8Array)).toEqual(
      Array.from(new Uint8Array(8).fill(0xc3)),
    );
  });

  it('RosbridgeClient re-arms the drain instead of firing on a stale deadline', async () => {
    const client = new RosbridgeClient({ getThrottleMode: () => 'auto' });
    const promise = client.connect('ws://localhost:9090');
    const socket = ws.last();
    socket.simulateOpen();
    await promise;
    vi.useFakeTimers();

    const received: RosMessage[] = [];
    client.subscribe('/state', (m) => received.push(m), { dispatchMode: 'latest-only' });

    const frame = (seq: number) =>
      JSON.stringify({ op: 'publish', topic: '/state', msg: { seq } });

    socket.simulateMessage(frame(1));
    vi.advanceTimersByTime(1);
    expect(received).toHaveLength(1);

    vi.advanceTimersByTime(49);
    socket.simulateMessage(frame(2));

    lag.max = WIDENING_LAG_MS;
    vi.advanceTimersByTime(50);
    socket.simulateMessage(frame(3));

    vi.advanceTimersByTime(200);
    expect(received).toHaveLength(1);

    vi.advanceTimersByTime(1000);
    expect(received).toHaveLength(2);
    expect(received[1]!.data).toEqual({ seq: 3 });
  });
});
