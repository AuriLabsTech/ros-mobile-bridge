import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parse as parseRosMsgDef } from '@foxglove/rosmsg';
import { MessageReader, MessageWriter } from '@foxglove/rosmsg2-serialization';
import { FoxgloveClient } from '../src/FoxgloveClient';
import {
  installMockWebSocket,
  findSentServiceCallRequest,
  type MockWebSocketHandle,
} from './_helpers/mock-websocket';

/**
 * An `advertiseServices` entry can carry its schema in two shapes. The nested
 * `request` / `response` objects are the current form; the flat
 * `requestSchema` / `responseSchema` pair is kept by the spec only "for
 * backwards compatibilty, prefer using `request` instead".
 *
 * Up to 0.1.7 the client read only the flat pair. A stock `foxglove_bridge`
 * 3.4.1 (foxglove-sdk-cpp v0.25.1) sends the nested objects on all of its
 * services and the flat fields on none of them, so every service outside the
 * six-entry built-in bundle was unusable: non-empty requests failed to encode,
 * and responses came back as undecoded `rawBytes` with no error at all.
 *
 * These tests pin both shapes, their precedence, and the two failure modes.
 */

function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

// Shape of a real `<pkg>/action/<Action>_SendGoal_Request`: a nested message
// carrying a fixed-length array, in the concatenated ros2msg form a bridge
// actually sends. This is the type class the bundle structurally cannot
// cover — it is per-action, so layer 1 has to work or the call is impossible.
const SEND_GOAL_REQUEST_SCHEMA = [
  'unique_identifier_msgs/UUID goal_id',
  '#goal definition',
  'string label',
  '================================================================================',
  'MSG: unique_identifier_msgs/UUID',
  'uint8[16] uuid',
  '',
].join('\n');

const SEND_GOAL_RESPONSE_SCHEMA = ['bool accepted', ''].join('\n');

const ZERO_UUID = Array.from({ length: 16 }, () => 0);

