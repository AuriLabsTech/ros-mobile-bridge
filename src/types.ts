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
 * The library decodes CDR and protobuf for Foxglove WS subscriptions when the
 * channel schema is parseable; otherwise it falls back to a `Uint8Array` so the
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
 *
 * The same contract holds for `bytes` fields inside a decoded protobuf
 * message (for example the `data` of a `foxglove.CompressedImage`): each is a
 * view into the same frame, not a copy.
 */
export interface RosMessage {
  /** The topic this message arrived on, as passed to `subscribe`. */
  topic: string;
  /**
   * The message type, spelled as the server advertised it (for example
   * `geometry_msgs/msg/Twist`), or an empty string when the client does not
   * know the type.
   */
  schemaName: string;
  /**
   * The message encoding the server declared for this topic, passed through
   * unchanged: `'json'` and `'cdr'` on the transports shipped today, and on
   * Foxglove WebSocket any other value the server declares, such as
   * `'protobuf'`. It always matches the `encoding` of the same topic in
   * `getAvailableTopics()`.
   *
   * This client decodes `'json'`, `'cdr'` and, on Foxglove WebSocket,
   * `'protobuf'`. A message in any other encoding is delivered with `data` as
   * the raw payload, and the client logs one warning per topic saying so.
   * Treat other values as possible, and branch with a default case: the set
   * belongs to the server, not to this library.
   */
  encoding: string;
  /**
   * The decoded message, or the raw payload when this client could not decode
   * it.
   *
   * A decoded protobuf message uses the field names its `.proto` declares
   * (`frame_id`, not `frameId`). 64-bit integers are `bigint`, `bytes` fields
   * are `Uint8Array`, enums are numbers, and a `google.protobuf.Timestamp` is
   * `{ seconds, nanos }`. A sub-message, a `oneof` member, or an `optional`
   * field the sender did not set is absent; other fields the sender omitted
   * carry protobuf's default. Map fields are plain objects with string keys.
   *
   * Raw bytes mean one of four things: the message is in an encoding this
   * client does not decode (see `encoding`), the server sent no usable
   * description of the type, the description it sent could not be parsed, or
   * the description said the type has no fields and the payload then carried data
   * that contradicts it. A message of a type that genuinely has no fields
   * decodes to `{}` and is not a raw payload, whatever its length on the wire.
   */
  data: Uint8Array | Record<string, unknown>;
  /**
   * A timestamp for this message. It means different things per transport:
   *
   * - **Foxglove WebSocket:** the timestamp the server put on the message
   *   frame. `foxglove_bridge` stamps it with the robot computer's clock (or
   *   its simulated clock under `use_sim_time`) when the message reached the
   *   bridge, before it was sent. It is not the message's own
   *   `header.stamp`, and not the time this device received it.
   * - **rosbridge:** this device's own clock (`Date.now()`) when the frame
   *   arrived, before any rate cap held it. rosbridge's JSON frames carry no
   *   server timestamp.
   *
   * So the two clocks differ: the robot's on Foxglove WebSocket, this
   * device's on rosbridge. Do not subtract one from the other, and do not
   * read `Date.now()` minus this value as network delay on Foxglove
   * WebSocket: the two clocks are not synchronised. For the time a message
   * was produced, read its `header.stamp` when its type has one.
   */
  receiveTime: {
    /** Whole seconds since the Unix epoch on the clock described above. */
    sec: number;
    /** Nanoseconds past `sec`, from 0 to 999 999 999. */
    nsec: number;
  };
  /**
   * Wire payload size in bytes. Populated by the protocol client so consumers
   * don't have to `JSON.stringify` the parsed data to estimate it (which is
   * prohibitively slow for big messages like camera frames).
   */
  byteSize?: number;
}

/**
 * Whether this client publishes to a topic the server lists.
 *
 * - `'app'`: this client currently advertises the topic, through `publish` or
 *   `ensureAdvertised`, whatever other nodes also publish it.
 * - `'robot'`: the server lists the topic and this client does not currently
 *   advertise it.
 *
 * Useful when a UI wants to mark "this app is publishing here". Which other
 * nodes publish or subscribe is `IProtocolClient.getTopicEndpoints`, not this
 * value.
 */
export type TopicSource = 'robot' | 'app';

/**
 * A topic the connected server currently knows about, as returned by
 * `IProtocolClient.getAvailableTopics` and passed to `onTopicsChange`.
 *
 * - Foxglove WebSocket: the channels the bridge has advertised to this
 *   client; the list changes when the bridge advertises or unadvertises.
 * - rosbridge: the answer of the robot's `/rosapi/topics` service, asked on
 *   connect, on the `discoveryRefreshMs` timer, and on each
 *   `getAvailableTopics()` call while connected.
 */
