// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * A service response the client cannot read (ADR 0020).
 *
 * Up to 0.1.15 the Foxglove client resolved something that looked like a
 * response anyway: an invented `{ success: true }` for a payload in an
 * encoding it does not decode or of zero length, and an undocumented
 * `{ rawBytes }` record when it had no schema or the bytes did not fit one.
 * A call that failed on the robot could read as a success. `callService()`
 * now resolves only with a response it decoded, and rejects with
 * `ServiceResponseDecodeError`, carrying the bytes, when the server answered
 * but the answer cannot be read.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import { ServiceResponseDecodeError } from '../src';
import {
  installMockWebSocket,
  findSentServiceCallRequest,
  foxgloveServiceCallResponseFrame,
  type MockWebSocketHandle,
} from './_helpers/mock-websocket';

/** What `rosidl` writes for a response with no fields: header plus the placeholder byte. */
const FIELDLESS_BYTES = new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0]);

describe('FoxgloveClient — a service response the client cannot read', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  /**
   * Advertise one service as `service`, call it by its name, and answer the
   * call with `payload` in `encoding`. `answerAsServiceId` lets a test answer
   * under an id the client never saw advertised.
   */
  async function callAndAnswer(
    service: Record<string, unknown>,
    encoding: string,
    payload: Uint8Array,
    answerAsServiceId = service.id as number,
  ): Promise<unknown> {
    const client = new FoxgloveClient();
    const connectPromise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [] }));
    socket.simulateMessage(JSON.stringify({ op: 'advertiseServices', services: [service] }));
    await connectPromise;

    const call = client.callService(service.name as string, {});
    call.catch(() => {});
    const sent = findSentServiceCallRequest(socket);
    if (!sent) throw new Error('client sent no service call request');
    socket.simulateMessage(
      foxgloveServiceCallResponseFrame(answerAsServiceId, sent.callId, encoding, payload),
    );
    return call;
  }

  async function rejection(promise: Promise<unknown>): Promise<ServiceResponseDecodeError> {
    const err = await promise.then(
      () => {
        throw new Error('expected the call to reject');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ServiceResponseDecodeError);
    return err as ServiceResponseDecodeError;
  }

  it('rejects with the bytes when no schema describes the response', async () => {
    const payload = new Uint8Array([0, 1, 0, 0, 7, 0, 0, 0]);
    const err = await rejection(
      callAndAnswer({ id: 43, name: '/reset', type: 'some_pkg/srv/Unknown' }, 'cdr', payload),
    );
    expect(err.name).toBe('ServiceResponseDecodeError');
    expect(err.reason).toBe('no-schema');
    expect(err.service).toBe('/reset');
    expect(err.encoding).toBe('cdr');
    expect(Array.from(err.bytes)).toEqual([0, 1, 0, 0, 7, 0, 0, 0]);
  });

  /** `std_srvs/srv/Empty`, advertised the way foxglove_bridge describes a fieldless response. */
  const EMPTY_SERVICE = {
    id: 42,
    name: '/reset',
    type: 'std_srvs/srv/Empty',
    response: { encoding: 'cdr', schemaName: 'std_srvs/srv/Empty_Response', schema: '' },
  };

  it('rejects with the bytes when they do not fit the schema', async () => {
    const payload = new Uint8Array([0x00, 0x01, 0x00, 0x00, 9, 9, 9, 9, 9, 9]);
    const err = await rejection(callAndAnswer(EMPTY_SERVICE, 'cdr', payload));
    expect(err.reason).toBe('schema-mismatch');
    expect(err.service).toBe('/reset');
    expect(Array.from(err.bytes)).toEqual([0x00, 0x01, 0x00, 0x00, 9, 9, 9, 9, 9, 9]);
  });

  it('still resolves the empty object for a response with no fields', async () => {
    await expect(callAndAnswer(EMPTY_SERVICE, 'cdr', FIELDLESS_BYTES)).resolves.toEqual({});
  });

  /** A service with a real response schema, so decoding is attempted. */
  const TRIGGER_SERVICE = {
    id: 44,
    name: '/dock',
    type: 'std_srvs/srv/Trigger',
    response: {
      encoding: 'cdr',
      schemaName: 'std_srvs/srv/Trigger_Response',
      schema: 'bool success\nstring message',
    },
  };

  it('rejects an encoding the client does not decode instead of inventing success', async () => {
    // Up to 0.1.15 this resolved `{ success: true }`: a protobuf answer from a
    // Foxglove SDK server read as a successful call, whatever it said.
    const payload = new Uint8Array([0x08, 0x00]);
    const err = await rejection(callAndAnswer(TRIGGER_SERVICE, 'protobuf', payload));
    expect(err.reason).toBe('unsupported-encoding');
    expect(err.service).toBe('/dock');
    expect(err.encoding).toBe('protobuf');
    expect(Array.from(err.bytes)).toEqual([0x08, 0x00]);
  });

  it('rejects a CDR payload the reader cannot parse as malformed', async () => {
    // Header and the bool, then a string length that runs past the end.
    const payload = new Uint8Array([0, 1, 0, 0, 1, 0, 0, 0, 0xff, 0xff, 0, 0]);
    const err = await rejection(callAndAnswer(TRIGGER_SERVICE, 'cdr', payload));
    expect(err.reason).toBe('malformed');
    expect(err.encoding).toBe('cdr');
    expect(Array.from(err.bytes)).toEqual(Array.from(payload));
  });

  it('rejects a JSON payload that does not parse as malformed', async () => {
    const payload = new TextEncoder().encode('{"success": tr');
    const err = await rejection(callAndAnswer(TRIGGER_SERVICE, 'json', payload));
    expect(err.reason).toBe('malformed');
    expect(err.encoding).toBe('json');
  });

  it.each(['null', '42', '[true, "ok"]', '"ok"'])(
    'rejects JSON that parses to %s, which is not a response record, as malformed',
    async (text) => {
      const payload = new TextEncoder().encode(text);
      const err = await rejection(callAndAnswer(TRIGGER_SERVICE, 'json', payload));
      expect(err.reason).toBe('malformed');
    },
  );

  it('hands back the payload alone, not a view into the frame around it', async () => {
    // A consumer decoding `err.bytes.buffer` must not read the frame's
    // opcode, ids and encoding label as the start of the payload.
    const err = await rejection(
      callAndAnswer(TRIGGER_SERVICE, 'protobuf', new Uint8Array([0x08, 0x00])),
    );
    expect(err.bytes.byteOffset).toBe(0);
    expect(err.bytes.buffer.byteLength).toBe(2);
  });

  // A response with no fields still serializes to at least five bytes in CDR,
  // and zero bytes are not JSON, so an empty payload was lost or broken on
  // the way. Up to 0.1.15 it resolved an invented `{ success: true }`.
  it.each(['cdr', 'json'])('rejects a zero-length %s payload as malformed', async (encoding) => {
    const err = await rejection(callAndAnswer(TRIGGER_SERVICE, encoding, new Uint8Array()));
    expect(err.reason).toBe('malformed');
    expect(err.bytes.byteLength).toBe(0);
  });

  it('rejects a zero-length payload in another encoding as unsupported', async () => {
    const err = await rejection(callAndAnswer(TRIGGER_SERVICE, 'protobuf', new Uint8Array()));
    expect(err.reason).toBe('unsupported-encoding');
    expect(err.bytes.byteLength).toBe(0);
  });

  it('rejects an answer under a service id the client never saw as no-schema', async () => {
    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const err = await rejection(callAndAnswer(TRIGGER_SERVICE, 'cdr', payload, 999));
    expect(err.reason).toBe('no-schema');
    expect(err.service).toBe('/dock');
    expect(Array.from(err.bytes)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('tells the reader the server answered, not that the call failed', async () => {
    const err = await rejection(
      callAndAnswer(TRIGGER_SERVICE, 'protobuf', new Uint8Array([0x08, 0x00])),
    );
    expect(err.message).toMatch(/server answered/i);
    expect(err.message).toContain('/dock');
  });
});
