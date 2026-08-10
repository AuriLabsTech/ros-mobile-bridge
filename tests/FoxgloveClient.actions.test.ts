import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parse as parseRosMsgDef } from '@foxglove/rosmsg';
import { MessageReader, MessageWriter } from '@foxglove/rosmsg2-serialization';
import { FoxgloveClient } from '../src/FoxgloveClient';
import { ActionGoalError } from '../src/errors';
import {
  installMockWebSocket,
  foxgloveMessageDataFrame,
  foxgloveServiceCallResponseFrame,
  parseFoxgloveServiceCallRequestFrame,
  type MockWebSocketHandle,
  type ParsedServiceCallRequest,
} from './_helpers/mock-websocket';

/**
 * Foxglove `sendActionGoal` composes goal dispatch from the hidden
 * `_action/*` services and topics: send_goal via `callService`, a status
 * watch on `_action/status` keyed by the client-invented goal UUID,
 * `get_result` fetched at terminal, and an optional `latest-only` feedback
 * subscription. The harness advertises the surfaces the way a
 * `foxglove_bridge` launched with `include_hidden:=true` does.
 */

const SEP = '='.repeat(80);

const UUID_CHAIN = ['MSG: unique_identifier_msgs/UUID', 'uint8[16] uuid'].join('\n');
const TIME_CHAIN = ['MSG: builtin_interfaces/Time', 'int32 sec', 'uint32 nanosec'].join('\n');

const SEND_GOAL_REQ = [
  'unique_identifier_msgs/UUID goal_id',
  'my_robot_interfaces/Dock_Goal goal',
  SEP,
  'MSG: my_robot_interfaces/Dock_Goal',
  'int32 target_id',
  SEP,
  UUID_CHAIN,
  '',
].join('\n');

const SEND_GOAL_RESP = ['bool accepted', 'builtin_interfaces/Time stamp', SEP, TIME_CHAIN, ''].join(
  '\n',
);

const GET_RESULT_REQ = ['unique_identifier_msgs/UUID goal_id', SEP, UUID_CHAIN, ''].join('\n');

const GET_RESULT_RESP = [
  'int8 status',
  'my_robot_interfaces/Dock_Result result',
  SEP,
  'MSG: my_robot_interfaces/Dock_Result',
  'bool docked',
  '',
].join('\n');

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

const FEEDBACK_MSG = [
  'unique_identifier_msgs/UUID goal_id',
  'my_robot_interfaces/Dock_Feedback feedback',
  SEP,
  'MSG: my_robot_interfaces/Dock_Feedback',
  'float32 progress',
  SEP,
  UUID_CHAIN,
  '',
].join('\n');

