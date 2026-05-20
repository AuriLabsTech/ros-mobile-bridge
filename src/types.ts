// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * Public type contracts for ros-mobile-bridge.
 *
 * Every protocol client (Foxglove WS, rosbridge, future Zenoh) implements
 * IProtocolClient. Consumer code should program against this interface and
 * pick the transport at runtime via ProtocolManager.
 */

// ─── Messages ────────────────────────────────────────────────────────────────

/**
 * A single ROS message delivered to a subscriber callback.
 *
 * `data` is either a decoded JavaScript object or a raw byte array when the
 * protocol could not decode the payload (no schema available, decode failure).
 * The library decodes CDR for Foxglove WS subscriptions when the channel
 * schema is parseable; otherwise it falls back to a `Uint8Array` so the
 * consumer can still inspect the wire bytes.
 */
export interface RosMessage {
  topic: string;
  schemaName: string;
  encoding: 'json' | 'cdr';
  data: Uint8Array | Record<string, unknown>;
  receiveTime: { sec: number; nsec: number };
  /**
   * Wire payload size in bytes. Populated by the protocol client so consumers
   * don't have to `JSON.stringify` the parsed data to estimate it (which is
   * prohibitively slow for big messages like camera frames).
   */
  byteSize?: number;
}

/**
 * Origin of a topic in the ROS graph as observed by the client.
 *
 * - `'robot'`: the topic is advertised by some node in the ROS graph the
 *   bridge is attached to (a publisher upstream of the bridge).
 * - `'app'`: the topic was advertised by this client via `publish` or
 *   `ensureAdvertised`. Useful when a UI wants to distinguish "things the
 *   robot is publishing" from "things this app has published to the bridge".
 */
export type TopicSource = 'robot' | 'app';

export interface TopicInfo {
  topic: string;
  schemaName: string;
  encoding: string;
  source?: TopicSource;
}

/**
 * A service advertised by the connected robot.
 *
 * Discovery is best-effort and protocol-specific:
 * - Foxglove WS: the bridge pushes `advertiseServices` on connect and on
 *   every ROS-graph change.
 * - rosbridge: the client polls `/rosapi/services` on a slow timer because
 *   the bridge has no push notification for service add/remove.
 *
 * `type` is the bare ROS service type (e.g. `std_srvs/srv/Trigger`) when the
 * protocol surfaces it; an empty string otherwise. rosbridge returns empty
 * strings to avoid a multi-roundtrip per-service type lookup.
 */
export interface ServiceInfo {
  name: string;
  type: string;
}

// ─── Subscription Options ───────────────────────────────────────────────────

/**
 * Options for `IProtocolClient.subscribe`. Used to enforce per-callback rate
 * limiting before message parsing — the dominant JS-thread cost for high-
 * bandwidth topics like compressed camera frames.
 */
export interface SubscribeOptions {
  /**
   * Maximum delivery rate in Hz. Messages within the throttle window are
   * dropped before `JSON.parse` / CDR decode, so a noisy publisher cannot
   * starve the JS thread. `undefined` means deliver every message.
   */
  maxFrequency?: number;
  /**
   * Opt out of the bandwidth-aware adaptive throttle. By default, when a
   * subscription's sustained bytes/sec crosses an internal threshold the
   * client tightens its effective delivery rate beyond what `maxFrequency`
   * requested, to keep the JS thread responsive for gesture and control
   * work. Set `true` when the device has been sized for the workload and
   * the caller wants raw rate.
   */
  disableAdaptive?: boolean;
}

// ─── Subscription Circuit Breaker ───────────────────────────────────────────

/**
 * State of the per-subscription circuit breaker.
 *
 * The breaker trips when even the deepest adaptive-throttle bucket can't keep
 * JS-thread lag below a "still saturated" threshold for a sustained period —
 * the workload is fundamentally too heavy for the transport on the current
 * device. While tripped the subscription is unsubscribed at the bridge,
 * freeing the JS thread, network, and memory entirely.
 *
 * - `closed`: normal operation; throttle handles everything.
 * - `tripped_auto`: subscription paused; auto-retry timer running. Cooldown
 *   is exponential (30 s, 60 s, 120 s, 300 s on repeated trips within a
 *   single connection).
 * - `tripped_manual`: subscription paused with no auto-retry. The user
 *   opted out via UI to stop the periodic stutter from failing recovery
 *   attempts.
 * - `half_open`: subscription resumed; the breaker watches lag for ~10 s.
 *   If lag stays low the breaker closes; if it spikes again it re-trips
 *   with a longer cooldown.
 */
