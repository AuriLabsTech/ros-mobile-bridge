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
 *
 * **Zero-copy contract on `Uint8Array` values (v0.1.2+).** When `data` is a
 * `Uint8Array`, it is a *view* into the inbound WebSocket frame's
 * ArrayBuffer, not a copy. The view's `byteOffset` is significant and the
 * underlying buffer is shared with the protocol client. Consumers that hand
 * `data` directly to native bindings which ignore `byteOffset` (some Skia
 * binding paths, some FFI calls) must first materialize an owned copy:
 *
 * ```ts
 * const owned = new Uint8Array(data); // copies if `data` is a view
 * skia.MakeImageFromEncoded(owned);
 * ```
 *
 * The exported `materializeBytes(view)` helper performs this copy and is the
 * recommended way to do it; `new Uint8Array(data)` is the equivalent inline
 * idiom. The helper always copies — it never returns the input view, even
 * when that view already spans its whole buffer — so the result is always
 * safe to retain.
 */
export interface RosMessage {
  topic: string;
  schemaName: string;
  encoding: 'json' | 'cdr';
  /**
   * The decoded message, or the raw payload when this client could not decode
   * it.
   *
   * Raw bytes mean one of three things: the server sent no usable description
   * of the type, the description it sent could not be parsed, or the
   * description said the type has no fields and the payload then carried data
   * that contradicts it. A message of a type that genuinely has no fields
   * decodes to `{}` and is not a raw payload, whatever its length on the wire.
   */
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
   *
   * `0` is the explicit spelling of "no user cap" and is exactly equivalent to
   * omitting the field. Both are supported and stable: use whichever reads
   * better at the call site, `0` being the natural choice when the value comes
   * from a variable or a settings store. Note that `0` disables only *this*
   * cap; the adaptive throttle still applies its own floor unless
   * {@link SubscribeOptions.disableAdaptive} is also set, so
   * `{ maxFrequency: 0, disableAdaptive: true }` is the supported way to say
   * "deliver every message, gate nothing".
   *
   * On rosbridge the cap also travels to the server, which stops the messages
   * you asked not to receive from crossing the network at all: a cap of `N`
   * asks the bridge to send at most one message every `1000 / N` ms, keeping
   * the newest when it has to choose. An uncapped subscription asks the bridge
   * for everything it has. When several subscriptions share one topic, the
   * loosest cap among them is what reaches the wire, so no subscription is
   * gated by another's choice. Foxglove WebSocket has no equivalent, and caps
   * there are enforced by the client alone.
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
  /**
   * The topic's ROS message type (e.g. `'geometry_msgs/msg/Twist'`), supplied
   * up front by the consumer. A hint, trusted only while topic discovery is
   * silent: when the client already knows the topic's type at subscribe time,
   * the hint is ignored, and if discovery later reports a different type the
   * client re-subscribes with the discovered one (discovery wins whenever it
   * disagrees).
   *
   * On rosbridge the hint types the subscribe frame, which establishes the
   * subscription at the bridge immediately, even before any publisher exists;
   * `getSubscriptionState` then reports `'active'` from the start, and
   * delivery begins the instant a publisher appears, without waiting for a
   * discovery poll. On Foxglove WebSocket the field is ignored: the wire
   * subscription requires an advertised channel regardless of the type being
   * known.
   *
   * Limitation: only hint a type you know from the robot's interface
   * contract. On rosbridge, a hinted subscription to a topic that does not
   * exist yet is itself an endpoint in the ROS graph, and topic discovery
   * reports a single type per topic (the alphabetically first among its
   * endpoints' types), so a wrong hint can be echoed back to the client as
   * the topic's type. If the wrong hint sorts before the true type, the
   * correction above never triggers and the subscription stays `'active'`
   * but never delivers, indistinguishable from a quiet topic. A wrong hint
   * on a topic with a live publisher at subscribe time is always corrected.
   */
  schemaName?: string;
  /**
   * How surviving messages reach the callback. Defaults to `'immediate'`.
   *
   * - `'immediate'` (default): every message that clears the throttle is
   *   parsed and delivered synchronously, on the message-handler tick. This
   *   is the only behavior prior to v0.1.3; existing subscriptions are
   *   unaffected.
   * - `'latest-only'`: under back-pressure, only the newest message reaches
   *   the callback. Superseded messages are dropped *before* being parsed,
   *   and delivery is deferred off the message-handler tick. Use this for
   *   high-bandwidth topics (raw camera frames) where rendering the freshest
   *   frame matters and intermediate frames are waste.
   *
   * `'latest-only'` collapses a burst to its newest member upstream of the
   * CDR/JSON decode — work an external wrapper cannot avoid, because it only
   * ever sees already-parsed messages. The trade-off: on a binary (CDR) topic
   * the stashed payload is copied to survive the deferral, so `'latest-only'`
   * is parse-cheap but not allocation-free (a copy is far cheaper than the
   * decode it replaces).
   *
   * Rate caps shape *when* the newest message is delivered, never *whether*
   * it is. `maxFrequency` and the adaptive cap set the minimum spacing between
   * deliveries; a message arriving inside a closed window replaces the one
   * waiting rather than being discarded, and is delivered when the window
   * reopens. So the last message before a topic falls silent always arrives,
   * at most one window late. This matters for topics that publish on change
   * and may then go quiet indefinitely (action goal status, an e-stop
   * assertion, a map update): there is no later message to restate a discarded
   * one, so dropping it would leave the callback permanently stale. Since
   * v0.1.9; earlier versions dropped it. A callback that throws is logged and
   * never wedges the subscription; on unsubscribe, disconnect, or a breaker
   * trip any pending message is dropped rather than delivered.
   *
   * `'immediate'` is unchanged and remains leading-edge: its contract is
   * synchronous delivery on the message-handler tick, and a trailing message
   * can only be delivered off it. Choose `'latest-only'` when the freshest
   * value matters more than delivery timing.
   *
   * For lossless delivery that is still deferred off-tick, keep a bounded
   * queue in the callback and drain it yourself — the bound and drop policy
   * are device- and workload-specific, so the library does not pick them:
   *
   * ```ts
   * const MAX = 8; // tune to the device
   * const queue: RosMessage[] = [];
   * let draining = false;
   * client.subscribe('/scan', (msg) => {
   *   if (queue.length >= MAX) queue.shift(); // drop oldest
   *   queue.push(msg);
   *   if (draining) return;
   *   draining = true;
   *   const pump = () => {
   *     const next = queue.shift();
   *     if (!next) { draining = false; return; }
   *     process(next);
   *     setTimeout(pump, 0);
   *   };
   *   setTimeout(pump, 0);
   * });
   * ```
   */
  dispatchMode?: 'immediate' | 'latest-only';
}

