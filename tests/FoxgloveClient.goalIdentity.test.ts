// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * How `sendActionGoal` names a goal on the wire and recognizes it again.
 *
 * The client invents each goal's UUID, then picks its own goal out of the
 * action's shared status topic by that UUID, whichever of the three spellings
 * the channel's serializer used. It also decides from the advertised
 * send_goal schema whether the goal travels nested under a `goal` member or
 * inlined at the root (ADR 0013). The main suite covers the ordinary cases;
 * these pin the edges where a wrong answer is silent on the wire.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parse as parseRosMsgDef } from '@foxglove/rosmsg';
import { MessageReader } from '@foxglove/rosmsg2-serialization';
import { FoxgloveClient } from '../src/FoxgloveClient';
import {
  installMockWebSocket,
  foxgloveMessageDataFrame,
  parseFoxgloveServiceCallRequestFrame,
  type MockWebSocketHandle,
  type MockWebSocket,
  type ParsedServiceCallRequest,
} from './_helpers/mock-websocket';

const SEP = '='.repeat(80);
const UUID_CHAIN = ['MSG: unique_identifier_msgs/UUID', 'uint8[16] uuid'].join('\n');

const SEND_GOAL_ID = 21;
const GET_RESULT_ID = 22;
const STATUS_CHANNEL = 11;

/** The rosidl shape: the goal's own fields inlined beside `goal_id`. */
const FLAT_SEND_GOAL_REQ = [
  'unique_identifier_msgs/UUID goal_id',
  'int32 target_id',
  SEP,
  UUID_CHAIN,
  '',
].join('\n');

const SEND_GOAL_RESP = 'bool accepted\n';
const GET_RESULT_REQ = ['unique_identifier_msgs/UUID goal_id', SEP, UUID_CHAIN, ''].join('\n');
const GET_RESULT_RESP = 'int8 status\n';

function svc(
  id: number,
  name: string,
  type: string,
  req: string,
  resp: string,
): Record<string, unknown> {
  return {
    id,
    name,
    type,
    request: {
      encoding: 'cdr',
      schemaName: `${type}_Request`,
      schemaEncoding: 'ros2msg',
      schema: req,
    },
    response: {
      encoding: 'cdr',
      schemaName: `${type}_Response`,
      schemaEncoding: 'ros2msg',
      schema: resp,
    },
  };
}

