// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * FoxgloveClient — Foxglove WebSocket Protocol v1 implementation.
 *
 * Implements `IProtocolClient` against raw `WebSocket` using the Foxglove WS
 * v1 spec: https://github.com/foxglove/ws-protocol/blob/main/docs/spec.md
 *
 * Key design decisions:
 *
 * - Uses the runtime's global `WebSocket` (no `@foxglove/ws-protocol` SDK),
 *   so the same compiled output runs in React Native, browsers, Node 22+
 *   natively, and Node 18-21 with a `ws` polyfill.
 * - Supports JSON and CDR (binary) encoding via `@foxglove/rosmsg2-serialization`,
 *   with ros2idl and ros2msg schemas.
 * - Exponential backoff reconnection (1 s → 2 s → 4 s → 8 s → 16 s, max 5
 *   attempts).
 * - Keep-alive ping every 5 s, reconnect if no pong in 10 s.
 * - Dead-man's switch: publishes zero Twist on unexpected disconnect when
 *   the client has been publishing on `/cmd_vel`.
 * - Control-priority outbox: gesture, E-Stop, and action-cancel publishes
 *   drain at the top of every incoming WS message handler so they ride out
 *   before the JS thread is consumed by the next parse macrotask.
 */

import { parse as parseRosMsgDef } from '@foxglove/rosmsg';
import { parseRos2idl } from '@foxglove/ros2idl-parser';
import { MessageReader } from '@foxglove/rosmsg2-serialization';
import {
  type BucketDef,
  type CircuitBreakerState,
  type ConnectionStatus,
  type IProtocolClient,
  type ProtocolClientOptions,
  type ProtocolLogger,
  type PublishOptions,
  type RosMessage,
  type ServiceInfo,
  type SubscribeOptions,
  type ThrottleMode,
  type TopicInfo,
} from './types';
import { CircuitBreaker, DEFAULT_BREAKER_CONFIG } from './CircuitBreaker';
import { getMaxLagMs, setModeGetter } from './EventLoopMonitor';
import {
  type BandwidthTracker,
  buildEffectivePresets,
  createBandwidthTracker,
  effectiveMinInterval,
  getTrackerBucketLabel,
  recordBytes,
  setTrackerToDeepest,
} from './SubscriptionBandwidth';
import { schemaToTemplate } from './schemaToTemplate';
import { jsonSchemaToTemplate } from './jsonSchemaToTemplate';

const NOOP_LOGGER: ProtocolLogger = { log() {}, warn() {}, error() {} };

// Module-level singletons. `new TextEncoder()` / `new TextDecoder()` are
// cheap but not free, and the per-message hot path constructs one per call
// in the original code. Reusing matches what Node and browsers do
// internally for encoders without options.
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

// ─── Foxglove WS v1 Protocol Types ──────────────────────────────────────────

interface FoxgloveChannel {
  id: number;
  topic: string;
  encoding: string;
  schemaName: string;
  schema: string;
  schemaEncoding?: string;
}

interface FoxgloveServerInfo {
  op: 'serverInfo';
  name: string;
  capabilities: string[];
  supportedEncodings?: string[];
  metadata?: Record<string, string>;
  sessionId?: string;
}

interface FoxgloveAdvertise {
  op: 'advertise';
  channels: FoxgloveChannel[];
}

interface FoxgloveUnadvertise {
  op: 'unadvertise';
  channelIds: number[];
}

interface FoxgloveServiceResponse {
  op: 'serviceCallResponse';
  serviceId: number;
  callId: number;
  encoding: string;
  data: string;
}

interface FoxgloveService {
  id: number;
  name: string;
  type: string;
  requestSchema?: string;
  responseSchema?: string;
}

interface FoxgloveAdvertiseServices {
  op: 'advertiseServices';
  services: FoxgloveService[];
}

type FoxgloveServerMessage =
  | FoxgloveServerInfo
  | FoxgloveAdvertise
  | FoxgloveUnadvertise
  | FoxgloveAdvertiseServices
  | FoxgloveServiceResponse
  | { op: string; [key: string]: unknown };

// ─── Constants ───────────────────────────────────────────────────────────────

// Subprotocol negotiation: send both, server picks the one it supports.
// - foxglove.sdk.v1:       Foxglove Bridge 3.x+ (ROS 2 Jazzy+), adds CDR services + schemas op
// - foxglove.websocket.v1: Foxglove Bridge 1.x-2.x (Humble/Iron), standard ws-protocol
// Wire format (opcodes, binary layout, JSON ops) is identical for subscribe/publish/ping/pong.
const SUBPROTOCOLS = ['foxglove.sdk.v1', 'foxglove.websocket.v1'];
const PING_INTERVAL_MS = 5_000;
const PONG_TIMEOUT_MS = 10_000;
const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RECONNECT_DELAY_MS = 1_000;
const CONNECTION_TIMEOUT_MS = 10_000;

