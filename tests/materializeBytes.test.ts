import { describe, it, expect } from 'vitest';
import { materializeBytes } from '../src/materializeBytes';

describe('materializeBytes', () => {
  it('returns an owned, offset-0 copy of an offset view', () => {
    const buf = new ArrayBuffer(8);
    const view = new Uint8Array(buf, 2, 4); // offset 2 into a larger buffer
    view.set([1, 2, 3, 4]);

    const out = materializeBytes(view);

    expect(out.byteOffset).toBe(0);
    expect(out.byteLength).toBe(4);
    expect(Array.from(out)).toEqual([1, 2, 3, 4]);
    // Distinct backing buffer — not a view into the source frame.
    expect(out.buffer).not.toBe(buf);
    expect(out.buffer.byteLength).toBe(4);
  });

  it('always copies, even when the input already spans its whole buffer', () => {
    const view = new Uint8Array([9, 8, 7]); // offset 0, full span — "already owned"
    const out = materializeBytes(view);

    expect(out).not.toBe(view);
    expect(out.buffer).not.toBe(view.buffer);
    expect(Array.from(out)).toEqual([9, 8, 7]);
  });

  it('does not alias: mutating the source after the copy leaves the result intact', () => {
    const view = new Uint8Array([1, 2, 3]);
    const out = materializeBytes(view);

    view[0] = 99;

    expect(out[0]).toBe(1);
  });

  it('handles empty input', () => {
    const out = materializeBytes(new Uint8Array(0));
    expect(out.byteLength).toBe(0);
    expect(out.byteOffset).toBe(0);
  });
});
