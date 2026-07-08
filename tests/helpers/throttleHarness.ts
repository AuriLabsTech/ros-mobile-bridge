// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * Deterministic offline harness for the adaptive-throttle controller
 * (`SubscriptionBandwidth.recordBytes`).
 *
 * The controller is a pure function of (now, lag): `recordBytes` takes `now`
 * explicitly and reads lag through `EventLoopMonitor.getMaxLagMs()`. A test
 * mocks `getMaxLagMs` and replays a prescribed lag series at fixed time steps,
 * recording the bucket trajectory. No device, no timers, no WebSocket.
 *
 * Fidelity note — the harness models the RAW lag series, not the smoothed
 * reading. In production `getMaxLagMs()` is a MAX over a 1 s rolling window of
 * 200 ms probe samples, so a single 160 ms lag event keeps the reported value
 * at 160 for ~1 s afterwards. The harness reproduces that smoothing from a raw
 * series so:
 *   - spike scenarios behave as they do on a real device (a "single spike"
 *     persists for the MAX window), and
 *   - the v0.1.5 fix's second, sustained-percentile relax reading can be
 *     derived from the same raw series and validated honestly (an isolated
 *     spike must barely move a multi-second percentile).
 *
 * The test file owns the `vi.mock('../src/EventLoopMonitor', ...)` (it must be
 * hoisted per-file); this helper stays pure and receives writer callbacks for
 * whichever mocked readings the scenario needs.
 */

import {
  createBandwidthTracker,
  recordBytes,
  getTrackerBucketLabel,
  type BandwidthTracker,
} from '../../src/SubscriptionBandwidth';
import type { ThrottleMode } from '../../src/types';

/** Probe cadence the real `EventLoopMonitor` samples lag at. */
export const PROBE_INTERVAL_MS = 200;
/** Rolling window `getMaxLagMs()` takes its MAX over. */
export const MAX_WINDOW_MS = 1000;

export interface TraceStep {
  /** Simulated wall-clock at this step (ms). */
  now: number;
  /** Raw (pre-smoothing) lag fed for this step. */
  rawLag: number;
  /** The MAX-over-1s reading the controller saw (what `getMaxLagMs()` returns). */
  maxLag: number;
  /** Bucket index the controller settled on after this step. */
  bucket: number;
  /** Override-aware bucket label (assert on this, never raw indices). */
  label: string;
  /** Effective adaptive min-interval (ms) after this step. `0` = uncapped. */
  intervalMs: number;
}

export interface ReplayConfig {
  /**
   * Writes the value the mocked `getMaxLagMs()` returns for the next step. The
   * harness computes the value (MAX over the last {@link MAX_WINDOW_MS} of the
   * raw series) and hands it here; the test wires this to its hoisted mock.
   */
  setMaxLag: (lagMs: number) => void;
  /**
   * Raw instantaneous lag for a given time. Receives the bucket the controller
   * was in BEFORE this step so a scenario can close the feedback loop (the
   * #354 limit cycle: throttling cuts parse work, lag falls, the throttle
   * relaxes, parse work returns, lag rises). Open-loop scenarios ignore the
   * second argument.
   */
  rawLagAt: (now: number, prevBucket: number) => number;
  /** Total replay length (ms). The first step is at `now = 0`. */
  durationMs: number;
  /**
   * Optional writer for a sustained-percentile relax reading derived from the
   * same raw series (used once the v0.1.5 two-signal fix lands; ignored for the
   * current-`main` baseline, which has no such reading).
   */
  setSustainedLag?: (lagMs: number) => void;
  /**
   * Window for the sustained reading (ms). Default mirrors EventLoopMonitor's
   * `SUSTAINED_WINDOW_MS` so the harness models the real relax signal.
   */
  sustainedWindowMs?: number;
  /**
   * Percentile for the sustained reading, 0..1. Default mirrors
   * EventLoopMonitor's `SUSTAINED_PERCENTILE`.
   */
  sustainedPercentile?: number;
  /** Step granularity (ms). Defaults to the probe interval. */
  stepMs?: number;
  /** Byte size fed to `recordBytes` each step (only affects bytesPerSec). */
  byteSize?: number;
  mode?: ThrottleMode;
  /** Supply a pre-seeded tracker (e.g. already driven to floor). */
  tracker?: BandwidthTracker;
}

function maxOverWindow(buf: Array<{ t: number; lag: number }>, now: number, windowMs: number): number {
  const cutoff = now - windowMs;
  let max = 0;
  for (const s of buf) {
    if (s.t >= cutoff && s.lag > max) max = s.lag;
  }
  return max;
}