export type CircuitBreakerState =
  | 'closed'
  | 'tripped_auto'
  | 'tripped_manual'
  | 'half_open';

// ─── Subscription Stats ─────────────────────────────────────────────────────

/**
 * Snapshot of the adaptive-throttle state for one subscription. Surfaced so
 * consumers can show users when delivery is being capped below what they
 * requested (e.g. a "5 Hz" / "1 Hz" / "0.5 Hz" badge near a widget).
 * `adaptiveMinIntervalMs > 0` means the throttle is actively limiting.
 */
export interface SubscriptionStats {
  /** Effective adaptive cap interval in ms. `0` means no cap. */
  adaptiveMinIntervalMs: number;
  /**
   * Human-readable label for the active bucket: `"none"`, `"10 Hz"`,
   * `"5 Hz"`, `"1 Hz"`, `"0.5 Hz"`. Renderable verbatim.
   */
  bucketLabel: string;
  /**
   * Last computed bytes/sec for this subscription over a rolling 1 s window.
   * Useful for diagnostics overlays.
   */
  bytesPerSec: number;
}

// ─── Publish Options ────────────────────────────────────────────────────────

/**
 * Options for `IProtocolClient.publish`.
 */
export interface PublishOptions {
  /**
   * Priority hint.
   *
   * - `'control'`: gesture, E-Stop, action cancel, and other safety-critical
   *   publishes that must not be starved by incoming-message parse work.
   *   The client routes control publishes through a small outbox flushed at
   *   the top of every incoming WebSocket message handler, so they ride out
   *   before the JS thread is consumed by the next parse macrotask.
   * - `'data'` (default): sent directly via synchronous `ws.send`. Most
   *   publishes don't share a tick with parse work and don't benefit from
   *   the outbox indirection.
   *
   * The library targets ROS 2 explicitly; the names reflect the semantics
   * (Twist on `/cmd_vel`, action cancel goals, E-Stop publishes) rather
   * than a generic high/normal pair.
   */
  priority?: 'control' | 'data';
}

// ─── Connection ──────────────────────────────────────────────────────────────

export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

export type ProtocolType = 'foxglove-ws' | 'rosbridge' | 'zenoh';

/**
 * Connection parameters consumed by `ProtocolManager.connect`. Only the
 * fields the library needs to open a WebSocket are declared here; identifiers,
 * display names, and any "saved profile" concept are the host application's
 * concern and should live in its own store.
 */
export interface ConnectionOptions {
  protocol: ProtocolType;
  host: string;
  /**
   * Port to connect to. Optional; defaults to `DEFAULT_PORTS[protocol]`
   * (8765 for `foxglove-ws`, 9090 for `rosbridge`, 7447 for `zenoh`).
   */
  port?: number;
  /**
   * Use the secure `wss://` scheme. Optional; defaults to `false` (`ws://`).
   */
  secure?: boolean;
}

// ─── Throttle configuration ─────────────────────────────────────────────────

/**
 * User-selectable adaptive-throttle mode. Each mode maps to a curve of
 * lag-to-delivery-rate buckets; the curves can be overridden per-host via
 * `ProtocolClientOptions.presetOverrides`.
 *
 * - `'performance'`: no adaptive cap, deliver every message the user's
 *   `maxFrequency` allows.
 * - `'auto'` (default): moderate curve tuned for general-purpose mobile use.
 * - `'efficient'`: aggressive curve that prioritises gesture authority over
 *   throughput on lower-end devices.
 *
 * @experimental The throttle-tuning surface (this type, `BucketDef`, and
 * `ProtocolClientOptions.presetOverrides`) is part of the public API but may
 * evolve before `1.0`. The mode names themselves are stable.
 */
export type ThrottleMode = 'performance' | 'auto' | 'efficient';

