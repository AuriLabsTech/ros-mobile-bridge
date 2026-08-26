import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parse as parseRosMsgDef } from '@foxglove/rosmsg';
import type { MessageDefinition } from '@foxglove/message-definition';
import { MessageReader, MessageWriter } from '@foxglove/rosmsg2-serialization';
import { FoxgloveClient } from '../src/FoxgloveClient';
import {
  installMockWebSocket,
  parseFoxgloveServiceCallRequestFrame,
  type MockWebSocketHandle,
  type MockWebSocket,
} from './_helpers/mock-websocket';
import { populateMessage, normalizeDecoded } from './_helpers/populateMessage';
import { capturedService, CAPTURED_SERVICES } from './fixtures';

/**
 * The shape of the send-goal request, checked against schemas a real bridge
 * advertised rather than against schemas this repo wrote.
 *
 * ROS 2 does not wrap an action goal in a `goal` member. `rosidl` generates
 * `<Action>_SendGoal_Request` with `unique_identifier_msgs/UUID goal_id`
 * followed by the goal's own fields inlined at the root. Up to 0.1.11 this
 * client sent `{goal_id, goal: {...}}`, and CDR carries no field names: the
 * writer matched the caller's `goal` key against nothing, wrote every real
 * field from its schema default, and the server executed a goal made of
 * defaults with no error anywhere. The captured `DockRobot` schema is the one
 * that proves it, because its defaults are not zeros.
 *
 * The fix is schema-driven, not a hard-coded flattening: whatever the parsed
 * root definition says, the encoder follows.
 */

const SEP = '='.repeat(80);

function defsFor(schema: string): MessageDefinition[] {
  return parseRosMsgDef(schema, { ros2: true });
}

/** The goal's own fields, as a populated payload plus the defs to decode with. */
function goalPayloadFor(requestSchema: string): {
  defs: MessageDefinition[];
  goal: Record<string, unknown>;
} {
  const defs = defsFor(requestSchema);
  const root = defs[0]!;
  const goalOnly: MessageDefinition = {
    ...root,
    definitions: root.definitions.filter((f) => f.name !== 'goal_id'),
  };
  return { defs, goal: populateMessage([goalOnly, ...defs.slice(1)]) };
}

