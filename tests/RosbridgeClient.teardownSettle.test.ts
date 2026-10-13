// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * Teardown settle before the socket close.
 *
 * `disconnect()` drains the control-priority outbox before closing, and that
 * drain is what carries a release-the-joystick zero Twist to the robot on the
 * way out. Up to 0.1.10 the drain and the close landed in the same tick.
 * `rosbridge_server` discards ops it has received but not yet processed when
 * the connection goes away, so any slow op the consumer wrote just in front of
 * the drain -- an `unsubscribe` is the measured case -- was enough to leave the
 * safety publish unprocessed. The failure has the worst shape a teleop app
 * has: the last instruction the robot received is "keep moving".
 *
 * Measured on a rig and then isolated with no client library in the path:
 * drain-then-close loses the zero 3/3, and 20 ms of settle keeps it 3/3.
 *
 * These tests pin that the close waits, that the drain is on the wire before
 * it does, that every intentional close of an open socket waits (ADR 0023),
 * and that a socket already gone is not waited on.
 *
 * ADR 0026 replaced the fixed 20 ms with a fence: rosbridge works through a
 * connection's ops one at a time, in order, and drops the unworked rest on
 * close, so the close now waits for the server's answer to one request sent
 * behind everything else (`/rosapi/get_time`), capped. 20 ms was outrun by a
 * subscription teardown in front of an E-Stop's cancels on a slow server
 * (measured 2026-10-13 against rosbridge 2.7.1).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import { RosbridgeClient } from '../src/RosbridgeClient';
import {
  installMockWebSocket,
  withFakeTimers,
  type MockWebSocketHandle,
  type MockWebSocket,
} from './_helpers/mock-websocket';

const TWIST = 'geometry_msgs/msg/Twist';

/** The fence's cap. Kept in step with TEARDOWN_FENCE_TIMEOUT_MS in the client. */
const FENCE_TIMEOUT_MS = 2_000;

function fenceFrames(socket: MockWebSocket): Array<Record<string, unknown>> {
  return socket.sentJson.filter(
    (m) => m.op === 'call_service' && String(m.id).startsWith('teardown_fence:'),
  );
}

/** Index of the last teardown fence among the frames sent, or -1. */
function lastFenceIndex(socket: MockWebSocket): number {
  const frames = socket.sentJson;
  for (let i = frames.length - 1; i >= 0; i--) {
    if (String(frames[i]?.id).startsWith('teardown_fence:')) return i;
  }
  return -1;
}

/** Answer the teardown fence the way rosbridge does, success or failure. */
function answerFence(socket: MockWebSocket, result = true): void {
  const fence = fenceFrames(socket).at(-1);
  if (!fence) throw new Error('no teardown fence on the wire');
  socket.simulateMessage(
    JSON.stringify({
      op: 'service_response',
      id: fence.id,
      service: '/rosapi/get_time',
      result,
      values: result ? { time: { sec: 1, nanosec: 0 } } : 'Service /rosapi/get_time does not exist',
    }),
  );
}

