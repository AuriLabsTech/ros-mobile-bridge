// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * `onLatency` reports the round trips the library already makes, on every
 * transport (ADR 0015).
 *
 * Up to 0.1.12 exactly one of the two shipped transports ever called it.
 * `RosbridgeClient` ran a 5 s `/rosapi/topics` probe; `FoxgloveClient` never
 * called `onLatency` at all, so a consumer who passed the option got a
 * permanently blank readout on that transport with nothing to distinguish it
 * from a connection that had not measured yet.
 *
 * The contract is now one sentence, true on both: a sample is reported when a
 * correlated request is matched to its response, and a connection that makes
 * no round trips reports none. What differs between the transports is only
 * whether an *idle* connection is additionally measured, and that difference
 * is a property of the protocols rather than of these implementations —
 * rosbridge has `/rosapi/get_time`, and every read-only correlated op Foxglove
 * WS v1 offers makes the bridge write a log line on the robot per probe.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parse as parseRosMsgDef } from '@foxglove/rosmsg';
import { MessageWriter } from '@foxglove/rosmsg2-serialization';
import { FoxgloveClient } from '../src/FoxgloveClient';
import { RosbridgeClient } from '../src/RosbridgeClient';
import {
  installMockWebSocket,
  withFakeTimers,
  findSentServiceCallRequest,
  foxgloveServiceCallResponseFrame,
  type MockWebSocketHandle,
  type MockWebSocket,
} from './_helpers/mock-websocket';

