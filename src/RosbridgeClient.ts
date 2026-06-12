// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * RosbridgeClient — rosbridge v2 protocol implementation.
 *
 * Implements the rosbridge v2 JSON protocol directly over the runtime's
 * `WebSocket`. No `roslib` dependency: that library pulls in Node-only
 * modules (`bson`, `ws`) that break in React Native and that we don't need
 * because the protocol is a small JSON envelope.
 *
 * Protocol spec: https://github.com/RobotWebTools/rosbridge_suite/blob/ros2/ROSBRIDGE_PROTOCOL.md
 * Default port: 9090.
 *
 * Features:
 *
 * - Topic discovery via the `/rosapi/topics` service.
 * - Subscribe with `throttle_rate` and `queue_length=1` (drop old, keep
 *   latest) for sane defaults on high-rate topics.
 * - Publish with auto-advertise on first send.
 * - Service calls with a 30 s timeout.
 * - Dead-man's switch: zero Twist on unexpected disconnect.
 * - Exponential backoff reconnection (1 s → 2 s → 4 s → 8 s → 16 s, max 5
 *   attempts).
 * - `tryDropPublishBeforeParse` fast-path: bounded substring scan extracts
 *   `op` and `topic` from a `publish` envelope so we can drop messages no
 *   callback wants without paying `JSON.parse` cost on the full payload.
 *   Matters for high-bandwidth topics where parse dominates per-message
 *   work.
 */

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

const NOOP_LOGGER: ProtocolLogger = { log() {}, warn() {}, error() {} };

// Module-level decoder singleton — see the FoxgloveClient comment for the
// rationale; same reasoning for the rosbridge binary-frame path.
const TEXT_DECODER = new TextDecoder();

const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RECONNECT_DELAY_MS = 1_000;
const CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_THROTTLE_RATE_MS = 100;
const SERVICE_CALL_TIMEOUT_MS = 30_000;

const ZERO_TWIST = {
  linear: { x: 0, y: 0, z: 0 },
  angular: { x: 0, y: 0, z: 0 },
};

const CMD_VEL_SCHEMA = 'geometry_msgs/msg/Twist';

// Per-callback subscription state. `dispatchMode` and the deferred-drain
// fields below it are only exercised by `latest-only` subscribers. rosbridge
// frames are JSON text, so a `latest-only` callback stashes the raw,
// unparsed string (immutable, so the stash is copy-free) and parses only the
// survivor on drain.
interface RosbridgeCallbackEntry {
  userMinIntervalMs: number | undefined;
  disableAdaptive: boolean;
  lastDeliveredAt: number;
  dispatchMode: 'immediate' | 'latest-only';
  pending: { raw: string; receivedAt: number } | null;
  drainTimer: ReturnType<typeof setTimeout> | null;
}