// ─── Subscription State ──────────────────────────────────────────────────────

/**
 * Establishment state of a subscription as reported by
 * `IProtocolClient.getSubscriptionState`.
 *
 * - `'none'`: no subscription exists for the topic.
 * - `'pending'`: `subscribe()` was called, but the client cannot yet confirm
 *   the subscription is established at the bridge (the topic is not
 *   advertised / not discovered yet). It activates automatically when the
 *   topic appears.
 * - `'active'`: the subscription is established at the bridge. Establishment,
 *   not delivery: a quiet topic is still `'active'`.
 */
export type SubscriptionState = 'none' | 'pending' | 'active';

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
export type CircuitBreakerState = 'closed' | 'tripped_auto' | 'tripped_manual' | 'half_open';

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
   *
   *   Multiple control publishes for the **same topic** coalesce — only the
   *   latest value drains. This means a release-the-joystick zero-Twist
   *   queued after N stale-value Twists on `/cmd_vel` sends in one WebSocket
   *   frame rather than draining behind the stale ones. Under sustained
   *   JS-thread saturation the robot stops within one WS round-trip of
   *   release, regardless of how deep the queue grew during the block.
   *   Insertion order across **distinct topics** is preserved.
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

// ─── Service call options ───────────────────────────────────────────────────

/**
 * Options for `IProtocolClient.callService`. Omitting the bag (or every
 * field) preserves the default behavior exactly, including the wire frames
 * sent.
 */
