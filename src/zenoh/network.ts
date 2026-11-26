// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * Zenoh network messages and the bodies they carry: PUSH (PUT, DEL),
 * REQUEST (QUERY, send only), RESPONSE (REPLY, ERR), RESPONSE_FINAL,
 * DECLARE, INTEREST, with network OAM skipped. Layouts follow
 * `zenoh-protocol/src/{network,zenoh}/` and `zenoh-codec/src/{network,zenoh,core}/`
 * at tag 1.10.1.
 *
 * Network messages travel inside a FRAME (see `transport.ts`). A PUSH is read
 * in two steps so the session can decide on the key before the body is
 * touched: `readNetworkMessage` stops after the PUSH extensions, then the
 * caller runs `readPushBody` or `skipPushBody`. Every other message is read
 * whole.
 *
 * @module
 */

import { ByteReader, ByteWriter, ZenohProtocolError } from './codec';
import { readExtensions, writeExtensions, type Extension } from './extensions';

const ID_MASK = 0x1f;
const FLAG_Z = 0x80;

const NET = {
  INTEREST: 0x19,
  RESPONSE_FINAL: 0x1a,
  RESPONSE: 0x1b,
  REQUEST: 0x1c,
  PUSH: 0x1d,
  DECLARE: 0x1e,
  OAM: 0x1f,
} as const;

const BODY = { PUT: 0x01, DEL: 0x02, QUERY: 0x03, REPLY: 0x04, ERR: 0x05 } as const;

const DECL = {
  D_KEYEXPR: 0x00,
  U_KEYEXPR: 0x01,
  D_SUBSCRIBER: 0x02,
  U_SUBSCRIBER: 0x03,
  D_QUERYABLE: 0x04,
  U_QUERYABLE: 0x05,
  D_TOKEN: 0x06,
  U_TOKEN: 0x07,
  D_FINAL: 0x1a,
} as const;

// Flags shared by PUSH, REQUEST, RESPONSE and the D_* declarations:
// N (0x20) the key has a suffix, M (0x40) the scope is in the sender's mapping.
const FLAG_N = 0x20;
const FLAG_M = 0x40;
// DECLARE: I (0x20) an interest id follows.
const FLAG_I = 0x20;
// PUT, DEL: T (0x20) timestamp. PUT, ERR: E (0x40) encoding. REPLY: C (0x20) consolidation.
const FLAG_T = 0x20;
const FLAG_E = 0x40;
const FLAG_C = 0x20;

// Extension ids, from `zenoh-protocol/src/{network,zenoh}/*.rs`. The network
// messages share QoS (1), Timestamp (2) and NodeId (3, mandatory).
const EXT_PUSH = [0x1, 0x2, 0x3, 0x7] as const; // + TsStack
const EXT_RESPONSE = [0x1, 0x2, 0x3, 0x7] as const; // + ResponderId, TsStack
const EXT_RESPONSE_FINAL = [0x1, 0x2] as const;
const EXT_DECLARE = [0x1, 0x2, 0x3] as const;
const EXT_INTEREST = [0x1, 0x2, 0x3] as const;
const EXT_OAM = [0x1, 0x2] as const;
const EXT_PUT_ATTACHMENT = 0x3;
const EXT_PUT = [0x1, EXT_PUT_ATTACHMENT] as const; // SourceInfo, Attachment; Shm (2, mandatory) is not
const EXT_DEL_ATTACHMENT = 0x2;
const EXT_DEL = [0x1, EXT_DEL_ATTACHMENT] as const;
const EXT_ERR = [0x1] as const; // SourceInfo; Shm (2, mandatory) is not
const EXT_WIRE_EXPR = 0x0f; // U_SUBSCRIBER, U_QUERYABLE, U_TOKEN: mandatory ZBuf
const EXT_QUERYABLE_INFO = 0x1;
const EXT_REQUEST_TARGET = 0x4;
const EXT_QUERY_BODY = 0x3;
const EXT_QUERY_ATTACHMENT = 0x5;

