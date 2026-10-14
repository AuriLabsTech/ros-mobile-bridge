// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * Where a service response's definition comes from, and what the consumer
 * sees when it comes from nowhere.
 *
 * The advertised text may be ROS 2 IDL rather than `.msg`, with or without a
 * `schemaEncoding` hint; the legacy flat fields carry their own per-side
 * hints; an advertised schema the client cannot parse is reported through the
 * logger before the client falls back to the built-in bundle; and a fieldless
 * description can arrive in either the nested or the flat form. The decode
 * error a consumer catches names its encoding and, where there is one, says
 * why in words.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseRos2idl } from '@foxglove/ros2idl-parser';
import { MessageWriter } from '@foxglove/rosmsg2-serialization';
import { FoxgloveClient } from '../src/FoxgloveClient';
import { ServiceResponseDecodeError } from '../src';
import type { ProtocolLogger } from '../src/types';
import {
  installMockWebSocket,
  findSentServiceCallRequest,
  foxgloveServiceCallResponseFrame,
  type MockWebSocketHandle,
} from './_helpers/mock-websocket';

/** `std_srvs/srv/Trigger_Response` written as ROS 2 IDL, the way an IDL-native bridge sends it. */
const TRIGGER_RESPONSE_IDL = [
  'module std_srvs {',
  '  module srv {',
  '    struct Trigger_Response {',
  '      boolean success;',
  '      string message;',
  '    };',
  '  };',
  '};',
].join('\n');

/** Neither parser accepts this: not `.msg`, and an IDL module with nothing in it. */
const UNPARSEABLE = 'module broken { };';

/** What `rosidl` writes for a response with no fields: header plus the placeholder byte. */
const FIELDLESS_BYTES = new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0]);

