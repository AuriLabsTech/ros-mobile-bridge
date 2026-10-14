import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import { installMockWebSocket, type MockWebSocketHandle } from './_helpers/mock-websocket';

/**
 * `getSchemaTemplate` for a type the bridge describes only on a service
 * advertisement: a service's request side, which is a ROS message type like
 * any other (`std_srvs/srv/SetBool_Request`). A consumer building a request
 * form, or checking a body before it is sent, needs the field list.
 */

describe('FoxgloveClient.getSchemaTemplate for service request types', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });

  afterEach(() => {
    ws.restore();
  });

  async function connectAdvertising(
    services: Record<string, unknown>[],
    channels: Record<string, unknown>[] = [],
    options?: ConstructorParameters<typeof FoxgloveClient>[0],
  ): Promise<FoxgloveClient> {
    const client = new FoxgloveClient(options);
    const connectPromise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.sdk.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(JSON.stringify({ op: 'advertise', channels }));
    socket.simulateMessage(JSON.stringify({ op: 'advertiseServices', services }));
    await connectPromise;
    return client;
  }

  const setBool = {
    id: 1,
    name: '/bench/answers',
    type: 'std_srvs/srv/SetBool',
    request: {
      encoding: 'cdr',
      schemaName: 'std_srvs/srv/SetBool_Request',
      schemaEncoding: 'ros2msg',
      schema: 'bool data # e.g. for hardware enabling / disabling\n',
    },
    response: {
      encoding: 'cdr',
      schemaName: 'std_srvs/srv/SetBool_Response',
      schemaEncoding: 'ros2msg',
      schema: 'bool success\nstring message\n',
    },
  };

  it('returns the request template of an advertised service', async () => {
    const client = await connectAdvertising([setBool]);
    expect(client.getSchemaTemplate('std_srvs/srv/SetBool_Request')).toEqual({ data: false });
  });

  it('returns the response template of an advertised service', async () => {
    const client = await connectAdvertising([setBool]);
    expect(client.getSchemaTemplate('std_srvs/srv/SetBool_Response')).toEqual({
      success: false,
      message: '',
    });
  });

  it('names the sides <type>_Request and <type>_Response in the legacy flat form', async () => {
    const client = await connectAdvertising([
      {
        id: 2,
        name: '/legacy',
        type: 'std_srvs/srv/SetBool',
        requestSchema: 'bool data\n',
        responseSchema: 'bool success\nstring message\n',
      },
    ]);
    expect(client.getSchemaTemplate('std_srvs/srv/SetBool_Request')).toEqual({ data: false });
    expect(client.getSchemaTemplate('std_srvs/srv/SetBool_Response')).toEqual({
      success: false,
      message: '',
    });
  });

  it('returns {} for a fieldless response, nested or legacy flat', async () => {
    const client = await connectAdvertising([
      {
        id: 4,
        name: '/nested_empty',
        type: 'std_srvs/srv/Empty',
        request: { encoding: 'cdr', schemaName: 'std_srvs/srv/Empty_Request', schema: '' },
        response: { encoding: 'cdr', schemaName: 'std_srvs/srv/Empty_Response', schema: '' },
      },
      {
        id: 5,
        name: '/flat_trigger_like',
        type: 'my_pkg/srv/Ping',
        requestSchema: 'string note\n',
        responseSchema: '',
      },
    ]);
    expect(client.getSchemaTemplate('std_srvs/srv/Empty_Response')).toEqual({});
    expect(client.getSchemaTemplate('my_pkg/srv/Ping_Response')).toEqual({});
    expect(client.getSchemaTemplate('my_pkg/srv/Ping_Request')).toEqual({ note: '' });
  });

  it('reads each side on its own: a fieldless request beside a response with fields', async () => {
    // std_srvs/srv/Trigger's shape, nested and in the legacy flat form.
    const client = await connectAdvertising([
      {
        id: 11,
        name: '/trigger',
        type: 'std_srvs/srv/Trigger',
        request: { encoding: 'cdr', schemaName: 'std_srvs/srv/Trigger_Request', schema: '' },
        response: {
          encoding: 'cdr',
          schemaName: 'std_srvs/srv/Trigger_Response',
          schemaEncoding: 'ros2msg',
          schema: 'bool success\nstring message\n',
        },
      },
      {
        id: 12,
        name: '/flat_trigger',
        type: 'my_pkg/srv/Go',
        requestSchema: '',
        responseSchema: 'bool success\n',
      },
    ]);
    expect(client.getSchemaTemplate('std_srvs/srv/Trigger_Request')).toEqual({});
    expect(client.getSchemaTemplate('my_pkg/srv/Go_Request')).toEqual({});
  });

  it('matches a channel the bridge names in two parts when asked with three', async () => {
    const client = await connectAdvertising(
      [],
      [
        {
          id: 3,
          topic: '/legacy',
          encoding: 'cdr',
          schemaName: 'std_msgs/String',
          schemaEncoding: 'ros2msg',
          schema: 'string data\n',
        },
      ],
    );
    expect(client.getSchemaTemplate('std_msgs/msg/String')).toEqual({ data: '' });
  });

  it('returns {} for a request the bridge describes as having no fields', async () => {
    const client = await connectAdvertising([
      {
        id: 3,
        name: '/fixture/empty',
        type: 'std_srvs/srv/Empty',
        request: { encoding: 'cdr', schemaName: 'std_srvs/srv/Empty_Request', schema: '' },
        response: { encoding: 'cdr', schemaName: 'std_srvs/srv/Empty_Response', schema: '' },
      },
    ]);
    expect(client.getSchemaTemplate('std_srvs/srv/Empty_Request')).toEqual({});
  });

  it('matches the two-part name without the srv segment (ADR 0002)', async () => {
    const client = await connectAdvertising([setBool]);
    expect(client.getSchemaTemplate('std_srvs/SetBool_Request')).toEqual({ data: false });
  });

  it('returns {} for a fieldless topic type (cdr, empty schema; ADR 0010)', async () => {
    const client = await connectAdvertising(
      [],
      [{ id: 1, topic: '/ping', encoding: 'cdr', schemaName: 'std_msgs/msg/Empty', schema: '' }],
    );
    expect(client.getSchemaTemplate('std_msgs/msg/Empty')).toEqual({});
  });

  it('matches a topic type by its two-part name too, as it does a service type', async () => {
    const client = await connectAdvertising(
      [],
      [
        {
          id: 1,
          topic: '/chatter',
          encoding: 'cdr',
          schemaName: 'std_msgs/msg/String',
          schemaEncoding: 'ros2msg',
          schema: 'string data\n',
        },
      ],
    );
    expect(client.getSchemaTemplate('std_msgs/String')).toEqual({ data: '' });
  });

  it('skips a service whose schema it cannot read and uses another of the same type', async () => {
    const unreadable = {
      ...setBool,
      id: 5,
      name: '/a',
      request: { ...setBool.request, schemaEncoding: 'ros2msg', schema: 'this is not a schema !!' },
    };
    const client = await connectAdvertising([unreadable, { ...setBool, id: 6, name: '/b' }]);
    expect(client.getSchemaTemplate('std_srvs/srv/SetBool_Request')).toEqual({ data: false });
  });

  it('does not warn on every call for a service schema it cannot read', async () => {
    const warn = vi.fn();
    const unreadable = {
      ...setBool,
      request: { ...setBool.request, schemaEncoding: 'ros2msg', schema: 'this is not a schema !!' },
    };
    const client = await connectAdvertising([unreadable], [], {
      logger: { log: vi.fn(), warn, error: vi.fn() },
    });
    client.getSchemaTemplate('std_srvs/srv/SetBool_Request');
    client.getSchemaTemplate('std_srvs/srv/SetBool_Request');
    expect(warn).not.toHaveBeenCalled();
  });

  // `rcl_interfaces/srv/GetParameters` is in the built-in bundle; the
  // template follows the encoder's precedence: advertised, then bundle.
  const getParameters = (request: Record<string, unknown>): Record<string, unknown> => ({
    id: 7,
    name: '/node/get_parameters',
    type: 'rcl_interfaces/srv/GetParameters',
    request,
    response: { encoding: 'cdr', schemaName: 'rcl_interfaces/srv/GetParameters_Response' },
  });

  it('uses the bundle for a bundled type advertised with an empty schema', async () => {
    const client = await connectAdvertising([
      getParameters({
        encoding: 'cdr',
        schemaName: 'rcl_interfaces/srv/GetParameters_Request',
        schema: '',
      }),
    ]);
    expect(client.getSchemaTemplate('rcl_interfaces/srv/GetParameters_Request')).toEqual({
      names: [],
    });
  });

  it('uses the bundle for a bundled type whose advertised schema cannot be read', async () => {
    const client = await connectAdvertising([
      getParameters({
        encoding: 'cdr',
        schemaName: 'rcl_interfaces/srv/GetParameters_Request',
        schemaEncoding: 'ros2msg',
        schema: 'this is not a schema !!',
      }),
    ]);
    expect(client.getSchemaTemplate('rcl_interfaces/srv/GetParameters_Request')).toEqual({
      names: [],
    });
  });

  it('answers as the encoder writes: a whitespace schema on a bundled type is fieldless', async () => {
    // callService parses the advertised '\n' as a type with no fields and
    // writes the 5-byte empty request, so the template must say {} too: a
    // body check built on it then refuses fields the call would drop.
    const client = await connectAdvertising([
      getParameters({
        encoding: 'cdr',
        schemaName: 'rcl_interfaces/srv/GetParameters_Request',
        schema: '\n',
      }),
    ]);
    expect(client.getSchemaTemplate('rcl_interfaces/srv/GetParameters_Request')).toEqual({});
  });

  it('returns null for a request schema the encoder cannot read (JSON Schema)', async () => {
    const client = await connectAdvertising([
      {
        ...setBool,
        request: {
          encoding: 'json',
          schemaName: 'std_srvs/srv/SetBool_Request',
          schemaEncoding: 'jsonschema',
          schema: '{"type":"object","properties":{"data":{"type":"boolean"}}}',
        },
      },
    ]);
    expect(client.getSchemaTemplate('std_srvs/srv/SetBool_Request')).toBeNull();
  });

  it('skips a channel whose schema is only whitespace without cdr', async () => {
    const client = await connectAdvertising(
      [],
      [{ id: 2, topic: '/s', encoding: 'json', schemaName: 'std_msgs/msg/String', schema: '\n' }],
    );
    expect(client.getSchemaTemplate('std_msgs/msg/String')).toBeNull();
  });

  it('does not answer a msg type with a service type of the same package and name', async () => {
    const client = await connectAdvertising([setBool]);
    expect(client.getSchemaTemplate('std_srvs/msg/SetBool_Request')).toBeNull();
  });

  it('returns null for a type no channel or service describes', async () => {
    const client = await connectAdvertising([setBool]);
    expect(client.getSchemaTemplate('std_srvs/srv/Trigger_Request')).toBeNull();
  });
});

