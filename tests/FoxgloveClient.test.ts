import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import {
  installMockWebSocket,
  foxgloveMessageDataFrame,
  type MockWebSocketHandle,
} from './_helpers/mock-websocket';

describe('FoxgloveClient', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });

  afterEach(() => {
    ws.restore();
  });

  it('connects after serverInfo + advertise and reports topics', async () => {
    const client = new FoxgloveClient();
    const connectPromise = client.connect('ws://localhost:8765');

    const socket = ws.last();
    expect(socket.url).toBe('ws://localhost:8765');
    expect(socket.binaryType).toBe('arraybuffer');

    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(
      JSON.stringify({
        op: 'serverInfo',
        name: 'mock-foxglove-bridge',
        capabilities: [],
      }),
    );
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertise',
        channels: [
          {
            id: 1,
            topic: '/chatter',
            encoding: 'json',
            schemaName: 'std_msgs/msg/String',
            schema: '',
          },
        ],
      }),
    );

    await connectPromise;
    expect(client.isConnected).toBe(true);

    const topics = await client.getAvailableTopics();
    expect(topics).toEqual([
      {
        topic: '/chatter',
        schemaName: 'std_msgs/msg/String',
        encoding: 'json',
        source: 'robot',
      },
    ]);
  });

  it('sends a subscribe op when subscribe is called', async () => {
    const client = new FoxgloveClient();
    const connectPromise = client.connect('ws://localhost:8765');
    const socket = ws.last();

    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertise',
        channels: [
          { id: 7, topic: '/state', encoding: 'json', schemaName: 'std_msgs/msg/Int32', schema: '' },
        ],
      }),
    );
    await connectPromise;

    client.subscribe('/state', () => {});

    const subscribeOps = socket.sentJson.filter((m) => m.op === 'subscribe');
    expect(subscribeOps.length).toBe(1);
    const op = subscribeOps[0] as { op: string; subscriptions: Array<{ id: number; channelId: number }> };
    expect(op.subscriptions[0]?.channelId).toBe(7);
  });

  it('decodes a JSON-encoded binary message and dispatches to the subscriber', async () => {
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
            id: 3,
            topic: '/diag',
            encoding: 'json',
            schemaName: 'std_msgs/msg/String',
            schema: '',
          },
        ],
      }),
    );
    await connectPromise;

    const received: Array<{ topic: string; data: unknown }> = [];
    client.subscribe('/diag', (msg) => {
      received.push({ topic: msg.topic, data: msg.data });
    });

    // The first subscribe op gets subscription id 1.
    const subscriptionId = 1;
    const payload = new TextEncoder().encode(JSON.stringify({ data: 'hello' }));
    const frame = foxgloveMessageDataFrame(subscriptionId, 0n, payload);
    socket.simulateMessage(frame);

    expect(received.length).toBe(1);
    expect(received[0]?.topic).toBe('/diag');
    expect(received[0]?.data).toEqual({ data: 'hello' });
  });

  it('returns a no-op unsubscribe for an unknown topic', async () => {
    const client = new FoxgloveClient();
    const connectPromise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [] }));
    await connectPromise;

    const unsubscribe = client.subscribe('/unknown', () => {});
    expect(typeof unsubscribe).toBe('function');
    // Calling it must not throw.
    unsubscribe();

    // No `subscribe` op was sent because the topic wasn't advertised.
    expect(socket.sentJson.some((m) => m.op === 'subscribe')).toBe(false);
  });

  it('advertises before publishing on a new topic and delays the first message', async () => {
    const client = new FoxgloveClient();
    const connectPromise = client.connect('ws://localhost:8765');
    const socket = ws.last();

    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [] }));
    await connectPromise;

    client.publish('/cmd_vel', 'geometry_msgs/msg/Twist', {
      linear: { x: 0, y: 0, z: 0 },
      angular: { x: 0, y: 0, z: 0 },
    });

    const advertiseOps = socket.sentJson.filter((m) => m.op === 'advertise');
    expect(advertiseOps.length).toBe(1);

    // No binary publish yet (it's delayed via setTimeout 150ms — verified
    // by the absence of a binary frame immediately after publish).
    expect(socket.sentBinary.length).toBe(0);
  });

  it('reports breaker state `closed` for unknown topics', () => {
    const client = new FoxgloveClient();
    expect(client.getBreakerState('/never-subscribed')).toBe('closed');
    expect(client.getBreakerNextRetryAt('/never-subscribed')).toBeNull();
    expect(client.getSubscriptionStats('/never-subscribed')).toBeNull();
  });

  it('exposes getThrottleMode-derived stats once a subscription exists', async () => {
    const client = new FoxgloveClient({ getThrottleMode: () => 'performance' });
    const connectPromise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertise',
        channels: [
          { id: 1, topic: '/t', encoding: 'json', schemaName: 'std_msgs/msg/String', schema: '' },
        ],
      }),
    );
    await connectPromise;

    client.subscribe('/t', () => {});
    const stats = client.getSubscriptionStats('/t');
    expect(stats).not.toBeNull();
    // performance mode has only the no-cap bucket.
    expect(stats?.adaptiveMinIntervalMs).toBe(0);
    expect(stats?.bucketLabel).toBe('none');
  });

  it('disconnect transitions status and closes the underlying socket', async () => {
    const client = new FoxgloveClient();
    const connectPromise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [] }));
    await connectPromise;

    expect(client.isConnected).toBe(true);
    await client.disconnect();
    expect(client.isConnected).toBe(false);
    expect(socket.readyState).toBe(3); // CLOSED
  });
});
