// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * A CDR topic whose schema declares only constants, such as
 * `rcl_interfaces/msg/ParameterType`. The CDR reader cannot be built from
 * such a definition, and the topic's messages have always arrived as raw
 * bytes. They must keep arriving, on both dispatch modes, rather than be
 * lost to an exception thrown out of the receive loop or a drain timer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import type { RosMessage, SubscribeOptions } from '../src/types';
import {
  installMockWebSocket,
  foxgloveMessageDataFrame,
  type MockWebSocketHandle,
} from './_helpers/mock-websocket';

const PAYLOAD = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x00]);

describe('FoxgloveClient — a topic whose schema has only constants', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    vi.useRealTimers();
    ws.restore();
  });

  async function deliver(options: SubscribeOptions, drain: () => void): Promise<RosMessage[]> {
    const client = new FoxgloveClient();
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
            topic: '/parameter_type',
            encoding: 'cdr',
            schemaName: 'rcl_interfaces/msg/ParameterType',
            schema: 'uint8 PARAMETER_NOT_SET=0\nuint8 PARAMETER_BOOL=1\n',
          },
        ],
      }),
    );
    await connected;

    const received: RosMessage[] = [];
    client.subscribe('/parameter_type', (m) => received.push(m), options);
    const op = socket.sentJson.find((m) => m.op === 'subscribe');
    const subId = (op?.subscriptions as Array<{ id: number }> | undefined)?.[0]?.id;
    if (subId === undefined) throw new Error('client sent no subscription');
    socket.simulateMessage(foxgloveMessageDataFrame(subId, 0n, PAYLOAD));
    drain();
    return received;
  }

  it('delivers raw bytes on the immediate path', async () => {
    const received = await deliver({ maxFrequency: 0, disableAdaptive: true }, () => {});
    expect(received).toHaveLength(1);
    expect(received[0]!.data).toBeInstanceOf(Uint8Array);
  });

  it('delivers raw bytes on the latest-only drain', async () => {
    vi.useFakeTimers();
    const received = await deliver(
      { dispatchMode: 'latest-only', maxFrequency: 10, disableAdaptive: true },
      () => vi.advanceTimersByTime(200),
    );
    expect(received).toHaveLength(1);
    expect(received[0]!.data).toBeInstanceOf(Uint8Array);
  });
});