export interface TopicInfo {
  /** The topic name, for example `/cmd_vel`. */
  topic: string;
  /**
   * The message type, spelled as the server advertised it (for example
   * `geometry_msgs/msg/Twist`). An empty string when the server listed the
   * topic without a type.
   */
  schemaName: string;
  /**
   * The encoding the server declared for this topic: `'json'` on rosbridge;
   * on Foxglove WebSocket whatever the bridge declares, usually `'cdr'`. The
   * same value `RosMessage.encoding` carries for this topic.
   */
  encoding: string;
  /**
   * Whether this client publishes to the topic (see {@link TopicSource}),
   * read from the client's own state each time a list is handed out.
   * `getAvailableTopics()` reflects a `publish`, `ensureAdvertised` or
   * `unadvertise` at once. These calls do not fire `onTopicsChange`, which
   * reports changes to the server's list, so a listener sees the new value
   * with the next such change. A topic only this client publishes appears
   * once the server lists it; after `unadvertise`, rosbridge can keep listing
   * it, as `'robot'`, for about 10 s while the bridge holds its publisher.
   */
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
  /** The service name, for example `/turtle1/teleport_absolute`. */
  name: string;
  /** The bare service type, or an empty string when the transport did not report it (see above). */
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

// ─── Parameters ─────────────────────────────────────────────────────────────

/**
 * A ROS 2 parameter value with its type. Every value says what it is, so a
 * write sends exactly that type: the integer `2n` and the double `2` cannot
 * be confused, and an empty array still says what it would hold.
 *
 * Integers are `bigint`, scalar and in arrays, on every transport, the same
 * as 64-bit integers in decoded messages. On rosbridge the bridge sends
 * integers as JSON numbers, so a value beyond 2^53 has already lost
 * precision before the library converts it.
 */
export type ParameterValue =
  | {
      /** ROS 2 `PARAMETER_BOOL`. */
      type: 'bool';
      /** The value. */
      value: boolean;
    }
  | {
      /** ROS 2 `PARAMETER_INTEGER` (64-bit). */
      type: 'integer';
      /** The value. */
      value: bigint;
    }
  | {
      /** ROS 2 `PARAMETER_DOUBLE`. */
      type: 'double';
      /** The value. */
      value: number;
    }
  | {
      /** ROS 2 `PARAMETER_STRING`. */
      type: 'string';
      /** The value. */
      value: string;
    }
  | {
      /** ROS 2 `PARAMETER_BYTE_ARRAY`. */
      type: 'byte_array';
      /** The bytes. */
      value: Uint8Array;
    }
  | {
      /** ROS 2 `PARAMETER_BOOL_ARRAY`. */
      type: 'bool_array';
      /** The values. */
      value: boolean[];
    }
  | {
      /** ROS 2 `PARAMETER_INTEGER_ARRAY` (64-bit). */
      type: 'integer_array';
      /** The values. */
      value: bigint[];
    }
  | {
      /** ROS 2 `PARAMETER_DOUBLE_ARRAY`. */
      type: 'double_array';
      /** The values. */
      value: number[];
    }
  | {
      /** ROS 2 `PARAMETER_STRING_ARRAY`. */
      type: 'string_array';
      /** The values. */
      value: string[];
    };

/** The `type` of a {@link ParameterValue}: one of the nine ROS 2 parameter types. */
export type ParameterType = ParameterValue['type'];

/**
 * What a node holds under one parameter name, as read by
 * `IProtocolClient.getParameters`.
 *
 * - `'set'`: the parameter is declared and has `value`.
 * - `'not-set'`: the parameter is declared and holds no value (a statically
 *   typed parameter never given one, or a dynamically typed one set to
 *   nothing).
 * - `'undeclared'`: the node has no parameter by that name.
 * - `'unreadable'`: the parameter exists and holds a value this transport
 *   cannot carry back. Today that is a byte array over rosbridge, which
 *   refuses to send any reply holding one. `type` says what it holds.
 */
export type ParameterReading =
  | {
      /** The parameter name, as asked for. */
      name: string;
      /** Declared, with a value. */
      state: 'set';
      /** What it holds. */
      value: ParameterValue;
    }
  | {
      /** The parameter name, as asked for. */
      name: string;
      /** Declared, without a value. */
      state: 'not-set';
    }
  | {
      /** The parameter name, as asked for. */
      name: string;
      /** Not declared on this node. */
      state: 'undeclared';
    }
  | {
      /** The parameter name, as asked for. */
      name: string;
      /** Holds a value this transport cannot carry back. */
      state: 'unreadable';
      /** The type of what it holds. */
      type: ParameterType;
    };

/**
 * What a node says about one parameter name, as read by
 * `IProtocolClient.describeParameters`. A declared parameter carries its
 * descriptor; `'undeclared'` means the node has no parameter by that name.
 *
 * `type` is `'not-set'` for a dynamically typed parameter that holds no
 * value. `integerRange` and `floatingPointRange` are present only when the
 * node declared one; a write outside the range is refused by the node.
 */
export type ParameterDescription =
  | {
      /** The parameter name, as asked for. */
      name: string;
      /** Declared on this node. */
      state: 'declared';
      /** Its type; `'not-set'` for a dynamically typed parameter holding no value. */
      type: ParameterType | 'not-set';
      /** The node's description of it, often empty. */
      description: string;
      /** Constraints the node states in words, often empty. */
      additionalConstraints: string;
      /** Whether the node refuses every change to it. */
      readOnly: boolean;
      /** Whether a change may give it a different type. */
      dynamicTyping: boolean;
      /** The allowed integer range, when the node declared one. */
      integerRange?: ParameterRange<bigint>;
      /** The allowed floating-point range, when the node declared one. */
      floatingPointRange?: ParameterRange<number>;
    }
  | {
      /** The parameter name, as asked for. */
      name: string;
      /** Not declared on this node. */
      state: 'undeclared';
    };

/**
 * A range a node declared for a parameter. `step` 0 means any value in the
 * range; otherwise a value must be `from` plus a whole number of steps.
 *
 * On rosbridge an integer bound beyond ±2^53 arrives as a JSON number and is
 * rounded before the library sees it, as integer values are: an int64 limit
 * such as 9223372036854775807 can read back one past the int64 maximum.
 */
export interface ParameterRange<T extends bigint | number> {
  /** The lowest allowed value. */
  from: T;
  /** The highest allowed value. */
  to: T;
  /** The spacing between allowed values; 0 for any. */
  step: T;
}

/** The node's one answer to `IProtocolClient.setParametersAtomically`. */
export interface ParameterAtomicResult {
  /** Whether the node applied every change; false means it applied none. */
  successful: boolean;
  /** The node's reason when it refused. */
  reason: string;
}

/** Options for `IProtocolClient.listParameters`: what to list, and the call's timeout. */
export interface ListParametersOptions extends CallServiceOptions {
  /** List only names under these prefixes (`'a'` lists `a.b`, `a.b.c`). Default: every name. */
  prefixes?: readonly string[];
  /**
   * How many dot-separated levels below a prefix to list. A whole number;
   * 0, the default, lists every level.
   */
  depth?: number;
}

/** One parameter to write: its name as the node declares it, and its new value. */
export interface ParameterChange {
  /** The parameter name, dots included (`a.b.c`). */
  name: string;
  /** The new value. Its `type` is sent as given. */
  value: ParameterValue;
}

/**
 * The node's answer to one change. A refused change carries the node's own
 * `reason` (read-only, wrong type, out of range, a node's own validation).
 */
export interface ParameterSetResult {
  /** The parameter this answer is for. */
  name: string;
  /** Whether the node applied the change. */
  successful: boolean;
  /** The node's reason when it refused; usually empty on success. */
  reason: string;
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

/**
 * The state of a client's connection, reported by
 * `IProtocolClient.onStatusChange`.
 *
 * - `'disconnected'`: no connection: before the first `connect()`, after
 *   `disconnect()`, or after the socket closed.
 * - `'connecting'`: a connection attempt, first or automatic, is in flight.
 * - `'connected'`: the transport's handshake completed and the client is
 *   usable.
 * - `'error'`: a connection attempt failed, the server turned out to speak a
 *   different protocol, or automatic reconnecting gave up after
 *   `maxReconnectAttempts`. Read the reason from `getLastError()`.
 *
 * When an established connection drops without `disconnect()`, the client
 * reconnects on its own: the status passes through `'disconnected'` or
 * `'error'` (depending on how the socket failed) and then `'connecting'`. A
 * failed first `connect()` is not retried; its promise rejects and retrying
 * is the caller's choice.
 */
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * Which wire protocol to speak. `'foxglove-ws'` is the Foxglove WebSocket v1
 * protocol (`foxglove_bridge`), `'rosbridge'` is the rosbridge v2 JSON
 * protocol (`rosbridge_server`). `'zenoh'` is reserved for a client that has
 * not shipped yet: `ProtocolManager.connect` fails with a "planned" error
 * for it today.
 */
export type ProtocolType = 'foxglove-ws' | 'rosbridge' | 'zenoh';

/**
 * Whether the server accepts publishing from this client, as returned by
 * {@link IProtocolClient.getPublishPermission}. `'unknown'` means the
 * transport did not say, never "probably yes".
 */
export type PublishPermission = 'allowed' | 'refused' | 'unknown';

/**
 * Connection parameters consumed by `ProtocolManager.connect`. Only the
 * fields the library needs to open a WebSocket are declared here; identifiers,
 * display names, and any "saved profile" concept are the host application's
 * concern and should live in its own store.
 */
export interface ConnectionOptions {
  /** Which wire protocol the server speaks. */
  protocol: ProtocolType;
  /**
   * The server's host name or IP address, for example `192.168.1.20`. A
   * pasted URL is cleaned up: a `ws://`, `wss://`, `http://` or `https://`
   * prefix, a `:port` suffix, and any path are removed, so `port` always
   * decides the port. A `wss://` or `https://` prefix also turns on `secure`
   * when `secure` is not set.
   */
  host: string;
  /**
   * Port to connect to. Optional; defaults to `DEFAULT_PORTS[protocol]`
   * (8765 for `foxglove-ws`, 9090 for `rosbridge`, 7447 for `zenoh`).
   */
  port?: number;
  /**
   * Use the secure `wss://` scheme. Optional. When not set, the connection
   * is secure only if `host` was pasted with a `wss://` or `https://`
   * prefix, and plain `ws://` otherwise. An explicit `true` or `false`
   * always wins.
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

// ─── Topic endpoints ────────────────────────────────────────────────────────

/**
 * Who is on each side of one topic, as {@link IProtocolClient.getTopicEndpoints}
 * reports it.
 *
 * Each side is either a list of fully qualified node names (`/ns/node`) or
 * `null`. The two mean different things, and the difference is the point:
 *
 * - An array is what the robot reported. An empty array means the robot said
 *   no node is on that side.
 * - `null` means not known: the client could not find out. Treat it as "the
 *   robot could not say" and fall back to your own judgement, never as
 *   "nobody".
 */
export interface TopicEndpoints {
  /** The topic name, as given to `getTopicEndpoints` or as the robot lists it. */
  topic: string;
  /** Nodes that publish on the topic, or `null` when not known. */
  publishers: string[] | null;
  /** Nodes that subscribe to the topic, or `null` when not known. */
  subscribers: string[] | null;
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
   * Called with round-trip latency in milliseconds each time a correlated
   * request the client issued is matched to its response.
   *
   * Every transport reports the same thing: one request-response round trip
   * on this connection, timed client-side, so a busy connection reports often
   * and an idle one reports rarely. Your own `callService` calls yield a
   * sample on every transport. On Foxglove WebSocket so do the service calls
   * the client makes under the hood to dispatch and cancel an action goal. On
   * rosbridge those go through the protocol's own action operations instead:
   * a goal is answered only when it ends, and a cancel is not answered at
   * all, so neither yields a sample.
   *
   * What never yields a sample is a request whose answer arrives when the
   * robot finishes working rather than when the request is served. On
   * Foxglove WebSocket, which has no action operations, an action's result is
   * fetched with a service call that the server answers only when the goal
   * ends; timing it would report the goal's duration under the name latency,
   * so it is excluded. If you issue such a long-polling call yourself through
   * {@link IProtocolClient.callService}, its duration is reported like any
   * other call you make.
   *
   * On rosbridge an idle connection is additionally measured by a background
   * probe (see {@link ProtocolClientOptions.latencyProbeMs}). On Foxglove
   * WebSocket there is no such probe and there deliberately is not going to
   * be one: that protocol offers no idle round trip that does not write to
   * the robot's log on every tick. A Foxglove connection that makes no
   * requests therefore reports no latency, which is the honest state rather
   * than a measurement of zero.
   *
   * Because samples are not periodic, a consumer rendering the number should
   * age it. The library reports that a round trip took this long; it does not
   * assert the measurement is still current.
   */
  onLatency?: (rttMs: number) => void;

