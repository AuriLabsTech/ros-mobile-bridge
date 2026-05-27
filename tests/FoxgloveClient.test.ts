import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parse as parseRosMsgDef } from '@foxglove/rosmsg';
import { MessageReader, MessageWriter } from '@foxglove/rosmsg2-serialization';
import { FoxgloveClient } from '../src/FoxgloveClient';
import {
  installMockWebSocket,
  foxgloveMessageDataFrame,
  foxgloveServiceCallResponseFrame,
  findSentServiceCallRequest,
  type MockWebSocketHandle,
} from './_helpers/mock-websocket';

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

  it('encodes service requests as a binary 0x02 SERVICE_CALL_REQUEST frame (CDR payload)', async () => {
    const { client, socket } = await connectedWithListParamsService();

    const resultPromise = client.callService('/n/list_parameters', { prefixes: [], depth: 0 });
    // Surface any rejection while we inspect the wire side.
    resultPromise.catch(() => {});

    // Per Foxglove WS v1 the request must go as binary opcode 0x02; the
    // older JSON op `serviceCallRequest` is not in the spec and is
    // rejected by current bridges.
    expect(socket.sentJson.some((m) => m.op === 'serviceCallRequest')).toBe(false);
    const callOp = findSentServiceCallRequest(socket);
    expect(callOp).not.toBeNull();
    expect(callOp!.encoding).toBe('cdr');
    expect(callOp!.serviceId).toBe(9);

    // The payload is CDR-encoded bytes (raw, not base64). Decoding with the
    // same schema must round-trip back to the request shape — i.e. the
    // library is using a real CDR writer, not just labeling JSON as "cdr".
    const requestDefs = parseRosMsgDef(REQUEST_SCHEMA, { ros2: true });
    const requestReader = new MessageReader(requestDefs);
    const decoded = requestReader.readMessage(callOp!.payload) as {
      prefixes: string[];
      depth: bigint | number;
    };
    expect(decoded.prefixes).toEqual([]);
    expect(Number(decoded.depth)).toBe(0);
  });

  it('serviceCallFailure rejects the in-flight call with the bridge message', async () => {
    const { client, socket } = await connectedWithListParamsService();

    const resultPromise = client.callService('/n/list_parameters', { prefixes: [], depth: 0 });
    const callOp = findSentServiceCallRequest(socket)!;

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
    const callOp = findSentServiceCallRequest(socket)!;

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

  // foxglove_bridge 3.2.6+ commonly advertises services with the type name
  // but without inline request-schema text (services it discovered via
  // ROS 2 graph introspection rather than from explicit .srv files).
  // Empty requests fall back to a CDR encapsulation header only and the
  // bridge default-constructs the request server-side; non-empty requests
  // genuinely can't be encoded without field layout.

  async function connectedWithSchemalessService(): Promise<{
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
        services: [{ id: 11, name: '/n/schemaless', type: 'std_srvs/srv/Trigger' }],
      }),
    );
    await connectPromise;
    return { client, socket };
  }

  it('schemaless service + empty request: sends only the CDR encapsulation header', async () => {
    const { client, socket } = await connectedWithSchemalessService();

    const resultPromise = client.callService('/n/schemaless', {});
    resultPromise.catch(() => {}); // we only inspect the wire side

    const callOp = findSentServiceCallRequest(socket);
    expect(callOp).not.toBeNull();
    expect(callOp!.encoding).toBe('cdr');

    // Payload must be exactly the 4-byte CDR_LE encapsulation header so the
    // bridge default-constructs the request from the known service type.
    expect(Array.from(callOp!.payload)).toEqual([0x00, 0x01, 0x00, 0x00]);
  });

  it('schemaless service + null/undefined treated as empty', async () => {
    const { client, socket } = await connectedWithSchemalessService();

    // Cast through unknown so the test exercises the runtime tolerance even
    // though the public signature requires Record<string, unknown>. Callers
    // may pass null/undefined defensively.
    const resultPromise = client.callService(
      '/n/schemaless',
      null as unknown as Record<string, unknown>,
    );
    resultPromise.catch(() => {});

    const callOp = findSentServiceCallRequest(socket)!;
    expect(Array.from(callOp.payload)).toEqual([0x00, 0x01, 0x00, 0x00]);
  });

  it('schemaless service + non-empty request: rejects with a clear, actionable error', async () => {
    const { client } = await connectedWithSchemalessService();
    await expect(
      client.callService('/n/schemaless', { someField: 1 }),
    ).rejects.toThrow(/has no request schema advertised.*non-empty/);
  });

  // foxglove-sdk-cpp ≥ 0.18.0 / foxglove_bridge 3.2.6+ deliver service-call
  // responses as binary opcode-0x03 frames by default. Before the binary
  // dispatch was wired into handleBinaryMessage these frames were dropped at
  // the opcode guard, pending callIds never resolved, and every callService
  // timed out at 30 s. These tests pin the binary path end-to-end.

  it('binary 0x03 SERVICE_CALL_RESPONSE (CDR) resolves the in-flight call', async () => {
    const { client, socket } = await connectedWithListParamsService();

    const resultPromise = client.callService('/n/list_parameters', { prefixes: [], depth: 0 });
    const callOp = findSentServiceCallRequest(socket)!;

    const responseDefs = parseRosMsgDef(RESPONSE_SCHEMA, { ros2: true });
    const responseBytes = new MessageWriter(responseDefs).writeMessage({ names: ['/x', '/y'] });
    socket.simulateMessage(
      foxgloveServiceCallResponseFrame(9, callOp.callId, 'cdr', responseBytes),
    );

    const result = (await resultPromise) as { names: string[] };
    expect(result.names).toEqual(['/x', '/y']);
  });

  it('binary 0x03 SERVICE_CALL_RESPONSE (JSON) resolves via back-compat decode', async () => {
    const { client, socket } = await connectedWithListParamsService();

    const resultPromise = client.callService('/n/list_parameters', { prefixes: [], depth: 0 });
    const callOp = findSentServiceCallRequest(socket)!;

    const payload = new TextEncoder().encode(JSON.stringify({ names: ['/json-a', '/json-b'] }));
    socket.simulateMessage(
      foxgloveServiceCallResponseFrame(9, callOp.callId, 'json', payload),
    );

    const result = (await resultPromise) as { names: string[] };
    expect(result.names).toEqual(['/json-a', '/json-b']);
  });

  it('binary 0x03 with an unknown serviceId resolves to rawBytes (no schema lookup possible)', async () => {
    const { client, socket } = await connectedWithListParamsService();

    const resultPromise = client.callService('/n/list_parameters', { prefixes: [], depth: 0 });
    const callOp = findSentServiceCallRequest(socket)!;

    // Service id 999 is not in the client's availableServices map. The
    // dispatcher surfaces the raw bytes so callers can still inspect.
    const stray = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    socket.simulateMessage(
      foxgloveServiceCallResponseFrame(999, callOp.callId, 'cdr', stray),
    );

    const result = (await resultPromise) as { rawBytes: Uint8Array };
    expect(Array.from(result.rawBytes)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  // Spec compliance: SERVICE_CALL_FAILURE is JSON-op only. But the bridge
  // also emits an undirected level-2 status when it rejects a malformed
  // serviceCallRequest — before the heuristic below the in-flight callId
  // hung until its 30 s timeout. This test pins the fast-fail.

  it('status:2 mentioning serviceCallRequest rejects all in-flight calls fast', async () => {
    const { client, socket } = await connectedWithListParamsService();

    const firstCall = client.callService('/n/list_parameters', { prefixes: [], depth: 0 });
    const secondCall = client.callService('/n/list_parameters', { prefixes: ['/a'], depth: 1 });

    socket.simulateMessage(
      JSON.stringify({
        op: 'status',
        level: 2,
        message: 'Failed to decode serviceCallRequest: unsupported encoding "json"',
      }),
    );

    await expect(firstCall).rejects.toThrow(/Bridge rejected service call.*serviceCallRequest/);
    await expect(secondCall).rejects.toThrow(/Bridge rejected service call.*serviceCallRequest/);
  });

  it('status:2 unrelated to service calls leaves pending calls alone', async () => {
    const { client, socket } = await connectedWithListParamsService();

    const resultPromise = client.callService('/n/list_parameters', { prefixes: [], depth: 0 });
    const callOp = findSentServiceCallRequest(socket)!;

    // A status message that doesn't mention serviceCallRequest must not
    // tear down unrelated in-flight calls; the heuristic is scoped.
    socket.simulateMessage(
      JSON.stringify({ op: 'status', level: 2, message: 'channel 5 lost a frame' }),
    );

    // The call should still be in flight — confirm by resolving it.
    const responseDefs = parseRosMsgDef(RESPONSE_SCHEMA, { ros2: true });
    const responseBytes = new MessageWriter(responseDefs).writeMessage({ names: ['/post-status'] });
    socket.simulateMessage(
      foxgloveServiceCallResponseFrame(9, callOp.callId, 'cdr', responseBytes),
    );
    const result = (await resultPromise) as { names: string[] };
    expect(result.names).toEqual(['/post-status']);
  });

  // RN compatibility guard: every outbound binary frame must be sent as
  // a typed array (Uint8Array), never a raw ArrayBuffer. RN's WebSocket
  // native bridge silently drops ArrayBuffer payloads above ~400 bytes —
  // confirmed via tcpdump on real Chesster traffic in Tinca vcode 1071,
  // where 16-name get_parameters requests never left the phone. The
  // browser/Node path is identical either way, so this test is the only
  // place the constraint is observable in CI.

  it('SERVICE_CALL_REQUEST is sent as Uint8Array, not raw ArrayBuffer', async () => {
    const { client, socket } = await connectedWithListParamsService();
    const sendSpy = vi.spyOn(socket, 'send');

    const resultPromise = client.callService('/n/list_parameters', { prefixes: [], depth: 0 });
    resultPromise.catch(() => {});

    const binarySends = sendSpy.mock.calls.filter(
      ([arg]) => arg instanceof ArrayBuffer || ArrayBuffer.isView(arg),
    );
    expect(binarySends.length).toBeGreaterThan(0);
    for (const [arg] of binarySends) {
      expect(arg instanceof ArrayBuffer).toBe(false);
      expect(ArrayBuffer.isView(arg)).toBe(true);
    }
  });

  it('topic publish frames are also sent as Uint8Array (publish path uses same RN-sensitive primitive)', async () => {
    // Connect, advertise a channel, then publish — exercises the
    // sendBinaryMessage path on the wire. The send call happens after a
    // microtask delay so we wait one tick before asserting.
    const client = new FoxgloveClient();
    const connectPromise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [] }));
    await connectPromise;

    const sendSpy = vi.spyOn(socket, 'send');
    client.publish('/cmd_vel', 'geometry_msgs/msg/Twist', {
      linear: { x: 0.1, y: 0, z: 0 },
      angular: { x: 0, y: 0, z: 0 },
    });
    // The control-priority outbox flushes via setTimeout(0). Wait a tick.
    await new Promise<void>((r) => setTimeout(r, 200));

    const binarySends = sendSpy.mock.calls.filter(
      ([arg]) => arg instanceof ArrayBuffer || ArrayBuffer.isView(arg),
    );
    expect(binarySends.length).toBeGreaterThan(0);
    for (const [arg] of binarySends) {
      expect(arg instanceof ArrayBuffer).toBe(false);
      expect(ArrayBuffer.isView(arg)).toBe(true);
    }
  });

  // Keep-alive: the spec has no JSON `ping` op. The previous JS-level
  // ping caused the bridge to emit status:2 every 5 s. This guard ensures
  // a long-running connection produces zero outbound JSON `ping` ops
  // regardless of how much time the simulated clock advances.

  it('no JSON ping op is sent on a long-lived connection', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'setTimeout', 'clearInterval', 'clearTimeout', 'Date'] });
    try {
      const { socket } = await connectedWithListParamsService();
      vi.advanceTimersByTime(5 * 60 * 1000); // 5 simulated minutes
      const pings = socket.sentJson.filter((m) => m.op === 'ping');
      expect(pings).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('binary frame with an unknown opcode is dropped without touching topic-data state', async () => {
    // Regression guard: the dispatcher's default branch must silently drop
    // unknown opcodes (e.g. 0x02 TIME / 0x04 FETCH_ASSET_RESPONSE) without
    // mis-routing into the messageData path. We assert by exercising both:
    // an unknown opcode arrives, then a real messageData frame still flows.
    const client = new FoxgloveClient();
    const connectPromise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertise',
        channels: [
          { id: 4, topic: '/t', encoding: 'json', schemaName: 'std_msgs/msg/String', schema: '' },
        ],
      }),
    );
    await connectPromise;

    const received: unknown[] = [];
    client.subscribe('/t', (m) => received.push(m.data));

    // Opcode 0x02 (TIME) — spec-listed, not consumed by this client.
    const noise = new ArrayBuffer(9);
    new DataView(noise).setUint8(0, 0x02);
    socket.simulateMessage(noise);
    expect(received).toEqual([]);

    // Real messageData frame still gets delivered.
    const payload = new TextEncoder().encode(JSON.stringify({ data: 'after-noise' }));
    socket.simulateMessage(foxgloveMessageDataFrame(1, 0n, payload));
    expect(received).toEqual([{ data: 'after-noise' }]);
  });
});
