// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * Discovery state on Foxglove WebSocket (ADR 0034): the bridge pushes both
 * lists over the connection, so topics are available once `serverInfo`
 * arrives, and services are available only when the bridge offers the
 * `services` capability, `'not-offered'` otherwise.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  it('marks both lists available when the bridge offers services', async () => {
    const client = new FoxgloveClient();
    const seen: DiscoveryState[] = [];
    client.onDiscoveryStateChange((s) => seen.push(s));

    await connectWith(client, ['services']);

    const offered: DiscoveryState = {
      topics: { state: 'available' },
      services: { state: 'available' },
    };
    expect(client.getDiscoveryState()).toEqual(offered);
    expect(seen).toEqual([UNKNOWN, offered]);
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
    const heard: DiscoveryState['services'][] = [];
    client.onServicesChange(() => heard.push(client.getDiscoveryState().services));

    await client.disconnect();

    // An emptied list next to 'available' would read as "the robot has no services".
    expect(heard.at(-1)).toEqual({ state: 'unknown' });
  });
});
