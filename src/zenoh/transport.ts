// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * Zenoh transport messages: INIT, OPEN, CLOSE, KEEP_ALIVE, FRAME, FRAGMENT,
 * with OAM skipped. Layouts and flags follow `zenoh-protocol/src/transport/`
 * and `zenoh-codec/src/transport/` at tag 1.10.1.
 *
 * Every message starts with a header byte: the low 5 bits are the message
 * id, the top 3 its flags. Bit 7 (Z) always means extensions follow.
 *
 * On the `ws/` link one WebSocket message is one batch, with no length
 * prefix, and a batch may hold several transport messages. A FRAME has no
 * length: its body is the network messages that follow it, up to the next
 * transport header or the end of the batch (`frameBodyContinues`). A
 * FRAGMENT's chunk is everything left in the batch.
 *
 * @module
 */

import { ByteWriter, ZenohProtocolError, vleLength, type ByteReader } from './codec';
import { readExtensions } from './extensions';

const ID_MASK = 0x1f;
const FLAG_Z = 0x80;

const ID = {
  OAM: 0x00,
  INIT: 0x01,
  OPEN: 0x02,
  CLOSE: 0x03,
  KEEP_ALIVE: 0x04,
  FRAME: 0x05,
  FRAGMENT: 0x06,
  JOIN: 0x07,
} as const;

/** Lowest network message id (INTEREST); the network ids run 0x19 to 0x1f. */
const NETWORK_ID_MIN = 0x19;

// INIT and OPEN: A = 0x20 (ack), S = 0x40 (size params, INIT), T = 0x40 (lease in seconds, OPEN).
const FLAG_A = 0x20;
const FLAG_S = 0x40;
const FLAG_T = 0x40;
// CLOSE: S = 0x20 (whole session, not one link).
const FLAG_CLOSE_SESSION = 0x20;
// FRAME and FRAGMENT: R = 0x20 (reliable). FRAGMENT: M = 0x40 (more follow).
const FLAG_R = 0x20;
const FLAG_M = 0x40;

/** Protocol version 9 is Zenoh 1.x; 8 is 0.11 and earlier. */
export const ZENOH_PROTOCOL_VERSION = 0x09;

/** Default batch size on unicast links, and the most a u16 can carry. */
const BATCH_SIZE_UNICAST = 0xffff;

/** Resolution byte `x|x|x|x|rid|fsn`; 0b10 is 32 bits, upstream's default for both. */
const RESOLUTION_32_32 = 0b1010;

const WHATAMI_CLIENT = 0b10;

// Extension ids per message, from `zenoh-protocol/src/transport/*.rs`.
const EXT_INIT_PATCH = 0x7;
const EXT_QOS = 0x1; // FRAME, FRAGMENT, OAM: Z64, mandatory
const EXT_FRAGMENT_FIRST = 0x2;
const EXT_FRAGMENT_DROP = 0x3;

/** Close reasons, `zenoh-protocol/src/transport/close.rs`. */
export const CLOSE_REASON = {
  GENERIC: 0x00,
  UNSUPPORTED: 0x01,
  INVALID: 0x02,
  MAX_SESSIONS: 0x03,
  MAX_LINKS: 0x04,
  EXPIRED: 0x05,
  UNRESPONSIVE: 0x06,
  CONNECTION_TO_SELF: 0x07,
} as const;

/**
 * Most bytes a FRAME or FRAGMENT header takes with no extensions: the header
 * byte plus a 32-bit sequence number as a VLE (up to 5 bytes). A network
 * message larger than the batch size minus this goes out as fragments.
 */
export const FRAGMENT_HEADER_MAX = 1 + vleLength(0xffffffff);

/** A transport message read from a batch. */
export type TransportMessage =
  | {
      kind: 'init-ack';
      version: typeof ZENOH_PROTOCOL_VERSION;
      whatami: 'router' | 'peer' | 'client';
      /** The router's Zenoh id, 1 to 16 bytes, as a view. */
      zid: Uint8Array;
      /** The largest batch the router reads. */
      batchSize: number;
      /** Opaque state the OpenSyn must echo, as a view. */
      cookie: Uint8Array;
      /** The router's Patch extension; 0 when absent (1.0.0 behaviour). */
      patch: number;
    }
  /**
   * An InitAck in another protocol version. Nothing after the version byte
   * is read, since its layout may differ; the rest of the batch is consumed.
   */
  | { kind: 'init-ack-version'; version: number }
  | { kind: 'open-ack'; leaseMs: number; initialSn: number }
  /** `session` false means the router closed one link of a multi-link session. */
  | { kind: 'close'; reason: number; session: boolean }
  | { kind: 'keep-alive' }
  /**
   * A FRAME header. Its network messages follow in the reader; read them
   * while `frameBodyContinues` holds.
   */
  | { kind: 'frame'; reliable: boolean; sn: number }
  | {
      kind: 'fragment';
      reliable: boolean;
      /** M flag: another fragment of this message follows. */
      more: boolean;
      sn: number;
      /** First marker: this fragment starts a message. */
      first: boolean;
      /** Drop marker: discard the partial message on this channel. */
      drop: boolean;
      /** The rest of the batch, as a view. */
      chunk: Uint8Array;
    }
  | { kind: 'oam' };

