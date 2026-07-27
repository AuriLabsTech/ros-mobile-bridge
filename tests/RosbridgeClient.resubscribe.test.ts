// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * rosbridge subscribe self-heal (RMB-49): `subscribe()` resolves a topic's
 * message type once, from the discovered-topic set as it stands at the moment
 * of the call. A topic whose publisher has not started yet is absent from that
 * set, so the subscription is recorded with an empty `schemaName` and its
 * subscribe frame goes out with no `type`. A stock `rosbridge_server` cannot
 * infer the type of a topic nothing advertises, logs a rosout ERROR, and never
 * establishes the subscription. It then stays dead for the life of the
 * connection: a second `subscribe()` for the same topic only appends a callback
 * to the dead entry, so a consumer cannot repair it either.
 *
 * When a later discovery pass learns the topic's real type, the client
 * re-issues the subscribe frame carrying it and records the type on the
 * subscription, so delivery begins without a reconnect. The repair is one-shot
 * per subscription (it fills in the empty `schemaName`), never re-sends for an
 * already-typed subscription, and leaves a topic that is still unadvertised
 * alone.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RosbridgeClient } from '../src/RosbridgeClient';
import {
  installMockWebSocket,
  withFakeTimers,
  type MockWebSocketHandle,
} from './_helpers/mock-websocket';

// The JS-thread lag signal is a module-level probe with no injection seam, and
// the circuit breaker only trips on sustained lag above its threshold. Drive it
// directly so the breaker-paused case below is reachable from a unit test.
// `lag.ms` stays 0 for every other test here, which is what the real, unstarted
// monitor reports anyway.
const lag = vi.hoisted(() => ({ ms: 0 }));
vi.mock('../src/EventLoopMonitor', () => ({
  getMaxLagMs: () => lag.ms,
  getSustainedLagMs: () => lag.ms,
  setModeGetter: () => {},
}));

type Socket = ReturnType<MockWebSocketHandle['last']>;

/** Respond to the most recent `/rosapi/topics` call on `socket`. */
function respondTopics(socket: Socket, names: string[], types: string[]): void {
  const calls = socket.sentJson.filter(
    (m) => m.op === 'call_service' && m.service === '/rosapi/topics',
  );
  const last = calls[calls.length - 1] as { id: string } | undefined;
  if (!last) throw new Error('no /rosapi/topics call to respond to');
  socket.simulateMessage(
    JSON.stringify({
      op: 'service_response',
      id: last.id,
      result: true,
      values: { topics: names, types },
    }),
  );
}

/** Flush the microtask chain (callService resolve -> .then -> setTopicsIfChanged). */
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

/** Every `subscribe` frame sent on `socket` for `topic`, in order. */
function subscribeFrames(
  socket: Socket,
  topic: string,
): Record<string, unknown>[] {
  return socket.sentJson.filter(
    (m) => m.op === 'subscribe' && m.topic === topic,
  ) as Record<string, unknown>[];
}

const TF = '/tf';
const TF_TYPE = 'tf2_msgs/msg/TFMessage';

/**
 * A `publish` frame heavy enough to clear the breaker's bytes/sec floor
 * (500 KB/s) on its own, since `byteSize` is the frame's string length.
 */
const HEAVY_FILLER = 'x'.repeat(600_000);
function heavyPublish(topic: string): string {
  return JSON.stringify({ op: 'publish', topic, msg: { filler: HEAVY_FILLER } });
}