const ZERO_TWIST = {
  linear: { x: 0, y: 0, z: 0 },
  angular: { x: 0, y: 0, z: 0 },
};

const CMD_VEL_SCHEMA = 'geometry_msgs/msg/Twist';

// Binary op-codes (Foxglove WS v1). Binary frames start with a single byte
// opcode; 0x01 = messageData is used in both directions.
enum BinaryOpcode {
  MESSAGE_DATA = 0x01,
}

// ─── Implementation ──────────────────────────────────────────────────────────

export class FoxgloveClient implements IProtocolClient {
  private readonly onLatency: ((rttMs: number) => void) | undefined;
  private readonly logger: ProtocolLogger;
  private readonly getThrottleMode: () => ThrottleMode;
  private readonly presets: Record<ThrottleMode, BucketDef[]>;

  private ws: WebSocket | null = null;
  private url = '';
  private status: ConnectionStatus = 'disconnected';
  private statusListeners = new Set<(s: ConnectionStatus) => void>();
  private logListeners = new Set<(log: string) => void>();
  private topicsListeners = new Set<(topics: TopicInfo[]) => void>();
  private servicesListeners = new Set<(services: ServiceInfo[]) => void>();

  constructor(options?: ProtocolClientOptions) {
    this.onLatency = options?.onLatency;
    this.logger = options?.logger ?? NOOP_LOGGER;
    this.getThrottleMode = options?.getThrottleMode ?? (() => 'auto');
    this.presets = buildEffectivePresets(options?.presetOverrides, this.logger);
    // Wire the EventLoopMonitor's mode getter from our own throttle-mode
    // option so consumers never need to know that setter exists.
    setModeGetter(this.getThrottleMode);
  }

  // Channel state
  private channels = new Map<number, FoxgloveChannel>();
  private topicToChannelId = new Map<string, number>();

  // Per-subscription state. Each callback keeps its own throttle clock so
  // multi-subscriber topics with different `maxFrequency` settings stay
  // isolated. Bandwidth tracking is per-subscription and feeds the adaptive
  // throttle layered on top of per-callback `maxFrequency`.
  private nextSubscriptionId = 1;
  private subscriptions = new Map<
    number,
    {
      topic: string;
      channelId: number;
      callbacks: Map<
        (msg: RosMessage) => void,
        {
          userMinIntervalMs: number | undefined;
          disableAdaptive: boolean;
          lastDeliveredAt: number;
        }
      >;
      bandwidth: BandwidthTracker;
      breaker: CircuitBreaker;
      isPaused: boolean;
    }
  >();
  private topicToSubscriptionId = new Map<string, number>();
  private breakerListeners = new Map<string, Set<(state: CircuitBreakerState) => void>>();

  // CDR message readers — keyed by subscriptionId, created from channel schema.
  private messageReaders = new Map<number, MessageReader>();

  // Publish state — maps topic → client-advertised channelId.
  private nextClientChannelId = 1;
  private advertisedTopics = new Map<string, number>();
  private hasPublishedTwist = false;

  // Control-priority outbox. Twist / E-Stop publishes route through here
  // and get flushed at the top of every incoming WS message handler.
  private static readonly CONTROL_FLUSH_BATCH = 3;
  private controlOutbox: Array<{ channelId: number; data: Record<string, unknown> }> = [];
  private controlFlushScheduled = false;