export interface CallServiceOptions {
  /**
   * Per-call timeout in milliseconds. Must be a finite number greater than
   * zero; zero or below throws synchronously, because on rosbridge the wire
   * `timeout: 0` means an *unbounded* server-side wait whose worker survives
   * the client's disconnect, and must never be forwarded.
   *
   * On rosbridge the value is forwarded as the protocol's `timeout` field
   * (seconds), so the bridge itself gives up and returns a failure frame
   * carrying its reason instead of leaving the caller to guess from silence;
   * a local backstop is armed slightly later than the wire deadline, so a
   * reasoned server answer always wins when one is coming and the backstop
   * fires only when no frame will ever arrive (as under a restrictive
   * `services_glob`). On Foxglove WebSocket, which has no wire-level
   * equivalent, the value governs the local timer directly.
   *
   * When omitted, the library's default local timeout (30 s) applies and no
   * wire field is sent.
   */
  timeoutMs?: number;
}

// ─── Actions ────────────────────────────────────────────────────────────────

/**
 * Terminal state of a dispatched action goal, delivered by
 * `ActionGoalHandle.outcome` when the goal's lifecycle ends.
 *
 * A canceled or aborted goal is a resolution, not an error: the lifecycle was
 * observed to its end. So is a disowned goal (`status: 0`): the server itself
 * answered that it no longer knows the goal. `outcome` rejects (with
 * `ActionGoalError`) only when there is no lifecycle to report at all.
 */
export interface ActionGoalOutcome {
  /**
   * The `action_msgs/msg/GoalStatus` value the goal ended with, relayed from
   * the wire verbatim: `4` SUCCEEDED, `5` CANCELED, `6` ABORTED, or `0`
   * STATUS_UNKNOWN — the server's specified answer for a goal it no longer
   * knows, typically one evicted after `result_timeout` (10 s by default on
   * current C++ action servers). Status 0 is entered on positive evidence
   * only, the server's own `get_result` answer, never inferred from silence
   * or a timer. It means no reachable server knows this goal: the goal is
   * not executing on any server the client can see, but nothing is known
   * about how execution ended. Branch on these four values.
   */
  status: number;
  /**
   * The action's result payload (the `<Action>_Result` message), as decoded
   * JSON. Empty object when the action's result type declares no fields, or
   * when the server's answer could not be decoded at all. For a `status: 0`
   * resolution this is the server's zero-filled placeholder and carries no
   * information.
   *
   * Bridges describe the result type in two different shapes, and the
   * library normalizes them: some nest the result under its own member,
   * others inline the result's fields at the top level of the response.
   * Either way this object holds the action's own fields and nothing else,
   * and `status` above is always the goal's terminal status, never a value
   * lifted out of the result.
   *
   * One limit follows from the inlined shape: an action whose result
   * declares a field of its own named `status` collides with the response's
   * terminal status, and the two collapse into one name before the message
   * reaches the library. Such a field is not reported here.
   */
  result: Record<string, unknown>;
}

/**
 * The action server's decision about a dispatched goal.
 *
 * - `'accepted'`: the server took the goal on. Reported from whichever
 *   evidence the transport provides first: the dispatch response, the goal
 *   appearing on the action's status topic, the first per-goal feedback
 *   frame, or any terminal state, since a goal that succeeded, aborted or was
 *   canceled was accepted by definition.
 * - `'rejected'`: the server declined it. The goal never runs and never
 *   enters the status state machine; ROS 2 places refusal outside it.
 * - `'unobservable'`: the goal ended and nothing in its life said either
 *   way. A connection that closed mid-goal, a server that died, a bridge
 *   failure whose text carries no classification.
 *
 * The union may grow, on the `ActionGoalErrorReason` precedent: branch with a
 * default case.
 */
export type ActionGoalAcceptance = 'accepted' | 'rejected' | 'unobservable';

/**
 * Handle returned synchronously by `sendActionGoal`. Every member is present
 * on every transport and resolves by the same rule everywhere; what differs
 * between transports is how promptly the evidence arrives, never what the
 * member means.
 */