/** Key ids (`ExprId`) and key suffix lengths (`ExprLen`) are 16-bit. */
const U16_MAX = 0xffff;
/** A timestamp's id is a Zenoh id, at most 16 bytes. */
const ZID_MAX = 16;
/** An encoding schema is length-bounded by a u8. */
const SCHEMA_MAX = 0xff;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/** INTEREST options byte `A|M|N|R|T|Q|S|K`. */
const INTEREST_OPT = { K: 0x01, S: 0x02, Q: 0x04, T: 0x08, R: 0x10, N: 0x20, M: 0x40 } as const;

/** INTEREST option: liveliness tokens. Pass to `encodeInterest`. */
export const INTEREST_TOKENS = INTEREST_OPT.T;

/**
 * A key as the wire carries it: a scope (a key id, 0 for none), the suffix
 * after it, and whose id table the scope refers to.
 */
export interface WireExpr {
  scope: number;
  suffix: string;
  /** M flag: the scope is an id the sender declared, not one we declared. */
  senderMapping: boolean;
}

/** A value's encoding: an id and an optional schema, as a view. */
export interface Encoding {
  id: number;
  schema: Uint8Array | null;
}

/** A PUT or DEL. Byte fields are views into the received batch. */
export interface PushBody {
  kind: 'put' | 'del';
  /** The value; empty for a DEL. */
  payload: Uint8Array;
  attachment: Uint8Array | null;
  /** Null when the PUT carried none (Zenoh's empty encoding) and for a DEL. */
  encoding: Encoding | null;
  /** The NTP64 time and the Zenoh id of the clock that stamped it. */
  timestamp: { time: bigint; zid: Uint8Array } | null;
}

/** A declaration inside a DECLARE. Queryable declarations are read and reported as `other`. */
export type Declaration =
  | { kind: 'd-keyexpr'; id: number; wire: WireExpr }
  | { kind: 'u-keyexpr'; id: number }
  | { kind: 'd-subscriber'; id: number; wire: WireExpr }
  /** `wire` is the wire-expression extension; null when absent or the null wire expression. */
  | { kind: 'u-subscriber'; id: number; wire: WireExpr | null }
  | { kind: 'd-token'; id: number; wire: WireExpr }
  /** `wire` is the wire-expression extension; null when absent or the null wire expression. */
  | { kind: 'u-token'; id: number; wire: WireExpr | null }
  | { kind: 'd-final' }
  | { kind: 'other' };

/** The body of a RESPONSE. */
export type ResponseBody =
  | { kind: 'reply'; sample: PushBody }
  | { kind: 'err'; payload: Uint8Array; encoding: Encoding | null };

/** A network message read from a FRAME body. */
export type NetworkMessage =
  /** A PUSH header. The body follows: read it with `readPushBody` or `skipPushBody`. */
  | { kind: 'push'; wire: WireExpr }
  | { kind: 'response'; rid: number; wire: WireExpr; body: ResponseBody }
  | { kind: 'response-final'; rid: number }
  /** `interestId` is set when the declaration answers an interest's current phase. */
  | { kind: 'declare'; interestId: number | null; decl: Declaration }
  | { kind: 'interest'; id: number; mode: InterestMode | 'final' }
  | { kind: 'oam' };

/** What an INTEREST asks for: what exists now, and optionally what comes later. */
export type InterestMode = 'current' | 'future' | 'current-future';

const INTEREST_MODES = ['final', 'current', 'future', 'current-future'] as const;

/** The QueryTarget extension: which matching queryables answer. */
export type QueryTarget = 'best-matching' | 'all' | 'all-complete';

const QUERY_TARGET: Record<QueryTarget, bigint> = {
  'best-matching': 0n,
  all: 1n,
  'all-complete': 2n,
};

// ---------------------------------------------------------------------------
// Keys

function writeKey(w: ByteWriter, key: string): void {
  const bytes = TEXT_ENCODER.encode(key);
  if (bytes.length > U16_MAX) throw new RangeError(`key longer than ${U16_MAX} bytes`);
  w.vle(0).bytes(bytes);
}

function readU16(r: ByteReader, what: string): number {
  const v = r.vle32();
  if (v > U16_MAX) throw new ZenohProtocolError(`${what} above 16 bits`);
  return v;
}