  /**
   * How often, in milliseconds, the client re-reads the robot's topics and
   * services when the transport does not announce graph changes on its own.
   * Defaults to `30000`. Pass `0` to disable the refresh entirely.
   *
   * - **rosbridge**: drives the topics poll and the services poll. That
   *   server sends nothing unsolicited when the graph changes on a live
   *   socket, so with this disabled the topic and service lists are frozen
   *   from connect to disconnect and `getAvailableTopics()` serves the
   *   frozen set. Disable it only if you refresh on demand yourself.
   * - **Foxglove WebSocket**: no effect. That transport pushes `advertise`
   *   and `unadvertise` on the live socket, so the lists are already current.
   *
   * A value above `0` but below `1000` throws synchronously at construction:
   * this timer issues service calls to the robot, and a sub-second interval
   * is refused rather than clamped.
   */
  discoveryRefreshMs?: number;

  /**
   * How often, in milliseconds, the client measures round-trip time on an
   * otherwise idle connection, for transports that offer a safe idle round
   * trip. Defaults to `30000`. Pass `0` to disable the probe.
   *
   * - **rosbridge**: drives a `/rosapi/get_time` probe, a payload-free
   *   read-only call that carries no graph data. The probe latches off for
   *   the rest of the connection after a single failed call.
   * - **Foxglove WebSocket**: no effect, and this is a property of the
   *   protocol rather than of this implementation. Every correlated
   *   read-only round trip Foxglove WS v1 offers makes the bridge write a
   *   log line on the robot for every probe.
   *
   * This governs only the idle probe. {@link ProtocolClientOptions.onLatency}
   * still fires for real round trips on every transport with this set to `0`.
   *
   * A value above `0` but below `1000` throws synchronously at construction,
   * on the same reasoning as {@link ProtocolClientOptions.discoveryRefreshMs}.
   */
  latencyProbeMs?: number;

