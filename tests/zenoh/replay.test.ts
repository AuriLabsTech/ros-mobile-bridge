import { describe, expect, it } from 'vitest';
import { ByteReader } from '../../src/zenoh/codec';
import { readTransportMessage } from '../../src/zenoh/transport';
import { batchContents, inSentOrder, loadRecording, patternBytes, replay } from './recordings';

/**
 * Replays of sessions recorded against a real `rmw_zenohd` (Jazzy, the
 * fixture's router; see `tests/fixtures/zenoh/` and
 * `tests/integration/zenohSession.test.ts`). The router's bytes are the
 * router's: nothing here was written by hand, so a layout the session layer
 * misreads fails here even where the hand-built bytes in `session.test.ts`
 * agree with it.
 */

const hex = (u: Uint8Array | null): string | null =>
  u === null ? null : Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');

interface ChatterObserved {
  tokens: Array<{ kind: 'declare' | 'undeclare'; key: string; interestId: number | null }>;
  finals: number[];
  pushes: Array<{
    key: string;
    kind: 'put' | 'del';
    payload: string;
    attachment: string | null;
    timestamp: boolean;
    reliable: boolean;
  }>;
}

interface FragmentsObserved {
  pushes: Array<{ key: string; length: number; reliable: boolean }>;
  patterns: Record<string, number[]>;
}

interface MixedObserved {
  pushes: Array<{ key: string; payload: string; reliable: boolean }>;
}

const BIG = 'rmb_test/frag/big';
/** Messages per channel in the recorded mixed burst (`MIXED_BURST` in the live test). */
const MIXED_BURST = 100;

/** Each batch that holds a FRAGMENT: where its chunk sits and whether more follow. */
function fragmentBatches(
  batches: Uint8Array[],
): Array<{ index: number; more: boolean; chunkStart: number }> {
  const out: Array<{ index: number; more: boolean; chunkStart: number }> = [];
  batches.forEach((batch, index) => {
    const m = readTransportMessage(new ByteReader(batch));
    if (m.kind !== 'fragment') return;
    // The router sends each fragment in a batch of its own.
    expect(m.chunk.byteOffset + m.chunk.length).toBe(batch.byteOffset + batch.length);
    out.push({ index, more: m.more, chunkStart: m.chunk.byteOffset - batch.byteOffset });
  });
  return out;
}

/** The fragments grouped by message: each group ends with its M=0 fragment. */
function fragmentedMessages(batches: Uint8Array[]): Array<ReturnType<typeof fragmentBatches>> {
  const groups: Array<ReturnType<typeof fragmentBatches>> = [[]];
  for (const f of fragmentBatches(batches)) {
    groups[groups.length - 1]!.push(f);
    if (!f.more) groups.push([]);
  }
  return groups.filter((g) => g.length > 0);
}

describe('replay: liveliness interest and /chatter (chatter.json)', () => {
  const { recording, batches } = loadRecording<ChatterObserved>('chatter');
  const { observed } = recording;

  it('opens, and ends only when closed', () => {
    const r = replay(batches);
    expect(r.opened).toBe(true);
    expect(r.end).toBeNull();
  });

  it('gives the same tokens and D_FINAL as the live run', () => {
    const r = replay(batches);
    expect(r.tokens.length).toBeGreaterThan(0);
    expect(r.tokens).toEqual(observed.tokens);
    expect(r.finals).toEqual(observed.finals);
  });

  it('gives the same samples as the live run, attachment and timestamp included', () => {
    const r = replay(batches);
    expect(r.pushes.length).toBeGreaterThan(0);
    expect(
      r.pushes.map(({ key, sample }) => ({
        key,
        kind: sample.kind,
        payload: hex(sample.payload),
        attachment: hex(sample.attachment),
        timestamp: sample.timestamp !== null,
        reliable: sample.reliable,
      })),
    ).toEqual(observed.pushes);
  });
});