function readWire(r: ByteReader, named: boolean, senderMapping: boolean): WireExpr {
  const scope = readU16(r, 'key scope');
  let suffix = '';
  if (named) {
    const bytes = r.take(readU16(r, 'key length'));
    suffix = TEXT_DECODER.decode(bytes);
  }
  return { scope, suffix, senderMapping };
}

/**
 * The full key a wire expression names. A scope must be an id the router
 * declared with D_KEYEXPR (`routerKeys`) and the wire must say so (M flag):
 * the client declares no ids of its own, so a scope in its mapping, or one
 * the router never declared, is a protocol error and not a guess.
 */
export function resolveKey(wire: WireExpr, routerKeys: ReadonlyMap<number, string>): string {
  if (wire.scope === 0) return wire.suffix;
  if (!wire.senderMapping) {
    throw new ZenohProtocolError(`key scope ${wire.scope} in the client's mapping, which is empty`);
  }
  const prefix = routerKeys.get(wire.scope);
  if (prefix === undefined) throw new ZenohProtocolError(`key scope ${wire.scope} never declared`);
  return prefix + wire.suffix;
}

/**
 * The wire-expression extension of an undeclaration: a ZBuf holding a flags
 * byte (N = 0x01, M = 0x02), a scope, and the suffix as raw bytes to its end.
 */
function readWireExt(value: Uint8Array): WireExpr {
  const inner = new ByteReader(value);
  const flags = inner.u8();
  const scope = readU16(inner, 'key scope');
  const suffix = flags & 0x01 ? TEXT_DECODER.decode(inner.rest()) : '';
  return { scope, suffix, senderMapping: (flags & 0x02) !== 0 };
}

// ---------------------------------------------------------------------------
// Bodies

function readTimestamp(r: ByteReader): { time: bigint; zid: Uint8Array } {
  const time = r.vle64();
  const size = r.vle32();
  if (size > ZID_MAX) throw new ZenohProtocolError('timestamp id longer than 16 bytes');
  return { time, zid: r.take(size) };
}

function readEncoding(r: ByteReader): Encoding {
  const v = r.vle32();
  let schema: Uint8Array | null = null;
  if (v & 0x01) {
    schema = r.bytes();
    if (schema.length > SCHEMA_MAX) throw new ZenohProtocolError('encoding schema too long');
  }
  return { id: Math.floor(v / 2), schema };
}

function zbufOf(exts: readonly Extension[], id: number): Uint8Array | null {
  for (const ext of exts) if (ext.id === id && ext.enc === 'zbuf') return ext.value;
  return null;
}

function readBody(r: ByteReader, readPayload: boolean): PushBody {
  const h = r.u8();
  const id = h & ID_MASK;
  if (id === BODY.PUT) {
    const timestamp = h & FLAG_T ? readTimestamp(r) : null;
    const encoding = h & FLAG_E ? readEncoding(r) : null;
    const exts = h & FLAG_Z ? readExtensions(r, EXT_PUT) : [];
    let payload: Uint8Array;
    if (readPayload) {
      payload = r.bytes();
    } else {
      r.skip(r.vle32());
      payload = EMPTY;
    }
    return {
      kind: 'put',
      payload,
      attachment: zbufOf(exts, EXT_PUT_ATTACHMENT),
      encoding,
      timestamp,
    };
  }
  if (id === BODY.DEL) {
    const timestamp = h & FLAG_T ? readTimestamp(r) : null;
    const exts = h & FLAG_Z ? readExtensions(r, EXT_DEL) : [];
    return {
      kind: 'del',
      payload: EMPTY,
      attachment: zbufOf(exts, EXT_DEL_ATTACHMENT),
      encoding: null,
      timestamp,
    };
  }
  throw new ZenohProtocolError(`PUSH body 0x${id.toString(16)} is neither PUT nor DEL`);
}

const EMPTY = new Uint8Array(0);

/** Read the PUT or DEL that follows a PUSH header. */
export function readPushBody(r: ByteReader): PushBody {
  return readBody(r, true);
}