  /**
   * Allow this client to learn which nodes publish and which subscribe to each
   * topic, for {@link IProtocolClient.getTopicEndpoints}. Defaults to `false`:
   * with it off, that method answers "not known" for every topic and the
   * client touches nothing on the robot for it.
   *
   * What turning it on costs, per transport:
   *
   * - **Foxglove WebSocket**: the client listens to the bridge's connection
   *   graph for the whole connection, from connect on. While anyone listens,
   *   the bridge rebuilds its map of the robot's graph each time a node starts
   *   or stops and sends the change to this client, about 1 KB per change on a
   *   small robot and more on a robot with many nodes, since every node's
   *   services ride along. Measured on a desktop CPU with 200 nodes and one
   *   node starting and stopping every 2 seconds: listening added about 12
   *   CPU-seconds per minute to the bridge (a fifth of one core) and sent this
   *   client about 370 KB per minute, up to 124 KB in one frame. A robot
   *   computer pays more; a robot whose nodes stay up pays next to nothing,
   *   since the bridge rebuilds only on a change. A bridge launched without
   *   the `connectionGraph` capability has nothing to listen to, and the
   *   answers stay not known.
   * - **rosbridge**: nothing runs in the background. Each call to
   *   `getTopicEndpoints` asks the bridge's `rosapi` node, one question at a
   *   time, about the topics you name. **Risk:** `rosapi` 2.7.1 and every
   *   release before it crashes when any node on the robot exits while it is
   *   answering one of these questions, and a crashed `rosapi` stays down until
   *   the bridge restarts. That breaks topic and service lists for every client
   *   of that robot, not only this one. It needs a robot whose nodes come and
   *   go; the client cannot prevent it, only keep the questions few. Name the
   *   topics you care about rather than asking for all of them.
   */
  readTopicEndpoints?: boolean;
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

/**
 * Where the library writes its diagnostics, passed as
 * `ProtocolClientOptions.logger`. The shape matches `console`, so
 * `{ logger: console }` works. Most lines start with the name of the part
 * that wrote them, for example `[FoxgloveClient]`.
 */
export interface ProtocolLogger {
  /** Routine progress: connects, discovery, reconnect attempts. */
  log: (...args: unknown[]) => void;
  /** Something unexpected that the library worked around. */
  warn: (...args: unknown[]) => void;
  /** A failure, such as a socket error or a listener that threw. */
  error: (...args: unknown[]) => void;
}

// ─── Schema Definitions ─────────────────────────────────────────────────────

/**
 * A message type described field by field, as
 * {@link IProtocolClient.getSchemaDefinition} returns it: the type asked for
 * and every type it contains, in one flat map keyed by three-part name.
 *
 * @example Walking every field of a type
 * ```ts
 * const def = await client.getSchemaDefinition('geometry_msgs/msg/PoseStamped');
 * function walk(typeName: string, path: string): void {
 *   for (const field of def!.types[typeName]!.fields) {
 *     if (field.isComplex) walk(field.type, `${path}${field.name}.`);
 *     else console.log(`${path}${field.name}: ${field.type}${field.isArray ? '[]' : ''}`);
 *   }
 * }
 * walk(def!.root, '');
 * ```
 */
export interface SchemaDefinition {
  /** The three-part name of the type asked for; always a key of {@link types}. */
  root: string;
  /** The root type and every type it contains, each once, keyed by three-part name. */
  types: Record<string, TypeDefinition>;
}

/** One message type: its fields in declaration order, and its constants. */
export interface TypeDefinition {
  /** Three-part name, such as `geometry_msgs/msg/Point`. */
  name: string;
  /** The fields a message of this type carries, in declaration order. Empty for a fieldless type. */
  fields: FieldDefinition[];
  /** The constants the type declares. They are not fields and are not sent. */
  constants: ConstantDefinition[];
}

/** One field of a {@link TypeDefinition}. */
export interface FieldDefinition {
  /** The field name, as the schema spells it. */
  name: string;
  /**
   * A ROS 2 primitive (`bool`, `byte`, `char`, `int8` to `uint64`,
   * `float32`, `float64`, `string`, `wstring`) or, when
   * {@link isComplex} is true, the three-part name of a type in
   * {@link SchemaDefinition.types}. For an array, the element type.
   */
  type: string;
  /** True when {@link type} names another message type. */
  isComplex: boolean;
  /** True for any array: fixed, bounded or unbounded. */
  isArray: boolean;
  /** Set only for a fixed-size array (`float64[9]`): the exact element count. */
  arrayLength?: number;
  /** Set only for a bounded sequence (`int32[<=3]`): the most elements it may hold. */
  arrayUpperBound?: number;
  /** Set only for a bounded string (`string<=10`): the most characters it may hold. */
  stringUpperBound?: number;
  /**
   * Set only when the schema declares a default (`float64 w 1.0`). A scalar
   * has the JavaScript type a decoded message gives that field (a 64-bit
   * integer is a `bigint`); an array default is a plain array of those. A
   * 64-bit default above 2^53 in an IDL schema is left out: the IDL parser
   * has already rounded it.
   */
  defaultValue?: DefinitionValue | DefinitionValue[];
}

/** A constant a {@link TypeDefinition} declares (`uint8 BOX=1`). */
export interface ConstantDefinition {
  /** The constant name. */
  name: string;
  /** Its ROS 2 primitive type. */
  type: string;
  /** Its value, with the JavaScript type a decoded message gives that type (a 64-bit integer is a `bigint`). */
  value: DefinitionValue;
}

/** A value a schema declares for a constant or a field default. */
export type DefinitionValue = boolean | number | bigint | string;

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