describe('FoxgloveClient send-goal request shape', () => {
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
  ): Promise<{ client: FoxgloveClient; socket: MockWebSocket }> {
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

  /** A send_goal service advertised the way a modern bridge advertises one. */
  function advertisement(
    id: number,
    name: string,
    type: string,
    requestSchema: string,
    requestEncoding: string,
    responseSchema: string,
  ): Record<string, unknown> {
    return {
      id,
      name,
      type,
      request: {
        encoding: 'cdr',
        schemaName: `${type}_Request`,
        schemaEncoding: requestEncoding,
        schema: requestSchema,
      },
      response: {
        encoding: 'cdr',
        schemaName: `${type}_Response`,
        schemaEncoding: requestEncoding,
        schema: responseSchema,
      },
    };
  }

  function sentRequestFor(socket: MockWebSocket, serviceId: number): Uint8Array {
    for (const buf of socket.sentBinary) {
      const parsed = parseFoxgloveServiceCallRequestFrame(buf);
      if (parsed && parsed.serviceId === serviceId) return parsed.payload;
    }
    throw new Error(`No SERVICE_CALL_REQUEST frame was sent for service id ${serviceId}`);
  }

  // Every captured send-goal service, not just the one that surfaced the bug.
  for (const svc of CAPTURED_SERVICES.filter((s) => s.name.endsWith('/_action/send_goal'))) {
    const action = svc.name.replace(/\/_action\/send_goal$/, '');

    it(`encodes the caller's goal fields at the root for ${svc.type}`, async () => {
      const { defs, goal } = goalPayloadFor(svc.request.schema);
      const { client, socket } = await connectAdvertising([
        advertisement(
          11,
          svc.name,
          svc.type,
          svc.request.schema,
          svc.request.encoding,
          svc.response.schema,
        ),
      ]);

      const handle = client.sendActionGoal(action, svc.type.replace(/_SendGoal$/, ''), goal);
      handle.outcome.catch(() => {}); // never settles here; keep the rejection handled

      const payload = sentRequestFor(socket, 11);
      const decoded = normalizeDecoded(new MessageReader(defs).readMessage(payload)) as Record<
        string,
        unknown
      >;

      // Field by field, so a failure names the field rather than dumping the
      // whole message.
      for (const [key, value] of Object.entries(goal)) {
        expect(decoded[key], `field "${key}" did not survive the round-trip`).toEqual(value);
      }

      // The goal id still rides at the root beside them, and is the UUID the
      // client invented rather than sixteen zeros.
      const goalId = (decoded.goal_id as Record<string, unknown>).uuid as number[];
      expect(goalId).toHaveLength(16);
      expect(goalId.some((b) => b !== 0)).toBe(true);

      // Nothing is smuggled in under a `goal` key.
      expect(decoded.goal).toBeUndefined();

      client.disconnect();
    });
  }

  it('nests the goal when the advertised root really does carry a complex "goal" member', async () => {
    // HYPOTHETICAL SCHEMA, not a capture. No bridge observed so far advertises
    // this shape; it exists to pin that the fix reads the schema instead of
    // flattening unconditionally, so a bridge or a future transport that does
    // send a nested definition still encodes correctly.
    const NESTED_REQ = [
      'unique_identifier_msgs/UUID goal_id',
      'my_robot_interfaces/Dock_Goal goal',
      SEP,
      'MSG: my_robot_interfaces/Dock_Goal',
      'int32 target_id',
      'string label',
      SEP,
      'MSG: unique_identifier_msgs/UUID',
      'uint8[16] uuid',
      '',
    ].join('\n');
    const NESTED_RESP = ['bool accepted', ''].join('\n');

    const { client, socket } = await connectAdvertising([
      advertisement(
        21,
        '/dock/_action/send_goal',
        'my_robot_interfaces/action/Dock_SendGoal',
        NESTED_REQ,
        'ros2msg',
        NESTED_RESP,
      ),
    ]);

    const goal = { target_id: 42, label: 'bay-3' };
    const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', goal);
    handle.outcome.catch(() => {});

    const decoded = normalizeDecoded(
      new MessageReader(defsFor(NESTED_REQ)).readMessage(sentRequestFor(socket, 21)),
    ) as Record<string, unknown>;

    expect(decoded.goal).toEqual({ target_id: 42, label: 'bay-3' });

    client.disconnect();
  });

  /**
   * A goal that declares its own member named `goal`.
   *
   * RECONSTRUCTED from nav2's `ComputePathToPose.action`, not a capture: the
   * goal's first field is `geometry_msgs/PoseStamped goal`, beside `start`,
   * `planner_id` and `use_start`. Inlined into the send-goal request the way
   * every captured schema shows, the root therefore carries a complex,
   * non-array field named `goal` that is NOT the action wrapper.
   *
   * A name-only witness cannot tell the two apart, and CDR is positional, so
   * the client would ship the caller's whole goal object into the
   * `PoseStamped` slot and let the writer fill `start`, `planner_id` and
   * `use_start` from schema defaults, with no error anywhere on the path. The
   * type is what separates them: `rosidl` names the wrapper `<Action>_Goal`.
   */
  const COMPUTE_PATH_REQ = [
    'unique_identifier_msgs/UUID goal_id',
    '#goal definition',
    'geometry_msgs/PoseStamped goal',
    'geometry_msgs/PoseStamped start',
    'string planner_id',
    'bool use_start',
    SEP,
    'MSG: geometry_msgs/PoseStamped',
    'std_msgs/Header header',
    'geometry_msgs/Pose pose',
    SEP,
    'MSG: std_msgs/Header',
    'builtin_interfaces/Time stamp',
    'string frame_id',
    SEP,
    'MSG: geometry_msgs/Pose',
    'geometry_msgs/Point position',
    'geometry_msgs/Quaternion orientation',
    SEP,
    'MSG: geometry_msgs/Point',
    'float64 x',
    'float64 y',
    'float64 z',
    SEP,
    'MSG: geometry_msgs/Quaternion',
    'float64 x',
    'float64 y',
    'float64 z',
    'float64 w',
    SEP,
    'MSG: builtin_interfaces/Time',
    'int32 sec',
    'uint32 nanosec',
    SEP,
    'MSG: unique_identifier_msgs/UUID',
    'uint8[16] uuid',
    '',
  ].join('\n');

  it('keeps the flat shape when a root "goal" member is the goal\'s own field, not the wrapper', async () => {
    const { defs, goal } = goalPayloadFor(COMPUTE_PATH_REQ);
    const { client, socket } = await connectAdvertising([
      advertisement(
        31,
        '/compute_path_to_pose/_action/send_goal',
        'nav2_msgs/action/ComputePathToPose_SendGoal',
        COMPUTE_PATH_REQ,
        'ros2msg',
        ['bool accepted', ''].join('\n'),
      ),
    ]);

    const handle = client.sendActionGoal(
      '/compute_path_to_pose',
      'nav2_msgs/action/ComputePathToPose',
      goal,
    );
    handle.outcome.catch(() => {});

    const decoded = normalizeDecoded(
      new MessageReader(defs).readMessage(sentRequestFor(socket, 31)),
    ) as Record<string, unknown>;

    for (const [key, value] of Object.entries(goal)) {
      expect(decoded[key], `field "${key}" did not survive the round-trip`).toEqual(value);
    }
    // The three fields a wrapper misread drops first: they would come back as
    // the schema's own defaults, and a planner would run against them.
    expect(decoded.planner_id).not.toBe('');
    expect(decoded.goal).toEqual(goal.goal);

    client.disconnect();
  });

  /**
   * A goal that declares its own member named `goal_id`.
   *
   * HYPOTHETICAL SCHEMA, not a capture. Inlining puts the goal's `goal_id`
   * at the root beside the envelope's `unique_identifier_msgs/UUID goal_id`,
   * so the parsed root really does declare the name twice, and both slots are
   * written from the caller's single key. The envelope id has to win, or the
   * client cannot key its own status watch, so the caller's field is lost.
   *
   * ADR 0013 decision 6 accepts the collision rather than mitigating it. What
   * this pins is that the loss is no longer silent: unlike the read side,
   * where the bridge has already merged the names, the write side can see it
   * coming and says so.
   */
  const GOAL_ID_COLLISION_REQ = [
    'unique_identifier_msgs/UUID goal_id',
    '#goal definition',
    'uint16 goal_id',
    'string label',
    SEP,
    'MSG: unique_identifier_msgs/UUID',
    'uint8[16] uuid',
    '',
  ].join('\n');

  it('warns, and does not silently drop, when the goal declares its own "goal_id"', async () => {
    const warn = vi.fn();
    const { client, socket } = await connectAdvertising(
      [
        advertisement(
          41,
          '/dock/_action/send_goal',
          'my_robot_interfaces/action/Dock_SendGoal',
          GOAL_ID_COLLISION_REQ,
          'ros2msg',
          ['bool accepted', ''].join('\n'),
        ),
      ],
      { logger: { log: vi.fn(), warn, error: vi.fn() } },
    );

    const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {
      goal_id: 42,
      label: 'bay-3',
    });
    handle.outcome.catch(() => {});

    const decoded = normalizeDecoded(
      new MessageReader(defsFor(GOAL_ID_COLLISION_REQ)).readMessage(sentRequestFor(socket, 41)),
    ) as Record<string, unknown>;

    // The rest of the goal is unaffected; only the colliding field is lost.
    expect(decoded.label).toBe('bay-3');
    expect(decoded.goal_id).toBe(0);

    const warned = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(warned).toContain('goal_id');
    expect(warned).toContain('/dock');

    client.disconnect();
  });

  it('writes the declared defaults, not the caller values, when the shape is wrong (regression rationale)', () => {
    // Not a client test: this is the mechanism the bug rode on, pinned so the
    // reason for the fixture corpus stays legible. Encoding a nested payload
    // against the real flat schema succeeds and silently produces defaults.
    const svc = capturedService('nav2_msgs/action/DockRobot_SendGoal');
    const { defs, goal } = goalPayloadFor(svc.request.schema);
    const reader = new MessageReader(defs);
    const writer = new MessageWriter(defs);

    const wrong = writer.writeMessage({ goal_id: { uuid: new Array(16).fill(0) }, goal });
    const decoded = normalizeDecoded(reader.readMessage(wrong)) as Record<string, unknown>;

    // The schema's own defaults come back, and none of the caller's values do.
    expect(decoded.use_dock_id).toBe(true);
    expect(decoded.max_staging_time).toBe(1000);
    expect(decoded.dock_id).not.toBe(goal.dock_id);
  });
});
