// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * Discovery state on Foxglove WebSocket (ADR 0034): the bridge pushes both
 * lists over the connection, so topics are available once the handshake
 * completes (`serverInfo`, then the first advertise), and services are available only when the bridge offers the
 * `services` capability, `'not-offered'` otherwise.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import type { DiscoveryState } from '../src/types';
import { installMockWebSocket, type MockWebSocketHandle } from './_helpers/mock-websocket';

const UNKNOWN: DiscoveryState = { topics: { state: 'unknown' }, services: { state: 'unknown' } };

describe('FoxgloveClient discovery state (ADR 0034)', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  async function connectWith(client: FoxgloveClient, capabilities: string[]): Promise<void> {
    const connected = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    expect(client.getDiscoveryState()).toEqual(UNKNOWN);
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities }));
    socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [] }));
    await connected;
  }

  it('marks services available on the first service list, not at the handshake', async () => {
    const client = new FoxgloveClient();
    const seen: DiscoveryState[] = [];
    client.onDiscoveryStateChange((s) => seen.push(s));

    await connectWith(client, ['services']);
    const topicsOnly: DiscoveryState = {
      topics: { state: 'available' },
      services: { state: 'unknown' },
    };
    // The bridge sends its service list after the handshake: none read yet.
    expect(client.getDiscoveryState()).toEqual(topicsOnly);

    const heard: DiscoveryState['services'][] = [];
    client.onServicesChange(() => heard.push(client.getDiscoveryState().services));
    ws.last().simulateMessage(
      JSON.stringify({
        op: 'advertiseServices',
        services: [{ id: 1, name: '/a/srv', type: 'std_srvs/srv/Trigger' }],
      }),
    );

    const offered: DiscoveryState = {
      topics: { state: 'available' },
      services: { state: 'available' },
    };
    expect(client.getDiscoveryState()).toEqual(offered);
    expect(seen).toEqual([UNKNOWN, topicsOnly, offered]);
    // The list listener hears the list with the state already set.
    expect(heard.at(-1)).toEqual({ state: 'available' });
    await client.disconnect();
  });

  it('keeps services not-offered when a bridge without the capability sends a service list anyway', async () => {
    const client = new FoxgloveClient();
    await connectWith(client, []);

    ws.last().simulateMessage(
      JSON.stringify({
        op: 'advertiseServices',
        services: [{ id: 1, name: '/a/srv', type: 'std_srvs/srv/Trigger' }],
      }),
    );

    expect(client.getDiscoveryState().services).toEqual({
      state: 'unavailable',
      reason: 'not-offered',
    });
    await client.disconnect();
  });

  it('tells services listeners of the emptied list once when a state listener disconnects on the first list', async () => {
    const client = new FoxgloveClient();
    await connectWith(client, ['services']);
    let closing: Promise<void> | null = null;
    client.onDiscoveryStateChange((s) => {
      if (s.services.state === 'available' && !closing) closing = client.disconnect();
    });
    const lists: number[] = [];
    client.onServicesChange((list) => lists.push(list.length));

    ws.last().simulateMessage(
      JSON.stringify({
        op: 'advertiseServices',
        services: [{ id: 1, name: '/a/srv', type: 'std_srvs/srv/Trigger' }],
      }),
    );
    await closing;

    // The initial call on registering, then the emptied list from the disconnect, once.
    expect(lists).toEqual([0, 0]);
  });

  it('does not mark services available while a disconnect waits on a held first publish', async () => {
    vi.useFakeTimers();
    try {
      const client = new FoxgloveClient();
      await connectWith(client, ['services']);
      const seen: DiscoveryState[] = [];
      client.onDiscoveryStateChange((s) => seen.push(s));

      // A first publish holds about 150 ms; the disconnect waits for it, and the
      // 2 s list wait runs out inside that window.
      await vi.advanceTimersByTimeAsync(1_950);
      client.publish('/cmd', 'std_msgs/msg/String', { data: 'x' });
      const closing = client.disconnect();
      await vi.runAllTimersAsync();
      await closing;

      expect(seen.some((s) => s.services.state === 'available')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still lets a service call made after the 2 s mark wait for a list that is late', async () => {
    vi.useFakeTimers();
    try {
      const client = new FoxgloveClient();
      await connectWith(client, ['services']);

      await vi.advanceTimersByTimeAsync(2_200);
      let settled = false;
      const call = client.callService('/arm/home', {});
      call.then(
        () => (settled = true),
        () => (settled = true),
      );
      await vi.advanceTimersByTimeAsync(100);

      // The call waits for the first list, as it did before the state existed.
      expect(settled).toBe(false);
      const closing = client.disconnect();
      await vi.runAllTimersAsync();
      await closing;
      await call.catch(() => {});
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells services listeners of a list the bridge sends before the handshake completes', async () => {
    const client = new FoxgloveClient();
    const lists: string[][] = [];
    client.onServicesChange((list) => lists.push(list.map((s) => s.name)));
    const connected = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(
      JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: ['services'] }),
    );
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertiseServices',
        services: [{ id: 1, name: '/a/srv', type: 'std_srvs/srv/Trigger' }],
      }),
    );
    socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [] }));
    await connected;

    expect(lists.at(-1)).toEqual(['/a/srv']);
    expect(client.getDiscoveryState().services).toEqual({ state: 'available' });
    await client.disconnect();
  });

  it('marks services available 2 s after the handshake when the bridge sends no list', async () => {
    vi.useFakeTimers();
    try {
      const client = new FoxgloveClient();
      await connectWith(client, ['services']);

      await vi.advanceTimersByTimeAsync(1_999);
      expect(client.getDiscoveryState().services).toEqual({ state: 'unknown' });
      await vi.advanceTimersByTimeAsync(1);
      expect(client.getDiscoveryState().services).toEqual({ state: 'available' });
      expect(client.getAvailableServices()).toEqual([]);
      const closing = client.disconnect();
      await vi.runAllTimersAsync();
      await closing;
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps services not read yet when the connection ends before any list', async () => {
    vi.useFakeTimers();
    try {
      const client = new FoxgloveClient();
      await connectWith(client, ['services']);
      const seen: DiscoveryState[] = [];
      client.onDiscoveryStateChange((s) => seen.push(s));

      const closing = client.disconnect();
      await vi.runAllTimersAsync();
      await closing;

      // The release of the list wait on teardown is no list read.
      expect(seen.some((s) => s.services.state === 'available')).toBe(false);
      expect(client.getDiscoveryState()).toEqual(UNKNOWN);
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks services not-offered when the bridge was launched without them', async () => {
    const client = new FoxgloveClient();
    await connectWith(client, []);

    expect(client.getDiscoveryState()).toEqual({
      topics: { state: 'available' },
      services: { state: 'unavailable', reason: 'not-offered' },
    });
  });

  it('settles connect() before telling listeners, so a listener that disconnects does not cancel it', async () => {
    const client = new FoxgloveClient();
    let connectedWhenHeard: boolean | null = null;
    let closing: Promise<void> | null = null;
    client.onDiscoveryStateChange((s) => {
      if (s.topics.state !== 'available' || closing) return;
      connectedWhenHeard = client.isConnected;
      closing = client.disconnect();
    });

    await expect(connectWith(client, ['services'])).resolves.toBeUndefined();
    await closing;

    expect(connectedWhenHeard).toBe(true);
  });

  it("starts no 2 s services wait for a connection a state listener already closed, so it cannot mark the next one's services", async () => {
    vi.useFakeTimers();
    try {
      const client = new FoxgloveClient();
      let closing: Promise<void> | null = null;
      const off = client.onDiscoveryStateChange((s) => {
        if (s.topics.state === 'available' && !closing) closing = client.disconnect();
      });
      await connectWith(client, ['services']);
      await closing;
      off();

      // Reconnect 1 s later; this connection's own wait runs out at 3 s.
      await vi.advanceTimersByTimeAsync(1_000);
      await connectWith(client, ['services']);
      await vi.advanceTimersByTimeAsync(1_500);

      // At 2.5 s no list came and this connection's wait has not run out.
      expect(client.getDiscoveryState().services).toEqual({ state: 'unknown' });
      const ending = client.disconnect();
      await vi.runAllTimersAsync();
      await ending;
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves no 2 s services timer pending after a state listener disconnects at the handshake', async () => {
    vi.useFakeTimers();
    try {
      const client = new FoxgloveClient();
      let closing: Promise<void> | null = null;
      client.onDiscoveryStateChange((s) => {
        if (s.topics.state === 'available' && !closing) closing = client.disconnect();
      });
      await connectWith(client, ['services']);
      await closing;

      // An intentional disconnect leaves nothing armed: a Node script exits at once.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns both lists to not read yet on disconnect', async () => {
    const client = new FoxgloveClient();
    await connectWith(client, []);
    const seen: DiscoveryState[] = [];
    client.onDiscoveryStateChange((s) => seen.push(s));

    await client.disconnect();

    expect(client.getDiscoveryState()).toEqual(UNKNOWN);
    expect(seen.at(-1)).toEqual(UNKNOWN);
  });

  it('tells a services listener of the emptied list only once the state is back to not read yet', async () => {
    const client = new FoxgloveClient();
    await connectWith(client, ['services']);
    ws.last().simulateMessage(
      JSON.stringify({
        op: 'advertiseServices',
        services: [{ id: 1, name: '/a/srv', type: 'std_srvs/srv/Trigger' }],
      }),
    );
    expect(client.getDiscoveryState().services).toEqual({ state: 'available' });
    const heard: DiscoveryState['services'][] = [];
    client.onServicesChange(() => heard.push(client.getDiscoveryState().services));

    await client.disconnect();

    // An emptied list next to 'available' would read as "the robot has no services".
    expect(heard.at(-1)).toEqual({ state: 'unknown' });
  });
});
