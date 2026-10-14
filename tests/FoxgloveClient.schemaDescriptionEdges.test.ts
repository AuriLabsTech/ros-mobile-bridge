// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * Edges of how the client reads what a server says about a type: a schema
 * field that is missing, one that cannot be parsed, a channel that does not
 * label its schema encoding, and a service request that is not an object.
 *
 * Each case is one a real server or caller can produce, and in each the wrong
 * reading is quiet: an empty object where data was lost, raw bytes where a
 * value was expected, or a request sent as empty that the caller did not
 * mean as empty.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import type { RosMessage } from '../src/types';
import {
  installMockWebSocket,
  foxgloveMessageDataFrame,
  findSentServiceCallRequest,
  foxgloveServiceCallResponseFrame,
  type MockWebSocketHandle,
  type MockWebSocket,
} from './_helpers/mock-websocket';

/** The shortest CDR serialization of a fieldless type, as this library writes it. */
const EMPTY_CDR = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x00]);

describe('FoxgloveClient — schema description edges', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  async function connectAdvertising(
    channels: Array<Record<string, unknown>>,
    services: Array<Record<string, unknown>> = [],
  ): Promise<{ client: FoxgloveClient; socket: MockWebSocket }> {
    const client = new FoxgloveClient();
    const promise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(JSON.stringify({ op: 'advertise', channels }));
    socket.simulateMessage(JSON.stringify({ op: 'advertiseServices', services }));
    await promise;
    return { client, socket };
  }

  it('reads a CDR channel advertised with no schema field as a type with no fields', async () => {
    // Foxglove WS v1 requires `schema`, but a server that omits it has said
    // no more than an empty one does.
    const { client, socket } = await connectAdvertising([
      { id: 7, topic: '/heartbeat', encoding: 'cdr', schemaName: 'std_msgs/msg/Empty' },
    ]);
    const received: RosMessage[] = [];
    client.subscribe('/heartbeat', (m) => received.push(m));
    const op = socket.sentJson.find((m) => m.op === 'subscribe');
    const subId = (op?.subscriptions as Array<{ id: number }>)[0]!.id;

    socket.simulateMessage(foxgloveMessageDataFrame(subId, 0n, EMPTY_CDR));

    expect(received.map((m) => m.data)).toEqual([{}]);
  });

  it('builds a template from ros2msg text on a CDR channel that does not label its schema encoding', async () => {
    // Only a `protobuf` message encoding makes an unlabelled schema a protobuf
    // descriptor; anything else is read as text.
    const { client } = await connectAdvertising([
      {
        id: 7,
        topic: '/cmd_vel_stamped',
        encoding: 'cdr',
        schemaName: 'pkg/msg/Speed',
        schema: 'float64 linear\nstring frame\n',
      },
    ]);

    expect(client.getSchemaTemplate('pkg/msg/Speed')).toEqual({ linear: 0, frame: '' });
  });

  it('rejects with the bytes, not an empty object, when the advertised response schema cannot be parsed', async () => {
    // An unreadable description is not a description of an empty type. The
    // bytes here happen to be a valid fieldless message, which is exactly the
    // case where answering `{}` would look right and be a guess.
    const { client, socket } = await connectAdvertising(
      [],
      [
        {
          id: 41,
          name: '/reset',
          type: 'pkg/srv/Reset',
          response: {
            encoding: 'cdr',
            schemaName: 'pkg/srv/Reset_Response',
            schema: 'not a schema !!',
          },
        },
      ],
    );
    const call = client.callService('/reset', {});
    const sent = findSentServiceCallRequest(socket)!;
    socket.simulateMessage(foxgloveServiceCallResponseFrame(41, sent.callId, 'cdr', EMPTY_CDR));

    await expect(call).rejects.toMatchObject({
      name: 'ServiceResponseDecodeError',
      reason: 'no-schema',
      bytes: EMPTY_CDR,
    });
  });

  it.each([
    ['an array', []],
    ['a number', 42],
  ])(
    'does not send %s as an empty request to a service with no schema',
    async (_label, request) => {
      const { client, socket } = await connectAdvertising(
        [],
        [{ id: 11, name: '/trigger', type: 'std_srvs/srv/Trigger' }],
      );

      // Cast through unknown: the signature takes an object, and this pins what
      // happens at runtime when a JavaScript caller passes something else.
      const call = client.callService('/trigger', request as unknown as Record<string, unknown>);

      await expect(call).rejects.toThrow(/Cannot encode a non-empty CDR request/);
      expect(findSentServiceCallRequest(socket)).toBeNull();
    },
  );

  it('sends an undefined request as the empty request, like `{}` and `null`', async () => {
    const { client, socket } = await connectAdvertising(
      [],
      [{ id: 11, name: '/trigger', type: 'std_srvs/srv/Trigger' }],
    );

    const call = client.callService('/trigger', undefined as unknown as Record<string, unknown>);
    call.catch(() => {}); // only the wire side is inspected

    expect(Array.from(findSentServiceCallRequest(socket)!.payload)).toEqual(Array.from(EMPTY_CDR));
  });
});