/**
 * Move past the PUT or DEL that follows a PUSH header. The payload is skipped
 * by its length and never read; the small fields before it are parsed, since
 * the payload's position depends on them.
 */
export function skipPushBody(r: ByteReader): void {
  readBody(r, false);
}

// ---------------------------------------------------------------------------
// Reading

/** Whether a network message header byte is a PUSH. */
export function isPushHeader(header: number): boolean {
  return (header & ID_MASK) === NET.PUSH;
}

/**
 * Read one network message at the reader's position, which must be inside a
 * FRAME body. For a PUSH this stops after its extensions; see the module
 * comment. Throws `ZenohProtocolError` on malformed input, on a REQUEST (the
 * client declares no queryable), and on any id that is not a network message.
 */
export function readNetworkMessage(r: ByteReader): NetworkMessage {
  const h = r.u8();
  const id = h & ID_MASK;
  const read = NETWORK_READERS[id];
  if (read === undefined) {
    throw new ZenohProtocolError(`0x${id.toString(16)} is not a network message`);
  }
  return read(r, h);
}

type Reader = (r: ByteReader, h: number) => NetworkMessage;

function readPushHeader(r: ByteReader, h: number): NetworkMessage {
  const wire = readWire(r, (h & FLAG_N) !== 0, (h & FLAG_M) !== 0);
  if (h & FLAG_Z) readExtensions(r, EXT_PUSH);
  return { kind: 'push', wire };
}

function readResponseFinal(r: ByteReader, h: number): NetworkMessage {
  const rid = r.vle32();
  if (h & FLAG_Z) readExtensions(r, EXT_RESPONSE_FINAL);
  return { kind: 'response-final', rid };
}

function readDeclare(r: ByteReader, h: number): NetworkMessage {
  const interestId = h & FLAG_I ? r.vle32() : null;
  if (h & FLAG_Z) readExtensions(r, EXT_DECLARE);
  return { kind: 'declare', interestId, decl: readDeclaration(r) };
}

function readOam(r: ByteReader, h: number): NetworkMessage {
  skipOam(r, h);
  return { kind: 'oam' };
}

function refuseRequest(): never {
  throw new ZenohProtocolError('REQUEST received, but the client declares no queryable');
}

/** One reader per network message id; an id missing here is not a network message. */
const NETWORK_READERS: Partial<Record<number, Reader>> = {
  [NET.PUSH]: readPushHeader,
  [NET.RESPONSE]: readResponse,
  [NET.RESPONSE_FINAL]: readResponseFinal,
  [NET.DECLARE]: readDeclare,
  [NET.INTEREST]: readInterest,
  [NET.OAM]: readOam,
  [NET.REQUEST]: refuseRequest,
};

function readResponse(r: ByteReader, h: number): NetworkMessage {
  const rid = r.vle32();
  const wire = readWire(r, (h & FLAG_N) !== 0, (h & FLAG_M) !== 0);
  if (h & FLAG_Z) readExtensions(r, EXT_RESPONSE);
  const bh = r.u8();
  const bid = bh & ID_MASK;
  if (bid === BODY.REPLY) {
    if (bh & FLAG_C) r.vle32();
    if (bh & FLAG_Z) readExtensions(r, []);
    return { kind: 'response', rid, wire, body: { kind: 'reply', sample: readPushBody(r) } };
  }
  if (bid === BODY.ERR) {
    const encoding = bh & FLAG_E ? readEncoding(r) : null;
    if (bh & FLAG_Z) readExtensions(r, EXT_ERR);
    return { kind: 'response', rid, wire, body: { kind: 'err', payload: r.bytes(), encoding } };
  }
  throw new ZenohProtocolError(`RESPONSE body 0x${bid.toString(16)} is neither REPLY nor ERR`);
}

