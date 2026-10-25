// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * `getLinkBacklogMs()` (ADR 0028). Foxglove WebSocket reads it from the
 * timestamp on every `messageData` frame; rosbridge sends no server timestamp
 * on its JSON frames, so it answers `null` rather than a reading of zero.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import { RosbridgeClient } from '../src/RosbridgeClient';
import { ZenohClient } from '../src/ZenohClient';
import type { RosMessage } from '../src/types';
import {
  foxgloveMessageDataFrame,
  installMockWebSocket,
  type MockWebSocket,
  type MockWebSocketHandle,
} from './_helpers/mock-websocket';

// The breaker trips only on sustained JS-thread lag, which has no injection
// seam; drive it directly, as RosbridgeClient.resubscribe.test.ts does.
// `lag.ms` stays 0 outside the breaker case.
const lag = vi.hoisted(() => ({ ms: 0 }));
vi.mock('../src/EventLoopMonitor', () => ({
  getMaxLagMs: () => lag.ms,
  getSustainedLagMs: () => lag.ms,
  setModeGetter: () => {},
}));

const TOPIC = '/chatter';
const OTHER = '/odom';
const START = Date.UTC(2026, 9, 21, 12, 0, 0);
/** The robot's clock runs this far ahead of the phone's; it must not matter. */
const ROBOT_AHEAD_MS = 5_000;
const PAYLOAD = new TextEncoder().encode(JSON.stringify({ data: 'hi' }));

