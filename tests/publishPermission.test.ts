// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * `getPublishPermission()` (ADR 0022): whether the server accepts publishing
 * from this client. Foxglove WebSocket says so through the `clientPublish`
 * capability in `serverInfo`; rosbridge has no server-wide signal, so it
 * answers `'unknown'` rather than guess.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import { RosbridgeClient } from '../src/RosbridgeClient';
import { installMockWebSocket, type MockWebSocketHandle } from './_helpers/mock-websocket';

describe('getPublishPermission', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    vi.useFakeTimers();
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
    vi.useRealTimers();
  });

  async function foxgloveConnect(client: FoxgloveClient, capabilities: string[]): Promise<void> {
    const promise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.sdk.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: '', capabilities }));
    socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [] }));
    await promise;
  }

  it("Foxglove: 'unknown' before the first handshake", () => {
    expect(new FoxgloveClient().getPublishPermission()).toBe('unknown');
  });

  it("Foxglove: 'allowed' when serverInfo lists clientPublish", async () => {
    const client = new FoxgloveClient();
    await foxgloveConnect(client, ['clientPublish', 'connectionGraph']);
    expect(client.getPublishPermission()).toBe('allowed');
  });

  it("Foxglove: 'refused' when serverInfo leaves clientPublish out", async () => {
    const client = new FoxgloveClient();
    await foxgloveConnect(client, ['connectionGraph', 'services']);
    expect(client.getPublishPermission()).toBe('refused');
  });

  it("Foxglove: back to 'unknown' after disconnect, and re-read on reconnect", async () => {
    const client = new FoxgloveClient();
    await foxgloveConnect(client, ['clientPublish']);
    await client.disconnect();
    expect(client.getPublishPermission()).toBe('unknown');

    await foxgloveConnect(client, []);
    expect(client.getPublishPermission()).toBe('refused');
  });

  it("Foxglove: is already readable when onStatusChange reports 'connected'", async () => {
    const client = new FoxgloveClient();
    const seen: string[] = [];
    client.onStatusChange((s) => {
      if (s === 'connected') seen.push(client.getPublishPermission());
    });
    await foxgloveConnect(client, []);
    expect(seen).toEqual(['refused']);
  });

  it("rosbridge: 'unknown' before, during and after a connection", async () => {
    const client = new RosbridgeClient();
    expect(client.getPublishPermission()).toBe('unknown');
    const promise = client.connect('ws://localhost:9090');
    ws.last().simulateOpen();
    await promise;
    expect(client.getPublishPermission()).toBe('unknown');
  });
});
