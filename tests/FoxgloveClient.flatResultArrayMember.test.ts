// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * A flattened GetResult response whose action result declares an array member
 * of its own named `result`.
 *
 * `foxglove_bridge` inlines the action result's fields at the root of the
 * GetResult response, so the client lifts them back out unless the root's
 * `result` key is the nested wrapper (ADR 0011). A wrapper is a struct and
 * always decodes to a plain record; an array under that name is a payload
 * field, so the response is flat and the array must reach the consumer as
 * `outcome.result.result`, beside the other fields, not in place of them.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parse as parseRosMsgDef } from '@foxglove/rosmsg';
import { MessageReader, MessageWriter } from '@foxglove/rosmsg2-serialization';
import { FoxgloveClient } from '../src/FoxgloveClient';
import {
  installMockWebSocket,
  foxgloveMessageDataFrame,
  foxgloveServiceCallResponseFrame,
  parseFoxgloveServiceCallRequestFrame,
  type MockWebSocketHandle,
  type ParsedServiceCallRequest,
} from './_helpers/mock-websocket';

const SEP = '='.repeat(80);
const UUID_CHAIN = ['MSG: unique_identifier_msgs/UUID', 'uint8[16] uuid'].join('\n');
const TIME_CHAIN = ['MSG: builtin_interfaces/Time', 'int32 sec', 'uint32 nanosec'].join('\n');

const SEND_GOAL_REQ = ['unique_identifier_msgs/UUID goal_id', SEP, UUID_CHAIN, ''].join('\n');
const SEND_GOAL_RESP = ['bool accepted', 'builtin_interfaces/Time stamp', SEP, TIME_CHAIN, ''].join(
  '\n',
);
const GET_RESULT_REQ = SEND_GOAL_REQ;

const STATUS_ARRAY = [
  'action_msgs/GoalStatus[] status_list',
  SEP,
  'MSG: action_msgs/GoalStatus',
  'action_msgs/GoalInfo goal_info',
  'int8 status',
  SEP,
  'MSG: action_msgs/GoalInfo',
  'unique_identifier_msgs/UUID goal_id',
  'builtin_interfaces/Time stamp',
  SEP,
  UUID_CHAIN,
  SEP,
  TIME_CHAIN,
  '',
].join('\n');

const SEND_GOAL_ID = 21;
const GET_RESULT_ID = 22;
const STATUS_CHANNEL = 11;

function svc(id: number, name: string, type: string, req: string, resp: string) {
  return {
    id,
    name,
    type,
    request: { encoding: 'cdr', schemaEncoding: 'ros2msg', schema: req },
    response: { encoding: 'cdr', schemaEncoding: 'ros2msg', schema: resp },
  };
}

describe('FoxgloveClient — a flattened result with an array member named "result"', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  function sentCalls(socket: ReturnType<MockWebSocketHandle['last']>): ParsedServiceCallRequest[] {
    return socket.sentBinary
      .map((buf) => parseFoxgloveServiceCallRequestFrame(buf))
      .filter((c): c is ParsedServiceCallRequest => c !== null && c !== undefined);
  }

  function respond(
    socket: ReturnType<MockWebSocketHandle['last']>,
    call: ParsedServiceCallRequest,
    schema: string,
    value: Record<string, unknown>,
  ): void {
    const bytes = new MessageWriter(parseRosMsgDef(schema, { ros2: true })).writeMessage(value);
    socket.simulateMessage(
      foxgloveServiceCallResponseFrame(call.serviceId, call.callId, 'cdr', bytes),
    );
  }

  /** Dispatch a goal, accept it, report it executing, and answer GetResult with `result`. */
  async function outcomeFor(
    getResultResp: string,
    result: Record<string, unknown>,
    encoding: 'cdr' | 'json' = 'cdr',
  ) {
    const client = new FoxgloveClient();
    const connectPromise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertise',
        channels: [
          {
            id: STATUS_CHANNEL,
            topic: '/scan/_action/status',
            encoding: 'cdr',
            schemaName: 'action_msgs/msg/GoalStatusArray',
            schemaEncoding: 'ros2msg',
            schema: STATUS_ARRAY,
          },
        ],
      }),
    );
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertiseServices',
        services: [
          svc(
            SEND_GOAL_ID,
            '/scan/_action/send_goal',
            'pkg/action/Scan_SendGoal',
            SEND_GOAL_REQ,
            SEND_GOAL_RESP,
          ),
          svc(
            GET_RESULT_ID,
            '/scan/_action/get_result',
            'pkg/action/Scan_GetResult',
            GET_RESULT_REQ,
            getResultResp,
          ),
        ],
      }),
    );
    await connectPromise;

    const handle = client.sendActionGoal('/scan', 'pkg/action/Scan', {});
    const sendGoal = sentCalls(socket).find((c) => c.serviceId === SEND_GOAL_ID)!;
    const uuid = (
      new MessageReader(parseRosMsgDef(SEND_GOAL_REQ, { ros2: true })).readMessage(
        sendGoal.payload,
      ) as { goal_id: { uuid: Uint8Array } }
    ).goal_id.uuid;
    respond(socket, sendGoal, SEND_GOAL_RESP, { accepted: true, stamp: { sec: 0, nanosec: 0 } });
    await flush();

    const subId = (
      socket.sentJson.find((m) => m.op === 'subscribe') as {
        subscriptions: Array<{ id: number; channelId: number }>;
      }
    ).subscriptions.find((s) => s.channelId === STATUS_CHANNEL)!.id;
    const status = new MessageWriter(parseRosMsgDef(STATUS_ARRAY, { ros2: true })).writeMessage({
      status_list: [
        {
          goal_info: { goal_id: { uuid: Array.from(uuid) }, stamp: { sec: 0, nanosec: 0 } },
          status: 2,
        },
      ],
    });
    socket.simulateMessage(foxgloveMessageDataFrame(subId, 0n, status));

    const standing = sentCalls(socket).find((c) => c.serviceId === GET_RESULT_ID)!;
    if (encoding === 'json') {
      const bytes = new TextEncoder().encode(JSON.stringify({ status: 4, ...result }));
      socket.simulateMessage(
        foxgloveServiceCallResponseFrame(standing.serviceId, standing.callId, 'json', bytes),
      );
    } else {
      respond(socket, standing, getResultResp, { status: 4, ...result });
    }
    return handle.outcome;
  }

  it('keeps a string array named "result" as a field of the lifted result', async () => {
    const resp = ['int8 status', '#result definition', 'string[] result', 'uint32 count', ''].join(
      '\n',
    );
    await expect(outcomeFor(resp, { result: ['a', 'b'], count: 2 })).resolves.toEqual({
      status: 4,
      result: { result: ['a', 'b'], count: 2 },
    });
  });

  it('never hands a null "result" member over as the result record', async () => {
    // Only a JSON answer can carry a null; CDR always materializes a value.
    // `outcome.result` is typed as a record, so a null under the wrapper's
    // name is a field like any other, not the result.
    const resp = ['int8 status', '#result definition', 'uint32 count', ''].join('\n');
    await expect(outcomeFor(resp, { result: null, count: 2 }, 'json')).resolves.toEqual({
      status: 4,
      result: { result: null, count: 2 },
    });
  });
});