export interface ActionGoalHandle {
  /**
   * Resolves when the goal's lifecycle ends: any terminal state (SUCCEEDED,
   * CANCELED, ABORTED) with its result payload, or `status: 0`
   * (STATUS_UNKNOWN) when the server answers that it no longer knows the
   * goal — see `ActionGoalOutcome.status`. Rejects with `ActionGoalError`
   * only when there is no lifecycle to report (dispatch rejected, no
   * server, connection closed mid-goal, server-side error).
   *
   * Never times out on its own: the library cannot distinguish a slow goal
   * from a dead one, so patience is the caller's decision. Race it against a
   * timer (`Promise.race`) and call `cancel()` to give up. A goal that
   * produces no evidence at all (a server that dies mid-goal and never
   * returns) stays pending forever; status 0 requires the server's own
   * answer, so it can never fire from mere silence.
   */
  outcome: Promise<ActionGoalOutcome>;
  /**
   * Request cancellation of this goal. Safe to call at any point in the
   * lifecycle: before the server accepted the goal (server-side no-op if the
   * goal never started), repeatedly, or after the outcome settled (no-op;
   * after a `status: 0` resolution in particular, no reachable server knows
   * the goal, so there is nothing left to cancel). Cancellation is confirmed
   * through `outcome` resolving with status `5` (CANCELED), not through this
   * call, which returns nothing.
   */
  cancel(): void;
  /**
   * Resolves with the server's decision to execute this goal, on evidence
   * rather than on a clock. **Never rejects**, on any path: it is safe to
   * leave unawaited, and safe to await in a runtime that treats an unhandled
   * rejection as fatal.
   *
   * Promptness is a transport capability, not a per-goal answer. On Foxglove
   * WebSocket the dispatch response carries `bool accepted`, so this normally
   * settles within a round trip. On rosbridge the bridge's own action client
   * sees that field and does not relay it, so the evidence is later and
   * implicit: the first feedback frame, or the terminal. An accepted rosbridge
   * goal that emits no feedback resolves only when it ends, possibly minutes
   * after dispatch.
   *
   * Feedback counts as evidence only for a goal that registered an
   * `onFeedback` callback. Feedback is opt-in on both transports, and a goal
   * that did not ask for it is never sent any: on Foxglove no feedback
   * subscription is opened, and on rosbridge the bridge is never asked to
   * relay the frames. It costs nothing on Foxglove, where the dispatch
   * response answers first either way. On rosbridge it is the difference
   * between settling at the first frame and settling at the terminal.
   *
   * One case leaves it pending for the life of the connection, and it is the
   * same case that leaves `outcome` pending: a Foxglove goal the server
   * refused whose dispatch response was lost. No status entry ever names a
   * refused goal, so no evidence of either kind arrives. A caller who needs a
   * bounded wait races a timer it owns, which is the same pattern on every
   * transport:
   *
   * ```ts
   * const decided = await Promise.race([
   *   handle.acceptance,
   *   new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 5_000)),
   * ]);
   * ```
   *
   * No settle order is promised between this and `outcome` when both settle
   * from the same frame. Do not build on microtask ordering.
   */
  acceptance: Promise<ActionGoalAcceptance>;
}

/**
 * Options for `sendActionGoal`.
 */
export interface SendActionGoalOptions {
  /**
   * Per-goal progress callback, registered at dispatch time (the shape every
   * native ROS 2 action client uses). Called with the action's feedback
   * payload (the `<Action>_Feedback` message) as decoded JSON.
   *
   * The contract is best-effort progress: the newest state wins under
   * pressure, and there is no rate guarantee. Feedback is expected to be
   * sampled-shaped (each frame restates current progress; the terminal
   * outcome travels separately), so a skipped frame is restated by the next
   * one. Consumers who need every frame subscribe to the action's feedback
   * topic themselves.
   *
   * A callback that throws is logged and never affects the goal or the
   * connection. No feedback is requested from the bridge when this option is
   * omitted.
   */
  onFeedback?: (feedback: Record<string, unknown>) => void;
}

// ─── Connection ──────────────────────────────────────────────────────────────

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

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

/**
 * Per-attempt options for `IProtocolClient.connect` (and forwarded verbatim
 * by `ProtocolManager.connect`'s second parameter). Not to be confused with
 * `ConnectionOptions`, which describes *what to connect to* and is safe to
 * persist; a `ConnectOptions` value carries per-attempt runtime state and
 * should never be stored.
 */
