import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parse as parseRosMsgDef } from '@foxglove/rosmsg';
import type { MessageDefinition } from '@foxglove/message-definition';
import { MessageReader, MessageWriter } from '@foxglove/rosmsg2-serialization';
import { FoxgloveClient } from '../src/FoxgloveClient';
import { getBundledServiceSchema } from '../src/builtinSchemas';
import {
  installMockWebSocket,
  parseFoxgloveServiceCallRequestFrame,
  foxgloveMessageDataFrame,
  type MockWebSocketHandle,
  type MockWebSocket,
  type ParsedServiceCallRequest,
} from './_helpers/mock-websocket';
import { populateMessage, normalizeDecoded } from './_helpers/populateMessage';
import { capturedService } from './fixtures';

/**
 * The second release-gate check: an inventory of every place the library
 * builds a ROS 2 request payload itself, each one checked against the
 * definition that governs it.
 *
 * The send-goal defect was not a coding slip, it was a missing inventory. The
 * library hand-builds a handful of payloads the consumer never sees, and one
 * of them had been wrong since the action path was written. Nothing in the
 * suite asked the question "does the shape we build match the shape the
 * definition declares", so nothing answered it.
 *
 * The check that matters is field-set equality against the root definition,
 * not a successful encode. **CDR carries no field names.** A payload with a
 * key the definition does not declare encodes without error, and every field
 * it failed to supply is written from its schema default. That is the failure
 * mode: silent, well-formed, and wrong at the robot.
 *
 * JSON-encoded payloads are listed too, and are a different risk class: field
 * names travel on the wire, so a wrong key is dropped or reported by the
 * bridge rather than turned into a default. They are inventoried for
 * completeness, not because they can fail the same way.
 */

const SEP = '='.repeat(80);
const UUID_CHAIN = ['MSG: unique_identifier_msgs/UUID', 'uint8[16] uuid'].join('\n');

const DOCK = capturedService('nav2_msgs/action/DockRobot_SendGoal');

/**
 * HYPOTHETICAL SCHEMA, not a capture. `<Action>_GetResult_Request` is a
 * one-member message by rosidl's generation rule, and no capture of one is in
 * the corpus yet. Listed as a gap below rather than presented as evidence.
 */
const GET_RESULT_REQ = ['unique_identifier_msgs/UUID goal_id', SEP, UUID_CHAIN, ''].join('\n');
const GET_RESULT_RESP = ['int8 status', '#result definition', 'bool success', ''].join('\n');

const CANCEL_GOAL = getBundledServiceSchema('action_msgs/srv/CancelGoal')!;

const SEND_GOAL_ID = 41;
const GET_RESULT_ID = 42;
const CANCEL_ID = 43;

const STATUS_CHANNEL = 51;

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
  ['MSG: builtin_interfaces/Time', 'int32 sec', 'uint32 nanosec'].join('\n'),
  '',
].join('\n');

const REQUEST_SCHEMA_BY_ID: Record<number, string> = {
  [SEND_GOAL_ID]: DOCK.request.schema,
  [GET_RESULT_ID]: GET_RESULT_REQ,
  [CANCEL_ID]: CANCEL_GOAL.request,
};

function advertisedServices(): Record<string, unknown>[] {
  const svc = (
    id: number,
    name: string,
    type: string,
    request: string,
    response: string,
  ): Record<string, unknown> => ({
    id,
    name,
    type,
    request: {
      encoding: 'cdr',
      schemaName: `${type}_Request`,
      schemaEncoding: 'ros2msg',
      schema: request,
    },
    response: {
      encoding: 'cdr',
      schemaName: `${type}_Response`,
      schemaEncoding: 'ros2msg',
      schema: response,
    },
  });
  return [
    svc(
      SEND_GOAL_ID,
      '/dock/_action/send_goal',
      DOCK.type,
      DOCK.request.schema,
      DOCK.response.schema,
    ),
    svc(
      GET_RESULT_ID,
      '/dock/_action/get_result',
      'nav2_msgs/action/DockRobot_GetResult',
      GET_RESULT_REQ,
      GET_RESULT_RESP,
    ),
    svc(
      CANCEL_ID,
      '/dock/_action/cancel_goal',
      'action_msgs/srv/CancelGoal',
      CANCEL_GOAL.request,
      CANCEL_GOAL.response,
    ),
  ];
}

/** The uuid the client invented, read back out of its own send_goal frame. */
function readGoalUuid(socket: MockWebSocket): Uint8Array {
  for (const buf of socket.sentBinary) {
    const parsed = parseFoxgloveServiceCallRequestFrame(buf);
    if (parsed?.serviceId !== SEND_GOAL_ID) continue;
    const decoded = new MessageReader(
      parseRosMsgDef(DOCK.request.schema, { ros2: true }),
    ).readMessage(parsed.payload) as { goal_id: { uuid: Uint8Array } };
    return decoded.goal_id.uuid;
  }
  throw new Error('no send_goal frame was sent');
}

