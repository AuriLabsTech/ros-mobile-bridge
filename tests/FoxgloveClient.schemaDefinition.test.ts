// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * `getSchemaDefinition` on Foxglove WebSocket (ADR 0032): every ROS type
 * `getSchemaTemplate` answers for, as one flat map of three-part names.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import { installMockWebSocket, type MockWebSocketHandle } from './_helpers/mock-websocket';

const SEP = '='.repeat(80);

describe('FoxgloveClient.getSchemaDefinition', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });

  afterEach(() => {
    ws.restore();
  });

  async function connectAdvertising(
    channels: Record<string, unknown>[],
    services: Record<string, unknown>[] = [],
  ): Promise<FoxgloveClient> {
    const client = new FoxgloveClient();
    const connectPromise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.sdk.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(JSON.stringify({ op: 'advertise', channels }));
    socket.simulateMessage(JSON.stringify({ op: 'advertiseServices', services }));
    await connectPromise;
    return client;
  }

  const poseStamped = {
    id: 1,
    topic: '/pose',
    encoding: 'cdr',
    schemaName: 'geometry_msgs/msg/PoseStamped',
    schemaEncoding: 'ros2msg',
    schema: `std_msgs/Header header
geometry_msgs/Point position
${SEP}
MSG: std_msgs/Header
builtin_interfaces/Time stamp
string frame_id
${SEP}
MSG: geometry_msgs/Point
float64 x
float64 y
float64 z`,
  };

  it("describes a topic's type with its nested types", async () => {
    const client = await connectAdvertising([poseStamped]);
    const def = await client.getSchemaDefinition('geometry_msgs/msg/PoseStamped');
    expect(def?.root).toBe('geometry_msgs/msg/PoseStamped');
    expect(Object.keys(def?.types ?? {}).sort()).toEqual([
      'builtin_interfaces/msg/Time',
      'geometry_msgs/msg/Point',
      'geometry_msgs/msg/PoseStamped',
      'std_msgs/msg/Header',
    ]);
    expect(def?.types['std_msgs/msg/Header']?.fields[0]).toEqual({
      name: 'stamp',
      type: 'builtin_interfaces/msg/Time',
      isComplex: true,
      isArray: false,
    });
  });

  it('accepts the two-part name and still answers with three-part names', async () => {
    const client = await connectAdvertising([
      { ...poseStamped, schemaName: 'geometry_msgs/PoseStamped' },
    ]);
    const def = await client.getSchemaDefinition('geometry_msgs/PoseStamped');
    expect(def?.root).toBe('geometry_msgs/msg/PoseStamped');
  });

  it('describes a fieldless topic type with no fields', async () => {
    const client = await connectAdvertising([
      { id: 2, topic: '/e', encoding: 'cdr', schemaName: 'std_msgs/msg/Empty', schema: '' },
    ]);
    expect(await client.getSchemaDefinition('std_msgs/msg/Empty')).toEqual({
      root: 'std_msgs/msg/Empty',
      types: { 'std_msgs/msg/Empty': { name: 'std_msgs/msg/Empty', fields: [], constants: [] } },
    });
  });

  it('answers null for a JSON Schema channel, an unknown type and an unreadable schema', async () => {
    const client = await connectAdvertising([
      {
        id: 3,
        topic: '/j',
        encoding: 'json',
        schemaName: 'pkg/msg/J',
        schemaEncoding: 'jsonschema',
        schema: '{"type":"object","properties":{"a":{"type":"number"}}}',
      },
      {
        id: 4,
        topic: '/bad',
        encoding: 'cdr',
        schemaName: 'pkg/msg/Bad',
        schema: '%%% not a schema',
      },
    ]);
    expect(await client.getSchemaDefinition('pkg/msg/J')).toBeNull();
    expect(await client.getSchemaDefinition('pkg/msg/Nope')).toBeNull();
    expect(await client.getSchemaDefinition('pkg/msg/Bad')).toBeNull();
  });

  it('parses a channel the way the decoder does, so it never describes a layout the decoder cannot read', async () => {
    // The decoder reads IDL only for the exact encoding `ros2idl`; anything
    // else goes to the .msg parser, which cannot read IDL text.
    const client = await connectAdvertising([
      {
        id: 7,
        topic: '/shout',
        encoding: 'cdr',
        schemaName: 'pkg/msg/Shout',
        schemaEncoding: 'ROS2IDL',
        schema: `${SEP}
IDL: pkg/msg/Shout
module pkg { module msg { struct Shout { int32 level; }; }; };`,
      },
    ]);
    expect(await client.getSchemaDefinition('pkg/msg/Shout')).toBeNull();
  });

  const setBool = {
    id: 1,
    name: '/bench/answers',
    type: 'std_srvs/srv/SetBool',
    request: {
      encoding: 'cdr',
      schemaName: 'std_srvs/srv/SetBool_Request',
      schemaEncoding: 'ros2msg',
      schema: 'bool data\n',
    },
    response: {
      encoding: 'cdr',
      schemaName: 'std_srvs/srv/SetBool_Response',
      schemaEncoding: 'ros2msg',
      schema: 'bool success\nstring message\n',
    },
  };

  it('describes both sides of an advertised service', async () => {
    const client = await connectAdvertising([], [setBool]);
    const req = await client.getSchemaDefinition('std_srvs/srv/SetBool_Request');
    expect(req).toEqual({
      root: 'std_srvs/srv/SetBool_Request',
      types: {
        'std_srvs/srv/SetBool_Request': {
          name: 'std_srvs/srv/SetBool_Request',
          fields: [{ name: 'data', type: 'bool', isComplex: false, isArray: false }],
          constants: [],
        },
      },
    });
    const res = await client.getSchemaDefinition('std_srvs/srv/SetBool_Response');
    expect(res?.types['std_srvs/srv/SetBool_Response']?.fields.map((f) => f.name)).toEqual([
      'success',
      'message',
    ]);
  });

  it('never answers a message-kind name with a service side', async () => {
    const client = await connectAdvertising([], [setBool]);
    expect(await client.getSchemaDefinition('std_srvs/msg/SetBool_Request')).toBeNull();
  });

  it('describes a bundled system service the bridge sent no schema for', async () => {
    const client = await connectAdvertising(
      [],
      [{ id: 9, name: '/node/get_parameters', type: 'rcl_interfaces/srv/GetParameters' }],
    );
    const def = await client.getSchemaDefinition('rcl_interfaces/srv/GetParameters_Request');
    expect(def?.types['rcl_interfaces/srv/GetParameters_Request']?.fields).toEqual([
      { name: 'names', type: 'string', isComplex: false, isArray: true },
    ]);
  });

  const nestedSendGoal = {
    id: 20,
    name: '/fibonacci/_action/send_goal',
    type: 'example_interfaces/action/Fibonacci_SendGoal',
    request: {
      encoding: 'cdr',
      schemaName: 'example_interfaces/action/Fibonacci_SendGoal_Request',
      schemaEncoding: 'ros2msg',
      schema: `unique_identifier_msgs/UUID goal_id
example_interfaces/Fibonacci_Goal goal
${SEP}
MSG: unique_identifier_msgs/UUID
uint8[16] uuid
${SEP}
MSG: example_interfaces/Fibonacci_Goal
int32 order`,
    },
    response: {
      encoding: 'cdr',
      schemaName: 'example_interfaces/action/Fibonacci_SendGoal_Response',
      schemaEncoding: 'ros2msg',
      schema: 'bool accepted\nbuiltin_interfaces/Time stamp',
    },
  };

  const GOAL = {
    root: 'example_interfaces/action/Fibonacci_Goal',
    types: {
      'example_interfaces/action/Fibonacci_Goal': {
        name: 'example_interfaces/action/Fibonacci_Goal',
        fields: [{ name: 'order', type: 'int32', isComplex: false, isArray: false }],
        constants: [],
      },
    },
  };

  it('describes an action goal from a send_goal request that nests it', async () => {
    const client = await connectAdvertising([], [nestedSendGoal]);
    expect(await client.getSchemaDefinition('example_interfaces/action/Fibonacci_Goal')).toEqual(
      GOAL,
    );
  });

  it('describes an action goal from a send_goal request that inlines it', async () => {
    const client = await connectAdvertising(
      [],
      [
        {
          ...nestedSendGoal,
          request: {
            ...nestedSendGoal.request,
            schema: `unique_identifier_msgs/UUID goal_id
int32 order
${SEP}
MSG: unique_identifier_msgs/UUID
uint8[16] uuid`,
          },
        },
      ],
    );
    expect(await client.getSchemaDefinition('example_interfaces/action/Fibonacci_Goal')).toEqual(
      GOAL,
    );
  });

  it('describes the send_goal request itself with the goal as an action type', async () => {
    const client = await connectAdvertising([], [nestedSendGoal]);
    const def = await client.getSchemaDefinition(
      'example_interfaces/action/Fibonacci_SendGoal_Request',
    );
    expect(Object.keys(def?.types ?? {}).sort()).toEqual([
      'example_interfaces/action/Fibonacci_Goal',
      'example_interfaces/action/Fibonacci_SendGoal_Request',
      'unique_identifier_msgs/msg/UUID',
    ]);
  });

  it('waits for the first service list when the bridge offers services', async () => {
    const client = new FoxgloveClient();
    const connectPromise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.sdk.v1');
    socket.simulateMessage(
      JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: ['services'] }),
    );
    socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [] }));
    await connectPromise;

    const pending = client.getSchemaDefinition('std_srvs/srv/SetBool_Request');
    socket.simulateMessage(JSON.stringify({ op: 'advertiseServices', services: [setBool] }));
    expect((await pending)?.root).toBe('std_srvs/srv/SetBool_Request');
  });

  it('answers an advertised topic type without waiting for a service list', async () => {
    const client = new FoxgloveClient();
    const connectPromise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.sdk.v1');
    socket.simulateMessage(
      JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: ['services'] }),
    );
    socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [poseStamped] }));
    await connectPromise;

    // No service list ever arrives; the wait for one would last 2 s.
    const late = new Promise((r) => setTimeout(() => r('late'), 200));
    const answer = await Promise.race([
      client.getSchemaDefinition('geometry_msgs/msg/PoseStamped'),
      late,
    ]);
    expect(answer).not.toBe('late');
    expect((answer as { root: string }).root).toBe('geometry_msgs/msg/PoseStamped');
  });

  it('hands out fresh objects: changing one answer does not change the next', async () => {
    const client = await connectAdvertising([], [setBool]);
    const first = await client.getSchemaDefinition('std_srvs/srv/SetBool_Request');
    first!.types['std_srvs/srv/SetBool_Request']!.fields.length = 0;
    const second = await client.getSchemaDefinition('std_srvs/srv/SetBool_Request');
    expect(second?.types['std_srvs/srv/SetBool_Request']?.fields).toHaveLength(1);
    expect(client.getSchemaTemplate('std_srvs/srv/SetBool_Request')).toEqual({ data: false });
  });
});
