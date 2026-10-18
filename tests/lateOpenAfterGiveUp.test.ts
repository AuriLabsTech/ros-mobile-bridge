import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import { RosbridgeClient } from '../src/RosbridgeClient';
import type { ConnectionStatus } from '../src/types';
import {
  installMockWebSocket,
  MockWebSocket,
  withFakeTimers,
  type MockWebSocketHandle,
} from './_helpers/mock-websocket';

// A socket the client gave up on while it was still connecting must not stay
// open if the server answers later. On React Native for Android, close() before
// open does nothing and the open still arrives, so the client has to close it
// then.

const clients = [
  {
    name: 'FoxgloveClient',
    make: () => new FoxgloveClient(),
    url: 'ws://localhost:8765',
    handshake: (socket: MockWebSocket) => {
      socket.simulateOpen('foxglove.websocket.v1');
      socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
      socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [] }));
    },
  },
  {
    name: 'RosbridgeClient',
    make: () => new RosbridgeClient(),
    url: 'ws://localhost:9090',
    handshake: (socket: MockWebSocket) => socket.simulateOpen(),
  },
] as const;

describe.each(clients)(
  '$name closes a socket that opens after the attempt was given up',
  ({ make, url, handshake }) => {
    let ws: MockWebSocketHandle;

    beforeEach(() => {
      ws = installMockWebSocket();
    });

    afterEach(() => {
      ws.restore();
    });

    it('after the connection timeout', async () => {
      await withFakeTimers(async () => {
        const client = make();
        const statuses: ConnectionStatus[] = [];
        client.onStatusChange((s) => statuses.push(s));
        const promise = client.connect(url);
        promise.catch(() => {});
        const socket = ws.last();
        socket.ignoresCloseWhileConnecting = true;

        vi.advanceTimersByTime(10_000);
        await expect(promise).rejects.toThrow();

        socket.simulateOpen();

        expect(socket.readyState).toBe(MockWebSocket.CLOSED);
        expect(statuses).not.toContain('connected');
        await client.disconnect();
      });
    });

    it('after a timed-out automatic reconnect, without touching the next connection', async () => {
      await withFakeTimers(async () => {
        const client = make();
        const connected = client.connect(url);
        const first = ws.last();
        handshake(first);
        await connected;

        first.simulateClose(1006, 'gone');
        await vi.advanceTimersByTimeAsync(5_000);
        const abandoned = ws.last();
        expect(abandoned).not.toBe(first);
        abandoned.ignoresCloseWhileConnecting = true;

        // The reconnect attempt times out; the client gives it up and retries.
        await vi.advanceTimersByTimeAsync(10_000);
        await vi.advanceTimersByTimeAsync(30_000);
        const next = ws.last();
        expect(next).not.toBe(abandoned);
        handshake(next);
        await vi.advanceTimersByTimeAsync(0);
        expect(client.isConnected).toBe(true);

        abandoned.simulateOpen();

        expect(abandoned.readyState).toBe(MockWebSocket.CLOSED);
        expect(next.readyState).toBe(MockWebSocket.OPEN);
        expect(client.isConnected).toBe(true);
        // An open connection's disconnect() waits on the server up to 2 s.
        const closed = client.disconnect();
        await vi.advanceTimersByTimeAsync(3_000);
        await closed;
      });
    });

    it('without throwing from the open event when that close throws', async () => {
      const client = make();
      const promise = client.connect(url);
      const socket = ws.last();
      socket.ignoresCloseWhileConnecting = true;

      await client.disconnect();
      await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
      socket.close = () => {
        throw new Error('close failed');
      };

      expect(() => socket.simulateOpen()).not.toThrow();
    });

    it('after the connect signal aborts', async () => {
      const client = make();
      const controller = new AbortController();
      const promise = client.connect(url, { signal: controller.signal });
      const socket = ws.last();
      socket.ignoresCloseWhileConnecting = true;

      controller.abort();
      await expect(promise).rejects.toMatchObject({ name: 'AbortError' });

      socket.simulateOpen();

      expect(socket.readyState).toBe(MockWebSocket.CLOSED);
      expect(client.isConnected).toBe(false);
    });

    it('after disconnect() while connecting', async () => {
      const client = make();
      const promise = client.connect(url);
      const socket = ws.last();
      socket.ignoresCloseWhileConnecting = true;

      await client.disconnect();
      await expect(promise).rejects.toMatchObject({ name: 'AbortError' });

      socket.simulateOpen();

      expect(socket.readyState).toBe(MockWebSocket.CLOSED);
      expect(client.isConnected).toBe(false);
    });
  },
);
