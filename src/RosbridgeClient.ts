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
 * - Subscribe with a wire policy derived from the subscription's own options:
 *   a `maxFrequency` cap becomes `throttle_rate` plus a one-deep latest-wins
 *   queue, and an uncapped subscription carries the server's own baseline.
 *   Consumers sharing a topic pool to the loosest policy among them.
 * - Publish with auto-advertise on first send.
 * - Service calls with a 30 s timeout.
 * - Zero-Twist on *intentional* disconnect only (socket still open); network
 *   loss / app kill / crash cannot send and require a robot-side `cmd_vel`
 *   watchdog.
 * - Exponential backoff reconnection (1 s → 2 s → 4 s → 8 s → 16 s, max 5
 *   attempts) after a connection that previously succeeded; subscriptions are
 *   NOT re-established after an automatic reconnect — the consumer resubscribes.
 * - `tryDropPublishBeforeParse` fast-path: bounded substring scan extracts
 *   `op` and `topic` from a `publish` envelope so we can drop messages no
 *   callback wants without paying `JSON.parse` cost on the full payload.
 *   Matters for high-bandwidth topics where parse dominates per-message
 *   work.
 */

import {
  type ActionGoalHandle,
  type ActionGoalOutcome,
  type BucketDef,
  type CallServiceOptions,
  type CircuitBreakerState,
  type ConnectOptions,
  type ConnectionStatus,
  type IProtocolClient,
  type ProtocolClientOptions,
  type ProtocolLogger,
  type PublishOptions,
  type RosMessage,
  type SendActionGoalOptions,
  type ServiceInfo,
  type SubscribeOptions,
  type SubscriptionState,
  type ThrottleMode,
  type TopicInfo,
} from './types';
import { CircuitBreaker, DEFAULT_BREAKER_CONFIG } from './CircuitBreaker';
import {
  ActionGoalError,
  connectAbortReason,
  ProtocolMismatchError,
  validateCallServiceTimeoutMs,
} from './errors';
import { getMaxLagMs, setModeGetter } from './EventLoopMonitor';
import { matchesSchema } from './schemaName';
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
const SERVICE_CALL_TIMEOUT_MS = 30_000;

/**
 * How long to let the server work through what was just written before the
 * socket is closed on an intentional `disconnect()`.
 *
 * `rosbridge_server` discards ops it has received but not yet processed when
 * the connection goes away. The teardown drain (`flushControlOutbox('all')`,
 * carrying the release-the-joystick zero Twist) is written in the same tick as
 * the close, so any slow op the consumer queued in front of it -- an
 * `unsubscribe` is the measured case -- is enough to leave the drain
 * unprocessed at close time. The last instruction the robot then holds is
 * "keep moving".
 *
 * Measured 2026-08-11 against a stock bridge with no client library in the
 * path: drain-then-close loses the zero 3/3, the same shape with 20 ms of
 * settle keeps it 3/3, and 200 ms is no better than 20. The value is the
 * measurement, not a guess, and it is deliberately not configurable: a
 * consumer cannot know the server's processing latency any better than this.
 *
 * Not applied to the Foxglove path, where the same teardown row passed on the
 * rig that failed here.
 */
const TEARDOWN_SETTLE_MS = 20;

/**
 * The delivery policy a rosbridge `subscribe` frame asks the server to apply,
 * before anything reaches this client.
 *
 * `throttleRateMs` is the minimum interval between sends; `queueLength` is the
 * depth of the server's per-subscription buffer. `{0, 0}` is the server's own
 * resting default: unthrottled, unbuffered, deliver everything.
 */
interface WireSubscribePolicy {
  throttleRateMs: number;
  queueLength: number;
}

/** The server's resting default: gate nothing, buffer nothing (ADR 0008). */
const OPEN_WIRE_POLICY: WireSubscribePolicy = { throttleRateMs: 0, queueLength: 0 };

/**
 * Derive one consumer's wire policy from the cap it asked for (ADR 0008).
 *
 * A capped subscription asks the server to gate at the same rate the client
 * would gate at anyway, with a one-deep latest-wins queue, so the cap costs
 * radio bandwidth rather than only JS-thread time. An uncapped subscription
 * carries the server's baseline: a consumer who declined a cap gets the rate
 * it declined to bound.
 *
 * Every published version through 0.1.10 hardcoded `100/1` here, which bounded
 * every rosbridge subscription near 10 Hz no matter what `maxFrequency` said,
 * and made `{ maxFrequency: 0, disableAdaptive: true }` -- the documented
 * spelling of "deliver every message, gate nothing" -- untrue on the wire.
 *
 * @param userMinIntervalMs The consumer's cap as a minimum interval, or
 *   `undefined` when it set no cap.
 */
function deriveWirePolicy(userMinIntervalMs: number | undefined): WireSubscribePolicy {
  if (userMinIntervalMs === undefined) return OPEN_WIRE_POLICY;
  return { throttleRateMs: Math.floor(userMinIntervalMs), queueLength: 1 };
}

/**
 * Merge every live consumer's derived policy into the one policy the shared
 * wire subscription carries: the componentwise minimum, so the loosest
 * consumer wins (ADR 0008).
 *
 * One wire subscription serves every callback on a topic, so a policy strict
 * enough for one consumer would silently gate the others. Taking the minimum
 * implements client-side the same pooling rule rosbridge documents for
 * multiple same-connection subscriptions to one topic. An empty callback set
 * cannot happen on a live subscription (the last removal tears it down), and
 * resolves to the baseline rather than to `Infinity`.
 */