describe('getLinkBacklogMs', () => {
  let ws: MockWebSocketHandle;
  let now: number;

  beforeEach(() => {
    lag.ms = 0;
    vi.useFakeTimers();
    now = START;
    vi.setSystemTime(now);
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
    vi.useRealTimers();
  });

  async function foxgloveConnect(client: FoxgloveClient): Promise<MockWebSocket> {
    const promise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.sdk.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: '', capabilities: [] }));
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertise',
        channels: [
          { id: 3, topic: TOPIC, encoding: 'json', schemaName: 'std_msgs/msg/String', schema: '' },
          { id: 4, topic: OTHER, encoding: 'json', schemaName: 'std_msgs/msg/String', schema: '' },
        ],
      }),
    );
    await promise;
    return socket;
  }

  /** The id of the newest subscription the client sent for `channelId`. */
  function subscriptionId(socket: MockWebSocket, channelId = 3): number {
    let id: number | undefined;
    for (const op of socket.sentJson.filter((m) => m.op === 'subscribe')) {
      for (const s of op.subscriptions as Array<{ id: number; channelId: number }>) {
        if (s.channelId === channelId) id = s.id;
      }
    }
    if (id === undefined) throw new Error(`client sent no subscribe op for channel ${channelId}`);
    return id;
  }

  /**
   * One frame that left the bridge `delayMs` before it arrives here.
   * `stampOffsetMs` shifts the stamp's time base, as a server that stamps one
   * channel with capture time and another with send time does.
   */
  function frameAfter(
    socket: MockWebSocket,
    delayMs: number,
    channelId = 3,
    stampOffsetMs = 0,
  ): void {
    now += 100;
    vi.setSystemTime(now);
    const stampNs = BigInt(now + ROBOT_AHEAD_MS - delayMs - stampOffsetMs) * 1_000_000n;
    socket.simulateMessage(
      foxgloveMessageDataFrame(subscriptionId(socket, channelId), stampNs, PAYLOAD),
    );
  }

  async function subscribed(): Promise<{ client: FoxgloveClient; socket: MockWebSocket }> {
    const client = new FoxgloveClient();
    const socket = await foxgloveConnect(client);
    client.subscribe(TOPIC, () => {});
    return { client, socket };
  }

  it('Foxglove: null before a connection and while nothing is subscribed', async () => {
    const client = new FoxgloveClient();
    expect(client.getLinkBacklogMs()).toBeNull();
    await foxgloveConnect(client);
    expect(client.getLinkBacklogMs()).toBeNull();
  });

  it('Foxglove: 0 on a steady link, whatever the clock offset', async () => {
    const { client, socket } = await subscribed();
    for (let i = 0; i < 10; i++) frameAfter(socket, 40);
    expect(client.getLinkBacklogMs()).toBe(0);
  });

  it('Foxglove: the rise above the floor when frames start arriving late', async () => {
    const { client, socket } = await subscribed();
    for (let i = 0; i < 10; i++) frameAfter(socket, 40);
    for (let i = 0; i < 10; i++) frameAfter(socket, 340);
    expect(client.getLinkBacklogMs()).toBe(300);
  });

  it('Foxglove: a latched replay stamped with its original time is not read as backlog', async () => {
    const { client, socket } = await subscribed();
    frameAfter(socket, 3_600_000);
    frameAfter(socket, 3_599_000);
    expect(client.getLinkBacklogMs()).toBe(0);
    for (let i = 0; i < 10; i++) frameAfter(socket, 40);
    expect(client.getLinkBacklogMs()).toBe(0);
  });

  it('Foxglove: counts the frames a rate cap holds back from the callback', async () => {
    const client = new FoxgloveClient();
    const socket = await foxgloveConnect(client);
    const received: RosMessage[] = [];
    client.subscribe(TOPIC, (m) => received.push(m), { maxFrequency: 1, disableAdaptive: true });
    for (let i = 0; i < 5; i++) frameAfter(socket, 40);
    for (let i = 0; i < 5; i++) frameAfter(socket, 240);
    expect(received).toHaveLength(1);
    expect(client.getLinkBacklogMs()).toBe(200);
  });

  it('Foxglove: null once the last subscription is gone', async () => {
    const client = new FoxgloveClient();
    const socket = await foxgloveConnect(client);
    const unsubscribe = client.subscribe(TOPIC, () => {});
    for (let i = 0; i < 5; i++) frameAfter(socket, 40);
    expect(client.getLinkBacklogMs()).toBe(0);
    unsubscribe();
    expect(client.getLinkBacklogMs()).toBeNull();
  });

  it("Foxglove: a new subscription does not inherit an old topic's reading", async () => {
    const client = new FoxgloveClient();
    const socket = await foxgloveConnect(client);
    const unsubscribe = client.subscribe(TOPIC, () => {});
    for (let i = 0; i < 5; i++) frameAfter(socket, 40);
    for (let i = 0; i < 5; i++) frameAfter(socket, 340);
    expect(client.getLinkBacklogMs()).toBe(300);
    unsubscribe();

    client.subscribe(OTHER, () => {});
    expect(client.getLinkBacklogMs()).toBeNull();
  });

  it('Foxglove: each topic keeps its own floor, so topics stamped on different time bases read 0', async () => {
    const client = new FoxgloveClient();
    const socket = await foxgloveConnect(client);
    client.subscribe(TOPIC, () => {});
    client.subscribe(OTHER, () => {});
    // The faster topic, stamped 80 ms earlier, fills the recent samples.
    for (let i = 0; i < 10; i++) {
      frameAfter(socket, 40, 3);
      for (let j = 0; j < 5; j++) frameAfter(socket, 40, 4, 80);
    }
    expect(client.getLinkBacklogMs()).toBe(0);
  });

  it('Foxglove: reports the topic that is furthest behind', async () => {
    const client = new FoxgloveClient();
    const socket = await foxgloveConnect(client);
    client.subscribe(TOPIC, () => {});
    client.subscribe(OTHER, () => {});
    for (let i = 0; i < 5; i++) {
      frameAfter(socket, 40, 3);
      frameAfter(socket, 40, 4);
    }
    for (let i = 0; i < 5; i++) {
      frameAfter(socket, 140, 3);
      frameAfter(socket, 290, 4);
    }
    expect(client.getLinkBacklogMs()).toBe(250);
  });

  it('Foxglove: a topic its breaker paused stops counting', async () => {
    const client = new FoxgloveClient();
    const socket = await foxgloveConnect(client);
    client.subscribe(TOPIC, () => {});
    client.subscribe(OTHER, () => {});
    for (let i = 0; i < 5; i++) {
      frameAfter(socket, 40, 3);
      frameAfter(socket, 40, 4);
    }

    // /chatter turns heavy and late while the JS thread lags, until its
    // breaker trips and unsubscribes it.
    const heavy = new Uint8Array(600_000);
    lag.ms = 300;
    await vi.advanceTimersByTimeAsync(600);
    for (let i = 0; i < 7; i++) {
      const stampNs = BigInt(Date.now() + ROBOT_AHEAD_MS - 840) * 1_000_000n;
      socket.simulateMessage(foxgloveMessageDataFrame(subscriptionId(socket, 3), stampNs, heavy));
      await vi.advanceTimersByTimeAsync(500);
    }
    lag.ms = 0;
    expect(client.getBreakerState(TOPIC)).toBe('tripped_auto');

    // Its last reading was 800 ms; /odom, still on time, is the link now.
    now = Date.now();
    frameAfter(socket, 40, 4);
    expect(client.getLinkBacklogMs()).toBe(0);
  });

  it('Foxglove: a re-subscribe after a breaker trip starts the topic over, so a deep latched replay is not backlog', async () => {
    const client = new FoxgloveClient();
    const socket = await foxgloveConnect(client);
    client.subscribe(TOPIC, () => {});
    for (let i = 0; i < 5; i++) frameAfter(socket, 40);

    const heavy = new Uint8Array(600_000);
    lag.ms = 300;
    await vi.advanceTimersByTimeAsync(600);
    for (let i = 0; i < 7; i++) {
      const stampNs = BigInt(Date.now() + ROBOT_AHEAD_MS - 840) * 1_000_000n;
      socket.simulateMessage(foxgloveMessageDataFrame(subscriptionId(socket), stampNs, heavy));
      await vi.advanceTimersByTimeAsync(500);
    }
    lag.ms = 0;
    expect(client.getBreakerState(TOPIC)).toBe('tripped_auto');
    await vi.advanceTimersByTimeAsync(31_000);
    expect(client.getBreakerState(TOPIC)).toBe('half_open');

    // The server replays three held messages, oldest first, stamped when they
    // were published an hour ago.
    now = Date.now();
    frameAfter(socket, 3_600_300);
    frameAfter(socket, 3_600_200);
    frameAfter(socket, 3_600_100);
    expect(client.getLinkBacklogMs()).toBe(0);
    for (let i = 0; i < 10; i++) frameAfter(socket, 40);
    expect(client.getLinkBacklogMs()).toBe(0);
  });

  it('Foxglove: a topic silent for more than ten seconds stops counting, and with none left it is null', async () => {
    const client = new FoxgloveClient();
    const socket = await foxgloveConnect(client);
    client.subscribe(TOPIC, () => {});
    client.subscribe(OTHER, () => {});
    for (let i = 0; i < 5; i++) {
      frameAfter(socket, 40, 3);
      frameAfter(socket, 40, 4);
    }
    for (let i = 0; i < 5; i++) frameAfter(socket, 840, 3);
    expect(client.getLinkBacklogMs()).toBe(800);

    // /chatter goes quiet; /odom keeps arriving on time for eleven seconds.
    for (let i = 0; i < 110; i++) frameAfter(socket, 40, 4);
    expect(client.getLinkBacklogMs()).toBe(0);

    now += 11_000;
    vi.setSystemTime(now);
    expect(client.getLinkBacklogMs()).toBeNull();
  });

  it('Foxglove: null once the only topic is unadvertised, even while a held frame waits to be delivered', async () => {
    const client = new FoxgloveClient();
    const socket = await foxgloveConnect(client);
    client.subscribe(TOPIC, () => {}, {
      dispatchMode: 'latest-only',
      maxFrequency: 1,
      disableAdaptive: true,
    });
    for (let i = 0; i < 5; i++) frameAfter(socket, 40);
    expect(client.getLinkBacklogMs()).toBe(0);
    socket.simulateMessage(JSON.stringify({ op: 'unadvertise', channelIds: [3] }));
    expect(client.getLinkBacklogMs()).toBeNull();
  });

  it('Foxglove: the floor starts over on a new connection', async () => {
    const { client, socket } = await subscribed();
    for (let i = 0; i < 5; i++) frameAfter(socket, 40);
    await client.disconnect();
    expect(client.getLinkBacklogMs()).toBeNull();

    const next = await foxgloveConnect(client);
    client.subscribe(TOPIC, () => {});
    for (let i = 0; i < 5; i++) frameAfter(next, 240);
    expect(client.getLinkBacklogMs()).toBe(0);
  });

  it('rosbridge: null before, during and after traffic', async () => {
    const client = new RosbridgeClient();
    expect(client.getLinkBacklogMs()).toBeNull();
    const promise = client.connect('ws://localhost:9090');
    const socket = ws.last();
    socket.simulateOpen();
    await promise;
    client.subscribe(TOPIC, () => {}, { schemaName: 'std_msgs/msg/String' });
    for (let i = 0; i < 5; i++) {
      socket.simulateMessage(JSON.stringify({ op: 'publish', topic: TOPIC, msg: { data: 'hi' } }));
    }
    expect(client.getLinkBacklogMs()).toBeNull();
  });

  it('Zenoh skeleton: null', () => {
    expect(new ZenohClient().getLinkBacklogMs()).toBeNull();
  });
});
