// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * Throttle controller — Layer 1 scenario profiles (the regression gate).
 *
 * Each profile replays a prescribed JS-thread-lag series through
 * `SubscriptionBandwidth.recordBytes` (lag mocked via `getMaxLagMs`) and
 * asserts on the bucket-label trajectory. Assertions are on bucket LABELS and
 * relative behavior, never raw indices — `DEFAULT_PRESETS` values are
 * `@experimental` and may be rebalanced in a patch.
 *
 * Acceptance numbers are product targets fixed up front (per the v0.1.5
 * proposal's "Validation stack"); the controller's deadband / percentile /
 * dwell constants are tuned to MEET them, never the reverse.
 *
 * These three profiles reproduce RMB #354 (oscillation) and #346 (Hz cap
 * ratchet / slow recovery) and are RED on the v0.1.4 controller.
 *
 * Modeling note on the oscillation profile: #354 is a closed-loop limit cycle
 * — throttling cuts parse work, lag falls, the controller relaxes, parse work
 * returns, lag rises, it tightens again. The honest repro therefore makes lag
 * respond to the bucket. An open-loop variant (lag merely *held* at the
 * boundary with jitter) does NOT reproduce #354 and is deliberately not used:
 * the v0.1.4 controller freezes at the pessimistic bucket under held-boundary
 * jitter, but holding the conservative cap when lag genuinely straddles a
 * threshold is defensible behavior, not the bug — and the deadband fix holds
 * there too. The defect is the hunting, which only appears closed-loop.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  replay,
  countLabelChanges,
  timeToLabel,
  timeToUncapped,
  finalStep,
} from './helpers/throttleHarness';

// `vi.hoisted` + `vi.mock` are hoisted above the imports by vitest's transform,
// so the mocked `getMaxLagMs` / `getSustainedLagMs` are in place before
// SubscriptionBandwidth (pulled in via the harness) resolves the module.
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

// Fixed-seed LCG so every profile is byte-for-byte reproducible across runs.
function seededJitter(seed: number, amplitude: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 0xffffffff) * 2 * amplitude - amplitude;
  };
}

describe('throttle Layer 1 — oscillation (#354)', () => {
  it('closed-loop limit cycle around the 5 Hz boundary settles to one bucket', () => {
    // Boundary between the "10 Hz" (bucket 1) and "5 Hz" (bucket 2) caps is the
    // 150 ms threshold. Throttled (bucket >= 2) cuts parse load so lag drops
    // below the boundary; roughly-uncapped (bucket <= 1) lets parse work back
    // in so lag rises above it. Small jitter keeps it near the knee.
    const jitter = seededJitter(1337, 3);
    const trace = replay({
      setMaxLag,
      setSustainedLag,
      durationMs: 20000,
      rawLagAt: (_now, prevBucket) => (prevBucket >= 2 ? 140 : 162) + jitter(),
    });
    const end = finalStep(trace).now;
    // Product target: under sustained near-boundary load the cap settles
    // instead of hunting. At most one label change in the final 15 s.
    expect(countLabelChanges(trace, end - 15000, end)).toBeLessThanOrEqual(1);
  });
});

describe('throttle Layer 1 — ratchet (#346)', () => {
  it('recovers to uncapped despite an isolated spike every 2.5 s', () => {
    // 400 ms for 5 s drives the cap to the floor. Then the thread is healthy
    // (~5 ms) except for a single 160 ms spike every 2.5 s. Isolated spikes
    // must not ratchet the cap permanently down.
    const trace = replay({
      setMaxLag,
      setSustainedLag,
      durationMs: 40000,
      rawLagAt: (now) => {
        if (now < 5000) return 400;
        return now % 2500 < 200 ? 160 : 5;
      },
    });
    // Must reach the uncapped bucket at some point after the load clears
    // (the 400 ms tail ages out of the 1 s MAX window by ~6 s).
    const reachedUncapped = timeToLabel(trace, 'none', 6000);
    expect(reachedUncapped).not.toBeNull();
    // And it must get there within a bounded time, not "eventually".
    expect(reachedUncapped).toBeLessThanOrEqual(20000);
  });
});

describe('throttle Layer 1 — clean recovery (#346 slow-recovery)', () => {
  it('returns to uncapped within about one relax window after lag clears', () => {
    // 400 ms for 5 s to the floor, then lag 0 forever. The signal is fully
    // clean by ~6 s (the 1 s MAX window flushes the 400 ms tail).
    const trace = replay({
      setMaxLag,
      setSustainedLag,
      durationMs: 25000,
      rawLagAt: (now) => (now < 5000 ? 400 : 0),
    });
    const t = timeToUncapped(trace);
    expect(t).not.toBeNull();
    // Product target: time-to-uncapped from a clean signal is at most one
    // relax window (~4-5 s), i.e. uncapped by ~11 s, not the ~18 s the
    // single-step-relax-with-clock-rearm controller takes.
    expect(t).toBeLessThanOrEqual(11000);
  });
});
