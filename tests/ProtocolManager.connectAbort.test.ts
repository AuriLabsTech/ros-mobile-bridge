import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProtocolManager } from '../src/ProtocolManager';
import { installMockWebSocket, type MockWebSocketHandle } from './_helpers/mock-websocket';

describe('ProtocolManager connect abort (ADR 0003)', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });

  afterEach(() => {
    ws.restore();
  });

  it('forwards ConnectOptions to the client: aborting mid-attempt rejects and stores no client', async () => {
    const manager = new ProtocolManager();
    const controller = new AbortController();

    const promise = manager.connect(
      { protocol: 'rosbridge', host: 'localhost' },
      { signal: controller.signal },
    );
    expect(ws.getInstances().length).toBe(1); // attempt reached the wire

    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(manager.getClient()).toBeNull();
  });

  it('checks the signal before any side effect: a pre-aborted call leaves the active client connected', async () => {
    const manager = new ProtocolManager();
    const first = manager.connect({ protocol: 'rosbridge', host: 'localhost' });
    ws.last().simulateOpen();
    const clientA = await first;
    expect(clientA.isConnected).toBe(true);

    const controller = new AbortController();
    controller.abort();

    await expect(
      manager.connect({ protocol: 'rosbridge', host: 'otherhost' }, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    // The pre-aborted call must not have torn down the live connection or
    // opened a new socket.
    expect(manager.getClient()).toBe(clientA);
    expect(clientA.isConnected).toBe(true);
    expect(ws.getInstances().length).toBe(1);

    await manager.disconnect();
  });
});