function mergeWirePolicy(
  callbacks: Map<(msg: RosMessage) => void, RosbridgeCallbackEntry>,
): WireSubscribePolicy {
  let throttleRateMs = Infinity;
  let queueLength = Infinity;
  for (const entry of callbacks.values()) {
    const policy = deriveWirePolicy(entry.userMinIntervalMs);
    throttleRateMs = Math.min(throttleRateMs, policy.throttleRateMs);
    queueLength = Math.min(queueLength, policy.queueLength);
  }
  if (!Number.isFinite(throttleRateMs)) return OPEN_WIRE_POLICY;
  return { throttleRateMs, queueLength };
}

/** True when two wire policies would put the same values on the wire. */
function sameWirePolicy(a: WireSubscribePolicy, b: WireSubscribePolicy): boolean {
  return a.throttleRateMs === b.throttleRateMs && a.queueLength === b.queueLength;
}

/**
 * How much later than a caller's wire `timeout` the local backstop fires. A
 * bridge that reaches its own deadline replies with a reasoned failure frame,
 * measured landing 20-40 ms late on loopback and arbitrarily later over a
 * real link; a local timer racing the same deadline would win and eat that
 * reason. The backstop exists only for the frame that never comes at all
 * (`services_glob` drops the call before name resolution, answering nothing).
 */
const SERVICE_CALL_BACKSTOP_MARGIN_MS = 1_000;

/**
 * On (re)connect, the first `/rosapi/topics` can come back empty if the host
 * has not re-attached the robot yet (e.g. a relay or sim that drops the host
 * and re-attaches a different robot). Rather than stick an empty list, retry a
 * bounded number of times with a short delay before accepting an empty result.
 */