  /**
   * Close the connection on purpose. No automatic reconnect follows.
   *
   * Before the socket closes, every pending `priority: 'control'` publish is
   * sent, however many are queued. The library sends no stop of its own: to
   * halt a robot on the way out, publish a zero `geometry_msgs/msg/Twist` to
   * each velocity topic you drove, with `priority: 'control'`, then call
   * `disconnect()`:
   *
   * ```ts
   * const zero = { linear: { x: 0, y: 0, z: 0 }, angular: { x: 0, y: 0, z: 0 } };
   * client.publish('/cmd_vel', 'geometry_msgs/msg/Twist', zero, { priority: 'control' });
   * await client.disconnect();
   * ```
   *
   * On rosbridge, every `disconnect()` of an open connection then waits for
   * the bridge to work through what was written before closing, because the
   * bridge drops messages it has received but not yet processed when the
   * connection closes. It sends one `/rosapi/get_time` request last and closes
   * on the answer, or after 2 s if none comes: usually one round trip, longer
   * on a busy robot computer. That wait covers whatever was written last, at
   * either priority, including a goal cancel or a service call sent just
   * before. A `connect()` made during that wait connects once the close is
   * done.
   *
   * **Safety boundary.** This only helps while the socket is open. Nothing can
   * stop the robot on an *unexpected* loss of connectivity (network drop, app
   * kill, crash): the transport is already gone, so no command can leave the
   * device. Halting on network loss must be enforced robot-side, by a
   * `cmd_vel` timeout or watchdog that stops the robot when commands stop
   * arriving.
   *
   * Called while a `connect()` is in flight, it cancels that attempt.
   */
  disconnect(): Promise<void>;

  /** `true` exactly when the status is `'connected'`. */
  readonly isConnected: boolean;

  // ── Topics ──────────────────────────────────────────────────────────────

  /**
   * The topics the server currently knows about (see {@link TopicInfo} for
   * where each transport gets them).
   *
   * - Foxglove WebSocket: resolves at once with the channels the bridge has
   *   advertised.
   * - rosbridge: while connected, asks `/rosapi/topics` and resolves with the
   *   answer; if that call fails, or while not connected, resolves with the
   *   last list it had. It never rejects.
   *
   * The list empties when the connection closes, without an
   * `onTopicsChange` call. To follow changes instead of asking, use
   * `onTopicsChange`.
   */
  getAvailableTopics(): Promise<TopicInfo[]>;

  /**
   * Which nodes publish and which subscribe to each topic, as a snapshot taken
   * now. Use it to tell a robot's command inputs (nodes subscribe) from its
   * sensor outputs (nodes publish).
   *
   * Needs {@link ProtocolClientOptions.readTopicEndpoints}. With that option
   * off, every side of every topic is `null` (not known), on every transport.
   *
   * With `topics`, the answer has one entry per distinct name, in the order
   * given, and the client asks only about those topics. Without it, the answer
   * covers every topic the transport knows, sorted by name. A side is `null`
   * whenever the client cannot vouch for it; see {@link TopicEndpoints}.
   *
   * The answer never lists the bridge this client talks through. The bridge
   * shows up in the robot's graph as an endpoint of every topic its clients
   * touch, this app's included, under one node name for all of them, so its
   * entries describe apps rather than the robot. The client leaves it out only
   * on evidence of its name, and when it has none the affected sides are not
   * known. On Foxglove WebSocket a second bridge on the same robot is listed
   * like any other node. On rosbridge, every node that publishes a
   * `client_count` topic is taken for a bridge and left out, since the client
   * cannot tell its own bridge from another one that way.
   * Nodes started from the command line (`ros2 topic pub`) are listed where the
   * transport reports them: Foxglove WebSocket does, rosbridge does not.
   *
   * Nothing is updated live, and there is no change callback: call it again
   * when you want a fresher answer. One lookup runs at a time; a call made
   * during a lookup for the same topics shares its answer, and any other call
   * waits for it to finish. Rejects with "Not connected" when called while
   * disconnected, and when the connection ends or changes mid-lookup.
   *
   * Transport notes:
   *
   * - **Foxglove WebSocket** reads the bridge's own map of the robot's graph.
   *   That map is only right once the bridge has rebuilt it while this client
   *   was listening, and the bridge rebuilds only when the graph changes. Until
   *   then every side is not known. In practice this app's first topic
   *   subscription triggers a rebuild. A change made in the last second or so
   *   may not be in the answer yet. The bridge's name is learned from the
   *   topics this client has subscribed to or advertised for at least two
   *   seconds; before that, or when another node is on every one of those
   *   topics too, every side is not known.
   * - **rosbridge** asks the bridge's `rosapi` node, one question at a time,
   *   with a timeout on each, and stops at the first failed question; every
   *   side not yet answered is then not known. Read the risk under
   *   {@link ProtocolClientOptions.readTopicEndpoints} before turning it on.
   *   The bridge's name is the publisher of its `client_count` topic.
   *   `rosapi` sees the graph through its own node, which can lag the robot
   *   by a moment, most likely just after the robot starts: an empty side
   *   then may be stale, and asking again a couple of seconds later gets
   *   the fresh answer.
   */
  getTopicEndpoints(topics?: readonly string[]): Promise<TopicEndpoints[]>;

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

