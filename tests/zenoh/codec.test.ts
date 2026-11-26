import { describe, expect, it } from 'vitest';
import { ByteReader, ByteWriter, ZenohProtocolError, vleLength } from '../../src/zenoh/codec';

const hex = (u: Uint8Array): string =>
  Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (s: string): Uint8Array =>
  new Uint8Array((s.match(/../g) ?? []).map((b) => parseInt(b, 16)));

describe('VLE (Zenoh zint: LEB128 with a 9-byte cap, the 9th byte carrying 8 bits)', () => {
  // Expected bytes follow commons/zenoh-codec/src/core/zint.rs at tag 1.10.1.
  const cases32: Array<[number, string]> = [
    [0, '00'],
    [127, '7f'],
    [128, '8001'],
    [300, 'ac02'],
    [0xffffffff, 'ffffffff0f'],
  ];

  for (const [value, bytes] of cases32) {
    it(`round-trips ${value} as a 32-bit field`, () => {
      const out = new ByteWriter().vle(value).finish();
      expect(hex(out)).toBe(bytes);
      expect(vleLength(value)).toBe(out.length);
      const r = new ByteReader(out);
      expect(r.vle32()).toBe(value);
      expect(r.remaining).toBe(0);
    });
  }

  const cases64: Array<[bigint, string]> = [
    [0n, '00'],
    [2n ** 53n, '80808080808080' + '10'],
    [2n ** 63n - 1n, 'ffffffffffffffff7f'],
    [2n ** 64n - 1n, 'ffffffffffffffffff'],
  ];

  for (const [value, bytes] of cases64) {
    it(`round-trips ${value} as a 64-bit field`, () => {
      const out = new ByteWriter().vle64(value).finish();
      expect(hex(out)).toBe(bytes);
      const r = new ByteReader(out);
      expect(r.vle64()).toBe(value);
      expect(r.remaining).toBe(0);
    });
  }

  it('stops at the 9th byte whatever its top bit says, as upstream does', () => {
    const r = new ByteReader(fromHex('ffffffffffffffffff' + '01'));
    expect(r.vle64()).toBe(2n ** 64n - 1n);
    expect(r.remaining).toBe(1);
  });

  it('refuses a 32-bit field above 2^32 - 1', () => {
    const out = new ByteWriter().vle64(2n ** 32n).finish();
    expect(() => new ByteReader(out).vle32()).toThrow(ZenohProtocolError);
  });

  it('refuses to write a 32-bit field that is not a 32-bit unsigned integer', () => {
    expect(() => new ByteWriter().vle(2 ** 32)).toThrow(RangeError);
    expect(() => new ByteWriter().vle(-1)).toThrow(RangeError);
    expect(() => new ByteWriter().vle(1.5)).toThrow(RangeError);
  });

  it('throws on a truncated VLE', () => {
    expect(() => new ByteReader(fromHex('8080')).vle32()).toThrow(ZenohProtocolError);
    expect(() => new ByteReader(fromHex('ffff')).vle64()).toThrow(ZenohProtocolError);
  });
});

describe('ByteReader bounds', () => {
  it('throws on reading past the end', () => {
    const r = new ByteReader(fromHex('01'));
    expect(r.u8()).toBe(1);
    expect(() => r.u8()).toThrow(ZenohProtocolError);
  });

  it('refuses a length beyond the buffer before allocating anything', () => {
    // 0xffffffff as a length prefix, then 2 bytes: a forged 4 GB length.
    const r = new ByteReader(fromHex('ffffffff0f' + 'abcd'));
    expect(() => r.bytes()).toThrow(ZenohProtocolError);
  });

  it('returns views into the source, never copies', () => {
    const src = fromHex('03aabbcc');
    const view = new ByteReader(src).bytes();
    expect(hex(view)).toBe('aabbcc');
    expect(view.buffer).toBe(src.buffer);
    expect(view.byteOffset).toBe(1);
  });

  it('skip() moves past bytes and checks bounds', () => {
    const r = new ByteReader(fromHex('aabbcc'));
    r.skip(2);
    expect(r.u8()).toBe(0xcc);
    expect(() => r.skip(1)).toThrow(ZenohProtocolError);
  });

  it('rest() takes every remaining byte', () => {
    const r = new ByteReader(fromHex('aabbcc'));
    r.u8();
    expect(hex(r.rest())).toBe('bbcc');
    expect(r.remaining).toBe(0);
  });

  it('reads a reader over a sub-view at the right offsets', () => {
    const big = fromHex('ff' + '02abcd' + 'ff');
    const r = new ByteReader(big.subarray(1, 4));
    expect(hex(r.bytes())).toBe('abcd');
    expect(r.remaining).toBe(0);
  });
});

describe('strings', () => {
  it('round-trips a UTF-8 string with its length prefix', () => {
    const out = new ByteWriter().str('añ/chatter').finish();
    expect(out[0]).toBe(11);
    expect(new ByteReader(out).str()).toBe('añ/chatter');
  });
});

describe('ByteWriter growth', () => {
  it('grows past its initial capacity and keeps every byte', () => {
    const w = new ByteWriter(1);
    const payload = new Uint8Array(1000).map((_, i) => i & 0xff);
    w.u8(7).bytes(payload).u8(9);
    const out = w.finish();
    expect(out.length).toBe(1 + 2 + 1000 + 1);
    const r = new ByteReader(out);
    expect(r.u8()).toBe(7);
    expect(r.bytes()).toEqual(payload);
    expect(r.u8()).toBe(9);
  });

  it('length tracks bytes written', () => {
    const w = new ByteWriter();
    w.u8(1).raw(new Uint8Array(5));
    expect(w.length).toBe(6);
  });
});
