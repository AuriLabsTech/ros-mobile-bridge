import { describe, it, expect } from 'vitest';
import { FragmentAssembler } from '../src/rosbridgeFragments';

function frag(id: string, data: string, num: number, total: number): Record<string, unknown> {
  return { op: 'fragment', id, data, num, total };
}

describe('FragmentAssembler', () => {
  it('joins fragments in num order once every one has arrived', () => {
    const a = new FragmentAssembler({ onDrop: () => {} });
    expect(a.accept(frag('0', 'ab', 0, 3), 0)).toBeNull();
    expect(a.accept(frag('0', 'cd', 1, 3), 0)).toBeNull();
    expect(a.accept(frag('0', 'e', 2, 3), 0)).toBe('abcde');
    expect(a.pending).toBe(0);
  });

  it('returns a one-fragment message at once', () => {
    const a = new FragmentAssembler({ onDrop: () => {} });
    expect(a.accept(frag('7', 'whole', 0, 1), 0)).toBe('whole');
    expect(a.pending).toBe(0);
  });

  it('accepts a numeric id as the same message as its string form', () => {
    const a = new FragmentAssembler({ onDrop: () => {} });
    a.accept({ op: 'fragment', id: 0, data: 'x', num: 0, total: 2 }, 0);
    expect(a.accept(frag('0', 'y', 1, 2), 0)).toBe('xy');
  });

  it('drops a message whose fragments would pass the byte cap, and says so', () => {
    const drops: string[] = [];
    const a = new FragmentAssembler({ maxBufferedChars: 10, onDrop: (r) => drops.push(r) });
    a.accept(frag('0', 'aaaaaa', 0, 2), 0);
    expect(a.accept(frag('0', 'bbbbbb', 1, 2), 0)).toBeNull();
    expect(a.pending).toBe(0);
    expect(drops.join('\n')).toMatch(/exceed 10 characters/);
  });

  it('frees the cap when a message completes, so the next one fits', () => {
    const a = new FragmentAssembler({ maxBufferedChars: 10, onDrop: () => {} });
    a.accept(frag('0', 'aaaaa', 0, 2), 0);
    expect(a.accept(frag('0', 'bbbbb', 1, 2), 0)).toBe('aaaaabbbbb');
    a.accept(frag('0', 'ccccc', 0, 2), 0);
    expect(a.accept(frag('0', 'ddddd', 1, 2), 0)).toBe('cccccddddd');
  });

  it('frees the cap when a partial message is dropped', () => {
    const a = new FragmentAssembler({ maxBufferedChars: 10, idleTimeoutMs: 100, onDrop: () => {} });
    a.accept(frag('a', 'aaaaaaaa', 0, 2), 0);
    a.sweep(1_000);
    a.accept(frag('b', 'bbbbb', 0, 2), 1_000);
    expect(a.accept(frag('b', 'ccccc', 1, 2), 1_000)).toBe('bbbbbccccc');
  });

  it('times a partial message out from its last fragment, not its first', () => {
    const a = new FragmentAssembler({ idleTimeoutMs: 100, onDrop: () => {} });
    a.accept(frag('0', 'a', 0, 3), 0);
    a.accept(frag('0', 'b', 1, 3), 90);
    a.sweep(150);
    expect(a.accept(frag('0', 'c', 2, 3), 150)).toBe('abc');
  });

  it('never splices two messages that interleave under the same id', () => {
    // Topic messages all carry id "0". If two arrive mixed (A0 A1 B0 A2 B1
    // B2), B0 must drop A, and A2 must not fill B's slot 2.
    const a = new FragmentAssembler({ onDrop: () => {} });
    const out = [
      a.accept(frag('0', 'A0', 0, 3), 0),
      a.accept(frag('0', 'A1', 1, 3), 0),
      a.accept(frag('0', 'B0', 0, 3), 0),
      a.accept(frag('0', 'A2', 2, 3), 0),
      a.accept(frag('0', 'B1', 1, 3), 0),
      a.accept(frag('0', 'B2', 2, 3), 0),
    ].filter((s) => s !== null);
    expect(out).not.toContain('B0B1A2');
    expect(out.every((s) => s === 'A0A1A2' || s === 'B0B1B2')).toBe(true);
  });

  it('logs one line for a dropped message, not one per remaining fragment', () => {
    const drops: string[] = [];
    const a = new FragmentAssembler({ maxBufferedChars: 10, onDrop: (r) => drops.push(r) });
    a.accept(frag('0', 'aaaaaa', 0, 6), 0);
    a.accept(frag('0', 'bbbbbb', 1, 6), 0); // over the cap: the message is dropped
    for (let num = 2; num < 6; num++) a.accept(frag('0', 'cccccc', num, 6), 0);
    expect(drops).toHaveLength(1);

    // The next message under the same id starts clean and is joined.
    a.accept(frag('0', 'x', 0, 2), 0);
    expect(a.accept(frag('0', 'y', 1, 2), 0)).toBe('xy');
  });

  it('drops a message that receives the same fragment twice', () => {
    const a = new FragmentAssembler({ onDrop: () => {} });
    a.accept(frag('0', 'a', 0, 3), 0);
    a.accept(frag('0', 'b', 1, 3), 0);
    a.accept(frag('0', 'b', 1, 3), 0);
    expect(a.accept(frag('0', 'c', 2, 3), 0)).toBeNull();
    expect(a.pending).toBe(0);
  });
});