  /**
   * Publish `data` as one message of type `schemaName` on `topic`.
   *
   * The first publish on a topic also advertises it to the server, which
   * creates the ROS publisher. On Foxglove WebSocket that first message is
   * held about 150 ms so the bridge's publisher exists before it arrives;
   * publishes made meanwhile wait behind it, in order. Call
   * {@link IProtocolClient.ensureAdvertised} ahead of time where the first
   * message must go out at once.
   *
   * Fire and forget: nothing confirms delivery. While the client is not
   * connected the call does nothing; the message is dropped, not queued for
   * later. `options.priority` decides how a publish is queued under load (see
   * {@link PublishOptions}). Whether the server accepts publishing at all is
   * reported by {@link IProtocolClient.getPublishPermission}.
   */
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
   * A goal sent before the bridge's first service list has arrived waits for
   * that list (at most 2 s, once per connection, as `callService` does) and
   * is then sent; a `cancel()` made during the wait is sent after the goal.
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
   *
   * Resolves only with a response the client decoded. When the server
   * answered but the client cannot read the answer (no schema for it, an
   * encoding it does not decode, bytes that do not fit the schema, or a
   * malformed payload), the promise rejects with `ServiceResponseDecodeError`,
   * which carries the payload as `bytes` and the case as `reason`. That
   * rejection means the call reached the server; it says nothing about
   * whether the service succeeded. Rosbridge never produces it, because the
   * bridge decodes the response itself.
   *
   * On Foxglove WebSocket the bridge lists its services just after
   * `connect()` resolves. A call made before that list arrives, to a service
   * not yet known, waits for it (at most 2 s, once per connection) and then
   * goes ahead; a service still not listed then rejects as not available.
   * That wait comes before `timeoutMs` starts counting.
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

  // ── Parameters ──────────────────────────────────────────────────────────
  //
  // Every parameter method goes through the node's own `rcl_interfaces`
  // services (`<node>/get_parameters` and its siblings) on every transport,
  // never through a bridge's own parameter shortcut. A parameter is named by
  // two arguments: the fully qualified node (`/controller`, `/ns/demo`) and
  // the parameter's name as the node declares it, dots included.
  //
  // When the node has no parameter services the client can see (an unknown
  // node, or a bridge whitelist that hides them), a call rejects with
  // `ParameterServiceError` reason `'no-parameter-services'`. Timeouts and
  // unreadable replies reject with the same errors `callService` uses.
  // `options.timeoutMs` bounds each request a method makes, not the method.
  // A call that fails is followed by one read of the service list, bounded
  // the same way, so a failure can take about twice `timeoutMs`.

  /**
   * The nodes whose parameter services the client can see: every node that
   * advertises `<node>/list_parameters`, sorted. Read fresh on each call.
   *
   * Rejects with `ParameterServiceError` reason `'discovery-unavailable'`
   * when the client cannot see the robot's services at all (rosbridge with
   * rosapi not running, or a Foxglove bridge that does not offer services),
   * rather than resolving `[]`, which would read as a robot with no
   * parameters.
   *
   * On rosbridge the list is a `/rosapi/services` call, which
   * `options.timeoutMs` bounds; a read that times out also rejects as
   * `'discovery-unavailable'`, with the timeout as `cause`. On Foxglove
   * WebSocket the bridge pushes the list and the option has no request to
   * bound: right after `connect()` the call waits for the first list, up to
   * 2 s whatever `timeoutMs` says.
   */
  getParameterNodes(options?: CallServiceOptions): Promise<string[]>;

  /**
   * The names of `node`'s parameters (`list_parameters`). With `prefixes`,
   * only names under them; `depth` limits how many dot-separated levels below
   * a prefix are listed, and 0 (the default) lists every level.
   */
  listParameters(node: string, options?: ListParametersOptions): Promise<string[]>;

  /**
   * Read parameters of `node`: one {@link ParameterReading} per name in
   * `names`, in the same order.
   *
   * A ROS 2 node answers a request naming any undeclared parameter, or any
   * declared one without a value, with nothing at all for the whole request.
   * The library sends the names together and, when that happens, asks again
   * one name at a time, so one bad name never hides the others. A name that
   * still comes back empty is described once to tell `'not-set'` from
   * `'undeclared'`. A node started with `allow_undeclared_parameters`
   * answers for every name as if it were declared without a value, so on
   * such a node an unknown name reads as `'not-set'`, never `'undeclared'`.
   *
   * On rosbridge the bridge never sends a reply that holds a non-empty byte
   * array, so the library first asks the parameters' types and does not read
   * the byte-array ones: each comes back as `'unreadable'` (an empty one too,
   * since its length is not known without reading it), and the rest are read
   * as usual.
   *
   * `options.timeoutMs` bounds each request, not the whole call: a read that
   * has to re-ask names one at a time, or describe them, makes several
   * requests in turn, so the call can take a few times `timeoutMs`.
   *
   * @example
   * Reading the robot's URDF. `robot_state_publisher` holds it as its
   * `robot_description` parameter, the same way on every transport. The node
   * follows its launch namespace (`/robot1/robot_state_publisher`) and can be
   * renamed at launch, so look it up with `getParameterNodes()` when the
   * default name is not there.
   * ```ts
   * const [reading] = await client.getParameters('/robot_state_publisher', [
   *   'robot_description',
   * ]);
   * const urdf =
   *   reading?.state === 'set' && reading.value.type === 'string'
   *     ? reading.value.value
   *     : null;
   * ```
   */
  getParameters(
    node: string,
    names: readonly string[],
    options?: CallServiceOptions,
  ): Promise<ParameterReading[]>;

