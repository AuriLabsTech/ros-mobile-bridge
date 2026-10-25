// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * An action's own struct field named like its wrapper member.
 *
 * `foxglove_bridge` inlines the `<Action>_Result` and `<Action>_Feedback`
 * wrappers into the root of the GetResult response and the feedback message,
 * so the client lifts the fields back out unless the bridge nested them
 * (ADR 0013). A result or feedback that declares a struct field of its own
 * named `result` or `feedback` decodes to a record under that name too, so
 * the decoded value cannot tell the two apart. The declared type can: the
 * wrapper's type is always `<Action>_Result` / `<Action>_Feedback` (ADR 0031).
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

/** Flat result whose own struct field is named `result`. */
const FLAT_TIME_RESULT = [
  'int8 status',
  '#result definition',
  'builtin_interfaces/Time result',
  'uint32 count',
  SEP,
  TIME_CHAIN,
  '',
].join('\n');

/** The same result, nested under the real wrapper. */
const NESTED_RESULT = [
  'int8 status',
  'pkg/Scan_Result result',
  SEP,
  'MSG: pkg/Scan_Result',
  'builtin_interfaces/Time result',
  'uint32 count',
  SEP,
  TIME_CHAIN,
  '',
].join('\n');

/** Flat feedback whose own struct field is named `feedback`. */
const FLAT_TIME_FEEDBACK = [
  'unique_identifier_msgs/UUID goal_id',
  '#feedback definition',
  'builtin_interfaces/Time feedback',
  'uint32 progress',
  SEP,
  UUID_CHAIN,
  SEP,
  TIME_CHAIN,
  '',
].join('\n');

const JOB_RESULT_CHAIN = ['MSG: other_pkg/Job_Result', 'uint32 code'].join('\n');
const JOB_FEEDBACK_CHAIN = ['MSG: other_pkg/Job_Feedback', 'uint32 code'].join('\n');

/**
 * Flat result whose own field `result` is another action's result type:
 * named like the wrapper, typed `_Result`, but not `Scan_Result`.
 * Hypothetical: no rig carries such a type.
 */
const FLAT_FOREIGN_RESULT = [
  'int8 status',
  '#result definition',
  'other_pkg/Job_Result result',
  'uint32 count',
  SEP,
  JOB_RESULT_CHAIN,
  '',
].join('\n');

/** Flat feedback whose own field `feedback` is another action's feedback type. Hypothetical. */
const FLAT_FOREIGN_FEEDBACK = [
  'unique_identifier_msgs/UUID goal_id',
  '#feedback definition',
  'other_pkg/Job_Feedback feedback',
  'uint32 progress',
  SEP,
  UUID_CHAIN,
  SEP,
  JOB_FEEDBACK_CHAIN,
  '',
].join('\n');

/** The same feedback, nested under the real wrapper. */
const NESTED_FEEDBACK = [
  'unique_identifier_msgs/UUID goal_id',
  'pkg/Scan_Feedback feedback',
  SEP,
  UUID_CHAIN,
  SEP,
  'MSG: pkg/Scan_Feedback',
  'builtin_interfaces/Time feedback',
  'uint32 progress',
  SEP,
  TIME_CHAIN,
  '',
].join('\n');

const SEND_GOAL_ID = 21;
const GET_RESULT_ID = 22;
const STATUS_CHANNEL = 11;
const FEEDBACK_CHANNEL = 12;

const STAMP = { sec: 5, nanosec: 6 };

function svc(id: number, name: string, type: string, req: string, resp: string) {
  return {
    id,
    name,
    type,
    request: { encoding: 'cdr', schemaEncoding: 'ros2msg', schema: req },
    response: { encoding: 'cdr', schemaEncoding: 'ros2msg', schema: resp },
  };
}

