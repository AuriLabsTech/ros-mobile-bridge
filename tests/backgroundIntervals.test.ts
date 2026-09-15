// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * `discoveryRefreshMs` and `latencyProbeMs` (ADR 0015 decision 5).
 *
 * The load-bearing argument for these two options is not tuning, it is the off
 * switch. Up to 0.1.12 the library read a robot's graph on a timer forever with
 * no way for a consumer to stop it, which is the one place it still broke its
 * own "no silent reliability features" rule.
 *
 * Both are named for intent rather than mechanism, so a transport is free to
 * satisfy them however it can, including by already pushing the changes the
 * option asks about. Both default to the behaviour 0.1.12 shipped in kind: when
 * existing behaviour becomes configurable, the default is the existing
 * behaviour, or the upgrade delivers as a silent regression exactly the defect
 * this ADR was opened about.
 *
 * Validation is deliberately identical on both clients even though only
 * rosbridge honours the values. A consumer who passes a dangerous cadence
 * should learn that from whichever client they happened to construct, not from
 * whichever transport the robot happened to be running.
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

const CLIENTS = [
  ['FoxgloveClient', (o?: object) => new FoxgloveClient(o)],
  ['RosbridgeClient', (o?: object) => new RosbridgeClient(o)],
] as const;

const FIELDS = ['discoveryRefreshMs', 'latencyProbeMs'] as const;

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('background interval options', () => {
  describe('validation', () => {
    for (const [name, construct] of CLIENTS) {
      for (const field of FIELDS) {
        it(`${name} throws synchronously on a sub-second ${field}`, () => {
          // Refused rather than clamped, following the `callService`
          // `timeoutMs` precedent (ADR 0006 §8): a dangerous value is a
          // programmer error and must never reach a setInterval that calls
          // services on someone's robot.
          expect(() => construct({ [field]: 250 })).toThrow(/at least 1000/);
        });

        it(`${name} throws on a negative or non-finite ${field}`, () => {
          expect(() => construct({ [field]: -1 })).toThrow();
          expect(() => construct({ [field]: Number.NaN })).toThrow();
          expect(() => construct({ [field]: Number.POSITIVE_INFINITY })).toThrow();
        });

        it(`${name} accepts 0 (disabled) and any value at or above 1000 for ${field}`, () => {
          expect(() => construct({ [field]: 0 })).not.toThrow();
          expect(() => construct({ [field]: 1000 })).not.toThrow();
          expect(() => construct({ [field]: 60_000 })).not.toThrow();
        });

        it(`${name} accepts an omitted ${field}`, () => {
          expect(() => construct({})).not.toThrow();
        });
      }
    }
  });

  describe('RosbridgeClient discoveryRefreshMs', () => {
    let ws: MockWebSocketHandle;

    beforeEach(() => {
      ws = installMockWebSocket();
    });
    afterEach(() => {
      ws.restore();
    });

    async function connected(
      options?: ConstructorParameters<typeof RosbridgeClient>[0],
    ): Promise<MockWebSocket> {
      const client = new RosbridgeClient(options);
      const promise = client.connect('ws://localhost:9090');
      const socket = ws.last();
      socket.simulateOpen();
      await promise;
      return socket;
    }

    function callsTo(socket: MockWebSocket, service: string): unknown[] {
      return socket.sentJson.filter((m) => m.op === 'call_service' && m.service === service);
    }

    /**
     * Answer every `call_service` frame not yet answered.
     *
     * Without this a test that only advances time is really testing the 30 s
     * service-call timeout and the bounded rediscovery retry it triggers, not
     * the poll cadence it means to.
     */
    const answered = new Set<string>();
    function answerAll(socket: MockWebSocket): void {
      for (const m of socket.sentJson) {
        if (m.op !== 'call_service') continue;
        const { id, service } = m as { id: string; service: string };
        if (answered.has(id)) continue;
        answered.add(id);
        const values =
          service === '/rosapi/topics'
            ? { topics: ['/rosout'], types: ['rcl_interfaces/msg/Log'] }
            : service === '/rosapi/services'
              ? { services: ['/dock'] }
              : {};
        socket.simulateMessage(
          JSON.stringify({ op: 'service_response', id, result: true, values }),
        );
      }
    }
    beforeEach(() => answered.clear());

    it('defaults to 30 s for both the topics poll and the services poll', async () => {
      await withFakeTimers(async () => {
        const socket = await connected({ latencyProbeMs: 0 });
        answerAll(socket);
        await flush();
        const topicsAtConnect = callsTo(socket, '/rosapi/topics').length;
        const servicesAtConnect = callsTo(socket, '/rosapi/services').length;

        await vi.advanceTimersByTimeAsync(29_000);
        answerAll(socket);
        await flush();
        expect(callsTo(socket, '/rosapi/topics')).toHaveLength(topicsAtConnect);
        expect(callsTo(socket, '/rosapi/services')).toHaveLength(servicesAtConnect);

        await vi.advanceTimersByTimeAsync(2_000);
        answerAll(socket);
        await flush();
        expect(callsTo(socket, '/rosapi/topics')).toHaveLength(topicsAtConnect + 1);
        expect(callsTo(socket, '/rosapi/services')).toHaveLength(servicesAtConnect + 1);
      });
    });

    it('0 stops both recurring reads but still reads once on connect', async () => {
      // Disabling the *refresh* is not asking to connect to a robot whose
      // topics and services are never learned. The consumer who turns this off
      // is the consumer who refreshes on demand, and `getAvailableTopics()`
      // still works.
      await withFakeTimers(async () => {
        const socket = await connected({ discoveryRefreshMs: 0, latencyProbeMs: 0 });
        answerAll(socket);
        await flush();

        const topicsAtConnect = callsTo(socket, '/rosapi/topics').length;
        const servicesAtConnect = callsTo(socket, '/rosapi/services').length;
        expect(topicsAtConnect).toBeGreaterThan(0);
        expect(servicesAtConnect).toBeGreaterThan(0);

        await vi.advanceTimersByTimeAsync(10 * 60_000);
        answerAll(socket);
        await flush();
        expect(callsTo(socket, '/rosapi/topics')).toHaveLength(topicsAtConnect);
        expect(callsTo(socket, '/rosapi/services')).toHaveLength(servicesAtConnect);
      });
    });

    it('drives the two polls on separate timers, not one shared timer', async () => {
      // Identical intervals, separately named and separately owned. Two jobs on
      // one timer is the defect ADR 0015 exists to remove, and a shared timer
      // would resurrect it the first time either cadence had to differ.
      await withFakeTimers(async () => {
        const socket = await connected({ discoveryRefreshMs: 1000, latencyProbeMs: 0 });
        const topicsAtConnect = callsTo(socket, '/rosapi/topics').length;
        const servicesAtConnect = callsTo(socket, '/rosapi/services').length;

        // Fail the services poll. Its own error path stops its own timer.
        const svc = socket.sentJson.filter(
          (m) => m.op === 'call_service' && m.service === '/rosapi/services',
        );
        const lastSvc = svc[svc.length - 1] as { id: string };
        answered.add(lastSvc.id);
        socket.simulateMessage(
          JSON.stringify({
            op: 'service_response',
            id: lastSvc.id,
            result: false,
            values: 'blocked by services_glob',
          }),
        );
        await flush();
        await vi.advanceTimersByTimeAsync(3_000);
        answerAll(socket);
        await flush();

        // Services stopped; topics kept going.
        expect(callsTo(socket, '/rosapi/services')).toHaveLength(servicesAtConnect);
        expect(callsTo(socket, '/rosapi/topics').length).toBeGreaterThan(topicsAtConnect);
      });
    });
  });

  describe('FoxgloveClient', () => {
    let ws: MockWebSocketHandle;

    beforeEach(() => {
      ws = installMockWebSocket();
    });
    afterEach(() => {
      ws.restore();
    });

    it('honours neither option on the wire: the graph is pushed, not polled', async () => {
      // Inert by design, not by oversight. Foxglove WS pushes `advertise` and
      // `unadvertise` on the live socket, so there is no discovery to pace, and
      // ADR 0015 decision 2 rules out an idle latency probe on this transport.
      await withFakeTimers(async () => {
        const client = new FoxgloveClient({ discoveryRefreshMs: 1000, latencyProbeMs: 1000 });
        const promise = client.connect('ws://localhost:8765');
        const socket = ws.last();
        socket.simulateOpen('foxglove.websocket.v1');
        socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
        socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [] }));
        await promise;

        const afterConnect = socket.sentMessages.length;
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(socket.sentMessages).toHaveLength(afterConnect);
      });
    });
  });
});