/** The subscription id the client chose for a channel, from its subscribe op. */
function subscriptionIdFor(socket: MockWebSocket, channelId: number): number | undefined {
  const ops = socket.sentJson.filter((m) => m.op === 'subscribe') as Array<{
    subscriptions: Array<{ id: number; channelId: number }>;
  }>;
  for (const op of ops) {
    for (const sub of op.subscriptions) {
      if (sub.channelId === channelId) return sub.id;
    }
  }
  return undefined;
}

function statusFrame(subId: number, uuid: ArrayLike<number>, status: number): ArrayBuffer {
  const bytes = new MessageWriter(parseRosMsgDef(STATUS_ARRAY, { ros2: true })).writeMessage({
    status_list: [
      {
        goal_info: { goal_id: { uuid: Array.from(uuid) }, stamp: { sec: 0, nanosec: 0 } },
        status,
      },
    ],
  });
  return foxgloveMessageDataFrame(subId, 0n, bytes);
}

/**
 * Every payload the library builds for itself, with the authority it is
 * checked against.
 *
 * `authority`:
 * - `captured` — a schema a real bridge advertised (`tests/fixtures/`).
 * - `bundled`  — the library's own IDL bundle, which is the definition it
 *                encodes against in production too.
 * - `none`     — no authoritative definition is checked in yet. Every entry
 *                here is also in `KNOWN_GAPS`, so adding a hand-built payload
 *                without an authority is a test failure rather than an
 *                omission nobody notices.
 */
interface InventoryEntry {
  site: string;
  encoding: 'cdr' | 'json';
  authority: 'captured' | 'bundled' | 'none';
  note?: string;
}

const INVENTORY: InventoryEntry[] = [
  {
    site: 'FoxgloveClient.sendActionGoal → <action>/_action/send_goal',
    encoding: 'cdr',
    authority: 'captured',
  },
  {
    site: 'FoxgloveClient.sendActionGoal → <action>/_action/get_result (standing request and residual probe)',
    encoding: 'cdr',
    authority: 'none',
    note: 'One-member request; no captured GetResult schema in the corpus yet.',
  },
  {
    site: 'FoxgloveClient.sendActionGoal → <action>/_action/cancel_goal',
    encoding: 'cdr',
    authority: 'bundled',
  },
  {
    site: 'FoxgloveClient.publishZeroTwist → /cmd_vel (geometry_msgs/msg/Twist)',
    encoding: 'json',
    authority: 'none',
    note: 'JSON on the wire: field names travel, so a wrong key cannot become a default.',
  },
  {
    site: 'RosbridgeClient.sendActionGoal → send_action_goal op',
    encoding: 'json',
    authority: 'none',
    note: 'The bridge composes the SendGoal request itself from the goal object; the library never encodes one.',
  },
  {
    site: 'RosbridgeClient.discoverTopics / discoverServices → /rosapi/topics, /rosapi/services',
    encoding: 'json',
    authority: 'none',
    note: 'Empty requests. Nothing to shape.',
  },
  {
    site: 'RosbridgeClient.publishZeroTwist → /cmd_vel (geometry_msgs/msg/Twist)',
    encoding: 'json',
    authority: 'none',
    note: 'JSON on the wire, as above.',
  },
];

/** Sites with no authority yet. Shrinking this list is the point of it. */
const KNOWN_GAPS = INVENTORY.filter((e) => e.authority === 'none').map((e) => e.site);

/**
 * Field-set equality between a payload and the root of a parsed definition.
 * Recurses into complex members, which is where the goal fields would have
 * hidden.
 */
function expectShapeMatches(
  defs: MessageDefinition[],
  payload: Record<string, unknown>,
  path = 'root',
): void {
  const typeMap = new Map<string, MessageDefinition>();
  for (const d of defs) if (d.name) typeMap.set(d.name, d);

  const root = defs[0]!;
  const declared = root.definitions.filter((f) => !f.isConstant);
  expect(new Set(Object.keys(payload)), `${path}: field set`).toEqual(
    new Set(declared.map((f) => f.name)),
  );

  for (const field of declared) {
    if (!field.isComplex || field.isArray) continue;
    const sub = typeMap.get(field.type);
    if (!sub) continue;
    const value = payload[field.name];
    if (value === null || typeof value !== 'object') continue;
    expectShapeMatches(
      [sub, ...defs.slice(1)],
      value as Record<string, unknown>,
      `${path}.${field.name}`,
    );
  }
}