describe('FoxgloveClient — a struct field named like the action wrapper', () => {
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

  function subIdFor(socket: ReturnType<MockWebSocketHandle['last']>, channelId: number): number {
    for (const m of socket.sentJson) {
      if (m.op !== 'subscribe') continue;
      const subs = (m as { subscriptions: Array<{ id: number; channelId: number }> }).subscriptions;
      const hit = subs.find((s) => s.channelId === channelId);
      if (hit) return hit.id;
    }
    throw new Error(`no subscription for channel ${channelId}`);
  }

  function encode(schema: string, value: Record<string, unknown>): Uint8Array {
    return new MessageWriter(parseRosMsgDef(schema, { ros2: true })).writeMessage(value);
  }

  /**
   * Dispatch a goal, accept it, deliver one feedback frame, and answer
   * GetResult. Returns the outcome and every feedback the consumer saw.
   */
  async function run(opts: {
    getResultResp: string;
    result: Record<string, unknown>;
    feedbackSchema: string;
    feedback: Record<string, unknown>;
    /** Feedback and the GetResult answer arrive as JSON, not CDR. */
    json?: boolean;
    /** The bridge drops the feedback channel before the `latest-only` drain. */
    unadvertiseFeedbackBeforeDrain?: boolean;
  }) {
    const asJson = (value: Record<string, unknown>): Uint8Array =>
      new TextEncoder().encode(JSON.stringify(value));
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
          {
            id: FEEDBACK_CHANNEL,
            topic: '/scan/_action/feedback',
            encoding: opts.json ? 'json' : 'cdr',
            schemaName: 'pkg/action/Scan_FeedbackMessage',
            schemaEncoding: 'ros2msg',
            schema: opts.feedbackSchema,
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
            opts.getResultResp,
          ),
        ],
      }),
    );
    await connectPromise;

    const feedbacks: Array<Record<string, unknown>> = [];
    const handle = client.sendActionGoal(
      '/scan',
      'pkg/action/Scan',
      {},
      {
        onFeedback: (f) => feedbacks.push(f),
      },
    );
    const sendGoal = sentCalls(socket).find((c) => c.serviceId === SEND_GOAL_ID)!;
    const uuid = (
      new MessageReader(parseRosMsgDef(SEND_GOAL_REQ, { ros2: true })).readMessage(
        sendGoal.payload,
      ) as { goal_id: { uuid: Uint8Array } }
    ).goal_id.uuid;
    socket.simulateMessage(
      foxgloveServiceCallResponseFrame(
        sendGoal.serviceId,
        sendGoal.callId,
        'cdr',
        encode(SEND_GOAL_RESP, { accepted: true, stamp: { sec: 0, nanosec: 0 } }),
      ),
    );
    await flush();

    const goalId = { uuid: Array.from(uuid) };
    socket.simulateMessage(
      foxgloveMessageDataFrame(
        subIdFor(socket, STATUS_CHANNEL),
        0n,
        encode(STATUS_ARRAY, {
          status_list: [
            { goal_info: { goal_id: goalId, stamp: { sec: 0, nanosec: 0 } }, status: 2 },
          ],
        }),
      ),
    );
    socket.simulateMessage(
      foxgloveMessageDataFrame(
        subIdFor(socket, FEEDBACK_CHANNEL),
        0n,
        (opts.json ? asJson : (v: Record<string, unknown>) => encode(opts.feedbackSchema, v))({
          goal_id: goalId,
          ...opts.feedback,
        }),
      ),
    );
    if (opts.unadvertiseFeedbackBeforeDrain) {
      socket.simulateMessage(JSON.stringify({ op: 'unadvertise', channelIds: [FEEDBACK_CHANNEL] }));
    }
    // `latest-only` delivers on the next tick.
    await flush();

    const standing = sentCalls(socket).find((c) => c.serviceId === GET_RESULT_ID)!;
    const answer = { status: 4, ...opts.result };
    socket.simulateMessage(
      foxgloveServiceCallResponseFrame(
        standing.serviceId,
        standing.callId,
        opts.json ? 'json' : 'cdr',
        opts.json ? asJson(answer) : encode(opts.getResultResp, answer),
      ),
    );
    const outcome = await handle.outcome;
    return { outcome, feedbacks };
  }

  it('keeps a Time field named "result" beside the other fields of a flat result', async () => {
    const { outcome } = await run({
      getResultResp: FLAT_TIME_RESULT,
      result: { result: STAMP, count: 2 },
      feedbackSchema: NESTED_FEEDBACK,
      feedback: { feedback: { feedback: STAMP, progress: 1 } },
    });
    expect(outcome).toEqual({ status: 4, result: { result: STAMP, count: 2 } });
  });

  it('keeps a Time field named "feedback" beside the other fields of flat feedback', async () => {
    const { feedbacks } = await run({
      getResultResp: NESTED_RESULT,
      result: { result: { result: STAMP, count: 2 } },
      feedbackSchema: FLAT_TIME_FEEDBACK,
      feedback: { feedback: STAMP, progress: 3 },
    });
    expect(feedbacks).toEqual([{ feedback: STAMP, progress: 3 }]);
  });

  it("keeps a field typed as another action's result beside the flat result's other fields", async () => {
    const { outcome } = await run({
      getResultResp: FLAT_FOREIGN_RESULT,
      result: { result: { code: 7 }, count: 2 },
      feedbackSchema: NESTED_FEEDBACK,
      feedback: { feedback: { feedback: STAMP, progress: 1 } },
    });
    expect(outcome).toEqual({ status: 4, result: { result: { code: 7 }, count: 2 } });
  });

  it("keeps a field typed as another action's feedback beside the flat feedback's other fields", async () => {
    const { feedbacks } = await run({
      getResultResp: NESTED_RESULT,
      result: { result: { result: STAMP, count: 2 } },
      feedbackSchema: FLAT_FOREIGN_FEEDBACK,
      feedback: { feedback: { code: 7 }, progress: 3 },
    });
    expect(feedbacks).toEqual([{ feedback: { code: 7 }, progress: 3 }]);
  });

  it("keeps a goal field typed as another action's goal in the goal template", async () => {
    // Hypothetical flat send_goal request: the goal's own `goal` field is
    // another action's `_Goal` type, beside `n`.
    const flatForeignGoalReq = [
      'unique_identifier_msgs/UUID goal_id',
      '#goal definition',
      'other_pkg/Plan_Goal goal',
      'uint32 n',
      SEP,
      UUID_CHAIN,
      SEP,
      'MSG: other_pkg/Plan_Goal',
      'uint32 code',
      '',
    ].join('\n');
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
          svc(
            SEND_GOAL_ID,
            '/scan/_action/send_goal',
            'pkg/action/Scan_SendGoal',
            flatForeignGoalReq,
            SEND_GOAL_RESP,
          ),
        ],
      }),
    );
    await connectPromise;
    expect(client.getSchemaTemplate('pkg/action/Scan_Goal')).toEqual({ goal: { code: 0 }, n: 0 });
  });

  it('still unwraps a nested wrapper whose payload has a field of the same name', async () => {
    const { outcome, feedbacks } = await run({
      getResultResp: NESTED_RESULT,
      result: { result: { result: STAMP, count: 2 } },
      feedbackSchema: NESTED_FEEDBACK,
      feedback: { feedback: { feedback: STAMP, progress: 3 } },
    });
    expect(outcome).toEqual({ status: 4, result: { result: STAMP, count: 2 } });
    expect(feedbacks).toEqual([{ feedback: STAMP, progress: 3 }]);
  });

  it('reads a JSON answer by its own shape, not by a schema that did not decode it', async () => {
    // The advertised schemas are flat, but JSON.parse decoded the frames, and
    // the JSON nests. No definition decoded them, so the value decides.
    const { outcome, feedbacks } = await run({
      getResultResp: FLAT_TIME_RESULT,
      result: { result: { count: 2 } },
      feedbackSchema: FLAT_TIME_FEEDBACK,
      feedback: { feedback: { progress: 3 } },
      json: true,
    });
    expect(outcome).toEqual({ status: 4, result: { count: 2 } });
    expect(feedbacks).toEqual([{ progress: 3 }]);
  });

  it('keeps the decode-time definition when the feedback channel goes before the drain', async () => {
    const { feedbacks } = await run({
      getResultResp: NESTED_RESULT,
      result: { result: { result: STAMP, count: 2 } },
      feedbackSchema: FLAT_TIME_FEEDBACK,
      feedback: { feedback: STAMP, progress: 3 },
      unadvertiseFeedbackBeforeDrain: true,
    });
    expect(feedbacks).toEqual([{ feedback: STAMP, progress: 3 }]);
  });
});
