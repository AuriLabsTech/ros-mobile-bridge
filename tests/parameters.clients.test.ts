// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * How each client feeds the shared parameter surface its service list
 * (ADR 0021 decision 7). Foxglove holds the list the bridge pushes, which
 * arrives after connect() resolves; rosbridge reads /rosapi/services fresh.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import { RosbridgeClient } from '../src/RosbridgeClient';
import { installMockWebSocket, type MockWebSocketHandle } from './_helpers/mock-websocket';

type Socket = ReturnType<MockWebSocketHandle['last']>;

describe('parameter service lists', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });

  afterEach(() => {
    vi.useRealTimers();
    ws.restore();
  });

  async function foxglove(
    capabilities: string[],
  ): Promise<{ client: FoxgloveClient; socket: Socket }> {
    const client = new FoxgloveClient();
    const promise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities }));
    socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [] }));
    await promise;
    return { client, socket };
  }

  function advertiseServices(socket: Socket, names: string[]): void {
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertiseServices',
        services: names.map((name, i) => ({
          id: i + 1,
          name,
          type: 'rcl_interfaces/srv/ListParameters',
        })),
      }),
    );
  }

  it('Foxglove: a call made right after connect waits for the first service list', async () => {
    const { client, socket } = await foxglove(['services']);
    const nodes = client.getParameterNodes();
    advertiseServices(socket, ['/b/list_parameters', '/a/list_parameters', '/a/get_parameters']);
    await expect(nodes).resolves.toEqual(['/a', '/b']);
    await client.disconnect();
  });

  it('Foxglove: a bridge that offers services but never lists any is waited for, then read as is', async () => {
    vi.useFakeTimers();
    const { client } = await foxglove(['services']);
    const nodes = client.getParameterNodes();
    let settled = false;
    void nodes.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(1_900);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await expect(nodes).resolves.toEqual([]);
    // The wait is once per connection: the next call reads at once.
    let again = false;
    void client.getParameterNodes().then(() => (again = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(again).toBe(true);
    await client.disconnect();
  });

  it('Foxglove: a bridge without the services capability is discovery-unavailable', async () => {
    const { client } = await foxglove([]);
    await expect(client.getParameterNodes()).rejects.toMatchObject({
      name: 'ParameterServiceError',
      reason: 'discovery-unavailable',
    });
    await client.disconnect();
  });

  it('Foxglove: a disconnect releases a waiting call', async () => {
    const { client } = await foxglove(['services']);
    const nodes = client.getParameterNodes();
    await client.disconnect();
    await expect(nodes).rejects.toThrow('Not connected');
  });

  async function rosbridge(): Promise<{ client: RosbridgeClient; socket: Socket }> {
    const client = new RosbridgeClient();
    const promise = client.connect('ws://localhost:9090');
    const socket = ws.last();
    socket.simulateOpen();
    await promise;
    return { client, socket };
  }

  /** Answer the newest /rosapi/services call on `socket`. */
  function answerServices(socket: Socket, reply: { result: boolean; values: unknown }): void {
    const calls = socket.sentJson.filter(
      (m) => m.op === 'call_service' && m.service === '/rosapi/services',
    );
    const id = (calls[calls.length - 1] as { id: string }).id;
    socket.simulateMessage(JSON.stringify({ op: 'service_response', id, ...reply }));
  }

  it('rosbridge: reads /rosapi/services fresh, not the poll that is still empty after connect', async () => {
    const { client, socket } = await rosbridge();
    expect(client.getAvailableServices()).toEqual([]);
    const nodes = client.getParameterNodes();
    await Promise.resolve();
    answerServices(socket, {
      result: true,
      values: { services: ['/x/list_parameters', '/rosapi/services'] },
    });
    await expect(nodes).resolves.toEqual(['/x']);
    await client.disconnect();
  });

  it('rosbridge: a failed /rosapi/services read is discovery-unavailable, with the cause kept', async () => {
    const { client, socket } = await rosbridge();
    const nodes = client.getParameterNodes();
    await Promise.resolve();
    answerServices(socket, { result: false, values: 'rosapi is not running' });
    const err = await nodes.catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'ParameterServiceError', reason: 'discovery-unavailable' });
    expect(String((err as { cause: unknown }).cause)).toContain('rosapi is not running');
    await client.disconnect();
  });

  it('rosbridge: a connection lost during the read is not reported as discovery-unavailable', async () => {
    const { client, socket } = await rosbridge();
    const nodes = client.getParameterNodes();
    await Promise.resolve();
    socket.simulateClose(1006, 'gone');
    const err = await nodes.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toMatchObject({ name: 'ParameterServiceError' });
  });
});
