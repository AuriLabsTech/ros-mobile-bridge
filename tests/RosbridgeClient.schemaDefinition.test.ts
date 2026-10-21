// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * `getSchemaDefinition` on rosbridge (ADR 0032): message types a topic
 * carries, through `/rosapi/topics_and_raw_types` only, and the bundled
 * system services with no call. Never the type-detail services, which kill
 * `rosapi_node` on bounded types (docs research, 2026-10-21).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RosbridgeClient } from '../src/RosbridgeClient';
import { installMockWebSocket, type MockWebSocketHandle } from './_helpers/mock-websocket';

type Socket = ReturnType<MockWebSocketHandle['last']>;

const SEP = '='.repeat(80);
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const RAW = {
  topics: ['/pose', '/solid'],
  types: ['geometry_msgs/msg/PointStamped', 'shape_msgs/msg/SolidPrimitive'],
  typedefs_full_text: [
    `# A point with a header
std_msgs/Header header
geometry_msgs/Point point

${SEP}
MSG: std_msgs/Header
builtin_interfaces/Time stamp
string frame_id

${SEP}
MSG: builtin_interfaces/Time
int32 sec
uint32 nanosec

${SEP}
MSG: geometry_msgs/Point
float64 x
float64 y
float64 z
`,
    `uint8 BOX=1
uint8 SPHERE=2
uint8 type
float64[<=3] dimensions
`,
  ],
};

interface Rosapi {
  /** Answer topics_and_raw_types with a failure frame. */
  failRaw?: boolean;
}

/** Answers every open call the client has made, until it stops asking. */
async function serve(socket: Socket, answered: Set<string>, rosapi: Rosapi = {}): Promise<void> {
  for (let round = 0; round < 50; round++) {
    await tick();
    const open = socket.sentJson.filter(
      (m) => m.op === 'call_service' && !answered.has(m.id as string),
    );
    if (open.length === 0) {
      await tick();
      if (socket.sentJson.every((m) => m.op !== 'call_service' || answered.has(m.id as string))) {
        return;
      }
      continue;
    }
    for (const call of open) {
      answered.add(call.id as string);
      const service = call.service as string;
      let result = true;
      let values: unknown = {};
      if (service === '/rosapi/topics') values = { topics: RAW.topics, types: RAW.types };
      else if (service === '/rosapi/services') values = { services: [] };
      else if (service === '/rosapi/topics_and_raw_types') {
        if (rosapi.failRaw) {
          result = false;
          values = 'Service /rosapi/topics_and_raw_types does not exist';
        } else values = RAW;
      }
      socket.simulateMessage(
        JSON.stringify({ op: 'service_response', id: call.id, service, result, values }),
      );
    }
  }
}

function calledServices(socket: Socket): string[] {
  return socket.sentJson.filter((m) => m.op === 'call_service').map((m) => m.service as string);
}