  /**
   * Describe parameters of `node`: one {@link ParameterDescription} per name
   * in `names`, in the same order (type, description, read-only, dynamic
   * typing, ranges, additional constraints). A request naming an undeclared
   * parameter is isolated the same way as in `getParameters`, and
   * `options.timeoutMs` likewise bounds each request rather than the call.
   */
  describeParameters(
    node: string,
    names: readonly string[],
    options?: CallServiceOptions,
  ): Promise<ParameterDescription[]>;

  /**
   * Change parameters of `node`, each on its own: the node applies every
   * change it accepts and refuses the rest. Resolves with one
   * {@link ParameterSetResult} per change, in the same order; a refused
   * change carries the node's reason. Rejects only when the node could not
   * be asked.
   */
  setParameters(
    node: string,
    changes: readonly ParameterChange[],
    options?: CallServiceOptions,
  ): Promise<ParameterSetResult[]>;

  /**
   * Change parameters of `node` all together or not at all. Resolves with the
   * node's one answer: `successful` false means none of the changes was
   * applied, and `reason` says why. ROS 2 has no change across several nodes
   * as one unit, so neither does this.
   */
  setParametersAtomically(
    node: string,
    changes: readonly ParameterChange[],
    options?: CallServiceOptions,
  ): Promise<ParameterAtomicResult>;

  // ── Schemas ─────────────────────────────────────────────────────────────

  /**
   * Returns a default JSON template for a message schema, with every field
   * set to its zero / empty default. Returns `null` if the schema is
   * unknown or the protocol does not carry it (rosbridge does not embed
   * schemas in its wire format; Foxglove WS does).
   *
   * Any message type the bridge describes is accepted, not only topic types:
   * on Foxglove WS that includes the request and response of an advertised
   * service (`std_srvs/srv/SetBool_Request`) and the goal of an advertised
   * action (`nav2_msgs/action/NavigateToPose_Goal`, the object
   * {@link IProtocolClient.sendActionGoal} takes). The goal needs the
   * action's hidden services, so a bridge launched without
   * `include_hidden:=true` returns `null` for it. A type with no fields gives
   * `{}`, so the keys of the template are the fields a request must name.
   */
  getSchemaTemplate(schemaName: string): Record<string, unknown> | null;

  /**
   * Describes a message type field by field: each field's type, which arrays
   * are fixed or bounded, string bounds, declared defaults, and the type's
   * constants. Resolves to `null` when the transport cannot describe the
   * type; never rejects for an unknown name.
   *
   * The answer is one flat map: {@link SchemaDefinition.root} is the type
   * asked for, and {@link SchemaDefinition.types} holds it and every type it
   * contains, each once, so a complex field's `type` is always a key of
   * `types`. Names are always in three parts (`geometry_msgs/msg/Point`),
   * whichever form the name was asked in or the bridge sent. Time and
   * duration fields are the nested types `builtin_interfaces/msg/Time` and
   * `builtin_interfaces/msg/Duration`, with fields `sec` and `nanosec`.
   *
   * - **Foxglove WebSocket:** every type {@link getSchemaTemplate} answers
   *   for that is described in ROS 2 `.msg` or IDL: topic types, the request
   *   and response of an advertised service, an action's goal. A channel
   *   described by JSON Schema or protobuf gives `null`. A service or goal
   *   type waits for the bridge's first service list after `connect()`, as
   *   service calls do; an advertised topic type answers at once.
   * - **rosbridge:** a message type some topic currently carries, read with
   *   one `/rosapi/topics_and_raw_types` call per lookup, and the request and
   *   response of the system services the library bundles (parameters,
   *   `CancelGoal`), with no call. Any other service or action type gives
   *   `null`. The library never asks rosapi's type-detail services, which
   *   stop `rosapi_node` on types with a bounded field on every released
   *   rosbridge.
   *
   * On both, `byte` and `char` fields read as `uint8`: the schema parsers
   * do not keep the difference.
   *
   * Every call returns new objects; changing them changes nothing in the
   * client.
   */
  getSchemaDefinition(schemaName: string): Promise<SchemaDefinition | null>;

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

  /**
   * Whether the server accepts publishing from this client, as far as the
   * transport says: `'allowed'`, `'refused'`, or `'unknown'` (ADR 0022). Use
   * it to grey out command controls before the user touches them.
   *
   * - **Foxglove WebSocket:** `'allowed'` when the bridge's `serverInfo` lists
   *   the `clientPublish` capability, `'refused'` when it does not. A
   *   `foxglove_bridge` launched without `clientPublish` in its `capabilities`
   *   parameter drops everything you publish, while `publish()` still returns
   *   normally and the status stays `'connected'`.
   * - **rosbridge:** always `'unknown'`. The protocol has no server-wide signal
   *   for it, and a topic refused by the server's `topics_pub_glob` is dropped
   *   with nothing on the wire.
   * - Before the first handshake and after disconnect: `'unknown'`.
   *
   * The answer is server-wide. `'allowed'` does not promise a given topic gets
   * through: a per-topic rule on the server (rosbridge `topics_pub_glob`, a
   * Foxglove topic whitelist) can still drop it. `publish()` behaves the same
   * whatever this returns; the library does not drop or throw on `'refused'`.
   *
   * The value changes only at a handshake, so re-read it when
   * {@link IProtocolClient.onStatusChange} reports `'connected'`; it is already
   * current inside that callback.
   */
  getPublishPermission(): PublishPermission;

