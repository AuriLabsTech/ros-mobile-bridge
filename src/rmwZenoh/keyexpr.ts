// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * How `rmw_zenoh` names ROS 2 things on Zenoh: the data key of a topic or
 * service, and the liveliness token each node, publisher, subscriber, service
 * server and service client declares. Pure functions over strings: no I/O, no
 * session state. The session layer in `src/zenoh/` knows nothing of ROS; this
 * module is the ROS half that sits beside it.
 *
 * Checked against `rmw_zenoh_cpp` 0.1.11 on Humble and 0.2.11 on Jazzy by
 * captured tokens (`tests/fixtures/rmw-zenoh/`), and against the `rolling`
 * source at `dda52d6d9bc8` (`liveliness_utils.cpp`, `qos.cpp`,
 * `docs/design.md`). `docs/PROTOCOLS.md`, "rmw_zenoh key expressions and
 * graph tokens", has the grammar with examples.
 *
 * Two rules hold throughout:
 *
 * - **Parsers return `null`, never throw.** Any session on the router can
 *   declare a token, so a parser's input is untrusted. A token `rmw_zenoh`
 *   itself would refuse is refused here too; where this module is stricter
 *   than `rmw_zenoh`, the function says so.
 * - **Builders throw `RangeError`** on input that would make a key the robot
 *   cannot match, or a key with a wildcard in it. A topic name such as
 *   `/a/**` would otherwise turn one subscription into a subscription to
 *   everything under `/a`.
 *
 * The type hash is never computed or guessed here: every builder takes the
 * hash segment as an argument, read from the robot's own tokens (ADR 0030,
 * decision 5).
 *
 * Internal; not re-exported from `index.ts`.
 *
 * @module
 */

import { stripInterfaceKind } from '../schemaName';

/** The hash segment Humble writes in place of a type hash. */
export const TYPE_HASH_NOT_SUPPORTED = 'TypeHashNotSupported';

/** The two hash segments rmw_zenoh writes: a REP-2011 hash, or Humble's constant. */
export type HashForm = 'rihs01' | 'unsupported';

/** The middle segment of a three-part ROS type name. */
export type InterfaceKind = 'msg' | 'srv' | 'action';

const RIHS01 = /^RIHS01_[0-9a-f]{64}$/;
const DDS_TYPE = /^([A-Za-z0-9_]+)::(msg|srv|action)::dds_::([A-Za-z0-9_]*[A-Za-z0-9])_$/;
// `pkg/Name`, once `stripInterfaceKind` has taken out a kind segment.
const TWO_PART = /^([A-Za-z0-9_]+)\/([A-Za-z0-9_]+)$/;
// A fully qualified ROS name: one or more `/chunk`, nothing a Zenoh key
// reserves (`*`, `$`, `?`, `#`) and no `%`, which tokens use for `/`.
const FQN = /^(?:\/[A-Za-z0-9_]+)+$/;
const NAME_CHUNK = /^[A-Za-z0-9_]+$/;
const DIGITS = /^[0-9]+$/;
const HEX = /^[0-9a-f]+$/;

/**
 * Which hash segment `segment` is, or `null` when it is neither form. A key or
 * token with any other segment (a wildcard, `RIHS02_`, a buffer channel's
 * `_buf_cpu`) is not one this module reads.
 */
export function hashForm(segment: string): HashForm | null {
  if (segment === TYPE_HASH_NOT_SUPPORTED) return 'unsupported';
  return RIHS01.test(segment) ? 'rihs01' : null;
}

/**
 * The DDS type name rmw_zenoh writes for a ROS type: `pkg/msg/Name` becomes
 * `pkg::msg::dds_::Name_`. A two-part `pkg/Name` takes `kind`, which the
 * caller knows from context (a topic's type is `msg`, a service's `srv`); a
 * three-part name keeps the kind it states, so an action's feedback topic
 * stays `pkg::action::dds_::Name_FeedbackMessage_`. `null` for anything else.
 */
