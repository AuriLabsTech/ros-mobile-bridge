// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * rosbridge wire subscribe policy, derived from the subscription's own options
 * (ADR 0008).
 *
 * The policy a `subscribe` frame carries executes on the rosbridge server,
 * before anything reaches this client, so no client-side option can see it or
 * undo it. Every published version through 0.1.10 hardcoded
 * `throttle_rate: 100, queue_length: 1`, which bounded every rosbridge
 * subscription near 10 Hz whatever `maxFrequency` said, and made
 * `{ maxFrequency: 0, disableAdaptive: true }` -- the documented spelling of
 * "deliver every message, gate nothing" -- untrue on the wire.
 *
 * These tests pin the three properties the decision rests on: the derivation
 * per row, the loosest-wins merge across consumers of one topic in both
 * directions, and re-subscribe in place with no preceding `unsubscribe`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RosbridgeClient } from '../src/RosbridgeClient';
import {
  installMockWebSocket,
  withFakeTimers,
  type MockWebSocketHandle,
} from './_helpers/mock-websocket';

// Same seam as the self-heal suite: the lag probe is module-level with no
// injection point, and the breaker-paused case below needs sustained lag.
const lag = vi.hoisted(() => ({ ms: 0 }));
vi.mock('../src/EventLoopMonitor', () => ({
  getMaxLagMs: () => lag.ms,
  getSustainedLagMs: () => lag.ms,
  setModeGetter: () => {},
}));

type Socket = ReturnType<MockWebSocketHandle['last']>;

const TOPIC = '/camera/image_raw';

/** Every frame sent on `socket` for `topic`, subscribe and unsubscribe alike. */
function framesFor(socket: Socket, topic: string): Record<string, unknown>[] {
  return socket.sentJson.filter(
    (m) => (m.op === 'subscribe' || m.op === 'unsubscribe') && m.topic === topic,
  ) as Record<string, unknown>[];
}

/** Just the subscribe frames, which is what carries the policy. */
function subscribeFrames(socket: Socket, topic: string): Record<string, unknown>[] {
  return framesFor(socket, topic).filter((m) => m.op === 'subscribe');
}

/** The policy on the most recent subscribe frame for `topic`. */
function lastPolicy(
  socket: Socket,
  topic: string,
): { throttle_rate: unknown; queue_length: unknown } {
  const frames = subscribeFrames(socket, topic);
  const last = frames[frames.length - 1];
  if (!last) throw new Error(`no subscribe frame for ${topic}`);
  return { throttle_rate: last.throttle_rate, queue_length: last.queue_length };
}

/**
 * A `publish` frame heavy enough to clear the breaker's bytes/sec floor on its
 * own, so the paused case is reachable without a real rig.
 */
const HEAVY_FILLER = 'x'.repeat(600_000);
function heavyPublish(topic: string): string {
  return JSON.stringify({ op: 'publish', topic, msg: { filler: HEAVY_FILLER } });
}

