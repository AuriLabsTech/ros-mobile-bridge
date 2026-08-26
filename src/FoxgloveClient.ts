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
 *   attempts) after a connection that previously succeeded. After an automatic
 *   reconnect the prior subscriptions are NOT re-established — the consumer
 *   watches connection status and resubscribes.
 * - Zero-Twist on *intentional* disconnect only: `disconnect()` and the
 *   teardown paths publish a stop on `/cmd_vel` while the socket is still open.
 *   This cannot cover network loss, app kill, or a crash — the socket is
 *   already gone, so nothing can be sent. Halting the robot on those paths
 *   requires a robot-side `cmd_vel` watchdog; the library does not substitute
 *   for one.
 * - Control-priority outbox: gesture, E-Stop, and action-cancel publishes
 *   drain at the top of every incoming WS message handler so they ride out
 *   before the JS thread is consumed by the next parse macrotask.
 */

import { parse as parseRosMsgDef } from '@foxglove/rosmsg';
import { parseRos2idl } from '@foxglove/ros2idl-parser';
import { MessageReader, MessageWriter } from '@foxglove/rosmsg2-serialization';
import type { MessageDefinition } from '@foxglove/message-definition';
import {
  type ActionGoalHandle,
  type ActionGoalAcceptance,
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
import { getBundledServiceSchema } from './builtinSchemas';

const NOOP_LOGGER: ProtocolLogger = { log() {}, warn() {}, error() {} };

// Module-level singletons. `new TextEncoder()` / `new TextDecoder()` are
// cheap but not free, and the per-message hot path constructs one per call
// in the original code. Reusing matches what Node and browsers do
// internally for encoders without options.
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

// Base64 alphabet → 6-bit value. Built once; every other byte (padding `=`,
// whitespace, junk) stays -1 and is skipped during decode.
const B64_LOOKUP: Int16Array = (() => {
  const table = new Int16Array(256).fill(-1);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < chars.length; i++) table[chars.charCodeAt(i)] = i;
  return table;
})();

/**
 * Decode a base64 string to a byte array using only the library's allowed
 * globals. Only the JSON-op `serviceCallResponse` back-compat path still needs
 * this — outbound and inbound binary frames are byte-native. `atob` is
 * deliberately not used: it is outside the allowed global set (WebSocket,
 * TextEncoder/Decoder, typed arrays) and is absent on older React Native
 * (Hermes) runtimes; `Buffer` is Node-only and the `FileReader`/`Blob`
 * round-trip is RN-finicky.
 */
function base64ToUint8(b64: string): Uint8Array {
  let len = b64.length;
  while (len > 0 && b64.charCodeAt(len - 1) === 61 /* '=' */) len--;
  const out = new Uint8Array((len * 3) >> 2);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < len; i++) {
    const v = B64_LOOKUP[b64.charCodeAt(i)] ?? -1;
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 0xff;
    }
  }
  return o === out.length ? out : out.subarray(0, o);
}

/**
 * Generate a client-invented goal UUID (16 bytes, RFC 4122 v4 bit layout).
 * `Math.random` is deliberate: the `crypto` global is outside the library's
 * platform floor (absent on the React Native baseline), and the UUID is a
 * correlation key for filtering the action's shared status and feedback
 * topics, not a security token — collision odds across the handful of goals
 * a session dispatches are negligible.
 */
function generateGoalUuid(): Uint8Array {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return bytes;
}

function uuidBytesToHex(bytes: ArrayLike<number>): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += (bytes[i]! & 0xff).toString(16).padStart(2, '0');
  }
  return s;
}

/**
 * Normalize a goal UUID as it appears in a decoded message to a hex key, or
 * `null` when the value is not a 16-byte UUID in any known spelling. Three
 * spellings arrive in practice: a `Uint8Array` (CDR decode of `uint8[16]`),
 * a plain number array (JSON-encoded channels that serialize byte arrays as
 * arrays), and a base64 string (JSON serializers that pack byte arrays,
 * which is how a `foxglove_bridge` JSON channel ships them).
 */
function uuidValueToHex(value: unknown): string | null {
  if (value instanceof Uint8Array) {
    return value.length === 16 ? uuidBytesToHex(value) : null;
  }
  if (Array.isArray(value)) {
    return value.length === 16 ? uuidBytesToHex(value as number[]) : null;
  }
  if (typeof value === 'string') {
    const bytes = base64ToUint8(value);
    return bytes.length === 16 ? uuidBytesToHex(bytes) : null;
  }
  return null;
}

/** Terminal `action_msgs/msg/GoalStatus` floor: 4 SUCCEEDED, 5 CANCELED, 6 ABORTED. */
const GOAL_STATUS_TERMINAL_FLOOR = 4;

/**
 * The shortest valid CDR serialization of a ROS 2 message: the 4-byte CDR_LE
 * encapsulation header (`00 01 00 00`) followed by one zero byte.
 *
 * The trailing byte is not padding and not optional. `rosidl` gives a message
 * with no fields a single `uint8 structure_needs_at_least_one_member`, because
 * a zero-size struct is not representable in the C and C++ backends, so an
 * "empty" request such as `std_srvs/srv/Trigger` or `std_srvs/srv/Empty`
 * serializes to five bytes on the wire, never four. Up to 0.1.10 this fallback
 * sent the bare header, which is not a valid serialization of any ROS 2 type:
 * `foxglove_bridge` failed to deserialize it and answered `serviceCallFailure`
 * with "Internal server error: Service failed to send a response", naming a
 * server fault for a client-side encoding bug. Every `Trigger`- and
 * `Empty`-shaped service was uncallable, which covers the ordinary shape of a
 * robot's button actions: dock, undock, reset odometry, clear costmaps.
 *
 * Sent as the entire payload when a service is called with an empty request and
 * neither the bridge nor the built-in bundle has a schema for it. When a schema
 * is available the writer produces these same five bytes for a fieldless type,
 * so the fallback agrees with the schema-driven path rather than approximating
 * it. For a schemaless type that does have fields, this payload is still short,
 * exactly as the bare header was; such a call cannot be encoded without the
 * field layout, and the request is documented as a default-construction
 * sentinel rather than a guarantee. See {@link FoxgloveClient.getServiceDefs}
 * for the schema precedence that decides when this fallback is reached.
 */
const EMPTY_REQUEST_CDR = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x00]);

/**
 * The message definition of a type with no fields, used to decode a channel
 * or service whose description says the type has nothing in it.
 *
 * Produced by the parser rather than written as a literal so that the two
 * spellings of "no fields" a server can send, an empty schema string and a
 * whitespace-only one, compile to the identical reader. A decode contract
 * that depended on which spelling arrived would be an accident, not a
 * contract.
 */
const FIELDLESS_MESSAGE_DEFS: MessageDefinition[] = parseRosMsgDef('', { ros2: true });

/**
 * True when a channel or service advertisement describes a type with no
 * fields: `std_msgs/msg/Empty` published as a heartbeat is the ordinary case.
 *
 * Foxglove WS v1 makes `schema` a required field, so an empty string is a
 * value the server chose rather than one it left out. On `foxglove_bridge`'s
 * success path it means exactly one thing, that the type's definition file is
 * empty: the definition cache returns the file's literal bytes, and
 * `std_msgs/msg/Empty.msg` is a zero-byte file. Reading it as "no schema at
 * all" is the conflation that made every empty-request service uncallable up
 * to 0.1.10, and it failed the same invisible way on this path, with a
 * heartbeat surfacing as raw bytes instead of the empty object it is.
 *
 * This is never sufficient on its own. The same bridges emit an empty schema
 * when a definition *lookup* fails, so the caller must also check that the
 * channel declared a real message encoding: see the callers, and the
 * "Fieldless types" entry in `docs/PROTOCOLS.md` for why that field separates
 * the two cases.
 */
function isFieldlessSchema(schema: string | undefined): boolean {
  return schema === undefined || schema.trim() === '';
}

/**
 * True if `request` carries no fields to encode: `null`, `undefined`, or an
 * object literal with no own keys. Such a request is encoded from the
 * service's schema when one is available (zero-filled via `schemaToTemplate`)
 * and from {@link EMPTY_REQUEST_CDR} when none is. Non-empty requests
 * genuinely cannot be CDR-encoded without field-layout information and
 * surface a clear error.
 */
function isEmptyRequest(request: unknown): boolean {
  if (request === null || request === undefined) return true;
  if (typeof request !== 'object' || Array.isArray(request)) return false;
  return Object.keys(request as Record<string, unknown>).length === 0;
}

/**
 * True if a parsed `<Action>_SendGoal_Request` really does carry the goal as a
 * nested member.
 *
 * `rosidl` does not generate one: it emits `unique_identifier_msgs/UUID
 * goal_id` followed by the goal's own fields inlined at the root, which is
 * what three nav2 send-goal schemas captured from a live bridge show (jazzy,
 * foxglove-sdk-cpp v0.25.1; `tests/fixtures/`). The encoder still asks rather
 * than assuming, because CDR carries no field names: a payload whose keys do
 * not match the definition encodes without error, writing each unmatched field
 * from its schema default. Guessing wrong in either direction is silent on the
 * wire and arrives at the robot as a goal nobody asked for.
 *
 * The name alone is not the witness, because a goal may declare a member of
 * its own called `goal`: nav2's `ComputePathToPose` does, as
 * `geometry_msgs/PoseStamped goal` beside `start`, `planner_id` and
 * `use_start`. Inlined, that field sits at the root looking exactly like a
 * wrapper. The **type** separates them, and it is the one thing `rosidl`
 * fixes about the wrapper: it is always named `<Action>_Goal` (ADR 0013).
 * A field named `goal` whose type does not end in `_Goal` is the goal's own
 * data and the request is flat.
 */
function requestNestsGoal(defs: MessageDefinition[]): boolean {
  const root = defs[0];
  if (!root) return false;
  return root.definitions.some(
    (f) =>
      f.name === 'goal' &&
      f.isComplex === true &&
      f.isArray !== true &&
      !f.isConstant &&
      isGoalWrapperType(f.type),
  );
}

/**
 * True if a field's declared type is the `rosidl`-generated goal wrapper,
 * `<Action>_Goal`. Compared on the bare type name, so `my_pkg/Dock_Goal` and
 * `my_pkg/action/Dock_Goal` answer the same, and a type that is nothing but
 * `_Goal` does not count as one.
 */
function isGoalWrapperType(type: string): boolean {
  const bare = type.slice(type.lastIndexOf('/') + 1);
  return bare.length > '_Goal'.length && bare.endsWith('_Goal');
}

/**
 * Read the payload out of a decoded ROS 2 action envelope, whichever way the
 * bridge advertised it.
 *
 * The advertised definition inlines the action-generated wrapper types —
 * `<Action>_Goal`, `_Feedback`, `_Result` — into the root of the type that
 * carries them, putting a comment where a `MSG:` separator would go. Ordinary message types
 * keep their sections, so only these three members are ever in question, and
 * only on the three legs that carry one: the send-goal request, the feedback
 * message, and the GetResult response. Status and `cancel_goal` nest
 * `action_msgs/GoalInfo`, an ordinary type, and are not affected.
 *
 * The decoded record's own shape is the answer, because the reader populates
 * every member the definition declares: a present `member` means the bridge
 * nested, an absent one means the fields are at the root beside the envelope
 * keys named in `exclude`. Recognized by evidence, never by count (ADR 0010),
 * and the same rule the GetResult lift has used since 0.1.11 (ADR 0011).
 *
 * A payload field whose name collides with an excluded envelope key is lost
 * on the inlined branch. That is inherent to a wire format the bridge has
 * already flattened, and it is the tradeoff the GetResult lift takes with
 * `status`.
 */