describe('FoxgloveClient service schema shape (nested vs flat)', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });

  afterEach(() => {
    ws.restore();
  });

  async function connectAdvertising(
    services: Record<string, unknown>[],
    options?: ConstructorParameters<typeof FoxgloveClient>[0],
  ): Promise<{ client: FoxgloveClient; socket: ReturnType<MockWebSocketHandle['last']> }> {
    const client = new FoxgloveClient(options);
    const connectPromise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [] }));
    socket.simulateMessage(JSON.stringify({ op: 'advertiseServices', services }));
    await connectPromise;
    return { client, socket };
  }

  /** A service advertised the way a modern bridge advertises it. */
  function nestedSendGoal(): Record<string, unknown> {
    return {
      id: 7,
      name: '/navigate_to_pose/_action/send_goal',
      type: 'nav2_msgs/action/NavigateToPose_SendGoal',
      request: {
        encoding: 'cdr',
        schemaName: 'nav2_msgs/action/NavigateToPose_SendGoal_Request',
        schemaEncoding: 'ros2msg',
        schema: SEND_GOAL_REQUEST_SCHEMA,
      },
      response: {
        encoding: 'cdr',
        schemaName: 'nav2_msgs/action/NavigateToPose_SendGoal_Response',
        schemaEncoding: 'ros2msg',
        schema: SEND_GOAL_RESPONSE_SCHEMA,
      },
    };
  }

  it('encodes a non-empty request from the nested `request` object', async () => {
    const { client, socket } = await connectAdvertising([nestedSendGoal()]);

    const resultPromise = client.callService('/navigate_to_pose/_action/send_goal', {
      goal_id: { uuid: ZERO_UUID },
      label: 'dock',
    });
    resultPromise.catch(() => {});

    const callOp = findSentServiceCallRequest(socket);
    expect(callOp).not.toBeNull();
    expect(callOp!.serviceId).toBe(7);
    expect(callOp!.encoding).toBe('cdr');

    // Round-trip through a reader built from the same text: proves the client
    // parsed the nested schema rather than falling through to the bundle
    // (which has no entry for this type) or the 4-byte header.
    const reader = new MessageReader(parseRosMsgDef(SEND_GOAL_REQUEST_SCHEMA, { ros2: true }));
    const decoded = reader.readMessage(callOp!.payload) as {
      goal_id: { uuid: Uint8Array };
      label: string;
    };
    expect(Array.from(decoded.goal_id.uuid)).toEqual(ZERO_UUID);
    expect(decoded.label).toBe('dock');
  });

  it('decodes a response from the nested `response` object instead of resolving rawBytes', async () => {
    const { client, socket } = await connectAdvertising([nestedSendGoal()]);

    const resultPromise = client.callService('/navigate_to_pose/_action/send_goal', {
      goal_id: { uuid: ZERO_UUID },
      label: 'dock',
    });
    const callOp = findSentServiceCallRequest(socket)!;

    const writer = new MessageWriter(parseRosMsgDef(SEND_GOAL_RESPONSE_SCHEMA, { ros2: true }));
    socket.simulateMessage(
      JSON.stringify({
        op: 'serviceCallResponse',
        serviceId: 7,
        callId: callOp.callId,
        encoding: 'cdr',
        data: bytesToB64(writer.writeMessage({ accepted: true })),
      }),
    );

    const result = (await resultPromise) as { accepted?: boolean; rawBytes?: Uint8Array };
    expect(result.accepted).toBe(true);
    // The silent half of the bug: an undecodable response resolves rawBytes
    // with no error, so a consumer sees a "successful" call carrying nothing.
    expect(result.rawBytes).toBeUndefined();
  });

  it('still reads the legacy flat fields when a bridge sends only those', async () => {
    const { client, socket } = await connectAdvertising([
      {
        id: 8,
        name: '/legacy/send_goal',
        type: 'nav2_msgs/action/NavigateToPose_SendGoal',
        requestSchema: SEND_GOAL_REQUEST_SCHEMA,
        requestSchemaEncoding: 'ros2msg',
        responseSchema: SEND_GOAL_RESPONSE_SCHEMA,
        responseSchemaEncoding: 'ros2msg',
      },
    ]);

    const resultPromise = client.callService('/legacy/send_goal', {
      goal_id: { uuid: ZERO_UUID },
      label: 'legacy',
    });
    resultPromise.catch(() => {});

    const callOp = findSentServiceCallRequest(socket)!;
    const reader = new MessageReader(parseRosMsgDef(SEND_GOAL_REQUEST_SCHEMA, { ros2: true }));
    const decoded = reader.readMessage(callOp.payload) as { label: string };
    expect(decoded.label).toBe('legacy');
  });

  it('prefers the nested object when a bridge sends both shapes', async () => {
    // Same field count and types on both sides, distinguishable only by name,
    // so whichever schema was used is readable off the wire.
    const { client, socket } = await connectAdvertising([
      {
        id: 9,
        name: '/both/shapes',
        type: 'demo/srv/Both',
        request: {
          encoding: 'cdr',
          schemaEncoding: 'ros2msg',
          schema: 'string from_nested\n',
        },
        requestSchema: 'string from_flat\n',
        requestSchemaEncoding: 'ros2msg',
      },
    ]);

    const resultPromise = client.callService('/both/shapes', { from_nested: 'nested wins' });
    resultPromise.catch(() => {});

    const callOp = findSentServiceCallRequest(socket)!;
    const reader = new MessageReader(parseRosMsgDef('string from_nested\n', { ros2: true }));
    expect((reader.readMessage(callOp.payload) as { from_nested: string }).from_nested).toBe(
      'nested wins',
    );
  });

  it('falls back to the built-in bundle and warns when the advertised schema will not parse', async () => {
    const warn = vi.fn();
    const { client, socket } = await connectAdvertising(
      [
        {
          id: 10,
          name: '/navigate_to_pose/_action/cancel_goal',
          type: 'action_msgs/srv/CancelGoal',
          request: {
            encoding: 'cdr',
            // A jsonschema-encoded service schema: not something the ros2msg
            // or ros2idl parsers can read. Before the nested fields were
            // read this path was unreachable, so it must not become fatal.
            schemaEncoding: 'jsonschema',
            schema: '{"type":"object","properties":{}}',
          },
        },
      ],
      { logger: { log: vi.fn(), warn, error: vi.fn() } },
    );

    // CancelGoal is in the bundle, so the call still encodes.
    const resultPromise = client.callService('/navigate_to_pose/_action/cancel_goal', {});
    resultPromise.catch(() => {});

    expect(findSentServiceCallRequest(socket)).not.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not parse the advertised request schema'),
    );
  });

  it('regression: a nested-only non-bundled service no longer reports a missing schema', async () => {
    // The exact 0.1.7 failure, reported against a stock 3.4.1 bridge from a
    // node consumer and reproduced on device: the schema was on the wire the
    // whole time, under `request`, and the error blamed the bridge for
    // omitting it.
    const { client, socket } = await connectAdvertising([nestedSendGoal()]);

    // An encode failure rejects synchronously, before any frame goes out, so
    // capturing the rejection and flushing microtasks is enough: the call
    // itself stays pending until the bridge answers, which it never does here.
    const rejection = vi.fn();
    client
      .callService('/navigate_to_pose/_action/send_goal', {
        goal_id: { uuid: ZERO_UUID },
        label: 'dock',
      })
      .catch(rejection);
    await Promise.resolve();

    expect(rejection).not.toHaveBeenCalled();
    expect(findSentServiceCallRequest(socket)).not.toBeNull();
  });
});
