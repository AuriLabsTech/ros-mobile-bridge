import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parse as parseRosMsgDef } from '@foxglove/rosmsg';
import { MessageReader, MessageWriter } from '@foxglove/rosmsg2-serialization';
import { getBundledServiceSchema, hasBundledServiceSchema } from '../src/builtinSchemas';
import { FoxgloveClient } from '../src/FoxgloveClient';
import {
  installMockWebSocket,
  findSentServiceCallRequest,
  foxgloveServiceCallResponseFrame,
  type MockWebSocketHandle,
} from './_helpers/mock-websocket';

const SERVICE_TYPES = [
  'rcl_interfaces/srv/ListParameters',
  'rcl_interfaces/srv/GetParameters',
  'rcl_interfaces/srv/SetParameters',
  'rcl_interfaces/srv/DescribeParameters',
  'rcl_interfaces/srv/GetParameterTypes',
  'action_msgs/srv/CancelGoal',
];

describe('builtinSchemas — every bundled service parses cleanly with @foxglove/rosmsg', () => {
  for (const type of SERVICE_TYPES) {
    it(`${type}: request + response both parse`, () => {
      const b = getBundledServiceSchema(type);
      expect(b).not.toBeNull();
      const reqDefs = parseRosMsgDef(b!.request, { ros2: true });
      const respDefs = parseRosMsgDef(b!.response, { ros2: true });
      expect(reqDefs.length).toBeGreaterThan(0);
      expect(respDefs.length).toBeGreaterThan(0);
      // The writer/reader compilers run a second pass of type resolution;
      // if a field references an unresolved type, this is where we'd find out.
      expect(() => new MessageWriter(reqDefs)).not.toThrow();
      expect(() => new MessageReader(reqDefs)).not.toThrow();
      expect(() => new MessageWriter(respDefs)).not.toThrow();
      expect(() => new MessageReader(respDefs)).not.toThrow();
    });
  }
});

describe('builtinSchemas — round-trip cases that exercise the trickier shapes', () => {
  it('SetParameters request round-trips a non-empty Parameter list', () => {
    const b = getBundledServiceSchema('rcl_interfaces/srv/SetParameters')!;
    const defs = parseRosMsgDef(b.request, { ros2: true });
    const writer = new MessageWriter(defs);
    const reader = new MessageReader(defs);
    const payload = {
      parameters: [
        {
          name: 'use_sim_time',
          value: {
            type: 1, // PARAMETER_BOOL
            bool_value: true,
            integer_value: 0n,
            double_value: 0,
            string_value: '',
            byte_array_value: new Uint8Array(),
            bool_array_value: [],
            integer_array_value: [],
            double_array_value: [],
            string_array_value: [],
          },
        },
      ],
    };
    const bytes = writer.writeMessage(payload);
    const decoded = reader.readMessage(bytes) as {
      parameters: Array<{ name: string; value: { type: number; bool_value: boolean } }>;
    };
    expect(decoded.parameters).toHaveLength(1);
    expect(decoded.parameters[0]!.name).toBe('use_sim_time');
    expect(decoded.parameters[0]!.value.type).toBe(1);
    expect(decoded.parameters[0]!.value.bool_value).toBe(true);
  });

  it('CancelGoal request round-trips through the cross-package GoalInfo/UUID/Time chain', () => {
    const b = getBundledServiceSchema('action_msgs/srv/CancelGoal')!;
    const defs = parseRosMsgDef(b.request, { ros2: true });
    const writer = new MessageWriter(defs);
    const reader = new MessageReader(defs);
    const uuid = new Uint8Array(16);
    uuid[0] = 0xab;
    uuid[15] = 0xcd;
    const bytes = writer.writeMessage({
      goal_info: { goal_id: { uuid }, stamp: { sec: 1234, nanosec: 5678 } },
    });
    const decoded = reader.readMessage(bytes) as {
      goal_info: { goal_id: { uuid: Uint8Array }; stamp: { sec: number; nanosec: number } };
    };
    expect(decoded.goal_info.stamp.sec).toBe(1234);
    expect(decoded.goal_info.stamp.nanosec).toBe(5678);
    expect(decoded.goal_info.goal_id.uuid[0]).toBe(0xab);
    expect(decoded.goal_info.goal_id.uuid[15]).toBe(0xcd);
  });

  it('CancelGoal response carries the int8 ERROR_* constants', () => {
    const b = getBundledServiceSchema('action_msgs/srv/CancelGoal')!;
    const defs = parseRosMsgDef(b.response, { ros2: true });
    const constants = defs[0]!.definitions.filter((d) => d.isConstant).map((d) => d.name);
    expect(constants).toEqual([
      'ERROR_NONE',
      'ERROR_REJECTED',
      'ERROR_UNKNOWN_GOAL_ID',
      'ERROR_GOAL_TERMINATED',
    ]);
  });

  it('DescribeParameters response handles same-package short-name refs (FloatingPointRange, IntegerRange)', () => {
    const b = getBundledServiceSchema('rcl_interfaces/srv/DescribeParameters')!;
    const defs = parseRosMsgDef(b.response, { ros2: true });
    const writer = new MessageWriter(defs);
    const reader = new MessageReader(defs);
    const bytes = writer.writeMessage({
      descriptors: [
        {
          name: 'speed',
          type: 3, // PARAMETER_DOUBLE
          description: 'top speed',
          additional_constraints: '',
          read_only: false,
          dynamic_typing: false,
          floating_point_range: [{ from_value: 0, to_value: 5, step: 0.1 }],
          integer_range: [],
        },
      ],
    });
    const decoded = reader.readMessage(bytes) as {
      descriptors: Array<{ name: string; floating_point_range: Array<{ to_value: number }> }>;
    };
    expect(decoded.descriptors[0]!.name).toBe('speed');
    expect(decoded.descriptors[0]!.floating_point_range[0]!.to_value).toBe(5);
  });

  it('hasBundledServiceSchema returns false for unknown types', () => {
    expect(hasBundledServiceSchema('std_srvs/srv/Trigger')).toBe(false);
    expect(hasBundledServiceSchema('rcl_interfaces/srv/ListParameters')).toBe(true);
  });
});