const CANCEL_REQ = [
  'action_msgs/GoalInfo goal_info',
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

const CANCEL_RESP = [
  'int8 return_code',
  'action_msgs/GoalInfo[] goals_canceling',
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
const CANCEL_ID = 23;
const STATUS_CHANNEL = 11;
const FEEDBACK_CHANNEL = 12;

function svc(
  id: number,
  name: string,
  type: string,
  reqSchema: string,
  respSchema: string,
): Record<string, unknown> {
  return {
    id,
    name,
    type,
    request: {
      encoding: 'cdr',
      schemaName: `${type}_Request`,
      schemaEncoding: 'ros2msg',
      schema: reqSchema,
    },
    response: {
      encoding: 'cdr',
      schemaName: `${type}_Response`,
      schemaEncoding: 'ros2msg',
      schema: respSchema,
    },
  };
}

describe('FoxgloveClient sendActionGoal', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });

  afterEach(() => {
    ws.restore();
  });

  async function connectedWithAction(opts?: { hidden?: boolean }): Promise<{
    client: FoxgloveClient;
    socket: ReturnType<MockWebSocketHandle['last']>;
  }> {
    const client = new FoxgloveClient();
    const connectPromise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertise',
        channels:
          opts?.hidden === false
            ? []
            : [
                {
                  id: STATUS_CHANNEL,
                  topic: '/dock/_action/status',
                  encoding: 'cdr',
                  schemaName: 'action_msgs/msg/GoalStatusArray',
                  schemaEncoding: 'ros2msg',
                  schema: STATUS_ARRAY,
                },
                {
                  id: FEEDBACK_CHANNEL,
                  topic: '/dock/_action/feedback',
                  encoding: 'cdr',
                  schemaName: 'my_robot_interfaces/action/Dock_FeedbackMessage',
                  schemaEncoding: 'ros2msg',
                  schema: FEEDBACK_MSG,
                },
              ],
      }),
    );
    if (opts?.hidden !== false) {
      socket.simulateMessage(
        JSON.stringify({
          op: 'advertiseServices',
          services: [
            svc(
              SEND_GOAL_ID,
              '/dock/_action/send_goal',
              'my_robot_interfaces/action/Dock_SendGoal',
              SEND_GOAL_REQ,
              SEND_GOAL_RESP,
            ),
            svc(
              GET_RESULT_ID,
              '/dock/_action/get_result',
              'my_robot_interfaces/action/Dock_GetResult',
              GET_RESULT_REQ,
              GET_RESULT_RESP,
            ),
            svc(
              CANCEL_ID,
              '/dock/_action/cancel_goal',
              'action_msgs/srv/CancelGoal',
              CANCEL_REQ,
              CANCEL_RESP,
            ),
          ],
        }),
      );
    }
    await connectPromise;
    return { client, socket };
  }

  /** All 0x02 service-call frames the client has sent, in order. */
  function sentCalls(socket: ReturnType<MockWebSocketHandle['last']>): ParsedServiceCallRequest[] {
    const out: ParsedServiceCallRequest[] = [];
    for (const buf of socket.sentBinary) {
      const parsed = parseFoxgloveServiceCallRequestFrame(buf);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  function respond(
    socket: ReturnType<MockWebSocketHandle['last']>,
    call: ParsedServiceCallRequest,
    respSchema: string,
    payload: Record<string, unknown>,
  ): void {
    const bytes = new MessageWriter(parseRosMsgDef(respSchema, { ros2: true })).writeMessage(
      payload,
    );
    socket.simulateMessage(
      foxgloveServiceCallResponseFrame(call.serviceId, call.callId, 'cdr', bytes),
    );
  }

  /** The subscription id the client chose for a channel, from its subscribe op. */
  function subscriptionIdFor(
    socket: ReturnType<MockWebSocketHandle['last']>,
    channelId: number,
  ): number | undefined {
    const ops = socket.sentJson.filter((m) => m.op === 'subscribe') as Array<{
      subscriptions: Array<{ id: number; channelId: number }>;
    }>;
    for (const op of ops) {
      for (const s of op.subscriptions) {
        if (s.channelId === channelId) return s.id;
      }
    }
    return undefined;
  }

  function statusArrayFrame(
    subId: number,
    entries: Array<{ uuid: ArrayLike<number>; status: number }>,
  ): ArrayBuffer {
    const bytes = new MessageWriter(parseRosMsgDef(STATUS_ARRAY, { ros2: true })).writeMessage({
      status_list: entries.map((e) => ({
        goal_info: { goal_id: { uuid: Array.from(e.uuid) }, stamp: { sec: 0, nanosec: 0 } },
        status: e.status,
      })),
    });
    return foxgloveMessageDataFrame(subId, 0n, bytes);
  }

  function statusFrame(subId: number, uuid: ArrayLike<number>, status: number): ArrayBuffer {
    return statusArrayFrame(subId, [{ uuid, status }]);
  }

  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('throws synchronously when dispatching while not connected', () => {
    const client = new FoxgloveClient();
    expect(() =>
      client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {}),
    ).toThrow('Not connected');
  });

  it('rejects with reason "unavailable" on a stock bridge that hides the _action services', async () => {
    const { client } = await connectedWithAction({ hidden: false });

    const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
    const err = (await handle.outcome.then(
      () => null,
      (e: unknown) => e,
    )) as ActionGoalError;

    expect(err).toBeInstanceOf(ActionGoalError);
    expect(err.reason).toBe('unavailable');
    expect(err.detail).toContain('include_hidden');
  });

  it('dispatches send_goal with a fresh 16-byte v4 uuid and the goal payload, and watches status', async () => {
    const { client, socket } = await connectedWithAction();

    const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {
      target_id: 3,
    });
    expect(typeof handle.cancel).toBe('function');

    const sendGoal = sentCalls(socket).find((c) => c.serviceId === SEND_GOAL_ID);
    expect(sendGoal).toBeDefined();
    expect(sendGoal?.encoding).toBe('cdr');

    const reader = new MessageReader(parseRosMsgDef(SEND_GOAL_REQ, { ros2: true }));
    const decoded = reader.readMessage(sendGoal!.payload) as {
      goal_id: { uuid: Uint8Array };
      goal: { target_id: number };
    };
    expect(decoded.goal.target_id).toBe(3);
    expect(decoded.goal_id.uuid.length).toBe(16);
    // RFC 4122 v4 bit layout, and not the all-zero uuid (which means
    // "cancel everything" in CancelGoal and must never be a goal id).
    expect(decoded.goal_id.uuid[6]! & 0xf0).toBe(0x40);
    expect(Array.from(decoded.goal_id.uuid).some((b) => b !== 0)).toBe(true);

    // The status watch is established at dispatch, before any response.
    expect(subscriptionIdFor(socket, STATUS_CHANNEL)).toBeDefined();
    // No feedback callback was supplied: the feedback topic is not subscribed.
    expect(subscriptionIdFor(socket, FEEDBACK_CHANNEL)).toBeUndefined();
  });

  it('rejects with reason "rejected" when the server declines the goal', async () => {
    const { client, socket } = await connectedWithAction();

    const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
    const sendGoal = sentCalls(socket).find((c) => c.serviceId === SEND_GOAL_ID)!;
    respond(socket, sendGoal, SEND_GOAL_RESP, {
      accepted: false,
      stamp: { sec: 0, nanosec: 0 },
    });

    const err = (await handle.outcome.then(
      () => null,
      (e: unknown) => e,
    )) as ActionGoalError;
    expect(err.reason).toBe('rejected');
  });

  it('arms a standing get_result on the first status frame naming the goal, and resolves when it answers', async () => {
    const { client, socket } = await connectedWithAction();

    const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {
      target_id: 3,
    });
    const sendGoal = sentCalls(socket).find((c) => c.serviceId === SEND_GOAL_ID)!;
    const reader = new MessageReader(parseRosMsgDef(SEND_GOAL_REQ, { ros2: true }));
    const uuid = (reader.readMessage(sendGoal.payload) as { goal_id: { uuid: Uint8Array } })
      .goal_id.uuid;

    respond(socket, sendGoal, SEND_GOAL_RESP, { accepted: true, stamp: { sec: 0, nanosec: 0 } });
    await flush();

    // Acceptance alone must not arm the standing request: the rclcpp server
    // registers the goal only after sending the goal response, so a
    // get_result fired here can draw a spurious STATUS_UNKNOWN for a
    // healthy goal.
    expect(sentCalls(socket).filter((c) => c.serviceId === GET_RESULT_ID).length).toBe(0);

    const statusSubId = subscriptionIdFor(socket, STATUS_CHANNEL)!;

    // The first status frame naming our UUID — non-terminal — arms the
    // standing request. Its answer arrives at the terminal transition,
    // before the server's expiry clock can evict the goal.
    socket.simulateMessage(statusFrame(statusSubId, uuid, 2));
    const afterFirstNaming = sentCalls(socket).filter((c) => c.serviceId === GET_RESULT_ID);
    expect(afterFirstNaming.length).toBe(1);

    // Further frames naming the goal, terminal included, must not
    // re-request: the terminal signal is the ANSWER to the standing
    // request, not a fetch triggered by the status topic.
    socket.simulateMessage(statusFrame(statusSubId, uuid, 2));
    socket.simulateMessage(statusFrame(statusSubId, uuid, 4));
    expect(sentCalls(socket).filter((c) => c.serviceId === GET_RESULT_ID).length).toBe(1);

    respond(socket, afterFirstNaming[0]!, GET_RESULT_RESP, {
      status: 4,
      result: { docked: true },
    });

    await expect(handle.outcome).resolves.toEqual({ status: 4, result: { docked: true } });

    // Settling releases the internal status watch.
    const unsubOps = socket.sentJson.filter((m) => m.op === 'unsubscribe') as Array<{
      subscriptionIds: number[];
    }>;
    expect(unsubOps.some((op) => op.subscriptionIds.includes(statusSubId))).toBe(true);
  });

  it('the standing get_result does not ride the 30 s public service timer', async () => {
    const { client, socket } = await connectedWithAction();

    const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
    const sendGoal = sentCalls(socket).find((c) => c.serviceId === SEND_GOAL_ID)!;
    const uuid = (
      new MessageReader(parseRosMsgDef(SEND_GOAL_REQ, { ros2: true })).readMessage(
        sendGoal.payload,
      ) as { goal_id: { uuid: Uint8Array } }
    ).goal_id.uuid;
    respond(socket, sendGoal, SEND_GOAL_RESP, { accepted: true, stamp: { sec: 0, nanosec: 0 } });
    await flush();

    const statusSubId = subscriptionIdFor(socket, STATUS_CHANNEL)!;

    const { vi } = await import('vitest');
    vi.useFakeTimers();
    try {
      socket.simulateMessage(statusFrame(statusSubId, uuid, 2));
      expect(sentCalls(socket).filter((c) => c.serviceId === GET_RESULT_ID).length).toBe(1);
      // A goal outliving the public callService default (30 s) must leave
      // the standing request in flight — this is the designed-out ceiling.
      vi.advanceTimersByTime(31_000);
    } finally {
      vi.useRealTimers();
    }

    let settledAs: 'resolved' | 'rejected' | null = null;
    void handle.outcome.then(
      () => (settledAs = 'resolved'),
      () => (settledAs = 'rejected'),
    );
    await flush();
    expect(settledAs).toBeNull();

    const standing = sentCalls(socket).find((c) => c.serviceId === GET_RESULT_ID)!;
    respond(socket, standing, GET_RESULT_RESP, { status: 4, result: { docked: true } });
    await expect(handle.outcome).resolves.toEqual({ status: 4, result: { docked: true } });
  });

  it('classifies eviction: absence after observation probes get_result, resolves {status: 0} on the UNKNOWN answer', async () => {
    const { client, socket } = await connectedWithAction();

    const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
    const sendGoal = sentCalls(socket).find((c) => c.serviceId === SEND_GOAL_ID)!;
    const uuid = (
      new MessageReader(parseRosMsgDef(SEND_GOAL_REQ, { ros2: true })).readMessage(
        sendGoal.payload,
      ) as { goal_id: { uuid: Uint8Array } }
    ).goal_id.uuid;
    respond(socket, sendGoal, SEND_GOAL_RESP, { accepted: true, stamp: { sec: 0, nanosec: 0 } });
    await flush();

    const statusSubId = subscriptionIdFor(socket, STATUS_CHANNEL)!;
    socket.simulateMessage(statusFrame(statusSubId, uuid, 2));
    expect(sentCalls(socket).filter((c) => c.serviceId === GET_RESULT_ID).length).toBe(1);

    // Eviction publishes nothing; the absence surfaces when ANOTHER goal's
    // transition publishes an array that no longer names ours.
    const foreign = Array.from({ length: 16 }, (_, i) => i + 1);
    socket.simulateMessage(statusFrame(statusSubId, foreign, 4));

    const calls = sentCalls(socket).filter((c) => c.serviceId === GET_RESULT_ID);
    expect(calls.length).toBe(2);

    // The server's own disowning answer: STATUS_UNKNOWN, zero-filled result.
    respond(socket, calls[1]!, GET_RESULT_RESP, { status: 0, result: { docked: false } });
    await expect(handle.outcome).resolves.toEqual({ status: 0, result: { docked: false } });
  });

  it('a probe answered with a real terminal resolves normally', async () => {
    const { client, socket } = await connectedWithAction();

    const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
    const sendGoal = sentCalls(socket).find((c) => c.serviceId === SEND_GOAL_ID)!;
    const uuid = (
      new MessageReader(parseRosMsgDef(SEND_GOAL_REQ, { ros2: true })).readMessage(
        sendGoal.payload,
      ) as { goal_id: { uuid: Uint8Array } }
    ).goal_id.uuid;
    respond(socket, sendGoal, SEND_GOAL_RESP, { accepted: true, stamp: { sec: 0, nanosec: 0 } });
    await flush();

    const statusSubId = subscriptionIdFor(socket, STATUS_CHANNEL)!;
    socket.simulateMessage(statusFrame(statusSubId, uuid, 2));
    const foreign = Array.from({ length: 16 }, (_, i) => i + 1);
    socket.simulateMessage(statusFrame(statusSubId, foreign, 4));

    const calls = sentCalls(socket).filter((c) => c.serviceId === GET_RESULT_ID);
    expect(calls.length).toBe(2);

    // A stale array can omit a goal the server still owns; the probe's
    // answer is the authority. Here it comes back with a real terminal.
    respond(socket, calls[1]!, GET_RESULT_RESP, { status: 4, result: { docked: true } });
    await expect(handle.outcome).resolves.toEqual({ status: 4, result: { docked: true } });
  });

  it('reappearance after absence self-corrects, and a later absence probes again', async () => {
    const { client, socket } = await connectedWithAction();

    const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
    const sendGoal = sentCalls(socket).find((c) => c.serviceId === SEND_GOAL_ID)!;
    const uuid = (
      new MessageReader(parseRosMsgDef(SEND_GOAL_REQ, { ros2: true })).readMessage(
        sendGoal.payload,
      ) as { goal_id: { uuid: Uint8Array } }
    ).goal_id.uuid;
    respond(socket, sendGoal, SEND_GOAL_RESP, { accepted: true, stamp: { sec: 0, nanosec: 0 } });
    await flush();

    const statusSubId = subscriptionIdFor(socket, STATUS_CHANNEL)!;
    const foreign = Array.from({ length: 16 }, (_, i) => i + 1);
    const getResultCalls = (): ParsedServiceCallRequest[] =>
      sentCalls(socket).filter((c) => c.serviceId === GET_RESULT_ID);

    socket.simulateMessage(statusFrame(statusSubId, uuid, 2)); // observe + arm standing
    expect(getResultCalls().length).toBe(1);
    socket.simulateMessage(statusFrame(statusSubId, foreign, 4)); // absence -> probe
    expect(getResultCalls().length).toBe(2);

    // The goal reappears: absence withdrawn, nothing new dispatched.
    socket.simulateMessage(statusFrame(statusSubId, uuid, 2));
    expect(getResultCalls().length).toBe(2);

    // The probe comes back inconclusive (not UNKNOWN, not terminal): it must
    // not settle anything.
    respond(socket, getResultCalls()[1]!, GET_RESULT_RESP, {
      status: 2,
      result: { docked: false },
    });
    let settledAs: 'resolved' | 'rejected' | null = null;
    void handle.outcome.then(
      () => (settledAs = 'resolved'),
      () => (settledAs = 'rejected'),
    );
    await flush();
    expect(settledAs).toBeNull();

    // A second absence after reappearance is a fresh episode: probe again.
    socket.simulateMessage(statusFrame(statusSubId, foreign, 4));
    expect(getResultCalls().length).toBe(3);

    // The standing request (armed first) answers at terminal and wins.
    respond(socket, getResultCalls()[0]!, GET_RESULT_RESP, { status: 4, result: { docked: true } });
    await expect(handle.outcome).resolves.toEqual({ status: 4, result: { docked: true } });
  });

  it('a goal with no status evidence stays pending: no probe, no deadline', async () => {
    const { client, socket } = await connectedWithAction();

    const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
    const sendGoal = sentCalls(socket).find((c) => c.serviceId === SEND_GOAL_ID)!;
    respond(socket, sendGoal, SEND_GOAL_RESP, { accepted: true, stamp: { sec: 0, nanosec: 0 } });
    await flush();

    const { vi } = await import('vitest');
    vi.useFakeTimers();
    try {
      // A server that dies without ever publishing status produces no
      // positive evidence; the library never times a goal out.
      vi.advanceTimersByTime(40_000);
    } finally {
      vi.useRealTimers();
    }

    let settledAs: 'resolved' | 'rejected' | null = null;
    void handle.outcome.then(
      () => (settledAs = 'resolved'),
      () => (settledAs = 'rejected'),
    );
    await flush();
    expect(settledAs).toBeNull();
    expect(sentCalls(socket).filter((c) => c.serviceId === GET_RESULT_ID).length).toBe(0);
  });

  it('classifies absence via the churn-replay latch: a restarted server resolves {status: 0}', async () => {
    const { client, socket } = await connectedWithAction();

    const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
    const sendGoal = sentCalls(socket).find((c) => c.serviceId === SEND_GOAL_ID)!;
    const uuid = (
      new MessageReader(parseRosMsgDef(SEND_GOAL_REQ, { ros2: true })).readMessage(
        sendGoal.payload,
      ) as { goal_id: { uuid: Uint8Array } }
    ).goal_id.uuid;
    respond(socket, sendGoal, SEND_GOAL_RESP, { accepted: true, stamp: { sec: 0, nanosec: 0 } });
    await flush();

    const statusSubId = subscriptionIdFor(socket, STATUS_CHANNEL)!;
    socket.simulateMessage(statusFrame(statusSubId, uuid, 2));
    expect(sentCalls(socket).filter((c) => c.serviceId === GET_RESULT_ID).length).toBe(1);

    // Server restart: the bridge churns the status channel to a new id and
    // the fresh server's transient_local latch replays an array that does
    // not name our goal.
    socket.simulateMessage(JSON.stringify({ op: 'unadvertise', channelIds: [STATUS_CHANNEL] }));
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertise',
        channels: [
          {
            id: 16,
            topic: '/dock/_action/status',
            encoding: 'cdr',
            schemaName: 'action_msgs/msg/GoalStatusArray',
            schemaEncoding: 'ros2msg',
            schema: STATUS_ARRAY,
          },
        ],
      }),
    );
    const renewedSubId = subscriptionIdFor(socket, 16);
    expect(renewedSubId).toBeDefined();

    socket.simulateMessage(statusArrayFrame(renewedSubId!, []));

    const calls = sentCalls(socket).filter((c) => c.serviceId === GET_RESULT_ID);
    expect(calls.length).toBe(2);
    respond(socket, calls[1]!, GET_RESULT_RESP, { status: 0, result: { docked: false } });
    await expect(handle.outcome).resolves.toEqual({ status: 0, result: { docked: false } });
  });

  it('an undecodable standing answer defers to the watch: the terminal frame supplies the status', async () => {
    // The bridge advertises get_result with NO response schema (schemaless
    // advertisement); the answer surfaces as {rawBytes} with no status
    // field, so the watch's terminal frame must supply it.
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
            '/dock/_action/send_goal',
            'my_robot_interfaces/action/Dock_SendGoal',
            SEND_GOAL_REQ,
            SEND_GOAL_RESP,
          ),
          {
            id: GET_RESULT_ID,
            name: '/dock/_action/get_result',
            type: 'my_robot_interfaces/action/Dock_GetResult',
            request: {
              encoding: 'cdr',
              schemaName: 'my_robot_interfaces/action/Dock_GetResult_Request',
              schemaEncoding: 'ros2msg',
              schema: GET_RESULT_REQ,
            },
            // no response schema
          },
        ],
      }),
    );
    await connectPromise;

    const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
    const sendGoal = sentCalls(socket).find((c) => c.serviceId === SEND_GOAL_ID)!;
    const uuid = (
      new MessageReader(parseRosMsgDef(SEND_GOAL_REQ, { ros2: true })).readMessage(
        sendGoal.payload,
      ) as { goal_id: { uuid: Uint8Array } }
    ).goal_id.uuid;
    respond(socket, sendGoal, SEND_GOAL_RESP, { accepted: true, stamp: { sec: 0, nanosec: 0 } });
    await flush();

    const statusSubId = subscriptionIdFor(socket, STATUS_CHANNEL)!;
    socket.simulateMessage(statusFrame(statusSubId, uuid, 2));
    const standing = sentCalls(socket).find((c) => c.serviceId === GET_RESULT_ID)!;

    // The answer arrives while the last named status is still EXECUTING:
    // undecodable, so it must not settle yet.
    respond(socket, standing, GET_RESULT_RESP, { status: 4, result: { docked: true } });
    let settledAs: 'resolved' | 'rejected' | null = null;
    void handle.outcome.then(
      () => (settledAs = 'resolved'),
      () => (settledAs = 'rejected'),
    );
    await flush();
    expect(settledAs).toBeNull();

    // The terminal frame lands: its status settles the held answer.
    socket.simulateMessage(statusFrame(statusSubId, uuid, 4));
    await expect(handle.outcome).resolves.toEqual({ status: 4, result: {} });
  });

  it('a foreign goal in the status array does not trigger get_result', async () => {
    const { client, socket } = await connectedWithAction();

    client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
    const statusSubId = subscriptionIdFor(socket, STATUS_CHANNEL)!;

    const foreign = Array.from({ length: 16 }, (_, i) => i + 1);
    socket.simulateMessage(statusFrame(statusSubId, foreign, 4));

    expect(sentCalls(socket).find((c) => c.serviceId === GET_RESULT_ID)).toBeUndefined();
  });

  it('cancel() sends CancelGoal carrying our uuid, and is a no-op after terminal', async () => {
    const { client, socket } = await connectedWithAction();

    const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
    const sendGoal = sentCalls(socket).find((c) => c.serviceId === SEND_GOAL_ID)!;
    const uuid = (
      new MessageReader(parseRosMsgDef(SEND_GOAL_REQ, { ros2: true })).readMessage(
        sendGoal.payload,
      ) as { goal_id: { uuid: Uint8Array } }
    ).goal_id.uuid;

    handle.cancel();

    const cancel = sentCalls(socket).find((c) => c.serviceId === CANCEL_ID);
    expect(cancel).toBeDefined();
    const decoded = new MessageReader(parseRosMsgDef(CANCEL_REQ, { ros2: true })).readMessage(
      cancel!.payload,
    ) as { goal_info: { goal_id: { uuid: Uint8Array }; stamp: { sec: number } } };
    expect(Array.from(decoded.goal_info.goal_id.uuid)).toEqual(Array.from(uuid));
    expect(decoded.goal_info.stamp.sec).toBe(0);

    // Server confirms through the status watch: CANCELED.
    const statusSubId = subscriptionIdFor(socket, STATUS_CHANNEL)!;
    socket.simulateMessage(statusFrame(statusSubId, uuid, 5));
    const getResult = sentCalls(socket).find((c) => c.serviceId === GET_RESULT_ID)!;
    respond(socket, getResult, GET_RESULT_RESP, { status: 5, result: { docked: false } });
    await expect(handle.outcome).resolves.toEqual({ status: 5, result: { docked: false } });

    // After terminal, cancel() sends nothing further.
    const cancelCountBefore = sentCalls(socket).filter((c) => c.serviceId === CANCEL_ID).length;
    handle.cancel();
    expect(sentCalls(socket).filter((c) => c.serviceId === CANCEL_ID).length).toBe(
      cancelCountBefore,
    );
  });

  it('routes feedback for our goal only, and releases the feedback sub at terminal', async () => {
    const { client, socket } = await connectedWithAction();

    const received: Array<Record<string, unknown>> = [];
    const handle = client.sendActionGoal(
      '/dock',
      'my_robot_interfaces/action/Dock',
      {},
      { onFeedback: (fb) => received.push(fb) },
    );
    const sendGoal = sentCalls(socket).find((c) => c.serviceId === SEND_GOAL_ID)!;
    const uuid = (
      new MessageReader(parseRosMsgDef(SEND_GOAL_REQ, { ros2: true })).readMessage(
        sendGoal.payload,
      ) as { goal_id: { uuid: Uint8Array } }
    ).goal_id.uuid;

    const feedbackSubId = subscriptionIdFor(socket, FEEDBACK_CHANNEL);
    expect(feedbackSubId).toBeDefined();

    const feedbackFrame = (goalUuid: ArrayLike<number>, progress: number): ArrayBuffer => {
      const bytes = new MessageWriter(parseRosMsgDef(FEEDBACK_MSG, { ros2: true })).writeMessage({
        goal_id: { uuid: Array.from(goalUuid) },
        feedback: { progress },
      });
      return foxgloveMessageDataFrame(feedbackSubId!, 0n, bytes);
    };

    // The internal feedback sub is `latest-only`, so delivery defers to the
    // throttle window (the adaptive floor boots non-zero) and a burst
    // conflates to its newest frame BEFORE the uuid filter runs — that is
    // the best-effort contract. Deliver one frame per window so each
    // survivor reaches the filter.
    const { vi } = await import('vitest');
    vi.useFakeTimers();
    try {
      socket.simulateMessage(feedbackFrame(uuid, 0.25));
      vi.advanceTimersByTime(600);
      const foreign = Array.from({ length: 16 }, (_, i) => 255 - i);
      socket.simulateMessage(feedbackFrame(foreign, 0.99));
      vi.advanceTimersByTime(600);
    } finally {
      vi.useRealTimers();
    }

    expect(received.length).toBe(1);
    expect(received[0]?.progress).toBeCloseTo(0.25);

    // Terminal: the internal feedback subscription is released too.
    const statusSubId = subscriptionIdFor(socket, STATUS_CHANNEL)!;
    socket.simulateMessage(statusFrame(statusSubId, uuid, 4));
    const getResult = sentCalls(socket).find((c) => c.serviceId === GET_RESULT_ID)!;
    respond(socket, getResult, GET_RESULT_RESP, { status: 4, result: { docked: true } });
    await handle.outcome;

    const unsubOps = socket.sentJson.filter((m) => m.op === 'unsubscribe') as Array<{
      subscriptionIds: number[];
    }>;
    expect(unsubOps.some((op) => op.subscriptionIds.includes(feedbackSubId!))).toBe(true);
  });

  it('rejects in-flight goals with reason "disconnected" when the connection closes mid-goal', async () => {
    const { client, socket } = await connectedWithAction();

    const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
    const observed = handle.outcome.then(
      () => null,
      (e: unknown) => e,
    );

    socket.simulateClose();

    const err = (await observed) as ActionGoalError;
    expect(err).toBeInstanceOf(ActionGoalError);
    expect(err.reason).toBe('disconnected');
  });

  it('matches a base64-encoded uuid from a JSON status channel', async () => {
    const client = new FoxgloveClient();
    const connectPromise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    // A JSON-encoded status channel: byte arrays arrive base64-packed.
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
            'my_robot_interfaces/action/Dock_SendGoal',
            SEND_GOAL_REQ,
            SEND_GOAL_RESP,
          ),
          svc(
            GET_RESULT_ID,
            '/dock/_action/get_result',
            'my_robot_interfaces/action/Dock_GetResult',
            GET_RESULT_REQ,
            GET_RESULT_RESP,
          ),
        ],
      }),
    );
    await connectPromise;

    const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
    const sendGoal = sentCalls(socket).find((c) => c.serviceId === SEND_GOAL_ID)!;
    const uuid = (
      new MessageReader(parseRosMsgDef(SEND_GOAL_REQ, { ros2: true })).readMessage(
        sendGoal.payload,
      ) as { goal_id: { uuid: Uint8Array } }
    ).goal_id.uuid;

    const statusSubId = subscriptionIdFor(socket, STATUS_CHANNEL)!;
    let b64 = '';
    {
      let s = '';
      for (const b of uuid) s += String.fromCharCode(b);
      b64 = btoa(s);
    }
    const payload = new TextEncoder().encode(
      JSON.stringify({
        status_list: [
          { goal_info: { goal_id: { uuid: b64 }, stamp: { sec: 0, nanosec: 0 } }, status: 4 },
        ],
      }),
    );
    socket.simulateMessage(foxgloveMessageDataFrame(statusSubId, 0n, payload));

    const getResult = sentCalls(socket).find((c) => c.serviceId === GET_RESULT_ID);
    expect(getResult).toBeDefined();
    respond(socket, getResult!, GET_RESULT_RESP, { status: 4, result: { docked: true } });
    await expect(handle.outcome).resolves.toEqual({ status: 4, result: { docked: true } });
  });

  it('survives an action-server restart mid-goal: status returns under a new channel id', async () => {
    const { client, socket } = await connectedWithAction();

    const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
    const sendGoal = sentCalls(socket).find((c) => c.serviceId === SEND_GOAL_ID)!;
    const uuid = (
      new MessageReader(parseRosMsgDef(SEND_GOAL_REQ, { ros2: true })).readMessage(
        sendGoal.payload,
      ) as { goal_id: { uuid: Uint8Array } }
    ).goal_id.uuid;
    respond(socket, sendGoal, SEND_GOAL_RESP, { accepted: true, stamp: { sec: 0, nanosec: 0 } });
    await flush();

    // The bridge drops and re-advertises the status channel under a NEW id
    // (measured churn: 12/14 -> 16/17).
    socket.simulateMessage(JSON.stringify({ op: 'unadvertise', channelIds: [STATUS_CHANNEL] }));
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertise',
        channels: [
          {
            id: 16,
            topic: '/dock/_action/status',
            encoding: 'cdr',
            schemaName: 'action_msgs/msg/GoalStatusArray',
            schemaEncoding: 'ros2msg',
            schema: STATUS_ARRAY,
          },
        ],
      }),
    );

    const renewedSubId = subscriptionIdFor(socket, 16);
    expect(renewedSubId).toBeDefined();

    // The terminal frame arrives on the NEW channel and still resolves.
    socket.simulateMessage(statusFrame(renewedSubId!, uuid, 4));
    const getResult = sentCalls(socket).find((c) => c.serviceId === GET_RESULT_ID)!;
    respond(socket, getResult, GET_RESULT_RESP, { status: 4, result: { docked: true } });
    await expect(handle.outcome).resolves.toEqual({ status: 4, result: { docked: true } });
  });
});