function liftActionWrapper(
  rec: Record<string, unknown>,
  member: string,
  ...exclude: string[]
): Record<string, unknown> {
  const nested = rec[member];
  if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  const lifted: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (k !== member && !exclude.includes(k)) lifted[k] = v;
  }
  return lifted;
}

/**
 * Parse a Foxglove-WS-advertised service or channel schema string into the
 * `MessageDefinition[]` shape both `MessageReader` and `MessageWriter`
 * accept. Uses the declared `schemaEncoding` first; falls back to the same
 * heuristic order `getSchemaTemplate` uses when the bridge doesn't set it.
 * Throws if no parser handles the string.
 */
function parseFoxgloveSchema(
  schemaStr: string,
  encodingHint: string | undefined,
): MessageDefinition[] {
  const declared = (encodingHint ?? '').toLowerCase();
  const tryRos2idl = (): MessageDefinition[] | null => {
    try {
      return parseRos2idl(schemaStr);
    } catch {
      return null;
    }
  };
  const tryRos2msg = (): MessageDefinition[] | null => {
    try {
      return parseRosMsgDef(schemaStr, { ros2: true });
    } catch {
      return null;
    }
  };

  const order = declared === 'ros2idl' ? [tryRos2idl, tryRos2msg] : [tryRos2msg, tryRos2idl];
  for (const attempt of order) {
    const defs = attempt();
    if (defs && defs.length > 0) return defs;
  }
  throw new Error(
    `Could not parse schema (encodingHint=${encodingHint ?? 'none'}, preview="${schemaStr.substring(0, 80)}")`,
  );
}

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

interface FoxgloveServiceFailure {
  op: 'serviceCallFailure';
  callId: number;
  message?: string;
}

/**
 * A dispatched service call: the answer, and a way to stop waiting for it.
 *
 * `forget` drops the call from the pending table without settling its
 * promise. It is disposal, not cancellation: Foxglove WS v1 has no frame for
 * withdrawing a request, so the server may still answer and we simply stop
 * caring. A bounded call clears itself when its timer fires; an unbounded one
 * has nothing to clear it, which is what this exists for (ADR 0009).
 */
interface DispatchedServiceCall {
  promise: Promise<Record<string, unknown>>;
  forget: () => void;
}

/**
 * One side (request or response) of a service advertisement, as carried in
 * the nested `request` / `response` objects of an `advertiseServices` entry.
 *
 * This is the **current** wire form. The flat `requestSchema` /
 * `responseSchema` fields on {@link FoxgloveService} are the legacy one; the
 * ws-protocol spec keeps them only "for backwards compatibilty, prefer using
 * `request` instead". Modern bridges (observed: `foxglove_bridge` 3.4.1 /
 * foxglove-sdk-cpp v0.25.1) send the nested objects and none of the flat
 * fields.
 */
interface FoxgloveServiceSchema {
  /**
   * Payload serialization for this side (`"cdr"`, `"json"`). Read for
   * completeness; requests are always sent as CDR regardless, see the
   * encoding note in {@link FoxgloveClient.callService}.
   */
  encoding?: string;
  /** ROS type name the schema describes, e.g. `std_srvs/srv/SetBool_Request`. */
  schemaName?: string;
  /** Schema-format hint (`"ros2msg"`, `"ros2idl"`, ...). */
  schemaEncoding?: string;
  /** Definition text in the format named by `schemaEncoding`. */
  schema?: string;
}

interface FoxgloveService {
  id: number;
  name: string;
  type: string;
  /** Current-form request schema. Takes precedence over `requestSchema`. */
  request?: FoxgloveServiceSchema;
  /** Current-form response schema. Takes precedence over `responseSchema`. */
  response?: FoxgloveServiceSchema;
  /** Legacy flat request schema. Superseded by `request`. */
  requestSchema?: string;
  /** Legacy flat response schema. Superseded by `response`. */
  responseSchema?: string;
  /**
   * Schema-format hint (`"ros2idl"`, `"ros2msg"`, ...) for the *request*.
   * Not in the spec, which derives the flat pair's encoding from
   * `supportedEncodings`; read leniently because some bridges send it.
   */
  requestSchemaEncoding?: string;
  /** Schema-format hint for the *response*. Same caveat as the request side. */
  responseSchemaEncoding?: string;
}

/**
 * Pick the schema text and format hint for one side of a service, preferring
 * the nested `request` / `response` objects over the legacy flat fields, as
 * the ws-protocol spec directs.
 *
 * The two forms are never mixed: whichever side supplies the definition text
 * also supplies the format hint, so a nested schema is never parsed under a
 * flat encoding hint that describes a different string. Returns `null` when
 * the bridge advertised no usable schema on this side, which is the caller's
 * signal to fall back to the built-in bundle.
 */
function resolveServiceSchema(
  svc: FoxgloveService,
  side: 'request' | 'response',
): { schema: string; encoding: string | undefined } | null {
  const nested = side === 'request' ? svc.request : svc.response;
  if (nested?.schema) {
    return { schema: nested.schema, encoding: nested.schemaEncoding };
  }
  const flat = side === 'request' ? svc.requestSchema : svc.responseSchema;
  if (flat) {
    const encoding = side === 'request' ? svc.requestSchemaEncoding : svc.responseSchemaEncoding;
    return { schema: flat, encoding };
  }
  return null;
}

/**
 * True when the advertisement carries a description for this side of the
 * service and that description says the type has no fields.
 *
 * Deliberately distinct from {@link resolveServiceSchema} returning `null`:
 * that means the server said nothing about this side, while this means the
 * server described it as empty. `std_srvs/srv/Empty` and every `.srv` whose
 * response side is bare hit this, which is the response-side twin of the
 * request-side case fixed in 0.1.10.
 */