export function ddsTypeName(rosType: string, kind: InterfaceKind): string | null {
  const twoPart = stripInterfaceKind(rosType);
  const stated = twoPart === rosType ? kind : (rosType.split('/')[1] as InterfaceKind);
  const m = TWO_PART.exec(twoPart);
  if (m === null) return null;
  const dds = `${m[1] ?? ''}::${stated}::dds_::${m[2] ?? ''}_`;
  // Only a name the rest of this module reads back: not `Name_`, not `_`.
  return rosTypeName(dds) === null ? null : dds;
}

/** The ROS type for a DDS type name: `pkg::msg::dds_::Name_` becomes `pkg/msg/Name`, else `null`. */
export function rosTypeName(ddsType: string): string | null {
  const m = DDS_TYPE.exec(ddsType);
  return m === null ? null : `${m[1]}/${m[2]}/${m[3]}`;
}

// ---------------------------------------------------------------------------
// Data keys

/** A topic's or service's data key, read back. */
export interface DataKey {
  /** The ROS domain id, the key's first chunk. */
  domainId: number;
  /** The fully qualified topic or service name, with its leading `/`. */
  name: string;
  /** The DDS type name, as on the wire. */
  ddsType: string;
  /** The same type as a ROS name, `pkg/kind/Name`. */
  rosType: string;
  /** The hash segment, as on the wire. */
  hashSegment: string;
  /** Which form the hash segment takes. */
  hashForm: HashForm;
}

/**
 * The data key rmw_zenoh publishes, subscribes and queries a topic or service
 * on: `<domain>/<name without its leading slash>/<DDS type>/<hash segment>`.
 * `name` is fully qualified (`/robot1/chatter`). Throws `RangeError` on a
 * name, type or hash this module would not parse back.
 */
export function dataKey(
  domainId: number,
  name: string,
  ddsType: string,
  hashSegment: string,
): string {
  checkDomain(domainId);
  checkFqn(name, 'name');
  if (rosTypeName(ddsType) === null)
    throw new RangeError(`not a DDS type name: ${JSON.stringify(ddsType)}`);
  if (hashForm(hashSegment) === null)
    throw new RangeError(`not a type hash segment: ${JSON.stringify(hashSegment)}`);
  return `${domainId}/${name.slice(1)}/${ddsType}/${hashSegment}`;
}

/**
 * Read a data key back, or `null`. A topic name has any number of chunks, so
 * the last two are taken as type and hash, and both must have their exact
 * form. That check is what keeps a buffer channel (`<key>/_buf_cpu`,
 * `<key>/_buf/<gid>`, rmw_zenoh on Lyrical and Rolling) from reading as a
 * topic.
 */
export function parseDataKey(key: string): DataKey | null {
  const chunks = key.split('/');
  if (chunks.length < 4) return null;
  const domainId = readDomain(chunks[0] ?? '');
  if (domainId === null) return null;
  const hashSegment = chunks[chunks.length - 1] ?? '';
  const ddsType = chunks[chunks.length - 2] ?? '';
  const form = hashForm(hashSegment);
  const rosType = rosTypeName(ddsType);
  if (form === null || rosType === null) return null;
  const name = `/${chunks.slice(1, -2).join('/')}`;
  if (!FQN.test(name)) return null;
  return {
    domainId,
    name,
    ddsType,
    rosType,
    hashSegment,
    hashForm: form,
  };
}

/**
 * The key expression to subscribe to a topic with, whatever its type and hash:
 * `<domain>/<name>/*\/*`. Never `<domain>/<name>/**`: on rmw_zenoh for Lyrical
 * and Rolling that also takes a buffer-aware topic's `_buf_cpu` and
 * `_buf/<gid>` channels, and the second carries a buffer descriptor, not CDR.
 * It also keeps `/odom` from taking `/odom/filtered`.
 */
export function topicSubscriptionKeyExpr(domainId: number, name: string): string {
  checkDomain(domainId);
  checkFqn(name, 'name');
  return `${domainId}/${name.slice(1)}/*/*`;
}