describe('RosbridgeClient.getSchemaDefinition', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  async function connected(): Promise<{
    client: RosbridgeClient;
    socket: Socket;
    answered: Set<string>;
  }> {
    const client = new RosbridgeClient({ latencyProbeMs: 0, discoveryRefreshMs: 0 });
    const p = client.connect('ws://localhost:9090');
    const socket = ws.last();
    socket.simulateOpen();
    await p;
    const answered = new Set<string>();
    await serve(socket, answered);
    return { client, socket, answered };
  }

  async function ask(
    env: { client: RosbridgeClient; socket: Socket; answered: Set<string> },
    name: string,
    rosapi?: Rosapi,
  ): ReturnType<RosbridgeClient['getSchemaDefinition']> {
    const pending = env.client.getSchemaDefinition(name);
    await serve(env.socket, env.answered, rosapi);
    return pending;
  }

  it("describes a topic's type from the robot's own message text", async () => {
    const env = await connected();
    const def = await ask(env, 'geometry_msgs/msg/PointStamped');
    expect(def?.root).toBe('geometry_msgs/msg/PointStamped');
    expect(Object.keys(def?.types ?? {}).sort()).toEqual([
      'builtin_interfaces/msg/Time',
      'geometry_msgs/msg/Point',
      'geometry_msgs/msg/PointStamped',
      'std_msgs/msg/Header',
    ]);
    expect(calledServices(env.socket)).toContain('/rosapi/topics_and_raw_types');
  });

  it('keeps bounds and constants, the case the detail services crash on', async () => {
    const env = await connected();
    const def = await ask(env, 'shape_msgs/SolidPrimitive');
    expect(def?.types['shape_msgs/msg/SolidPrimitive']).toEqual({
      name: 'shape_msgs/msg/SolidPrimitive',
      fields: [
        { name: 'type', type: 'uint8', isComplex: false, isArray: false },
        {
          name: 'dimensions',
          type: 'float64',
          isComplex: false,
          isArray: true,
          arrayUpperBound: 3,
        },
      ],
      constants: [
        { name: 'BOX', type: 'uint8', value: 1 },
        { name: 'SPHERE', type: 'uint8', value: 2 },
      ],
    });
  });

  it('never calls a type-detail service', async () => {
    const env = await connected();
    await ask(env, 'geometry_msgs/msg/PointStamped');
    await ask(env, 'pkg/msg/NotCarried');
    await ask(env, 'std_srvs/srv/SetBool_Request');
    expect(calledServices(env.socket).filter((s) => s.endsWith('_details'))).toEqual([]);
  });

  it('answers null for a type no topic carries', async () => {
    const env = await connected();
    expect(await ask(env, 'pkg/msg/NotCarried')).toBeNull();
  });

  it('answers null when the raw-types call fails', async () => {
    const env = await connected();
    expect(await ask(env, 'geometry_msgs/msg/PointStamped', { failRaw: true })).toBeNull();
  });

  it('describes a bundled system service side without asking the robot', async () => {
    const env = await connected();
    const before = env.socket.sentJson.length;
    const def = await env.client.getSchemaDefinition('rcl_interfaces/srv/GetParameters_Request');
    expect(def?.types['rcl_interfaces/srv/GetParameters_Request']?.fields).toEqual([
      { name: 'names', type: 'string', isComplex: false, isArray: true },
    ]);
    expect(env.socket.sentJson.length).toBe(before);
  });

  it('answers null for a service side outside the bundle without asking the robot', async () => {
    const env = await connected();
    const before = env.socket.sentJson.length;
    expect(await env.client.getSchemaDefinition('std_srvs/srv/SetBool_Request')).toBeNull();
    expect(env.socket.sentJson.length).toBe(before);
  });

  it('asks like the other rosapi lookups: 5 s timeout, no latency sample', async () => {
    const samples: number[] = [];
    const client = new RosbridgeClient({
      latencyProbeMs: 0,
      discoveryRefreshMs: 0,
      onLatency: (ms) => samples.push(ms),
    });
    const p = client.connect('ws://localhost:9090');
    const socket = ws.last();
    socket.simulateOpen();
    await p;
    const answered = new Set<string>();
    await serve(socket, answered);
    const before = samples.length;

    const pending = client.getSchemaDefinition('geometry_msgs/msg/PointStamped');
    await serve(socket, answered);
    expect((await pending)?.root).toBe('geometry_msgs/msg/PointStamped');

    const call = socket.sentJson.find((m) => m.service === '/rosapi/topics_and_raw_types');
    expect(call?.timeout).toBe(5);
    expect(samples.length).toBe(before);
  });

  it('answers null when not connected', async () => {
    const client = new RosbridgeClient({ latencyProbeMs: 0, discoveryRefreshMs: 0 });
    expect(await client.getSchemaDefinition('geometry_msgs/msg/PointStamped')).toBeNull();
  });
});
