// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * Discovery state on rosbridge (ADR 0034): a list is marked unavailable only
 * on an explicit "does not exist" refusal from rosapi, confirmed by a second
 * `/rosapi/get_time` ask about 2 s later, never on a timeout; it clears on the
 * next good read of that list and returns to not read yet on disconnect.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RosbridgeClient } from '../src/RosbridgeClient';
import type { DiscoveryState } from '../src/types';
import {
  disconnectUnderFakeTimers,
  installMockWebSocket,
  withFakeTimers,
  type MockWebSocketHandle,
} from './_helpers/mock-websocket';

type Socket = ReturnType<MockWebSocketHandle['last']>;

const UNKNOWN: DiscoveryState = { topics: { state: 'unknown' }, services: { state: 'unknown' } };
const ROSAPI_GONE: DiscoveryState = {
  topics: { state: 'unavailable', reason: 'helper-missing' },
  services: { state: 'unavailable', reason: 'helper-missing' },
};

/** Ids of every `call_service` the client sent for `service`, oldest first. */
function callIds(socket: Socket, service: string): string[] {
  return socket.sentJson
    .filter((m) => m.op === 'call_service' && m.service === service)
    .map((m) => m.id as string);
}

/** The id of the newest call for `service`; throws when there is none. */
function lastCallId(socket: Socket, service: string): string {
  const id = callIds(socket, service).at(-1);
  if (!id) throw new Error(`no ${service} call to answer`);
  return id;
}

/** rosbridge's refusal for a service missing from its graph, as measured. */
function refuse(socket: Socket, service: string): void {
  socket.simulateMessage(
    JSON.stringify({
      op: 'service_response',
      id: lastCallId(socket, service),
      result: false,
      values: `Service ${service} does not exist`,
    }),
  );
}

/** A successful answer to the newest call for `service`. */
function answer(socket: Socket, service: string, values: Record<string, unknown>): void {
  socket.simulateMessage(
    JSON.stringify({
      op: 'service_response',
      id: lastCallId(socket, service),
      result: true,
      values,
    }),
  );
}

async function connected(client: RosbridgeClient, ws: MockWebSocketHandle): Promise<Socket> {
  const p = client.connect('ws://localhost:9090');
  const socket = ws.last();
  socket.simulateOpen();
  await p;
  return socket;
}

