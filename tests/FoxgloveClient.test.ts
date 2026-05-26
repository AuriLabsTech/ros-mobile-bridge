import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parse as parseRosMsgDef } from '@foxglove/rosmsg';
import { MessageReader, MessageWriter } from '@foxglove/rosmsg2-serialization';
import { FoxgloveClient } from '../src/FoxgloveClient';
import {
  installMockWebSocket,
  foxgloveMessageDataFrame,
  type MockWebSocketHandle,
} from './_helpers/mock-websocket';

/**
 * Base64 → Uint8Array, mirroring the helper inside FoxgloveClient so tests
 * can inspect or build the byte payloads the wire ops carry.
 */
function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

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

// ─── Service calls (CDR encoding, failure-op handling) ─────────────────────
//
// foxglove_bridge >= 3.2.6 (foxglove-sdk-cpp v0.18.0) rejects JSON-encoded
// service-call requests even when the server advertises supportedEncodings
// of ["cdr", "json"]; that capability applies only to topic messages. These
// tests pin the CDR-encoding fix and the serviceCallFailure dispatch that
// turns bridge rejections into immediate promise rejections instead of
// 30 s timeout hangs.

describe('FoxgloveClient — service calls', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });

  afterEach(() => {
    ws.restore();
  });

  // Shape mirrors ListParameters_Request: prefixes is a string[], depth a
  // uint64. Small enough to inspect on the wire, real enough to exercise
  // CDR encapsulation + alignment.
  const REQUEST_SCHEMA = 'string[] prefixes\nuint64 depth\n';
  const RESPONSE_SCHEMA = 'string[] names\n';

  async function connectedWithListParamsService(): Promise<{
    client: FoxgloveClient;
    socket: ReturnType<MockWebSocketHandle['last']>;
  }> {
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
          {
            id: 9,
            name: '/n/list_parameters',
            type: 'rcl_interfaces/srv/ListParameters',
            requestSchema: REQUEST_SCHEMA,
            requestSchemaEncoding: 'ros2msg',
            responseSchema: RESPONSE_SCHEMA,
            responseSchemaEncoding: 'ros2msg',
          },
        ],
      }),
    );
    await connectPromise;
    return { client, socket };
  }

  it('encodes service requests as CDR (not JSON) and round-trips through MessageReader', async () => {
    const { client, socket } = await connectedWithListParamsService();

    const resultPromise = client.callService('/n/list_parameters', { prefixes: [], depth: 0 });
    // Surface any rejection while we inspect the wire side.
    resultPromise.catch(() => {});

    const callOp = socket.sentJson.find((m) => m.op === 'serviceCallRequest') as
      | { op: string; encoding: string; callId: number; data: string }
      | undefined;
    expect(callOp).toBeDefined();
    expect(callOp!.encoding).toBe('cdr');

    // The data is CDR-encoded bytes (base64-wrapped). Decoding with the same
    // schema must round-trip back to the request shape — i.e. the library
    // is using a real CDR writer, not just labeling JSON as "cdr".
    const requestDefs = parseRosMsgDef(REQUEST_SCHEMA, { ros2: true });
    const requestReader = new MessageReader(requestDefs);
    const decoded = requestReader.readMessage(b64ToBytes(callOp!.data)) as {
      prefixes: string[];
      depth: bigint | number;
    };
    expect(decoded.prefixes).toEqual([]);
    expect(Number(decoded.depth)).toBe(0);
  });

  it('serviceCallFailure rejects the in-flight call with the bridge message', async () => {
    const { client, socket } = await connectedWithListParamsService();

    const resultPromise = client.callService('/n/list_parameters', { prefixes: [], depth: 0 });
    const callOp = socket.sentJson.find((m) => m.op === 'serviceCallRequest') as {
      callId: number;
    };

    socket.simulateMessage(
      JSON.stringify({
        op: 'serviceCallFailure',
        callId: callOp.callId,
        message: 'Unsupported encoding',
      }),
    );

    await expect(resultPromise).rejects.toThrow(/Unsupported encoding/);
  });

  it('decodes a CDR-encoded serviceCallResponse via the response schema', async () => {
    const { client, socket } = await connectedWithListParamsService();

    const resultPromise = client.callService('/n/list_parameters', { prefixes: [], depth: 0 });
    const callOp = socket.sentJson.find((m) => m.op === 'serviceCallRequest') as {
      callId: number;
    };

    // Build a CDR-encoded response with the same schema the client cached
    // off the advertiseServices op.
    const responseDefs = parseRosMsgDef(RESPONSE_SCHEMA, { ros2: true });
    const writer = new MessageWriter(responseDefs);
    const responseBytes = writer.writeMessage({ names: ['/a', '/b'] });

    socket.simulateMessage(
      JSON.stringify({
        op: 'serviceCallResponse',
        serviceId: 9,
        callId: callOp.callId,
        encoding: 'cdr',
        data: bytesToB64(responseBytes),
      }),
    );

    const result = (await resultPromise) as { names: string[] };
    expect(result.names).toEqual(['/a', '/b']);
  });

  it('rejects when the bridge advertised the service without a request schema', async () => {
    const client = new FoxgloveClient();
    const connectPromise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [] }));
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertiseServices',
        services: [{ id: 1, name: '/n/schemaless', type: 'std_srvs/srv/Trigger' }],
      }),
    );
    await connectPromise;

    await expect(client.callService('/n/schemaless', {})).rejects.toThrow(/no request schema/);
  });
});
