import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import { installMockWebSocket, type MockWebSocketHandle } from './_helpers/mock-websocket';

/**
 * The advertise that completes the handshake carries the first topic list.
 * It must reach `onTopicsChange` like every later advertise does, as the
 * first discovery does on rosbridge; otherwise a picker fed only from the
 * callback stays empty after connect.
 */
describe('FoxgloveClient onTopicsChange', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });

  afterEach(() => {
    ws.restore();
  });

  function channel(id: number, topic: string): Record<string, unknown> {
    return { id, topic, encoding: 'json', schemaName: 'std_msgs/msg/String', schema: '' };
  }

  it('fires for the first topic list, with the client already connected', async () => {
    const client = new FoxgloveClient();
    const seen: Array<{ topics: string[]; connected: boolean }> = [];
    client.onTopicsChange((t) =>
      seen.push({ topics: t.map((x) => x.topic), connected: client.isConnected }),
    );

    const connected = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [channel(1, '/a')] }));
    await connected;

    expect(seen).toEqual([{ topics: ['/a'], connected: true }]);
  });

  it('keeps firing for advertises after the handshake', async () => {
    const client = new FoxgloveClient();
    const seen: string[][] = [];
    client.onTopicsChange((t) => seen.push(t.map((x) => x.topic)));

    const connected = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [channel(1, '/a')] }));
    await connected;
    socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [channel(2, '/b')] }));

    expect(seen).toEqual([['/a'], ['/a', '/b']]);
  });

  it('fires again for the first list after an automatic reconnect', async () => {
    vi.useFakeTimers();
    try {
      const client = new FoxgloveClient();
      const seen: string[][] = [];
      client.onTopicsChange((t) => seen.push(t.map((x) => x.topic)));

      const connected = client.connect('ws://localhost:8765');
      const socket = ws.last();
      socket.simulateOpen('foxglove.websocket.v1');
      socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
      socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [channel(1, '/a')] }));
      await connected;

      socket.simulateClose(1006, 'gone');
      await vi.advanceTimersByTimeAsync(20_000);
      const socket2 = ws.last();
      expect(socket2).not.toBe(socket);
      socket2.simulateOpen('foxglove.websocket.v1');
      socket2.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
      socket2.simulateMessage(JSON.stringify({ op: 'advertise', channels: [channel(7, '/c')] }));

      expect(client.isConnected).toBe(true);
      expect(seen).toEqual([['/a'], ['/c']]);
      await client.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it('survives a listener that disconnects from inside the first-list call', async () => {
    const client = new FoxgloveClient();
    client.onTopicsChange(() => {
      void client.disconnect();
    });

    const connected = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    expect(() =>
      socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [channel(1, '/a')] })),
    ).not.toThrow();
    await expect(connected).resolves.toBeUndefined();
    expect(client.isConnected).toBe(false);
  });
});
