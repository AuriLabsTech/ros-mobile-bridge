import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

/**
 * HYPOTHETICAL SCHEMA, not a capture: a `_SendGoal_Request` whose root carries
 * the goal as a complex member. `rosidl` does not generate this shape — it
 * inlines the goal's fields at the root, which is what every captured schema
 * in `tests/fixtures/` shows — and this suite was green against the wrong
 * shape for exactly that reason until 0.1.12.
 *
 * It stays because the encoder is schema-driven and this is the branch that
 * pins the nested case. The flat shape, against real captured schemas, is
 * covered in `tests/FoxgloveClient.sendGoalShape.test.ts`.
 */
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

/**
 * How `foxglove_bridge` actually advertises a GetResult response: the
 * action result's own fields are inlined at the top level, with no `MSG:`
 * separator and no `result` member. Measured on a live rig against
 * `nav2_msgs/action/NavigateToPose_GetResult_Response`.
 */
const GET_RESULT_RESP_FLAT = [
  'int8 status',
  '#result definition',
  'bool docked',
  'uint16 error_code',
  'string error_msg',
  '',
].join('\n');

/** The same flattening, for an action whose result declares no fields. */
const GET_RESULT_RESP_FLAT_FIELDLESS = ['int8 status', '#result definition', ''].join('\n');

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

/**
 * The same feedback message as a live bridge advertises it: the action's own
 * `_Feedback` fields inlined at the root beside `goal_id`, with a comment
 * where a `MSG:` separator would go and no `feedback` member. Ordinary
 * message types keep their sections, which is why `goal_id` is still a
 * complex reference here. Shape taken from a tap of
 * `nav2_msgs/action/NavigateToPose_FeedbackMessage`.
 */
const FEEDBACK_MSG_FLAT = [
  'unique_identifier_msgs/UUID goal_id',
  '#feedback definition',
  'float32 progress',
  'string stage',
  SEP,
  UUID_CHAIN,
  '',
].join('\n');

