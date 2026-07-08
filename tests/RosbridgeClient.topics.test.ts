// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * rosbridge topic re-discovery (RMB-39): the discovered-topic list must stay
 * fresh on (re)connect and mid-session, matching Foxglove's push-driven
 * freshness, without a public API change. Covers the reconnect-swap and
 * mid-session-add cases, the unchanged-no-notify guarantee, and the
 * empty-first-result bounded retry.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RosbridgeClient } from '../src/RosbridgeClient';
import {
  installMockWebSocket,
  withFakeTimers,
  type MockWebSocketHandle,
} from './_helpers/mock-websocket';

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

describe('RosbridgeClient — topic re-discovery (RMB-39)', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  it('re-discovers topics on connect and fires onTopicsChange with the set', async () => {
    const client = new RosbridgeClient();
    const changes: string[][] = [];
    client.onTopicsChange((t) => changes.push(t.map((x) => x.topic)));

    const p = client.connect('ws://localhost:9090');
    const socket = ws.last();
    socket.simulateOpen();
    await p;

    respondTopics(socket, ['/a', '/b'], ['ta', 'tb']);
    await flush();

    expect(changes).toEqual([['/a', '/b']]);
  });

  it('fires onTopicsChange only when the set changes, not on an unchanged re-poll', async () => {
    const client = new RosbridgeClient();
    const p = client.connect('ws://localhost:9090');
    const socket = ws.last();
    socket.simulateOpen();
    await p;
    respondTopics(socket, ['/a'], ['ta']); // on-connect discovery
    await flush();

    const changes: string[][] = [];
    client.onTopicsChange((t) => changes.push(t.map((x) => x.topic)));

    // Re-poll with the SAME set: must not notify.
    const g1 = client.getAvailableTopics();
    respondTopics(socket, ['/a'], ['ta']);
    await g1;

    // Re-poll with an ADDED topic: must notify with the new set.
    const g2 = client.getAvailableTopics();
    respondTopics(socket, ['/a', '/b'], ['ta', 'tb']);
    await g2;

    expect(changes).toEqual([['/a', '/b']]);
  });

  it('re-discovers topics mid-session via the latency probe (no second timer)', async () => {
    await withFakeTimers(async () => {
      const client = new RosbridgeClient();
      const p = client.connect('ws://localhost:9090');
      const socket = ws.last();
      socket.simulateOpen();
      await p;
      respondTopics(socket, ['/a'], ['ta']); // on-connect discovery
      await flush();

      const changes: string[][] = [];
      client.onTopicsChange((t) => changes.push(t.map((x) => x.topic)));

      // The latency probe issues its own /rosapi/topics every 5 s; its payload
      // is reused for topic re-discovery rather than running a second timer.
      await vi.advanceTimersByTimeAsync(5000);
      respondTopics(socket, ['/a', '/b'], ['ta', 'tb']);
      await flush();

      expect(changes).toEqual([['/a', '/b']]);
    });
  });

  it('does not stick an empty first result; a bounded retry recovers the real set', async () => {
    await withFakeTimers(async () => {
      const client = new RosbridgeClient();
      const changes: string[][] = [];
      client.onTopicsChange((t) => changes.push(t.map((x) => x.topic)));

      const p = client.connect('ws://localhost:9090');
      const socket = ws.last();
      socket.simulateOpen();
      await p;

      // First post-connect result is empty (host not re-attached yet).
      respondTopics(socket, [], []);
      await flush();
      expect(changes).toEqual([]); // empty did NOT stick / notify

      // The bounded retry re-issues the call; respond with the real set.
      await vi.advanceTimersByTimeAsync(700);
      respondTopics(socket, ['/a'], ['ta']);
      await flush();

      expect(changes).toEqual([['/a']]);
    });
  });

  it('refreshes topics after a reconnect where the host serves a different robot', async () => {
    await withFakeTimers(async () => {
      const client = new RosbridgeClient();
      const p = client.connect('ws://localhost:9090');
      const socketA = ws.last();
      socketA.simulateOpen();
      await p;
      respondTopics(socketA, ['/robotA/odom'], ['nav_msgs/msg/Odometry']);
      await flush();

      const changes: string[][] = [];
      client.onTopicsChange((t) => changes.push(t.map((x) => x.topic)));

      // Connection drops; the client schedules a reconnect (first backoff 1 s).
      socketA.simulateClose();
      await vi.advanceTimersByTimeAsync(1000);

      const socketB = ws.last();
      expect(socketB).not.toBe(socketA);
      socketB.simulateOpen();
      await flush();

      // The same host now serves a different robot.
      respondTopics(socketB, ['/robotB/scan'], ['sensor_msgs/msg/LaserScan']);
      await flush();

      expect(changes).toEqual([['/robotB/scan']]);
      expect(client.isConnected).toBe(true);
    });
  });
});