export interface ConnectOptions {
  /**
   * Cancels the **connection attempt** — the window between the `connect()`
   * call and its promise settling. When the signal aborts before the
   * handshake completes, the socket is closed and the `connect()` promise
   * rejects with `signal.reason` (when the runtime provides one) or an
   * `Error` whose `name` is `'AbortError'`. The one stable contract is the
   * name: treat `err.name === 'AbortError'` as cancellation; do not rely on
   * `instanceof`.
   *
   * An abort is not an error: it leaves `getLastError()` untouched, sets
   * status `'disconnected'` (not `'error'`), and schedules no reconnect.
   *
   * Aborting after `connect()` has resolved is a no-op — the signal governs
   * the attempt, never the established connection; end a live session with
   * `disconnect()`. The abort listener is removed as soon as the attempt
   * settles, so a long-lived signal can be reused across attempts safely.
   *
   * If a pre-aborted signal is passed, `connect()` rejects immediately and
   * no socket is created.
   */
  signal?: AbortSignal;
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

  /**
   * Open a connection and resolve once the transport's handshake completes.
   *
   * `options.signal` cancels the attempt (see `ConnectOptions.signal` for
   * the full contract). Calling `disconnect()` while an attempt is in
   * flight also cancels it: the pending promise rejects with an
   * `'AbortError'`-named error. Cancellation rejections are pre-handled by
   * the library, so a caller that does not retain the promise sees no
   * unhandled rejection.
   *
   * If a connect is already in flight or established, this call returns
   * immediately and `options` is ignored.
   */
  connect(url: string, options?: ConnectOptions): Promise<void>;
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
   *
   * **Synchronous callback contract.** `onMessage` is invoked synchronously
   * on the message-handler tick after the per-tick throttle / breaker
   * decisions have already run. A callback that performs heavy work
   * synchronously (an expensive decode, a synchronous render pipeline)
   * blocks the JS thread for the callback's duration — including blocking
   * the lag probe that informs the library's own adaptive throttle and
   * circuit breaker. Under sustained overload this lets queued messages
   * bypass throttle decisions that would otherwise drop them, because the
   * decisions are made at message-arrival granularity, not at
   * callback-completion granularity.
   *
   * The library cannot bound consumer callback duration without breaking
   * the synchronous contract that ordering-sensitive consumers depend on.
   * Yielding via `setImmediate`, `queueMicrotask`, or `requestIdleCallback`
   * is the consumer's responsibility. The canonical shape for heavy work
   * is *defer + skip-if-still-processing + latest-wins*:
   *
   * ```ts
   * let pending: RosMessage | null = null;
   * let processing = false;
   * client.subscribe('/camera/raw', (msg) => {
   *   pending = msg;                   // latest-wins; older value discarded
   *   if (processing) return;          // a deferred decode is in flight
   *   processing = true;
   *   setImmediate(() => {
   *     while (pending) {
   *       const next = pending;
   *       pending = null;
   *       decodeAndRender(next);
   *     }
   *     processing = false;
   *   });
   * });
   * ```
   *
   * `SubscribeOptions.dispatchMode: 'latest-only'` ships the latest-wins half
   * of this pattern as a built-in, and conflates upstream of the parse — see
   * its documentation.
   */
  subscribe(
    topic: string,
    onMessage: (msg: RosMessage) => void,
    options?: SubscribeOptions,
  ): () => void;