describe('RosbridgeClient — fence between the teardown drain and the close', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  async function connectedClient(): Promise<{
    client: RosbridgeClient;
    socket: MockWebSocket;
  }> {
    const client = new RosbridgeClient();
    const promise = client.connect('ws://localhost:9090');
    const socket = ws.last();
    socket.simulateOpen();
    await promise;
    return { client, socket };
  }

  function publishedTopics(socket: MockWebSocket): string[] {
    return socket.sentJson.filter((m) => m.op === 'publish').map((m) => m.topic as string);
  }

  it('holds the socket open until the server answers the fence', async () => {
    await withFakeTimers(async () => {
      const { client, socket } = await connectedClient();
      client.publish('/cmd_vel', TWIST, { linear: { x: 0.5 } }, { priority: 'control' });

      const teardown = client.disconnect();

      // The drain is already on the wire, and the socket is still open: this
      // is the window the server needs and never had.
      expect(publishedTopics(socket)).toContain('/cmd_vel');
      expect(socket.readyState).toBe(1);

      // Time alone does not close it any more: a slow server is still working
      // through what came before. Only its answer to the fence does.
      await vi.advanceTimersByTimeAsync(FENCE_TIMEOUT_MS - 1);
      expect(socket.readyState).toBe(1);

      answerFence(socket);
      await teardown;

      expect(socket.readyState).toBe(3);
    });
  });

  it('the fence goes out behind everything the consumer and the drain wrote', async () => {
    // rosbridge answers ops in the order they arrived, so the fence's answer
    // proves the server got through everything in front of it. That holds only
    // if nothing that matters is written after it.
    await withFakeTimers(async () => {
      const { client, socket } = await connectedClient();
      client
        .callService('/navigate_to_pose/_action/cancel_goal', {}, { timeoutMs: 2000 })
        .catch(() => {});
      client.publish('/cmd_vel', TWIST, { linear: { x: 0 } }, { priority: 'control' });

      const teardown = client.disconnect();

      const frames = socket.sentJson;
      const fenceAt = frames.findIndex((m) => String(m.id).startsWith('teardown_fence:'));
      const cancelAt = frames.findIndex(
        (m) => m.service === '/navigate_to_pose/_action/cancel_goal',
      );
      const zeroAt = frames.findIndex((m) => m.op === 'publish' && m.topic === '/cmd_vel');
      expect(fenceAt).toBeGreaterThan(cancelAt);
      expect(fenceAt).toBeGreaterThan(zeroAt);
      expect(fenceFrames(socket)).toHaveLength(1);
      expect(fenceFrames(socket)[0]).toMatchObject({ service: '/rosapi/get_time', args: {} });

      answerFence(socket);
      await teardown;
    });
  });

  it('the fence does not cost the drain: every control topic is written before the close', async () => {
    await withFakeTimers(async () => {
      const { client, socket } = await connectedClient();
      for (const topic of ['/cmd_vel', '/robot2/cmd_vel', '/robot3/cmd_vel']) {
        client.publish(topic, TWIST, { linear: { x: 0.5 } }, { priority: 'control' });
      }

      const teardown = client.disconnect();
      const writtenBeforeClose = new Set(publishedTopics(socket));

      answerFence(socket);
      await teardown;

      expect(writtenBeforeClose).toEqual(
        new Set(['/cmd_vel', '/robot2/cmd_vel', '/robot3/cmd_vel']),
      );
    });
  });

  it('fences even when the drain sent nothing: a cancel written just before is at risk too', async () => {
    // Up to 0.1.16-rc.1 the wait ran only when the drain wrote something.
    // An emergency stop that cancels every goal and then disconnects, on a
    // connection where nothing was driven at control priority, closed in the
    // same tick as its cancels. Measured on rosbridge 2.7.1: the cancel never
    // reached the action server in 13 of 20 runs (ADR 0023).
    await withFakeTimers(async () => {
      const { client, socket } = await connectedClient();
      client
        .callService('/navigate_to_pose/_action/cancel_goal', {}, { timeoutMs: 2000 })
        .catch(() => {});

      const teardown = client.disconnect();

      expect(fenceFrames(socket)).toHaveLength(1);
      expect(socket.readyState).toBe(1);

      answerFence(socket);
      await teardown;

      expect(socket.readyState).toBe(3);
    });
  });

  it('a failure answer releases the close too: it was still worked through in order', async () => {
    // A server without rosapi answers "does not exist". That frame comes from
    // the same in-order handling as a success, so it proves the same thing.
    await withFakeTimers(async () => {
      const { client, socket } = await connectedClient();

      const teardown = client.disconnect();
      answerFence(socket, false);
      await teardown;

      expect(socket.readyState).toBe(3);
    });
  });

  it('closes at the cap when the fence is never answered', async () => {
    // A services_glob that blocks /rosapi/get_time makes the server answer
    // nothing at all; a link that died without the socket noticing, the same.
    // The close falls back to the pre-fence behaviour rather than hanging.
    await withFakeTimers(async () => {
      const { client, socket } = await connectedClient();

      const teardown = client.disconnect();
      await vi.advanceTimersByTimeAsync(FENCE_TIMEOUT_MS - 1);
      expect(socket.readyState).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      await teardown;

      expect(socket.readyState).toBe(3);
      expect(client.isConnected).toBe(false);
    });
  });

  it("the fence's answer is not a latency sample: it waits on the server's queue", async () => {
    // ADR 0016: a round trip whose answer waits on work other than the
    // connection is not a latency sample. The fence's answer waits on
    // everything the server had queued in front of it.
    await withFakeTimers(async () => {
      const samples: number[] = [];
      const client = new RosbridgeClient({ onLatency: (ms) => samples.push(ms) });
      const promise = client.connect('ws://localhost:9090');
      const socket = ws.last();
      socket.simulateOpen();
      await promise;

      const teardown = client.disconnect();
      await vi.advanceTimersByTimeAsync(300);
      answerFence(socket);
      await teardown;

      expect(samples).toEqual([]);
    });
  });

  it('a write made while the fence is out is fenced again before the close', async () => {
    // The status stays 'connected' through the wait, so a screen's unmount can
    // still publish its zero or cancel a goal after disconnect() started. That
    // write sits behind the first fence, so its answer proves nothing about it.
    await withFakeTimers(async () => {
      const { client, socket } = await connectedClient();

      const teardown = client.disconnect();
      client
        .callService('/navigate_to_pose/_action/cancel_goal', {}, { timeoutMs: 2000 })
        .catch(() => {});
      answerFence(socket);
      await vi.advanceTimersByTimeAsync(0);

      // Still open, with a second fence behind the late cancel.
      expect(socket.readyState).toBe(1);
      const frames = socket.sentJson;
      const lateCancelAt = frames.findIndex(
        (m) => m.service === '/navigate_to_pose/_action/cancel_goal',
      );
      expect(fenceFrames(socket)).toHaveLength(2);
      expect(lastFenceIndex(socket)).toBeGreaterThan(lateCancelAt);

      answerFence(socket);
      await teardown;
      expect(socket.readyState).toBe(3);
    });
  });

  it('a second disconnect() during the fence covers what was written in between', async () => {
    await withFakeTimers(async () => {
      const { client, socket } = await connectedClient();

      const first = client.disconnect();
      client
        .callService('/navigate_to_pose/_action/cancel_goal', {}, { timeoutMs: 2000 })
        .catch(() => {});
      const second = client.disconnect();

      // The first fence's answer proves nothing about the cancel behind it.
      const [firstFence] = fenceFrames(socket);
      socket.simulateMessage(
        JSON.stringify({ op: 'service_response', id: firstFence?.id, result: true, values: {} }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(socket.readyState).toBe(1);

      // A fence behind the cancel is out; its answer releases both calls.
      const frames = socket.sentJson;
      const cancelAt = frames.findIndex(
        (m) => m.service === '/navigate_to_pose/_action/cancel_goal',
      );
      expect(lastFenceIndex(socket)).toBeGreaterThan(cancelAt);
      answerFence(socket);
      await Promise.all([first, second]);
      expect(socket.readyState).toBe(3);
    });
  });

  it('the fence wait never exceeds the cap, however many writes arrive during it', async () => {
    await withFakeTimers(async () => {
      const { client, socket } = await connectedClient();

      const teardown = client.disconnect();
      let closedAt: number | null = null;
      for (let t = 0; t < FENCE_TIMEOUT_MS + 500 && closedAt === null; t += 100) {
        client.publish('/cmd_vel', TWIST, { linear: { x: 0 } }, { priority: 'control' });
        answerFence(socket);
        await vi.advanceTimersByTimeAsync(100);
        if (socket.readyState === 3) closedAt = t + 100;
      }
      await teardown;
      expect(closedAt).not.toBeNull();
      expect(closedAt).toBeLessThanOrEqual(FENCE_TIMEOUT_MS + 100);
    });
  });

  it("the library's own polls stop while the fence is out, so they cannot add rounds", async () => {
    // The polls are torn down at the close anyway. Left running, a tick inside
    // the wait writes a call behind the fence and costs another round trip on
    // exactly the slow server the fence exists for.
    await withFakeTimers(async () => {
      const client = new RosbridgeClient({ discoveryRefreshMs: 1000, latencyProbeMs: 1000 });
      const promise = client.connect('ws://localhost:9090');
      const socket = ws.last();
      socket.simulateOpen();
      await promise;
      await vi.advanceTimersByTimeAsync(900);

      const teardown = client.disconnect();
      const before = socket.sentJson.length;
      await vi.advanceTimersByTimeAsync(500); // past the next poll tick
      expect(socket.sentJson.length).toBe(before);

      answerFence(socket);
      await teardown;
      expect(fenceFrames(socket)).toHaveLength(1);
      expect(socket.readyState).toBe(3);
    });
  });

  it('a send that throws during the fence still closes and lands on disconnected', async () => {
    await withFakeTimers(async () => {
      const { client, socket } = await connectedClient();
      socket.send = () => {
        throw new Error('send failed');
      };

      await client.disconnect().catch(() => {});

      expect(socket.readyState).toBe(3);
      expect(client.isConnected).toBe(false);
    });
  });

  it('an abort on a connect() parked behind the fence rejects at once, not at the close', async () => {
    await withFakeTimers(async () => {
      const { client, socket } = await connectedClient();

      const teardown = client.disconnect();
      const controller = new AbortController();
      let outcome: string | null = null;
      client.connect('ws://other:9090', { signal: controller.signal }).then(
        () => (outcome = 'connected'),
        (err: Error) => (outcome = err.name),
      );
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe('AbortError');
      expect(socket.readyState).toBe(1); // the fence is still out

      answerFence(socket);
      await teardown;
      // No socket was opened for the cancelled attempt.
      expect(ws.last()).toBe(socket);
    });
  });

  it('a socket that closes under the fence ends the wait at once', async () => {
    await withFakeTimers(async () => {
      const { client, socket } = await connectedClient();

      const teardown = client.disconnect();
      socket.simulateClose(1006, 'connection lost');

      // No timer advance: this resolves on microtasks or the test times out.
      await teardown;
      expect(client.isConnected).toBe(false);
    });
  });

  it('a connect() made during the fence connects once the close is done', async () => {
    // The status stays 'connected' through the fence, so without a guard
    // this connect() reads as already done, and the fence's cleanup then
    // leaves the client disconnected with no new socket.
    await withFakeTimers(async () => {
      const { client, socket } = await connectedClient();

      const teardown = client.disconnect();
      const reconnect = client.connect('ws://other:9090');

      answerFence(socket);
      await teardown;
      expect(socket.readyState).toBe(3);

      const next = ws.last();
      expect(next).not.toBe(socket);
      next.simulateOpen();
      await reconnect;
      expect(client.isConnected).toBe(true);
    });
  });

  it('a disconnect() with no open socket does not wait', async () => {
    await withFakeTimers(async () => {
      const { client, socket } = await connectedClient();
      socket.simulateClose(1006, 'connection lost');

      // No timer advance on purpose: this resolves on microtasks or the test
      // times out.
      await client.disconnect();

      expect(client.isConnected).toBe(false);
    });
  });

  it('an involuntary close is not delayed: only the intentional teardown settles', async () => {
    await withFakeTimers(async () => {
      const { client, socket } = await connectedClient();
      client.publish('/cmd_vel', TWIST, { linear: { x: 0.5 } }, { priority: 'control' });

      const statuses: string[] = [];
      client.onStatusChange((s) => statuses.push(s));

      // The socket dies under us. There is no drain to protect, and delaying
      // here would only slow the reconnect down, so the status moves without
      // any timer having to run.
      socket.simulateClose(1006, 'connection lost');

      // The listener replays the current status on registration, so the last
      // entry is what the close produced, with no timer advance in between.
      expect(statuses[0]).toBe('connected');
      expect(statuses[statuses.length - 1]).not.toBe('connected');
    });
  });
});

describe('FoxgloveClient — teardown is deliberately not delayed', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  it('closes in the same tick as the drain, as it always has', async () => {
    const client = new FoxgloveClient();
    const promise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(
      JSON.stringify({ op: 'serverInfo', name: 'test-server', capabilities: ['publish'] }),
    );
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertise',
        channels: [
          {
            id: 1,
            topic: '/chatter',
            encoding: 'json',
            schemaName: 'std_msgs/msg/String',
            schema: '',
          },
        ],
      }),
    );
    await promise;

    client.ensureAdvertised('/cmd_vel', TWIST);
    client.publish('/cmd_vel', TWIST, { linear: { x: 0.5 } }, { priority: 'control' });

    // The settle is a rosbridge fix for a rosbridge behaviour: the server
    // discarding ops it has not yet processed. The same teardown row passed on
    // Foxglove on the rig that failed here, so this path is left alone rather
    // than given an unmeasured delay. Revisit only with a measurement.
    await client.disconnect();

    expect(socket.readyState).toBe(3);
  });
});
