import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RosbridgeClient } from '../src/RosbridgeClient';
import { installMockWebSocket, type MockWebSocketHandle } from './_helpers/mock-websocket';

describe('RosbridgeClient', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });

  afterEach(() => {
    ws.restore();
  });

  async function connectedClient(): Promise<{
    client: RosbridgeClient;
    socket: ReturnType<MockWebSocketHandle['last']>;
  }> {
    const client = new RosbridgeClient();
    const promise = client.connect('ws://localhost:9090');
    const socket = ws.last();
    socket.simulateOpen();
    await promise;
    return { client, socket };
  }

  it('reports connected after the WS opens', async () => {
    const { client, socket } = await connectedClient();
    expect(client.isConnected).toBe(true);
    expect(socket.url).toBe('ws://localhost:9090');
  });

  it('publish auto-advertises and emits a publish op', async () => {
    const { client, socket } = await connectedClient();

    client.publish('/cmd_vel', 'geometry_msgs/msg/Twist', {
      linear: { x: 0, y: 0, z: 0 },
      angular: { x: 0, y: 0, z: 0 },
    });

    const ops = socket.sentJson;
    const advertise = ops.find((m) => m.op === 'advertise');
    const publish = ops.find((m) => m.op === 'publish');

    expect(advertise).toMatchObject({ op: 'advertise', topic: '/cmd_vel', type: 'geometry_msgs/msg/Twist' });
    expect(publish).toMatchObject({ op: 'publish', topic: '/cmd_vel' });
    expect(publish?.msg).toMatchObject({
      linear: { x: 0, y: 0, z: 0 },
      angular: { x: 0, y: 0, z: 0 },
    });
  });

  it('does not re-advertise on the second publish to the same topic', async () => {
    const { client, socket } = await connectedClient();
    client.publish('/foo', 'std_msgs/msg/Int32', { data: 1 });
    client.publish('/foo', 'std_msgs/msg/Int32', { data: 2 });

    const advertiseCount = socket.sentJson.filter(
      (m) => m.op === 'advertise' && m.topic === '/foo',
    ).length;
    expect(advertiseCount).toBe(1);

    const publishes = socket.sentJson.filter((m) => m.op === 'publish' && m.topic === '/foo');
    expect(publishes.length).toBe(2);
  });

  it('subscribe sends a subscribe op and routes incoming publishes to the callback', async () => {
    const { client, socket } = await connectedClient();

    const received: Array<{ topic: string; data: unknown }> = [];
    client.subscribe('/state', (msg) => {
      received.push({ topic: msg.topic, data: msg.data });
    });

    const subscribeOps = socket.sentJson.filter((m) => m.op === 'subscribe');
    expect(subscribeOps.length).toBe(1);
    expect(subscribeOps[0]).toMatchObject({ topic: '/state', queue_length: 1 });

    // Server pushes a publish op for the same topic.
    socket.simulateMessage(JSON.stringify({ op: 'publish', topic: '/state', msg: { value: 42 } }));

    expect(received).toEqual([{ topic: '/state', data: { value: 42 } }]);
  });

  it('drops publishes for unsubscribed topics via the fast-path without dispatching', async () => {
    const { client, socket } = await connectedClient();

    const received: unknown[] = [];
    // Subscribe to one topic so the active-subscriptions map is non-empty.
    client.subscribe('/known', (msg) => {
      received.push(msg);
    });

    // Send a publish for a topic the client never subscribed to. The
    // fast-path detects "not subscribed" and drops without parsing.
    socket.simulateMessage(JSON.stringify({ op: 'publish', topic: '/unknown', msg: { x: 1 } }));

    expect(received.length).toBe(0);
  });

  it('handles a service_response and resolves the pending promise', async () => {
    const { client, socket } = await connectedClient();

    const resultPromise = client.callService('/my/service', {});
    // The services-poll fires its own call_service on connect for
    // /rosapi/services; filter by service name to find ours.
    const callOp = socket.sentJson.find(
      (m) => m.op === 'call_service' && m.service === '/my/service',
    );
    expect(callOp).toBeDefined();
    const id = (callOp as { id: string }).id;

    socket.simulateMessage(
      JSON.stringify({
        op: 'service_response',
        id,
        result: true,
        values: { topics: ['/a', '/b'], types: ['t1', 't2'] },
      }),
    );

    const result = await resultPromise;
    expect(result).toEqual({ topics: ['/a', '/b'], types: ['t1', 't2'] });
  });

  it('service call with result=false rejects with the error message', async () => {
    const { client, socket } = await connectedClient();

    const p = client.callService('/svc', {});
    const callOp = socket.sentJson.find(
      (m) => m.op === 'call_service' && m.service === '/svc',
    ) as { id: string };

    socket.simulateMessage(
      JSON.stringify({
        op: 'service_response',
        id: callOp.id,
        result: false,
        values: 'boom',
      }),
    );

    await expect(p).rejects.toThrow(/boom/);
  });

  it('control-priority publishes drain through the outbox on the next tick', async () => {
    const { client, socket } = await connectedClient();

    client.publish('/cmd_vel', 'geometry_msgs/msg/Twist', {
      linear: { x: 0, y: 0, z: 0 },
      angular: { x: 0, y: 0, z: 0 },
    }, { priority: 'control' });

    // Outbox is flushed via setTimeout(0); yield to let it run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const publishes = socket.sentJson.filter((m) => m.op === 'publish' && m.topic === '/cmd_vel');
    expect(publishes.length).toBe(1);
  });

  it('control-priority publishes for the same topic conflate to the latest value (regression guard for safety: joystick-release zero-Twist must drain in one WS send even when N stale-value Twists are queued)', async () => {
    const { client, socket } = await connectedClient();

    // Five stale control-priority publishes followed by a zero-Twist release.
    // Without conflation, all six drain. With conflation, only the zero does.
    for (let i = 1; i <= 5; i++) {
      client.publish('/cmd_vel', 'geometry_msgs/msg/Twist', {
        linear: { x: 0.1 * i, y: 0, z: 0 },
        angular: { x: 0, y: 0, z: 0 },
      }, { priority: 'control' });
    }
    client.publish('/cmd_vel', 'geometry_msgs/msg/Twist', {
      linear: { x: 0, y: 0, z: 0 },
      angular: { x: 0, y: 0, z: 0 },
    }, { priority: 'control' });

    await new Promise<void>((r) => setTimeout(r, 0));

    const publishes = socket.sentJson.filter(
      (m) => m.op === 'publish' && m.topic === '/cmd_vel',
    );
    expect(publishes.length).toBe(1);
    const msg = (publishes[0] as { msg: { linear: { x: number } } }).msg;
    expect(msg.linear.x).toBe(0); // the zero-Twist won
  });

  it('control-priority publishes preserve insertion order across distinct topics (intra-topic conflation; inter-topic FIFO)', async () => {
    const { client, socket } = await connectedClient();

    // /cmd_vel first appears at slot 0, /e_stop at slot 1. Subsequent /cmd_vel
    // publishes replace slot 0 (do not move to back), so drain order is
    // /cmd_vel (latest) → /e_stop.
    client.publish('/cmd_vel', 'geometry_msgs/msg/Twist', { seq: 1 }, { priority: 'control' });
    client.publish('/cmd_vel', 'geometry_msgs/msg/Twist', { seq: 2 }, { priority: 'control' });
    client.publish('/e_stop', 'std_msgs/msg/Bool', { data: true }, { priority: 'control' });
    client.publish('/cmd_vel', 'geometry_msgs/msg/Twist', { seq: 3 }, { priority: 'control' });

    await new Promise<void>((r) => setTimeout(r, 0));

    const publishes = socket.sentJson.filter((m) => m.op === 'publish') as Array<{
      op: string;
      topic: string;
      msg: Record<string, unknown>;
    }>;
    expect(publishes).toHaveLength(2);
    expect(publishes[0]!.topic).toBe('/cmd_vel');
    expect(publishes[0]!.msg).toEqual({ seq: 3 });
    expect(publishes[1]!.topic).toBe('/e_stop');
    expect(publishes[1]!.msg).toEqual({ data: true });
  });

  it('getSchemaTemplate returns null for the rosbridge transport', () => {
    const client = new RosbridgeClient();
    expect(client.getSchemaTemplate('geometry_msgs/msg/Twist')).toBeNull();
  });
});