describe('replay: fragmented messages through the router (fragments.json)', () => {
  const { recording, batches } = loadRecording<FragmentsObserved>('fragments');
  const { observed } = recording;
  const bigPayloads = observed.patterns[BIG]!.map((seed) =>
    patternBytes(observed.pushes.find((p) => p.key === BIG)!.length, seed),
  );

  // `fragmentBatches` reads only each batch's first transport message. A
  // re-recording where the router put a fragment behind a FRAME in one batch
  // fails here, before the tests below pick the wrong batch to drop.
  it('holds two messages of three fragments each', () => {
    expect(fragmentedMessages(batches).map((g) => g.length)).toEqual([3, 3]);
  });

  it('gives the same messages as the live run, and the big ones byte for byte', () => {
    const r = replay(batches);
    expect(r.end).toBeNull();
    expect(
      r.pushes.map(({ key, sample }) => ({
        key,
        length: sample.payload.length,
        reliable: sample.reliable,
      })),
    ).toEqual(observed.pushes);
    expect(r.pushes.filter((p) => p.key === BIG).map((p) => p.sample.payload)).toEqual(bigPayloads);
    expect(r.stats.reliable).toMatchObject({ gapDrops: 0, buffersAllocated: 2 });
  });

  it('lost middle fragment: one message fewer, no garbage, the next one arrives', () => {
    const lost = fragmentedMessages(batches)[0]![1]!.index;
    const r = replay(batches.filter((_, i) => i !== lost));
    expect(r.end).toBeNull();
    const big = r.pushes.filter((p) => p.key === BIG);
    expect(big.map((p) => p.sample.payload)).toEqual([bigPayloads[1]]);
    expect(r.pushes).toHaveLength(observed.pushes.length - 1);
    expect(r.pushes.at(-1)!.key).toBe('rmb_test/frag/small');
    expect(r.stats.reliable.gapDrops).toBe(1);
  });

  describe('drop before parse: the big messages refused', () => {
    const refuseBig = (key: string) => key !== BIG;

    /** The batches with every chunk after each big message's first fragment overwritten. */
    const withGarbage = (): Uint8Array[] => {
      const out = batches.map((b) => b.slice());
      for (const group of fragmentedMessages(batches)) {
        for (const f of group.slice(1)) out[f.index]!.fill(0xee, f.chunkStart);
      }
      return out;
    };

    it('never delivers them, allocates no buffer, and still delivers the next message', () => {
      const r = replay(batches, refuseBig);
      expect(r.end).toBeNull();
      expect(r.pushes.map((p) => p.key)).toEqual(
        observed.pushes.map((p) => p.key).filter((k) => k !== BIG),
      );
      expect(r.stats.reliable).toMatchObject({ refused: 2, buffersAllocated: 0, gapDrops: 0 });
    });

    it('planted check: garbage in their later fragments changes nothing', () => {
      const clean = replay(batches, refuseBig);
      const dirty = replay(withGarbage(), refuseBig);
      expect(dirty.end).toBeNull();
      expect(dirty.pushes.map((p) => p.key)).toEqual(clean.pushes.map((p) => p.key));
      expect(dirty.stats).toEqual(clean.stats);
    });

    it('red control: the same garbage, admitted, reaches the payload', () => {
      const r = replay(withGarbage());
      const big = r.pushes.filter((p) => p.key === BIG).map((p) => p.sample.payload);
      expect(big).toHaveLength(2);
      expect(big).not.toEqual(bigPayloads);
    });
  });
});

describe('replay: reliable and best-effort FRAMEs in one batch (mixed.json)', () => {
  const { recording, batches } = loadRecording<MixedObserved>('mixed');
  const { observed } = recording;

  // A re-recording where the router happened to batch nothing fails here,
  // before the tests below pass without the case they exist for.
  it('holds batches with a FRAME on each channel', () => {
    expect(batchContents(batches).some((b) => b.reliable && b.bestEffort)).toBe(true);
  });

  it('delivers every PUSH the batches hold, each on its own channel', () => {
    const r = replay(batches);
    expect(r.end).toBeNull();
    const held = batchContents(batches).reduce((n, b) => n + b.pushes, 0);
    expect(r.pushes).toHaveLength(held);
    expect(
      r.pushes.map(({ key, sample }) => ({
        key,
        payload: hex(sample.payload),
        reliable: sample.reliable,
      })),
    ).toEqual(observed.pushes);
    const on = (key: string) => r.pushes.filter((p) => p.key === key);
    expect(on('rmb_test/mix/r').every((p) => p.sample.reliable)).toBe(true);
    expect(on('rmb_test/mix/be').every((p) => !p.sample.reliable)).toBe(true);
    // The live test waited for every reliable message and at least one best-effort one.
    const sent = Array.from({ length: MIXED_BURST }, (_, i) => hex(patternBytes(16, i)));
    expect(on('rmb_test/mix/r').map((p) => hex(p.sample.payload))).toEqual(sent);
    const bestEffort = on('rmb_test/mix/be').map((p) => hex(p.sample.payload));
    expect(bestEffort.length).toBeGreaterThan(0);
    expect(inSentOrder(bestEffort, sent)).toBe(true);
  });
});
