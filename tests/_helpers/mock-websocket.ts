/**
 * MockWebSocket — scriptable WebSocket double for unit tests.
 *
 * The protocol clients only consume the standard WebSocket surface
 * (constructor, `binaryType`, `readyState`, `protocol`, `send`, `close`,
 * `onopen` / `onmessage` / `onerror` / `onclose`), so a hand-rolled mock
 * is enough — no need for a full DOM polyfill. Tests script the server
 * side byte-for-byte with `simulateOpen`, `simulateMessage`,
 * `simulateClose`, and `simulateError`, and assert on what the client
 * sent via `sentMessages`, `sentJson`, and `sentBinary`.
 *
 * `installMockWebSocket()` swaps the global `WebSocket` for this mock and
 * returns a teardown function plus accessors for the instances created
 * during the test. Tests should call this in `beforeEach` and restore in
 * `afterEach`.
 */

import { vi } from 'vitest';

export interface MockCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

export interface MockMessageEvent {
  data: string | ArrayBuffer;
}

type SocketHandler<E> = ((this: MockWebSocket, ev: E) => unknown) | null;

export class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: MockWebSocket[] = [];

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState: number = MockWebSocket.CONNECTING;
  binaryType: 'arraybuffer' | 'blob' = 'blob';
  protocol = '';
  url: string;
  bufferedAmount = 0;
  extensions = '';

  sentMessages: Array<string | ArrayBuffer> = [];

  onopen: SocketHandler<Event> = null;
  onmessage: SocketHandler<MockMessageEvent> = null;
  onerror: SocketHandler<Event> = null;
  onclose: SocketHandler<MockCloseEvent> = null;

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    if (protocols) {
      const negotiated = Array.isArray(protocols) ? (protocols[0] ?? '') : protocols;
      this.protocol = negotiated;
    }
    MockWebSocket.instances.push(this);
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== MockWebSocket.OPEN) return;
    if (data instanceof ArrayBuffer) {
      this.sentMessages.push(data);
    } else if (typeof data === 'string') {
      this.sentMessages.push(data);
    } else {
      // ArrayBufferView path — copy into a standalone ArrayBuffer so callers
      // can compare without worrying about the view's offset/length.
      const buf = new ArrayBuffer(data.byteLength);
      new Uint8Array(buf).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      this.sentMessages.push(buf);
    }
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.call(this, { code, reason, wasClean: true });
  }

  addEventListener(): void {
    /* not used by the protocol clients */
  }

  removeEventListener(): void {
    /* not used by the protocol clients */
  }

  dispatchEvent(): boolean {
    return true;
  }

  // ── Test scripting ─────────────────────────────────────────────────────

  simulateOpen(negotiatedProtocol?: string): void {
    this.readyState = MockWebSocket.OPEN;
    if (negotiatedProtocol !== undefined) {
      this.protocol = negotiatedProtocol;
    }
    this.onopen?.call(this, new Event('open'));
  }

  simulateMessage(data: string | ArrayBuffer): void {
    this.onmessage?.call(this, { data });
  }

  simulateClose(code = 1000, reason = ''): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.call(this, { code, reason, wasClean: true });
  }

  simulateError(message?: string): void {
    // Model the strictest supported runtime, not the browser: the `ws` npm
    // package is an EventEmitter, and an 'error' event with zero listeners
    // crashes the Node process. A socket that can emit 'error' while no
    // handler is attached is therefore a latent host crash on Node-on-ws,
    // even though browser / React Native EventTarget sockets tolerate it.
    if (!this.onerror) {
      throw new Error(
        `unhandled 'error' event on MockWebSocket (no onerror listener attached): ` +
          `${message ?? '(no message)'} — on the ws package this crashes the host process`,
      );
    }
    const ev = new Event('error') as Event & { message?: string };
    if (message) ev.message = message;
    this.onerror.call(this, ev);
  }

  // ── Test introspection ─────────────────────────────────────────────────

  get sentJson(): Array<Record<string, unknown>> {
    return this.sentMessages
      .filter((m): m is string => typeof m === 'string')
      .map((s) => JSON.parse(s) as Record<string, unknown>);
  }

  get sentBinary(): ArrayBuffer[] {
    return this.sentMessages.filter((m): m is ArrayBuffer => m instanceof ArrayBuffer);
  }
}

export interface MockWebSocketHandle {
  restore: () => void;
  getInstances: () => MockWebSocket[];
  /** Convenience: the most recently created instance. Throws if none. */
  last: () => MockWebSocket;
}

/**
 * Replace the global `WebSocket` with `MockWebSocket` for the lifetime of
 * the test. Returns a handle for introspection and a `restore` function
 * that puts the original back.
 */
