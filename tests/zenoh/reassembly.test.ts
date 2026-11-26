import { describe, expect, it, vi } from 'vitest';
import { ChannelReassembler, type FragmentInput } from '../../src/zenoh/reassembly';

const bytes = (...xs: number[]): Uint8Array => Uint8Array.from(xs);

function frag(
  sn: number,
  more: boolean,
  chunk: Uint8Array,
  marks: Partial<FragmentInput> = {},
): FragmentInput {
  return { sn, more, first: false, drop: false, chunk, ...marks };
}

/** A message of `n` fragments of `size` bytes, each byte the message tag. */
function message(tag: number, startSn: number, n: number, size = 4): FragmentInput[] {
  return Array.from({ length: n }, (_, i) =>
    frag((startSn + i) % 2 ** 32, i < n - 1, new Uint8Array(size).fill(tag)),
  );
}

function feed(
  r: ChannelReassembler,
  frags: FragmentInput[],
  admit?: (c: Uint8Array) => boolean,
): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const f of frags) {
    const m = r.fragment(f, admit);
    if (m !== null) out.push(m);
  }
  return out;
}

describe('ChannelReassembler: rule 1, consecutive fragments', () => {
  it('joins fragments until M=0 and returns the whole message', () => {
    const r = new ChannelReassembler();
    const out = feed(r, [
      frag(10, true, bytes(1, 2)),
      frag(11, true, bytes(3)),
      frag(12, false, bytes(4, 5)),
    ]);
    expect(out).toEqual([bytes(1, 2, 3, 4, 5)]);
  });

  it('returns a lone M=0 fragment as a view, with no copy', () => {
    const chunk = bytes(9, 9);
    const out = feed(new ChannelReassembler(), [frag(0, false, chunk)]);
    expect(out[0]).toBe(chunk);
  });

  it('never reuses a buffer: an earlier message stays intact', () => {
    const r = new ChannelReassembler();
    const [a] = feed(r, message(1, 0, 3));
    const [b] = feed(r, message(2, 3, 3));
    expect(a).toEqual(new Uint8Array(12).fill(1));
    expect(b).toEqual(new Uint8Array(12).fill(2));
    expect(a!.buffer).not.toBe(b!.buffer);
  });

  it('follows the sequence number across 2^32', () => {
    const out = feed(new ChannelReassembler(), message(7, 0xfffffffe, 4));
    expect(out).toEqual([new Uint8Array(16).fill(7)]);
  });
});

describe('ChannelReassembler: rules 2 and 3, markers', () => {
  it('a First marker starts a new message and discards the partial one', () => {
    const r = new ChannelReassembler();
    const out = feed(r, [
      frag(0, true, bytes(1)),
      frag(1, true, bytes(2), { first: true }),
      frag(2, false, bytes(3)),
    ]);
    expect(out).toEqual([bytes(2, 3)]);
  });

  it('a First marker restarts even after a gap', () => {
    const r = new ChannelReassembler();
    const out = feed(r, [
      frag(0, true, bytes(1)),
      frag(5, true, bytes(2), { first: true }),
      frag(6, false, bytes(3)),
    ]);
    expect(out).toEqual([bytes(2, 3)]);
  });

  it('a Drop marker discards the partial message and its own chunk', () => {
    const r = new ChannelReassembler();
    const out = feed(r, [
      frag(0, true, bytes(1)),
      frag(1, true, bytes(2), { drop: true }),
      ...message(5, 2, 2),
    ]);
    expect(out).toEqual([new Uint8Array(8).fill(5)]);
  });
});