describe('RosbridgeClient discovery state (ADR 0034)', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  it('marks both lists helper-missing when a refusal is confirmed by a second get_time refusal', async () => {
    await withFakeTimers(async () => {
      const client = new RosbridgeClient({ latencyProbeMs: 0 });
      const seen: DiscoveryState[] = [];
      client.onDiscoveryStateChange((s) => seen.push(s));
      const socket = await connected(client, ws);

      refuse(socket, '/rosapi/services');
      await vi.advanceTimersByTimeAsync(0);
      // One refusal is not enough: a busy rosapi can miss its readiness wait.
      expect(client.getDiscoveryState()).toEqual(UNKNOWN);
      expect(callIds(socket, '/rosapi/get_time')).toEqual([]);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(callIds(socket, '/rosapi/get_time')).toHaveLength(1);
      refuse(socket, '/rosapi/get_time');
      await vi.advanceTimersByTimeAsync(0);

      expect(client.getDiscoveryState()).toEqual(ROSAPI_GONE);
      expect(seen).toEqual([UNKNOWN, ROSAPI_GONE]);
    });
  });

  it('leaves the state alone when the confirming get_time answers (a busy rosapi), and confirms afresh on the next refusal', async () => {
    await withFakeTimers(async () => {
      const client = new RosbridgeClient({ latencyProbeMs: 0 });
      const seen: DiscoveryState[] = [];
      client.onDiscoveryStateChange((s) => seen.push(s));
      const socket = await connected(client, ws);

      refuse(socket, '/rosapi/services');
      await vi.advanceTimersByTimeAsync(2_000);
      answer(socket, '/rosapi/get_time', { sec: 1, nanosec: 0 });
      await vi.advanceTimersByTimeAsync(0);
      expect(seen).toEqual([UNKNOWN]);

      // The next refusal is new evidence: it gets its own confirming ask.
      refuse(socket, '/rosapi/topics');
      await vi.advanceTimersByTimeAsync(2_000);
      expect(callIds(socket, '/rosapi/get_time')).toHaveLength(2);
      refuse(socket, '/rosapi/get_time');
      await vi.advanceTimersByTimeAsync(0);
      expect(client.getDiscoveryState()).toEqual(ROSAPI_GONE);
    });
  });

  it('never treats rosbridge\'s own "Timeout exceeded" reply as a refusal', async () => {
    await withFakeTimers(async () => {
      const client = new RosbridgeClient({ latencyProbeMs: 0 });
      const socket = await connected(client, ws);

      socket.simulateMessage(
        JSON.stringify({
          op: 'service_response',
          id: lastCallId(socket, '/rosapi/services'),
          result: false,
          values: 'Timeout exceeded while waiting for service response',
        }),
      );
      await vi.advanceTimersByTimeAsync(5_000);

      expect(callIds(socket, '/rosapi/get_time')).toEqual([]);
      expect(client.getDiscoveryState()).toEqual(UNKNOWN);
    });
  });

  it('never treats a call that gets no answer as a refusal', async () => {
    await withFakeTimers(async () => {
      const client = new RosbridgeClient({ latencyProbeMs: 0 });
      const socket = await connected(client, ws);

      // Nothing answers the connect's topics and services reads: both time out.
      await vi.advanceTimersByTimeAsync(35_000);

      expect(callIds(socket, '/rosapi/get_time')).toEqual([]);
      expect(client.getDiscoveryState()).toEqual(UNKNOWN);
    });
  });

  it('marks each list available on its first good read', async () => {
    await withFakeTimers(async () => {
      const client = new RosbridgeClient({ latencyProbeMs: 0 });
      const socket = await connected(client, ws);

      answer(socket, '/rosapi/services', { services: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(client.getDiscoveryState()).toEqual({
        topics: { state: 'unknown' },
        services: { state: 'available' },
      });

      // An empty robot is still a list the client read, when the app asks.
      const read = client.getAvailableTopics();
      answer(socket, '/rosapi/topics', { topics: [], types: [] });
      await read;
      expect(client.getDiscoveryState()).toEqual({
        topics: { state: 'available' },
        services: { state: 'available' },
      });
    });
  });

  it('reports a list available only once its new contents are in place', async () => {
    await withFakeTimers(async () => {
      const client = new RosbridgeClient({ latencyProbeMs: 0 });
      const listed: string[][] = [];
      client.onDiscoveryStateChange((s) => {
        if (s.services.state === 'available') {
          listed.push(client.getAvailableServices().map((x) => x.name));
        }
      });
      const socket = await connected(client, ws);

      answer(socket, '/rosapi/services', { services: ['/a/srv'] });
      await vi.advanceTimersByTimeAsync(0);

      expect(listed).toEqual([['/a/srv']]);
    });
  });

  it('tells a topics listener of a new list only once topics read as available', async () => {
    await withFakeTimers(async () => {
      const client = new RosbridgeClient({ latencyProbeMs: 0 });
      const heard: DiscoveryState['topics'][] = [];
      client.onTopicsChange(() => heard.push(client.getDiscoveryState().topics));
      const socket = await connected(client, ws);

      answer(socket, '/rosapi/topics', { topics: ['/chatter'], types: ['std_msgs/msg/String'] });
      await vi.advanceTimersByTimeAsync(0);

      expect(heard).toEqual([{ state: 'available' }]);
    });
  });

  it('tells a services listener of the emptied list on disconnect only once the state is back to not read yet', async () => {
    await withFakeTimers(async () => {
      const client = new RosbridgeClient({ latencyProbeMs: 0 });
      const socket = await connected(client, ws);
      answer(socket, '/rosapi/services', { services: ['/a/srv'] });
      await vi.advanceTimersByTimeAsync(0);
      const heard: DiscoveryState['services'][] = [];
      client.onServicesChange(() => heard.push(client.getDiscoveryState().services));

      await disconnectUnderFakeTimers(client);

      // The first entry is the initial call on registering. An emptied list
      // next to 'available' would read as "the robot has no services".
      expect(heard).toEqual([{ state: 'available' }, { state: 'unknown' }]);
    });
  });

  it('calls a listener registered from inside a state callback once, with the state it registered on', async () => {
    await withFakeTimers(async () => {
      const client = new RosbridgeClient({ latencyProbeMs: 0 });
      const late: DiscoveryState[] = [];
      let registered = false;
      client.onDiscoveryStateChange((s) => {
        if (s.services.state !== 'available' || registered) return;
        registered = true;
        client.onDiscoveryStateChange((t) => late.push(t));
      });
      const socket = await connected(client, ws);

      answer(socket, '/rosapi/services', { services: ['/a/srv'] });
      await vi.advanceTimersByTimeAsync(0);

      // Only the initial call on registering: the change it registered on is not heard twice.
      expect(late).toEqual([{ topics: { state: 'unknown' }, services: { state: 'available' } }]);
    });
  });

  it('keeps topics unknown while an empty first read after connect is being retried', async () => {
    await withFakeTimers(async () => {
      const client = new RosbridgeClient({ latencyProbeMs: 0 });
      const socket = await connected(client, ws);

      // Empty: the host may not have re-attached the robot yet, so it retries.
      answer(socket, '/rosapi/topics', { topics: [], types: [] });
      await vi.advanceTimersByTimeAsync(0);

      expect(client.getDiscoveryState().topics).toEqual({ state: 'unknown' });
    });
  });

  it('leaves the services list empty when a listener disconnects on hearing it available', async () => {
    await withFakeTimers(async () => {
      const client = new RosbridgeClient({ latencyProbeMs: 0 });
      let closing: Promise<void> | null = null;
      client.onDiscoveryStateChange((s) => {
        if (s.services.state === 'available' && !closing) closing = client.disconnect();
      });
      const socket = await connected(client, ws);

      answer(socket, '/rosapi/services', { services: ['/a/srv'] });
      await vi.advanceTimersByTimeAsync(5_000);
      await closing;

      expect(client.getAvailableServices()).toEqual([]);
      expect(client.getDiscoveryState()).toEqual(UNKNOWN);
    });
  });

  /** Connect and confirm rosapi dead, with the given discovery refresh. */
  async function rosapiGone(discoveryRefreshMs = 30_000): Promise<{
    client: RosbridgeClient;
    socket: Socket;
  }> {
    const client = new RosbridgeClient({ latencyProbeMs: 0, discoveryRefreshMs });
    const socket = await connected(client, ws);
    refuse(socket, '/rosapi/services');
    await vi.advanceTimersByTimeAsync(2_000);
    refuse(socket, '/rosapi/get_time');
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getDiscoveryState()).toEqual(ROSAPI_GONE);
    return { client, socket };
  }

  it('keeps polling services after a refused read, and a good read clears only that list', async () => {
    await withFakeTimers(async () => {
      const { client, socket } = await rosapiGone();
      const before = callIds(socket, '/rosapi/services').length;

      await vi.advanceTimersByTimeAsync(30_000);
      expect(callIds(socket, '/rosapi/services').length).toBe(before + 1);

      // rosapi is back (respawn:=true): the next poll's answer clears services.
      answer(socket, '/rosapi/services', { services: ['/a/srv'] });
      await vi.advanceTimersByTimeAsync(0);
      expect(client.getDiscoveryState()).toEqual({
        topics: { state: 'unavailable', reason: 'helper-missing' },
        services: { state: 'available' },
      });
      expect(client.getAvailableServices().map((s) => s.name)).toEqual(['/a/srv']);
    });
  });

  it('clears the topics list on a read the app asks for, with the refresh off', async () => {
    await withFakeTimers(async () => {
      const { client, socket } = await rosapiGone(0);

      const read = client.getAvailableTopics();
      answer(socket, '/rosapi/topics', { topics: ['/chatter'], types: ['std_msgs/msg/String'] });
      await read;

      expect(client.getDiscoveryState().topics).toEqual({ state: 'available' });
    });
  });

  it('asks nothing extra once rosapi is marked gone: a dead rosapi costs only the refresh', async () => {
    await withFakeTimers(async () => {
      const { socket } = await rosapiGone();

      await vi.advanceTimersByTimeAsync(30_000);
      refuse(socket, '/rosapi/services');
      await vi.advanceTimersByTimeAsync(5_000);

      expect(callIds(socket, '/rosapi/get_time')).toHaveLength(1);
    });
  });

  it('returns both lists to not read yet on disconnect, telling listeners', async () => {
    await withFakeTimers(async () => {
      const { client } = await rosapiGone();
      const seen: DiscoveryState[] = [];
      client.onDiscoveryStateChange((s) => seen.push(s));

      await disconnectUnderFakeTimers(client);

      expect(client.getDiscoveryState()).toEqual(UNKNOWN);
      expect(seen).toEqual([ROSAPI_GONE, UNKNOWN]);
    });
  });

  it('tells listeners of the reset only once the socket is released', async () => {
    await withFakeTimers(async () => {
      const { client } = await rosapiGone();
      let call: Promise<unknown> | null = null;
      client.onDiscoveryStateChange((s) => {
        if (s.topics.state !== 'unknown') return;
        const made = client.callService('/arm/home', {});
        made.catch(() => {}); // asserted below, after the disconnect
        call = made;
      });

      await disconnectUnderFakeTimers(client);

      // A call from the listener meets no connection, rather than a closing one.
      expect(call).not.toBeNull();
      await expect(call).rejects.toThrow('Not connected');
    });
  });

  it('sends no confirming ask during the teardown fence', async () => {
    await withFakeTimers(async () => {
      const client = new RosbridgeClient({ latencyProbeMs: 0 });
      const socket = await connected(client, ws);
      refuse(socket, '/rosapi/services');
      await vi.advanceTimersByTimeAsync(1_500);

      const done = client.disconnect();
      await vi.advanceTimersByTimeAsync(5_000);
      await done;

      expect(socket.sentJson.filter((m) => String(m.id).startsWith('discovery_confirm:'))).toEqual(
        [],
      );
    });
  });

  it('drops a confirmation still waiting when the connection ends', async () => {
    await withFakeTimers(async () => {
      const client = new RosbridgeClient({ latencyProbeMs: 0 });
      const socket = await connected(client, ws);
      refuse(socket, '/rosapi/services');
      socket.simulateClose(1006, 'gone');
      await vi.advanceTimersByTimeAsync(2_000);

      expect(callIds(socket, '/rosapi/get_time')).toEqual([]);
      expect(client.getDiscoveryState()).toEqual(UNKNOWN);
      await disconnectUnderFakeTimers(client);
    });
  });

  it("counts a refusal of the app's own /rosapi/ call, and a live rosapi's answer to the confirm keeps the state", async () => {
    await withFakeTimers(async () => {
      const client = new RosbridgeClient({ latencyProbeMs: 0 });
      const socket = await connected(client, ws);

      const call = client.callService('/rosapi/no_such_service', {});
      refuse(socket, '/rosapi/no_such_service');
      await expect(call).rejects.toThrow('does not exist');

      await vi.advanceTimersByTimeAsync(2_000);
      expect(callIds(socket, '/rosapi/get_time')).toHaveLength(1);
      answer(socket, '/rosapi/get_time', { sec: 1, nanosec: 0 });
      await vi.advanceTimersByTimeAsync(0);
      expect(client.getDiscoveryState()).toEqual(UNKNOWN);
    });
  });

  it('ignores a "does not exist" for a service outside /rosapi/', async () => {
    await withFakeTimers(async () => {
      const client = new RosbridgeClient({ latencyProbeMs: 0 });
      const socket = await connected(client, ws);

      const call = client.callService('/arm/home', {});
      refuse(socket, '/arm/home');
      await expect(call).rejects.toThrow('does not exist');
      await vi.advanceTimersByTimeAsync(5_000);

      expect(callIds(socket, '/rosapi/get_time')).toEqual([]);
    });
  });

  it('leaves the state alone when the confirming get_time gets no answer', async () => {
    await withFakeTimers(async () => {
      const client = new RosbridgeClient({ latencyProbeMs: 0 });
      const socket = await connected(client, ws);

      refuse(socket, '/rosapi/services');
      await vi.advanceTimersByTimeAsync(2_000 + 10_000);

      expect(callIds(socket, '/rosapi/get_time')).toHaveLength(1);
      expect(client.getDiscoveryState()).toEqual(UNKNOWN);
    });
  });
});