/** The key expression that covers every liveliness token of one ROS domain. */
export function livelinessKeyExpr(domainId: number): string {
  checkDomain(domainId);
  return `@ros2_lv/${domainId}/**`;
}

// ---------------------------------------------------------------------------
// QoS

/** A reliability value rmw_zenoh can write, from `rmw/types.h`. */
export type QosReliability =
  | 'system-default'
  | 'reliable'
  | 'best-effort'
  | 'unknown'
  | 'best-available';
/** A durability value rmw_zenoh can write, from `rmw/types.h`. */
export type QosDurability =
  | 'system-default'
  | 'transient-local'
  | 'volatile'
  | 'unknown'
  | 'best-available';
/** A history value rmw_zenoh can write, from `rmw/types.h`. */
export type QosHistory = 'system-default' | 'keep-last' | 'keep-all' | 'unknown';

/**
 * The part of an endpoint's QoS this module reads into types. Deadline,
 * lifespan and liveliness are checked but kept only in the raw chunk.
 */
export interface EndpointQos {
  reliability: QosReliability;
  durability: QosDurability;
  history: QosHistory;
  depth: number;
}

/** rmw_zenoh's defaults (`qos.cpp`), which an empty QoS field stands for. */
export const DEFAULT_QOS: Readonly<EndpointQos> = Object.freeze({
  reliability: 'reliable',
  durability: 'volatile',
  history: 'keep-last',
  depth: 42,
});

// rmw enum numbers (`rmw/include/rmw/types.h`, jazzy), as rmw_zenoh's maps
// list them. Humble's rmw has no best-available; a Humble node never writes 4.
const RELIABILITY: readonly (QosReliability | undefined)[] = [
  'system-default',
  'reliable',
  'best-effort',
  'unknown',
  'best-available',
];
const DURABILITY: readonly (QosDurability | undefined)[] = [
  'system-default',
  'transient-local',
  'volatile',
  'unknown',
  'best-available',
];
const HISTORY: readonly (QosHistory | undefined)[] = [
  'system-default',
  'keep-last',
  'keep-all',
  'unknown',
];
// 2 is manual-by-node, deprecated in rmw and absent from rmw_zenoh's map.
const LIVELINESS = new Set(['0', '1', '3', '4', '5']);

const U64_MAX = '18446744073709551615';

/** A decimal unsigned 64-bit number with nothing else in it, as rmw_zenoh's `str_to_size_t` reads one. */
function isU64(s: string): boolean {
  if (!DIGITS.test(s)) return false;
  const t = s.replace(/^0+(?=.)/, '');
  return t.length < U64_MAX.length || (t.length === U64_MAX.length && t <= U64_MAX);
}

/** An enum field: empty means the default, else one of the listed numbers. */
function readEnum<T>(field: string, table: readonly (T | undefined)[], fallback: T): T | null {
  if (field === '') return fallback;
  if (!/^[0-9]$/.test(field)) return null;
  return table[Number(field)] ?? null;
}

/**
 * Read a QoS chunk: `<rel>:<dur>:<hist>,<depth>:<dl s>,<dl ns>:<ls s>,<ls ns>:<liv>,<lease s>,<lease ns>`,
 * each field empty when it is rmw_zenoh's default. `null` where rmw_zenoh's
 * `keyexpr_to_qos` fails, and also on extra groups or fields, which it
 * ignores, on an enum field of more than one digit (`01`), which it reads as
 * the number, and on a depth past 2^53, which it accepts and a JavaScript
 * number cannot hold exactly.
 */