  // Service calls
  private nextServiceCallId = 1;
  private pendingServiceCalls = new Map<
    number,
    {
      resolve: (v: Record<string, unknown>) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private availableServices = new Map<string, FoxgloveService>();

  // Keep-alive
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPingSentTime = 0;

  // Reconnection
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalDisconnect = false;

  // Connection handshake
  private connectResolve: (() => void) | null = null;
  private connectReject: ((e: Error) => void) | null = null;
  private serverInfoReceived = false;

  get isConnected(): boolean {
    return this.status === 'connected';
  }

  get reconnectAttempt(): number {
    return this.reconnectAttempts;
  }

  get maxReconnectAttempts(): number {
    return MAX_RECONNECT_ATTEMPTS;
  }

  async connect(url: string): Promise<void> {
    if (this.status === 'connecting' || this.status === 'connected') {
      return;
    }

    this.url = url.trim();
    this.intentionalDisconnect = false;
    this.reconnectAttempts = 0;

    this.log(`Opening WebSocket to ${this.url}...`);
    return this.performConnect();
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;

    this.safePublishZeroTwist();

    // Drain pending control-priority publishes BEFORE closing the socket.
    // Without this, an Action Client cancel-goal queued via the outbox +
    // setTimeout(0) gets dropped when cleanup() closes the websocket — the
    // macrotask scheduler hadn't fired yet, so the E-Stop's cancel never
    // reaches the robot.
    this.flushControlOutbox();

    this.cleanup();
    this.setStatus('disconnected');
  }

  async getAvailableTopics(): Promise<TopicInfo[]> {
    const appTopics = new Set(this.advertisedTopics.keys());

    return Array.from(this.channels.values()).map((ch) => ({
      topic: ch.topic,
      schemaName: ch.schemaName,
      encoding: ch.encoding,
      source: appTopics.has(ch.topic) ? ('app' as const) : ('robot' as const),
    }));
  }

  getSchemaTemplate(schemaName: string): Record<string, unknown> | null {
    // Find a channel advertising this schema, then pick the parser that
    // matches the schema format. Foxglove WS lets a server advertise
    // channels with ros2idl (reference foxglove_bridge), ros2msg (legacy),
    // or JSON Schema (some bridges). Try the declared `schemaEncoding`
    // first, then heuristic-detect; the older foxglove-websocket Python
    // library doesn't set the field.
    for (const ch of this.channels.values()) {
      if (ch.schemaName !== schemaName || !ch.schema) continue;
      const encoding = (ch.schemaEncoding ?? '').toLowerCase();
      const schemaStr = ch.schema;
      const looksLikeJsonSchema = schemaStr.trimStart().startsWith('{');

      const tryRos2idl = (): Record<string, unknown> | null => {
        try {
          return schemaToTemplate(parseRos2idl(schemaStr));
        } catch {
          return null;
        }
      };
      const tryRos2msg = (): Record<string, unknown> | null => {
        try {
          return schemaToTemplate(parseRosMsgDef(schemaStr, { ros2: true }));
        } catch {
          return null;
        }
      };
      const tryJsonSchema = (): Record<string, unknown> | null => {
        try {
          const parsed = JSON.parse(schemaStr);
          const t = jsonSchemaToTemplate(parsed);
          return t && typeof t === 'object' && !Array.isArray(t)
            ? (t as Record<string, unknown>)
            : null;
        } catch {
          return null;
        }
      };

      let order: Array<() => Record<string, unknown> | null>;
      if (encoding === 'ros2idl') {
        order = [tryRos2idl, tryJsonSchema, tryRos2msg];
      } else if (encoding === 'jsonschema' || looksLikeJsonSchema) {
        order = [tryJsonSchema, tryRos2idl, tryRos2msg];
      } else {
        order = [tryRos2msg, tryRos2idl, tryJsonSchema];
      }

      for (const attempt of order) {
        const t = attempt();
        if (t) return t;
      }
      this.log(
        `Schema template parse failed for "${schemaName}" — all parsers rejected the schema.`,
      );
      break;
    }
    return null;
  }

  subscribe(
    topic: string,
    onMessage: (msg: RosMessage) => void,
    options?: SubscribeOptions,
  ): () => void {
    const userMinIntervalMs =
      options?.maxFrequency && options.maxFrequency > 0
        ? 1000 / options.maxFrequency
        : undefined;
    const disableAdaptive = options?.disableAdaptive ?? false;

    const existingSubId = this.topicToSubscriptionId.get(topic);
    if (existingSubId !== undefined) {
      const sub = this.subscriptions.get(existingSubId);
      if (sub) {
        sub.callbacks.set(onMessage, {
          userMinIntervalMs,
          disableAdaptive,
          lastDeliveredAt: 0,
        });
        return () => {
          sub.callbacks.delete(onMessage);
          if (sub.callbacks.size === 0) {
            this.unsubscribeTopic(topic, existingSubId);
          }
        };
      }
    }

    const channelId = this.topicToChannelId.get(topic);
    if (channelId === undefined) {
      this.logger.warn(
        `[FoxgloveClient] Topic "${topic}" not available. Available: ${Array.from(this.topicToChannelId.keys()).join(', ')}`,
      );
      return () => {};
    }

    const subscriptionId = this.nextSubscriptionId++;
    const callbacks = new Map<
      (msg: RosMessage) => void,
      {
        userMinIntervalMs: number | undefined;
        disableAdaptive: boolean;
        lastDeliveredAt: number;
      }
    >();
    callbacks.set(onMessage, {
      userMinIntervalMs,
      disableAdaptive,
      lastDeliveredAt: 0,
    });

    const breaker = new CircuitBreaker({
      ...DEFAULT_BREAKER_CONFIG,
      onStateChange: (newState) => {
        const sub = this.subscriptions.get(subscriptionId);
        if (!sub) return;
        sub.isPaused = newState === 'tripped_auto' || newState === 'tripped_manual';
        if (newState === 'tripped_auto') {
          if (this.ws && this.status === 'connected') {
            this.sendJson({ op: 'unsubscribe', subscriptionIds: [subscriptionId] });
          }
          this.log(`[breaker] ${topic} → tripped_auto (sustained overload)`);
        } else if (newState === 'half_open') {
          setTrackerToDeepest(sub.bandwidth, this.getThrottleMode());
          if (this.ws && this.status === 'connected') {
            this.sendJson({
              op: 'subscribe',
              subscriptions: [{ id: subscriptionId, channelId: sub.channelId }],
            });
          }
          this.log(`[breaker] ${topic} → half_open (re-subscribed)`);
        } else if (newState === 'closed') {
          this.log(`[breaker] ${topic} → closed (recovered)`);
        } else if (newState === 'tripped_manual') {
          this.log(`[breaker] ${topic} → tripped_manual (user disabled auto-retry)`);
        }
        const listeners = this.breakerListeners.get(topic);
        if (listeners) {
          for (const cb of listeners) {
            try {
              cb(newState);
            } catch (err) {
              this.logger.error('[FoxgloveClient] Breaker listener error:', err);
            }
          }
        }
      },
    });

    this.subscriptions.set(subscriptionId, {
      topic,
      channelId,
      callbacks,
      bandwidth: createBandwidthTracker(this.getThrottleMode(), this.presets),
      breaker,
      isPaused: false,
    });
    this.topicToSubscriptionId.set(topic, subscriptionId);

    const channel = this.channels.get(channelId);
    if (channel && channel.schema && channel.encoding !== 'json') {
      const schemaEncoding = channel.schemaEncoding ?? '';
      this.log(
        `Creating CDR reader for "${topic}" (encoding=${channel.encoding}, schemaEncoding=${schemaEncoding})`,
      );
      try {
        let msgDefs;
        if (schemaEncoding === 'ros2idl') {
          msgDefs = parseRos2idl(channel.schema);
        } else {
          msgDefs = parseRosMsgDef(channel.schema, { ros2: true });
        }
        this.messageReaders.set(subscriptionId, new MessageReader(msgDefs));
        this.log(`  CDR reader created successfully for "${topic}"`);
      } catch (err) {
        this.log(`  CDR reader FAILED for "${topic}": ${String(err)}`);
        this.log(`  Schema preview: ${channel.schema.substring(0, 200)}`);
      }
    }

    this.sendJson({
      op: 'subscribe',
      subscriptions: [{ id: subscriptionId, channelId }],
    });

    return () => {
      callbacks.delete(onMessage);
      if (callbacks.size === 0) {
        this.unsubscribeTopic(topic, subscriptionId);
      }
    };
  }

  publish(
    topic: string,
    schemaName: string,
    data: Record<string, unknown>,
    options?: PublishOptions,
  ): void {
    if (!this.ws || this.status !== 'connected') {
      return;
    }

    if (schemaName === CMD_VEL_SCHEMA) {
      this.hasPublishedTwist = true;
    }

    let clientChannelId = this.advertisedTopics.get(topic);
    if (clientChannelId === undefined) {
      clientChannelId = this.nextClientChannelId++;
      this.advertisedTopics.set(topic, clientChannelId);

      this.sendJson({
        op: 'advertise',
        channels: [
          {
            id: clientChannelId,
            topic,
            encoding: 'json',
            schemaName,
          },
        ],
      });

      // Delay first message so the bridge has time to create the ROS
      // publisher. Without this, the message arrives before the publisher
      // is ready and gets dropped.
      const chId = clientChannelId;
      setTimeout(() => {
        this.sendBinaryMessage(chId, data);
      }, 150);
      return;
    }

    if (options?.priority === 'control') {
      this.controlOutbox.push({ channelId: clientChannelId, data });
      this.scheduleControlFlush();
      return;
    }

    this.sendBinaryMessage(clientChannelId, data);
  }

  private scheduleControlFlush(): void {
    if (this.controlFlushScheduled) return;
    this.controlFlushScheduled = true;
    setTimeout(() => {
      this.controlFlushScheduled = false;
      this.flushControlOutbox();
    }, 0);
  }

  private flushControlOutbox(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.controlOutbox.length = 0;
      return;
    }
    let drained = 0;
    while (
      this.controlOutbox.length > 0 &&
      drained < FoxgloveClient.CONTROL_FLUSH_BATCH
    ) {
      const entry = this.controlOutbox.shift();
      if (!entry) break;
      this.sendBinaryMessage(entry.channelId, entry.data);
      drained++;
    }
    if (this.controlOutbox.length > 0) {
      this.scheduleControlFlush();
    }
  }