describe('hand-built request inventory', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });

  afterEach(() => {
    ws.restore();
  });

  it('lists every site, and every site without an authority is a declared gap', () => {
    expect(INVENTORY.length).toBeGreaterThan(0);
    for (const entry of INVENTORY) {
      if (entry.authority === 'none') {
        expect(KNOWN_GAPS, `${entry.site} has no authority and must be a declared gap`).toContain(
          entry.site,
        );
        expect(entry.note, `${entry.site} must say why it has no authority`).toBeTruthy();
      }
    }
  });

  /**
   * The CDR sites, checked on the payloads the client hands the encoder.
   *
   * Checking the *decoded* frame proves nothing: `MessageReader` reconstructs
   * whatever the definition declares, so a message encoded from a wrong-shaped
   * payload decodes into a right-shaped object full of defaults. That is
   * precisely how the send-goal defect stayed invisible. The payload going in
   * is the only place the mismatch exists, so that is what this reads.
   *
   * `writeMessage` calls and outbound frames pair up in order: the client
   * encodes immediately before it sends, one call per service request.
   */
  describe('the CDR sites, on the payloads handed to the encoder', () => {
    interface Recorded {
      serviceId: number;
      payload: Record<string, unknown>;
    }

    async function scriptedGoal(): Promise<{ client: FoxgloveClient; recorded: Recorded[] }> {
      const payloads: Record<string, unknown>[] = [];
      // The spy sits on the prototype, so it sees this test's own encodes too
      // (the status frame it feeds back). `recording` brackets those out.
      let recording = true;
      const originalWrite = MessageWriter.prototype.writeMessage;
      const spy = vi.spyOn(MessageWriter.prototype, 'writeMessage').mockImplementation(function (
        this: MessageWriter,
        message: unknown,
      ) {
        if (recording) payloads.push(message as Record<string, unknown>);
        return originalWrite.call(this, message);
      });

      try {
        const client = new FoxgloveClient();
        const connectPromise = client.connect('ws://localhost:8765');
        const socket: MockWebSocket = ws.last();
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
          JSON.stringify({ op: 'advertiseServices', services: advertisedServices() }),
        );
        await connectPromise;

        const goalDefs = parseRosMsgDef(DOCK.request.schema, { ros2: true });
        const goalRoot = goalDefs[0]!;
        const goal = populateMessage([
          { ...goalRoot, definitions: goalRoot.definitions.filter((f) => f.name !== 'goal_id') },
          ...goalDefs.slice(1),
        ]);

        const handle = client.sendActionGoal('/dock', 'nav2_msgs/action/DockRobot', goal);
        handle.outcome.catch(() => {});

        // A status frame naming the goal arms the standing get_result, which
        // is the second hand-built payload. `cancel()` fires the third.
        const uuid = readGoalUuid(socket);
        recording = false;
        const status = statusFrame(subscriptionIdFor(socket, STATUS_CHANNEL)!, uuid, 2);
        recording = true;
        socket.simulateMessage(status);
        handle.cancel();

        const frames: ParsedServiceCallRequest[] = [];
        for (const buf of socket.sentBinary) {
          const parsed = parseFoxgloveServiceCallRequestFrame(buf);
          if (parsed) frames.push(parsed);
        }
        expect(payloads.length, 'one encode per outbound service request').toBe(frames.length);

        return {
          client,
          recorded: frames.map((f, i) => ({ serviceId: f.serviceId, payload: payloads[i]! })),
        };
      } finally {
        spy.mockRestore();
      }
    }

    it('every payload the client builds matches its service definition, field for field', async () => {
      const { client, recorded } = await scriptedGoal();

      // All three sites fired, so a silently-skipped one cannot pass this.
      expect(recorded.map((r) => r.serviceId).sort()).toEqual(
        [SEND_GOAL_ID, GET_RESULT_ID, CANCEL_ID].sort(),
      );

      for (const { serviceId, payload } of recorded) {
        const schema = REQUEST_SCHEMA_BY_ID[serviceId]!;
        expectShapeMatches(parseRosMsgDef(schema, { ros2: true }), payload, `service ${serviceId}`);
      }

      client.disconnect();
    });

    it('the check is not vacuous: the shape this library shipped until 0.1.12 fails it', () => {
      // The canary. `{goal_id, goal}` against the captured flat definition is
      // exactly what went out for every nav2 action, and it has to be caught
      // here or this whole file is decoration.
      const defs = parseRosMsgDef(DOCK.request.schema, { ros2: true });
      expect(() =>
        expectShapeMatches(defs, {
          goal_id: { uuid: new Array(16).fill(0) },
          goal: { dock_id: 'bay-3' },
        }),
      ).toThrow();
    });
  });

  it('every bundled schema parses and round-trips a fully populated message', () => {
    // The bundle is hand-written IDL, which makes it a hand-built definition
    // rather than a hand-built payload — the same class of risk one level
    // down. A bundled schema that does not round-trip is unusable in the
    // fallback path it exists for.
    for (const type of [
      'rcl_interfaces/srv/ListParameters',
      'rcl_interfaces/srv/GetParameters',
      'rcl_interfaces/srv/SetParameters',
      'rcl_interfaces/srv/DescribeParameters',
      'rcl_interfaces/srv/GetParameterTypes',
      'action_msgs/srv/CancelGoal',
    ]) {
      const bundled = getBundledServiceSchema(type);
      expect(bundled, `${type} is missing from the bundle`).toBeTruthy();
      for (const side of ['request', 'response'] as const) {
        const defs = parseRosMsgDef(bundled![side], { ros2: true });
        const populated = populateMessage(defs);
        const decoded = normalizeDecoded(
          new MessageReader(defs).readMessage(new MessageWriter(defs).writeMessage(populated)),
        ) as Record<string, unknown>;
        for (const [key, value] of Object.entries(populated)) {
          expect(decoded[key], `${type} ${side}: field "${key}" did not survive`).toEqual(value);
        }
      }
    }
  });
});