describe('RosbridgeClient — subscribe self-heal on topic discovery (RMB-49)', () => {
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

  it('re-subscribes with the real type when a late publisher advertises the topic', async () => {
    await withFakeTimers(async () => {
      const { client, socket } = await connectedClient();
      // On-connect discovery: /tf has no publisher yet, so it is absent.
      respondTopics(socket, ['/rosout'], ['rcl_interfaces/msg/Log']);
      await flush();

      client.subscribe(TF, () => {});
      const first = subscribeFrames(socket, TF);
      expect(first).toHaveLength(1);
      expect('type' in first[0]!).toBe(false);

      // The publisher starts. The 5 s latency probe re-discovers topics and
      // now sees /tf with its real type.
      await vi.advanceTimersByTimeAsync(5000);
      respondTopics(
        socket,
        ['/rosout', TF],
        ['rcl_interfaces/msg/Log', TF_TYPE],
      );
      await flush();

      const frames = subscribeFrames(socket, TF);
      expect(frames).toHaveLength(2);
      expect(frames[1]!.type).toBe(TF_TYPE);
    });
  });

  it('delivers messages to the callback after the self-heal, with the repaired schema name', async () => {
    await withFakeTimers(async () => {
      const { client, socket } = await connectedClient();
      respondTopics(socket, ['/rosout'], ['rcl_interfaces/msg/Log']);
      await flush();

      const received: { schemaName: string; data: unknown }[] = [];
      client.subscribe(TF, (msg) => {
        received.push({ schemaName: msg.schemaName, data: msg.data });
      });

      await vi.advanceTimersByTimeAsync(5000);
      respondTopics(
        socket,
        ['/rosout', TF],
        ['rcl_interfaces/msg/Log', TF_TYPE],
      );
      await flush();

      socket.simulateMessage(
        JSON.stringify({
          op: 'publish',
          topic: TF,
          msg: { transforms: [] },
        }),
      );

      expect(received).toHaveLength(1);
      // The repaired type reaches the consumer on every delivered message, and
      // is what the breaker's half-open path replays.
      expect(received[0]!.schemaName).toBe(TF_TYPE);
      expect(received[0]!.data).toEqual({ transforms: [] });
    });
  });

  it('repairs a subscription made before the first discovery resolves (startup race)', async () => {
    const { client, socket } = await connectedClient();

    // Subscribe before answering on-connect discovery: discoveredTopics is empty.
    client.subscribe(TF, () => {});
    expect('type' in subscribeFrames(socket, TF)[0]!).toBe(false);

    respondTopics(socket, [TF], [TF_TYPE]);
    await flush();

    const frames = subscribeFrames(socket, TF);
    expect(frames).toHaveLength(2);
    expect(frames[1]!.type).toBe(TF_TYPE);
  });

  it('does not re-subscribe a topic that is still unadvertised', async () => {
    await withFakeTimers(async () => {
      const { client, socket } = await connectedClient();
      respondTopics(socket, ['/rosout'], ['rcl_interfaces/msg/Log']);
      await flush();

      client.subscribe(TF, () => {});

      // A discovery pass that changes the set but still does not carry /tf.
      await vi.advanceTimersByTimeAsync(5000);
      respondTopics(
        socket,
        ['/rosout', '/odom'],
        ['rcl_interfaces/msg/Log', 'nav_msgs/msg/Odometry'],
      );
      await flush();

      expect(subscribeFrames(socket, TF)).toHaveLength(1);
    });
  });

  it('does not re-subscribe an already-typed, healthy subscription', async () => {
    await withFakeTimers(async () => {
      const { client, socket } = await connectedClient();
      respondTopics(socket, [TF], [TF_TYPE]);
      await flush();

      client.subscribe(TF, () => {});
      expect(subscribeFrames(socket, TF)[0]!.type).toBe(TF_TYPE);

      // An unrelated topic appears. The healthy subscription must not be re-sent.
      await vi.advanceTimersByTimeAsync(5000);
      respondTopics(socket, [TF, '/odom'], [TF_TYPE, 'nav_msgs/msg/Odometry']);
      await flush();

      expect(subscribeFrames(socket, TF)).toHaveLength(1);
    });
  });

  it('repairs at most once: a later discovery pass sends no further subscribe', async () => {
    await withFakeTimers(async () => {
      const { client, socket } = await connectedClient();
      respondTopics(socket, ['/rosout'], ['rcl_interfaces/msg/Log']);
      await flush();

      client.subscribe(TF, () => {});

      await vi.advanceTimersByTimeAsync(5000);
      respondTopics(
        socket,
        ['/rosout', TF],
        ['rcl_interfaces/msg/Log', TF_TYPE],
      );
      await flush();
      expect(subscribeFrames(socket, TF)).toHaveLength(2);

      // Another real set change, with /tf still present and already repaired.
      await vi.advanceTimersByTimeAsync(5000);
      respondTopics(
        socket,
        ['/rosout', TF, '/odom'],
        ['rcl_interfaces/msg/Log', TF_TYPE, 'nav_msgs/msg/Odometry'],
      );
      await flush();

      expect(subscribeFrames(socket, TF)).toHaveLength(2);
    });
  });

  it('leaves onTopicsChange semantics unchanged (fires only on a real set change)', async () => {
    await withFakeTimers(async () => {
      const { client, socket } = await connectedClient();
      respondTopics(socket, ['/rosout'], ['rcl_interfaces/msg/Log']);
      await flush();

      client.subscribe(TF, () => {});

      const changes: string[][] = [];
      client.onTopicsChange((t) => changes.push(t.map((x) => x.topic)));

      // A real change: /tf appears, and the repair rides along.
      await vi.advanceTimersByTimeAsync(5000);
      respondTopics(
        socket,
        ['/rosout', TF],
        ['rcl_interfaces/msg/Log', TF_TYPE],
      );
      await flush();

      // An identical set: no notification, and no extra subscribe frame.
      await vi.advanceTimersByTimeAsync(5000);
      respondTopics(
        socket,
        ['/rosout', TF],
        ['rcl_interfaces/msg/Log', TF_TYPE],
      );
      await flush();

      expect(changes).toEqual([['/rosout', TF]]);
      expect(subscribeFrames(socket, TF)).toHaveLength(2);
    });
  });

  it('does not resurrect a breaker-paused subscription, and its half-open replay carries the repaired type', async () => {
    await withFakeTimers(async () => {
      const { client, socket } = await connectedClient();
      respondTopics(socket, ['/rosout'], ['rcl_interfaces/msg/Log']);
      await flush();

      // A typeless subscription is not necessarily a dead one. /tf has a live
      // publisher here, so rosbridge resolves the type itself and delivery
      // works while `schemaName` is still empty on this side.
      client.subscribe(TF, () => {});
      expect(subscribeFrames(socket, TF)).toHaveLength(1);

      // Saturate it: heavy bytes and sustained lag, held past the trip dwell.
      lag.ms = 300;
      await vi.advanceTimersByTimeAsync(600); // clear the breaker's warm-up
      for (let i = 0; i < 7; i++) {
        socket.simulateMessage(heavyPublish(TF));
        await vi.advanceTimersByTimeAsync(500);
      }

      expect(client.getBreakerState(TF)).toBe('tripped_auto');
      expect(
        socket.sentJson.filter((m) => m.op === 'unsubscribe' && m.topic === TF),
      ).toHaveLength(1);

      // Discovery now learns the type. The subscription must stay off the wire:
      // re-subscribing here would undo the load shedding the breaker just did.
      lag.ms = 0;
      await vi.advanceTimersByTimeAsync(5000);
      respondTopics(
        socket,
        ['/rosout', TF],
        ['rcl_interfaces/msg/Log', TF_TYPE],
      );
      await flush();
      expect(subscribeFrames(socket, TF)).toHaveLength(1);

      // The type was still adopted, so when the breaker reopens on its own
      // schedule its replay carries it instead of a typeless frame.
      client.breakerRetry(TF);
      const frames = subscribeFrames(socket, TF);
      expect(frames).toHaveLength(2);
      expect(frames[1]!.type).toBe(TF_TYPE);
    });
  });

  /**
   * Eligibility generalized for the consumer-supplied type hint
   * (`SubscribeOptions.schemaName`): the repair fires not only when the
   * recorded type is empty, but when it *differs* from what discovery
   * reports. Wire facts the differs shape rests on (probed against a stock
   * rosbridge_server): a subscribe whose type conflicts with the topic's
   * established type is rejected silently (rosout ERROR, no `status` op,
   * nothing changed server-side), so the corrective subscribe must be
   * preceded by an `unsubscribe` — a bare re-subscribe is itself rejected by
   * the same conflict rule when a wrong-typed registration exists. The
   * `unsubscribe` is accepted and harmless when the wrong-typed subscribe
   * registered nothing. The empty-type shape keeps the bare re-subscribe:
   * a typeless subscription can be flowing, and an unsubscribe would cut
   * delivery for nothing.
   */
  describe('type hint convergence (recorded type differs from discovered)', () => {
    const GATED = '/mode_gated';
    const HINT = 'std_msgs/msg/Bool';
    const REAL = 'std_msgs/msg/Float64';

    it('re-subscribes with the discovered type, unsubscribe first', async () => {
      await withFakeTimers(async () => {
        const { client, socket } = await connectedClient();
        respondTopics(socket, ['/rosout'], ['rcl_interfaces/msg/Log']);
        await flush();

        client.subscribe(GATED, () => {}, { schemaName: HINT });
        expect(subscribeFrames(socket, GATED)[0]!.type).toBe(HINT);

        // Discovery learns the real type, which disagrees with the hint.
        await vi.advanceTimersByTimeAsync(5000);
        respondTopics(
          socket,
          ['/rosout', GATED],
          ['rcl_interfaces/msg/Log', REAL],
        );
        await flush();

        const frames = socket.sentJson.filter(
          (m) => (m.op === 'subscribe' || m.op === 'unsubscribe') && m.topic === GATED,
        );
        // subscribe(hint) → unsubscribe → subscribe(discovered): the server
        // may hold a wrong-typed registration that rejects any conflicting
        // subscribe, and only an unsubscribe clears it.
        expect(frames.map((m) => [m.op, m.type ?? null])).toEqual([
          ['subscribe', HINT],
          ['unsubscribe', null],
          ['subscribe', REAL],
        ]);

        // The adopted type reaches the consumer on delivered messages.
        const received: string[] = [];
        client.subscribe(GATED, (m) => received.push(m.schemaName));
        socket.simulateMessage(
          JSON.stringify({ op: 'publish', topic: GATED, msg: { data: 2 } }),
        );
        expect(received).toEqual([REAL]);
      });
    });

    it('converges at most once for a given discovered type', async () => {
      await withFakeTimers(async () => {
        const { client, socket } = await connectedClient();
        respondTopics(socket, ['/rosout'], ['rcl_interfaces/msg/Log']);
        await flush();

        client.subscribe(GATED, () => {}, { schemaName: HINT });

        await vi.advanceTimersByTimeAsync(5000);
        respondTopics(
          socket,
          ['/rosout', GATED],
          ['rcl_interfaces/msg/Log', REAL],
        );
        await flush();
        expect(subscribeFrames(socket, GATED)).toHaveLength(2);

        // Another real set change with the topic's entry unchanged: the
        // repaired subscription is no longer eligible.
        await vi.advanceTimersByTimeAsync(5000);
        respondTopics(
          socket,
          ['/rosout', GATED, '/odom'],
          ['rcl_interfaces/msg/Log', REAL, 'nav_msgs/msg/Odometry'],
        );
        await flush();

        expect(subscribeFrames(socket, GATED)).toHaveLength(2);
        expect(
          socket.sentJson.filter((m) => m.op === 'unsubscribe' && m.topic === GATED),
        ).toHaveLength(1);
      });
    });

    it('treats a 2-part hint as matching its 3-part discovered form (no repair cycle)', async () => {
      await withFakeTimers(async () => {
        const { client, socket } = await connectedClient();
        respondTopics(socket, ['/rosout'], ['rcl_interfaces/msg/Log']);
        await flush();

        // The 2-part ROS 1 spelling is an accepted alias on the wire: the
        // subscription is healthy, so a repair would cut delivery for nothing.
        client.subscribe(TF, () => {}, { schemaName: 'tf2_msgs/TFMessage' });

        await vi.advanceTimersByTimeAsync(5000);
        respondTopics(
          socket,
          ['/rosout', TF],
          ['rcl_interfaces/msg/Log', TF_TYPE],
        );
        await flush();

        expect(subscribeFrames(socket, TF)).toHaveLength(1);
        expect(
          socket.sentJson.filter((m) => m.op === 'unsubscribe' && m.topic === TF),
        ).toHaveLength(0);

        // The canonical discovered spelling is adopted for bookkeeping: it is
        // what delivered messages and the breaker's half-open replay carry.
        const received: string[] = [];
        client.subscribe(TF, (m) => received.push(m.schemaName));
        socket.simulateMessage(
          JSON.stringify({ op: 'publish', topic: TF, msg: { transforms: [] } }),
        );
        expect(received).toEqual([TF_TYPE]);
      });
    });

    it('adopts the discovered type for a paused subscription without touching the wire', async () => {
      await withFakeTimers(async () => {
        const { client, socket } = await connectedClient();
        respondTopics(socket, ['/rosout'], ['rcl_interfaces/msg/Log']);
        await flush();

        client.subscribe(GATED, () => {}, { schemaName: HINT });
        expect(subscribeFrames(socket, GATED)).toHaveLength(1);

        // Trip the breaker with heavy traffic and sustained lag.
        lag.ms = 300;
        await vi.advanceTimersByTimeAsync(600);
        for (let i = 0; i < 7; i++) {
          socket.simulateMessage(heavyPublish(GATED));
          await vi.advanceTimersByTimeAsync(500);
        }
        expect(client.getBreakerState(GATED)).toBe('tripped_auto');
        const unsubsAfterTrip = socket.sentJson.filter(
          (m) => m.op === 'unsubscribe' && m.topic === GATED,
        ).length;

        // Discovery disagrees with the hint while the subscription is paused:
        // adopt the type, send nothing (the breaker already unsubscribed).
        lag.ms = 0;
        await vi.advanceTimersByTimeAsync(5000);
        respondTopics(
          socket,
          ['/rosout', GATED],
          ['rcl_interfaces/msg/Log', REAL],
        );
        await flush();
        expect(subscribeFrames(socket, GATED)).toHaveLength(1);
        expect(
          socket.sentJson.filter((m) => m.op === 'unsubscribe' && m.topic === GATED),
        ).toHaveLength(unsubsAfterTrip);

        // The half-open replay carries the adopted type.
        client.breakerRetry(GATED);
        const frames = subscribeFrames(socket, GATED);
        expect(frames).toHaveLength(2);
        expect(frames[1]!.type).toBe(REAL);
      });
    });
  });
});