// ─── FoxgloveClient integration: the bundle as a layered-resolution fallback ──
//
// These exercise the three-layer schema resolution
// (bridge-advertised → bundled IDL → null) end-to-end through
// `callService`. They live in this file rather than FoxgloveClient.test.ts
// because what's being tested is the bundle's role inside the client, not
// any other client behavior — keeping them next to the bundle source makes
// the fallback contract easier to audit at a glance.

describe('FoxgloveClient × builtinSchemas — layered schema resolution', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });

  afterEach(() => {
    ws.restore();
  });

  async function connectAndAdvertise(
    services: Array<{
      id: number;
      name: string;
      type: string;
      requestSchema?: string;
      requestSchemaEncoding?: string;
      responseSchema?: string;
      responseSchemaEncoding?: string;
    }>,
  ): Promise<{ client: FoxgloveClient; socket: ReturnType<MockWebSocketHandle['last']> }> {
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

  it('bundled-only service + empty request: encodes via the bundle defs, not the 4-byte fallback', async () => {
    const { client, socket } = await connectAndAdvertise([
      { id: 9, name: '/n/get_parameters', type: 'rcl_interfaces/srv/GetParameters' },
    ]);

    const resultPromise = client.callService('/n/get_parameters', {});
    resultPromise.catch(() => {});

    const callOp = findSentServiceCallRequest(socket);
    expect(callOp).not.toBeNull();
    expect(callOp!.encoding).toBe('cdr');

    // Distinguish the bundle path from the schemaless-empty path: a real CDR
    // payload encoded against `string[] names` is longer than the bare 4-byte
    // encapsulation header (it carries a uint32 sequence length).
    expect(callOp!.payload.byteLength).toBeGreaterThan(4);

    const bundle = getBundledServiceSchema('rcl_interfaces/srv/GetParameters')!;
    const reqDefs = parseRosMsgDef(bundle.request, { ros2: true });
    const decoded = new MessageReader(reqDefs).readMessage(callOp!.payload) as { names: string[] };
    expect(decoded.names).toEqual([]);
  });

  it('bundled-only service + non-empty request: round-trips via the bundle defs', async () => {
    const { client, socket } = await connectAndAdvertise([
      { id: 9, name: '/n/get_parameters', type: 'rcl_interfaces/srv/GetParameters' },
    ]);

    const resultPromise = client.callService('/n/get_parameters', {
      names: ['/foo', '/bar'],
    });
    resultPromise.catch(() => {});

    const callOp = findSentServiceCallRequest(socket);
    expect(callOp).not.toBeNull();
    expect(callOp!.encoding).toBe('cdr');

    const bundle = getBundledServiceSchema('rcl_interfaces/srv/GetParameters')!;
    const reqDefs = parseRosMsgDef(bundle.request, { ros2: true });
    const decoded = new MessageReader(reqDefs).readMessage(callOp!.payload) as {
      names: string[];
    };
    expect(decoded.names).toEqual(['/foo', '/bar']);
  });

  it('bridge-advertised schemaful service + empty request: fills with zero defaults', async () => {
    // ListParameters_Request shape, advertised inline so the bundle is *not*
    // the source of truth here — the bridge schema is. This pins the
    // "default request sentinel" contract: `{}` encodes via the bridge defs
    // with zero values, not via the 4-byte encapsulation-header fallback.
    const REQUEST_SCHEMA = 'string[] prefixes\nuint64 depth\n';
    const { client, socket } = await connectAndAdvertise([
      {
        id: 9,
        name: '/n/list_parameters',
        type: 'rcl_interfaces/srv/ListParameters',
        requestSchema: REQUEST_SCHEMA,
        requestSchemaEncoding: 'ros2msg',
      },
    ]);

    const resultPromise = client.callService('/n/list_parameters', {});
    resultPromise.catch(() => {});

    const callOp = findSentServiceCallRequest(socket);
    expect(callOp).not.toBeNull();
    expect(callOp!.payload.byteLength).toBeGreaterThan(4);

    const reqDefs = parseRosMsgDef(REQUEST_SCHEMA, { ros2: true });
    const decoded = new MessageReader(reqDefs).readMessage(callOp!.payload) as {
      prefixes: string[];
      depth: bigint | number;
    };
    expect(decoded.prefixes).toEqual([]);
    expect(Number(decoded.depth)).toBe(0);
  });

  it('cache invalidation on disconnect: reusing a service id with a new type does not stale-hit the cache', async () => {
    // First connection: service id 9 is GetParameters (no inline schema).
    // The first callService populates `serviceRequestDefs.get(9)` with the
    // bundle's GetParameters defs.
    const first = await connectAndAdvertise([
      { id: 9, name: '/n/svc', type: 'rcl_interfaces/srv/GetParameters' },
    ]);
    const firstCall = first.client.callService('/n/svc', { names: ['/x'] });
    firstCall.catch(() => {});
    expect(findSentServiceCallRequest(first.socket)).not.toBeNull();

    await first.client.disconnect();

    // Second connection: same id, *different* type with an incompatible
    // request shape. If the defs/writer caches survived disconnect, the
    // wire bytes would still be encoded against GetParameters defs and
    // either throw at encode time or fail to round-trip via the new type's
    // defs. Decoding via SetParameters defs proves the cache was rebuilt.
    const second = await connectAndAdvertise([
      { id: 9, name: '/n/svc', type: 'rcl_interfaces/srv/SetParameters' },
    ]);
    const setParamsPayload = {
      parameters: [
        {
          name: 'use_sim_time',
          value: {
            type: 1,
            bool_value: true,
            integer_value: 0n,
            double_value: 0,
            string_value: '',
            byte_array_value: new Uint8Array(),
            bool_array_value: [],
            integer_array_value: [],
            double_array_value: [],
            string_array_value: [],
          },
        },
      ],
    };
    const secondCall = second.client.callService('/n/svc', setParamsPayload);
    secondCall.catch(() => {});

    const callOp = findSentServiceCallRequest(second.socket);
    expect(callOp).not.toBeNull();

    const setBundle = getBundledServiceSchema('rcl_interfaces/srv/SetParameters')!;
    const setReqDefs = parseRosMsgDef(setBundle.request, { ros2: true });
    const decoded = new MessageReader(setReqDefs).readMessage(callOp!.payload) as {
      parameters: Array<{ name: string; value: { type: number; bool_value: boolean } }>;
    };
    expect(decoded.parameters).toHaveLength(1);
    expect(decoded.parameters[0]!.name).toBe('use_sim_time');
    expect(decoded.parameters[0]!.value.type).toBe(1);
    expect(decoded.parameters[0]!.value.bool_value).toBe(true);
  });

  // ── action cancellation over a hidden `_action/*` path ──────────────────
  //
  // A ROS 2 action's cancel endpoint is the one action service whose type is
  // universal (`action_msgs/srv/CancelGoal`) rather than generated per
  // action, which is why it can live in the bundle at all. It is also the
  // deepest nesting the bundle carries: GoalInfo composes UUID and Time
  // across three packages, where the parameter services are flat. The
  // GetParameters cases above pin the bundle-as-fallback mechanism; these
  // pin that the mechanism survives a cross-package nested chain on a
  // realistic hidden service path.

  const CANCEL_SERVICE = '/navigate_to_pose/_action/cancel_goal';

  function decodeCancelRequest(payload: Uint8Array): {
    goal_info: {
      goal_id: { uuid: Uint8Array | number[] };
      stamp: { sec: number; nanosec: number };
    };
  } {
    const bundle = getBundledServiceSchema('action_msgs/srv/CancelGoal')!;
    const reqDefs = parseRosMsgDef(bundle.request, { ros2: true });
    return new MessageReader(reqDefs).readMessage(payload) as ReturnType<
      typeof decodeCancelRequest
    >;
  }

  it('schemaless CancelGoal on a hidden _action path: encodes the nested GoalInfo chain', async () => {
    const { client, socket } = await connectAndAdvertise([
      { id: 12, name: CANCEL_SERVICE, type: 'action_msgs/srv/CancelGoal' },
    ]);

    const uuid = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
    const resultPromise = client.callService(CANCEL_SERVICE, {
      goal_info: { goal_id: { uuid }, stamp: { sec: 12, nanosec: 34 } },
    });
    resultPromise.catch(() => {});

    const callOp = findSentServiceCallRequest(socket);
    expect(callOp).not.toBeNull();
    expect(callOp!.encoding).toBe('cdr');
    expect(callOp!.serviceId).toBe(12);
    // Not the 4-byte encapsulation-header fallback: the bundle supplied real
    // field layout, so a non-empty request is encodable.
    expect(callOp!.payload.byteLength).toBeGreaterThan(4);

    const decoded = decodeCancelRequest(callOp!.payload);
    expect(Array.from(decoded.goal_info.goal_id.uuid)).toEqual(uuid);
    expect(decoded.goal_info.stamp.sec).toBe(12);
    expect(decoded.goal_info.stamp.nanosec).toBe(34);
  });

  it('schemaless CancelGoal + empty request: fills the documented cancel-all form', async () => {
    // `action_msgs/srv/CancelGoal` documents an all-zero goal_id with an
    // all-zero stamp as "cancel every goal on this action". Because the
    // bundle supplies defs, `{}` goes through `schemaToTemplate` and
    // materializes exactly that, rather than degrading to the 4-byte
    // encapsulation header. Consumers building an unconditional stop path
    // depend on `{}` being a valid cancel-all rather than a no-op.
    const { client, socket } = await connectAndAdvertise([
      { id: 12, name: CANCEL_SERVICE, type: 'action_msgs/srv/CancelGoal' },
    ]);

    const resultPromise = client.callService(CANCEL_SERVICE, {});
    resultPromise.catch(() => {});

    const callOp = findSentServiceCallRequest(socket);
    expect(callOp).not.toBeNull();
    expect(callOp!.payload.byteLength).toBeGreaterThan(4);

    const decoded = decodeCancelRequest(callOp!.payload);
    expect(Array.from(decoded.goal_info.goal_id.uuid)).toEqual(new Array(16).fill(0));
    expect(decoded.goal_info.stamp.sec).toBe(0);
    expect(decoded.goal_info.stamp.nanosec).toBe(0);
  });

  it('schemaless CancelGoal: decodes a bundled-schema response with goals_canceling', async () => {
    const { client, socket } = await connectAndAdvertise([
      { id: 12, name: CANCEL_SERVICE, type: 'action_msgs/srv/CancelGoal' },
    ]);

    const resultPromise = client.callService(CANCEL_SERVICE, {});
    const callOp = findSentServiceCallRequest(socket)!;

    // Build the response with the same bundled defs the client must fall
    // back to, since the bridge advertised no responseSchema either.
    const bundle = getBundledServiceSchema('action_msgs/srv/CancelGoal')!;
    const respDefs = parseRosMsgDef(bundle.response, { ros2: true });
    const responseBytes = new MessageWriter(respDefs).writeMessage({
      return_code: 0,
      goals_canceling: [
        {
          goal_id: { uuid: new Array(16).fill(7) },
          stamp: { sec: 1, nanosec: 2 },
        },
      ],
    });

    socket.simulateMessage(
      foxgloveServiceCallResponseFrame(12, callOp.callId, 'cdr', responseBytes),
    );

    const result = (await resultPromise) as {
      return_code: number;
      goals_canceling: Array<{ goal_id: { uuid: Uint8Array | number[] } }>;
    };
    expect(result.return_code).toBe(0);
    expect(result.goals_canceling).toHaveLength(1);
    expect(Array.from(result.goals_canceling[0]!.goal_id.uuid)).toEqual(new Array(16).fill(7));
  });
});

describe('builtinSchemas — lookup tolerates the 2-part / 3-part name asymmetry', () => {
  it('resolves a 2-part service name to the bundled 3-part srv schema', () => {
    const threePart = getBundledServiceSchema('rcl_interfaces/srv/ListParameters');
    const twoPart = getBundledServiceSchema('rcl_interfaces/ListParameters');
    expect(twoPart).not.toBeNull();
    expect(twoPart).toBe(threePart);
  });

  it('hasBundledServiceSchema agrees with the tolerant lookup', () => {
    expect(hasBundledServiceSchema('action_msgs/CancelGoal')).toBe(true);
    expect(hasBundledServiceSchema('action_msgs/srv/CancelGoal')).toBe(true);
  });

  it('still returns null for a genuinely unknown service', () => {
    expect(getBundledServiceSchema('my_pkg/srv/Frobnicate')).toBeNull();
    expect(getBundledServiceSchema('my_pkg/Frobnicate')).toBeNull();
    expect(hasBundledServiceSchema('my_pkg/Frobnicate')).toBe(false);
  });
});