/** The same flattening, for an action whose feedback declares no fields. */
const FEEDBACK_MSG_FLAT_FIELDLESS = [
  'unique_identifier_msgs/UUID goal_id',
  '#feedback definition',
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

  async function connectedWithAction(opts?: {
    hidden?: boolean;
    getResultResp?: string;
    feedbackSchema?: string;
  }): Promise<{
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
                  schema: opts?.feedbackSchema ?? FEEDBACK_MSG,
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
              opts?.getResultResp ?? GET_RESULT_RESP,
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
    expect(() => client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {})).toThrow(
      'Not connected',
    );
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
    const uuid = (reader.readMessage(sendGoal.payload) as { goal_id: { uuid: Uint8Array } }).goal_id
      .uuid;

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

  /**
   * A live bridge inlines the action-generated wrapper types (`_Goal`,
   * `_Feedback`, `_Result`) into the root of the type that carries them, so
   * the decoded feedback record has no `feedback` member and the fields sit
   * beside `goal_id`. Reading `rec.feedback` there yields `undefined` and
   * every frame reaches the consumer as `{}` — 895 frames over an 89 s goal,
   * measured on a device against a bridge on `foxglove-sdk-cpp/v0.25.1`,
   * while status and the terminal stayed healthy because they ride ordinary
   * `action_msgs` types that keep their `MSG:` sections.
   *
   * Delivery follows the same evidence rule the GetResult lift uses (ADR
   * 0011): the decoded record's own shape is the schema's answer, because
   * the reader populates every member the definition declares.
   *
   * The nested case is covered by the routing test above, which asserts
   * `progress` on the delivered object and so fails if the flat branch ever
   * runs unconditionally.
   */
  it('delivers the feedback fields when the bridge inlines them at the root', async () => {
    const { client, socket } = await connectedWithAction({ feedbackSchema: FEEDBACK_MSG_FLAT });

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

    const feedbackSubId = subscriptionIdFor(socket, FEEDBACK_CHANNEL)!;
    const bytes = new MessageWriter(parseRosMsgDef(FEEDBACK_MSG_FLAT, { ros2: true })).writeMessage(
      {
        goal_id: { uuid: Array.from(uuid) },
        progress: 0.25,
        stage: 'approach',
      },
    );

    const { vi } = await import('vitest');
    vi.useFakeTimers();
    try {
      socket.simulateMessage(foxgloveMessageDataFrame(feedbackSubId, 0n, bytes));
      vi.advanceTimersByTime(600);
    } finally {
      vi.useRealTimers();
    }

    expect(received.length).toBe(1);
    expect(received[0]?.progress).toBeCloseTo(0.25);
    expect(received[0]?.stage).toBe('approach');
    // The correlation key is the client's own bookkeeping, not robot data.
    expect(received[0]).not.toHaveProperty('goal_id');

    handle.cancel();
  });

  it('delivers an empty object for inlined feedback that declares no fields', async () => {
    const { client, socket } = await connectedWithAction({
      feedbackSchema: FEEDBACK_MSG_FLAT_FIELDLESS,
    });

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

    const feedbackSubId = subscriptionIdFor(socket, FEEDBACK_CHANNEL)!;
    const bytes = new MessageWriter(
      parseRosMsgDef(FEEDBACK_MSG_FLAT_FIELDLESS, { ros2: true }),
    ).writeMessage({ goal_id: { uuid: Array.from(uuid) } });

    const { vi } = await import('vitest');
    vi.useFakeTimers();
    try {
      socket.simulateMessage(foxgloveMessageDataFrame(feedbackSubId, 0n, bytes));
      vi.advanceTimersByTime(600);
    } finally {
      vi.useRealTimers();
    }

    // A frame arrived and was routed: acceptance is settled from it even
    // though it carries no fields (ADR 0010's discipline, on this path).
    expect(received.length).toBe(1);
    expect(received[0]).toEqual({});
    await expect(handle.acceptance).resolves.toBe('accepted');

    handle.cancel();
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

  it('a lost send_goal answer resolves normally once the status watch has named the goal', async () => {
    const { client, socket } = await connectedWithAction();
    const { vi } = await import('vitest');

    // Fake timers are installed BEFORE the dispatch on purpose: the deadline
    // under test is armed inside sendActionGoal, and a timer scheduled under
    // real timers cannot be advanced afterwards.
    vi.useFakeTimers();
    try {
      const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
      const sendGoal = sentCalls(socket).find((c) => c.serviceId === SEND_GOAL_ID)!;
      const uuid = (
        new MessageReader(parseRosMsgDef(SEND_GOAL_REQ, { ros2: true })).readMessage(
          sendGoal.payload,
        ) as { goal_id: { uuid: Uint8Array } }
      ).goal_id.uuid;

      // The measured failure, roughly one restart run in seven: the server
      // accepted the goal and is executing it, and the send_goal response for
      // this call id never comes back. Nothing answers it in this test.
      const statusSubId = subscriptionIdFor(socket, STATUS_CHANNEL)!;
      socket.simulateMessage(statusFrame(statusSubId, uuid, 2));

      await vi.advanceTimersByTimeAsync(31_000);

      // The standing request armed by the status frame is the result channel;
      // the missing dispatch answer never mattered.
      const standing = sentCalls(socket).find((c) => c.serviceId === GET_RESULT_ID)!;
      respond(socket, standing, GET_RESULT_RESP, { status: 4, result: { docked: true } });
      await expect(handle.outcome).resolves.toEqual({ status: 4, result: { docked: true } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a precise bridge failure naming the dispatch is outranked by status evidence', async () => {
    const { client, socket } = await connectedWithAction();

    const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
    const sendGoal = sentCalls(socket).find((c) => c.serviceId === SEND_GOAL_ID)!;
    const uuid = (
      new MessageReader(parseRosMsgDef(SEND_GOAL_REQ, { ros2: true })).readMessage(
        sendGoal.payload,
      ) as { goal_id: { uuid: Uint8Array } }
    ).goal_id.uuid;

    // The action server has named the goal: it exists and is running. The
    // goal id was invented here before the request was sent, so a status
    // frame naming it proves the request reached the server.
    const statusSubId = subscriptionIdFor(socket, STATUS_CHANNEL)!;
    socket.simulateMessage(statusFrame(statusSubId, uuid, 2));

    // The bridge now reports that it could not handle our request. That is
    // the bridge speaking about its own handling, not the server speaking
    // about the goal, and the server outranks it.
    socket.simulateMessage(
      JSON.stringify({
        op: 'serviceCallFailure',
        callId: sendGoal.callId,
        message: 'Failed to decode the service response',
      }),
    );

    let settledAs: 'resolved' | 'rejected' | null = null;
    void handle.outcome.then(
      () => (settledAs = 'resolved'),
      () => (settledAs = 'rejected'),
    );
    await flush();
    expect(settledAs).toBeNull();

    // And the goal still ends through the standing request, as if the
    // failure frame had never arrived.
    const standing = sentCalls(socket).find((c) => c.serviceId === GET_RESULT_ID)!;
    respond(socket, standing, GET_RESULT_RESP, { status: 4, result: { docked: true } });
    await expect(handle.outcome).resolves.toEqual({ status: 4, result: { docked: true } });
  });

  it('a precise bridge failure before any status evidence still rejects the goal', async () => {
    const { client, socket } = await connectedWithAction();

    const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
    const sendGoal = sentCalls(socket).find((c) => c.serviceId === SEND_GOAL_ID)!;

    // No status frame has named the goal. A request the bridge failed to
    // forward never reached the server, so no status frame ever will.
    socket.simulateMessage(
      JSON.stringify({
        op: 'serviceCallFailure',
        callId: sendGoal.callId,
        message: 'Unsupported encoding',
      }),
    );

    const err = (await handle.outcome.then(
      () => null,
      (e: unknown) => e,
    )) as ActionGoalError;
    expect(err).toBeInstanceOf(ActionGoalError);
    expect(err.reason).toBe('server-error');
    expect(err.detail).toContain('Unsupported encoding');
  });

  it('a level-2 status broadcast fails ordinary calls without touching the goal', async () => {
    const { client, socket } = await connectedWithAction();

    // An unrelated service, in flight at the same time as the goal.
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertiseServices',
        services: [
          svc(31, '/lights/toggle', 'std_srvs/srv/SetBool', 'bool data\n', 'bool success\n'),
        ],
      }),
    );

    const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
    const ordinary = client.callService('/lights/toggle', { data: true });

    let settledAs: 'resolved' | 'rejected' | null = null;
    void handle.outcome.then(
      () => (settledAs = 'resolved'),
      () => (settledAs = 'rejected'),
    );

    // A level-2 status carries no call id: it is the bridge complaining
    // about some service call, with no way to say which. It fails the calls
    // the consumer is waiting on, and makes no claim about our goal.
    socket.simulateMessage(
      JSON.stringify({
        op: 'status',
        level: 2,
        message: 'Failed to parse serviceCallRequest: unsupported encoding',
      }),
    );

    await expect(ordinary).rejects.toThrow(/Bridge rejected service call/);
    await flush();
    expect(settledAs).toBeNull();
  });

  it('a send_goal answer that never arrives leaves the goal pending, with or without evidence', async () => {
    const { client } = await connectedWithAction();
    const { vi } = await import('vitest');

    vi.useFakeTimers();
    try {
      const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
      let settledAs: 'resolved' | 'rejected' | null = null;
      void handle.outcome.then(
        () => (settledAs = 'resolved'),
        () => (settledAs = 'rejected'),
      );

      // No dispatch answer and no status frame: the library has no evidence
      // about this goal, and inventing a verdict from a clock is the thing
      // ADR 0009 removes.
      await vi.advanceTimersByTimeAsync(40_000);

      expect(settledAs).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a settled goal leaves no outstanding pending service calls', async () => {
    const { client, socket } = await connectedWithAction();

    const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
    const sendGoal = sentCalls(socket).find((c) => c.serviceId === SEND_GOAL_ID)!;
    const uuid = (
      new MessageReader(parseRosMsgDef(SEND_GOAL_REQ, { ros2: true })).readMessage(
        sendGoal.payload,
      ) as { goal_id: { uuid: Uint8Array } }
    ).goal_id.uuid;

    // The dispatch answer is lost, so that request is still outstanding when
    // the goal ends through the standing one. Unbounded requests have no
    // timer to clear them, so the goal has to dispose of them itself.
    const statusSubId = subscriptionIdFor(socket, STATUS_CHANNEL)!;
    socket.simulateMessage(statusFrame(statusSubId, uuid, 2));
    const standing = sentCalls(socket).find((c) => c.serviceId === GET_RESULT_ID)!;
    respond(socket, standing, GET_RESULT_RESP, { status: 4, result: { docked: true } });
    await expect(handle.outcome).resolves.toEqual({ status: 4, result: { docked: true } });

    // The only white-box assertion in this suite, and deliberate: the claim
    // is about accumulation, which has no projection on the public surface:
    // a leaked entry changes no outcome, sends no frame, and is invisible
    // until the process runs out of memory. Asserting it here is what stops
    // the accumulation from creeping back.
    const pendingCalls = (client as unknown as { pendingServiceCalls: Map<number, unknown> })
      .pendingServiceCalls;
    expect(pendingCalls.size).toBe(0);

    // The same invariant for the member added in 0.1.12: a settled goal
    // leaves nothing of itself pending, promises included.
    await expect(handle.acceptance).resolves.toBe('accepted');
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

  /**
   * `foxglove_bridge` inlines the action result's fields at the top level of
   * the GetResult response, so the decoded response carries no `result` key
   * and the fields were dropped on the floor. The lift is gated on a numeric
   * `status`, which is what separates a real GetResult answer from the two
   * responses the service path mints itself.
   */
  describe('flattened GetResult responses', () => {
    async function dispatchToStanding(
      client: FoxgloveClient,
      socket: ReturnType<MockWebSocketHandle['last']>,
    ) {
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
      return { handle, standing, statusSubId, uuid };
    }

    it('delivers a nested result unchanged', async () => {
      const { client, socket } = await connectedWithAction();
      const { handle, standing } = await dispatchToStanding(client, socket);

      respond(socket, standing, GET_RESULT_RESP, { status: 4, result: { docked: true } });

      await expect(handle.outcome).resolves.toEqual({ status: 4, result: { docked: true } });
    });

    it('lifts the fields of a flattened result the bridge inlined at the top level', async () => {
      const { client, socket } = await connectedWithAction({
        getResultResp: GET_RESULT_RESP_FLAT,
      });
      const { handle, standing } = await dispatchToStanding(client, socket);

      respond(socket, standing, GET_RESULT_RESP_FLAT, {
        status: 4,
        docked: true,
        error_code: 17,
        error_msg: 'goal aborted by the planner',
      });

      await expect(handle.outcome).resolves.toEqual({
        status: 4,
        result: { docked: true, error_code: 17, error_msg: 'goal aborted by the planner' },
      });
    });

    it('never lets the lift reach the authoritative status', async () => {
      const { client, socket } = await connectedWithAction({
        getResultResp: GET_RESULT_RESP_FLAT,
      });
      const { handle, standing } = await dispatchToStanding(client, socket);

      respond(socket, standing, GET_RESULT_RESP_FLAT, {
        status: 5,
        docked: false,
        error_code: 0,
        error_msg: '',
      });

      const outcome = await handle.outcome;
      expect(outcome.status).toBe(5);
      expect(outcome.result).not.toHaveProperty('status');
    });

    it('settles an empty result for an action whose flattened result declares no fields', async () => {
      const { client, socket } = await connectedWithAction({
        getResultResp: GET_RESULT_RESP_FLAT_FIELDLESS,
      });
      const { handle, standing } = await dispatchToStanding(client, socket);

      respond(socket, standing, GET_RESULT_RESP_FLAT_FIELDLESS, { status: 4 });

      await expect(handle.outcome).resolves.toEqual({ status: 4, result: {} });
    });

    it('never types a primitive "result" member as the result record', async () => {
      // HYPOTHETICAL SCHEMA, not a capture: an action whose result declares a
      // member of its own named `result`. Inlined, the root carries a
      // primitive under the wrapper's name, which no wrapper member can ever
      // be — a wrapper is a struct, and the reader always materializes it as
      // an object. So the primitive is a payload field and the response is
      // flat, and the same witness the lift uses answers that.
      //
      // Before 0.1.12-rc.3 the check here was `resp.result != null`, so the
      // boolean was handed to the consumer as `outcome.result`, typed
      // `Record<string, unknown>` and holding `true`.
      //
      // The colliding field itself is still lost, which is the tradeoff ADR
      // 0013 decision 6 takes for every name the envelope occupies.
      const PRIMITIVE_RESULT_RESP = [
        'int8 status',
        '#result definition',
        'bool result',
        'string label',
        '',
      ].join('\n');

      const { client, socket } = await connectedWithAction({
        getResultResp: PRIMITIVE_RESULT_RESP,
      });
      const { handle, standing } = await dispatchToStanding(client, socket);

      respond(socket, standing, PRIMITIVE_RESULT_RESP, {
        status: 4,
        result: true,
        label: 'bay-3',
      });

      const outcome = await handle.outcome;
      expect(outcome.status).toBe(4);
      expect(typeof outcome.result).toBe('object');
      expect(outcome.result).toEqual({ label: 'bay-3' });
    });

    it('does not lift the {success: true} a zero-length response mints', async () => {
      // The service path answers a zero-length CDR payload with a response it
      // invented, not with decoded fields. It carries no numeric status, so
      // the gate excludes it and the watch's terminal frame supplies the
      // status, exactly as it did before the lift existed.
      const { client, socket } = await connectedWithAction();
      const { handle, standing, statusSubId, uuid } = await dispatchToStanding(client, socket);

      socket.simulateMessage(
        foxgloveServiceCallResponseFrame(
          standing.serviceId,
          standing.callId,
          'cdr',
          new Uint8Array(0),
        ),
      );
      await flush();

      socket.simulateMessage(statusFrame(statusSubId, uuid, 4));

      await expect(handle.outcome).resolves.toEqual({ status: 4, result: {} });
    });
  });

  /**
   * `acceptance` (ADR 0012): the action server's decision to execute the
   * goal, reported on evidence and never on a clock. Foxglove carries the
   * fast source — the dispatch response's `bool accepted` — and two slower
   * ones that cover a lost response: a status entry naming the goal (the
   * server never registers a goal it refused, and the id was invented here
   * before dispatch, so naming it is positive proof) and any terminal
   * implying execution. It resolves `'unobservable'` when the goal ends with
   * no evidence of either kind, and it never rejects.
   */
  describe('acceptance', () => {
    it("resolves 'accepted' from the dispatch response", async () => {
      const { client, socket } = await connectedWithAction();

      const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
      const sendGoal = sentCalls(socket).find((c) => c.serviceId === SEND_GOAL_ID)!;
      respond(socket, sendGoal, SEND_GOAL_RESP, {
        accepted: true,
        stamp: { sec: 0, nanosec: 0 },
      });

      await expect(handle.acceptance).resolves.toBe('accepted');
    });

    it("resolves 'accepted' from a status entry when the dispatch response never arrives", async () => {
      // Fake timers are installed before the dispatch, so the goal's whole
      // life happens under them: a test that installs them afterwards proves
      // nothing about a deadline that was already armed.
      vi.useFakeTimers();
      try {
        const { client, socket } = await connectedWithAction();

        const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
        const sendGoal = sentCalls(socket).find((c) => c.serviceId === SEND_GOAL_ID)!;
        const uuid = (
          new MessageReader(parseRosMsgDef(SEND_GOAL_REQ, { ros2: true })).readMessage(
            sendGoal.payload,
          ) as { goal_id: { uuid: Uint8Array } }
        ).goal_id.uuid;

        // Far past the 30 s public service default this path used to inherit.
        await vi.advanceTimersByTimeAsync(600_000);

        const statusSubId = subscriptionIdFor(socket, STATUS_CHANNEL)!;
        socket.simulateMessage(statusFrame(statusSubId, uuid, 2));

        await expect(handle.acceptance).resolves.toBe('accepted');
      } finally {
        vi.useRealTimers();
      }
    });

    it("resolves 'rejected' when the server declines, and cannot skew from the outcome", async () => {
      const { client, socket } = await connectedWithAction();

      const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
      const sendGoal = sentCalls(socket).find((c) => c.serviceId === SEND_GOAL_ID)!;
      respond(socket, sendGoal, SEND_GOAL_RESP, {
        accepted: false,
        stamp: { sec: 0, nanosec: 0 },
      });

      await expect(handle.acceptance).resolves.toBe('rejected');

      // Both surfaces are driven by the server's one answer; the duplication
      // is only safe while they cannot disagree.
      const err = (await handle.outcome.then(
        () => null,
        (e: unknown) => e,
      )) as ActionGoalError;
      expect(err).toBeInstanceOf(ActionGoalError);
      expect(err.reason).toBe('rejected');
    });

    it("resolves 'accepted' from a terminal reached with no dispatch answer at all", async () => {
      const { client, socket } = await connectedWithAction();

      // The dispatch answer is never sent. The status frame alone arms the
      // standing get_result, and its terminal is the acceptance evidence.
      const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
      const sendGoal = sentCalls(socket).find((c) => c.serviceId === SEND_GOAL_ID)!;
      const uuid = (
        new MessageReader(parseRosMsgDef(SEND_GOAL_REQ, { ros2: true })).readMessage(
          sendGoal.payload,
        ) as { goal_id: { uuid: Uint8Array } }
      ).goal_id.uuid;

      const statusSubId = subscriptionIdFor(socket, STATUS_CHANNEL)!;
      socket.simulateMessage(statusFrame(statusSubId, uuid, 2));
      const standing = sentCalls(socket).find((c) => c.serviceId === GET_RESULT_ID)!;
      respond(socket, standing, GET_RESULT_RESP, { status: 4, result: { docked: true } });

      await expect(handle.outcome).resolves.toEqual({ status: 4, result: { docked: true } });
      await expect(handle.acceptance).resolves.toBe('accepted');
    });

    it("resolves 'unobservable' on a stock bridge that hides the _action services", async () => {
      const { client } = await connectedWithAction({ hidden: false });

      const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
      handle.outcome.catch(() => {});

      await expect(handle.acceptance).resolves.toBe('unobservable');
    });

    it("resolves 'unobservable' when the connection closes before any evidence", async () => {
      const { client, socket } = await connectedWithAction();

      const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
      handle.outcome.catch(() => {});
      socket.simulateClose(1006, 'gone');

      await expect(handle.acceptance).resolves.toBe('unobservable');
    });

    it('never rejects, on any failure path', async () => {
      const { client, socket } = await connectedWithAction();

      // A bridge-level failure of the dispatch, before any status evidence.
      const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
      handle.outcome.catch(() => {});
      const sendGoal = sentCalls(socket).find((c) => c.serviceId === SEND_GOAL_ID)!;
      socket.simulateMessage(
        JSON.stringify({
          op: 'serviceCallFailure',
          serviceId: sendGoal.serviceId,
          callId: sendGoal.callId,
          message: 'Service /dock/_action/send_goal is not available',
        }),
      );

      // `.then` with two arms rather than `resolves`: the assertion is that
      // the rejection arm is never taken, which `resolves` would report as a
      // failed match instead of naming what happened.
      const settled = await handle.acceptance.then(
        (v) => ({ ok: true, v }),
        (e: unknown) => ({ ok: false, v: e }),
      );
      expect(settled).toEqual({ ok: true, v: 'unobservable' });
    });
  });
});
