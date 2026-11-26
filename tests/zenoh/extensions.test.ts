import { describe, expect, it } from 'vitest';
import { ByteReader, ByteWriter, ZenohProtocolError } from '../../src/zenoh/codec';
import { readExtensions, writeExtensions, type Extension } from '../../src/zenoh/extensions';

const hex = (u: Uint8Array): string =>
  Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (s: string): Uint8Array =>
  new Uint8Array((s.match(/../g) ?? []).map((b) => parseInt(b, 16)));

function roundTrip(exts: Extension[], known: number[]): Extension[] {
  const w = new ByteWriter();
  writeExtensions(w, exts);
  return readExtensions(new ByteReader(w.finish()), known);
}

describe('extension TLV (header Z | ENC(2) | M | ID(4))', () => {
  it('writes the three encodings with the bytes a QUERY carries', () => {
    const w = new ByteWriter();
    writeExtensions(w, [
      { id: 0x4, mandatory: true, enc: 'z64', value: 2n }, // QueryTarget AllComplete
      { id: 0x3, mandatory: false, enc: 'zbuf', value: fromHex('aabb') },
      { id: 0x2, mandatory: false, enc: 'unit' },
    ]);
    // 0x80|0x20|0x10|4 = b4, value 02; 0x80|0x40|3 = c3, len 02, aabb; 0x02.
    expect(hex(w.finish())).toBe('b402' + 'c302aabb' + '02');
  });

  it('round-trips each encoding', () => {
    const exts: Extension[] = [
      { id: 0x1, mandatory: false, enc: 'unit' },
      { id: 0x7, mandatory: false, enc: 'z64', value: 2n ** 64n - 1n },
      { id: 0xf, mandatory: true, enc: 'zbuf', value: fromHex('010203') },
    ];
    expect(roundTrip(exts, [0x1, 0x7, 0xf])).toEqual(exts);
  });

  it('skips an unknown optional extension of each encoding and keeps reading', () => {
    const exts: Extension[] = [
      { id: 0x9, mandatory: false, enc: 'zbuf', value: fromHex('ffff') },
      { id: 0xa, mandatory: false, enc: 'z64', value: 5n },
      { id: 0xb, mandatory: false, enc: 'unit' },
      { id: 0x3, mandatory: false, enc: 'zbuf', value: fromHex('01') },
    ];
    expect(roundTrip(exts, [0x3])).toEqual([exts[3]]);
  });

  it('fails on an unknown mandatory extension', () => {
    const exts: Extension[] = [{ id: 0x9, mandatory: true, enc: 'unit' }];
    expect(() => roundTrip(exts, [0x3])).toThrow(ZenohProtocolError);
  });

  it('leaves the reader just after the last extension', () => {
    const w = new ByteWriter();
    writeExtensions(w, [{ id: 0x2, mandatory: false, enc: 'unit' }]);
    w.u8(0x99);
    const r = new ByteReader(w.finish());
    readExtensions(r, [0x2]);
    expect(r.u8()).toBe(0x99);
  });

  it('fails on the reserved encoding 0b11', () => {
    expect(() => readExtensions(new ByteReader(fromHex('61')), [0x1])).toThrow(ZenohProtocolError);
  });

  it('fails on a zbuf whose length runs past the message', () => {
    expect(() => readExtensions(new ByteReader(fromHex('4305aabb')), [0x3])).toThrow(
      ZenohProtocolError,
    );
  });

  it('writes nothing for an empty list', () => {
    const w = new ByteWriter();
    writeExtensions(w, []);
    expect(w.length).toBe(0);
  });
});