describe('ChannelReassembler: rule 4, a sequence gap', () => {
  it('drops the broken message, skips to its M=0, and keeps the next one: the lost-fragment red', () => {
    const all = [...message(1, 0, 5), ...message(2, 5, 5), ...message(3, 10, 5)];
    expect(feed(new ChannelReassembler(), all)).toHaveLength(3);
    const lost = all.filter((f) => f.sn !== 7); // a middle fragment of message 2
    const r = new ChannelReassembler();
    const out = feed(r, lost);
    expect(out).toEqual([new Uint8Array(20).fill(1), new Uint8Array(20).fill(3)]);
    expect(r.stats().gapDrops).toBe(1);
  });

  it('never restarts mid-message: a gap right after M=0 skips the rest of that message', () => {
    // Message 2's first fragment (sn 3) is lost; 4 and 5 are its middle and end.
    const frags = [...message(1, 0, 3), ...message(2, 3, 3).slice(1), ...message(3, 6, 2)];
    const r = new ChannelReassembler();
    expect(feed(r, frags)).toEqual([new Uint8Array(12).fill(1), new Uint8Array(8).fill(3)]);
    expect(r.stats().gapDrops).toBe(1);
  });

  it('counts a gap after a FRAME as a drop, even with no partial message', () => {
    const r = new ChannelReassembler();
    r.frame(10);
    expect(feed(r, [frag(12, false, bytes(1))])).toEqual([]);
    expect(r.stats().gapDrops).toBe(1);
  });

  it('a lost last fragment drops the message, and the next one survives', () => {
    // Message 1 is sn 0 to 2; sn 2 (its M=0) is lost; message 2 starts at 3 with no marker.
    const frags = [...message(1, 0, 3).slice(0, 2), ...message(2, 3, 2)];
    // Without the last fragment the receiver cannot see where message 1 ended:
    // sn 3 is a gap inside it, so everything to the next M=0 goes. Nothing is
    // glued together.
    expect(feed(new ChannelReassembler(), frags)).toEqual([]);
  });
});

describe('ChannelReassembler: rule 5, a FRAME on the channel', () => {
  it('resets the partial message and advances the expected sequence number', () => {
    const r = new ChannelReassembler();
    feed(r, [frag(0, true, bytes(1))]);
    r.frame(1);
    expect(feed(r, message(4, 2, 2))).toEqual([new Uint8Array(8).fill(4)]);
  });

  it('ends a skip in progress', () => {
    const r = new ChannelReassembler();
    feed(r, [frag(0, true, bytes(1)), frag(2, true, bytes(2))]); // gap: skipping
    r.frame(3);
    expect(feed(r, message(4, 4, 2))).toEqual([new Uint8Array(8).fill(4)]);
  });
});

describe('ChannelReassembler: refusing a message from its first fragment', () => {
  it('asks once with the first chunk, then skips the rest with no buffer', () => {
    const admit = vi.fn((chunk: Uint8Array) => chunk[0] !== 2);
    const r = new ChannelReassembler();
    const out = feed(r, [...message(1, 0, 3), ...message(2, 3, 4), ...message(3, 7, 2)], admit);
    expect(out).toEqual([new Uint8Array(12).fill(1), new Uint8Array(8).fill(3)]);
    expect(admit).toHaveBeenCalledTimes(3);
    expect(admit.mock.calls[1]![0]).toEqual(new Uint8Array(4).fill(2));
    expect(r.stats()).toMatchObject({ refused: 1, buffersAllocated: 2 });
  });

  it('does not ask about a single-fragment message: the caller reads it whole', () => {
    const admit = vi.fn(() => false);
    const out = feed(new ChannelReassembler(), [frag(0, false, bytes(1))], admit);
    expect(out).toEqual([bytes(1)]);
    expect(admit).not.toHaveBeenCalled();
  });

  it('lets an error from the check escape and skips the rest of that message', () => {
    const r = new ChannelReassembler();
    expect(() =>
      r.fragment(frag(0, true, bytes(1)), () => {
        throw new Error('bad header');
      }),
    ).toThrow('bad header');
    // sn 1 and 2 are the tail of the message whose header failed: never glued
    // into a message of their own. The next message (sn 3, 4) arrives.
    const tail = [frag(1, true, bytes(0xee)), frag(2, false, bytes(0xee))];
    expect(feed(r, [...tail, ...message(5, 3, 2)])).toEqual([new Uint8Array(8).fill(5)]);
  });
});