function describesFieldlessService(svc: FoxgloveService, side: 'request' | 'response'): boolean {
  const nested = side === 'request' ? svc.request : svc.response;
  if (nested && nested.schema !== undefined) return isFieldlessSchema(nested.schema);
  const flat = side === 'request' ? svc.requestSchema : svc.responseSchema;
  if (flat !== undefined) return isFieldlessSchema(flat);
  return false;
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
  | FoxgloveServiceFailure
  | { op: string; [key: string]: unknown };

// ─── Constants ───────────────────────────────────────────────────────────────

// Subprotocol negotiation: send both, server picks the one it supports.
// - foxglove.sdk.v1:       Foxglove Bridge 3.x+ (ROS 2 Jazzy+), adds CDR services + schemas op
// - foxglove.websocket.v1: Foxglove Bridge 1.x-2.x (Humble/Iron), standard ws-protocol
// Wire format (opcodes, binary layout, JSON ops) is identical across both.
const SUBPROTOCOLS = ['foxglove.sdk.v1', 'foxglove.websocket.v1'];
const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RECONNECT_DELAY_MS = 1_000;
const CONNECTION_TIMEOUT_MS = 10_000;

const ZERO_TWIST = {
  linear: { x: 0, y: 0, z: 0 },
  angular: { x: 0, y: 0, z: 0 },
};

const CMD_VEL_SCHEMA = 'geometry_msgs/msg/Twist';

// Binary op-codes (Foxglove WS v1). Per spec the numbering is *per
// direction* — 0x02 means TIME inbound but SERVICE_CALL_REQUEST outbound
// — so we keep two enums to make directionality explicit at call sites.
//
// Server → client opcodes we consume. 0x02 TIME and 0x04
// FETCH_ASSET_RESPONSE are spec-listed but not used here yet.
// SERVICE_CALL_FAILURE is deliberately absent: per spec it travels as the
// JSON op `serviceCallFailure`, not as a binary frame.
enum BinaryOpcode {
  MESSAGE_DATA = 0x01,
  SERVICE_CALL_RESPONSE = 0x03,
}

// Client → server opcodes we emit. Subset of the spec; the rest of the
// client→server surface (subscribe, advertise, getParameters, ...) is
// JSON ops sent via `sendJson`.
enum ClientBinaryOpcode {
  MESSAGE_DATA = 0x01,
  SERVICE_CALL_REQUEST = 0x02,
}

// Per-callback subscription state. One entry per `onMessage` registered
// against a topic; `dispatchMode` and the deferred-drain fields below it are
// only exercised by `latest-only` subscribers.
interface CallbackEntry {
  userMinIntervalMs: number | undefined;
  disableAdaptive: boolean;
  lastDeliveredAt: number;
  dispatchMode: 'immediate' | 'latest-only';
  // `latest-only` deferred-drain state. `pending` holds a materialized
  // (owned) copy of the newest un-delivered payload; `drainTimer` is the armed
  // timer that will parse and deliver it. Both null in `immediate`.
  //
  // `encoding` and `schemaName` are captured at stash time rather than read at
  // drain time: they describe the channel the bytes actually arrived on, and
  // that channel can be unadvertised (a dying publisher) or re-advertised under
  // a new id with a different type while the drain is armed. Trailing delivery
  // makes that window as long as the throttle interval, so reading them late
  // would relabel a CDR payload as JSON on an empty schema and skip its reader.
  pending: {
    payload: Uint8Array;
    sec: number;
    nsec: number;
    encoding: string;
    schemaName: string;
  } | null;
  drainTimer: ReturnType<typeof setTimeout> | null;
}

// ─── Implementation ──────────────────────────────────────────────────────────

export class FoxgloveClient implements IProtocolClient {
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
    // `options.onLatency` is intentionally not consumed here. The earlier
    // JSON-op `ping`/`pong` keep-alive that drove RTT measurement is not
    // in the Foxglove WS v1 spec; current bridges reject it with a
    // status-level-2 error. WebSocket-level RFC 6455 ping/pong handles
    // connection liveness automatically but is not portably accessible
    // from JS (browsers don't expose `ws.ping()`). Until the spec or a
    // host-injected probe gives us a portable signal, FoxgloveClient
    // leaves `onLatency` quiescent. RosbridgeClient still drives it.
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
      callbacks: Map<(msg: RosMessage) => void, CallbackEntry>;
      bandwidth: BandwidthTracker;
      breaker: CircuitBreaker;
      isPaused: boolean;
    }
  >();
  private topicToSubscriptionId = new Map<string, number>();
  // Pending subscriptions: subscribe() was called while connected, but the
  // channel is not advertised yet, so no wire frame can carry it (the
  // subscribe op requires a channelId). Callbacks and their options are held
  // here until `handleAdvertise` sees the topic and activates them through
  // the normal subscribe path. Cleared by cleanup(): pendings follow the same
  // reconnect contract as established subscriptions.
  private pendingSubscriptions = new Map<
    string,
    Map<(msg: RosMessage) => void, SubscribeOptions | undefined>
  >();
  private breakerListeners = new Map<string, Set<(state: CircuitBreakerState) => void>>();

  // CDR message readers — keyed by subscriptionId, created from channel schema.
  private messageReaders = new Map<number, MessageReader>();

  // Subscriptions whose reader was invented from a description with no fields
  // in it, rather than compiled from a schema the server sent. Recorded when
  // the reader is built and never re-derived from channel state: a
  // `latest-only` drain can run after its channel is unadvertised, and the
  // property being recorded belongs to the reader, not to the live channel
  // map. Cleaned up wherever `messageReaders` is.
  private fieldlessReaders = new Set<number>();

  // Channels already warned about a fieldless description the payload
  // contradicted. Keyed by channelId so the warning survives a resubscribe
  // and still fires once per offending channel rather than once per message.
  private fieldlessMismatchWarned = new Set<number>();

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
      // `null` = no deadline: the action composition's dispatch and standing
      // get_result (see callServiceInternal). Every cleanup path must
      // null-check.
      timer: ReturnType<typeof setTimeout> | null;
      // An action composition owns this call. A failure frame that names no
      // callId makes no claim about it, so the blunt level-2 path leaves it
      // alone (ADR 0009). A disconnect still clears it: that one is not a
      // claim about a call, it is the end of the connection.
      actionOwned: boolean;
    }
  >();
  private availableServices = new Map<string, FoxgloveService>();

  // In-flight goal dispatches, keyed by the client-invented goal UUID (hex).
  // Held only so connection teardown can reject every outstanding outcome as
  // 'disconnected'; the resolve path lives in per-dispatch closures.
  private pendingActionGoals = new Map<
    string,
    { action: string; fail: (e: ActionGoalError) => void }
  >();
  /**
   * Per-service CDR codecs. Compiled lazily on first call from the schema
   * the bridge shipped in `advertiseServices`. Foxglove WS service requests
   * and responses are CDR-encoded for ROS 2; the codec parses the bare
   * Request/Response struct (the bridge handles `rmw_request_id_t` wrapping).
   */
  // The defs caches hold the parsed MessageDefinition[] keyed by service id.
  // Keeping them alongside the writer/reader caches buys two things: cheap
  // lookup of zero-value defaults (via schemaToTemplate) when the caller
  // passes an empty request, and a single source of truth for "where did
  // this schema come from" (bridge-advertised, bundled fallback, or neither).
  private serviceRequestDefs = new Map<number, MessageDefinition[]>();
  private serviceResponseDefs = new Map<number, MessageDefinition[]>();
  private serviceRequestWriters = new Map<number, MessageWriter>();
  private serviceResponseReaders = new Map<number, MessageReader>();

  // Reconnection
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalDisconnect = false;

  // Connection handshake
  private connectResolve: (() => void) | null = null;
  private connectReject: ((e: Error) => void) | null = null;
  // The promise the current initial connect() caller holds. Kept so a
  // library-initiated cancellation (signal abort, disconnect() mid-attempt)
  // can pre-handle it before rejecting — a fire-and-forget caller must not
  // get an unhandled rejection for a cancellation it asked for (ADR 0003).
  private pendingConnect: Promise<void> | null = null;
  private serverInfoReceived = false;
  private lastError: Error | null = null;

  getLastError(): Error | null {
    return this.lastError;
  }

  get isConnected(): boolean {
    return this.status === 'connected';
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

    this.log(`Opening WebSocket to ${this.url}...`);
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

    // Drain pending control-priority publishes BEFORE closing the socket.
    // Without this, an Action Client cancel-goal queued via the outbox +
    // setTimeout(0) gets dropped when cleanup() closes the websocket — the
    // macrotask scheduler hadn't fired yet, so the E-Stop's cancel never
    // reaches the robot. Uncapped: anything left behind by a batched drain
    // dies with the socket, which is the same silent drop one tick later.
    this.flushControlOutbox('all');

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
    // subscribe() requires a connected client; both transports behave the
    // same. Without this guard an empty channel map would route a
    // subscribe-while-disconnected into the pending path, quietly turning it
    // into subscribe-before-connect support on one transport only.
    if (!this.ws || this.status !== 'connected') {
      this.logger.warn(`[FoxgloveClient] subscribe("${topic}") ignored: client is not connected.`);
      return () => {};
    }

    const userMinIntervalMs =
      options?.maxFrequency && options.maxFrequency > 0 ? 1000 / options.maxFrequency : undefined;
    const disableAdaptive = options?.disableAdaptive ?? false;
    const dispatchMode = options?.dispatchMode ?? 'immediate';

    const existingSubId = this.topicToSubscriptionId.get(topic);
    if (existingSubId !== undefined) {
      const sub = this.subscriptions.get(existingSubId);
      if (sub) {
        sub.callbacks.set(onMessage, {
          userMinIntervalMs,
          disableAdaptive,
          lastDeliveredAt: 0,
          dispatchMode,
          pending: null,
          drainTimer: null,
        });
        return () => this.removeSubscriptionCallback(topic, onMessage);
      }
    }

    const channelId = this.topicToChannelId.get(topic);
    if (channelId === undefined) {
      // Not advertised yet: hold the subscription off the wire until the
      // channel appears. The client cannot distinguish a typo'd topic from
      // one that will advertise later (mode-gated topics); that judgment is
      // the consumer's, built on getSubscriptionState + onTopicsChange.
      let pending = this.pendingSubscriptions.get(topic);
      if (!pending) {
        pending = new Map();
        this.pendingSubscriptions.set(topic, pending);
      }
      pending.set(onMessage, options);
      this.log(`Topic "${topic}" not advertised yet; subscription is pending until it appears.`);
      return () => this.removeSubscriptionCallback(topic, onMessage);
    }

    const subscriptionId = this.nextSubscriptionId++;
    const callbacks = new Map<(msg: RosMessage) => void, CallbackEntry>();
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
        const sub = this.subscriptions.get(subscriptionId);
        if (!sub) return;
        sub.isPaused = newState === 'tripped_auto' || newState === 'tripped_manual';
        // A breaker trip discards any pending latest-only payload: the bytes
        // are stale (the topic tripped *because* it was saturating) and we
        // must not deliver after pausing the subscription.
        if (sub.isPaused) this.cancelAllDrains(sub);
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
    } else if (channel && isFieldlessSchema(channel.schema) && channel.encoding === 'cdr') {
      // The channel declared a real message encoding and described its type as
      // having no fields, which on both first-party bridges is reachable only
      // from the success path: a lookup failure leaves `encoding` empty. So
      // this is a fieldless type, and it reads like any other type, through a
      // reader built from a definition with nothing in it.
      //
      // Nothing here inspects the payload's length. A fieldless message is not
      // one fixed size on the wire: RTPS pads a submessage to a 32-bit
      // boundary and that padding is indistinguishable from payload at the
      // receiver, so the same message reaches this client as 5 bytes or 8
      // depending on the middleware underneath the bridge. `decodePayload`
      // corroborates with the payload's structure instead.
      this.log(`Creating fieldless reader for "${topic}" (schemaName=${channel.schemaName})`);
      this.messageReaders.set(subscriptionId, new MessageReader(FIELDLESS_MESSAGE_DEFS));
      this.fieldlessReaders.add(subscriptionId);
    }

    this.sendJson({
      op: 'subscribe',
      subscriptions: [{ id: subscriptionId, channelId }],
    });

    return () => this.removeSubscriptionCallback(topic, onMessage);
  }

  /**
   * Detach `onMessage` from `topic` wherever the subscription currently
   * lives — the pending map, or the active subscription the topic resolves
   * to *now*. Every unsubscribe closure routes here, keyed by the stable
   * (topic, callback) pair rather than by a captured subscription id: a
   * subscription can be demoted to pending and re-established under a new
   * subscription id while a consumer holds an old closure (a channel
   * unadvertised and re-advertised across an action-server restart), and a
   * closure bound to the dead id would detach nothing — or worse, tear down
   * the live successor's topic mapping.
   */
  private removeSubscriptionCallback(topic: string, onMessage: (msg: RosMessage) => void): void {
    // A demoted (unmapped) predecessor of this topic may still hold an armed
    // drain for this callback. Unsubscribing must drop that pending frame —
    // the contract is no delivery after unsubscribe — so cancel it wherever
    // a zombie carries it before detaching from the live state.
    for (const [subId, sub] of this.subscriptions) {
      if (sub.topic !== topic) continue;
      if (this.topicToSubscriptionId.get(topic) === subId) continue;
      const entry = sub.callbacks.get(onMessage);
      if (entry) {
        this.cancelDrain(entry);
        sub.callbacks.delete(onMessage);
        this.reapDemotedSubscription(subId);
      }
    }

    const entries = this.pendingSubscriptions.get(topic);
    if (entries?.delete(onMessage)) {
      if (entries.size === 0) this.pendingSubscriptions.delete(topic);
      return;
    }
    this.removeActiveCallback(topic, onMessage);
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
      // Conflate-on-replace by destination. If an entry for this channel is
      // already pending, replace it with the new one rather than appending.
      // Under sustained JS-thread saturation the outbox can accumulate dozens
      // of stale control-priority publishes (e.g. a 30 Hz joystick streaming
      // /cmd_vel while the thread is blocked by a camera decode); without
      // conflation a release-the-joystick zero-Twist queued behind them
      // drains LAST, so the robot keeps moving until every stale frame has
      // been sent. With conflation the zero replaces the stale entry at the
      // same slot and the robot stops in one WS send. The latest publish IS
      // the latest intent — including a stop command. Insertion order across
      // distinct topics is preserved (replace happens in place); only
      // intra-topic duplicates collapse.
      const existing = this.controlOutbox.findIndex((e) => e.channelId === clientChannelId);
      if (existing >= 0) {
        this.controlOutbox[existing] = { channelId: clientChannelId, data };
      } else {
        this.controlOutbox.push({ channelId: clientChannelId, data });
      }
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

  /**
   * Drain the control-priority outbox to the socket.
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
   */
  private flushControlOutbox(mode: 'batch' | 'all' = 'batch'): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.controlOutbox.length = 0;
      return;
    }
    const budget = mode === 'all' ? Infinity : FoxgloveClient.CONTROL_FLUSH_BATCH;
    let drained = 0;
    while (this.controlOutbox.length > 0 && drained < budget) {
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
    view.setUint8(0, ClientBinaryOpcode.MESSAGE_DATA);
    view.setUint32(1, channelId, true);
    new Uint8Array(buffer, 5).set(payloadBytes);

    // Send as a typed array, not the raw ArrayBuffer. React Native's
    // WebSocket native bridge silently drops `send(ArrayBuffer)` payloads
    // above roughly 400 bytes (verified via tcpdump on a real robot: a
    // 16-name get_parameters request never left the device). The Uint8Array path
    // goes through a different RN native serializer that handles every
    // size we send. Same bytes on the wire on browsers/Node; this is
    // load-bearing for RN. Do not revert.
    this.ws.send(new Uint8Array(buffer));
  }

  /**
   * Send a service-call request as a binary opcode-0x02 frame. Per
   * Foxglove WS v1 spec, SERVICE_CALL_REQUEST is binary only; the JSON op
   * `serviceCallRequest` that earlier revisions used is not in the spec
   * and is rejected by current bridges with a `status` level-2 message,
   * which leaves the in-flight callId hanging until the 30 s timeout.
   *
   * Frame layout mirrors the inbound 0x03 SERVICE_CALL_RESPONSE parser:
   *   [uint8 op=0x02][uint32 serviceId LE][uint32 callId LE]
   *   [uint32 encLen LE][utf8 encoding][bytes payload]
   */
  private sendBinaryServiceCallRequest(
    serviceId: number,
    callId: number,
    encoding: string,
    payload: Uint8Array,
  ): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const encodingBytes = TEXT_ENCODER.encode(encoding);
    const buffer = new ArrayBuffer(1 + 4 + 4 + 4 + encodingBytes.byteLength + payload.byteLength);
    const view = new DataView(buffer);
    view.setUint8(0, ClientBinaryOpcode.SERVICE_CALL_REQUEST);
    view.setUint32(1, serviceId, true);
    view.setUint32(5, callId, true);
    view.setUint32(9, encodingBytes.byteLength, true);
    new Uint8Array(buffer, 13, encodingBytes.byteLength).set(encodingBytes);
    new Uint8Array(buffer, 13 + encodingBytes.byteLength).set(payload);
    // Typed-array send, not raw ArrayBuffer — see comment in
    // sendBinaryMessage. RN drops ArrayBuffer payloads above ~400 bytes,
    // which manifested as 16-name get_parameters requests silently
    // never leaving the device.
    this.ws.send(new Uint8Array(buffer));
  }

  // Deliberately not `async`: an invalid `timeoutMs` is a programmer error
  // and throws synchronously (mirroring RosbridgeClient), while runtime
  // failures — not connected, service unknown, timeout — stay promise
  // rejections, exactly as before.
  callService(
    service: string,
    request: Record<string, unknown>,
    options?: CallServiceOptions,
  ): Promise<Record<string, unknown>> {
    // Foxglove WS has no wire-level timeout, so the caller's value governs
    // the local timer directly; there is no backstop margin to add because
    // there is no server-reasoned frame to wait for.
    const timeoutMs = options?.timeoutMs;
    validateCallServiceTimeoutMs(timeoutMs);
    return this.callServiceInternal(service, request, timeoutMs).promise;
  }

  /**
   * Shared dispatch for the public {@link callService} and the action
   * composition's standing `get_result`. `timeoutMs` semantics: a number
   * arms that local deadline, `undefined` arms the 30 s default, and `null`
   * — internal callers only, never reachable from the public surface —
   * arms no deadline at all. The action composition's calls must be unbounded
   * because a goal's lifetime is not time-bounded, which the no-deadline
   * doctrine (ADR 0006/0007/0009) deliberately leaves untimed.
   *
   * `options.actionOwned` marks the call as belonging to an action
   * composition, which exempts it from the blunt level-2 rejection path (ADR
   * 0009 decision 3). See {@link DispatchedServiceCall} for `forget`.
   */
  private callServiceInternal(
    service: string,
    request: Record<string, unknown>,
    timeoutMs: number | undefined | null,
    options?: { actionOwned?: boolean },
  ): DispatchedServiceCall {
    if (!this.ws || this.status !== 'connected') {
      return { promise: Promise.reject(new Error('Not connected')), forget: () => {} };
    }

    const serviceInfo = this.availableServices.get(service);
    if (!serviceInfo) {
      return {
        promise: Promise.reject(new Error(`Service "${service}" not available`)),
        forget: () => {},
      };
    }

    const callId = this.nextServiceCallId++;

    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      if (timeoutMs !== null) {
        const armMs = timeoutMs ?? 30_000;
        timer = setTimeout(() => {
          this.pendingServiceCalls.delete(callId);
          reject(
            timeoutMs !== undefined
              ? new Error(`Service call "${service}" timed out after ${timeoutMs}ms`)
              : new Error(`Service call "${service}" timed out after 30s`),
          );
        }, armMs);
      }

      this.pendingServiceCalls.set(callId, {
        resolve,
        reject,
        timer,
        actionOwned: options?.actionOwned === true,
      });

      // Encode the request as CDR. JSON-encoded service requests are
      // rejected by foxglove-sdk-cpp v0.18.0+ ("Unsupported encoding") even
      // though the server advertises `supportedEncodings: ["cdr", "json"]`
      // — that capability applies to topic messages, not service calls.
      // CDR is the canonical encoding for ROS 2 services and is accepted
      // by every SDK version.
      //
      // Schema sourcing is layered, in this order:
      //   1. Bridge-advertised schema, authoritative when present. Read via
      //      `resolveServiceSchema`, which prefers the nested `request` /
      //      `response` objects and treats the flat `requestSchema` pair as
      //      the legacy fallback. Reading only the flat pair is what made
      //      every non-bundled service on a modern bridge unusable up to
      //      0.1.7: a 3.4.1 apt binary (foxglove-sdk-cpp v0.25.1) advertises
      //      full ros2msg text for all 74 of its services and sends the flat
      //      fields on none of them.
      //   2. Bundled IDL fallback (rcl_interfaces parameter ops,
      //      action_msgs/CancelGoal). A defensive floor for the universal
      //      system types, for bridges that advertise a service with no
      //      inline IDL at all and for schemas we cannot parse. Nothing
      //      beyond those types can be covered here, which is why layer 1
      //      has to work: `<pkg>/action/<Action>_SendGoal` is per-action and
      //      unbundlable by construction.
      //   3. No defs at all — empty requests fall back to the shortest
      //      valid ROS 2 serialization, the encapsulation header plus
      //      rosidl's one dummy member byte (`EMPTY_REQUEST_CDR`), which
      //      is exactly what a fieldless request type encodes to;
      //      non-empty requests cannot be encoded without field layout
      //      and surface an explicit error.
      //
      // When defs *are* available (cases 1 and 2), an empty caller request
      // is filled with zero values via `schemaToTemplate` rather than
      // rejected on missing fields. That makes `{}` a stable "default
      // request" sentinel across both sim and real-bridge configurations.
      let payloadBytes: Uint8Array;
      try {
        const reqDefs = this.getRequestDefs(serviceInfo);
        if (reqDefs) {
          const writer = this.getOrCompileRequestWriter(serviceInfo.id, reqDefs);
          const payload = isEmptyRequest(request) ? schemaToTemplate(reqDefs) : request;
          payloadBytes = writer.writeMessage(payload);
        } else if (isEmptyRequest(request)) {
          payloadBytes = EMPTY_REQUEST_CDR;
        } else {
          throw new Error(
            `Service "${service}" (type "${serviceInfo.type}") has no usable request schema: the bridge advertised none, none could be parsed, and this type is not in the built-in fallback bundle. Cannot encode a non-empty CDR request. ` +
              `Empty requests still work via the empty-message fallback. If the bridge did advertise a schema, a warning naming the parse failure was logged when it was read.`,
          );
        }
      } catch (err) {
        if (timer !== null) clearTimeout(timer);
        this.pendingServiceCalls.delete(callId);
        reject(
          new Error(
            `Failed to encode request for "${service}": ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        return;
      }

      this.sendBinaryServiceCallRequest(serviceInfo.id, callId, 'cdr', payloadBytes);
    });

    return {
      promise,
      forget: () => {
        const pending = this.pendingServiceCalls.get(callId);
        if (!pending) return;
        if (pending.timer !== null) clearTimeout(pending.timer);
        this.pendingServiceCalls.delete(callId);
      },
    };
  }

  // `_actionType` is unused on this transport: every schema the composition
  // needs (send_goal, get_result, cancel, status, feedback) arrives from the
  // bridge's own advertisements. The parameter exists for interface parity —
  // rosbridge cannot dispatch without it.
  sendActionGoal(
    action: string,
    _actionType: string,
    goal: Record<string, unknown>,
    options?: SendActionGoalOptions,
  ): ActionGoalHandle {
    if (!this.ws || this.status !== 'connected') {
      throw new Error('Not connected');
    }

    const uuid = generateGoalUuid();
    const uuidArr = Array.from(uuid);
    const key = uuidBytesToHex(uuid);
    const sendGoalService = `${action}/_action/send_goal`;

    let resolveOutcome!: (o: ActionGoalOutcome) => void;
    let rejectOutcome!: (e: Error) => void;
    const outcome = new Promise<ActionGoalOutcome>((res, rej) => {
      resolveOutcome = res;
      rejectOutcome = rej;
    });

    // Acceptance (ADR 0012). Resolves on evidence, never on a clock, and
    // never rejects: most callers will not await it, and a rejecting promise
    // nobody awaits is an unhandled-rejection trap in every runtime this
    // library targets. Four sources feed it, whichever lands first — the
    // dispatch response, a status entry naming the goal, a per-goal feedback
    // frame, and a terminal that implies the goal ran — and `finish` supplies
    // `'unobservable'` for a goal that ends having produced none of them.
    //
    // Three of the four are always present. The feedback source is not: the
    // subscription below is created only when the caller passed `onFeedback`,
    // because feedback is opt-in (ADR 0006 decision 5) and this client does
    // not subscribe to a topic nobody asked for. Nothing is lost by that on
    // this transport, and a rig bench on 2026-08-26 measured why: the
    // dispatch response carries `bool accepted` and arrived 6.2 ms before the
    // first feedback frame, with the feedback callback having fired zero
    // times when acceptance settled. Feedback is a redundant source here, not
    // a load-bearing one.
    let resolveAcceptance!: (a: ActionGoalAcceptance) => void;
    const acceptance = new Promise<ActionGoalAcceptance>((res) => {
      resolveAcceptance = res;
    });
    let acceptanceSettled = false;
    const settleAcceptance = (value: ActionGoalAcceptance): void => {
      if (acceptanceSettled) return;
      acceptanceSettled = true;
      resolveAcceptance(value);
    };

    let settled = false;
    let unsubStatus: (() => void) | null = null;
    let unsubFeedback: (() => void) | null = null;

    // Disposal for the composition's unbounded requests. They carry no timer
    // by design, so a goal that ends while one is still outstanding (the
    // ordinary shape of a lost dispatch answer) has to drop them itself, or
    // they sit in the pending table until the next disconnect (ADR 0009
    // decision 5).
    let forgetDispatch: (() => void) | null = null;
    let forgetStandingResult: (() => void) | null = null;
    const forgetPendingCalls = (): void => {
      if (forgetDispatch) {
        forgetDispatch();
        forgetDispatch = null;
      }
      if (forgetStandingResult) {
        forgetStandingResult();
        forgetStandingResult = null;
      }
    };

    const finish = (settleFn: () => void): void => {
      if (settled) return;
      settled = true;
      this.pendingActionGoals.delete(key);
      forgetPendingCalls();
      if (unsubStatus) {
        unsubStatus();
        unsubStatus = null;
      }
      if (unsubFeedback) {
        unsubFeedback();
        unsubFeedback = null;
      }
      settleFn();
      // Last word on acceptance: the goal is over, so any evidence that was
      // going to arrive has. Every earlier source is idempotent through
      // `settleAcceptance`, so this only fires when none of them did.
      settleAcceptance('unobservable');
    };
    const fail = (e: ActionGoalError): void => finish(() => rejectOutcome(e));

    // Fail fast on a stock bridge: without `include_hidden:=true` the
    // `_action/*` services are simply not advertised, and nothing later in
    // the composition can work.
    const sendGoalInfo = this.availableServices.get(sendGoalService);
    if (!sendGoalInfo) {
      fail(
        new ActionGoalError(
          'unavailable',
          action,
          `Service "${sendGoalService}" is not advertised by the bridge. Actions over ` +
            `Foxglove WebSocket require the bridge to be launched with include_hidden:=true.`,
        ),
      );
      return { outcome, acceptance, cancel: () => {} };
    }

    this.pendingActionGoals.set(key, { action, fail });

    // Per-goal feedback rides the action's shared feedback topic, filtered
    // by our UUID. `latest-only`: the contract is best-effort progress where
    // the newest state wins; conflation under pressure is safe by
    // construction because each frame restates progress.
    const onFeedback = options?.onFeedback;
    if (onFeedback) {
      unsubFeedback = this.subscribe(
        `${action}/_action/feedback`,
        (msg) => {
          const data = msg.data;
          if (data instanceof Uint8Array) return; // undecodable channel; feedback is best-effort
          const rec = data as Record<string, unknown>;
          const goalId = (rec.goal_id as Record<string, unknown> | undefined)?.uuid;
          if (uuidValueToHex(goalId) !== key) return;
          // A server only feeds back on a goal it is executing.
          settleAcceptance('accepted');
          try {
            onFeedback(liftActionWrapper(rec, 'feedback', 'goal_id'));
          } catch (err) {
            this.logger.error('[FoxgloveClient] Action feedback callback error:', err);
          }
        },
        { dispatchMode: 'latest-only' },
      );
    }

    // Status watch on the shared `_action/status` topic, keyed by our UUID.
    // It arms the standing result request, classifies residuals (ADR 0007),
    // and is released at settle. Uncapped and non-adaptive: status is an
    // event topic (a goal's terminal frame is the moment the topic goes
    // quiet), so no gate may discard it.
    const getResultService = `${action}/_action/get_result`;
    let armed = false;
    let observed = false;
    let absent = false;
    let probeInFlight = false;
    let lastNamedStatus = -1;
    let resultAwaitingStatus: Record<string, unknown> | null = null;

    // The single funnel for all three result paths: the standing request, the
    // ADR 0007 probe, and the status-supplied terminal.
    //
    // `foxglove_bridge` advertises the GetResult response schema flattened,
    // inlining the action result's own fields at the top level with no `MSG:`
    // separator, so the decoded response has no `result` key and the fields
    // would be dropped. When the key is absent the fields are lifted back out
    // (ADR 0011). The numeric-status gate is load-bearing, not decoration: the
    // service path mints `{ rawBytes }` for a response it cannot decode and
    // `{ success: true }` for a zero-length payload, and neither is robot
    // data. A real GetResult answer always carries a numeric `status`; those
    // two never do. `status` itself is excluded from the lift, so the
    // authoritative terminal enum can never be overwritten by a result field.
    const settleResult = (status: number, resp: Record<string, unknown>): void => {
      // One witness for both shapes, and it is `liftActionWrapper`'s:
      // a `result` member that is a non-array object is the nested wrapper and
      // is returned whole, anything else means the fields are at the root.
      // The looser `resp.result != null` this used to run first could not tell
      // a wrapper from a result that declares a primitive member of its own
      // named `result`, and handed the consumer that primitive under a type
      // that promises a record.
      const result =
        typeof resp.status === 'number' ? liftActionWrapper(resp, 'result', 'status') : {};
      // A goal that succeeded, was canceled or aborted was accepted to get
      // there. STATUS_UNKNOWN (0) is excluded: a server answering that it no
      // longer knows the goal says nothing about whether it ever took it on,
      // so that path falls through to `finish`'s `'unobservable'`.
      if (status >= GOAL_STATUS_TERMINAL_FLOOR) settleAcceptance('accepted');
      finish(() => resolveOutcome({ status, result }));
    };

    // The standing `get_result`, armed on the FIRST status frame naming our
    // UUID — never at acceptance: the rclcpp server registers the goal only
    // after sending the goal response, so an accept-time request can draw a
    // spurious STATUS_UNKNOWN for a healthy goal. It is the primary result
    // channel: the server answers it synchronously at the terminal
    // transition, before the `result_timeout` expiry clock arms, which
    // makes it immune to result eviction on every distro — including
    // humble, whose expiry runs from acceptance and would defeat any
    // fetch-after-terminal design for goals outliving `result_timeout`.
    // Internally unbounded (`timeoutMs: null`): a goal's lifetime is not
    // time-bounded, and a 30 s ride-along would reintroduce the ceiling
    // this architecture removes.
    const armStandingResult = (): void => {
      if (armed || settled) return;
      armed = true;
      const standing = this.callServiceInternal(
        getResultService,
        { goal_id: { uuid: uuidArr } },
        null,
        { actionOwned: true },
      );
      forgetStandingResult = standing.forget;
      standing.promise
        .then((resp) => {
          if (settled) return;
          if (typeof resp.status === 'number') {
            settleResult(resp.status, resp);
          } else if (lastNamedStatus >= GOAL_STATUS_TERMINAL_FLOOR) {
            // Undecodable response (no schema available): the watch already
            // saw the terminal transition; report that status with an empty
            // result, matching the pre-standing-request behavior.
            settleResult(lastNamedStatus, {});
          } else {
            // Undecodable response before any terminal frame: hold it and
            // let the watch's terminal frame supply the status.
            resultAwaitingStatus = resp;
          }
        })
        .catch((err: unknown) => {
          fail(
            new ActionGoalError(
              'server-error',
              action,
              err instanceof Error ? err.message : String(err),
            ),
          );
        });
    };

    // The residual probe (ADR 0007): fired once per absence episode when a
    // readable status array stops naming a goal the watch has previously
    // observed. Bounded by the ordinary 30 s default — an unknown-goal
    // answer is immediate, and a probe that parks on a still-live goal is
    // superseded by the standing request anyway. Only the server's own
    // answer settles anything: STATUS_UNKNOWN resolves the designed
    // `{status: 0}` disowning outcome, a real terminal resolves normally,
    // and everything else (a non-terminal status, an undecodable payload, a
    // timeout, a transport rejection) is inconclusive and leaves the goal
    // pending for the watch to keep classifying.
    const probeResult = (): void => {
      if (probeInFlight || settled) return;
      probeInFlight = true;
      this.callServiceInternal(getResultService, { goal_id: { uuid: uuidArr } }, undefined, {
        actionOwned: true,
      })
        .promise.then((resp) => {
          probeInFlight = false;
          if (settled) return;
          const s = resp.status;
          if (typeof s === 'number' && (s === 0 || s >= GOAL_STATUS_TERMINAL_FLOOR)) {
            settleResult(s, resp);
          }
        })
        .catch(() => {
          probeInFlight = false;
        });
    };

    unsubStatus = this.subscribe(
      `${action}/_action/status`,
      (msg) => {
        if (settled) return;
        const data = msg.data;
        if (data instanceof Uint8Array) return;
        const list = (data as Record<string, unknown>).status_list;
        if (!Array.isArray(list)) return;

        let named: number | null = null;
        for (const entry of list) {
          const rec = entry as Record<string, unknown>;
          const info = rec.goal_info as Record<string, unknown> | undefined;
          const goalId = (info?.goal_id as Record<string, unknown> | undefined)?.uuid;
          if (uuidValueToHex(goalId) !== key) continue;
          named = typeof rec.status === 'number' ? rec.status : -1;
          break;
        }

        if (named !== null) {
          observed = true;
          absent = false;
          // The server never registers a goal it refused, and this id was
          // invented client-side before dispatch, so a status entry naming it
          // is positive proof of acceptance (ADR 0009 decision 2's inference,
          // on the same evidence). This is the source that covers a lost
          // dispatch response.
          settleAcceptance('accepted');
          lastNamedStatus = named;
          armStandingResult();
          if (resultAwaitingStatus !== null && named >= GOAL_STATUS_TERMINAL_FLOOR) {
            settleResult(named, resultAwaitingStatus);
          }
          return;
        }

        // A readable array that does not name the goal. Before any
        // observation that is expected (the latch replay may predate the
        // goal, and probing then can draw a spurious UNKNOWN); after
        // observation it opens an absence episode: probe once, and let the
        // server's own answer classify. Reappearance above withdraws the
        // episode so a later absence can probe again.
        if (!observed || absent) return;
        absent = true;
        probeResult();
      },
      { maxFrequency: 0, disableAdaptive: true },
    );

    // Internally unbounded (`timeoutMs: null`), like the standing get_result
    // armed beside it. The 30 s this used to inherit from `callService` was
    // never chosen for actions: it is the public service default, and a
    // dispatch answer that goes missing (measured, roughly one restarted-server
    // run in seven) is not evidence that the goal does not exist. Every native
    // ROS 2 action client waits for the answer or not at all, and rosbridge
    // never had a dispatch deadline here either. ADR 0009.
    // The request shape follows the advertised schema. `rosidl` inlines the
    // goal's fields at the root beside `goal_id`, so that is both the shape a
    // real bridge asks for and the fallback when no schema could be read; a
    // root that genuinely declares a complex `goal` member gets the nested
    // form instead. Up to 0.1.11 this always nested, and because CDR matches
    // fields by position rather than by name, the writer silently wrote every
    // real goal field from its schema default: a `DockRobot` goal went out as
    // `use_dock_id: true, max_staging_time: 1000.0` with the caller's dock id
    // dropped, and no error was raised anywhere on the path.
    //
    // `goal_id` is written after the spread so a goal that happens to carry a
    // field of that name cannot displace the id this client invented. Key
    // order itself is not wire-visible; the override is.
    //
    // That override is also the one place a caller's field is dropped on
    // purpose, so it is announced. ADR 0013 decision 6 accepts wrapper name
    // collisions rather than mitigating them, and this is not a mitigation:
    // the id has to win, because the client keys its status watch, its
    // `get_result` and its cancel on the id it invented, and a goal it cannot
    // name is a goal it cannot follow. What changes is that the loss is no
    // longer silent. The read side genuinely cannot see a collision, because
    // the bridge merged the two names before the frame arrived; the write
    // side is holding both halves at once and can.
    const sendGoalDefs = sendGoalInfo ? this.getRequestDefs(sendGoalInfo) : null;
    const nestsGoal = sendGoalDefs !== null && requestNestsGoal(sendGoalDefs);
    if (!nestsGoal && Object.prototype.hasOwnProperty.call(goal, 'goal_id')) {
      this.logger.warn(
        `[FoxgloveClient] The goal for "${action}" carries a field named "goal_id", which ` +
          `this client replaces with the id it generated to track the goal. That field will ` +
          `not reach the action server. The advertised send_goal request puts the goal's own ` +
          `fields at the root beside the envelope's goal_id, so the two names collide there.`,
      );
    }
    const dispatchRequest = nestsGoal
      ? { goal_id: { uuid: uuidArr }, goal }
      : { ...goal, goal_id: { uuid: uuidArr } };

    const dispatch = this.callServiceInternal(sendGoalService, dispatchRequest, null, {
      actionOwned: true,
    });
    forgetDispatch = dispatch.forget;
    // finish() ran before this handle existed: dispose it here instead.
    if (settled) forgetPendingCalls();
    dispatch.promise
      .then((resp) => {
        if (resp.accepted === true) settleAcceptance('accepted');
        if (resp.accepted === false) {
          // Settled before `fail`, so the two surfaces reporting the server's
          // one answer cannot disagree.
          settleAcceptance('rejected');
          fail(
            new ActionGoalError(
              'rejected',
              action,
              'The action server rejected the goal (send_goal responded accepted: false).',
            ),
          );
        }
        // Accepted (or acceptance unobservable): the status watch owns the
        // lifecycle from here.
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        // On whether the goal exists, the action server outranks the bridge
        // (ADR 0009 decision 2). This failure is the bridge reporting on its
        // own handling of our request; the status topic is the server
        // reporting on the goal it is running. The goal id was invented here
        // before the request went out, so a status frame naming it is proof
        // that the request arrived and the server registered it, and a
        // request the bridge failed to forward can never draw one.
        if (observed) {
          this.logger.warn(
            `[FoxgloveClient] send_goal for "${action}" failed at the bridge (${message}), but the ` +
              `action server has already named this goal on ${action}/_action/status. Keeping the ` +
              `goal: the status watch owns its lifecycle from here.`,
          );
          return;
        }
        fail(
          new ActionGoalError(
            /not available/i.test(message) ? 'unavailable' : 'server-error',
            action,
            message,
          ),
        );
      });

    return {
      outcome,
      acceptance,
      // Cancellation is a `CancelGoal` service call carrying our self-invented
      // UUID, so it is exact for this goal. Confirmation arrives through the
      // status watch (terminal status 5), never through this call.
      cancel: () => {
        if (settled) return;
        this.callService(`${action}/_action/cancel_goal`, {
          goal_info: { goal_id: { uuid: uuidArr }, stamp: { sec: 0, nanosec: 0 } },
        }).catch((err: unknown) => {
          this.log(
            `cancel_goal for "${action}" failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      },
    };
  }

  /**
   * Resolve the parsed request-side {@link MessageDefinition}[] for a
   * service, preferring the bridge-advertised schema and falling back to
   * the built-in bundle (`src/builtinSchemas.ts`) when the bridge omitted
   * one. Returns `null` if neither source has anything for this service —
   * callers then choose between the {@link EMPTY_REQUEST_CDR} fallback (for
   * empty requests) and an explicit error (for non-empty ones). Cached
   * per service id; parse + bundle lookup runs at most once per service
   * advertisement.
   */
  private getRequestDefs(svc: FoxgloveService): MessageDefinition[] | null {
    return this.getServiceDefs(svc, 'request');
  }

  /** Response-side counterpart to {@link getRequestDefs}; same precedence. */
  private getResponseDefs(svc: FoxgloveService): MessageDefinition[] | null {
    return this.getServiceDefs(svc, 'response');
  }

  /**
   * Shared body of {@link getRequestDefs} and {@link getResponseDefs}. Both
   * sides resolve identically, and keeping one implementation is what stops
   * the request and response paths from drifting — a drift that already cost
   * one field bug, since only the request side is loud when it goes wrong.
   */
  private getServiceDefs(
    svc: FoxgloveService,
    side: 'request' | 'response',
  ): MessageDefinition[] | null {
    const cache = side === 'request' ? this.serviceRequestDefs : this.serviceResponseDefs;
    const cached = cache.get(svc.id);
    if (cached) return cached;

    const advertised = resolveServiceSchema(svc, side);
    if (advertised) {
      try {
        const defs = parseFoxgloveSchema(advertised.schema, advertised.encoding);
        cache.set(svc.id, defs);
        return defs;
      } catch (err) {
        // An advertised-but-unparseable schema must not be fatal: the
        // bundle may still cover this type, and before the nested fields
        // were read this path could not be reached at all. Warn so the
        // consumer can see which schema the bridge sent that we could not
        // read, then fall through to the floor.
        this.logger.warn(
          `[FoxgloveClient] Could not parse the advertised ${side} schema for "${svc.name}" ` +
            `(type "${svc.type}"); falling back to the built-in bundle. ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const bundled = getBundledServiceSchema(svc.type);
    if (bundled) {
      const defs = parseRosMsgDef(side === 'request' ? bundled.request : bundled.response, {
        ros2: true,
      });
      cache.set(svc.id, defs);
      return defs;
    }
    return null;
  }

  /** Lazily compile and cache the CDR writer for a service's request type. */
  private getOrCompileRequestWriter(serviceId: number, defs: MessageDefinition[]): MessageWriter {
    const cached = this.serviceRequestWriters.get(serviceId);
    if (cached) return cached;
    const writer = new MessageWriter(defs);
    this.serviceRequestWriters.set(serviceId, writer);
    return writer;
  }

  /** Lazily compile and cache the CDR reader for a service's response type. */
  private getOrCompileResponseReader(serviceId: number, defs: MessageDefinition[]): MessageReader {
    const cached = this.serviceResponseReaders.get(serviceId);
    if (cached) return cached;
    const reader = new MessageReader(defs);
    this.serviceResponseReaders.set(serviceId, reader);
    return reader;
  }

  private findServiceById(serviceId: number): FoxgloveService | undefined {
    for (const svc of this.availableServices.values()) {
      if (svc.id === serviceId) return svc;
    }
    return undefined;
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
    this.lastError = null;
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
          // The connection timeout is deliberately NOT cleared here: it must
          // cover the full handshake (WS open → serverInfo → advertise), not
          // just the TCP/WS open. It is cleared on success in handleAdvertise
          // and on failure in handleConnectionError. Clearing it here let a
          // socket that opens but never speaks the protocol hang forever.
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
          // If the WebSocket opened but no `serverInfo` ever arrived, the
          // endpoint completed the WS handshake yet never spoke Foxglove WS:
          // a protocol mismatch (e.g. a rosbridge server). The Foxglove side
          // cannot positively identify the real protocol (rosbridge shares the
          // `status` op), so `detectedProtocol` is 'unknown'. A socket still in
          // CONNECTING is a plain timeout.
          const opened = this.ws?.readyState === WebSocket.OPEN;
          const error =
            opened && !this.serverInfoReceived
              ? new ProtocolMismatchError(
                  'foxglove-ws',
                  'unknown',
                  'No Foxglove WebSocket handshake (serverInfo) was received. ' +
                    'The server may speak a different protocol. Check the protocol and port.',
                )
              : new Error(`Connection timeout after ${CONNECTION_TIMEOUT_MS}ms`);
          this.handleConnectionError(error);
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

    try {
      if (typeof event.data === 'string') {
        this.handleJsonMessage(event.data);
      } else if (event.data instanceof ArrayBuffer) {
        this.handleBinaryMessage(event.data);
      }
    } catch (err) {
      // A malformed frame from a buggy or hostile bridge must never escape the
      // message handler: an uncaught throw here is an uncaughtException on Node
      // (process dies) and a fatal error on React Native release builds. The
      // per-op handlers also guard their own field shapes (below) so a
      // half-valid frame degrades; this is the backstop for anything they miss.
      this.logger.error('[FoxgloveClient] Error handling inbound message:', err);
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
      case 'serviceCallFailure':
        this.handleServiceCallFailure(msg as FoxgloveServiceFailure);
        break;
      case 'schemas':
        // sdk.v1 sends schemas metadata; not currently needed.
        break;
      case 'status': {
        const status = msg as { level?: number; message?: string };
        if (status.level === 2) {
          const text = status.message ?? '';
          this.logger.error('[FoxgloveClient] Server error:', text);
          // Status messages are undirected — they don't carry a callId.
          // When the bridge rejects a service-call request (e.g. an
          // unsupported encoding or a stale schema), this is the only
          // signal that reaches us; without fast-fail the in-flight
          // callIds hang until their 30 s timeout. Substring-match keeps
          // the rejection scoped to service-call errors.
          //
          // Action-owned calls are spared: with no callId the frame cannot
          // say which call it means, so it makes no claim about any goal.
          if (/serviceCallRequest/i.test(text) && this.pendingServiceCalls.size > 0) {
            this.rejectAllPendingServiceCalls(
              `Bridge rejected service call: ${text}`,
              'except-action-owned',
            );
          }
        }
        break;
      }
    }
  }

  private handleBinaryMessage(buffer: ArrayBuffer): void {
    if (buffer.byteLength < 1) return;

    const view = new DataView(buffer);
    const opcode = view.getUint8(0);

    switch (opcode) {
      case BinaryOpcode.MESSAGE_DATA:
        this.handleBinaryMessageData(buffer, view);
        return;
      case BinaryOpcode.SERVICE_CALL_RESPONSE:
        this.handleBinaryServiceCallResponse(buffer, view);
        return;
      default:
        // Spec-listed but currently unused (0x02 TIME, 0x04
        // FETCH_ASSET_RESPONSE) and any future opcode — drop silently
        // rather than logging on the hot path.
        return;
    }
  }

  private handleBinaryMessageData(buffer: ArrayBuffer, view: DataView): void {
    // messageData binary format (server → client):
    // [uint8 op=0x01] [uint32LE subscriptionId] [uint64LE timestamp] [payload]
    if (buffer.byteLength < 13) return;
    const subscriptionId = view.getUint32(1, true);

    const timestampLow = view.getUint32(5, true);
    const timestampHigh = view.getUint32(9, true);
    const timestampNs = timestampHigh * 0x100000000 + timestampLow;
    const sec = Math.floor(timestampNs / 1_000_000_000);
    const nsec = timestampNs % 1_000_000_000;

    const payloadOffset = 13;
    // Zero-copy view, NOT `buffer.slice(payloadOffset)`. `ArrayBuffer.slice`
    // allocates a fresh ArrayBuffer and copies the payload bytes on every
    // inbound frame, including frames dropped a few lines below by the
    // throttle short-circuit. On raw image topics (10 MB/frame at 30 Hz)
    // that's ~300 MB/s of allocation + GC churn even when 100 % of frames
    // are dropped. `TextDecoder.decode`, `MessageReader.readMessage`, and
    // the four `data = ...` assignments below all accept `Uint8Array`
    // transparently; the regression test in FoxgloveClient.test.ts asserts
    // `data.buffer === frameBuffer` to pin the zero-copy invariant.
    const payload = new Uint8Array(buffer, payloadOffset);

    const sub = this.subscriptions.get(subscriptionId);
    if (!sub) return;
    if (sub.isPaused) return;

    const now = Date.now();
    const mode = this.getThrottleMode();
    recordBytes(sub.bandwidth, now, buffer.byteLength, mode);
    sub.breaker.recordObservation(now, sub.bandwidth.bytesPerSec, getMaxLagMs());

    // Single pass over callbacks. The two dispatch modes want opposite things
    // from a closed throttle window, so the window test lives per-mode rather
    // than as one gate upstream of both.
    //
    // `latest-only` conflates before parse: stash a materialized copy of the
    // newest payload and defer the decode to a drain. The stash is
    // unconditional — a frame arriving inside a closed window supersedes the
    // pending one instead of being discarded, because the mode promises the
    // newest frame reaches the callback and a burst that ends inside a closed
    // window has no later frame to restate it. The drain is armed for the
    // moment the window reopens, and `lastDeliveredAt` moves at delivery, not
    // here. The `payload` view aliases the WS frame buffer (v0.1.2 zero-copy
    // ingest), so it must be copied to survive the tick boundary.
    //
    // `immediate` keeps the synchronous parse-and-deliver path and stays a
    // leading-edge gate: its contract is delivery on the message-handler tick,
    // and a trailing frame can only be delivered off it. The parse runs at most
    // once, shared across every immediate subscriber, and is skipped entirely
    // when no immediate callback is eligible.
    const deliverTo: Array<[(msg: RosMessage) => void, CallbackEntry]> = [];
    for (const [cb, entry] of sub.callbacks) {
      const interval = effectiveMinInterval(
        entry.userMinIntervalMs,
        entry.disableAdaptive,
        sub.bandwidth,
      );

      if (entry.dispatchMode === 'latest-only') {
        const stashChannel = this.channels.get(sub.channelId);
        entry.pending = {
          payload: new Uint8Array(payload),
          sec,
          nsec,
          encoding: stashChannel?.encoding ?? 'json',
          schemaName: stashChannel?.schemaName ?? '',
        };
        if (entry.drainTimer === null) {
          entry.drainTimer = setTimeout(
            () => this.drainLatestOnly(subscriptionId, cb, entry),
            Math.max(0, interval - (now - entry.lastDeliveredAt)),
          );
        }
        continue;
      }

      if (interval <= 0 || now - entry.lastDeliveredAt >= interval) {
        deliverTo.push([cb, entry]);
      }
    }
    if (deliverTo.length === 0) return;

    let parsed: RosMessage | null = null;
    for (const [cb, entry] of deliverTo) {
      entry.lastDeliveredAt = now;

      if (parsed === null) {
        const channelInfo = this.channels.get(sub.channelId);
        const encoding = channelInfo?.encoding ?? 'json';
        parsed = {
          topic: sub.topic,
          schemaName: channelInfo?.schemaName ?? '',
          encoding: encoding === 'json' ? 'json' : 'cdr',
          data: this.decodePayload(payload, subscriptionId, encoding),
          receiveTime: { sec, nsec },
          byteSize: payload.byteLength,
        };
      }
      try {
        cb(parsed);
      } catch (err) {
        this.logger.error('[FoxgloveClient] Subscriber callback error:', err);
      }
    }
  }

  /**
   * Decode a `messageData` payload to its delivered shape: a parsed object when
   * a CDR reader or JSON decode succeeds, the raw bytes otherwise. Shared by
   * the synchronous `immediate` path and the deferred `latest-only` drain.
   */
  private decodePayload(
    payload: Uint8Array,
    subscriptionId: number,
    encoding: string,
  ): Record<string, unknown> | Uint8Array {
    if (encoding === 'json') {
      try {
        return JSON.parse(TEXT_DECODER.decode(payload)) as Record<string, unknown>;
      } catch {
        return payload;
      }
    }
    const reader = this.messageReaders.get(subscriptionId);
    if (reader) {
      try {
        const decoded = reader.readMessage(payload) as Record<string, unknown>;
        if (reader.lastReadHadTrailingBytes() && this.fieldlessReaders.has(subscriptionId)) {
          // The channel described a type with nothing in it and then sent
          // bytes that are not accounted for by CDR's final padding, so the
          // description and the payload disagree. Believing the description
          // here would hand back an empty object for a message that carried
          // data. Degrade to raw bytes, exactly as this path did before a
          // fieldless channel was decoded at all, and say so once: a server
          // advertising no schema for a type that has fields is a fault worth
          // seeing rather than absorbing.
          this.warnFieldlessMismatch(subscriptionId, payload.byteLength);
          return payload;
        }
        return decoded;
      } catch {
        return payload;
      }
    }
    // No reader: a JSON channel is handled above, so what remains is a schema
    // that failed to parse, or a channel that declared no usable message
    // encoding at all. Both are undecodable here, and the raw bytes are the
    // honest answer.
    return payload;
  }

  /**
   * Warn at most once per channel that a fieldless description was not
   * believed.
   *
   * The distinction the caller draws is worth stating: unread trailing bytes
   * are evidence of a wrong description only on a reader this client invented
   * from an empty one. On a reader compiled from a schema the server sent,
   * leftover bytes mean the schema is older than the payload, which is a
   * different claim and is not acted on here.
   */
  private warnFieldlessMismatch(subscriptionId: number, byteLength: number): void {
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub || this.fieldlessMismatchWarned.has(sub.channelId)) return;
    this.fieldlessMismatchWarned.add(sub.channelId);
    const channel = this.channels.get(sub.channelId);
    this.logger.warn(
      `[FoxgloveClient] "${sub.topic}" was advertised with no schema for type ` +
        `"${channel?.schemaName ?? 'unknown'}", but its ${byteLength}-byte payload carries ` +
        `data a fieldless type cannot hold. Delivering raw bytes for this topic.`,
    );
  }

  /**
   * Drain one `latest-only` callback's pending payload: parse the survivor and
   * deliver it. Cleared state (`pending`, `drainTimer`) is reset *before* the
   * callback runs, so a throwing callback never wedges future delivery — the
   * next arrival re-arms normally. Bails if the subscription was torn down or
   * paused while the drain was armed (no post-teardown delivery).
   */
  private drainLatestOnly(
    subscriptionId: number,
    cb: (msg: RosMessage) => void,
    entry: CallbackEntry,
  ): void {
    entry.drainTimer = null;
    const pending = entry.pending;
    if (!pending) return;

    const sub = this.subscriptions.get(subscriptionId);
    if (!sub || sub.isPaused) {
      entry.pending = null;
      return;
    }

    // Re-check the window before delivering. The adaptive interval can widen
    // between arming and firing, and a drain armed under the older, narrower
    // interval must not deliver early on the strength of a stale deadline.
    // Re-arm for the remainder instead; the pending payload is kept, so the
    // frame is deferred rather than lost.
    const nowMs = Date.now();
    const interval = effectiveMinInterval(
      entry.userMinIntervalMs,
      entry.disableAdaptive,
      sub.bandwidth,
    );
    const remaining = interval - (nowMs - entry.lastDeliveredAt);
    if (remaining > 0) {
      entry.drainTimer = setTimeout(
        () => this.drainLatestOnly(subscriptionId, cb, entry),
        remaining,
      );
      return;
    }

    entry.pending = null;
    entry.lastDeliveredAt = nowMs;

    const rosMsg: RosMessage = {
      topic: sub.topic,
      schemaName: pending.schemaName,
      encoding: pending.encoding === 'json' ? 'json' : 'cdr',
      data: this.decodePayload(pending.payload, subscriptionId, pending.encoding),
      receiveTime: { sec: pending.sec, nsec: pending.nsec },
      byteSize: pending.payload.byteLength,
    };
    try {
      cb(rosMsg);
    } catch (err) {
      this.logger.error('[FoxgloveClient] Subscriber callback error:', err);
    }
    // If this subscription was demoted while the drain was armed (channel
    // unadvertised mid-window), this delivery was its last duty: reap it.
    this.reapDemotedSubscription(subscriptionId);
  }

  /** Cancel one callback's armed drain and drop its pending payload. */
  private cancelDrain(entry: CallbackEntry): void {
    if (entry.drainTimer !== null) {
      clearTimeout(entry.drainTimer);
      entry.drainTimer = null;
    }
    entry.pending = null;
  }

  /** Cancel every armed drain on a subscription (teardown / pause). */
  private cancelAllDrains(sub: { callbacks: Map<(msg: RosMessage) => void, CallbackEntry> }): void {
    for (const entry of sub.callbacks.values()) this.cancelDrain(entry);
  }

  private handleServerInfo(info: FoxgloveServerInfo): void {
    this.log(`Received serverInfo: ${info.name} (sessionId: ${info.sessionId ?? 'none'})`);
    this.serverInfoReceived = true;
  }

  private handleAdvertise(msg: FoxgloveAdvertise): void {
    const channels = Array.isArray(msg.channels) ? msg.channels : [];
    for (const ch of channels) {
      this.channels.set(ch.id, ch);
      this.topicToChannelId.set(ch.topic, ch.id);
      this.log(
        `  Channel: ${ch.topic} [${ch.schemaName}] encoding=${ch.encoding} schemaEncoding=${ch.schemaEncoding ?? 'none'}`,
      );
    }

    if (this.connectResolve && this.serverInfoReceived) {
      this.log(`Connection established with ${channels.length} initial topics.`);
      this.clearConnectionTimeout();
      this.reconnectAttempts = 0;
      this.setStatus('connected');

      this.connectResolve();
      this.connectResolve = null;
      this.connectReject = null;
    } else {
      // Activate before notifying, so a listener that inspects the client
      // from its onTopicsChange handler observes an already-consistent state
      // (mirrors the rosbridge self-heal ordering).
      this.activatePendingSubscriptions();
      this.notifyTopicsChanged();
    }
  }

  /**
   * Establish every pending subscription whose channel is now advertised, by
   * replaying the recorded callbacks and options through the normal
   * subscribe path (first callback creates the subscription and sends the
   * wire frame; the rest merge). The pending entry is removed first, so the
   * closures handed out at pending time fall through to the active-removal
   * path from here on.
   */
  private activatePendingSubscriptions(): void {
    if (this.pendingSubscriptions.size === 0) return;
    for (const [topic, entries] of this.pendingSubscriptions) {
      if (!this.topicToChannelId.has(topic)) continue;
      this.pendingSubscriptions.delete(topic);
      for (const [onMessage, options] of entries) {
        this.subscribe(topic, onMessage, options);
      }
      this.log(`Pending subscription for "${topic}" activated.`);
    }
  }

  private handleUnadvertise(msg: FoxgloveUnadvertise): void {
    const channelIds = Array.isArray(msg.channelIds) ? msg.channelIds : [];
    for (const id of channelIds) {
      const ch = this.channels.get(id);
      if (ch) {
        // Only clear the topic->channel mapping when it still points at THIS
        // channel id. If the same topic was re-advertised under a new id, the
        // mapping already points at the new channel; unadvertising the stale
        // id must not wipe the live mapping.
        if (this.topicToChannelId.get(ch.topic) === id) {
          this.topicToChannelId.delete(ch.topic);
          this.demoteSubscriptionToPending(ch.topic, id);
        }
      }
      this.channels.delete(id);
    }
    this.notifyTopicsChanged();
  }

  /**
   * Move a live subscription back to the pending map when the channel
   * carrying it is unadvertised. The callbacks and their options are kept,
   * so when the topic re-advertises — under the same channel id or a new
   * one, as `foxglove_bridge` does across an action-server restart — the
   * ordinary pending-activation path re-subscribes them. Without this, a
   * subscription whose channel churned was left bound to a dead id: alive
   * in the client's maps, permanently silent on the wire.
   *
   * No `unsubscribe` frame is sent: the server dropped the channel, so
   * there is nothing to unsubscribe from.
   */
  private demoteSubscriptionToPending(topic: string, channelId: number): void {
    const subId = this.topicToSubscriptionId.get(topic);
    if (subId === undefined) return;
    const sub = this.subscriptions.get(subId);
    if (!sub || sub.channelId !== channelId) return;

    let pending = this.pendingSubscriptions.get(topic);
    if (!pending) {
      pending = new Map();
      this.pendingSubscriptions.set(topic, pending);
    }
    let anyDrainArmed = false;
    for (const [cb, entry] of sub.callbacks) {
      if (entry.drainTimer !== null) anyDrainArmed = true;
      const opts: SubscribeOptions = {
        disableAdaptive: entry.disableAdaptive,
        dispatchMode: entry.dispatchMode,
      };
      if (entry.userMinIntervalMs) opts.maxFrequency = 1000 / entry.userMinIntervalMs;
      pending.set(cb, opts);
    }
    sub.breaker.destroy();
    this.topicToSubscriptionId.delete(topic);

    // A `latest-only` callback may hold a stashed trailing frame whose drain
    // is still armed — the exact frame the v0.1.9 trailing-delivery contract
    // exists to deliver, already labelled (stash-time capture) with the
    // channel that carried it. Keep the subscription object and its reader
    // alive as an unmapped zombie until that drain completes; the drain
    // reaps it (see reapDemotedSubscription). With nothing armed, tear down
    // immediately. No new frames can arrive either way: the server dropped
    // the channel, and the topic mapping above is already gone.
    if (!anyDrainArmed) {
      this.subscriptions.delete(subId);
      this.messageReaders.delete(subId);
      this.fieldlessReaders.delete(subId);
    }
    this.log(
      `Channel for "${topic}" unadvertised; subscription demoted to pending until the topic reappears.`,
    );
  }

  /**
   * Delete a demoted (unmapped) subscription once its last armed drain has
   * completed. A subscription is demoted exactly when the topic mapping no
   * longer points at it; a mapped subscription is never reaped here.
   */
  private reapDemotedSubscription(subscriptionId: number): void {
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub) return;
    if (this.topicToSubscriptionId.get(sub.topic) === subscriptionId) return;
    for (const entry of sub.callbacks.values()) {
      if (entry.drainTimer !== null) return;
    }
    this.subscriptions.delete(subscriptionId);
    this.messageReaders.delete(subscriptionId);
    this.fieldlessReaders.delete(subscriptionId);
  }

  private handleAdvertiseServices(msg: FoxgloveAdvertiseServices): void {
    const services = Array.isArray(msg.services) ? msg.services : [];
    for (const svc of services) {
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

  /**
   * Service-call responses arrive on two distinct wire paths and both
   * funnel into {@link dispatchServiceCallResponse}:
   *
   *   1. JSON op `serviceCallResponse` (handled here) — older bridges
   *      and any deployment with binary responses disabled. `data` is
   *      base64, decoded once into a Uint8Array before dispatch.
   *   2. Binary opcode 0x03 (handled in
   *      {@link handleBinaryServiceCallResponse}) — the default for
   *      foxglove-sdk-cpp ≥ 0.18.0 / foxglove_bridge 3.2.6+. Payload
   *      bytes are passed through directly with no base64 round-trip.
   *
   * Before this split, only the JSON path existed and the binary
   * frames were dropped by {@link handleBinaryMessage} — pending callIds
   * never resolved and surfaced as 30 s timeouts on every callService.
   */
  private handleServiceCallResponse(msg: FoxgloveServiceResponse): void {
    const payload = msg.data ? base64ToUint8(msg.data) : new Uint8Array();
    this.dispatchServiceCallResponse(msg.callId, msg.serviceId, msg.encoding ?? '', payload);
  }

  /**
   * Inner decode + dispatch shared by the JSON-op and binary-frame
   * paths. Owns the lookup of the pending call, the timer cleanup, and
   * the CDR / JSON branch — splitting it out keeps the two surface
   * paths thin and prevents drift between them.
   */
  private dispatchServiceCallResponse(
    callId: number,
    serviceId: number,
    encoding: string,
    payload: Uint8Array,
  ): void {
    const pending = this.pendingServiceCalls.get(callId);
    if (!pending) return;

    if (pending.timer !== null) clearTimeout(pending.timer);
    this.pendingServiceCalls.delete(callId);

    try {
      if (encoding === 'cdr' && payload.byteLength > 0) {
        const svc = this.findServiceById(serviceId);
        const respDefs = svc ? this.getResponseDefs(svc) : null;
        if (svc && !respDefs && describesFieldlessService(svc, 'response')) {
          // The bridge described the response type as having no fields, which
          // is the ordinary shape for a robot's button actions: dock, undock,
          // reset odometry. The response *is* the empty object, so deliver one
          // rather than bytes the consumer cannot interpret. Same reading as a
          // fieldless topic, and guarded the same way: bytes the empty
          // definition cannot account for mean the description was wrong, and
          // the raw payload is handed back instead.
          const reader = this.getOrCompileResponseReader(svc.id, FIELDLESS_MESSAGE_DEFS);
          const decoded = reader.readMessage(payload) as Record<string, unknown>;
          if (reader.lastReadHadTrailingBytes()) {
            this.logger.warn(
              `[FoxgloveClient] "${svc.name}" was advertised with no response schema, but its ` +
                `${payload.byteLength}-byte response carries data a fieldless type cannot hold. ` +
                `Returning raw bytes.`,
            );
            pending.resolve({ rawBytes: payload } as Record<string, unknown>);
            return;
          }
          pending.resolve(decoded);
          return;
        }
        if (!svc || !respDefs) {
          // Neither the bridge nor the bundle has a response schema for
          // this service, and the bridge did not describe the type as empty
          // either. Surface the raw bytes so the consumer can still inspect
          // them rather than swallowing the payload entirely.
          pending.resolve({ rawBytes: payload } as Record<string, unknown>);
          return;
        }
        const reader = this.getOrCompileResponseReader(svc.id, respDefs);
        const decoded = reader.readMessage(payload);
        pending.resolve(decoded as Record<string, unknown>);
      } else if (encoding === 'json' && payload.byteLength > 0) {
        // Back-compat path for older bridges that responded in JSON.
        // TextDecoder is the correct decoder here — `atob` would only
        // round-trip ASCII payloads, but Foxglove can send UTF-8.
        const text = TEXT_DECODER.decode(payload);
        const parsed = JSON.parse(text) as Record<string, unknown>;
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

  /**
   * Parse a binary opcode-0x03 SERVICE_CALL_RESPONSE frame and dispatch
   * to {@link dispatchServiceCallResponse}. Frame layout (LE throughout):
   *
   *   [uint8 op=0x03][uint32 serviceId][uint32 callId]
   *   [uint32 encodingLength][utf8 encoding][bytes payload]
   *
   * Malformed frames (too short for the header, or an `encodingLength`
   * that runs past the buffer) are dropped silently — the bridge will
   * either resend or fail the call via the JSON `serviceCallFailure`
   * op, and either way logging on the hot binary path would be noisy.
   */
  private handleBinaryServiceCallResponse(buffer: ArrayBuffer, view: DataView): void {
    if (buffer.byteLength < 13) return; // 1 + 4 + 4 + 4
    const serviceId = view.getUint32(1, true);
    const callId = view.getUint32(5, true);
    const encodingLength = view.getUint32(9, true);
    const payloadOffset = 13 + encodingLength;
    if (buffer.byteLength < payloadOffset) return;
    const encoding = TEXT_DECODER.decode(new Uint8Array(buffer, 13, encodingLength));
    const payload = new Uint8Array(buffer, payloadOffset);
    this.dispatchServiceCallResponse(callId, serviceId, encoding, payload);
  }

  /**
   * Handle a `serviceCallFailure` op (callId-targeted rejection from the
   * bridge). Without this, failures sat unhandled and the in-flight promise
   * timed out at 30 s — turning every misencoded request, unknown service,
   * or schema mismatch into a long, opaque hang.
   */
  private handleServiceCallFailure(msg: FoxgloveServiceFailure): void {
    const pending = this.pendingServiceCalls.get(msg.callId);
    if (!pending) return;

    if (pending.timer !== null) clearTimeout(pending.timer);
    this.pendingServiceCalls.delete(msg.callId);
    pending.reject(new Error(msg.message ?? 'Service call failed (no message from bridge)'));
  }

  /**
   * Reject every in-flight service call with `reason`, clear their timers,
   * and drop them from the pending map. Used by {@link cleanup} on disconnect
   * and by the status-level-2 fast-fail path where the bridge has signalled a
   * service-call rejection without naming a callId.
   *
   * `scope: 'except-action-owned'` spares the calls an action composition
   * owns. A level-2 status names no callId, so it cannot claim that any
   * particular goal failed, and taking a goal dispatch down because an
   * unrelated service was misencoded is a guess (ADR 0009 decision 3). A
   * disconnect passes the default `'all'`: that is not a claim about a call,
   * it is the end of the connection, and the goal is failed as
   * `'disconnected'` on its own path.
   */
  private rejectAllPendingServiceCalls(
    reason: string,
    scope: 'all' | 'except-action-owned' = 'all',
  ): void {
    for (const [callId, pending] of this.pendingServiceCalls) {
      if (scope === 'except-action-owned' && pending.actionOwned) continue;
      if (pending.timer !== null) clearTimeout(pending.timer);
      this.pendingServiceCalls.delete(callId);
      pending.reject(new Error(reason));
    }
  }

  // ── Private: reconnection ────────────────────────────────────────────────

  private handleConnectionError(error: Error): void {
    this.clearConnectionTimeout();
    this.lastError = error;

    // Only auto-reconnect if the connection previously succeeded or a reconnect
    // cycle is already running. A failure on the *initial* connect rejects the
    // caller's connect() promise and stops there — first-connect retry is the
    // consumer's call. Without this gate a wrong-endpoint connect() would reject
    // the caller yet leave a background reconnect loop holding a socket nobody
    // can disconnect (ProtocolManager never stored the client).
    const wasConnected = this.status === 'connected';
    const reconnecting = this.reconnectAttempts > 0;

    if (this.connectReject) {
      this.connectReject(error);
      this.connectResolve = null;
      this.connectReject = null;
    }

    this.setStatus('error');
    this.cleanup();
    if (wasConnected || reconnecting) {
      this.scheduleReconnect();
    }
  }

  private handleClose(_code: number, _reason: string): void {
    const wasConnected = this.status === 'connected';

    // A close before the handshake completed leaves the connect promise
    // pending; reject it so the caller's connect() flow doesn't hang. When
    // wasConnected is true the promise already resolved (connectReject is
    // null), so this only fires on the pre-handshake path.
    if (this.connectReject) {
      this.connectReject(new Error('Connection closed before the handshake completed'));
      this.connectResolve = null;
      this.connectReject = null;
    }

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

    const delay = Math.min(BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts), 16_000);
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
    if (sub) this.cancelAllDrains(sub);
    sub?.breaker.destroy();
    // `breakerListeners` are owned by the caller of `onBreakerStateChange`,
    // not by the subscription. Their cleanup happens through the unsubscribe
    // function that `onBreakerStateChange` returns. Tearing them down here
    // would nuke listeners belonging to other consumers watching the same
    // topic.

    this.subscriptions.delete(subscriptionId);
    // Guarded delete: only clear the topic mapping while it still points at
    // THIS subscription id. A stale closure carrying a dead id (its
    // subscription was demoted and re-established across channel churn) must
    // not tear down the live successor's mapping.
    if (this.topicToSubscriptionId.get(topic) === subscriptionId) {
      this.topicToSubscriptionId.delete(topic);
    }
    this.messageReaders.delete(subscriptionId);
    this.fieldlessReaders.delete(subscriptionId);

    if (sub && this.ws && this.status === 'connected' && !sub.isPaused) {
      this.sendJson({
        op: 'unsubscribe',
        subscriptionIds: [subscriptionId],
      });
    }
  }

  /**
   * Remove one callback from an established subscription, tearing the
   * subscription down when it was the last. Same semantics as the closure
   * returned by the active subscribe path; used by pending-era closures whose
   * subscription has activated since.
   */
  private removeActiveCallback(topic: string, onMessage: (msg: RosMessage) => void): void {
    const subId = this.topicToSubscriptionId.get(topic);
    if (subId === undefined) return;
    const sub = this.subscriptions.get(subId);
    if (!sub) return;
    const entry = sub.callbacks.get(onMessage);
    if (entry) this.cancelDrain(entry);
    sub.callbacks.delete(onMessage);
    if (sub.callbacks.size === 0) {
      this.unsubscribeTopic(topic, subId);
    }
  }

  getSubscriptionState(topic: string): SubscriptionState {
    if (this.topicToSubscriptionId.has(topic)) return 'active';
    if (this.pendingSubscriptions.has(topic)) return 'pending';
    return 'none';
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

  onBreakerStateChange(topic: string, cb: (state: CircuitBreakerState) => void): () => void {
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

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.rejectAllPendingServiceCalls('Connection closed');

    // Goal dispatch correlation is connection-scoped: once this connection
    // ends the terminal outcome is permanently unobservable while the robot
    // may keep executing — the exact asymmetry the 'disconnected' reason
    // signals. Copy first: fail() mutates the map.
    for (const pending of [...this.pendingActionGoals.values()]) {
      pending.fail(
        new ActionGoalError(
          'disconnected',
          pending.action,
          'Connection closed before the goal reached a terminal state.',
        ),
      );
    }
    this.pendingActionGoals.clear();

    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN && this.advertisedTopics.size > 0) {
        const channelIds = Array.from(this.advertisedTopics.values());
        try {
          this.sendJson({ op: 'unadvertise', channelIds });
        } catch {
          // best effort
        }
      }

      // 'error' alone keeps a no-op listener instead of null: the ws npm
      // package is an EventEmitter, close() during CONNECTING emits 'error',
      // and an unlistened EventEmitter 'error' crashes the host process.
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = () => {};
      this.ws.onclose = null;

      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }

    for (const sub of this.subscriptions.values()) {
      this.cancelAllDrains(sub);
      // Destroy the breaker here, not only in unsubscribeTopic. Otherwise a
      // tripped breaker's cooldown timer (30 s–5 min) outlives the connection,
      // fires half_open into the next connection's maps (ids are reused after
      // nextSubscriptionId resets), and resubscribes a phantom id.
      sub.breaker.destroy();
    }

    this.channels.clear();
    this.topicToChannelId.clear();
    this.subscriptions.clear();
    // Pendings die with the connection, same as established subscriptions:
    // the consumer resubscribes from onStatusChange after a reconnect, and a
    // resubscribed unknown topic simply lands back in pending.
    this.pendingSubscriptions.clear();
    this.topicToSubscriptionId.clear();
    this.messageReaders.clear();
    this.fieldlessReaders.clear();
    this.fieldlessMismatchWarned.clear();
    this.advertisedTopics.clear();
    this.availableServices.clear();
    this.serviceRequestDefs.clear();
    this.serviceResponseDefs.clear();
    this.serviceRequestWriters.clear();
    this.serviceResponseReaders.clear();
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