const WHATAMI = ['router', 'peer', 'client'] as const;

function assertZid(zid: Uint8Array): void {
  if (zid.length < 1 || zid.length > 16) {
    throw new RangeError(`a Zenoh id is 1 to 16 bytes, got ${zid.length}`);
  }
}

/**
 * The client's InitSyn: version 9, client role, 32-bit sequence numbers and
 * request ids, batch size 65,535, no extensions (so no Patch: the router
 * gives 1.0.0 behaviour). 22 bytes with a 16-byte zid.
 */
export function encodeInitSyn(zid: Uint8Array): Uint8Array {
  assertZid(zid);
  return new ByteWriter(6 + zid.length)
    .u8(ID.INIT | FLAG_S)
    .u8(ZENOH_PROTOCOL_VERSION)
    .u8(((zid.length - 1) << 4) | WHATAMI_CLIENT)
    .raw(zid)
    .u8(RESOLUTION_32_32)
    .u8(BATCH_SIZE_UNICAST & 0xff)
    .u8(BATCH_SIZE_UNICAST >> 8)
    .finish();
}

/**
 * The client's OpenSyn. The lease goes in milliseconds (T clear). Upstream
 * sends seconds when the lease is a whole number of them; routers read
 * either form.
 */
export function encodeOpenSyn(leaseMs: number, initialSn: number, cookie: Uint8Array): Uint8Array {
  return new ByteWriter(16 + cookie.length)
    .u8(ID.OPEN)
    .vle(leaseMs)
    .vle(initialSn)
    .bytes(cookie)
    .finish();
}

/** A session CLOSE (S set) with `reason`, one of `CLOSE_REASON`. */
export function encodeClose(reason: number): Uint8Array {
  return new ByteWriter(2)
    .u8(ID.CLOSE | FLAG_CLOSE_SESSION)
    .u8(reason)
    .finish();
}

/** A KEEP_ALIVE: the header byte alone. */
export function encodeKeepAlive(): Uint8Array {
  return Uint8Array.of(ID.KEEP_ALIVE);
}

/** A FRAME holding one encoded network message. */
export function encodeFrame(reliable: boolean, sn: number, message: Uint8Array): Uint8Array {
  return new ByteWriter(FRAGMENT_HEADER_MAX + message.length)
    .u8(ID.FRAME | (reliable ? FLAG_R : 0))
    .vle(sn)
    .raw(message)
    .finish();
}

/**
 * A FRAGMENT holding `chunk`. No First or Drop marker: the client does not
 * negotiate Patch, so it never sends them.
 */
export function encodeFragment(
  reliable: boolean,
  more: boolean,
  sn: number,
  chunk: Uint8Array,
): Uint8Array {
  return new ByteWriter(FRAGMENT_HEADER_MAX + chunk.length)
    .u8(ID.FRAGMENT | (reliable ? FLAG_R : 0) | (more ? FLAG_M : 0))
    .vle(sn)
    .raw(chunk)
    .finish();
}

/**
 * Whether the reader is still inside a FRAME body: bytes are left and the
 * next header carries a network message id, not a transport one.
 */
export function frameBodyContinues(r: ByteReader): boolean {
  return r.more() && (r.peek() & ID_MASK) >= NETWORK_ID_MIN;
}

/**
 * Read one transport message at the reader's position. Throws
 * `ZenohProtocolError` on malformed input and on any message a client must
 * not receive (InitSyn, OpenSyn, JOIN, a network message outside a FRAME).
 */
export function readTransportMessage(r: ByteReader): TransportMessage {
  const h = r.u8();
  const id = h & ID_MASK;
  const read = TRANSPORT_READERS[id];
  if (read !== undefined) return read(r, h);
  if (id >= NETWORK_ID_MIN) {
    throw new ZenohProtocolError(`network message 0x${id.toString(16)} outside a FRAME`);
  }
  throw new ZenohProtocolError(`unknown transport message 0x${id.toString(16)}`);
}

type Reader = (r: ByteReader, h: number) => TransportMessage;

function readInit(r: ByteReader, h: number): TransportMessage {
  if ((h & FLAG_A) === 0) throw new ZenohProtocolError('InitSyn received by a client');
  return readInitAck(r, h);
}