describe('FoxgloveClient — where a service response definition comes from', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  function spyLogger(): ProtocolLogger & { warn: ReturnType<typeof vi.fn> } {
    return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  }

  /**
   * Advertise `service`, call it with an empty request, and answer with
   * `payload`. Resolves or rejects as the client's `callService` does.
   */
  async function callAndAnswer(
    service: Record<string, unknown>,
    payload: Uint8Array,
    options: { encoding?: string; logger?: ProtocolLogger } = {},
  ): Promise<Record<string, unknown>> {
    const client = new FoxgloveClient(options.logger ? { logger: options.logger } : undefined);
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
      foxgloveServiceCallResponseFrame(
        service.id as number,
        sent.callId,
        options.encoding ?? 'cdr',
        payload,
      ),
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

  /** CDR bytes for a Trigger response, written from the IDL definition. */
  function triggerResponseBytes(value: { success: boolean; message: string }): Uint8Array {
    return new MessageWriter(parseRos2idl(TRIGGER_RESPONSE_IDL)).writeMessage(value);
  }

  /** The text of every `logger.warn` call, joined. */
  function warned(logger: { warn: ReturnType<typeof vi.fn> }): string[] {
    return logger.warn.mock.calls.map((args: unknown[]) => args.map(String).join(' '));
  }

  describe('an advertised ROS 2 IDL response schema', () => {
    it('decodes when the bridge labels it ros2idl', async () => {
      const service = {
        id: 51,
        name: '/dock',
        type: 'my_pkg/srv/Dock',
        response: { encoding: 'cdr', schemaEncoding: 'ros2idl', schema: TRIGGER_RESPONSE_IDL },
      };
      await expect(
        callAndAnswer(service, triggerResponseBytes({ success: true, message: 'docked' })),
      ).resolves.toEqual({ success: true, message: 'docked' });
    });

    it('decodes when the bridge sends no schemaEncoding, after .msg fails to read it', async () => {
      const service = {
        id: 52,
        name: '/dock',
        type: 'my_pkg/srv/Dock',
        response: { encoding: 'cdr', schema: TRIGGER_RESPONSE_IDL },
      };
      await expect(
        callAndAnswer(service, triggerResponseBytes({ success: false, message: 'blocked' })),
      ).resolves.toEqual({ success: false, message: 'blocked' });
    });

    it('decodes from the flat legacy field, using the response-side hint', async () => {
      const logger = spyLogger();
      const service = {
        id: 53,
        name: '/dock',
        type: 'my_pkg/srv/Dock',
        requestSchema: '',
        responseSchema: TRIGGER_RESPONSE_IDL,
        requestSchemaEncoding: 'ros2msg',
        responseSchemaEncoding: 'ros2idl',
      };
      await expect(
        callAndAnswer(service, triggerResponseBytes({ success: true, message: '' }), { logger }),
      ).resolves.toEqual({ success: true, message: '' });
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('an advertised schema the client cannot parse', () => {
    it('warns with the service, the side, the hint and a preview of the text', async () => {
      const logger = spyLogger();
      const service = {
        id: 54,
        name: '/dock',
        type: 'my_pkg/srv/Dock',
        response: { encoding: 'cdr', schemaEncoding: 'ros2idl', schema: UNPARSEABLE },
      };
      const err = await rejection(callAndAnswer(service, FIELDLESS_BYTES, { logger }));
      // No bundle covers the type, so the fallback finds nothing either.
      expect(err.reason).toBe('no-schema');

      const lines = warned(logger);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('advertised response schema for "/dock"');
      expect(lines[0]).toContain('type "my_pkg/srv/Dock"');
      expect(lines[0]).toContain('encodingHint=ros2idl');
      expect(lines[0]).toContain(`preview="${UNPARSEABLE}"`);
    });

    it('says the hint was absent rather than printing undefined', async () => {
      const logger = spyLogger();
      const service = {
        id: 55,
        name: '/dock',
        type: 'my_pkg/srv/Dock',
        response: { encoding: 'cdr', schema: UNPARSEABLE },
      };
      await rejection(callAndAnswer(service, FIELDLESS_BYTES, { logger }));
      expect(warned(logger)[0]).toContain('encodingHint=none');
    });

    it('cuts the preview at 80 characters', async () => {
      const logger = spyLogger();
      const head = 'module broken { ' + 'x'.repeat(64);
      expect(head).toHaveLength(80);
      const service = {
        id: 56,
        name: '/dock',
        type: 'my_pkg/srv/Dock',
        response: { encoding: 'cdr', schema: `${head}TAIL_PAST_THE_PREVIEW };` },
      };
      await rejection(callAndAnswer(service, FIELDLESS_BYTES, { logger }));
      const line = warned(logger)[0]!;
      expect(line).toContain(`preview="${head}"`);
      expect(line).not.toContain('TAIL_PAST_THE_PREVIEW');
    });

    it('reports each side under its own flat hint', async () => {
      const logger = spyLogger();
      const service = {
        id: 57,
        name: '/dock',
        type: 'my_pkg/srv/Dock',
        requestSchema: UNPARSEABLE,
        responseSchema: UNPARSEABLE,
        requestSchemaEncoding: 'request-hint',
        responseSchemaEncoding: 'response-hint',
      };
      await rejection(callAndAnswer(service, FIELDLESS_BYTES, { logger }));
      const lines = warned(logger);
      const request = lines.find((l) => l.includes('advertised request schema'));
      const response = lines.find((l) => l.includes('advertised response schema'));
      expect(request).toContain('encodingHint=request-hint');
      expect(response).toContain('encodingHint=response-hint');
    });

    it('treats IDL that declares no message type as unparseable', async () => {
      // Valid IDL, but nothing in it a reader could decode with. It must take
      // the same path as text that fails to parse, not stand in as an empty
      // definition.
      const logger = spyLogger();
      const service = {
        id: 63,
        name: '/dock',
        type: 'my_pkg/srv/Dock',
        response: { encoding: 'cdr', schema: 'module my_pkg { typedef int32 Id; };' },
      };
      const err = await rejection(callAndAnswer(service, FIELDLESS_BYTES, { logger }));
      expect(err.reason).toBe('no-schema');
      expect(warned(logger)[0]).toContain('advertised response schema for "/dock"');
    });

    it('does not warn about a schema the bridge never sent', async () => {
      // No schema on either side is the ordinary state for a type the bundle
      // covers, not a parse failure. The call still fails for want of a
      // definition, but nothing was misread.
      const logger = spyLogger();
      const service = { id: 58, name: '/dock', type: 'my_pkg/srv/Dock' };
      const err = await rejection(callAndAnswer(service, FIELDLESS_BYTES, { logger }));
      expect(err.reason).toBe('no-schema');
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('a fieldless response described in the legacy flat form', () => {
    it('resolves the empty object', async () => {
      const service = {
        id: 59,
        name: '/reset',
        type: 'my_pkg/srv/Reset',
        requestSchema: 'int32 mode',
        responseSchema: '',
      };
      await expect(callAndAnswer(service, FIELDLESS_BYTES)).resolves.toEqual({});
    });

    it('reads the flat field when the nested object carries no schema text', async () => {
      const service = {
        id: 60,
        name: '/reset',
        type: 'my_pkg/srv/Reset',
        response: { encoding: 'cdr' },
        requestSchema: 'int32 mode',
        responseSchema: '',
      };
      await expect(callAndAnswer(service, FIELDLESS_BYTES)).resolves.toEqual({});
    });

    it('does not read a nested object without schema text as a fieldless description', async () => {
      // The nested object says nothing about the fields, and the flat field
      // describes a type the client cannot read. Nothing described the
      // response as empty, so the call must not resolve `{}`.
      const service = {
        id: 64,
        name: '/reset',
        type: 'my_pkg/srv/Reset',
        response: { encoding: 'cdr' },
        requestSchema: 'int32 mode',
        responseSchema: UNPARSEABLE,
      };
      const err = await rejection(callAndAnswer(service, FIELDLESS_BYTES, { logger: spyLogger() }));
      expect(err.reason).toBe('no-schema');
    });
  });

  describe('what the decode error tells the consumer', () => {
    it('names the CDR encoding and the reason when a fieldless response carries data', async () => {
      const service = {
        id: 61,
        name: '/reset',
        type: 'std_srvs/srv/Empty',
        response: { encoding: 'cdr', schema: '' },
      };
      const payload = new Uint8Array([0, 1, 0, 0, 9, 9, 9, 9, 9, 9]);
      const err = await rejection(callAndAnswer(service, payload));
      expect(err.reason).toBe('schema-mismatch');
      expect(err.encoding).toBe('cdr');
      expect(err.message).toContain(
        'the service was advertised with no response fields, but the response carries data',
      );
    });

    it('says why JSON that is not an object is not a response', async () => {
      const service = {
        id: 62,
        name: '/dock',
        type: 'std_srvs/srv/Trigger',
        response: { encoding: 'json', schema: 'bool success\nstring message' },
      };
      const err = await rejection(
        callAndAnswer(service, new TextEncoder().encode('[1, 2]'), { encoding: 'json' }),
      );
      expect(err.reason).toBe('malformed');
      expect(err.message).toContain('the JSON is not an object');
    });
  });
});