  /**
   * How far, in milliseconds, the link's delay has risen above its own recent
   * floor, or `null` when this transport cannot tell (ADR 0028). A rising
   * value means messages are queuing somewhere between the robot and this
   * device: in the bridge, the network, or this device's socket layer.
   *
   * Read it beside the JS-thread lag from `getMaxLagMs()`. The value rising
   * while lag stays flat points at the link. Both rising points at this
   * device, or at both, because a busy JS thread also delays when frames
   * reach the library. The library does not act on the value: when to lower
   * a rate or warn the user is your decision.
   *
   * - **Foxglove WebSocket:** read from the timestamp the server puts on every
   *   message frame, against this device's clock. The clocks need not agree:
   *   each subscribed topic is measured against the lowest delay it has shown
   *   over the last ten minutes, so a constant offset cancels, even one that
   *   differs from topic to topic. The value is the largest of those readings,
   *   since every topic shares the one socket. It updates on every frame,
   *   including frames a rate cap keeps from your callback. A topic counts
   *   while its last frame is under ten seconds old and its circuit breaker
   *   has not paused it. Each new subscription to the server starts the
   *   topic's floor over: the first subscribe to a topic, a breaker
   *   re-subscribe, a re-subscribe after the server advertises the topic
   *   again, and every subscribe on a new connection, but not a second
   *   `subscribe()` to a topic already subscribed. So a latched replay
   *   stamped with its original time reads 0 when it arrives oldest first or
   *   is at most four messages (`foxglove_bridge` stamps a replay on delivery
   *   anyway). A frame stamped 0, or with the same stamp as the frame before,
   *   is not counted: the server does not stamp, or its clock stopped (a
   *   paused simulation, while it stays paused). `null` when no topic counts:
   *   before the first frame,
   *   once nothing is subscribed, and once every subscribed topic has gone
   *   quiet or stopped advancing its stamp.
   * - **rosbridge:** always `null`. Its JSON frames carry no server timestamp.
   *
   * Some cases read wrong, and the library cannot detect them. A bridge on
   * simulated time (`use_sim_time`) stamps frames with the simulation's clock,
   * so a simulation running slower or faster than real time makes the value
   * meaningless. A simulation that resumes after a pause, or is reset to an
   * earlier time, reads the pause or the rewind as backlog for up to ten
   * minutes. A robot
   * clock stepped backwards, a robot clock stepped forwards and then back, or
   * this device's clock stepped forwards by less than ten minutes (by NTP, or
   * by hand), reads as backlog for up to ten minutes; a larger forward step
   * starts the floor over and reads 0. More than four latched messages replayed
   * newest first (several latched publishers on one topic) can read as
   * backlog until a fresh message arrives.
   *
   * A link that delivers nothing at all reads `null` after ten seconds, not a
   * large number: no frames look the same as a publisher that stopped, so the
   * library does not guess. Pair it with your own check on when a topic you
   * expect last delivered.
   *
   * There is no drop count: neither bridge reports dropped messages, and ROS 2
   * messages carry no sequence number to infer one from. The value rises
   * before a full bridge queue starts dropping, which is the moment worth
   * acting on.
   */
  getLinkBacklogMs(): number | null;

  // ── Events ──────────────────────────────────────────────────────────────

  /**
   * Call `cb` with each new {@link ConnectionStatus}. `cb` is also called
   * once, right away, with the current status. Returns a function that
   * removes `cb`.
   *
   * After that first call, a status is reported only when it changes.
   * Subscriptions do not survive a reconnect: resubscribe when the status
   * changes to `'connected'`. The first call can itself be `'connected'`
   * when you register on a client that is already connected, so a handler
   * that resubscribes should skip it (or track the previous status), or it
   * subscribes twice.
   *
   * By the time `cb` hears `'connected'`, the `connect()` call that led there
   * has already succeeded. Calling `disconnect()` from inside `cb` closes the
   * connection; it does not turn that `connect()` into a cancellation.
   */
  onStatusChange(cb: (status: ConnectionStatus) => void): () => void;

  /**
   * Call `cb` with the full topic list (see {@link TopicInfo}) when the
   * transport reports a new one. Each call carries the whole list, not a
   * difference, so a handler that reacts to topics appearing should compare
   * against the list it saw last. Unlike `onStatusChange`, `cb` is not called
   * on registration: read `getAvailableTopics()` for the current list.
   * Returns a function that removes `cb`.
   *
   * - Foxglove WebSocket: `cb` fires for the list the bridge sends during the
   *   handshake, on connect and on every automatic reconnect, even when it is
   *   empty (the status is already `'connected'` by then), and then whenever
   *   the bridge advertises or unadvertises topics.
   * - rosbridge: `cb` fires when a discovery finds a set of topic names or
   *   types different from the previous one. The list starts empty on each
   *   connection, so the first discovery fires `cb` only if it finds at least
   *   one topic.
   * - Neither transport calls `cb` when the list empties on disconnect.
   */
  onTopicsChange(cb: (topics: TopicInfo[]) => void): () => void;

  /**
   * Call `cb` with each line the client writes to its connection log
   * (connects, discovery, reconnect attempts), prefixed with a
   * `[HH:MM:SS.mmm]` UTC time. Meant for an in-app diagnostics view; the
   * wording is not stable and should not be parsed. The same lines also go
   * to `ProtocolClientOptions.logger.log`. Returns a function that removes
   * `cb`.
   */
  onLog(cb: (log: string) => void): () => void;
}
