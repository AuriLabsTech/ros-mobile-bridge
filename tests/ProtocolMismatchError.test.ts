// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * ProtocolMismatchError, both directions:
 *   - rosbridge client pointed at a Foxglove server: detected post-connect from
 *     a Foxglove-only frame, surfaced via status -> 'error' + getLastError().
 *   - Foxglove client pointed at a non-Foxglove endpoint: the serverInfo-wait
 *     timeout rejects connect() with the typed error (detected 'unknown').
 *
 * The error is a public export and a consumer contract: the carrier
 * fields (detectedProtocol / expectedProtocol) and the instanceof check are
 * what a consumer branches on in its connection UI.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RosbridgeClient } from '../src/RosbridgeClient';
import { FoxgloveClient } from '../src/FoxgloveClient';
import { ProtocolMismatchError } from '../src/index';
import {
  installMockWebSocket,
  withFakeTimers,
  type MockWebSocketHandle,
} from './_helpers/mock-websocket';

describe('ProtocolMismatchError — rosbridge pointed at a Foxglove server', () => {
  let ws: MockWebSocketHandle;
  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  async function connectedRosbridge(): Promise<{
    client: RosbridgeClient;
    socket: ReturnType<MockWebSocketHandle['last']>;
    statuses: string[];
  }> {
    const client = new RosbridgeClient();
    const statuses: string[] = [];
    client.onStatusChange((s) => statuses.push(s));
    const p = client.connect('ws://localhost:9090');
    const socket = ws.last();
    socket.simulateOpen();
    await p;
    return { client, socket, statuses };
  }

  it('detects the mismatch from an unsolicited serverInfo frame', async () => {
    const { client, socket, statuses } = await connectedRosbridge();
    // A Foxglove server greets with serverInfo; a rosbridge server never does.
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'foxglove', capabilities: [] }));

    expect(statuses[statuses.length - 1]).toBe('error');
    const err = client.getLastError();
    expect(err).toBeInstanceOf(ProtocolMismatchError);
    const mismatch = err as ProtocolMismatchError;
    expect(mismatch.detectedProtocol).toBe('foxglove-ws');
    expect(mismatch.expectedProtocol).toBe('rosbridge');
    expect(mismatch.message).toMatch(/Foxglove WebSocket server/);
  });

  it('detects the mismatch from an advertise frame carrying a channels array', async () => {
    const { client, socket } = await connectedRosbridge();
    socket.simulateMessage(
      JSON.stringify({ op: 'advertise', channels: [{ id: 1, topic: '/x', encoding: 'json' }] }),
    );
    expect(client.getLastError()).toBeInstanceOf(ProtocolMismatchError);
  });

  it('exposes getLastError() from inside the onStatusChange("error") callback (consumer contract)', async () => {
    // A consumer reads client.getLastError() the instant status hits 'error'
    // and renders the ProtocolMismatchError message. Pin that exact consumption.
    const client = new RosbridgeClient();
    let seenAtError: Error | null | undefined;
    client.onStatusChange((s) => {
      if (s === 'error') seenAtError = client.getLastError();
    });
    const p = client.connect('ws://localhost:9090');
    const socket = ws.last();
    socket.simulateOpen();
    await p;

    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'fg' }));
    expect(seenAtError).toBeInstanceOf(ProtocolMismatchError);
  });

  it('emits the terminal error status even if teardown/logging throws during detection', async () => {
    // Root cause: the mismatch handler runs inside handleMessage's
    // try/catch. If any step after detection throws (on the real socket the
    // device logs showed the socket closing, i.e. cleanup ran, yet no status
    // reached the consumer), the status emission must NOT be swallowed. Model a
    // throw in the raise path with a logger that throws once, and require the
    // consumer to still receive 'error' with a readable ProtocolMismatchError.
    // A fully hostile logger: every method throws. Neither the connection
    // handshake nor the mismatch emission may be broken by it.
    const throwingLogger = {
      log: () => {
        throw new Error('logger.log blew up');
      },
      warn: () => {
        throw new Error('logger.warn blew up');
      },
      error: () => {
        throw new Error('logger.error blew up');
      },
    };
    const client = new RosbridgeClient({ logger: throwingLogger });
    const statuses: string[] = [];
    let errAtError: Error | null | undefined;
    client.onStatusChange((s) => {
      statuses.push(s);
      if (s === 'error') errAtError = client.getLastError();
    });

    const p = client.connect('ws://localhost:9090');
    const socket = ws.last();
    socket.simulateOpen();
    await p;

    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'fg' }));

    expect(statuses[statuses.length - 1]).toBe('error');
    expect(errAtError).toBeInstanceOf(ProtocolMismatchError);
  });

  it('does not auto-reconnect into the same mismatch (no new socket)', async () => {
    await withFakeTimers(async () => {
      const client = new RosbridgeClient();
      const p = client.connect('ws://localhost:9090');
      const socket = ws.last();
      socket.simulateOpen();
      await p;
      const socketsBefore = ws.getInstances().length;

      socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'fg', capabilities: [] }));
      // Let any reconnect backoff fire; there must be no new connection attempt.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(ws.getInstances().length).toBe(socketsBefore);
    });
  });

  it('does not false-positive on a non-Foxglove frame (channels-less advertise stays connected)', async () => {
    const { client, socket, statuses } = await connectedRosbridge();
    // A bare advertise with no channels array is not a Foxglove tell; ignore it.
    socket.simulateMessage(JSON.stringify({ op: 'advertise', topic: '/x', type: 'std_msgs/msg/String' }));
    socket.simulateMessage(JSON.stringify({ op: 'some_future_op' }));

    expect(statuses[statuses.length - 1]).toBe('connected');
    expect(client.getLastError()).toBeNull();
  });
});

describe('ProtocolMismatchError — Foxglove pointed at a non-Foxglove endpoint', () => {
  let ws: MockWebSocketHandle;
  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  it('rejects connect() with the typed error when no serverInfo arrives before the timeout', async () => {
    await withFakeTimers(async () => {
      const client = new FoxgloveClient();
      const p = client.connect('ws://localhost:8765');
      const rejection = p.catch((e: unknown) => e);

      const socket = ws.last();
      socket.simulateOpen('foxglove.websocket.v1'); // WS opens, but no serverInfo follows
      await vi.advanceTimersByTimeAsync(10_000); // CONNECTION_TIMEOUT_MS

      const err = await rejection;
      expect(err).toBeInstanceOf(ProtocolMismatchError);
      const mismatch = err as ProtocolMismatchError;
      expect(mismatch.expectedProtocol).toBe('foxglove-ws');
      expect(mismatch.detectedProtocol).toBe('unknown');
      // Same error is also retrievable via getLastError().
      expect(client.getLastError()).toBe(err);
    });
  });

  it('still reports a plain timeout (not a mismatch) when the socket never opens', async () => {
    await withFakeTimers(async () => {
      const client = new FoxgloveClient();
      const p = client.connect('ws://localhost:8765');
      const rejection = p.catch((e: unknown) => e);
      // Do NOT simulateOpen: the socket stays CONNECTING.
      await vi.advanceTimersByTimeAsync(10_000);

      const err = await rejection;
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(ProtocolMismatchError);
    });
  });
});
