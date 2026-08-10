import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import { RosbridgeClient } from '../src/RosbridgeClient';
import {
  installMockWebSocket,
  withFakeTimers,
  type MockWebSocketHandle,
} from './_helpers/mock-websocket';

describe('RosbridgeClient callService per-call timeout', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });

  afterEach(() => {
    ws.restore();
  });

  async function connectedClient(): Promise<{
    client: RosbridgeClient;
    socket: ReturnType<MockWebSocketHandle['last']>;
  }> {
    const client = new RosbridgeClient();
    const promise = client.connect('ws://localhost:9090');
    const socket = ws.last();
    socket.simulateOpen();
    await promise;
    return { client, socket };
  }

  it('forwards timeoutMs as the wire `timeout` field in seconds; omits the field without it', async () => {
    const { client, socket } = await connectedClient();

    void client.callService('/with/timeout', {}, { timeoutMs: 2000 });
    void client.callService('/without/timeout', {});

    const withTimeout = socket.sentJson.find(
      (m) => m.op === 'call_service' && m.service === '/with/timeout',
    );
    const withoutTimeout = socket.sentJson.find(
      (m) => m.op === 'call_service' && m.service === '/without/timeout',
    );

    // The protocol's `timeout` is seconds (float); the API takes milliseconds.
    expect(withTimeout?.timeout).toBe(2);
    // Omitting the option preserves the pre-0.1.10 wire frame exactly.
    expect(withoutTimeout && 'timeout' in withoutTimeout).toBe(false);
  });

  it('arms a local backstop after the wire deadline plus a margin when no frame ever arrives', async () => {
    await withFakeTimers(async () => {
      const { client } = await connectedClient();

      let rejection: Error | null = null;
      const call = client
        .callService('/glob/dropped', {}, { timeoutMs: 2000 })
        .catch((e: Error) => {
          rejection = e;
        });

      // Past the wire deadline (where the server's reasoned frame would land
      // 20-40 ms later) the backstop must NOT have fired yet: a same-deadline
      // local timer would eat the server's reason.
      vi.advanceTimersByTime(2400);
      await Promise.resolve();
      expect(rejection).toBeNull();

      // Well past the margin: no frame is ever coming (services_glob drop),
      // so the backstop rejects — long before the 30 s default.
      vi.advanceTimersByTime(2000);
      await call;
      expect(rejection).not.toBeNull();
      expect((rejection as unknown as Error).message).toContain('no response frame');
    });
  });

  it("lets the server's late reasoned failure win over the local backstop", async () => {
    await withFakeTimers(async () => {
      const { client, socket } = await connectedClient();

      let rejection: Error | null = null;
      const call = client
        .callService('/slow/service', {}, { timeoutMs: 1000 })
        .catch((e: Error) => {
          rejection = e;
        });
      const id = socket.sentJson.find(
        (m) => m.op === 'call_service' && m.service === '/slow/service',
      )?.id as string;

      // The measured server behavior: its failure frame lands 20-40 ms after
      // its nominal deadline. The backstop margin must leave room for it.
      vi.advanceTimersByTime(1030);
      socket.simulateMessage(
        JSON.stringify({
          op: 'service_response',
          id,
          result: false,
          values: 'Timeout exceeded while waiting for service response',
        }),
      );

      await call;
      expect((rejection as unknown as Error).message).toBe(
        'Timeout exceeded while waiting for service response',
      );
    });
  });

  it('throws synchronously on timeoutMs of zero or below, and never sends the frame', async () => {
    const { client, socket } = await connectedClient();
    const framesBefore = socket.sentJson.filter((m) => m.op === 'call_service').length;

    // Wire `timeout: 0` means an unbounded server-side wait whose worker
    // survives the client's disconnect; it must never be forwarded.
    expect(() => client.callService('/s', {}, { timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(() => client.callService('/s', {}, { timeoutMs: -5 })).toThrow(/timeoutMs/);
    expect(() => client.callService('/s', {}, { timeoutMs: Number.NaN })).toThrow(/timeoutMs/);

    const framesAfter = socket.sentJson.filter((m) => m.op === 'call_service').length;
    expect(framesAfter).toBe(framesBefore);
  });
});

describe('FoxgloveClient callService per-call timeout', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });

  afterEach(() => {
    ws.restore();
  });

  async function connectedClient(): Promise<{
    client: FoxgloveClient;
    socket: ReturnType<MockWebSocketHandle['last']>;
  }> {
    const client = new FoxgloveClient();
    const connectPromise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [] }));
    // A service with no advertised schema: an empty request still dispatches
    // via the CDR encapsulation-header fallback, which is all a timeout test
    // needs on the wire.
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertiseServices',
        services: [{ id: 3, name: '/svc', type: 'my_msgs/srv/Thing' }],
      }),
    );
    await connectPromise;
    return { client, socket };
  }

  it('timeoutMs governs the local timer directly (no wire-level equivalent exists)', async () => {
    await withFakeTimers(async () => {
      const { client } = await connectedClient();

      let rejection: Error | null = null;
      const call = client.callService('/svc', {}, { timeoutMs: 500 }).catch((e: Error) => {
        rejection = e;
      });

      vi.advanceTimersByTime(499);
      await Promise.resolve();
      expect(rejection).toBeNull();

      vi.advanceTimersByTime(2);
      await call;
      expect(rejection).not.toBeNull();
      expect((rejection as unknown as Error).message).toContain('timed out after 500ms');
    });
  });

  it('throws synchronously on timeoutMs of zero or below, and sends no frame', async () => {
    const { client, socket } = await connectedClient();
    const framesBefore = socket.sentMessages.length;

    expect(() => client.callService('/svc', {}, { timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(() => client.callService('/svc', {}, { timeoutMs: -1 })).toThrow(/timeoutMs/);

    expect(socket.sentMessages.length).toBe(framesBefore);
  });
});