describe('FoxgloveClient — goal identity on the wire', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  /**
   * Connect with a send_goal and get_result service and a JSON-encoded status
   * channel, the encoding whose serializers spell a byte array either as a
   * number array or as base64.
   */
  async function connected(sendGoalReq = FLAT_SEND_GOAL_REQ): Promise<{
    client: FoxgloveClient;
    socket: MockWebSocket;
  }> {
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
            topic: '/dock/_action/status',
            encoding: 'json',
            schemaName: 'action_msgs/msg/GoalStatusArray',
            schema: '',
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
            '/dock/_action/send_goal',
            'pkg/action/Dock_SendGoal',
            sendGoalReq,
            SEND_GOAL_RESP,
          ),
          svc(
            GET_RESULT_ID,
            '/dock/_action/get_result',
            'pkg/action/Dock_GetResult',
            GET_RESULT_REQ,
            GET_RESULT_RESP,
          ),
        ],
      }),
    );
    await connectPromise;
    return { client, socket };
  }

  function sentCalls(socket: MockWebSocket, serviceId: number): ParsedServiceCallRequest[] {
    return socket.sentBinary
      .map((b) => parseFoxgloveServiceCallRequestFrame(b))
      .filter((c): c is ParsedServiceCallRequest => c !== null && c.serviceId === serviceId);
  }

  /** Decode the n-th send_goal request the client sent, against `schema`. */
  function sentGoal(socket: MockWebSocket, schema: string, n = 0): Record<string, unknown> {
    const call = sentCalls(socket, SEND_GOAL_ID)[n];
    if (!call) throw new Error(`no send_goal request #${n}`);
    return new MessageReader(parseRosMsgDef(schema, { ros2: true })).readMessage(
      call.payload,
    ) as Record<string, unknown>;
  }

  function goalUuid(socket: MockWebSocket, n = 0): number[] {
    const decoded = sentGoal(socket, FLAT_SEND_GOAL_REQ, n) as { goal_id: { uuid: Uint8Array } };
    return Array.from(decoded.goal_id.uuid);
  }

  function statusFrame(
    socket: MockWebSocket,
    entries: Array<{ uuid: unknown; status: number }>,
  ): ArrayBuffer {
    const op = socket.sentJson.find((m) => m.op === 'subscribe');
    const subId = (op?.subscriptions as Array<{ id: number }> | undefined)?.[0]?.id;
    if (subId === undefined) throw new Error('status topic was not subscribed');
    const payload = new TextEncoder().encode(
      JSON.stringify({
        status_list: entries.map((e) => ({
          goal_info: {
            goal_id: e.uuid === undefined ? {} : { uuid: e.uuid },
            stamp: { sec: 0, nanosec: 0 },
          },
          status: e.status,
        })),
      }),
    );
    return foxgloveMessageDataFrame(subId, 0n, payload);
  }

  it('gives every goal its own id', async () => {
    const { client, socket } = await connected();

    for (let i = 0; i < 4; i++) client.sendActionGoal('/dock', 'pkg/action/Dock', { target_id: i });

    const ids = [0, 1, 2, 3].map((n) => goalUuid(socket, n).join(','));
    expect(new Set(ids).size).toBe(4);
  });

  it('compares ids byte by byte, so ids that run together the same way stay apart', async () => {
    // Ours starts 01 23, the other goal's 12 03. Written without leading
    // zeros both read "123...", which is the comparison this pins out.
    const ours = [0x01, 0x23, ...Array<number>(14).fill(0x55)];
    let i = 0;
    const random = vi.spyOn(Math, 'random').mockImplementation(() => (ours[i++ % 16]! + 0.5) / 256);
    try {
      const { client, socket } = await connected();
      client.sendActionGoal('/dock', 'pkg/action/Dock', { target_id: 1 });
      const sent = goalUuid(socket);
      expect(sent.slice(0, 2)).toEqual([0x01, 0x23]);

      const other = [0x12, 0x03, ...sent.slice(2)];
      socket.simulateMessage(statusFrame(socket, [{ uuid: other, status: 4 }]));
      expect(sentCalls(socket, GET_RESULT_ID)).toHaveLength(0);

      socket.simulateMessage(statusFrame(socket, [{ uuid: sent, status: 4 }]));
      expect(sentCalls(socket, GET_RESULT_ID)).toHaveLength(1);
    } finally {
      random.mockRestore();
    }
  });

  it('recognizes its goal when the status channel spells the uuid as a number array', async () => {
    const { client, socket } = await connected();

    client.sendActionGoal('/dock', 'pkg/action/Dock', { target_id: 1 });
    socket.simulateMessage(statusFrame(socket, [{ uuid: goalUuid(socket), status: 4 }]));

    // A terminal status naming the goal is what fetches the result.
    expect(sentCalls(socket, GET_RESULT_ID)).toHaveLength(1);
  });

  it('is not thrown off by entries for other goals whose ids it cannot read', async () => {
    const { client, socket } = await connected();

    client.sendActionGoal('/dock', 'pkg/action/Dock', { target_id: 1 });
    const ours = goalUuid(socket);
    socket.simulateMessage(
      statusFrame(socket, [
        { uuid: undefined, status: 2 },
        { uuid: null, status: 2 },
        { uuid: 7, status: 2 },
        { uuid: ours.slice(0, 15), status: 2 },
        { uuid: ours, status: 4 },
      ]),
    );

    expect(sentCalls(socket, GET_RESULT_ID)).toHaveLength(1);
  });

  describe('nested or inlined goal', () => {
    it('inlines the goal when its own `goal` field has a type named only `_Goal`', async () => {
      // A bare `_Goal` is not an `<Action>_Goal` wrapper: there is no action
      // name in front of it.
      const schema = [
        'unique_identifier_msgs/UUID goal_id',
        'pkg/_Goal goal',
        SEP,
        'MSG: pkg/_Goal',
        'int32 x',
        SEP,
        UUID_CHAIN,
        '',
      ].join('\n');
      const { client, socket } = await connected(schema);

      client.sendActionGoal('/dock', 'pkg/action/Dock', { goal: { x: 5 } });

      expect(sentGoal(socket, schema)).toMatchObject({ goal: { x: 5 } });
    });

    it('inlines the goal when a wrapper-typed field is not named `goal`', async () => {
      const schema = [
        'unique_identifier_msgs/UUID goal_id',
        'pkg/Dock_Goal target',
        SEP,
        'MSG: pkg/Dock_Goal',
        'int32 x',
        SEP,
        UUID_CHAIN,
        '',
      ].join('\n');
      const { client, socket } = await connected(schema);

      client.sendActionGoal('/dock', 'pkg/action/Dock', { target: { x: 3 } });

      expect(sentGoal(socket, schema)).toMatchObject({ target: { x: 3 } });
    });

    it('inlines the goal when its `goal` field is an array of a wrapper-named type', async () => {
      const schema = [
        'unique_identifier_msgs/UUID goal_id',
        'pkg/Waypoint_Goal[] goal',
        SEP,
        'MSG: pkg/Waypoint_Goal',
        'int32 x',
        SEP,
        UUID_CHAIN,
        '',
      ].join('\n');
      const { client, socket } = await connected(schema);

      client.sendActionGoal('/dock', 'pkg/action/Dock', { goal: [{ x: 1 }, { x: 2 }] });

      expect(sentGoal(socket, schema)).toMatchObject({ goal: [{ x: 1 }, { x: 2 }] });
    });
  });
});