  /**
   * Establishment state of the subscription on `topic`:
   * `'none' | 'pending' | 'active'`.
   *
   * `subscribe()` on a topic the bridge has not advertised yet succeeds and
   * returns a working unsubscribe function, but the subscription cannot be
   * established at the bridge until the topic appears; until then it is
   * `'pending'` and no messages can arrive. The client cannot tell a typo'd
   * topic from one that will appear later (a robot mode switch that starts
   * new publishers, a node still launching) — only the app can judge that,
   * so the state is surfaced instead of timed out.
   *
   * `'active'` means *established*, not *delivering*:
   *
   * - A quiet topic (no publisher, or nothing published yet) is `'active'`.
   *   Topic liveness is a separate question — `getAvailableTopics()` /
   *   `onTopicsChange`.
   * - A subscription paused by its circuit breaker stays `'active'`; breaker
   *   state has its own observer, `getBreakerState`.
   * - On rosbridge, a subscription typed via `SubscribeOptions.schemaName`
   *   reports `'active'` immediately. If the supplied type turns out wrong,
   *   `'active'` can overstate until topic discovery reports the real type
   *   and the client re-subscribes with it (see `SubscribeOptions.schemaName`).
   *
   * Getter only, by design: every pending → active transition coincides with
   * an event the consumer can already observe (the topic appearing fires
   * `onTopicsChange`; delivery fires the message callback itself). A
   * "waiting for topic" badge is a small wrapper:
   *
   * ```ts
   * const unsub = client.subscribe('/mode_gated/status', onMsg);
   * const render = () =>
   *   setBadge(client.getSubscriptionState('/mode_gated/status') === 'pending');
   * render();
   * const stop = client.onTopicsChange(render);
   * ```
   */
  getSubscriptionState(topic: string): SubscriptionState;

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
   * Publish a zero-velocity `geometry_msgs/msg/Twist` on `/cmd_vel` to halt
   * robot motion. Used by app-background, intentional-disconnect, and E-Stop
   * paths. No-op if the client has never published a Twist on this connection.
   *
   * **Safety boundary.** This sends only while the socket is open. It cannot
   * stop the robot on an *unexpected* loss of connectivity (network drop, app
   * kill, crash) — the transport is already gone, so no command can leave the
   * device. Network-loss halting must be enforced robot-side, by a `cmd_vel`
   * timeout / watchdog on the robot that stops when commands stop arriving. The
   * library covers intentional teardown; it cannot substitute for that
   * watchdog.
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
   *
   * Every field advances on frame *receipt*, recomputed per received frame
   * (including frames the cap drops before parse), not on delivery to your
   * callback. So a subscribed topic that receives no traffic never updates: it
   * reports its initial, pessimistic cap until the first frame arrives, and
   * `bytesPerSec` is an arrival rate, not a delivered rate.
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
  onBreakerStateChange(topic: string, cb: (state: CircuitBreakerState) => void): () => void;

  // ── Actions ─────────────────────────────────────────────────────────────

