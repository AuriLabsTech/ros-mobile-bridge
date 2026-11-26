// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * Byte-level primitives of the Zenoh wire format: variable-length integers,
 * length-prefixed bytes and strings, over a growable writer and a
 * bounds-checked reader.
 *
 * Internal to the Zenoh session layer. Nothing here knows about ROS.
 *
 * @module
 */

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/** Largest value a 32-bit Zenoh field may carry. */
const U32_MAX = 0xffffffff;

/**
 * Most bytes a Zenoh VLE takes. Upstream (`zenoh-codec/src/core/zint.rs`)
 * caps a 64-bit value at 9 bytes: the first 8 carry 7 bits each behind a
 * continuation bit, and the 9th carries the last 8 bits with no continuation
 * bit. That is not plain LEB128, which would need 10 bytes for `2^64 - 1`.
 */
const VLE_MAX_BYTES = 9;

/**
 * Malformed or unsupported input from the router. The session ends with a
 * `protocol-error` when one escapes a parse.
 */
export class ZenohProtocolError extends Error {
  /** @param message What was wrong, for the session-end report. */
  constructor(message: string) {
    super(message);
    this.name = 'ZenohProtocolError';
  }
}

/** Number of bytes `ByteWriter.vle` writes for `value`. */
export function vleLength(value: number): number {
  let n = 1;
  let v = value;
  while (v >= 0x80) {
    v = Math.floor(v / 0x80);
    n++;
  }
  return n;
}

function assertU32(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > U32_MAX) {
    throw new RangeError(`not a 32-bit unsigned integer: ${value}`);
  }
}

/** Growable output buffer. Capacity doubles when a write would overflow it. */
export class ByteWriter {
  private buf: Uint8Array;
  private n = 0;

  /** @param capacity Initial capacity in bytes. */
  constructor(capacity = 64) {
    this.buf = new Uint8Array(Math.max(1, capacity));
  }

  /** Bytes written so far. */
  get length(): number {
    return this.n;
  }

  private reserve(extra: number): void {
    const needed = this.n + extra;
    if (needed <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < needed) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.n));
    this.buf = next;
  }

  /** Write one byte (the low 8 bits of `value`). */
  u8(value: number): this {
    this.reserve(1);
    this.buf[this.n++] = value & 0xff;
    return this;
  }

  /**
   * Write a VLE for a field the spec bounds to 32 bits (sequence numbers,
   * ids, lengths). Throws `RangeError` for anything else: a caller bug.
   */
  vle(value: number): this {
    assertU32(value);
    let v = value;
    while (v >= 0x80) {
      this.u8((v & 0x7f) | 0x80);
      v = Math.floor(v / 0x80);
    }
    return this.u8(v);
  }

  /** Write a VLE for a 64-bit field, with upstream's 9-byte cap. */
  vle64(value: bigint): this {
    if (value < 0n || value > 0xffffffffffffffffn) {
      throw new RangeError(`not a 64-bit unsigned integer: ${value}`);
    }
    let v = value;
    for (let i = 0; i < VLE_MAX_BYTES - 1 && v >= 0x80n; i++) {
      this.u8(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    return this.u8(Number(v));
  }

  /** Write bytes as they are, with no length prefix. */
  raw(bytes: Uint8Array): this {
    this.reserve(bytes.length);
    this.buf.set(bytes, this.n);
    this.n += bytes.length;
    return this;
  }

  /** Write a VLE length, then the bytes. */
  bytes(bytes: Uint8Array): this {
    return this.vle(bytes.length).raw(bytes);
  }

  /** Write a string as length-prefixed UTF-8. */
  str(value: string): this {
    return this.bytes(TEXT_ENCODER.encode(value));
  }

  /** The bytes written, as a view into the writer's buffer. */
  finish(): Uint8Array {
    return this.buf.subarray(0, this.n);
  }
}

/**
 * Bounds-checked reader over a byte view. Every read checks the bytes left
 * before it happens, so a forged length raises before anything is allocated.
 * Byte results are views into the source, never copies.
 */
export class ByteReader {
  private readonly src: Uint8Array;
  private i = 0;

  /** @param src The bytes to read. Only this view is read, never the buffer beyond it. */
  constructor(src: Uint8Array) {
    this.src = src;
  }

  /** Bytes not yet read. */
  get remaining(): number {
    return this.src.length - this.i;
  }

  /** Offset of the next byte within the source view. */
  get offset(): number {
    return this.i;
  }

  /** Whether any byte is left. */
  more(): boolean {
    return this.i < this.src.length;
  }

  /** Read one byte. */
  u8(): number {
    if (this.i >= this.src.length) throw new ZenohProtocolError('message truncated');
    return this.src[this.i++]!;
  }

  /** Look at the next byte without consuming it. */
  peek(): number {
    if (this.i >= this.src.length) throw new ZenohProtocolError('message truncated');
    return this.src[this.i]!;
  }

  /** Read a VLE for a field the spec bounds to 32 bits. */
  vle32(): number {
    let value = 0;
    let scale = 1;
    for (let k = 0; k < VLE_MAX_BYTES; k++) {
      const b = this.u8();
      const last = k === VLE_MAX_BYTES - 1;
      value += (last ? b : b & 0x7f) * scale;
      if (value > U32_MAX) throw new ZenohProtocolError('32-bit field out of range');
      if (last || (b & 0x80) === 0) return value;
      scale *= 0x80;
    }
    throw new ZenohProtocolError('unreachable');
  }

  /** Read a VLE for a 64-bit field. */
  vle64(): bigint {
    let value = 0n;
    let shift = 0n;
    for (let k = 0; k < VLE_MAX_BYTES; k++) {
      const b = this.u8();
      if (k === VLE_MAX_BYTES - 1) return value | (BigInt(b) << shift);
      value |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return value;
      shift += 7n;
    }
    throw new ZenohProtocolError('unreachable');
  }

  /** Read `n` bytes as a view. */
  take(n: number): Uint8Array {
    if (n > this.remaining) throw new ZenohProtocolError('length beyond the message');
    const view = this.src.subarray(this.i, this.i + n);
    this.i += n;
    return view;
  }

  /** Move past `n` bytes without reading them. */
  skip(n: number): void {
    if (n > this.remaining) throw new ZenohProtocolError('length beyond the message');
    this.i += n;
  }

  /** Read a VLE length, then that many bytes as a view. */
  bytes(): Uint8Array {
    return this.take(this.vle32());
  }

  /** Read a length-prefixed UTF-8 string. */
  str(): string {
    return TEXT_DECODER.decode(this.bytes());
  }

  /** Every remaining byte, as a view. */
  rest(): Uint8Array {
    return this.take(this.remaining);
  }
}