function readOpen(r: ByteReader, h: number): TransportMessage {
  if ((h & FLAG_A) === 0) throw new ZenohProtocolError('OpenSyn received by a client');
  return readOpenAck(r, h);
}

function readClose(r: ByteReader, h: number): TransportMessage {
  const reason = r.u8();
  if (h & FLAG_Z) readExtensions(r, []);
  return { kind: 'close', reason, session: (h & FLAG_CLOSE_SESSION) !== 0 };
}

function readKeepAlive(r: ByteReader, h: number): TransportMessage {
  if (h & FLAG_Z) readExtensions(r, []);
  return { kind: 'keep-alive' };
}

function readFrame(r: ByteReader, h: number): TransportMessage {
  const sn = r.vle32();
  if (h & FLAG_Z) readExtensions(r, [EXT_QOS]);
  return { kind: 'frame', reliable: (h & FLAG_R) !== 0, sn };
}

function readOam(r: ByteReader, h: number): TransportMessage {
  skipOam(r, h);
  return { kind: 'oam' };
}

function refuseJoin(): never {
  throw new ZenohProtocolError('JOIN received on a unicast session');
}

/** One reader per transport message id. */
const TRANSPORT_READERS: Partial<Record<number, Reader>> = {
  [ID.INIT]: readInit,
  [ID.OPEN]: readOpen,
  [ID.CLOSE]: readClose,
  [ID.KEEP_ALIVE]: readKeepAlive,
  [ID.FRAME]: readFrame,
  [ID.FRAGMENT]: readFragment,
  [ID.OAM]: readOam,
  [ID.JOIN]: refuseJoin,
};

function readInitAck(r: ByteReader, h: number): TransportMessage {
  const version = r.u8();
  if (version !== ZENOH_PROTOCOL_VERSION) {
    r.rest();
    return { kind: 'init-ack-version', version };
  }
  const flags = r.u8();
  const whatami = WHATAMI[flags & 0b11];
  if (whatami === undefined) throw new ZenohProtocolError('InitAck with the reserved whatami');
  const zid = r.take(1 + (flags >> 4));
  let resolution = RESOLUTION_32_32;
  let batchSize = BATCH_SIZE_UNICAST;
  if (h & FLAG_S) {
    resolution = r.u8();
    batchSize = r.u8() | (r.u8() << 8);
  }
  // The InitSyn asked for 32 bits for both; the sequence-number arithmetic
  // and the request ids assume them, so any other agreement is refused.
  if ((resolution & 0x0f) !== RESOLUTION_32_32) {
    throw new ZenohProtocolError(
      `InitAck resolution 0x${resolution.toString(16)}, not the 32-bit one asked for`,
    );
  }
  const cookie = r.bytes();
  if (cookie.length > BATCH_SIZE_UNICAST) throw new ZenohProtocolError('InitAck cookie too long');
  let patch = 0;
  if (h & FLAG_Z) {
    for (const ext of readExtensions(r, [EXT_INIT_PATCH])) {
      if (ext.enc === 'z64') patch = Number(BigInt.asUintN(8, ext.value));
    }
  }
  return {
    kind: 'init-ack',
    version,
    whatami,
    zid,
    batchSize,
    cookie,
    patch,
  };
}

function readOpenAck(r: ByteReader, h: number): TransportMessage {
  const lease = Number(r.vle64());
  const initialSn = r.vle32();
  if (h & FLAG_Z) readExtensions(r, []);
  return { kind: 'open-ack', leaseMs: h & FLAG_T ? lease * 1000 : lease, initialSn };
}

function readFragment(r: ByteReader, h: number): TransportMessage {
  const sn = r.vle32();
  let first = false;
  let drop = false;
  if (h & FLAG_Z) {
    for (const ext of readExtensions(r, [EXT_QOS, EXT_FRAGMENT_FIRST, EXT_FRAGMENT_DROP])) {
      if (ext.id === EXT_FRAGMENT_FIRST) first = true;
      else if (ext.id === EXT_FRAGMENT_DROP) drop = true;
    }
  }
  return {
    kind: 'fragment',
    reliable: (h & FLAG_R) !== 0,
    more: (h & FLAG_M) !== 0,
    sn,
    first,
    drop,
    chunk: r.rest(),
  };
}

/**
 * OAM header `Z|ENC(2)|OAM`: a 16-bit id, extensions, then a body whose
 * encoding the header's ENC bits give, as an extension's would.
 */
function skipOam(r: ByteReader, h: number): void {
  r.vle32();
  if (h & FLAG_Z) readExtensions(r, [EXT_QOS]);
  const enc = (h >> 5) & 0b11;
  if (enc === 1) r.vle64();
  else if (enc === 2) r.skip(r.vle32());
  else if (enc === 3) throw new ZenohProtocolError('OAM with the reserved encoding');
}
