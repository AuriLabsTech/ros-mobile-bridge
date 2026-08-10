import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parse as parseRosMsgDef } from '@foxglove/rosmsg';
import { MessageWriter } from '@foxglove/rosmsg2-serialization';
import { FoxgloveClient } from '../src/FoxgloveClient';
import {
  installMockWebSocket,
  findSentServiceCallRequest,
  foxgloveServiceCallResponseFrame,
  type MockWebSocketHandle,
} from './_helpers/mock-websocket';

/**
 * Wire replay of a field-reported scenario: a `CancelGoal` call carrying a
 * random v4 UUID + zero stamp (a liveness probe matching no goal that ever
 * existed), answered by the server with `return_code: 2`
 * (ERROR_UNKNOWN_GOAL_ID) and an empty `goals_canceling` — an answer that
 * was on the wire but reportedly never reached the caller. The advertisement
 * mirrors what a stock foxglove_bridge 3.4.1 sends: nested request/response
 * objects carrying full ros2msg text.
 */

const GOAL_INFO_CHAIN = [
  '================================================================================',
  'MSG: action_msgs/GoalInfo',
  'unique_identifier_msgs/UUID goal_id',
  'builtin_interfaces/Time stamp',
  '================================================================================',
  'MSG: unique_identifier_msgs/UUID',
  'uint8[16] uuid',
  '================================================================================',
  'MSG: builtin_interfaces/Time',
  'int32 sec',
  'uint32 nanosec',
  '',
].join('\n');

const CANCEL_GOAL_REQUEST_SCHEMA = ['action_msgs/GoalInfo goal_info', GOAL_INFO_CHAIN].join('\n');

const CANCEL_GOAL_RESPONSE_SCHEMA = [
  'int8 ERROR_NONE=0',
  'int8 ERROR_REJECTED=1',
  'int8 ERROR_UNKNOWN_GOAL_ID=2',
  'int8 ERROR_GOAL_TERMINATED=3',
  'int8 return_code',
  'action_msgs/GoalInfo[] goals_canceling',
  GOAL_INFO_CHAIN,
].join('\n');

const PROBE_UUID = [
  0x8a, 0x1f, 0x33, 0x07, 0x51, 0x2b, 0x44, 0x9e, 0x8f, 0x00, 0xd2, 0x6c, 0x1a, 0x5b, 0x99, 0x41,
];

describe('FoxgloveClient CancelGoal response receive path (cancel-probe replay)', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });

  afterEach(() => {
    ws.restore();
  });

  async function connectedWithCancelGoal(): Promise<{
    client: FoxgloveClient;
    socket: ReturnType<MockWebSocketHandle['last']>;
  }> {
    const client = new FoxgloveClient();
    const connectPromise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [] }));
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertiseServices',
        services: [
          {
            id: 42,
            name: '/dock/_action/cancel_goal',
            type: 'action_msgs/srv/CancelGoal',
            request: {
              encoding: 'cdr',
              schemaName: 'action_msgs/srv/CancelGoal_Request',
              schemaEncoding: 'ros2msg',
              schema: CANCEL_GOAL_REQUEST_SCHEMA,
            },
            response: {
              encoding: 'cdr',
              schemaName: 'action_msgs/srv/CancelGoal_Response',
              schemaEncoding: 'ros2msg',
              schema: CANCEL_GOAL_RESPONSE_SCHEMA,
            },
          },
        ],
      }),
    );
    await connectPromise;
    return { client, socket };
  }

  it('resolves the caller with return_code 2 when the reasoned response frame arrives', async () => {
    const { client, socket } = await connectedWithCancelGoal();

    // The probe's request: a random v4 uuid that matches no goal, zero stamp.
    const resultPromise = client.callService('/dock/_action/cancel_goal', {
      goal_info: {
        goal_id: { uuid: PROBE_UUID },
        stamp: { sec: 0, nanosec: 0 },
      },
    });

    // The request provably left the device (the pass verified seven of them).
    const sent = findSentServiceCallRequest(socket);
    expect(sent).not.toBeNull();
    expect(sent?.serviceId).toBe(42);

    // The server's answer, byte-encoded exactly as the bridge would:
    // ERROR_UNKNOWN_GOAL_ID, nothing canceling.
    const responseDefs = parseRosMsgDef(CANCEL_GOAL_RESPONSE_SCHEMA, { ros2: true });
    const responseBytes = new MessageWriter(responseDefs).writeMessage({
      return_code: 2,
      goals_canceling: [],
    });
    socket.simulateMessage(
      foxgloveServiceCallResponseFrame(42, sent!.callId, 'cdr', responseBytes),
    );

    const result = await resultPromise;
    expect(result.return_code).toBe(2);
    expect(result.goals_canceling).toEqual([]);
  });
});