/**
 * One step in an adaptive-throttle curve. A curve is an array of buckets in
 * ascending `threshold` order; the highest-threshold bucket whose value the
 * measured JS-thread lag exceeds wins, and its `minIntervalMs` becomes the
 * effective delivery interval for every subscription on that throttle mode.
 *
 * The first bucket in every curve must have `threshold === 0` — that's the
 * "no throttle" base case the throttle falls through to when lag is below
 * every higher threshold. Validation in `presetOverrides` enforces this.
 *
 * @experimental Part of the public throttle-tuning surface; the shape is
 * semver-stable but may gain optional fields before `1.0`.
 */
export interface BucketDef {
  /**
   * Minimum JS-thread lag (ms) at which this bucket activates. Compared
   * against the rolling-window max from `getMaxLagMs()`.
   */
  threshold: number;
  /**
   * Minimum interval (ms) between deliveries when this bucket is active.
   * `0` means "no cap" (deliver every message).
   */
  minIntervalMs: number;
  /**
   * Human-readable label used by diagnostics (`bucketLabelForLag`,
   * `getSubscriptionStats.bucketLabel`). Convention: `'none'` for the
   * no-cap bucket, frequency strings like `'5 Hz'` for capped buckets.
   */
  label: string;
}

// ─── Protocol Client Options ────────────────────────────────────────────────

/**
 * Optional callbacks injected by the host application. These let the
 * protocol layer stay decoupled from app-specific concerns (metrics
 * pipelines, logging frameworks, performance-mode settings).
 *
 * Every callback is optional. The library has sensible no-op defaults.
 */
export interface ProtocolClientOptions {
  /**
   * Called with round-trip latency in milliseconds after each successful
   * keep-alive ping/pong or latency probe.
   */
  onLatency?: (rttMs: number) => void;
  /**
   * Logger interface. Falls back to silent no-ops if not provided. The
   * library never writes to `console` directly when a logger is supplied.
   */
  logger?: ProtocolLogger;
  /**
   * Returns the user-selected throttle mode. Read on every incoming message
   * so a Settings change applies immediately to existing subscriptions
   * without resubscribing. Defaults to `'auto'` when not provided.
   */
  getThrottleMode?: () => ThrottleMode;
  /**
   * Override the built-in throttle curves on a per-mode basis. Modes not
   * present in this map (or modes whose override fails validation) fall
   * back to the library's tuned defaults.
   *
   * The library was tuned on one device class; consumers shipping to a
   * different device profile (slower CPU, larger screen, etc.) can supply
   * their own curves here without forking the library.
   *
   * Validation runs once at construction time. A rejected override produces
   * a `logger.warn` and falls back to the default for that mode only; other
   * modes' overrides still take effect. The rules enforced:
   *
   * - The bucket array is non-empty.
   * - The first bucket has `threshold === 0` (the "no throttle" base case).
   *
   * The library does not enforce that thresholds are sorted ascending or
   * that labels are unique within an array — those are consumer-quality
   * concerns; the throttle still terminates with sensible-enough results
   * if they're violated.
   *
   * Note: `bucketLabelForLag(mode, lagMs)` is a stateless module-level
   * diagnostic and always reads the library defaults, never per-client
   * overrides. If a consumer needs override-aware bucket labelling, derive
   * it from `getSubscriptionStats(topic).bucketLabel` instead.
   *
   * @experimental Part of the public throttle-tuning surface; the override
   * shape is semver-stable but may evolve before `1.0`.
   */
  presetOverrides?: Partial<Record<ThrottleMode, BucketDef[]>>;
}

export interface ProtocolLogger {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

// ─── Protocol Client Interface ───────────────────────────────────────────────

/**
 * The contract every transport implements. Program against this interface
 * and use `ProtocolManager` to pick the concrete implementation at runtime.
 */
export interface IProtocolClient {
  // ── Lifecycle ───────────────────────────────────────────────────────────
  connect(url: string): Promise<void>;
  disconnect(): Promise<void>;
  readonly isConnected: boolean;

  // ── Topics ──────────────────────────────────────────────────────────────
  getAvailableTopics(): Promise<TopicInfo[]>;

