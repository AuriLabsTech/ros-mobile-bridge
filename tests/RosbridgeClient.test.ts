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

  it('getSchemaTemplate returns null for the rosbridge transport', () => {
    const client = new RosbridgeClient();
    expect(client.getSchemaTemplate('geometry_msgs/msg/Twist')).toBeNull();
  });
});