function percentileOverWindow(
  buf: Array<{ t: number; lag: number }>,
  now: number,
  windowMs: number,
  q: number,
): number {
  const cutoff = now - windowMs;
  const vals = buf.filter((s) => s.t >= cutoff).map((s) => s.lag);
  if (vals.length === 0) return 0;
  vals.sort((a, b) => a - b);
  const idx = Math.min(vals.length - 1, Math.floor(vals.length * q));
  return vals[idx] ?? 0;
}

/**
 * Replay a lag series through the controller and return the bucket trajectory.
 * Models the real `getMaxLagMs()` smoothing (1 s rolling MAX of the raw series)
 * and, optionally, a sustained percentile for the relax signal.
 */
export function replay(cfg: ReplayConfig): TraceStep[] {
  const stepMs = cfg.stepMs ?? PROBE_INTERVAL_MS;
  const byteSize = cfg.byteSize ?? 50_000;
  const mode = cfg.mode ?? 'auto';
  const sustainedWindowMs = cfg.sustainedWindowMs ?? 4000;
  const sustainedPct = cfg.sustainedPercentile ?? 0.75;
  const tracker = cfg.tracker ?? createBandwidthTracker(mode);

  const rawBuf: Array<{ t: number; lag: number }> = [];
  const trace: TraceStep[] = [];

  for (let now = 0; now <= cfg.durationMs; now += stepMs) {
    const rawLag = cfg.rawLagAt(now, tracker.currentBucket);
    rawBuf.push({ t: now, lag: rawLag });
    // Drop samples older than the longer of the two windows we read.
    const keepFrom = now - Math.max(MAX_WINDOW_MS, sustainedWindowMs);
    while (rawBuf.length > 0 && (rawBuf[0]?.t ?? 0) < keepFrom) rawBuf.shift();

    const maxLag = maxOverWindow(rawBuf, now, MAX_WINDOW_MS);
    cfg.setMaxLag(maxLag);
    if (cfg.setSustainedLag) {
      cfg.setSustainedLag(percentileOverWindow(rawBuf, now, sustainedWindowMs, sustainedPct));
    }

    recordBytes(tracker, now, byteSize, mode);

    trace.push({
      now,
      rawLag,
      maxLag,
      bucket: tracker.currentBucket,
      label: getTrackerBucketLabel(tracker, mode),
      intervalMs: tracker.adaptiveMinIntervalMs,
    });
  }
  return trace;
}

/** Count how many times the bucket label changed within [fromMs, toMs]. */
export function countLabelChanges(trace: TraceStep[], fromMs = 0, toMs = Infinity): number {
  let changes = 0;
  let prev: string | null = null;
  for (const s of trace) {
    if (s.now < fromMs || s.now > toMs) continue;
    if (prev !== null && s.label !== prev) changes += 1;
    prev = s.label;
  }
  return changes;
}

/** Count how many times the bucket index changed within [fromMs, toMs]. */
export function countBucketChanges(trace: TraceStep[], fromMs = 0, toMs = Infinity): number {
  let changes = 0;
  let prev: number | null = null;
  for (const s of trace) {
    if (s.now < fromMs || s.now > toMs) continue;
    if (prev !== null && s.bucket !== prev) changes += 1;
    prev = s.bucket;
  }
  return changes;
}

/** First `now` at which the trace reaches the given label, or null if never. */
export function timeToLabel(trace: TraceStep[], label: string, fromMs = 0): number | null {
  for (const s of trace) {
    if (s.now < fromMs) continue;
    if (s.label === label) return s.now;
  }
  return null;
}

/** First `now` at which the trace reaches the uncapped bucket (interval 0). */
export function timeToUncapped(trace: TraceStep[], fromMs = 0): number | null {
  for (const s of trace) {
    if (s.now < fromMs) continue;
    if (s.intervalMs === 0) return s.now;
  }
  return null;
}

/** Highest bucket index seen at or after `fromMs`. */
export function maxBucketAfter(trace: TraceStep[], fromMs: number): number {
  let max = 0;
  for (const s of trace) {
    if (s.now >= fromMs && s.bucket > max) max = s.bucket;
  }
  return max;
}

/** The final step in the trace. */
export function finalStep(trace: TraceStep[]): TraceStep {
  const last = trace[trace.length - 1];
  if (!last) throw new Error('empty trace');
  return last;
}