const SERVICE = '/dock';
const SERVICE_ID = 3;
const RESP_DEF = 'bool success\nstring message\n';

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('onLatency — passive measurement from real round trips', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  // ── Foxglove ────────────────────────────────────────────────────────────

  describe('FoxgloveClient', () => {
    async function connected(
      onLatency: (ms: number) => void = () => {},
    ): Promise<{ client: FoxgloveClient; socket: MockWebSocket }> {
      const client = new FoxgloveClient({ onLatency });
      const promise = client.connect('ws://localhost:8765');
      const socket = ws.last();
      socket.simulateOpen('foxglove.websocket.v1');
      socket.simulateMessage(
        JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: ['services'] }),
      );
      // `connect()` resolves on the first `advertise`, not on `serverInfo`.
      socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [] }));
      socket.simulateMessage(
        JSON.stringify({
          op: 'advertiseServices',
          services: [
            {
              id: SERVICE_ID,
              name: SERVICE,
              type: 'std_srvs/srv/SetBool',
              requestSchema: 'bool data\n',
              responseSchema: RESP_DEF,
            },
          ],
        }),
      );
      await promise;
      return { client, socket };
    }

    it('reports a sample when a service call is matched to its response', async () => {
      const samples: number[] = [];
      const { client, socket } = await connected((ms) => samples.push(ms));

      const call = client.callService(SERVICE, { data: true });
      await flush();

      const sent = findSentServiceCallRequest(socket);
      expect(sent).not.toBeNull();

      const payload = new MessageWriter(parseRosMsgDef(RESP_DEF, { ros2: true })).writeMessage({
        success: true,
        message: 'ok',
      });
      socket.simulateMessage(
        foxgloveServiceCallResponseFrame(SERVICE_ID, sent!.callId, 'cdr', payload),
      );

      await call;
      expect(samples).toHaveLength(1);
      expect(samples[0]).toBeGreaterThanOrEqual(0);
    });

    it('reports a sample for a failure frame too: the round trip completed', async () => {
      // A `serviceCallFailure` means the request reached the bridge and an
      // answer came back. That the service failed is a different fact from how
      // long the wire took, and a consumer watching latency wants the number.
      const samples: number[] = [];
      const { client, socket } = await connected((ms) => samples.push(ms));

      const call = client.callService(SERVICE, { data: true });
      await flush();
      const sent = findSentServiceCallRequest(socket);

      socket.simulateMessage(
        JSON.stringify({
          op: 'serviceCallFailure',
          serviceId: SERVICE_ID,
          callId: sent!.callId,
          message: 'no server',
        }),
      );

      await expect(call).rejects.toThrow('no server');
      expect(samples).toHaveLength(1);
    });

    it('reports nothing on a timeout: nothing came back to time', async () => {
      await withFakeTimers(async () => {
        const samples: number[] = [];
        const { client } = await connected((ms) => samples.push(ms));

        const call = client.callService(SERVICE, { data: true }, { timeoutMs: 1000 });
        const settled = call.catch(() => 'timed out');
        await vi.advanceTimersByTimeAsync(2000);

        expect(await settled).toBe('timed out');
        expect(samples).toEqual([]);
      });
    });

    it('runs no idle probe: a connection that makes no requests reports nothing', async () => {
      // The honest state, and the whole of ADR 0015 decision 2. Every
      // correlated read-only op Foxglove WS v1 offers costs a log line on the
      // user's robot per tick, so no synthetic probe is added here. If this
      // test ever fails, something started measuring an idle Foxglove
      // connection and the ADR needs revisiting before the code does.
      await withFakeTimers(async () => {
        const samples: number[] = [];
        await connected((ms) => samples.push(ms));
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(samples).toEqual([]);
      });
    });

    it('a throwing onLatency never reaches the caller', async () => {
      const { client, socket } = await connected(() => {
        throw new Error('consumer metrics blew up');
      });

      const call = client.callService(SERVICE, { data: true });
      await flush();
      const sent = findSentServiceCallRequest(socket);
      const payload = new MessageWriter(parseRosMsgDef(RESP_DEF, { ros2: true })).writeMessage({
        success: true,
        message: 'ok',
      });
      socket.simulateMessage(
        foxgloveServiceCallResponseFrame(SERVICE_ID, sent!.callId, 'cdr', payload),
      );

      await expect(call).resolves.toEqual({ success: true, message: 'ok' });
    });
  });

  // ── rosbridge ───────────────────────────────────────────────────────────

  describe('RosbridgeClient', () => {
    async function connected(
      options?: ConstructorParameters<typeof RosbridgeClient>[0],
    ): Promise<{ client: RosbridgeClient; socket: MockWebSocket }> {
      const client = new RosbridgeClient(options);
      const promise = client.connect('ws://localhost:9090');
      const socket = ws.last();
      socket.simulateOpen();
      await promise;
      return { client, socket };
    }

    /** The most recent `call_service` frame for `service`, or undefined. */
    function lastCall(socket: MockWebSocket, service: string): { id: string } | undefined {
      const calls = socket.sentJson.filter((m) => m.op === 'call_service' && m.service === service);
      return calls[calls.length - 1] as { id: string } | undefined;
    }

    it('reports a sample when a service call is matched to its response', async () => {
      const samples: number[] = [];
      const { client, socket } = await connected({ onLatency: (ms) => samples.push(ms) });

      const call = client.callService('/dock', {});
      await flush();
      const sent = lastCall(socket, '/dock');
      socket.simulateMessage(
        JSON.stringify({ op: 'service_response', id: sent!.id, result: true, values: {} }),
      );

      await call;
      // The connect path's own `/rosapi/topics` and `/rosapi/services` reads
      // are round trips too and are still unanswered here, so this is the one.
      expect(samples).toHaveLength(1);
    });

    it('probes an idle connection on /rosapi/get_time, not /rosapi/topics', async () => {
      // The probe used to reuse a `/rosapi/topics` call and feed the answer
      // back into the topic list, so a measurement silently doubled as
      // discovery. `/rosapi/get_time` is purpose-built, read-only and
      // payload-free: it carries no graph data and there is nothing to mutate.
      await withFakeTimers(async () => {
        const samples: number[] = [];
        const { socket } = await connected({
          onLatency: (ms) => samples.push(ms),
          discoveryRefreshMs: 0, // isolate the probe from the discovery timers
        });

        await vi.advanceTimersByTimeAsync(30_000);
        const probe = lastCall(socket, '/rosapi/get_time');
        expect(probe).toBeDefined();

        socket.simulateMessage(
          JSON.stringify({
            op: 'service_response',
            id: probe!.id,
            result: true,
            values: { time: { secs: 1, nsecs: 0 } },
          }),
        );
        await flush();

        expect(samples).toHaveLength(1);
      });
    });

    it('the probe does not touch the topic list', async () => {
      await withFakeTimers(async () => {
        const { client, socket } = await connected({ discoveryRefreshMs: 0 });

        // On-connect discovery establishes a known set.
        const initial = lastCall(socket, '/rosapi/topics');
        socket.simulateMessage(
          JSON.stringify({
            op: 'service_response',
            id: initial!.id,
            result: true,
            values: { topics: ['/a'], types: ['ta'] },
          }),
        );
        await flush();

        const changes: string[][] = [];
        client.onTopicsChange((t) => changes.push(t.map((x) => x.topic)));

        // A probe answer carrying something topic-shaped must change nothing.
        await vi.advanceTimersByTimeAsync(30_000);
        const probe = lastCall(socket, '/rosapi/get_time');
        socket.simulateMessage(
          JSON.stringify({
            op: 'service_response',
            id: probe!.id,
            result: true,
            values: { topics: ['/a', '/b'], types: ['ta', 'tb'] },
          }),
        );
        await flush();

        expect(changes).toEqual([]);
      });
    });

    it('latches the probe off after a single failed call', async () => {
      // A `services_glob` that blocks `/rosapi/get_time` blocks every retry
      // too. One error, then silence, rather than an error every interval for
      // the life of the connection.
      await withFakeTimers(async () => {
        const { socket } = await connected({ discoveryRefreshMs: 0 });

        await vi.advanceTimersByTimeAsync(30_000);
        const first = lastCall(socket, '/rosapi/get_time');
        expect(first).toBeDefined();

        socket.simulateMessage(
          JSON.stringify({
            op: 'service_response',
            id: first!.id,
            result: false,
            values: 'service /rosapi/get_time does not exist',
          }),
        );
        await flush();

        await vi.advanceTimersByTimeAsync(5 * 60_000);
        const calls = socket.sentJson.filter(
          (m) => m.op === 'call_service' && m.service === '/rosapi/get_time',
        );
        expect(calls).toHaveLength(1);
      });
    });

    it('latches the probe off when the call is dropped silently, with no failure frame', async () => {
      // The failure mode the latch was written for produces no frame at all.
      // A restrictive `services_glob` makes rosbridge answer nothing, so the
      // 5 s guard is the only observer. A guard that drops the pending entry
      // without rejecting it never runs the latch, so the probe re-fires every
      // interval for the life of the connection, which is exactly the "an error
      // every interval forever" its own TSDoc promises to avoid.
      await withFakeTimers(async () => {
        const { socket } = await connected({ discoveryRefreshMs: 0 });

        await vi.advanceTimersByTimeAsync(30_000);
        expect(lastCall(socket, '/rosapi/get_time')).toBeDefined();

        // No response of any kind. Past the 5 s guard, and well past several
        // further probe intervals.
        await vi.advanceTimersByTimeAsync(5 * 60_000);

        const calls = socket.sentJson.filter(
          (m) => m.op === 'call_service' && m.service === '/rosapi/get_time',
        );
        expect(calls).toHaveLength(1);
      });
    });

    it('latencyProbeMs: 0 runs no probe, and real round trips still report', async () => {
      await withFakeTimers(async () => {
        const samples: number[] = [];
        const { client, socket } = await connected({
          onLatency: (ms) => samples.push(ms),
          latencyProbeMs: 0,
          discoveryRefreshMs: 0,
        });

        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(lastCall(socket, '/rosapi/get_time')).toBeUndefined();
        expect(samples).toEqual([]);

        const call = client.callService('/dock', {});
        await flush();
        const sent = lastCall(socket, '/dock');
        socket.simulateMessage(
          JSON.stringify({ op: 'service_response', id: sent!.id, result: true, values: {} }),
        );
        await call;

        expect(samples).toHaveLength(1);
      });
    });

    it('honours a custom latencyProbeMs', async () => {
      await withFakeTimers(async () => {
        const { socket } = await connected({ latencyProbeMs: 60_000, discoveryRefreshMs: 0 });

        await vi.advanceTimersByTimeAsync(30_000);
        expect(lastCall(socket, '/rosapi/get_time')).toBeUndefined();

        await vi.advanceTimersByTimeAsync(30_000);
        expect(lastCall(socket, '/rosapi/get_time')).toBeDefined();
      });
    });
  });
});