describe('FoxgloveClient.getSchemaTemplate for action goal types', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });

  afterEach(() => {
    ws.restore();
  });

  async function connectWithSendGoal(
    requestSchema: string,
    options?: ConstructorParameters<typeof FoxgloveClient>[0],
  ): Promise<FoxgloveClient> {
    const client = new FoxgloveClient(options);
    const connectPromise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.sdk.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [] }));
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertiseServices',
        services: [
          {
            id: 9,
            name: '/demo/_action/send_goal',
            type: 'demo_msgs/action/Demo_SendGoal',
            request: {
              encoding: 'cdr',
              schemaName: 'demo_msgs/action/Demo_SendGoal_Request',
              schemaEncoding: 'ros2msg',
              schema: requestSchema,
            },
            response: {
              encoding: 'cdr',
              schemaName: 'demo_msgs/action/Demo_SendGoal_Response',
              schemaEncoding: 'ros2msg',
              schema: 'bool accepted\n',
            },
          },
        ],
      }),
    );
    await connectPromise;
    return client;
  }

  const UUID_DEF = [
    '================================================================================',
    'MSG: unique_identifier_msgs/UUID',
    'uint8[16] uuid',
  ];
  const POSE_DEF = [
    '================================================================================',
    'MSG: demo_msgs/Pose',
    'float64 x',
  ];

  it('derives <Action>_Goal from a send_goal request that inlines the goal (rosidl)', async () => {
    const client = await connectWithSendGoal(
      ['unique_identifier_msgs/UUID goal_id', '#goal definition', 'string label', ...UUID_DEF].join(
        '\n',
      ),
    );
    expect(client.getSchemaTemplate('demo_msgs/action/Demo_Goal')).toEqual({ label: '' });
    expect(client.getSchemaTemplate('demo_msgs/Demo_Goal')).toEqual({ label: '' });
  });

  it('keeps a goal field that is itself named goal when the request is inlined', async () => {
    // nav2's ComputePathToPose declares `geometry_msgs/PoseStamped goal`.
    const client = await connectWithSendGoal(
      [
        'unique_identifier_msgs/UUID goal_id',
        'demo_msgs/Pose goal',
        'string planner_id',
        ...UUID_DEF,
        ...POSE_DEF,
      ].join('\n'),
    );
    expect(client.getSchemaTemplate('demo_msgs/action/Demo_Goal')).toEqual({
      goal: { x: 0 },
      planner_id: '',
    });
  });

  it('does not warn on every call for a send_goal schema it cannot read', async () => {
    const warn = vi.fn();
    const client = await connectWithSendGoal('this is not a schema !!', {
      logger: { log: vi.fn(), warn, error: vi.fn() },
    });
    expect(client.getSchemaTemplate('demo_msgs/action/Demo_Goal')).toBeNull();
    expect(client.getSchemaTemplate('demo_msgs/action/Demo_Goal')).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not answer a msg type ending in _Goal with an action goal', async () => {
    const client = await connectWithSendGoal(
      ['unique_identifier_msgs/UUID goal_id', 'string label', ...UUID_DEF].join('\n'),
    );
    expect(client.getSchemaTemplate('demo_msgs/msg/Demo_Goal')).toBeNull();
  });

  it('derives <Action>_Goal from a send_goal request that nests the goal wrapper', async () => {
    const client = await connectWithSendGoal(
      [
        'unique_identifier_msgs/UUID goal_id',
        'demo_msgs/action/Demo_Goal goal',
        ...UUID_DEF,
        '================================================================================',
        'MSG: demo_msgs/action/Demo_Goal',
        'string label',
      ].join('\n'),
    );
    expect(client.getSchemaTemplate('demo_msgs/action/Demo_Goal')).toEqual({ label: '' });
  });
});