function readDeclaration(r: ByteReader): Declaration {
  const h = r.u8();
  const id = h & ID_MASK;
  const named = (h & FLAG_N) !== 0;
  const sender = (h & FLAG_M) !== 0;
  const ext = (known: readonly number[]): Extension[] =>
    h & FLAG_Z ? readExtensions(r, known) : [];
  // The null wire expression (scope 0, no suffix, receiver mapping) names no
  // key: upstream's WireExprType::null(), which rmw_zenohd (zenoh 1.10.1) puts on
  // every U_TOKEN. It reads as an absent extension, so the id resolves.
  const undeclaredWire = (exts: readonly Extension[]): WireExpr | null => {
    const v = zbufOf(exts, EXT_WIRE_EXPR);
    if (v === null) return null;
    const wire = readWireExt(v);
    return wire.scope === 0 && wire.suffix === '' && !wire.senderMapping ? null : wire;
  };
  switch (id) {
    case DECL.D_KEYEXPR: {
      const eid = readU16(r, 'key id');
      // D_KEYEXPR has no M flag: its scope is in the receiver's mapping.
      const wire = readWire(r, named, false);
      ext([]);
      return { kind: 'd-keyexpr', id: eid, wire };
    }
    case DECL.U_KEYEXPR: {
      const eid = readU16(r, 'key id');
      ext([]);
      return { kind: 'u-keyexpr', id: eid };
    }
    case DECL.D_SUBSCRIBER: {
      const sid = r.vle32();
      const wire = readWire(r, named, sender);
      ext([]);
      return { kind: 'd-subscriber', id: sid, wire };
    }
    case DECL.U_SUBSCRIBER: {
      const sid = r.vle32();
      return { kind: 'u-subscriber', id: sid, wire: undeclaredWire(ext([EXT_WIRE_EXPR])) };
    }
    case DECL.D_TOKEN: {
      const tid = r.vle32();
      const wire = readWire(r, named, sender);
      ext([]);
      return { kind: 'd-token', id: tid, wire };
    }
    case DECL.U_TOKEN: {
      const tid = r.vle32();
      return { kind: 'u-token', id: tid, wire: undeclaredWire(ext([EXT_WIRE_EXPR])) };
    }
    case DECL.D_QUERYABLE:
      r.vle32();
      readWire(r, named, sender);
      ext([EXT_QUERYABLE_INFO]);
      return { kind: 'other' };
    case DECL.U_QUERYABLE:
      r.vle32();
      ext([EXT_WIRE_EXPR]);
      return { kind: 'other' };
    case DECL.D_FINAL:
      ext([]);
      return { kind: 'd-final' };
    default:
      throw new ZenohProtocolError(`unknown declaration 0x${id.toString(16)}`);
  }
}

function readInterest(r: ByteReader, h: number): NetworkMessage {
  const id = r.vle32();
  const mode = INTEREST_MODES[(h >> 5) & 0b11]!;
  if (mode !== 'final') {
    const opts = r.u8();
    if (opts & INTEREST_OPT.R) {
      readWire(r, (opts & INTEREST_OPT.N) !== 0, (opts & INTEREST_OPT.M) !== 0);
    }
  }
  if (h & FLAG_Z) readExtensions(r, EXT_INTEREST);
  return { kind: 'interest', id, mode };
}

/** Network OAM `Z|ENC(2)|OAM`: a 16-bit id, extensions, then a body by ENC. */
function skipOam(r: ByteReader, h: number): void {
  readU16(r, 'OAM id');
  if (h & FLAG_Z) readExtensions(r, EXT_OAM);
  const enc = (h >> 5) & 0b11;
  if (enc === 1) r.vle64();
  else if (enc === 2) r.skip(r.vle32());
  else if (enc === 3) throw new ZenohProtocolError('OAM with the reserved encoding');
}

// ---------------------------------------------------------------------------
// Writing. Every key goes as a full string: scope 0, N set, M clear.

function declare(write: (w: ByteWriter) => void): Uint8Array {
  const w = new ByteWriter(32).u8(NET.DECLARE);
  write(w);
  return w.finish();
}

/** DECLARE D_SUBSCRIBER for `key` with the client's subscriber id. */
export function encodeDeclareSubscriber(id: number, key: string): Uint8Array {
  return declare((w) => {
    w.u8(DECL.D_SUBSCRIBER | FLAG_N).vle(id);
    writeKey(w, key);
  });
}