describe('RosbridgeClient — wire subscribe policy (ADR 0008)', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    lag.ms = 0;
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  async function connectedClient(): Promise<{
    client: RosbridgeClient;
    socket: Socket;
  }> {
    const client = new RosbridgeClient();
    const promise = client.connect('ws://localhost:9090');
    const socket = ws.last();
    socket.simulateOpen();
    await promise;
    return { client, socket };
  }

  describe('derivation from the subscription options', () => {
    it('a 15 Hz cap asks the server for 15 Hz, not the old 10', async () => {
      const { client, socket } = await connectedClient();
      client.subscribe(TOPIC, () => {}, { maxFrequency: 15 });

      // floor(1000 / 15) = 66 ms. The pre-0.1.11 hardcode was 100 ms, so a
      // 15 Hz camera cap could never deliver more than ~10 Hz over rosbridge.
      expect(lastPolicy(socket, TOPIC)).toEqual({ throttle_rate: 66, queue_length: 1 });
    });

    it('an omitted cap carries the server baseline: gate nothing, buffer nothing', async () => {
      const { client, socket } = await connectedClient();
      client.subscribe(TOPIC, () => {});

      expect(lastPolicy(socket, TOPIC)).toEqual({ throttle_rate: 0, queue_length: 0 });
    });

    it('maxFrequency 0 is the same wire policy as omitting it', async () => {
      const { client, socket } = await connectedClient();
      client.subscribe(TOPIC, () => {}, { maxFrequency: 0, disableAdaptive: true });

      expect(lastPolicy(socket, TOPIC)).toEqual({ throttle_rate: 0, queue_length: 0 });
    });

    it('disableAdaptive alone changes nothing on the wire', async () => {
      const { client, socket } = await connectedClient();
      // The adaptive throttle is client-side and stays there: it protects the
      // JS thread, never the radio, so it has no wire expression.
      client.subscribe(TOPIC, () => {}, { maxFrequency: 5, disableAdaptive: true });

      expect(lastPolicy(socket, TOPIC)).toEqual({ throttle_rate: 200, queue_length: 1 });
    });

    it('a cap faster than 1 kHz floors to an unthrottled frame rather than a negative one', async () => {
      const { client, socket } = await connectedClient();
      client.subscribe(TOPIC, () => {}, { maxFrequency: 2000 });

      expect(lastPolicy(socket, TOPIC)).toEqual({ throttle_rate: 0, queue_length: 1 });
    });
  });

  describe('loosest wins across consumers of one topic', () => {
    it('a second, looser consumer loosens the shared policy in place', async () => {
      const { client, socket } = await connectedClient();
      client.subscribe(TOPIC, () => {}, { maxFrequency: 5 });
      expect(lastPolicy(socket, TOPIC)).toEqual({ throttle_rate: 200, queue_length: 1 });

      client.subscribe(TOPIC, () => {}, { maxFrequency: 20 });
      expect(lastPolicy(socket, TOPIC)).toEqual({ throttle_rate: 50, queue_length: 1 });

      // Re-sent in place: rosbridge updates a subscription keyed by client and
      // topic, and an `unsubscribe` first would open the server's teardown
      // flush race for no gain.
      expect(framesFor(socket, TOPIC).map((m) => m.op)).toEqual(['subscribe', 'subscribe']);
    });

    it('an uncapped consumer opens the topic for everyone sharing it', async () => {
      const { client, socket } = await connectedClient();
      client.subscribe(TOPIC, () => {}, { maxFrequency: 5 });
      client.subscribe(TOPIC, () => {});

      // Componentwise minimum: the uncapped consumer's {0, 0} wins both fields.
      // Its own 5 Hz cap is still enforced client-side for the capped callback.
      expect(lastPolicy(socket, TOPIC)).toEqual({ throttle_rate: 0, queue_length: 0 });
    });

    it('the loosest consumer leaving tightens the policy back down', async () => {
      const { client, socket } = await connectedClient();
      client.subscribe(TOPIC, () => {}, { maxFrequency: 5 });
      const unsubscribeFast = client.subscribe(TOPIC, () => {}, { maxFrequency: 20 });
      expect(lastPolicy(socket, TOPIC)).toEqual({ throttle_rate: 50, queue_length: 1 });

      unsubscribeFast();

      expect(lastPolicy(socket, TOPIC)).toEqual({ throttle_rate: 200, queue_length: 1 });
      expect(framesFor(socket, TOPIC).map((m) => m.op)).toEqual([
        'subscribe',
        'subscribe',
        'subscribe',
      ]);
    });

    it('a consumer joining at an equal or stricter policy sends no frame', async () => {
      const { client, socket } = await connectedClient();
      client.subscribe(TOPIC, () => {}, { maxFrequency: 20 });
      client.subscribe(TOPIC, () => {}, { maxFrequency: 20 });
      client.subscribe(TOPIC, () => {}, { maxFrequency: 5 });

      expect(subscribeFrames(socket, TOPIC)).toHaveLength(1);
      expect(lastPolicy(socket, TOPIC)).toEqual({ throttle_rate: 50, queue_length: 1 });
    });

    it('the last consumer leaving unsubscribes rather than re-deriving', async () => {
      const { client, socket } = await connectedClient();
      const unsubscribe = client.subscribe(TOPIC, () => {}, { maxFrequency: 5 });

      unsubscribe();

      expect(framesFor(socket, TOPIC).map((m) => m.op)).toEqual(['subscribe', 'unsubscribe']);
    });
  });

  describe('interaction with the rest of the subscribe machinery', () => {
    it('a paused subscription stays off the wire, and the breaker replays the current policy', async () => {
      await withFakeTimers(async () => {
        const { client, socket } = await connectedClient();
        client.subscribe(TOPIC, () => {}, { maxFrequency: 5 });

        lag.ms = 300;
        await vi.advanceTimersByTimeAsync(600);
        for (let i = 0; i < 7; i++) {
          socket.simulateMessage(heavyPublish(TOPIC));
          await vi.advanceTimersByTimeAsync(500);
        }
        expect(client.getBreakerState(TOPIC)).toBe('tripped_auto');
        const framesWhilePaused = subscribeFrames(socket, TOPIC).length;

        // A consumer joining while the breaker is shedding load must not undo
        // the unsubscribe it just issued.
        lag.ms = 0;
        client.subscribe(TOPIC, () => {}, { maxFrequency: 20 });
        expect(subscribeFrames(socket, TOPIC)).toHaveLength(framesWhilePaused);

        // The looser policy was still recorded, so the half-open replay carries
        // it rather than the policy the topic was tripped under.
        client.breakerRetry(TOPIC);
        expect(lastPolicy(socket, TOPIC)).toEqual({ throttle_rate: 50, queue_length: 1 });
      });
    });

    it('the discovery self-heal re-subscribe carries the derived policy', async () => {
      const { client, socket } = await connectedClient();
      client.subscribe(TOPIC, () => {}, { maxFrequency: 15, schemaName: 'wrong_pkg/msg/Wrong' });

      const calls = socket.sentJson.filter(
        (m) => m.op === 'call_service' && m.service === '/rosapi/topics',
      );
      const last = calls[calls.length - 1] as { id: string };
      socket.simulateMessage(
        JSON.stringify({
          op: 'service_response',
          id: last.id,
          service: '/rosapi/topics',
          result: true,
          values: { topics: [TOPIC], types: ['sensor_msgs/msg/Image'] },
        }),
      );
      await Promise.resolve();
      await Promise.resolve();

      const frames = subscribeFrames(socket, TOPIC);
      expect(frames.length).toBeGreaterThan(1);
      expect(frames[frames.length - 1]).toMatchObject({
        type: 'sensor_msgs/msg/Image',
        throttle_rate: 66,
        queue_length: 1,
      });
    });
  });
});