  ensureAdvertised(topic: string, schemaName: string): void {
    if (!this.ws || this.status !== 'connected') return;
    if (this.advertisedTopics.has(topic)) return;

    const clientChannelId = this.nextClientChannelId++;
    this.advertisedTopics.set(topic, clientChannelId);

    this.sendJson({
      op: 'advertise',
      channels: [
        {
          id: clientChannelId,
          topic,
          encoding: 'json',
          schemaName,
        },
      ],
    });
  }

  unadvertise(topic: string): void {
    const clientChannelId = this.advertisedTopics.get(topic);
    if (clientChannelId === undefined) return;

    this.advertisedTopics.delete(topic);

    if (this.ws && this.status === 'connected') {
      this.sendJson({
        op: 'unadvertise',
        channelIds: [clientChannelId],
      });
    }
  }

  private sendBinaryMessage(channelId: number, data: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const jsonPayload = JSON.stringify(data);
    const payloadBytes = TEXT_ENCODER.encode(jsonPayload);

    const buffer = new ArrayBuffer(1 + 4 + payloadBytes.byteLength);
    const view = new DataView(buffer);
    view.setUint8(0, BinaryOpcode.MESSAGE_DATA);
    view.setUint32(1, channelId, true);
    new Uint8Array(buffer, 5).set(payloadBytes);

    this.ws.send(buffer);
  }

