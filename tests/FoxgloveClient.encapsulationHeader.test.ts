// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * A CDR payload whose encapsulation header names a representation the
 * library does not read, as seen through the Foxglove client.
 *
 * `@foxglove/cdr` reads the parameter-list and delimited kinds, and ids it
 * does not know, into wrong values without an error, so the shared codec
 * refuses them (`tests/cdrPayload.test.ts` covers the codec alone). Here the
 * client's two promises are pinned: a topic delivers the raw bytes and says
 * so once, and a service call rejects as `'malformed'` naming the header.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import { ServiceResponseDecodeError } from '../src';
import type { RosMessage } from '../src/types';
import {
  installMockWebSocket,
  foxgloveMessageDataFrame,
  findSentServiceCallRequest,
  foxgloveServiceCallResponseFrame,
  type MockWebSocketHandle,
} from './_helpers/mock-websocket';

/**
 * `uint8 data` = 42 behind a parameter-list little-endian header (`00 03`).
 * Read as plain CDR it would decode to `{ data: 42 }`, which is exactly the
 * silent misreading the refusal exists to stop.
 */
const PARAMETER_LIST_PAYLOAD = new Uint8Array([0x00, 0x03, 0x00, 0x00, 42]);

describe('FoxgloveClient — a topic whose payload has a refused header', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  async function subscribeAndDeliver(count: number): Promise<{
    received: RosMessage[];
    warn: ReturnType<typeof vi.fn>;
  }> {
    const warn = vi.fn();
    const client = new FoxgloveClient({ logger: { log: vi.fn(), warn, error: vi.fn() } });
    const connected = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertise',
        channels: [
          {
            id: 7,
            topic: '/level',
            encoding: 'cdr',
            schemaName: 'std_msgs/msg/UInt8',
            schema: 'uint8 data\n',
          },
        ],
      }),
    );
    await connected;

    const received: RosMessage[] = [];
    client.subscribe('/level', (m) => received.push(m), { maxFrequency: 0, disableAdaptive: true });
    const op = socket.sentJson.find((m) => m.op === 'subscribe');
    const subId = (op?.subscriptions as Array<{ id: number }> | undefined)?.[0]?.id;
    if (subId === undefined) throw new Error('client sent no subscription');
    for (let i = 0; i < count; i++) {
      socket.simulateMessage(foxgloveMessageDataFrame(subId, 0n, PARAMETER_LIST_PAYLOAD));
    }
    return { received, warn };
  }

  it('delivers the raw bytes and warns naming the topic and the header', async () => {
    const { received, warn } = await subscribeAndDeliver(1);
    expect(received).toHaveLength(1);
    expect(received[0]!.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(received[0]!.data as Uint8Array)).toEqual(Array.from(PARAMETER_LIST_PAYLOAD));
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain('/level');
    expect(line).toContain('00 03');
  });

  it('warns once per channel, not once per message', async () => {
    const { received, warn } = await subscribeAndDeliver(5);
    expect(received).toHaveLength(5);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('FoxgloveClient — a service response with a refused header', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  it('rejects as malformed, naming the header bytes', async () => {
    const client = new FoxgloveClient();
    const connected = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [] }));
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertiseServices',
        services: [
          {
            id: 44,
            name: '/level',
            type: 'some_pkg/srv/Level',
            response: {
              encoding: 'cdr',
              schemaName: 'some_pkg/srv/Level_Response',
              schema: 'uint8 data\n',
            },
          },
        ],
      }),
    );
    await connected;

    const call = client.callService('/level', {});
    call.catch(() => {});
    const sent = findSentServiceCallRequest(socket);
    if (!sent) throw new Error('client sent no service call request');
    socket.simulateMessage(
      foxgloveServiceCallResponseFrame(44, sent.callId, 'cdr', PARAMETER_LIST_PAYLOAD),
    );

    const err = await call.then(
      () => {
        throw new Error('expected the call to reject');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ServiceResponseDecodeError);
    const decodeErr = err as ServiceResponseDecodeError;
    expect(decodeErr.reason).toBe('malformed');
    expect(decodeErr.message).toContain('00 03');
    expect(Array.from(decodeErr.bytes)).toEqual(Array.from(PARAMETER_LIST_PAYLOAD));
  });
});
