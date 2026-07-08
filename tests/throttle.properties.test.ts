// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * Throttle controller — Layer 2 property-based invariants.
 *
 * The scenario profiles in `throttle.scenarios.test.ts` pin specific waveforms;
 * these invariants assert properties that must hold for ANY lag waveform, over
 * hundreds of seeded-random series (a deterministic PRNG stands in for
 * fast-check — every case is reproducible from its seed, no new dependency).
 *
 * Two groups:
 *   - "reproduces the bug" invariants are RED on the v0.1.4 controller (they
 *     generalize #354 and #346 across random configs) and go green with the fix.
 *   - "safety guards" are GREEN on v0.1.4 and must NOT regress: the safety
 *     direction (tighten on saturation) and determinism are non-negotiable.
 */

import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_PRESETS } from '../src/SubscriptionBandwidth';
import { replay, countLabelChanges, timeToLabel, type TraceStep } from './helpers/throttleHarness';

// `vi.hoisted` + `vi.mock` are hoisted above the imports by vitest's transform,
// so the mocked readings are in place before SubscriptionBandwidth resolves the
// EventLoopMonitor module.
const lag = vi.hoisted(() => ({ max: 0, sustained: 0 }));
vi.mock('../src/EventLoopMonitor', () => ({
  getMaxLagMs: () => lag.max,
  getSustainedLagMs: () => lag.sustained,
}));

const setMaxLag = (v: number): void => {
  lag.max = v;
};
const setSustainedLag = (v: number): void => {
  lag.sustained = v;
};

const AUTO = DEFAULT_PRESETS.auto;
const DEEPEST_LABEL = AUTO[AUTO.length - 1]!.label; // '0.5 Hz'
const TOP_THRESHOLD = AUTO[AUTO.length - 1]!.threshold; // 350
const CASES = 400;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (r: () => number, lo: number, hi: number): number => lo + r() * (hi - lo);

describe('throttle Layer 2 — reproduces the bug (RED on v0.1.4)', () => {
  it('no ratchet: isolated spikes never prevent recovery to uncapped', () => {
    // For any random saturating prefix followed by a healthy tail punctuated by
    // a single short spike every 2.2-3.2 s, the cap must reach 'none'. The
    // v0.1.4 controller never does: each spike resets the 3 s relax dwell.
    const failures: number[] = [];
    for (let c = 0; c < CASES; c++) {
      const r = mulberry32(0x51a7e + c);
      const prefixMs = between(r, 2000, 8000);
      const spikeEvery = between(r, 2200, 3200);
      const spikeHigh = between(r, 150, 185);
      const healthy = between(r, 0, 35);
      const trace = replay({
        setMaxLag,
        setSustainedLag,
        durationMs: 35000,
        rawLagAt: (now) => {
          if (now < prefixMs) return between(r, 200, 500);
          return now % spikeEvery < 200 ? spikeHigh : healthy;
        },
      });
      // It clears the prefix's MAX-window tail ~1 s after prefixMs.
      if (timeToLabel(trace, 'none', prefixMs + 1500) === null) failures.push(c);
    }
    expect(failures.length, `ratcheted (never reached uncapped) in cases: ${failures.slice(0, 8).join(', ')}`).toBe(0);
  });

  it('no limit cycle: a deadband around any boundary settles to one bucket', () => {
    // Closed-loop: lag drops below the boundary when throttled and rises above
    // it when uncapped. A correct controller settles; v0.1.4 hunts.
    const boundaries = [
      { threshold: 150, higherBucket: 2 },
      { threshold: 200, higherBucket: 3 },
    ];
    const failures: Array<{ c: number; changes: number }> = [];
    for (let c = 0; c < CASES; c++) {
      const r = mulberry32(0xc7c1e + c);
      const b = boundaries[Math.floor(r() * boundaries.length)]!;
      const delta = between(r, 10, 30);
      const trace = replay({
        setMaxLag,
        setSustainedLag,
        durationMs: 20000,
        rawLagAt: (_now, prevBucket) => {
          const base = prevBucket >= b.higherBucket ? b.threshold - delta : b.threshold + delta;
          return base + between(r, -3, 3);
        },
      });
      const end = trace[trace.length - 1]!.now;
      const changes = countLabelChanges(trace, end - 10000, end);
      if (changes > 1) failures.push({ c, changes });
    }
    expect(failures.length, `hunted (>1 change after settling) in ${failures.length} cases, e.g. ${JSON.stringify(failures.slice(0, 4))}`).toBe(0);
  });
});

describe('throttle Layer 2 — documented limits', () => {
  it('breaking duty cycle: spikes dense enough to saturate the 1 s MAX are sustained load and stay capped', () => {
    // Spike immunity has a boundary. A 160 ms spike every 600 ms is closer than
    // the 1 s MAX window, so the spike signal is ALWAYS high and the sustained
    // p75 sees ~1/3 spikes — this is no longer an "isolated" spike, it is real
    // sustained thread starvation, and the cap MUST stay engaged. This pins the
    // limit so a future over-eager relax (e.g. ignoring the spike floor) is
    // caught. The supported regime (one spike per >= ~1.2 s, which clears the
    // MAX window between spikes) is covered by the no-ratchet test above.
    const trace = replay({
      setMaxLag,
      setSustainedLag,
      durationMs: 30000,
      rawLagAt: (now) => {
        if (now < 4000) return 400;
        return now % 600 < 200 ? 160 : 5;
      },
    });
    expect(timeToLabel(trace, 'none', 5000)).toBeNull();
  });
});

describe('throttle Layer 2 — safety guards (GREEN on v0.1.4, must not regress)', () => {
  it('safety floor: sustained lag above the top threshold reaches the deepest cap', () => {
    // Whenever the MAX reading has been at/above the top threshold for two
    // consecutive ticks, the cap must already be at the deepest bucket. This
    // is the untunable safety direction; it must never slow down.
    const violations: Array<{ c: number; now: number; label: string }> = [];
    for (let c = 0; c < CASES; c++) {
      const r = mulberry32(0x5a7e + c);
      const trace = replay({
        setMaxLag,
        setSustainedLag,
        durationMs: 15000,
        rawLagAt: () => between(r, 0, 600),
      });
      for (let i = 1; i < trace.length; i++) {
        const cur = trace[i]!;
        const prev = trace[i - 1]!;
        if (cur.maxLag >= TOP_THRESHOLD && prev.maxLag >= TOP_THRESHOLD) {
          if (cur.label !== DEEPEST_LABEL) {
            violations.push({ c, now: cur.now, label: cur.label });
          }
        }
      }
    }
    expect(violations.length, `safety-floor violations: ${JSON.stringify(violations.slice(0, 4))}`).toBe(0);
  });

  it('determinism: identical input series produce identical trajectories', () => {
    for (let c = 0; c < 50; c++) {
      const build = (): TraceStep[] => {
        const r = mulberry32(0xd37 + c);
        return replay({
          setMaxLag,
          setSustainedLag,
          durationMs: 12000,
          rawLagAt: () => between(r, 0, 500),
        });
      };
      const a = build();
      const b = build();
      expect(a.map((s) => s.bucket)).toEqual(b.map((s) => s.bucket));
    }
  });
});