const TOPICS_REDISCOVERY_ATTEMPTS = 5;
const TOPICS_REDISCOVERY_RETRY_MS = 600;

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
  // `schemaName` is captured at stash time rather than read at drain time: it
  // describes the topic as typed when the bytes arrived, and discovery can
  // re-type a topic (the 0.1.7 self-heal re-subscribes with a corrected type)
  // while the drain is armed. Trailing delivery makes that window as long as
  // the throttle interval. Foxglove has the same rule, with encoding too.
  pending: { raw: string; receivedAt: number; schemaName: string } | null;
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
      // The merged policy currently on the wire for this topic: the loosest
      // among every live callback's own derivation. Stored rather than
      // recomputed at send time so a change can be detected, and so every
      // re-send path carries the same values.
      wirePolicy: WireSubscribePolicy;
      // Establishment at the bridge is not yet confirmable: the subscribe
      // frame went out typeless, and a rejected subscribe is invisible (rosout
      // ERROR server-side, no `status` op). Cleared when a typed subscribe is
      // sent (type known at creation, hinted, or adopted by the self-heal) or
      // when delivery is observed on the typeless frame.
      pending: boolean;
    }
  >();
  private breakerListeners = new Map<string, Set<(state: CircuitBreakerState) => void>>();

  private advertisedTopics = new Set<string>();
  private hasPublishedTwist = false;

  private static readonly CONTROL_FLUSH_BATCH = 3;
  private controlOutbox: Array<{ op: 'publish'; topic: string; msg: Record<string, unknown> }> = [];
  private controlFlushScheduled = false;

  private discoveredTopics: TopicInfo[] = [];
  private topicsRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastError: Error | null = null;

  private pendingServiceCalls = new Map<
    string,
    {
      resolve: (result: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private serviceCallCounter = 0;

  // In-flight goal dispatches, keyed by the client-invented op `id` — the
  // only correlation mechanism the wire provides (`action_result` and
  // `action_feedback` carry no goal UUID). Connection-scoped by nature: the
  // per-connection handler server-side owns the goal, so these are rejected
  // as 'disconnected' when the connection ends.
  private pendingActionGoals = new Map<
    string,
    {
      action: string;
      resolve: (outcome: ActionGoalOutcome) => void;
      reject: (error: Error) => void;
      onFeedback: ((feedback: Record<string, unknown>) => void) | undefined;
    }
  >();
  private actionGoalCounter = 0;

  private latencyProbeTimer: ReturnType<typeof setInterval> | null = null;

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalDisconnect = false;
  // Connect-attempt settle functions, held in fields (not only handler
  // closures) so a cancellation can settle the pending attempt from outside
  // the socket callbacks. `pendingConnect` is the promise the current
  // initial connect() caller holds, kept so a library-initiated cancellation
  // can pre-handle it before rejecting (ADR 0003; mirrors FoxgloveClient).
  private connectResolve: (() => void) | null = null;
  private connectReject: ((e: Error) => void) | null = null;
  private pendingConnect: Promise<void> | null = null;

  get isConnected(): boolean {
    return this.status === 'connected';
  }

  getLastError(): Error | null {
    return this.lastError;
  }

  get reconnectAttempt(): number {
    return this.reconnectAttempts;
  }

  get maxReconnectAttempts(): number {
    return MAX_RECONNECT_ATTEMPTS;
  }

  // Deliberately not `async`: the caller must receive the exact promise
  // object the library holds in `pendingConnect`, so cancellation can
  // pre-handle it. An async wrapper would be a different promise.
  connect(url: string, options?: ConnectOptions): Promise<void> {
    if (this.status === 'connecting' || this.status === 'connected') {
      return Promise.resolve();
    }

    const signal = options?.signal;
    if (signal?.aborted) {
      const rejected = Promise.reject(connectAbortReason(signal));
      rejected.catch(() => {}); // pre-handled cancellation (ADR 0003)
      return rejected;
    }

    this.url = url.trim();
    this.intentionalDisconnect = false;
    this.reconnectAttempts = 0;
    this.lastError = null;

    this.log(`Connecting to rosbridge at ${this.url}...`);
    let attempt = this.performConnect();
    if (signal) {
      const onAbort = (): void => {
        this.abortPendingConnect(connectAbortReason(signal));
      };
      signal.addEventListener('abort', onAbort);
      // Remove the listener as soon as the attempt settles either way, so a
      // long-lived signal neither accumulates listeners across attempts nor
      // can touch the established connection (the signal governs the
      // attempt, not the connection).
      attempt = attempt.finally(() => {
        signal.removeEventListener('abort', onAbort);
      });
    }
    this.pendingConnect = attempt;
    return attempt;
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;

    // A disconnect() while a connect attempt is in flight is a cancellation
    // of that attempt: settle the caller's promise instead of orphaning it
    // (pre-ADR-0003 behavior left it pending forever). No-op when nothing
    // is pending.
    this.abortPendingConnect(
      connectAbortReason(undefined, 'Connection attempt cancelled by disconnect()'),
    );

    this.safePublishZeroTwist();

    // Drain pending control-priority publishes BEFORE closing the socket,
    // uncapped: anything a batched drain left behind dies with the socket
    // when the re-armed flush finds it closed, which is the same silent
    // drop one tick later.
    const drained = this.flushControlOutbox('all');

    // Writing the drain is not the same as the robot receiving it. Give the
    // server time to work through what is queued before the close takes the
    // connection away; see TEARDOWN_SETTLE_MS for the measurement.
    if (drained > 0) await this.settleBeforeClose();

    this.cleanup();
    this.setStatus('disconnected');
  }

  /**
   * Wait out {@link TEARDOWN_SETTLE_MS} before an intentional teardown closes
   * the socket, so the drain that was just written is processed rather than
   * discarded.
   *
   * Scoped to `disconnect()`, and within it to a teardown that actually wrote
   * something. Every other path into `cleanup()` is either a socket that is
   * already gone (an involuntary close, an error) or an attempt that never
   * drained anything (an abort), and delaying those would only slow a
   * reconnect down. A session that published no control-priority message has
   * nothing at risk either, and disconnects as immediately as it always did.
   *
   * Messages arriving during the settle are still delivered: the subscriptions
   * are torn down by `cleanupConnection()` after the wait, not before, so the
   * window behaves like any other moment on a live connection rather than
   * introducing a half-closed state.
   */
  private settleBeforeClose(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, TEARDOWN_SETTLE_MS));
  }

  /**
   * Settle the in-flight connect attempt as cancelled: close the socket,
   * clear all attempt state, and reject the caller's promise with `reason`.
   * No-op when no attempt is pending. An abort is not an error: `lastError`
   * stays untouched, status lands on 'disconnected', and no reconnect is
   * scheduled.
   */
  private abortPendingConnect(reason: unknown): void {
    const reject = this.connectReject;
    if (!reject) return;
    this.connectResolve = null;
    this.connectReject = null;
    this.pendingConnect?.catch(() => {}); // pre-handled cancellation (ADR 0003)
    this.pendingConnect = null;
    this.cleanup();
    this.setStatus('disconnected');
    reject(reason as Error);
  }

  async getAvailableTopics(): Promise<TopicInfo[]> {
    if (!this.ws || !this.isConnected) {
      return this.discoveredTopics;
    }

    try {
      const result = await this.callService('/rosapi/topics', {});
      this.setTopicsIfChanged(this.topicsResultToInfos(result));
      return this.discoveredTopics;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`Failed to get topics via rosapi: ${msg}`);
      return this.discoveredTopics;
    }
  }

  /** Map a `/rosapi/topics` service result into the discovered-topic shape. */
  private topicsResultToInfos(result: Record<string, unknown>): TopicInfo[] {
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
    return topics;
  }

  /**
   * Replace the discovered-topic set and fire `onTopicsChange` only when the
   * set actually changed (by topic name + type), mirroring the services-poll
   * diff. Keeps reconnect / mid-session re-discovery quiet when nothing moved.
   */
  private setTopicsIfChanged(next: TopicInfo[]): void {
    const key = (list: TopicInfo[]): string =>
      list
        .map((t) => `${t.topic}::${t.schemaName}`)
        .sort()
        .join('|');
    if (key(this.discoveredTopics) === key(next)) return;
    this.discoveredTopics = next;
    this.log(`Discovered ${next.length} topics.`);
    // Repair before notifying, so a listener that inspects or subscribes from
    // its `onTopicsChange` handler observes an already-consistent client.
    this.resubscribeNewlyTypedTopics();
    this.notifyTopicsChanged();
  }

  /**
   * Re-issue the subscribe frame for any subscription whose recorded message
   * type disagrees with what topic discovery now reports — because it was
   * unknown when the subscription was created, or because a consumer-supplied
   * `SubscribeOptions.schemaName` turns out wrong. Discovery always wins.
   *
   * `subscribe()` resolves the type once, from `discoveredTopics` (or the
   * consumer's hint) as it stands at the moment of the call, and stores it as
   * the subscription's `schemaName`. A topic with no publisher yet is absent
   * from that set, so an unhinted subscription is recorded with an empty
   * `schemaName` and its frame goes out without a `type` (see
   * `buildSubscribeFrame`). A stock `rosbridge_server` cannot infer the type
   * of a topic nothing advertises: it logs a rosout ERROR and never
   * establishes the subscription, which then stays dead for the life of the
   * connection. Nothing else revisits it, and a consumer cannot repair it
   * either, since a second `subscribe()` for the same topic only appends a
   * callback to the dead entry.
   *
   * So the moment discovery learns (or corrects) the type, adopt it and
   * re-subscribe. The repair has two shapes, matching how the server treats
   * type conflicts (each wire-verified against a stock bridge):
   *
   * - **Recorded type empty:** a bare typed re-subscribe. The server keys a
   *   subscription by client and topic and updates it in place when the types
   *   don't conflict; no preceding `unsubscribe`, so a typeless-but-flowing
   *   subscription (live publisher, server resolved the type itself) never
   *   loses delivery to the repair.
   * - **Recorded type differs from discovered:** `unsubscribe`, then the
   *   typed re-subscribe. The server rejects any subscribe whose type
   *   conflicts with the topic's established type — where "established" is
   *   the live graph's type or the server's own wrong-typed registration —
   *   silently (rosout ERROR, no `status` op), so a bare corrective frame
   *   would bounce off a wrong-typed registration. Only `unsubscribe` clears
   *   it, and the `unsubscribe` is accepted and harmless in the states where
   *   the wrong-typed subscribe itself was rejected and registered nothing.
   *
   * "Differs" is judged kind-agnostically (`matchesSchema`): the 2-part ROS 1
   * spelling is an accepted alias on the wire, so `std_msgs/String` recorded
   * against `std_msgs/msg/String` discovered is a healthy subscription, not a
   * wrong one — the canonical discovered spelling is adopted silently and no
   * frame is sent.
   *
   * Three properties hold:
   *
   * - **One-shot per divergence.** Adopting the discovered `schemaName` is
   *   what makes the subscription ineligible on the next pass, so a topic is
   *   re-subscribed at most once per discovered type, no matter how often the
   *   topic set changes afterwards.
   * - **Healthy subscriptions are never re-sent.** A subscription whose
   *   recorded type matches discovery is skipped, so no duplicate frame is
   *   emitted for it.
   * - **A paused subscription stays off the wire.** Its type is still
   *   adopted, because the breaker replays
   *   `buildSubscribeFrame(topic, sub.schemaName)` when it reopens, and that
   *   replay must carry the real type. But sending here would undo the
   *   `unsubscribe` the breaker just issued to shed load.
   */
  private resubscribeNewlyTypedTopics(): void {
    for (const [topic, sub] of this.activeSubscriptions) {
      const discovered = this.discoveredTopics.find(
        (t) => t.topic === topic,
      )?.schemaName;
      if (!discovered) continue;

      if (sub.schemaName && matchesSchema(sub.schemaName, discovered)) {
        // Same type; adopt the canonical discovered spelling for delivered
        // messages and the breaker's half-open replay. Nothing to send.
        sub.schemaName = discovered;
        continue;
      }

      const recordedDiffers = sub.schemaName !== '';
      sub.schemaName = discovered;
      // A typed subscribe confirms establishment (a paused subscription's
      // breaker replays the typed frame when it reopens, same confirmation).
      sub.pending = false;
      if (sub.isPaused) continue;

      if (recordedDiffers) this.send({ op: 'unsubscribe', topic });
      this.send(this.buildSubscribeFrame(topic, discovered));
      this.log(`Re-subscribed to "${topic}" with discovered type ${discovered}`);
    }
  }

  /**
   * Re-discover topics on (re)connect. The first result after a reconnect can
   * come back empty if the host has not re-attached the robot yet (e.g. a relay
   * or sim that drops the host and re-attaches a different robot); retry a
   * bounded number of times before accepting an empty set, so a transient race
   * doesn't wipe a known topic list. Mid-session re-discovery is handled
   * separately by the latency probe reusing its `/rosapi/topics` call.
   */
  private rediscoverTopics(attemptsLeft: number): void {
    if (!this.ws || !this.isConnected) return;
    this.callService('/rosapi/topics', {})
      .then((result) => {
        if (!this.isConnected) return;
        const next = this.topicsResultToInfos(result);
        if (next.length === 0 && attemptsLeft > 0) {
          this.scheduleTopicsRetry(attemptsLeft);
          return;
        }
        this.setTopicsIfChanged(next);
      })
      .catch(() => {
        if (this.isConnected && attemptsLeft > 0) this.scheduleTopicsRetry(attemptsLeft);
      });
  }

  private scheduleTopicsRetry(attemptsLeft: number): void {
    if (this.topicsRetryTimer) return;
    this.topicsRetryTimer = setTimeout(() => {
      this.topicsRetryTimer = null;
      this.rediscoverTopics(attemptsLeft - 1);
    }, TOPICS_REDISCOVERY_RETRY_MS);
  }

  private stopTopicsRetry(): void {
    if (this.topicsRetryTimer) {
      clearTimeout(this.topicsRetryTimer);
      this.topicsRetryTimer = null;
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
      this.logger.warn(
        `[RosbridgeClient] subscribe("${topic}") ignored: client is not connected.`,
      );
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
      // A joining consumer can only loosen the shared policy, and it has to
      // reach the wire: the topic's existing subscription was established
      // under whatever the previous consumers asked for.
      this.syncWirePolicy(topic);
      return () => {
        const entry = existing.callbacks.get(onMessage);
        if (entry) this.cancelDrain(entry);
        existing.callbacks.delete(onMessage);
        if (existing.callbacks.size === 0) {
          this.unsubscribeTopic(topic);
        } else {
          this.syncWirePolicy(topic);
        }
      };
    }

    // Discovery wins over the consumer's hint; the hint is trusted only while
    // discovery is silent. A hint that turns out wrong is converged by the
    // discovery self-heal (see resubscribeNewlyTypedTopics).
    const topicInfo = this.discoveredTopics.find((t) => t.topic === topic);
    const messageType = topicInfo?.schemaName ?? options?.schemaName ?? '';

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
            this.send(this.buildSubscribeFrame(topic, sub.schemaName));
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
      wirePolicy: mergeWirePolicy(callbacks),
      pending: !messageType,
    });

    this.send(this.buildSubscribeFrame(topic, messageType));

    return () => {
      const entry = callbacks.get(onMessage);
      if (entry) this.cancelDrain(entry);
      callbacks.delete(onMessage);
      if (callbacks.size === 0) {
        this.unsubscribeTopic(topic);
      } else {
        this.syncWirePolicy(topic);
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

  /**
   * Drain the control-priority outbox to the socket. Mirrors the
   * FoxgloveClient flush.
   *
   * `'batch'`, the live path, sends at most `CONTROL_FLUSH_BATCH` entries
   * per tick and re-arms for the rest, so a saturated JS thread never
   * spends an unbounded slice here.
   *
   * `'all'` ignores the cap and is for teardown only. There is no next
   * tick to re-arm into: the socket closes as soon as the caller returns,
   * so a re-armed flush finds it shut and clears the remainder unsent —
   * silently dropping every E-Stop publish past the cap. Bounded by
   * construction: the outbox conflates per destination, so its length is
   * the number of distinct control-priority topics, not a burst.
   *
   * @returns How many entries reached the socket, which the teardown path
   *   reads to decide whether there is anything worth settling for.
   */
  private flushControlOutbox(mode: 'batch' | 'all' = 'batch'): number {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.controlOutbox.length = 0;
      return 0;
    }
    const budget = mode === 'all' ? Infinity : RosbridgeClient.CONTROL_FLUSH_BATCH;
    let drained = 0;
    while (this.controlOutbox.length > 0 && drained < budget) {
      const entry = this.controlOutbox.shift();
      if (!entry) break;
      this.send(entry);
      drained++;
    }
    if (this.controlOutbox.length > 0) {
      this.scheduleControlFlush();
    }
    return drained;
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

  // Deliberately not `async`: an invalid `timeoutMs` is a programmer error
  // and throws synchronously (the value must never reach the wire), while
  // runtime failures — not connected, timeout, server failure — stay promise
  // rejections, exactly as before.
  callService(
    service: string,
    request: Record<string, unknown>,
    options?: CallServiceOptions,
  ): Promise<Record<string, unknown>> {
    const timeoutMs = options?.timeoutMs;
    validateCallServiceTimeoutMs(timeoutMs);

    if (!this.ws || this.status !== 'connected') {
      return Promise.reject(new Error('Not connected'));
    }

    const id = `service_call:${service}:${++this.serviceCallCounter}`;

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const armMs =
        timeoutMs !== undefined
          ? timeoutMs + SERVICE_CALL_BACKSTOP_MARGIN_MS
          : SERVICE_CALL_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pendingServiceCalls.delete(id);
        reject(
          timeoutMs !== undefined
            ? new Error(
                `Service call "${service}" got no response frame within ${armMs}ms ` +
                  `(${timeoutMs}ms wire timeout + ${SERVICE_CALL_BACKSTOP_MARGIN_MS}ms backstop margin). ` +
                  `A bridge that reaches its own timeout replies with a failure frame; ` +
                  `total silence usually means a restrictive services_glob dropped the call.`,
              )
            : new Error(`Service call "${service}" timed out after ${SERVICE_CALL_TIMEOUT_MS}ms`),
        );
      }, armMs);

      this.pendingServiceCalls.set(id, { resolve, reject, timer });

      const frame: Record<string, unknown> = {
        op: 'call_service',
        id,
        service,
        args: request,
      };
      // The protocol's `timeout` is seconds (float). Forwarded only when the
      // caller asked: an omitted option must preserve the wire frame exactly.
      if (timeoutMs !== undefined) frame.timeout = timeoutMs / 1000;
      this.send(frame);
    });
  }

  sendActionGoal(
    action: string,
    actionType: string,
    goal: Record<string, unknown>,
    options?: SendActionGoalOptions,
  ): ActionGoalHandle {
    if (!this.ws || this.status !== 'connected') {
      throw new Error('Not connected');
    }

    const id = `action_goal:${action}:${++this.actionGoalCounter}`;
    const onFeedback = options?.onFeedback;

    const outcome = new Promise<ActionGoalOutcome>((resolve, reject) => {
      this.pendingActionGoals.set(id, { action, resolve, reject, onFeedback });
    });

    const frame: Record<string, unknown> = {
      op: 'send_action_goal',
      id,
      action,
      action_type: actionType,
      args: goal,
    };
    // The wire flag is sent only when a callback is supplied; without it the
    // bridge is never asked to relay feedback frames.
    if (onFeedback) frame.feedback = true;
    this.send(frame);

    return {
      outcome,
      // `cancel_action_goal` is connection-scoped: the server resolves the id
      // against this connection's own dispatches, so it is exact for our goal
      // and a server-side no-op if the goal never started. Once the terminal
      // frame settled the dispatch (entry deleted), there is nothing left to
      // cancel and no frame is sent.
      cancel: () => {
        if (!this.pendingActionGoals.has(id)) return;
        this.send({ op: 'cancel_action_goal', id, action });
      },
    };
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
      this.connectResolve = resolve;
      this.connectReject = reject;
      // Settle through the fields (null-after-use) so a cancellation that
      // already settled the attempt makes these late socket callbacks no-ops.
      const settleResolve = (): void => {
        if (!this.connectResolve) return;
        const r = this.connectResolve;
        this.connectResolve = null;
        this.connectReject = null;
        r();
      };
      const settleReject = (err: Error): void => {
        if (!this.connectReject) return;
        const r = this.connectReject;
        this.connectResolve = null;
        this.connectReject = null;
        r(err);
      };

      try {
        this.ws = new WebSocket(this.url);

        this.connectionTimeoutTimer = setTimeout(() => {
          this.log(`Connection timeout after ${CONNECTION_TIMEOUT_MS}ms`);
          const reconnecting = this.reconnectAttempts > 0;
          settleReject(new Error(`Connection timeout after ${CONNECTION_TIMEOUT_MS}ms`));
          this.cleanup();
          this.setStatus('error');
          // Only auto-reconnect mid-cycle; a failed initial connect rejects the
          // caller and stops, leaving first-connect retry to the consumer.
          if (reconnecting) this.scheduleReconnect();
        }, CONNECTION_TIMEOUT_MS);

        this.ws.onopen = () => {
          this.clearConnectionTimeout();
          this.reconnectAttempts = 0;
          this.log('Connected to rosbridge server.');
          this.setStatus('connected');
          this.startLatencyProbe();
          this.startServicesPoll();
          // Re-discover topics immediately so a reconnect to a host now serving
          // a different robot reflects the new set without waiting for the first
          // latency-probe tick; bounded retry covers the empty-first-result race.
          this.rediscoverTopics(TOPICS_REDISCOVERY_ATTEMPTS);
          settleResolve();
        };

        this.ws.onerror = (event: Event) => {
          const detail =
            (event as Event & { message?: string }).message ?? 'Connection error';
          this.log(`Rosbridge error: ${detail}`);
          this.logger.error('[RosbridgeClient] Error:', event);

          if (this.status === 'connecting') {
            const reconnecting = this.reconnectAttempts > 0;
            this.clearConnectionTimeout();
            settleReject(new Error(`Rosbridge error: ${detail}`));
            this.cleanup();
            this.setStatus('error');
            // Only auto-reconnect mid-cycle; a failed initial connect rejects
            // the caller and stops, leaving first-connect retry to the consumer.
            if (reconnecting) this.scheduleReconnect();
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
        settleReject(error);
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
        case 'action_result':
          this.handleActionResult(msg);
          break;
        case 'action_feedback':
          this.handleActionFeedback(msg);
          break;
        case 'status': {
          const level = msg.level as string | undefined;
          const statusMsg = msg.msg as string | undefined;
          if (level === 'error' || level === 'warning') {
            this.log(`rosbridge ${level}: ${statusMsg ?? 'unknown'}`);
          }
          break;
        }
        default:
          this.handleUnknownOp(op, msg);
      }
    } catch (err) {
      this.logger.error('[RosbridgeClient] Failed to parse message:', err);
    }
  }

  /**
   * Handle an op the rosbridge protocol does not define. The rosbridge client
   * resolves connect at socket-open with no handshake to validate, so a
   * wrong-protocol endpoint (a Foxglove WebSocket server) is only detectable
   * from the frames it sends. A Foxglove server sends an unsolicited
   * `serverInfo` on connect and `advertise` frames carrying a `channels` array;
   * a real rosbridge server sends neither, so either is precise proof of a
   * protocol mismatch. Other unknown ops are ignored (forward-compatible).
   */
  private handleUnknownOp(op: string, msg: Record<string, unknown>): void {
    const looksFoxglove = op === 'serverInfo' || (op === 'advertise' && Array.isArray(msg.channels));
    if (looksFoxglove) this.raiseProtocolMismatch();
  }

  /**
   * Surface a detected protocol mismatch (a Foxglove server on the rosbridge
   * client). This is a post-connect transition — `connect()` already resolved
   * at socket-open — so the error reaches the consumer via `getLastError()` on
   * the `status === 'error'` edge rather than a connect rejection. Tear the
   * connection down and suppress auto-reconnect, which would only re-trigger
   * the same mismatch.
   */
  private raiseProtocolMismatch(): void {
    if (this.status === 'error') return; // already raised; ignore further frames
    this.intentionalDisconnect = true;

    // Emit the terminal 'error' status with two guarantees, because rc.1's
    // "emit before cleanup" reorder did NOT fix RMB-45 on device (the consumer
    // still never received 'error'):
    //   1. Nothing that can throw runs before the emit — the ProtocolMismatchError
    //      is constructed defensively (a bundling/RN quirk that made `new
    //      ProtocolMismatchError` throw would otherwise be swallowed by
    //      handleMessage's try/catch, before setStatus ran).
    //   2. A microtask backstop re-runs the emit on a clean stack, so any
    //      synchronous throw in the teardown below (which handleMessage's
    //      try/catch would swallow) can never bypass the one event the consumer
    //      needs. The emit is idempotent (guards on status === 'error').
    this.emitProtocolMismatchError();
    void Promise.resolve().then(() => this.emitProtocolMismatchError());

    try {
      this.cleanup();
    } catch {
      // cleanup is best-effort; the terminal error was already emitted above.
    }
  }

  /**
   * Emit the terminal protocol-mismatch error to the consumer. Idempotent:
   * once status is 'error' this is a no-op, so the synchronous call and the
   * microtask backstop in {@link raiseProtocolMismatch} deliver exactly one
   * emission. Sets `lastError` before `setStatus` so `getLastError()` is
   * readable from inside the `onStatusChange('error')` callback.
   */
  private emitProtocolMismatchError(): void {
    if (this.status === 'error') return;
    let err: Error;
    try {
      err = new ProtocolMismatchError('rosbridge', 'foxglove-ws');
    } catch {
      // Fall back to a plain Error so the terminal status is emitted even if
      // constructing the typed error ever fails in a bundled runtime. The
      // message matches the typed error's default.
      err = new Error(
        'This looks like a Foxglove WebSocket server, but the client is configured for ' +
          'rosbridge. Switch the protocol to Foxglove WebSocket.',
      );
    }
    this.lastError = err;
    this.setStatus('error');
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

    // Assumes rosbridge's conventional key order (op, topic, msg), so `"topic"`
    // appears in the envelope head before the payload. The 200-char bound keeps
    // the scan in that head. If a server reorders keys so `msg` precedes
    // `topic`, this either finds nothing in the head (-> full parse) or matches
    // a `"topic"` string inside the payload (-> a wrong/absent topic -> treated
    // as not-subscribed -> dropped). Both are safe fallbacks: this is a parse-
    // cost fast path, never the correctness path, so the misorder is benign.
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
    let topic = data.slice(i, topicEnd);
    if (topic.indexOf('\\') !== -1) {
      // A stock ROS 2 `rosbridge_server` serializes outbound frames with ujson,
      // which escapes '/' as '\/', so the sliced topic is e.g. "\/model\/pose".
      // Unescape via the authoritative JSON string parser so the key matches
      // `activeSubscriptions`; on any malformed escape, defer to the full parse
      // below. This must resolve the real topic HERE, not by deferring on the
      // sub-miss: a `latest-only` subscriber is served exclusively by this
      // path's deferred drain (`handlePublish` skips latest-only), so a bare
      // defer would still starve it.
      try {
        topic = JSON.parse(`"${topic}"`) as string;
      } catch {
        return false;
      }
    }

    const sub = this.activeSubscriptions.get(topic);
    if (!sub) return false; // topic not matched here → defer to the authoritative
    // JSON.parse rather than silently drop. The fast-path is a parse-cost
    // optimization, never the correctness path: it only drops (returns true)
    // on a certain positive match. Any extraction miss (an unexpected wire
    // shape, a decoy `topic` in the payload) falls through to the full parse,
    // where `handlePublish` re-reads the authoritative topic. Genuinely
    // unsubscribed frames are then dropped cheaply there; rosbridge only sends
    // topics we subscribed to, so the extra parse is near-zero frequency.

    // A frame that certainly matched this topic is observed delivery, and a
    // latest-only-only subscriber never reaches handlePublish, so the
    // pending → active promotion must happen here too.
    sub.pending = false;

    const now = Date.now();

    if (sub.isPaused) {
      recordBytes(sub.bandwidth, now, byteSize, mode);
      return true;
    }

    // Walk the callbacks. A `latest-only` subscriber conflates before parse:
    // stash the raw (unparsed) frame string — immutable, so copy-free — and
    // defer the JSON.parse to a drain that parses only the survivor. The stash
    // is unconditional: a frame arriving inside a closed window supersedes the
    // pending one instead of being discarded, because the mode promises the
    // newest frame reaches the callback and a burst that ends inside a closed
    // window has no later frame to restate it. The drain is armed for the
    // moment the window reopens, and `lastDeliveredAt` moves at delivery.
    //
    // `immediate` subscribers stay a leading-edge gate and fall through to the
    // normal parse + `handlePublish` path.
    let anyImmediateWantsThis = false;
    for (const [cb, entry] of sub.callbacks) {
      const interval = effectiveMinInterval(
        entry.userMinIntervalMs,
        entry.disableAdaptive,
        sub.bandwidth,
      );

      if (entry.dispatchMode === 'latest-only') {
        entry.pending = { raw: data, receivedAt: now, schemaName: sub.schemaName };
        if (entry.drainTimer === null) {
          entry.drainTimer = setTimeout(
            () => this.drainLatestOnly(topic, cb, entry),
            Math.max(0, interval - (now - entry.lastDeliveredAt)),
          );
        }
        continue;
      }

      if (interval <= 0 || now - entry.lastDeliveredAt >= interval) {
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
    // Delivery on a typeless subscription proves the bridge established it
    // (it resolved the type from a live publisher): promote pending → active.
    sub.pending = false;
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
    if (!pending) return;

    const sub = this.activeSubscriptions.get(topic);
    if (!sub || sub.isPaused) {
      entry.pending = null;
      return;
    }

    // Re-check the window before delivering. The adaptive interval can widen
    // between arming and firing, and a drain armed under the older, narrower
    // interval must not deliver early on the strength of a stale deadline.
    // Re-arm for the remainder instead; the pending frame is kept, so it is
    // deferred rather than lost.
    const nowMs = Date.now();
    const interval = effectiveMinInterval(
      entry.userMinIntervalMs,
      entry.disableAdaptive,
      sub.bandwidth,
    );
    const remaining = interval - (nowMs - entry.lastDeliveredAt);
    if (remaining > 0) {
      entry.drainTimer = setTimeout(() => this.drainLatestOnly(topic, cb, entry), remaining);
      return;
    }

    entry.pending = null;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(pending.raw) as Record<string, unknown>;
    } catch {
      return; // malformed frame; nothing to deliver, and no window consumed
    }

    entry.lastDeliveredAt = nowMs;

    const rosMsg: RosMessage = {
      topic,
      schemaName: pending.schemaName,
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

  /**
   * Deliver an `action_feedback` frame to the dispatching goal's callback.
   * Correlation is the dispatch `id` alone (the frame carries no goal UUID).
   * Frames for unknown ids — another client's goal relayed by a confused
   * bridge, or a frame racing past its own terminal `action_result` — are
   * dropped. A throwing callback is logged and never affects the goal or the
   * connection.
   */
  private handleActionFeedback(msg: Record<string, unknown>): void {
    const pending = this.pendingActionGoals.get(msg.id as string);
    if (!pending?.onFeedback) return;
    try {
      pending.onFeedback((msg.values ?? {}) as Record<string, unknown>);
    } catch (err) {
      this.logger.error('[RosbridgeClient] Action feedback callback error:', err);
    }
  }

  /**
   * Settle a goal dispatch from its terminal `action_result` frame. Exactly
   * one arrives per dispatch. `result` on the frame reports *op* success, not
   * goal success: a canceled or aborted goal arrives with `result: true` and
   * its `GoalStatus` in `status`, and resolves the outcome — the lifecycle
   * was observed to its end.
   */
  private handleActionResult(msg: Record<string, unknown>): void {
    const id = msg.id as string;
    const pending = this.pendingActionGoals.get(id);
    if (!pending) return;
    this.pendingActionGoals.delete(id);

    const opSucceeded = msg.result === true || msg.result === 'true';
    if (!opSucceeded) {
      // On failure frames `values` is a bare string from the server. The two
      // known strings (pinned in docs/PROTOCOLS.md, present on every
      // maintained rosbridge branch) are matched exactly; the text is the
      // only classification signal the wire carries. Anything else is
      // relayed verbatim as 'server-error'.
      const detail = typeof msg.values === 'string' ? msg.values : 'Action goal failed';
      const reason =
        detail === 'Action goal was rejected'
          ? 'rejected'
          : detail === 'No action server available'
            ? 'unavailable'
            : 'server-error';
      pending.reject(new ActionGoalError(reason, pending.action, detail));
      return;
    }

    pending.resolve({
      status: msg.status as number,
      result: (msg.values ?? {}) as Record<string, unknown>,
    });
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

  getSubscriptionState(topic: string): SubscriptionState {
    const sub = this.activeSubscriptions.get(topic);
    if (!sub) return 'none';
    return sub.pending ? 'pending' : 'active';
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
        resolve: (values) => {
          clearTimeout(timer);
          if (this.onLatency) {
            try {
              this.onLatency(Date.now() - start);
            } catch {
              // metrics must never affect protocol operation
            }
          }
          // Reuse the probe's `/rosapi/topics` payload for mid-session topic
          // re-discovery instead of running a second timer. Only apply a
          // non-empty result: an empty mid-session read is almost always a
          // transient (a connected ROS graph always has at least /rosout), and
          // the reconnect race is already covered by `rediscoverTopics`.
          try {
            const next = this.topicsResultToInfos(values);
            if (next.length > 0) this.setTopicsIfChanged(next);
          } catch {
            // topic re-discovery is best-effort; never break the latency probe
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
    this.stopTopicsRetry();
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

    // Dispatch correlation is connection-scoped: the per-connection handler
    // server-side owns the goal, so once this connection ends the terminal
    // outcome is permanently unobservable — while the robot may keep
    // executing. That asymmetry is exactly what the 'disconnected' reason
    // exists to signal; goal failure it is not.
    for (const [, pending] of this.pendingActionGoals) {
      pending.reject(
        new ActionGoalError(
          'disconnected',
          pending.action,
          'Connection closed before the goal reached a terminal state.',
        ),
      );
    }
    this.pendingActionGoals.clear();

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
      // 'error' alone keeps a no-op listener instead of null: the ws npm
      // package is an EventEmitter, close() during CONNECTING emits 'error',
      // and an unlistened EventEmitter 'error' crashes the host process.
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = () => {};
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

  /**
   * Build a rosbridge `subscribe` frame, omitting `type` when the message type
   * is not yet known. A topic subscribed before topic discovery has populated
   * `discoveredTopics` (a startup race) has an empty `schemaName`; sending
   * `type:""` makes a stock rosbridge_server run `get_message_class("")`, throw
   * InvalidTypeStringException, log a rosout ERROR, and silently drop the
   * subscription (zero delivery, no self-heal until reconnect). With `type`
   * absent, rosbridge resolves the type from the live publisher instead.
   *
   * The wire policy is read from the subscription rather than passed in, so
   * every path that re-sends a frame -- the discovery self-heal, the breaker's
   * half-open replay, a policy change -- carries the current merged values
   * without having to thread them through.
   */
  private buildSubscribeFrame(
    topic: string,
    schemaName: string,
  ): Record<string, unknown> {
    const policy = this.activeSubscriptions.get(topic)?.wirePolicy ?? OPEN_WIRE_POLICY;
    const frame: Record<string, unknown> = {
      op: 'subscribe',
      topic,
      throttle_rate: policy.throttleRateMs,
      queue_length: policy.queueLength,
    };
    if (schemaName) frame.type = schemaName;
    return frame;
  }

  /**
   * Recompute a topic's merged wire policy and re-subscribe in place when it
   * changed. Called whenever the topic's consumer set changes: a second
   * consumer joining can only loosen the policy, and the loosest consumer
   * leaving can only tighten it.
   *
   * The re-subscribe carries no preceding `unsubscribe`. rosbridge keys a
   * subscription by client and topic and updates it in place, so a bare frame
   * is enough, and an `unsubscribe` would open the server's teardown flush
   * race (a pending message dropped by `QueueMessageHandler.finish`) for no
   * gain. A paused subscription is left off the wire; the breaker's half-open
   * replay reads the stored policy when it re-subscribes.
   */
  private syncWirePolicy(topic: string): void {
    const sub = this.activeSubscriptions.get(topic);
    if (!sub) return;
    const next = mergeWirePolicy(sub.callbacks);
    if (sameWirePolicy(next, sub.wirePolicy)) return;
    sub.wirePolicy = next;
    if (sub.isPaused) return;
    this.send(this.buildSubscribeFrame(topic, sub.schemaName));
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
    // A consumer's logger must never break protocol operation. A throwing
    // logger here previously propagated out of hot paths (e.g. the connection
    // handshake and the inbound message handler), which is one way the terminal
    // protocol-mismatch status could be lost (RMB-45).
    try {
      this.logger.log(`[RosbridgeClient] ${formatted}`);
    } catch {
      // ignore
    }
    for (const cb of this.logListeners) {
      try {
        cb(formatted);
      } catch {
        // ignore; a log listener must not break protocol operation either
      }
    }
  }
}