export class RosbridgeClient implements IProtocolClient {
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
  private availableServices: ServiceInfo[] = [];
  private servicesPollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options?: ProtocolClientOptions) {
    this.onLatency = options?.onLatency;
    this.logger = options?.logger ?? NOOP_LOGGER;
    this.getThrottleMode = options?.getThrottleMode ?? (() => 'auto');
    this.presets = buildEffectivePresets(options?.presetOverrides, this.logger);
    // Wire the EventLoopMonitor's mode getter from our own throttle-mode
    // option so consumers never need to know that setter exists.
    setModeGetter(this.getThrottleMode);
  }

  private activeSubscriptions = new Map<
    string,
    {
      schemaName: string;
      callbacks: Map<(msg: RosMessage) => void, RosbridgeCallbackEntry>;
      bandwidth: BandwidthTracker;
      breaker: CircuitBreaker;
      isPaused: boolean;
    }
  >();
  private breakerListeners = new Map<string, Set<(state: CircuitBreakerState) => void>>();

  private advertisedTopics = new Set<string>();
  private hasPublishedTwist = false;

  private static readonly CONTROL_FLUSH_BATCH = 3;
  private controlOutbox: Array<{ op: 'publish'; topic: string; msg: Record<string, unknown> }> = [];
  private controlFlushScheduled = false;

  private discoveredTopics: TopicInfo[] = [];

  private pendingServiceCalls = new Map<
    string,
    {
      resolve: (result: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private serviceCallCounter = 0;

  private latencyProbeTimer: ReturnType<typeof setInterval> | null = null;

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalDisconnect = false;

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

    this.log(`Connecting to rosbridge at ${this.url}...`);
    return this.performConnect();
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;

    this.safePublishZeroTwist();
    this.flushControlOutbox();

    this.cleanup();
    this.setStatus('disconnected');
  }

  async getAvailableTopics(): Promise<TopicInfo[]> {
    if (!this.ws || !this.isConnected) {
      return this.discoveredTopics;
    }

    try {
      const result = await this.callService('/rosapi/topics', {});
      const names: string[] = (result.topics as string[]) ?? [];
      const types: string[] = (result.types as string[]) ?? [];

      const topics: TopicInfo[] = [];
      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        if (!name) continue;
        topics.push({
          topic: name,
          schemaName: types[i] ?? '',
          encoding: 'json',
          source: this.advertisedTopics.has(name) ? 'app' : 'robot',
        });
      }

      this.discoveredTopics = topics;
      this.log(`Discovered ${topics.length} topics.`);
      this.notifyTopicsChanged();
      return topics;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`Failed to get topics via rosapi: ${msg}`);
      return this.discoveredTopics;
    }
  }

  getSchemaTemplate(_schemaName: string): Record<string, unknown> | null {
    // rosbridge's /rosapi/message_details is async and not surfaced through
    // the current IProtocolClient contract. Consumers that need a template
    // for a rosbridge connection should compose one client-side. Foxglove WS
    // does the heavy lifting via inline schemas.
    return null;
  }

  subscribe(
    topic: string,
    onMessage: (msg: RosMessage) => void,
    options?: SubscribeOptions,
  ): () => void {
    if (!this.ws || this.status !== 'connected') {
      return () => {};
    }

    const userMinIntervalMs =
      options?.maxFrequency && options.maxFrequency > 0
        ? 1000 / options.maxFrequency
        : undefined;
    const disableAdaptive = options?.disableAdaptive ?? false;
    const dispatchMode = options?.dispatchMode ?? 'immediate';

    const existing = this.activeSubscriptions.get(topic);
    if (existing) {
      existing.callbacks.set(onMessage, {
        userMinIntervalMs,
        disableAdaptive,
        lastDeliveredAt: 0,
        dispatchMode,
        pending: null,
        drainTimer: null,
      });
      return () => {
        const entry = existing.callbacks.get(onMessage);
        if (entry) this.cancelDrain(entry);
        existing.callbacks.delete(onMessage);
        if (existing.callbacks.size === 0) {
          this.unsubscribeTopic(topic);
        }
      };
    }

    const topicInfo = this.discoveredTopics.find((t) => t.topic === topic);
    const messageType = topicInfo?.schemaName ?? '';

    if (!messageType) {
      this.log(`Warning: subscribing to "${topic}" without known message type`);
    }

    const callbacks = new Map<(msg: RosMessage) => void, RosbridgeCallbackEntry>();
    callbacks.set(onMessage, {
      userMinIntervalMs,
      disableAdaptive,
      lastDeliveredAt: 0,
      dispatchMode,
      pending: null,
      drainTimer: null,
    });

    const breaker = new CircuitBreaker({
      ...DEFAULT_BREAKER_CONFIG,
      onStateChange: (newState) => {
        const sub = this.activeSubscriptions.get(topic);
        if (!sub) return;
        sub.isPaused = newState === 'tripped_auto' || newState === 'tripped_manual';
        // A breaker trip discards any pending latest-only payload: stale bytes,
        // and we must not deliver after pausing the subscription.
        if (sub.isPaused) this.cancelAllDrains(sub);
        if (newState === 'tripped_auto') {
          if (this.ws && this.status === 'connected') {
            this.send({ op: 'unsubscribe', topic });
          }
          this.log(`[breaker] ${topic} → tripped_auto (sustained overload)`);
        } else if (newState === 'half_open') {
          setTrackerToDeepest(sub.bandwidth, this.getThrottleMode());
          if (this.ws && this.status === 'connected') {
            this.send({
              op: 'subscribe',
              topic,
              type: sub.schemaName,
              throttle_rate: DEFAULT_THROTTLE_RATE_MS,
              queue_length: 1,
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
              this.logger.error('[RosbridgeClient] Breaker listener error:', err);
            }
          }
        }
      },
    });

    this.activeSubscriptions.set(topic, {
      schemaName: messageType,
      callbacks,
      bandwidth: createBandwidthTracker(this.getThrottleMode(), this.presets),
      breaker,
      isPaused: false,
    });

    this.send({
      op: 'subscribe',
      topic,
      type: messageType,
      throttle_rate: DEFAULT_THROTTLE_RATE_MS,
      queue_length: 1,
    });

    return () => {
      const entry = callbacks.get(onMessage);
      if (entry) this.cancelDrain(entry);
      callbacks.delete(onMessage);
      if (callbacks.size === 0) {
        this.unsubscribeTopic(topic);
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

    if (!this.advertisedTopics.has(topic)) {
      this.send({
        op: 'advertise',
        topic,
        type: schemaName,
      });
      this.advertisedTopics.add(topic);
    }

    const payload = { op: 'publish' as const, topic, msg: data };

    if (options?.priority === 'control') {
      // Conflate-on-replace by topic. Mirrors the FoxgloveClient outbox: if a
      // control-priority publish for this topic is already pending, replace
      // rather than append. Under JS-thread saturation a stop publish (zero
      // Twist released by a joystick gesture-end, action cancel, etc.) drains
      // in one WS send instead of behind every stale tick that piled up
      // during the block. The latest publish IS the latest intent. Insertion
      // order across distinct topics is preserved (replace in place); only
      // intra-topic duplicates collapse.
      const existing = this.controlOutbox.findIndex((e) => e.topic === topic);
      if (existing >= 0) {
        this.controlOutbox[existing] = payload;
      } else {
        this.controlOutbox.push(payload);
      }
      this.scheduleControlFlush();
      return;
    }

    this.send(payload);
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
      drained < RosbridgeClient.CONTROL_FLUSH_BATCH
    ) {
      const entry = this.controlOutbox.shift();
      if (!entry) break;
      this.send(entry);
      drained++;
    }
    if (this.controlOutbox.length > 0) {
      this.scheduleControlFlush();
    }
  }

  ensureAdvertised(topic: string, schemaName: string): void {
    if (!this.ws || this.status !== 'connected') return;
    if (this.advertisedTopics.has(topic)) return;

    this.send({
      op: 'advertise',
      topic,
      type: schemaName,
    });
    this.advertisedTopics.add(topic);
  }

  unadvertise(topic: string): void {
    if (!this.advertisedTopics.has(topic)) return;

    this.advertisedTopics.delete(topic);

    if (this.ws && this.status === 'connected') {
      this.send({
        op: 'unadvertise',
        topic,
      });
    }
  }

  async callService(
    service: string,
    request: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.ws || this.status !== 'connected') {
      throw new Error('Not connected');
    }

    const id = `service_call:${service}:${++this.serviceCallCounter}`;

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingServiceCalls.delete(id);
        reject(
          new Error(`Service call "${service}" timed out after ${SERVICE_CALL_TIMEOUT_MS}ms`),
        );
      }, SERVICE_CALL_TIMEOUT_MS);

      this.pendingServiceCalls.set(id, { resolve, reject, timer });

      this.send({
        op: 'call_service',
        id,
        service,
        args: request,
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
    return [...this.availableServices];
  }

  onServicesChange(cb: (services: ServiceInfo[]) => void): () => void {
    this.servicesListeners.add(cb);
    cb(this.getAvailableServices());
    return () => {
      this.servicesListeners.delete(cb);
    };
  }

  private async discoverServices(): Promise<void> {
    if (!this.isConnected) return;
    try {
      const result = await this.callService('/rosapi/services', {});
      const names: string[] = (result.services as string[]) ?? [];
      const next: ServiceInfo[] = names.map((n) => ({ name: n, type: '' }));
      const prevKey = this.availableServices
        .map((s) => s.name)
        .sort()
        .join('|');
      const nextKey = next.map((s) => s.name).sort().join('|');
      if (prevKey === nextKey) return;
      this.availableServices = next;
      this.notifyServicesChanged();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`Service discovery via /rosapi/services failed: ${msg}`);
      this.stopServicesPoll();
    }
  }

  private startServicesPoll(): void {
    if (this.servicesPollTimer) return;
    void this.discoverServices();
    this.servicesPollTimer = setInterval(() => {
      void this.discoverServices();
    }, 30_000);
  }

  private stopServicesPoll(): void {
    if (this.servicesPollTimer) {
      clearInterval(this.servicesPollTimer);
      this.servicesPollTimer = null;
    }
  }

  private notifyServicesChanged(): void {
    const snapshot = this.getAvailableServices();
    for (const cb of this.servicesListeners) {
      try {
        cb(snapshot);
      } catch (err) {
        this.logger.error('[RosbridgeClient] Services listener error:', err);
      }
    }
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

  // ── Private: connection lifecycle ──────────────────────────────────────

  private performConnect(): Promise<void> {
    this.cleanupConnection();
    this.setStatus('connecting');

    return new Promise<void>((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);

        this.connectionTimeoutTimer = setTimeout(() => {
          this.log(`Connection timeout after ${CONNECTION_TIMEOUT_MS}ms`);
          reject(new Error(`Connection timeout after ${CONNECTION_TIMEOUT_MS}ms`));
          this.cleanup();
          this.setStatus('error');
          this.scheduleReconnect();
        }, CONNECTION_TIMEOUT_MS);

        this.ws.onopen = () => {
          this.clearConnectionTimeout();
          this.reconnectAttempts = 0;
          this.log('Connected to rosbridge server.');
          this.setStatus('connected');
          this.startLatencyProbe();
          this.startServicesPoll();
          resolve();
        };

        this.ws.onerror = (event: Event) => {
          const detail =
            (event as Event & { message?: string }).message ?? 'Connection error';
          this.log(`Rosbridge error: ${detail}`);
          this.logger.error('[RosbridgeClient] Error:', event);

          if (this.status === 'connecting') {
            this.clearConnectionTimeout();
            reject(new Error(`Rosbridge error: ${detail}`));
            this.cleanup();
            this.setStatus('error');
            this.scheduleReconnect();
          }
        };

        this.ws.onclose = () => {
          const wasConnected = this.status === 'connected';
          this.log('Rosbridge connection closed.');

          if (wasConnected && this.hasPublishedTwist && !this.intentionalDisconnect) {
            this.safePublishZeroTwist();
          }

          this.cleanupConnection();
          this.setStatus('disconnected');

          if (wasConnected && !this.intentionalDisconnect) {
            this.scheduleReconnect();
          }
        };

        this.ws.onmessage = (event: MessageEvent) => {
          this.handleMessage(event.data as string | ArrayBuffer);
        };
      } catch (err) {
        this.clearConnectionTimeout();
        const error = err instanceof Error ? err : new Error(String(err));
        reject(error);
        this.cleanup();
        this.setStatus('error');
      }
    });
  }

  // ── Private: message handling ──────────────────────────────────────────

  private handleMessage(raw: string | ArrayBuffer): void {
    if (this.controlOutbox.length > 0) {
      this.flushControlOutbox();
    }

    try {
      const data = typeof raw === 'string' ? raw : TEXT_DECODER.decode(raw);
      const byteSize = typeof raw === 'string' ? data.length : raw.byteLength;
      // Compute mode once per incoming message and forward to the inner
      // handlers so we don't call the host's `getThrottleMode` twice on the
      // fast-path → dispatch flow.
      const mode = this.getThrottleMode();

      if (this.tryDropPublishBeforeParse(data, byteSize, mode)) {
        return;
      }

      const msg = JSON.parse(data) as Record<string, unknown>;
      const op = msg.op as string;

      switch (op) {
        case 'publish':
          this.handlePublish(msg, byteSize, mode);
          break;
        case 'service_response':
          this.handleServiceResponse(msg);
          break;
        case 'status': {
          const level = msg.level as string | undefined;
          const statusMsg = msg.msg as string | undefined;
          if (level === 'error' || level === 'warning') {
            this.log(`rosbridge ${level}: ${statusMsg ?? 'unknown'}`);
          }
          break;
        }
      }
    } catch (err) {
      this.logger.error('[RosbridgeClient] Failed to parse message:', err);
    }
  }

  /**
   * Drop a publish message before paying full `JSON.parse` cost.
   *
   * Rosbridge frames look like `{"op":"publish","topic":"…","msg":{…}}`.
   * For fat payloads (base64-encoded camera frames, large arrays)
   * `JSON.parse` on the whole envelope dominates per-message cost. We do a
   * cheap substring search to extract `op` and `topic`, run the same
   * throttle/breaker accounting `handlePublish` would do, and return `true`
   * to skip the parse when no callback wants the message right now.
   *
   * Handles both compact (`{"op":"publish"`) and pretty (`{"op": "publish"`)
   * JSON forms.
   */
  private tryDropPublishBeforeParse(data: string, byteSize: number, mode: ThrottleMode): boolean {
    if (
      !data.startsWith('{"op":"publish"') &&
      !data.startsWith('{"op": "publish"')
    ) {
      return false;
    }

    const topicKeyIdx = data.indexOf('"topic"');
    if (topicKeyIdx < 0 || topicKeyIdx > 200) return false;

    let i = topicKeyIdx + 7;
    if (data[i] !== ':') return false;
    i++;
    if (data[i] === ' ') i++;
    if (data[i] !== '"') return false;
    i++;
    const topicEnd = data.indexOf('"', i);
    if (topicEnd < 0) return false;
    const topic = data.slice(i, topicEnd);

    const sub = this.activeSubscriptions.get(topic);
    if (!sub) return true; // not subscribed → drop

    const now = Date.now();

    if (sub.isPaused) {
      recordBytes(sub.bandwidth, now, byteSize, mode);
      return true;
    }

    // Walk eligible callbacks. A `latest-only` subscriber conflates before
    // parse: stash the raw (unparsed) frame string — immutable, so copy-free —
    // and defer the JSON.parse to a `setTimeout(0)` drain that parses only the
    // survivor. `immediate` subscribers fall through to the normal parse +
    // `handlePublish` path.
    let anyImmediateWantsThis = false;
    for (const [cb, entry] of sub.callbacks) {
      const interval = effectiveMinInterval(
        entry.userMinIntervalMs,
        entry.disableAdaptive,
        sub.bandwidth,
      );
      const eligible = interval <= 0 || now - entry.lastDeliveredAt >= interval;
      if (!eligible) continue;

      if (entry.dispatchMode === 'latest-only') {
        entry.lastDeliveredAt = now;
        entry.pending = { raw: data, receivedAt: now };
        if (entry.drainTimer === null) {
          entry.drainTimer = setTimeout(() => this.drainLatestOnly(topic, cb, entry), 0);
        }
      } else {
        anyImmediateWantsThis = true;
      }
    }

    // An immediate subscriber needs the parsed message: let the frame through
    // to JSON.parse + handlePublish, which does the bytes/breaker accounting.
    if (anyImmediateWantsThis) return false;

    // Nothing immediate wanted it (all eligible callbacks were latest-only, or
    // none were eligible). Account here and skip the parse.
    recordBytes(sub.bandwidth, now, byteSize, mode);
    sub.breaker.recordObservation(now, sub.bandwidth.bytesPerSec, getMaxLagMs());

    return true;
  }

  private handlePublish(msg: Record<string, unknown>, byteSize: number, mode: ThrottleMode): void {
    const topic = msg.topic as string;
    const msgData = (msg.msg ?? {}) as Record<string, unknown>;

    const sub = this.activeSubscriptions.get(topic);
    if (!sub) return;
    if (sub.isPaused) return;

    const now = Date.now();
    recordBytes(sub.bandwidth, now, byteSize, mode);
    sub.breaker.recordObservation(now, sub.bandwidth.bytesPerSec, getMaxLagMs());

    // Single pass over callbacks: collect those whose throttle window allows
    // delivery. Avoids recomputing `effectiveMinInterval` in a second loop.
    // `latest-only` callbacks are skipped here — they were stashed and armed
    // for deferred delivery in `tryDropPublishBeforeParse`, upstream of parse.
    const deliverTo: Array<[(msg: RosMessage) => void, RosbridgeCallbackEntry]> = [];
    for (const [cb, entry] of sub.callbacks) {
      if (entry.dispatchMode === 'latest-only') continue;
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

    const rosMsg: RosMessage = {
      topic,
      schemaName: sub.schemaName,
      encoding: 'json',
      data: msgData,
      receiveTime: {
        sec: Math.floor(now / 1000),
        nsec: (now % 1000) * 1_000_000,
      },
      byteSize,
    };

    for (const [cb, entry] of deliverTo) {
      entry.lastDeliveredAt = now;
      try {
        cb(rosMsg);
      } catch (err) {
        this.logger.error('[RosbridgeClient] Subscriber callback error:', err);
      }
    }
  }

  /**
   * Drain one `latest-only` callback's pending frame: parse the survivor and
   * deliver it. State (`pending`, `drainTimer`) is cleared *before* the
   * callback runs, so a throwing callback never wedges future delivery. Bails
   * if the subscription was torn down or paused while the drain was armed (no
   * post-teardown delivery).
   */
  private drainLatestOnly(
    topic: string,
    cb: (msg: RosMessage) => void,
    entry: RosbridgeCallbackEntry,
  ): void {
    entry.drainTimer = null;
    const pending = entry.pending;
    entry.pending = null;
    if (!pending) return;

    const sub = this.activeSubscriptions.get(topic);
    if (!sub || sub.isPaused) return;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(pending.raw) as Record<string, unknown>;
    } catch {
      return; // malformed frame; nothing to deliver
    }

    const rosMsg: RosMessage = {
      topic,
      schemaName: sub.schemaName,
      encoding: 'json',
      data: (parsed.msg ?? {}) as Record<string, unknown>,
      receiveTime: {
        sec: Math.floor(pending.receivedAt / 1000),
        nsec: (pending.receivedAt % 1000) * 1_000_000,
      },
      byteSize: pending.raw.length,
    };
    try {
      cb(rosMsg);
    } catch (err) {
      this.logger.error('[RosbridgeClient] Subscriber callback error:', err);
    }
  }

  /** Cancel one callback's armed drain and drop its pending frame. */
  private cancelDrain(entry: RosbridgeCallbackEntry): void {
    if (entry.drainTimer !== null) {
      clearTimeout(entry.drainTimer);
      entry.drainTimer = null;
    }
    entry.pending = null;
  }

  /** Cancel every armed drain on a subscription (teardown / pause). */
  private cancelAllDrains(sub: {
    callbacks: Map<(msg: RosMessage) => void, RosbridgeCallbackEntry>;
  }): void {
    for (const entry of sub.callbacks.values()) this.cancelDrain(entry);
  }

  private handleServiceResponse(msg: Record<string, unknown>): void {
    const id = msg.id as string;
    const pending = this.pendingServiceCalls.get(id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingServiceCalls.delete(id);

    const success = msg.result === true || msg.result === 'true';
    if (success) {
      const values = (msg.values ?? {}) as Record<string, unknown>;
      pending.resolve(values);
    } else {
      const errorMsg =
        typeof msg.values === 'string' ? msg.values : 'Service call failed';
      pending.reject(new Error(errorMsg));
    }
  }

  // ── Private: topic management ──────────────────────────────────────────

  private unsubscribeTopic(topic: string): void {
    const sub = this.activeSubscriptions.get(topic);
    if (sub) this.cancelAllDrains(sub);
    sub?.breaker.destroy();
    // `breakerListeners` are owned by the caller of `onBreakerStateChange`,
    // not by the subscription. Their cleanup happens through the unsubscribe
    // function that `onBreakerStateChange` returns.

    this.activeSubscriptions.delete(topic);
    if (this.ws && this.status === 'connected' && !sub?.isPaused) {
      this.send({ op: 'unsubscribe', topic });
    }
  }

  // ── IProtocolClient: circuit breaker controls ─────────────────────────────

  getBreakerState(topic: string): CircuitBreakerState {
    return this.activeSubscriptions.get(topic)?.breaker.getState() ?? 'closed';
  }

  getBreakerNextRetryAt(topic: string): number | null {
    return this.activeSubscriptions.get(topic)?.breaker.getNextRetryAt() ?? null;
  }

  getSubscriptionStats(topic: string) {
    const sub = this.activeSubscriptions.get(topic);
    if (!sub) return null;
    const mode = this.getThrottleMode();
    return {
      adaptiveMinIntervalMs: sub.bandwidth.adaptiveMinIntervalMs,
      bucketLabel: getTrackerBucketLabel(sub.bandwidth, mode),
      bytesPerSec: sub.bandwidth.bytesPerSec,
    };
  }

  breakerRetry(topic: string): void {
    this.activeSubscriptions.get(topic)?.breaker.retry();
  }

  breakerDisable(topic: string): void {
    this.activeSubscriptions.get(topic)?.breaker.disable();
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

  // ── Private: dead-man's switch ─────────────────────────────────────────

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

  // ── Private: latency probe ──────────────────────────────────────────────

  private startLatencyProbe(): void {
    this.stopLatencyProbe();
    this.latencyProbeTimer = setInterval(() => {
      if (!this.ws || this.status !== 'connected') return;
      const start = Date.now();
      const id = `latency_probe:${++this.serviceCallCounter}`;

      const timer = setTimeout(() => {
        this.pendingServiceCalls.delete(id);
      }, 5_000);

      this.pendingServiceCalls.set(id, {
        resolve: () => {
          clearTimeout(timer);
          if (this.onLatency) {
            try {
              this.onLatency(Date.now() - start);
            } catch {
              // metrics must never affect protocol operation
            }
          }
        },
        reject: () => {
          clearTimeout(timer);
        },
        timer,
      });

      this.send({
        op: 'call_service',
        id,
        service: '/rosapi/topics',
        args: {},
      });
    }, 5_000);
  }

  private stopLatencyProbe(): void {
    if (this.latencyProbeTimer) {
      clearInterval(this.latencyProbeTimer);
      this.latencyProbeTimer = null;
    }
  }

  // ── Private: reconnection ──────────────────────────────────────────────

  private scheduleReconnect(): void {
    if (
      this.intentionalDisconnect ||
      this.reconnectTimer !== null ||
      this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS
    ) {
      if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        this.log(`Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached.`);
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
        this.logger.error('[RosbridgeClient] Reconnect failed:', err);
      });
    }, delay);
  }

  // ── Private: cleanup ───────────────────────────────────────────────────

  private cleanupConnection(): void {
    this.clearConnectionTimeout();
    this.stopServicesPoll();
    for (const sub of this.activeSubscriptions.values()) {
      this.cancelAllDrains(sub);
      // Destroy the breaker so its cooldown timer can't outlive the
      // connection and fire half_open into the next one.
      sub.breaker.destroy();
    }
    this.activeSubscriptions.clear();

    for (const [, pending] of this.pendingServiceCalls) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection closed'));
    }
    this.pendingServiceCalls.clear();

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      for (const topic of this.advertisedTopics) {
        try {
          this.send({ op: 'unadvertise', topic });
        } catch {
          // best effort
        }
      }
    }

    this.advertisedTopics.clear();
  }

  private cleanup(): void {
    this.cleanupConnection();
    this.stopLatencyProbe();
    this.stopServicesPoll();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      // Detach handlers before close (mirroring FoxgloveClient.cleanup).
      // Otherwise a late onclose from a stale socket — e.g. a timed-out
      // CONNECTING socket whose close lands after a reconnect succeeded —
      // fires handleClose into the live connection's state and tears it down.
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }

    this.discoveredTopics = [];
    if (this.availableServices.length > 0) {
      this.availableServices = [];
      this.notifyServicesChanged();
    }
  }

  private clearConnectionTimeout(): void {
    if (this.connectionTimeoutTimer) {
      clearTimeout(this.connectionTimeoutTimer);
      this.connectionTimeoutTimer = null;
    }
  }

  // ── Private: helpers ───────────────────────────────────────────────────

  private send(msg: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const cb of this.statusListeners) {
      try {
        cb(status);
      } catch (err) {
        this.logger.error('[RosbridgeClient] Status listener error:', err);
      }
    }
  }

  private notifyTopicsChanged(): void {
    for (const cb of this.topicsListeners) {
      try {
        cb(this.discoveredTopics);
      } catch (err) {
        this.logger.error('[RosbridgeClient] Topics listener error:', err);
      }
    }
  }

  private log(message: string): void {
    const timestamp = new Date().toISOString().substring(11, 23);
    const formatted = `[${timestamp}] ${message}`;
    this.logger.log(`[RosbridgeClient] ${formatted}`);
    for (const cb of this.logListeners) {
      try {
        cb(formatted);
      } catch (err) {
        this.logger.error('[RosbridgeClient] Log listener error:', err);
      }
    }
  }
}