  /**
   * Dispatch a ROS 2 action goal and return a minimal handle for it,
   * synchronously. Throws when the client is not connected.
   *
   * `handle.outcome` resolves on any terminal state — SUCCEEDED (4),
   * CANCELED (5), ABORTED (6) — with the `action_msgs/msg/GoalStatus` value
   * and the result payload; a canceled or aborted goal is a resolution, not
   * an error, because the lifecycle was observed to its end. It also
   * resolves `{status: 0}` (STATUS_UNKNOWN) when the server answers that it
   * no longer knows the goal — its specified disowning answer, typically
   * after `result_timeout` eviction — entered on that positive evidence
   * only, never inferred from silence; see `ActionGoalOutcome.status`. A
   * goal that produces no evidence at all stays pending forever. It rejects
   * with `ActionGoalError` only when there is no lifecycle to report; branch
   * on its `reason` with a default case. The `'disconnected'` reason means
   * the outcome became permanently unobservable while the robot may still be
   * executing — reassess robot state on reconnect rather than treating it as
   * goal failure.
   *
   * `options.onFeedback` registers a best-effort per-goal progress callback
   * (newest state wins under pressure, no rate guarantee); consumers who
   * need every frame subscribe to the action's feedback topic themselves.
   * The handle never times out on its own — patience is the caller's
   * decision (`Promise.race`), and `cancel()` is the giving-up mechanism,
   * safe on a goal that never started.
   *
   * Two situations leave a goal pending with no further evidence coming: an
   * action that is still advertised whose server has died, and a goal the
   * server declined whose reply was lost on the way back. Neither is
   * distinguishable from a goal that is simply taking a long time, so an
   * application that needs a deadline sets its own:
   *
   * ```ts
   * const handle = client.sendActionGoal('/dock', 'my_robot/action/Dock', goal);
   * const deadline = new Promise<never>((_, reject) =>
   *   setTimeout(() => reject(new Error('dock did not finish in 60s')), 60_000),
   * );
   * try {
   *   const outcome = await Promise.race([handle.outcome, deadline]);
   * } catch (err) {
   *   handle.cancel();
   *   throw err;
   * }
   * ```
   *
   * `handle.acceptance` resolves with the server's decision to execute the
   * goal (`'accepted'`, `'rejected'` or `'unobservable'`) from whatever
   * evidence the transport provides, and never rejects. It is prompt on
   * Foxglove WebSocket, where the dispatch response carries the flag, and
   * late on rosbridge, where the bridge does not relay it and the first
   * feedback frame or the terminal is the evidence. Cancel-by-UUID,
   * cancel-all, and action discovery remain reachable via `callService` on
   * the action's services where the transport exposes them.
   *
   * If you do call `<action>/_action/send_goal` yourself, put the goal's own
   * fields at the **root** of the request beside `goal_id`, not under a
   * `goal` key. `rosidl` inlines them: three nav2 send-goal schemas captured
   * from a live bridge (jazzy, foxglove-sdk-cpp v0.25.1) all declare the flat
   * shape and none declares a nested one. Getting this wrong is silent rather
   * than fatal, which is what makes it worth stating: CDR carries no field
   * names, so a nested payload encodes without error, every real field is
   * written from its schema default, and the robot executes a goal nobody
   * sent. `sendActionGoal` encodes from the advertised schema and is correct
   * either way; a hand-built request is not.
   *
   * ```ts
   * // Correct: the goal's fields ride at the root.
   * await client.callService('/dock/_action/send_goal', {
   *   goal_id: { uuid: myUuidBytes },
   *   use_dock_id: true,
   *   dock_id: 'bay-3',
   * });
   * ```
   *
   * Transport notes: on rosbridge the client speaks the native
   * `send_action_goal` op family; the bridge's internal action client holds
   * a standing result request from acceptance, so the status-0 disowning
   * case never arises there — one contract, and rosbridge simply never
   * produces the middle value. On Foxglove WebSocket the client composes
   * dispatch from the hidden `_action/*` services and topics, which exist
   * only when the bridge runs with `include_hidden:=true`; on a stock
   * Foxglove bridge the outcome rejects fast with reason `'unavailable'`.
   * The terminal result rides a standing `get_result` request armed when
   * the status topic first names the goal — immune to result eviction on
   * every distro and free of any client-side ceiling on goal duration. That
   * same watch is what lets the Foxglove client carry a goal whose `send_goal`
   * reply went missing at the bridge: the goal id is invented here before the
   * request is sent, so a status entry naming it proves the server holds the
   * goal, and from that point the server outranks any bridge-level failure.
   * Over rosbridge that recovery is not available, because the bridge relays
   * the goal without the client's goal id and never surfaces the one it mints,
   * so no status entry there can be matched to this goal.
   *
   * Note for consumers that implement `IProtocolClient` themselves (test
   * doubles, most commonly): the interface is the contract between the
   * library and its transports; additions to it ship in 0.1.x releases.
   * Prefer extending a shipped client or implementing a partial view.
   */
  sendActionGoal(
    action: string,
    actionType: string,
    goal: Record<string, unknown>,
    options?: SendActionGoalOptions,
  ): ActionGoalHandle;

  // ── Services ────────────────────────────────────────────────────────────

  /**
   * Call a ROS service and resolve with its response. `options.timeoutMs`
   * bounds the individual call (see `CallServiceOptions.timeoutMs` for the
   * per-transport mechanics); zero or below throws synchronously. Omitting
   * it preserves the default behavior exactly.
   */
  callService(
    service: string,
    request: Record<string, unknown>,
    options?: CallServiceOptions,
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

  /**
   * The most recent error that drove the connection into a failure, or `null`
   * if none. Read this on a `status === 'error'` transition to recover the
   * reason. In particular, a `ProtocolMismatchError` detected *after* connect
   * resolves (the rosbridge-points-at-Foxglove case) is surfaced only here,
   * since there is no pending `connect()` promise left to reject. Cleared at
   * the start of the next `connect()`.
   */
  getLastError(): Error | null;

  // ── Events ──────────────────────────────────────────────────────────────

  onStatusChange(cb: (status: ConnectionStatus) => void): () => void;
  onTopicsChange(cb: (topics: TopicInfo[]) => void): () => void;
  onLog(cb: (log: string) => void): () => void;
}