function parseQos(chunk: string): EndpointQos | null {
  // The six groups, split into their fields: rel, dur, hist+depth, deadline,
  // lifespan, liveliness+lease.
  const fields = chunk.split(':').map((g) => g.split(','));
  const widths = fields.map((f) => f.length).join();
  if (widths !== '1,1,2,2,2,3') return null;
  const [[rel], [dur], [hist, depthField], deadline, lifespan, [liveliness, ...lease]] = fields as [
    [string],
    [string],
    [string, string],
    string[],
    string[],
    [string, ...string[]],
  ];
  const reliability = readEnum(rel, RELIABILITY, DEFAULT_QOS.reliability);
  const durability = readEnum(dur, DURABILITY, DEFAULT_QOS.durability);
  const history = readEnum(hist, HISTORY, DEFAULT_QOS.history);
  if (reliability === null || durability === null || history === null) return null;
  if (liveliness !== '' && !LIVELINESS.has(liveliness)) return null;
  const numbers = [depthField, ...deadline, ...lifespan, ...lease];
  if (!numbers.every((n) => n === '' || isU64(n))) return null;
  const depth = depthField === '' ? DEFAULT_QOS.depth : Number(depthField);
  return Number.isSafeInteger(depth) ? { reliability, durability, history, depth } : null;
}

/**
 * Write a QoS chunk the way rmw_zenoh's `qos_to_keyexpr` does: each field
 * only where it differs from the default. Deadline, lifespan and liveliness
 * are always written as defaults.
 */
function encodeQos(qos: EndpointQos): string {
  if (!Number.isSafeInteger(qos.depth) || qos.depth < 0) {
    throw new RangeError(`QoS depth must be a non-negative integer: ${qos.depth}`);
  }
  const num = <T>(table: readonly (T | undefined)[], value: T, fallback: T): string => {
    if (value === fallback) return '';
    const i = table.indexOf(value);
    if (i < 0) throw new RangeError(`not a QoS value: ${String(value)}`);
    return String(i);
  };
  const rel = num(RELIABILITY, qos.reliability, DEFAULT_QOS.reliability);
  const dur = num(DURABILITY, qos.durability, DEFAULT_QOS.durability);
  const hist = num(HISTORY, qos.history, DEFAULT_QOS.history);
  const depth = qos.depth === DEFAULT_QOS.depth ? '' : String(qos.depth);
  return `${rel}:${dur}:${hist},${depth}:,:,:,,`;
}

// ---------------------------------------------------------------------------
// Liveliness tokens

/** The node part every token carries. */
export interface NodeInfo {
  /** The ROS domain id. */
  domainId: number;
  /** The Zenoh session id of the node's process, lowercase hex. */
  zid: string;
  /** The node's id within its session. */
  nodeId: string;
  /** The SROS enclave, `/` when none is set. */
  enclave: string;
  /** The node's namespace, `/` for the root. */
  namespace: string;
  /** The node's name, without its namespace. */
  name: string;
}

/** A graph entity other than a node. */
export type EndpointKind = 'publisher' | 'subscriber' | 'service-server' | 'service-client';

/** A node, from its `NN` token. */
export interface GraphNode {
  kind: 'node';
  /** The token as declared; the entity's identity, as rmw_zenoh hashes it into a GID. */
  token: string;
  node: NodeInfo;
}

/** A publisher, subscriber, service server or service client, from its token. */
export interface GraphEndpoint {
  kind: EndpointKind;
  /** The token as declared; the entity's identity, as rmw_zenoh hashes it into a GID. */
  token: string;
  /** The node the endpoint belongs to. */
  node: NodeInfo;
  /** The endpoint's id within its node. */
  entityId: string;
  /** The fully qualified topic or service name. */
  name: string;
  /** The DDS type name, as on the wire. */
  ddsType: string;
  /** The same type as a ROS name, `pkg/kind/Name`. */
  rosType: string;
  /** The hash segment, as on the wire. */
  hashSegment: string;
  /** Which form the hash segment takes. */
  hashForm: HashForm;
  /** Reliability, durability, history and depth. */
  qos: EndpointQos;
  /** The QoS chunk as declared, deadline, lifespan and liveliness included. */
  qosRaw: string;
  /**
   * The `backends:...` chunk of a buffer-aware endpoint (rmw_zenoh on
   * Lyrical and Rolling), raw, or `null`.
   */
  backends: string | null;
}

/** Anything a liveliness token describes. */
export type GraphEntity = GraphNode | GraphEndpoint;

const ADMIN_SPACE = '@ros2_lv';