export function installMockWebSocket(): MockWebSocketHandle {
  const globalAny = globalThis as { WebSocket?: unknown };
  const original = globalAny.WebSocket;
  globalAny.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  MockWebSocket.instances = [];

  return {
    restore: () => {
      globalAny.WebSocket = original;
      MockWebSocket.instances = [];
    },
    getInstances: () => MockWebSocket.instances,
    last: () => {
      const arr = MockWebSocket.instances;
      const ws = arr[arr.length - 1];
      if (!ws) throw new Error('No MockWebSocket has been constructed yet');
      return ws;
    },
  };
}

/**
 * Parsed view of an outbound client → server SERVICE_CALL_REQUEST
 * frame (binary opcode 0x02). Used by tests to assert what the
 * FoxgloveClient actually put on the wire without re-deriving the
 * frame layout at every callsite.
 */
export interface ParsedServiceCallRequest {
  serviceId: number;
  callId: number;
  encoding: string;
  payload: Uint8Array;
}

/**
 * Parse a single client → server SERVICE_CALL_REQUEST frame (opcode 0x02)
 * if `buffer` looks like one; otherwise return `null`. Frame layout
 * mirrors the inbound 0x03 SERVICE_CALL_RESPONSE.
 */
export function parseFoxgloveServiceCallRequestFrame(
  buffer: ArrayBuffer,
): ParsedServiceCallRequest | null {
  if (buffer.byteLength < 13) return null;
  const view = new DataView(buffer);
  if (view.getUint8(0) !== 0x02) return null;
  const serviceId = view.getUint32(1, true);
  const callId = view.getUint32(5, true);
  const encodingLength = view.getUint32(9, true);
  if (buffer.byteLength < 13 + encodingLength) return null;
  const encoding = new TextDecoder().decode(new Uint8Array(buffer, 13, encodingLength));
  const payload = new Uint8Array(buffer, 13 + encodingLength);
  return { serviceId, callId, encoding, payload };
}

/**
 * Find the first SERVICE_CALL_REQUEST frame the FoxgloveClient sent on
 * the mock socket, or `null` if none. Replaces the pre-binary pattern of
 * scanning `socket.sentJson` for `{op: "serviceCallRequest"}`.
 */
export function findSentServiceCallRequest(
  socket: MockWebSocket,
): ParsedServiceCallRequest | null {
  for (const buf of socket.sentBinary) {
    const parsed = parseFoxgloveServiceCallRequestFrame(buf);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * Helper: build the binary frame the Foxglove WS spec sends for a
 * SERVICE_CALL_RESPONSE (server → client, opcode 0x03).
 *
 *   [uint8 op=0x03] [uint32LE serviceId] [uint32LE callId]
 *   [uint32LE encodingLength] [utf8 encoding] [bytes payload]
 *
 * This is the frame foxglove-sdk-cpp ≥ 0.18.0 / foxglove_bridge 3.2.6+
 * sends for every service-call response; tests use it to drive the
 * binary dispatch path that pairs with the JSON-op fallback.
 */
export function foxgloveServiceCallResponseFrame(
  serviceId: number,
  callId: number,
  encoding: string,
  payload: Uint8Array,
): ArrayBuffer {
  const encodingBytes = new TextEncoder().encode(encoding);
  const buffer = new ArrayBuffer(1 + 4 + 4 + 4 + encodingBytes.byteLength + payload.byteLength);
  const view = new DataView(buffer);
  view.setUint8(0, 0x03);
  view.setUint32(1, serviceId, true);
  view.setUint32(5, callId, true);
  view.setUint32(9, encodingBytes.byteLength, true);
  new Uint8Array(buffer, 13, encodingBytes.byteLength).set(encodingBytes);
  new Uint8Array(buffer, 13 + encodingBytes.byteLength).set(payload);
  return buffer;
}

/**
 * Helper: build the binary frame the Foxglove WS spec sends for a single
 * subscriber `messageData` payload.
 *
 *   [uint8 op=0x01] [uint32LE subscriptionId] [uint64LE timestampNs] [payload]
 */
export function foxgloveMessageDataFrame(
  subscriptionId: number,
  timestampNs: bigint,
  payload: Uint8Array,
): ArrayBuffer {
  const buffer = new ArrayBuffer(1 + 4 + 8 + payload.byteLength);
  const view = new DataView(buffer);
  view.setUint8(0, 0x01);
  view.setUint32(1, subscriptionId, true);
  // 64-bit little-endian write as two 32-bit halves.
  const low = Number(timestampNs & 0xffffffffn);
  const high = Number((timestampNs >> 32n) & 0xffffffffn);
  view.setUint32(5, low, true);
  view.setUint32(9, high, true);
  new Uint8Array(buffer, 13).set(payload);
  return buffer;
}

/** Run a callback with vitest's fake timers active, restoring real timers
 *  afterwards even if the callback throws. */
export async function withFakeTimers<T>(fn: () => Promise<T> | T): Promise<T> {
  vi.useFakeTimers();
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}
