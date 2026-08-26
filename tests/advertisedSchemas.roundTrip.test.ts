import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parse as parseRosMsgDef } from '@foxglove/rosmsg';
import { MessageReader, MessageWriter } from '@foxglove/rosmsg2-serialization';
import { FoxgloveClient } from '../src/FoxgloveClient';
import {
  installMockWebSocket,
  foxgloveServiceCallResponseFrame,
  parseFoxgloveServiceCallRequestFrame,
  type MockWebSocketHandle,
  type MockWebSocket,
} from './_helpers/mock-websocket';
import { populateMessage, normalizeDecoded } from './_helpers/populateMessage';
import { SCHEMA_CAPTURES } from './fixtures';

/**
 * The release-gate corpus check.
 *
 * Every CDR encode and decode path in this library runs against schemas a real
 * bridge advertised, with values chosen so neither a zero nor a schema default
 * can be mistaken for a success. It is deliberately generic: a new capture
 * dropped into `tests/fixtures/advertised-schemas.json` is exercised here with
 * no test written for it.
 *
 * Service calls are the only CDR encode path on this transport — `publish`
 * advertises its client channels as JSON — and `sendActionGoal` composes from
 * service calls, so this covers the dispatch, get-result and cancel paths at
 * their common floor. `tests/FoxgloveClient.sendGoalShape.test.ts` covers what
 * is layered on top: which payload the action path hands to that encoder.
 */

describe('advertised-schema corpus round-trip', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });

  afterEach(() => {
    ws.restore();
  });

  async function connectAdvertising(
    services: Record<string, unknown>[],
  ): Promise<{ client: FoxgloveClient; socket: MockWebSocket }> {
    const client = new FoxgloveClient();
    const connectPromise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [] }));
    socket.simulateMessage(JSON.stringify({ op: 'advertiseServices', services }));
    await connectPromise;
    return { client, socket };
  }

  for (const capture of SCHEMA_CAPTURES) {
    describe(`${capture.rosDistro} / ${capture.foxgloveLibrary} (captured ${capture.capturedUtc})`, () => {
      for (const svc of capture.services) {
        const serviceId = 31;

        it(`round-trips a ${svc.type} request through the client's encoder`, async () => {
          const defs = parseRosMsgDef(svc.request.schema, { ros2: true });
          const request = populateMessage(defs);

          const { client, socket } = await connectAdvertising([
            {
              id: serviceId,
              name: svc.name,
              type: svc.type,
              request: {
                encoding: 'cdr',
                schemaName: svc.request.schemaName,
                schemaEncoding: svc.request.encoding,
                schema: svc.request.schema,
              },
              response: {
                encoding: 'cdr',
                schemaName: svc.response.schemaName,
                schemaEncoding: svc.response.encoding,
                schema: svc.response.schema,
              },
            },
          ]);

          const pending = client.callService(svc.name, request);
          pending.catch(() => {});

          const sent = socket.sentBinary
            .map(parseFoxgloveServiceCallRequestFrame)
            .find((f) => f?.serviceId === serviceId);
          expect(sent, 'no SERVICE_CALL_REQUEST frame was sent').toBeTruthy();
          expect(sent!.encoding).toBe('cdr');

          const decoded = normalizeDecoded(
            new MessageReader(defs).readMessage(sent!.payload),
          ) as Record<string, unknown>;

          for (const [key, value] of Object.entries(request)) {
            expect(decoded[key], `request field "${key}" did not survive the round-trip`).toEqual(
              value,
            );
          }

          client.disconnect();
        });

        it(`round-trips a ${svc.type} response through the client's decoder`, async () => {
          const defs = parseRosMsgDef(svc.response.schema, { ros2: true });
          const response = populateMessage(defs);

          const { client, socket } = await connectAdvertising([
            {
              id: serviceId,
              name: svc.name,
              type: svc.type,
              request: {
                encoding: 'cdr',
                schemaName: svc.request.schemaName,
                schemaEncoding: svc.request.encoding,
                schema: svc.request.schema,
              },
              response: {
                encoding: 'cdr',
                schemaName: svc.response.schemaName,
                schemaEncoding: svc.response.encoding,
                schema: svc.response.schema,
              },
            },
          ]);

          const pending = client.callService(
            svc.name,
            populateMessage(parseRosMsgDef(svc.request.schema, { ros2: true })),
          );

          const sent = socket.sentBinary
            .map(parseFoxgloveServiceCallRequestFrame)
            .find((f) => f?.serviceId === serviceId);
          expect(sent, 'no SERVICE_CALL_REQUEST frame was sent').toBeTruthy();

          socket.simulateMessage(
            foxgloveServiceCallResponseFrame(
              serviceId,
              sent!.callId,
              'cdr',
              new MessageWriter(defs).writeMessage(response),
            ),
          );

          const decoded = normalizeDecoded(await pending) as Record<string, unknown>;
          for (const [key, value] of Object.entries(response)) {
            expect(decoded[key], `response field "${key}" did not survive the round-trip`).toEqual(
              value,
            );
          }

          client.disconnect();
        });
      }
    });
  }
});