const KIND_TO_WIRE: Readonly<Record<EndpointKind, string>> = {
  publisher: 'MP',
  subscriber: 'MS',
  'service-server': 'SS',
  'service-client': 'SC',
};
const WIRE_TO_KIND: ReadonlyMap<string, EndpointKind | 'node'> = new Map<
  string,
  EndpointKind | 'node'
>([
  ['NN', 'node'],
  ['MP', 'publisher'],
  ['MS', 'subscriber'],
  ['SS', 'service-server'],
  ['SC', 'service-client'],
]);

const mangle = (name: string): string => name.replace(/\//g, '%');
const demangle = (name: string): string => name.replace(/%/g, '/');

/**
 * Read one liveliness token, or `null`. Node tokens have 9 chunks, endpoint
 * tokens 13, plus an optional 14th `backends:...`.
 *
 * Refused as rmw_zenoh's `Entity::make` refuses: too few chunks, an empty
 * chunk, an admin space other than `@ros2_lv`, an unknown kind, a QoS chunk
 * that does not parse. Refused here and not by rmw_zenoh: a domain that is not
 * plain decimal without a leading zero, a type chunk not in the
 * `pkg::kind::dds_::Name_` form, a hash segment in neither form, any field
 * {@link nodeToken} or {@link endpointToken} would refuse (zid, ids, enclave,
 * namespace, node name, topic or service name), and a node token whose entity
 * id is not its node id. rmw_zenoh reads most of these as opaque text; this
 * library could not address such an entity, and a parsed field must never make
 * a later build throw. Chunks past the
 * 14th, a 14th that is not `backends:...`, and a node token's chunks past the
 * 9th are ignored, as rmw_zenoh ignores them; `token` keeps them, so two
 * such tokens are two entities.
 */
export function parseLivelinessToken(token: string): GraphEntity | null {
  const chunks = token.split('/');
  if (chunks.length < 9) return null;
  if (chunks.some((c) => c.length === 0)) return null;
  const [admin, domain, zid, nodeId, entityId, kindWire, enclave, namespace, nodeName] = chunks as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (admin !== ADMIN_SPACE) return null;
  const kind = WIRE_TO_KIND.get(kindWire);
  if (kind === undefined) return null;
  const domainId = readDomain(domain);
  if (domainId === null) return null;
  const node: NodeInfo = {
    domainId,
    zid,
    nodeId,
    enclave: demangle(enclave),
    namespace: demangle(namespace),
    name: demangle(nodeName),
  };
  if (!isBuildableNode(node) || !DIGITS.test(entityId)) return null;
  if (kind === 'node') return entityId === nodeId ? { kind, token, node } : null;
  return parseEndpointTail(kind, token, node, entityId, chunks.slice(9));
}

/**
 * Whether `nodeToken` would take these fields back. The parser refuses what
 * the builders refuse, so a peer's token never becomes a RangeError later.
 */
function isBuildableNode(node: NodeInfo): boolean {
  return (
    HEX.test(node.zid) &&
    DIGITS.test(node.nodeId) &&
    isNamespace(node.enclave) &&
    isNamespace(node.namespace) &&
    NAME_CHUNK.test(node.name)
  );
}

/** The chunks after the node name: name, type, hash, QoS and an optional backends chunk. */
function parseEndpointTail(
  kind: EndpointKind,
  token: string,
  node: NodeInfo,
  entityId: string,
  tail: string[],
): GraphEndpoint | null {
  if (tail.length < 4) return null;
  const [name = '', ddsType = '', hashSegment = '', qosRaw = '', extra] = tail;
  const qos = parseQos(qosRaw);
  const rosType = rosTypeName(ddsType);
  const form = hashForm(hashSegment);
  if (qos === null || rosType === null || form === null) return null;
  if (!FQN.test(demangle(name))) return null;
  return {
    kind,
    token,
    node,
    entityId,
    name: demangle(name),
    ddsType,
    rosType,
    hashSegment,
    hashForm: form,
    qos,
    qosRaw,
    backends: extra !== undefined && extra.startsWith('backends:') ? extra : null,
  };
}

/**
 * The token a node declares: `@ros2_lv/<domain>/<zid>/<node id>/<node id>/NN/<enclave>/<namespace>/<name>`,
 * with `/` written `%` in the enclave and namespace. Throws `RangeError` on a
 * field that would not parse back.
 */
export function nodeToken(node: NodeInfo): string {
  return nodePrefix(node, node.nodeId, 'NN');
}

/**
 * The token an endpoint declares. QoS is written as rmw_zenoh writes it, each
 * field only where it differs from {@link DEFAULT_QOS}; deadline, lifespan and
 * liveliness are always the defaults. No backends chunk. Throws `RangeError`
 * on a field that would not parse back.
 */
export function endpointToken(endpoint: {
  node: NodeInfo;
  entityId: string;
  kind: EndpointKind;
  name: string;
  ddsType: string;
  hashSegment: string;
  qos: EndpointQos;
}): string {
  const { node, entityId, kind, name, ddsType, hashSegment, qos } = endpoint;
  if (!DIGITS.test(entityId))
    throw new RangeError(`entity id must be decimal: ${JSON.stringify(entityId)}`);
  checkFqn(name, 'name');
  if (rosTypeName(ddsType) === null)
    throw new RangeError(`not a DDS type name: ${JSON.stringify(ddsType)}`);
  if (hashForm(hashSegment) === null)
    throw new RangeError(`not a type hash segment: ${JSON.stringify(hashSegment)}`);
  const prefix = nodePrefix(node, entityId, KIND_TO_WIRE[kind]);
  return `${prefix}/${mangle(name)}/${ddsType}/${hashSegment}/${encodeQos(qos)}`;
}

/**
 * Which naming form the robot's endpoints use, read from their tokens (ADR
 * 0030, decision 5): `'mixed'` when both appear, `'unknown'` when there is no
 * endpoint to read. Nodes carry no hash and are not counted.
 */
export function detectNamingForm(entities: Iterable<GraphEntity>): HashForm | 'mixed' | 'unknown' {
  let seen: HashForm | null = null;
  for (const e of entities) {
    if (e.kind === 'node') continue;
    if (seen === null) seen = e.hashForm;
    else if (seen !== e.hashForm) return 'mixed';
  }
  return seen ?? 'unknown';
}

function nodePrefix(node: NodeInfo, id: string, kindWire: string): string {
  checkDomain(node.domainId);
  if (!HEX.test(node.zid))
    throw new RangeError(`zid must be lowercase hex: ${JSON.stringify(node.zid)}`);
  if (!DIGITS.test(node.nodeId))
    throw new RangeError(`node id must be decimal: ${JSON.stringify(node.nodeId)}`);
  checkNamespace(node.enclave, 'enclave');
  checkNamespace(node.namespace, 'namespace');
  if (!NAME_CHUNK.test(node.name))
    throw new RangeError(`not a node name: ${JSON.stringify(node.name)}`);
  return [
    ADMIN_SPACE,
    String(node.domainId),
    node.zid,
    node.nodeId,
    id,
    kindWire,
    mangle(node.enclave),
    mangle(node.namespace),
    node.name,
  ].join('/');
}

function readDomain(chunk: string): number | null {
  // No leading zero: `007` would read as 7, and keys built for 7 never match `007/...`.
  if (!/^(?:0|[1-9][0-9]*)$/.test(chunk)) return null;
  const n = Number(chunk);
  return Number.isSafeInteger(n) ? n : null;
}

function checkDomain(domainId: number): void {
  if (!Number.isSafeInteger(domainId) || domainId < 0) {
    throw new RangeError(`domain id must be a non-negative integer: ${domainId}`);
  }
}

function checkFqn(name: string, what: string): void {
  if (!FQN.test(name))
    throw new RangeError(`${what} must be a fully qualified ROS name: ${JSON.stringify(name)}`);
}

function checkNamespace(ns: string, what: string): void {
  if (!isNamespace(ns)) checkFqn(ns, what);
}

function isNamespace(ns: string): boolean {
  return ns === '/' || FQN.test(ns);
}