/** DECLARE U_SUBSCRIBER, by id alone. */
export function encodeUndeclareSubscriber(id: number): Uint8Array {
  return declare((w) => w.u8(DECL.U_SUBSCRIBER).vle(id));
}

/** DECLARE D_TOKEN for `key` with the client's token id. */
export function encodeDeclareToken(id: number, key: string): Uint8Array {
  return declare((w) => {
    w.u8(DECL.D_TOKEN | FLAG_N).vle(id);
    writeKey(w, key);
  });
}

/** DECLARE U_TOKEN, by id alone. */
export function encodeUndeclareToken(id: number): Uint8Array {
  return declare((w) => w.u8(DECL.U_TOKEN).vle(id));
}

/**
 * INTEREST restricted to `key` (R and N set, M clear), asking for the kinds
 * in `options` (`INTEREST_TOKENS`). Never sets K, so the router answers with
 * full key strings and no key ids.
 */
export function encodeInterest(
  id: number,
  mode: InterestMode,
  key: string,
  options: number,
): Uint8Array {
  const w = new ByteWriter(32)
    .u8(NET.INTEREST | (INTEREST_MODES.indexOf(mode) << 5))
    .vle(id)
    .u8(
      (options & (INTEREST_OPT.S | INTEREST_OPT.Q | INTEREST_OPT.T)) |
        INTEREST_OPT.R |
        INTEREST_OPT.N,
    );
  writeKey(w, key);
  return w.finish();
}

/** INTEREST in mode Final: stop the declarations an earlier interest asked for. */
export function encodeInterestFinal(id: number): Uint8Array {
  return new ByteWriter(8).u8(NET.INTEREST).vle(id).finish();
}

/**
 * PUSH carrying a PUT of `payload` to `key`, with no encoding (Zenoh's
 * empty one) and no timestamp, and `attachment` when given.
 */
export function encodePut(key: string, payload: Uint8Array, attachment?: Uint8Array): Uint8Array {
  const w = new ByteWriter(payload.length + key.length + 32).u8(NET.PUSH | FLAG_N);
  writeKey(w, key);
  if (attachment === undefined) {
    w.u8(BODY.PUT);
  } else {
    w.u8(BODY.PUT | FLAG_Z);
    writeExtensions(w, [
      { id: EXT_PUT_ATTACHMENT, mandatory: false, enc: 'zbuf', value: attachment },
    ]);
  }
  return w.bytes(payload).finish();
}

/**
 * REQUEST carrying a QUERY on `key`. The QueryBody extension holds the
 * encoding (the empty one) and then the payload with **no** length prefix:
 * the extension's own length bounds it (`ValueType` in
 * `zenoh-codec/src/zenoh/mod.rs`). With a length prefix the queryable cannot
 * deserialize the body, and only RESPONSE_FINAL comes back.
 */
export function encodeQuery(
  rid: number,
  key: string,
  opts: { target: QueryTarget; payload?: Uint8Array; attachment?: Uint8Array },
): Uint8Array {
  const w = new ByteWriter((opts.payload?.length ?? 0) + key.length + 48)
    .u8(NET.REQUEST | FLAG_N | FLAG_Z)
    .vle(rid);
  writeKey(w, key);
  writeExtensions(w, [
    { id: EXT_REQUEST_TARGET, mandatory: true, enc: 'z64', value: QUERY_TARGET[opts.target] },
  ]);
  const exts: Extension[] = [];
  if (opts.payload !== undefined) {
    const body = new ByteWriter(opts.payload.length + 1).vle(0).raw(opts.payload).finish();
    exts.push({ id: EXT_QUERY_BODY, mandatory: false, enc: 'zbuf', value: body });
  }
  if (opts.attachment !== undefined) {
    exts.push({ id: EXT_QUERY_ATTACHMENT, mandatory: false, enc: 'zbuf', value: opts.attachment });
  }
  w.u8(BODY.QUERY | (exts.length > 0 ? FLAG_Z : 0));
  writeExtensions(w, exts);
  return w.finish();
}