  /**
   * Subscribe to a topic. Returns an unsubscribe function.
   *
   * If `options.maxFrequency` is set, the client drops messages without
   * parsing them when they arrive sooner than `1000 / maxFrequency` ms
   * after the previous delivery to this callback. Throttle state is
   * per-callback, so multiple subscribers to the same topic with different
   * rates are isolated.
   */
  subscribe(
    topic: string,
    onMessage: (msg: RosMessage) => void,
    options?: SubscribeOptions,
  ): () => void;

  publish(
    topic: string,
    schemaName: string,
    data: Record<string, unknown>,
    options?: PublishOptions,
  ): void;

  /**
   * Declare intent to publish on `topic` ahead of the first data message,
   * so a subsequent `publish` to that topic sends synchronously instead of
   * paying the advertise-then-setTimeout delay. Safety-critical paths
   * (E-Stop, action cancel goals on AppState background) need the first
   * publish on a rarely-used channel to land before the socket tears down.
   * No-op if already advertised.
   */
  ensureAdvertised(topic: string, schemaName: string): void;

  /**
   * Unadvertise a topic the client previously published to. Tells the
   * bridge to tear down its ROS publisher.
   */
  unadvertise(topic: string): void;

  /**
   * Publish a zero-velocity `geometry_msgs/msg/Twist` on `/cmd_vel`. Used by
   * dead-man's-switch paths (app background, disconnect, E-Stop) to halt
   * robot motion. No-op if the client has never published a Twist on this
   * connection.
   */
  publishZeroTwist(): void;

  // ── Circuit breaker (per-topic) ─────────────────────────────────────────

  /**
   * Current breaker state for `topic`. Returns `'closed'` when no
   * subscription exists, so consumers don't need to null-check.
   */
  getBreakerState(topic: string): CircuitBreakerState;

  /**
   * `Date.now()` when the next auto-retry will fire for `topic`, or `null`
   * when the breaker is not in `tripped_auto`. Used by UIs to render a
   * countdown.
   */
  getBreakerNextRetryAt(topic: string): number | null;

  /**
   * Snapshot of the adaptive-throttle state for `topic`, or `null` when no
   * subscription exists. Used to render "currently capped at X Hz" badges.
   */
  getSubscriptionStats(topic: string): SubscriptionStats | null;

  /**
   * Manual retry from any tripped state. Resumes the subscription via
   * `half_open`. No-op if the breaker is already closed or no subscription
   * exists.
   */
  breakerRetry(topic: string): void;

  /**
   * Cancel auto-retry for a subscription whose breaker is in `tripped_auto`,
   * transitioning to `tripped_manual`. No-op otherwise.
   */
  breakerDisable(topic: string): void;

  /**
   * Subscribe to breaker-state-change notifications for a topic. The
   * callback fires on every transition. Returns an unsubscribe function.
   */
  onBreakerStateChange(
    topic: string,
    cb: (state: CircuitBreakerState) => void,
  ): () => void;

  // ── Services ────────────────────────────────────────────────────────────

  callService(
    service: string,
    request: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /**
   * Snapshot of services currently advertised by the robot. Returns an
   * empty list when discovery has not completed (e.g. immediately after
   * connect on rosbridge, before the first `/rosapi/services` poll).
   */
  getAvailableServices(): ServiceInfo[];

  /**
   * Subscribe to service-list changes. Fires immediately with the current
   * list and again on every update. Returns an unsubscribe function.
   */
  onServicesChange(cb: (services: ServiceInfo[]) => void): () => void;

  // ── Schemas ─────────────────────────────────────────────────────────────

  /**
   * Returns a default JSON template for a message schema, with every field
   * set to its zero / empty default. Returns `null` if the schema is
   * unknown or the protocol does not carry it (rosbridge does not embed
   * schemas in its wire format; Foxglove WS does).
   */
  getSchemaTemplate(schemaName: string): Record<string, unknown> | null;

  // ── Reconnection info ───────────────────────────────────────────────────

  /** Current reconnection attempt. `0` when not reconnecting. */
  readonly reconnectAttempt: number;
  /** Maximum reconnect attempts before the client gives up. */
  readonly maxReconnectAttempts: number;

  // ── Events ──────────────────────────────────────────────────────────────

  onStatusChange(cb: (status: ConnectionStatus) => void): () => void;
  onTopicsChange(cb: (topics: TopicInfo[]) => void): () => void;
  onLog(cb: (log: string) => void): () => void;
}