  async callService(
    service: string,
    request: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.ws || this.status !== 'connected') {
      throw new Error('Not connected');
    }

    const serviceInfo = this.availableServices.get(service);
    if (!serviceInfo) {
      throw new Error(`Service "${service}" not available`);
    }

    const callId = this.nextServiceCallId++;

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingServiceCalls.delete(callId);
        reject(new Error(`Service call "${service}" timed out after 30s`));
      }, 30_000);

      this.pendingServiceCalls.set(callId, { resolve, reject, timer });

      const jsonData = JSON.stringify(request);
      const encoded = btoa(jsonData);

      this.sendJson({
        op: 'serviceCallRequest',
        serviceId: serviceInfo.id,
        callId,
        encoding: 'json',
        data: encoded,
      });
    });
  }

  onStatusChange(cb: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(cb);
    cb(this.status);
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  onTopicsChange(cb: (topics: TopicInfo[]) => void): () => void {
    this.topicsListeners.add(cb);
    return () => {
      this.topicsListeners.delete(cb);
    };
  }

  getAvailableServices(): ServiceInfo[] {
    return Array.from(this.availableServices.values()).map((s) => ({
      name: s.name,
      type: s.type,
    }));
  }

  onServicesChange(cb: (services: ServiceInfo[]) => void): () => void {
    this.servicesListeners.add(cb);
    cb(this.getAvailableServices());
    return () => {
      this.servicesListeners.delete(cb);
    };
  }

  onLog(cb: (log: string) => void): () => void {
    this.logListeners.add(cb);
    return () => {
      this.logListeners.delete(cb);
    };
  }

  publishZeroTwist(): void {
    this.safePublishZeroTwist();
  }

  // ── Private: connection lifecycle ────────────────────────────────────────

  private performConnect(): Promise<void> {
    this.cleanup();
    this.setStatus('connecting');

    return new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;

      try {
        this.ws = new WebSocket(this.url, SUBPROTOCOLS);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
          const negotiated = this.ws?.protocol ?? 'unknown';
          this.log(
            `WebSocket handshake successful (protocol: ${negotiated}), waiting for serverInfo...`,
          );
          this.clearConnectionTimeout();
        };

        this.ws.onmessage = (event: MessageEvent) => {
          this.handleWsMessage(event);
        };

        this.ws.onerror = (event: Event) => {
          const detail =
            (event as Event & { message?: string }).message ??
            'Handshake failed or connection rejected by server';
          this.log(`WebSocket error: ${detail}`);
          this.logger.error('[FoxgloveClient] WebSocket error:', event);
          this.handleConnectionError(new Error(`WebSocket error: ${detail}`));
        };

        this.ws.onclose = (event: CloseEvent) => {
          this.log(`WebSocket closed: code=${event.code}, reason=${event.reason || 'none'}`);
          this.handleClose(event.code ?? 1000, event.reason ?? '');
        };

        this.connectionTimeoutTimer = setTimeout(() => {
          this.handleConnectionError(
            new Error(`Connection timeout after ${CONNECTION_TIMEOUT_MS}ms`),
          );
        }, CONNECTION_TIMEOUT_MS);
      } catch (err) {
        this.handleConnectionError(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // ── Private: WebSocket message handling ──────────────────────────────────

  private handleWsMessage(event: MessageEvent): void {
    // Drain the control outbox BEFORE we spend the JS thread parsing this
    // incoming message. Under heavy load, control publishes that landed in
    // the outbox while the previous parse held the thread now ride out
    // before this one starts. Cheap when outbox is empty.
    if (this.controlOutbox.length > 0) {
      this.flushControlOutbox();
    }

    if (typeof event.data === 'string') {
      this.handleJsonMessage(event.data);
    } else if (event.data instanceof ArrayBuffer) {
      this.handleBinaryMessage(event.data);
    }
  }

  private handleJsonMessage(raw: string): void {
    let msg: FoxgloveServerMessage;
    try {
      msg = JSON.parse(raw) as FoxgloveServerMessage;
    } catch {
      this.logger.warn('[FoxgloveClient] Failed to parse JSON message');
      return;
    }

    switch (msg.op) {
      case 'serverInfo':
        this.handleServerInfo(msg as FoxgloveServerInfo);
        break;
      case 'advertise':
        this.handleAdvertise(msg as FoxgloveAdvertise);
        break;
      case 'unadvertise':
        this.handleUnadvertise(msg as FoxgloveUnadvertise);
        break;
      case 'advertiseServices':
        this.handleAdvertiseServices(msg as FoxgloveAdvertiseServices);
        break;
      case 'serviceCallResponse':
        this.handleServiceCallResponse(msg as FoxgloveServiceResponse);
        break;
      case 'pong':
        this.handlePong();
        break;
      case 'schemas':
        // sdk.v1 sends schemas metadata; not currently needed.
        break;
      case 'status':
        if ((msg as { level?: number }).level === 2) {
          this.logger.error(
            '[FoxgloveClient] Server error:',
            (msg as { message?: string }).message,
          );
        }
        break;
    }
  }

  private handleBinaryMessage(buffer: ArrayBuffer): void {
    if (buffer.byteLength < 5) return;

    const view = new DataView(buffer);
    const opcode = view.getUint8(0);

    if (opcode !== BinaryOpcode.MESSAGE_DATA) return;

    // messageData binary format (server → client):
    // [uint8 op=0x01] [uint32LE subscriptionId] [uint64LE timestamp] [payload]
    const subscriptionId = view.getUint32(1, true);

    const timestampLow = view.getUint32(5, true);
    const timestampHigh = view.getUint32(9, true);
    const timestampNs = timestampHigh * 0x100000000 + timestampLow;
    const sec = Math.floor(timestampNs / 1_000_000_000);
    const nsec = timestampNs % 1_000_000_000;

    const payloadOffset = 13;
    const payload = buffer.slice(payloadOffset);

    const sub = this.subscriptions.get(subscriptionId);
    if (!sub) return;
    if (sub.isPaused) return;

    const now = Date.now();
    const mode = this.getThrottleMode();
    recordBytes(sub.bandwidth, now, buffer.byteLength, mode);
    sub.breaker.recordObservation(now, sub.bandwidth.bytesPerSec, getMaxLagMs());

    // Single pass over callbacks: collect those whose throttle window allows
    // delivery. Avoids recomputing `effectiveMinInterval` in a second pass.
    const deliverTo: Array<[(msg: RosMessage) => void, { lastDeliveredAt: number }]> = [];
    for (const [cb, entry] of sub.callbacks) {
      const interval = effectiveMinInterval(
        entry.userMinIntervalMs,
        entry.disableAdaptive,
        sub.bandwidth,
      );
      if (interval <= 0 || now - entry.lastDeliveredAt >= interval) {
        deliverTo.push([cb, entry]);
      }
    }
    if (deliverTo.length === 0) return;

    const channelInfo = this.channels.get(sub.channelId);
    const schemaName = channelInfo?.schemaName ?? '';
    const encoding = channelInfo?.encoding ?? 'json';

    let data: Record<string, unknown> | Uint8Array;

    if (encoding === 'json') {
      try {
        const text = TEXT_DECODER.decode(payload);
        data = JSON.parse(text) as Record<string, unknown>;
      } catch {
        data = new Uint8Array(payload);
      }
    } else {
      const reader = this.messageReaders.get(subscriptionId);
      if (reader) {
        try {
          data = reader.readMessage(new Uint8Array(payload)) as Record<string, unknown>;
        } catch {
          data = new Uint8Array(payload);
        }
      } else {
        data = new Uint8Array(payload);
      }
    }

    const rosMsg: RosMessage = {
      topic: sub.topic,
      schemaName,
      encoding: encoding === 'json' ? 'json' : 'cdr',
      data,
      receiveTime: { sec, nsec },
      byteSize: payload.byteLength,
    };

    for (const [cb, entry] of deliverTo) {
      entry.lastDeliveredAt = now;
      try {
        cb(rosMsg);
      } catch (err) {
        this.logger.error('[FoxgloveClient] Subscriber callback error:', err);
      }
    }
  }

  private handleServerInfo(info: FoxgloveServerInfo): void {
    this.log(`Received serverInfo: ${info.name} (sessionId: ${info.sessionId ?? 'none'})`);
    this.serverInfoReceived = true;
  }

  private handleAdvertise(msg: FoxgloveAdvertise): void {
    for (const ch of msg.channels) {
      this.channels.set(ch.id, ch);
      this.topicToChannelId.set(ch.topic, ch.id);
      this.log(
        `  Channel: ${ch.topic} [${ch.schemaName}] encoding=${ch.encoding} schemaEncoding=${ch.schemaEncoding ?? 'none'}`,
      );
    }

    if (this.connectResolve && this.serverInfoReceived) {
      this.log(`Connection established with ${msg.channels.length} initial topics.`);
      this.clearConnectionTimeout();
      this.reconnectAttempts = 0;
      this.setStatus('connected');
      this.startPingLoop();

      this.connectResolve();
      this.connectResolve = null;
      this.connectReject = null;
    } else {
      this.notifyTopicsChanged();
    }
  }

  private handleUnadvertise(msg: FoxgloveUnadvertise): void {
    for (const id of msg.channelIds) {
      const ch = this.channels.get(id);
      if (ch) {
        this.topicToChannelId.delete(ch.topic);
      }
      this.channels.delete(id);
    }
    this.notifyTopicsChanged();
  }

  private handleAdvertiseServices(msg: FoxgloveAdvertiseServices): void {
    for (const svc of msg.services) {
      this.availableServices.set(svc.name, svc);
    }
    this.notifyServicesChanged();
  }

  private notifyServicesChanged(): void {
    const snapshot = this.getAvailableServices();
    for (const cb of this.servicesListeners) {
      try {
        cb(snapshot);
      } catch (err) {
        this.logger.error('[FoxgloveClient] Services listener error:', err);
      }
    }
  }

  private handleServiceCallResponse(msg: FoxgloveServiceResponse): void {
    const pending = this.pendingServiceCalls.get(msg.callId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingServiceCalls.delete(msg.callId);

    try {
      if (msg.encoding === 'json' && msg.data) {
        const decoded = atob(msg.data);
        const parsed = JSON.parse(decoded) as Record<string, unknown>;
        pending.resolve(parsed);
      } else {
        pending.resolve({ success: true });
      }
    } catch (err) {
      pending.reject(
        new Error(
          `Failed to parse service response: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }

  // ── Private: keep-alive ──────────────────────────────────────────────────

  private startPingLoop(): void {
    this.stopPingLoop();

    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        if (this.pongTimer) {
          clearTimeout(this.pongTimer);
          this.pongTimer = null;
        }

        this.lastPingSentTime = Date.now();
        this.sendJson({ op: 'ping' });

        this.pongTimer = setTimeout(() => {
          this.logger.warn('[FoxgloveClient] Pong timeout — reconnecting');
          this.handleClose(4000, 'Pong timeout');
        }, PONG_TIMEOUT_MS);
      }
    }, PING_INTERVAL_MS);
  }

  private stopPingLoop(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private handlePong(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
    if (this.onLatency && this.lastPingSentTime > 0) {
      try {
        this.onLatency(Date.now() - this.lastPingSentTime);
      } catch {
        // metrics must never affect protocol operation
      }
    }
  }

  // ── Private: reconnection ────────────────────────────────────────────────

  private handleConnectionError(error: Error): void {
    this.clearConnectionTimeout();

    if (this.connectReject) {
      this.connectReject(error);
      this.connectResolve = null;
      this.connectReject = null;
    }

    this.setStatus('error');
    this.cleanup();
    this.scheduleReconnect();
  }

  private handleClose(_code: number, _reason: string): void {
    const wasConnected = this.status === 'connected';

    if (wasConnected && this.hasPublishedTwist && !this.intentionalDisconnect) {
      this.safePublishZeroTwist();
    }

    this.cleanup();
    this.setStatus('disconnected');

    if (wasConnected && !this.intentionalDisconnect) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (
      this.intentionalDisconnect ||
      this.reconnectTimer !== null ||
      this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS
    ) {
      if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        this.logger.warn(
          `[FoxgloveClient] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached`,
        );
        this.setStatus('error');
      }
      return;
    }

    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts),
      16_000,
    );
    this.log(
      `Scheduling reconnect attempt ${this.reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms...`,
    );
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.performConnect().catch((err) => {
        this.logger.error('[FoxgloveClient] Reconnect failed:', err);
      });
    }, delay);
  }

  // ── Private: unsubscribe ─────────────────────────────────────────────────

  private unsubscribeTopic(topic: string, subscriptionId: number): void {
    const sub = this.subscriptions.get(subscriptionId);
    sub?.breaker.destroy();
    // `breakerListeners` are owned by the caller of `onBreakerStateChange`,
    // not by the subscription. Their cleanup happens through the unsubscribe
    // function that `onBreakerStateChange` returns. Tearing them down here
    // would nuke listeners belonging to other consumers watching the same
    // topic.

    this.subscriptions.delete(subscriptionId);
    this.topicToSubscriptionId.delete(topic);
    this.messageReaders.delete(subscriptionId);

    if (this.ws && this.status === 'connected' && !sub?.isPaused) {
      this.sendJson({
        op: 'unsubscribe',
        subscriptionIds: [subscriptionId],
      });
    }
  }

  // ── IProtocolClient: circuit breaker controls ─────────────────────────────

  getBreakerState(topic: string): CircuitBreakerState {
    const subId = this.topicToSubscriptionId.get(topic);
    if (subId === undefined) return 'closed';
    const sub = this.subscriptions.get(subId);
    return sub?.breaker.getState() ?? 'closed';
  }

  getBreakerNextRetryAt(topic: string): number | null {
    const subId = this.topicToSubscriptionId.get(topic);
    if (subId === undefined) return null;
    return this.subscriptions.get(subId)?.breaker.getNextRetryAt() ?? null;
  }

  getSubscriptionStats(topic: string) {
    const subId = this.topicToSubscriptionId.get(topic);
    if (subId === undefined) return null;
    const sub = this.subscriptions.get(subId);
    if (!sub) return null;
    const mode = this.getThrottleMode();
    return {
      adaptiveMinIntervalMs: sub.bandwidth.adaptiveMinIntervalMs,
      bucketLabel: getTrackerBucketLabel(sub.bandwidth, mode),
      bytesPerSec: sub.bandwidth.bytesPerSec,
    };
  }

  breakerRetry(topic: string): void {
    const subId = this.topicToSubscriptionId.get(topic);
    if (subId === undefined) return;
    this.subscriptions.get(subId)?.breaker.retry();
  }

  breakerDisable(topic: string): void {
    const subId = this.topicToSubscriptionId.get(topic);
    if (subId === undefined) return;
    this.subscriptions.get(subId)?.breaker.disable();
  }

  onBreakerStateChange(
    topic: string,
    cb: (state: CircuitBreakerState) => void,
  ): () => void {
    let listeners = this.breakerListeners.get(topic);
    if (!listeners) {
      listeners = new Set();
      this.breakerListeners.set(topic, listeners);
    }
    listeners.add(cb);
    return () => {
      const set = this.breakerListeners.get(topic);
      if (set) {
        set.delete(cb);
        if (set.size === 0) this.breakerListeners.delete(topic);
      }
    };
  }

  // ── Private: dead-man's switch ───────────────────────────────────────────

  private safePublishZeroTwist(): void {
    if (!this.hasPublishedTwist) return;

    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.publish('/cmd_vel', CMD_VEL_SCHEMA, ZERO_TWIST, { priority: 'control' });
      }
    } catch {
      // best effort
    }

    this.hasPublishedTwist = false;
  }

  // ── Private: cleanup ─────────────────────────────────────────────────────

  private cleanup(): void {
    this.clearConnectionTimeout();
    this.stopPingLoop();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    for (const [, pending] of this.pendingServiceCalls) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection closed'));
    }
    this.pendingServiceCalls.clear();

    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN && this.advertisedTopics.size > 0) {
        const channelIds = Array.from(this.advertisedTopics.values());
        try {
          this.sendJson({ op: 'unadvertise', channelIds });
        } catch {
          // best effort
        }
      }

      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;

      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close();
      }
      this.ws = null;
    }

    this.channels.clear();
    this.topicToChannelId.clear();
    this.subscriptions.clear();
    this.topicToSubscriptionId.clear();
    this.messageReaders.clear();
    this.advertisedTopics.clear();
    this.availableServices.clear();
    this.notifyServicesChanged();
    this.serverInfoReceived = false;
    this.nextSubscriptionId = 1;
    this.nextClientChannelId = 1;
    this.nextServiceCallId = 1;
  }

  private clearConnectionTimeout(): void {
    if (this.connectionTimeoutTimer) {
      clearTimeout(this.connectionTimeoutTimer);
      this.connectionTimeoutTimer = null;
    }
  }

  // ── Private: helpers ─────────────────────────────────────────────────────

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const cb of this.statusListeners) {
      try {
        cb(status);
      } catch (err) {
        this.logger.error('[FoxgloveClient] Status listener error:', err);
      }
    }
  }

  private sendJson(msg: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private notifyTopicsChanged(): void {
    const appTopics = new Set(this.advertisedTopics.keys());
    const topics: TopicInfo[] = Array.from(this.channels.values()).map((ch) => ({
      topic: ch.topic,
      schemaName: ch.schemaName,
      encoding: ch.encoding,
      source: appTopics.has(ch.topic) ? ('app' as const) : ('robot' as const),
    }));
    for (const cb of this.topicsListeners) {
      try {
        cb(topics);
      } catch (err) {
        this.logger.error('[FoxgloveClient] Topics listener error:', err);
      }
    }
  }

  private log(message: string): void {
    const timestamp = new Date().toISOString().substring(11, 23);
    const formatted = `[${timestamp}] ${message}`;
    this.logger.log(`[FoxgloveClient] ${formatted}`);
    for (const cb of this.logListeners) {
      try {
        cb(formatted);
      } catch (err) {
        this.logger.error('[FoxgloveClient] Log listener error:', err);
      }
    }
  }
}
