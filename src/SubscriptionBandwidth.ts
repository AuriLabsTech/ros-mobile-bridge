// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * SubscriptionBandwidth — adaptive throttle driven by JS-thread saturation.
 *
 * Bucket selection reads `EventLoopMonitor.getMaxLagMs()` rather than a
 * per-subscription bytes/sec rate. The symptom the throttle is protecting
 * against (gesture and control starvation) is a property of the JS thread,
 * not of any single message stream, so the right signal is thread saturation
 * directly. A bytes/sec ladder would have to be calibrated per device class
 * and per message size — fragile in a library targeting four runtimes — and
 * would miss the case where several medium-rate subscriptions (lidar + odom
 * + imu) sum to thread saturation while none individually crosses a byte
 * threshold.
 *
 * Bytes/sec is still tracked per subscription for metrics and UI ("currently
 * throttled because /camera is at 5 MB/s") via `getSubscriptionStats`; it is
 * not the throttle decision input.
 *
 * Hysteresis: tighten immediately on the spike (saturation costs gesture
 * authority — pay the cost up front), relax slowly (3 s below threshold) so
 * the throttle doesn't oscillate around a boundary.
 *
 * The curves themselves (`DEFAULT_PRESETS` below) were tuned on one device
 * class. Consumers can override per mode via `ProtocolClientOptions.presetOverrides`;
 * each tracker carries its own effective preset map so two clients with
 * different overrides don't share state.
 */

import { getMaxLagMs } from './EventLoopMonitor';
import type { BucketDef, ProtocolLogger, ThrottleMode } from './types';

const BANDWIDTH_WINDOW_MS = 1000;
const TIGHTEN_DWELL_MS = 0;
const RELAX_DWELL_MS = 3000;

/**
 * Library-tuned throttle curves. Override via
 * `ProtocolClientOptions.presetOverrides` to ship a per-device-class curve.
 * Exported for use by consumers building their own preset variants on top
 * of the defaults (e.g. `{ ...DEFAULT_PRESETS, auto: [...customAuto] }`).
 *
 * @experimental The override *shape* (`BucketDef`, `ThrottleMode`,
 * `presetOverrides`) is semver-stable, but the default *values* in this map
 * may be rebalanced in any patch release as device-tuning data accrues. Do
 * not snapshot these numbers and assume they're frozen; reference the export
 * if you want to track the current defaults.
 */
export const DEFAULT_PRESETS: Record<ThrottleMode, BucketDef[]> = {
  performance: [{ threshold: 0, minIntervalMs: 0, label: 'none' }],

  auto: [
    { threshold: 0, minIntervalMs: 0, label: 'none' },
    { threshold: 100, minIntervalMs: 100, label: '10 Hz' },
    { threshold: 150, minIntervalMs: 200, label: '5 Hz' },
    { threshold: 200, minIntervalMs: 1000, label: '1 Hz' },
    { threshold: 350, minIntervalMs: 2000, label: '0.5 Hz' },
  ],

  efficient: [
    { threshold: 0, minIntervalMs: 0, label: 'none' },
    { threshold: 80, minIntervalMs: 100, label: '10 Hz' },
    { threshold: 130, minIntervalMs: 200, label: '5 Hz' },
    { threshold: 200, minIntervalMs: 1000, label: '1 Hz' },
    { threshold: 350, minIntervalMs: 2000, label: '0.5 Hz' },
  ],
};

const THROTTLE_MODES: readonly ThrottleMode[] = ['performance', 'auto', 'efficient'];

/**
 * Pessimistic-start initial bucket per mode. Without this, every new
 * subscription floods → spike → tighten, costing the first ~1 s of
 * usability while the throttle catches up. Each tracker boots at a
 * moderate cap and only relaxes if observed lag stays below the
 * next-lower bucket's threshold long enough.
 */
const INITIAL_BUCKET_PER_MODE: Record<ThrottleMode, number> = {
  performance: 0,
  auto: 2,
  efficient: 3,
};

/**
 * Validate a single mode's bucket array. Returns `true` if usable as an
 * override; logs a warning and returns `false` otherwise so the caller can
 * fall back to the default for that mode.
 *
 * Only enforces correctness-essential rules:
 * - The array is non-empty.
 * - The first bucket has `threshold === 0`.
 *
 * Consumer-hygiene rules (thresholds sorted ascending, unique labels) are
 * intentionally not enforced — `recordBytes` and `bucketLabelForLag`
 * terminate with sensible-enough results in their absence, and listing every
 * possible quality rule is not the library's job.
 */
function validatePreset(
  buckets: BucketDef[] | undefined,
  mode: ThrottleMode,
  logger: ProtocolLogger,
): boolean {
  if (!buckets || buckets.length === 0) {
    logger.warn(
      `[ros-mobile-bridge] presetOverrides.${mode}: empty bucket array; using default preset for this mode`,
    );
    return false;
  }
  const first = buckets[0];
  if (!first || first.threshold !== 0) {
    logger.warn(
      `[ros-mobile-bridge] presetOverrides.${mode}: first bucket must have threshold === 0 (the "no throttle" base case); using default preset for this mode`,
    );
    return false;
  }
  return true;
}

/**
 * Merge consumer-supplied overrides on top of `DEFAULT_PRESETS`. Invalid
 * per-mode overrides are skipped (with a `logger.warn`); valid ones replace
 * the default for their mode. Returns a fresh object so two clients with
 * different overrides never share mutable state through this map.
 */
export function buildEffectivePresets(
  overrides: Partial<Record<ThrottleMode, BucketDef[]>> | undefined,
  logger: ProtocolLogger,
): Record<ThrottleMode, BucketDef[]> {
  const merged: Record<ThrottleMode, BucketDef[]> = {
    performance: DEFAULT_PRESETS.performance,
    auto: DEFAULT_PRESETS.auto,
    efficient: DEFAULT_PRESETS.efficient,
  };
  if (!overrides) return merged;

  for (const mode of THROTTLE_MODES) {
    const override = overrides[mode];
    if (override === undefined) continue;
    if (validatePreset(override, mode, logger)) {
      merged[mode] = override;
    }
  }
  return merged;
}

export interface BandwidthTracker {
  /** Ring buffer of (timestamp, byteSize) over the rolling window. */
  window: Array<{ t: number; b: number }>;
  /** Cached bytes/sec, updated on each `recordBytes`. */
  bytesPerSec: number;
  /** Bucket index currently applied (drives `adaptiveMinIntervalMs`). */
  currentBucket: number;
  /**
   * Most recently observed target bucket (may differ from `currentBucket`
   * while we're inside the hysteresis dwell window).
   */
  targetBucket: number;
  /** ms timestamp when `targetBucket` was first observed. */
  targetObservedAt: number;
  /** Effective adaptive throttle interval. `0` means no throttle. */
  adaptiveMinIntervalMs: number;
  /**
   * Effective preset map for this tracker. Shared by reference across every
   * tracker created by the same client; never mutated after construction.
   */
  presets: Record<ThrottleMode, BucketDef[]>;
}

export function createBandwidthTracker(
  mode: ThrottleMode = 'auto',
  presets: Record<ThrottleMode, BucketDef[]> = DEFAULT_PRESETS,
): BandwidthTracker {
  const initialBucket = INITIAL_BUCKET_PER_MODE[mode] ?? 0;
  const preset = presets[mode];
  const safeInitial = Math.min(initialBucket, Math.max(0, preset.length - 1));
  const initialIntervalMs = preset[safeInitial]?.minIntervalMs ?? 0;
  return {
    window: [],
    bytesPerSec: 0,
    currentBucket: safeInitial,
    targetBucket: safeInitial,
    targetObservedAt: 0,
    adaptiveMinIntervalMs: initialIntervalMs,
    presets,
  };
}

/**
 * Record an incoming message of `byteSize` bytes at time `now`. Updates the
 * rolling byte window and applies the bucket policy for the active mode
 * based on JS-thread lag. Mutates `tracker` in place.
 *
 * Bucket selection reads from `EventLoopMonitor.getMaxLagMs()` — a global
 * signal, not per-subscription. If every subscription is a small
 * contributor but they sum to JS-thread saturation, the throttle still
 * fires. That's correct: the symptom we're protecting against (gesture and
 * control starvation) is a property of the thread, not a single stream.
 */
export function recordBytes(
  tracker: BandwidthTracker,
  now: number,
  byteSize: number,
  mode: ThrottleMode = 'auto',
): void {
  tracker.window.push({ t: now, b: byteSize });
  const cutoff = now - BANDWIDTH_WINDOW_MS;
  while (tracker.window.length > 0) {
    const head = tracker.window[0];
    if (!head || head.t >= cutoff) break;
    tracker.window.shift();
  }
  let total = 0;
  for (const e of tracker.window) total += e.b;
  tracker.bytesPerSec = total / (BANDWIDTH_WINDOW_MS / 1000);

  const buckets = tracker.presets[mode];
  const lagMs = getMaxLagMs();

  let targetBucket = 0;
  for (let i = buckets.length - 1; i >= 1; i--) {
    const bucket = buckets[i];
    if (bucket && lagMs >= bucket.threshold) {
      targetBucket = i;
      break;
    }
  }

  if (targetBucket !== tracker.targetBucket) {
    tracker.targetBucket = targetBucket;
    tracker.targetObservedAt = now;
    return;
  }
  if (targetBucket === tracker.currentBucket) {
    return;
  }

  const dwell = now - tracker.targetObservedAt;
  const tighten = targetBucket > tracker.currentBucket;
  const requiredDwell = tighten ? TIGHTEN_DWELL_MS : RELAX_DWELL_MS;
  if (dwell < requiredDwell) return;

  if (tighten) {
    tracker.currentBucket = targetBucket;
  } else {
    tracker.currentBucket = Math.max(targetBucket, tracker.currentBucket - 1);
    tracker.targetObservedAt = now;
  }
  tracker.adaptiveMinIntervalMs = buckets[tracker.currentBucket]?.minIntervalMs ?? 0;
}

/**
 * Effective min-interval (ms) for a callback, combining the user's request
 * with the adaptive throttle. The user's `userMinIntervalMs` is a floor —
 * adaptive can only make the interval longer, never shorter.
 */
export function effectiveMinInterval(
  userMinIntervalMs: number | undefined,
  disableAdaptive: boolean,
  tracker: BandwidthTracker,
): number {
  const user = userMinIntervalMs ?? 0;
  if (disableAdaptive) return user;
  return Math.max(user, tracker.adaptiveMinIntervalMs);
}

/**
 * Reset the tracker to the deepest bucket so half-open recovery starts
 * conservative. The throttle's existing step-relax logic walks the bucket
 * back up if observed lag stays below the next-lower bucket's threshold.
 * Avoids a flood-then-tighten cycle on every breaker recovery.
 */
export function setTrackerToDeepest(tracker: BandwidthTracker, mode: ThrottleMode): void {
  const buckets = tracker.presets[mode];
  const lastIdx = Math.max(0, buckets.length - 1);
  tracker.currentBucket = lastIdx;
  tracker.targetBucket = lastIdx;
  tracker.targetObservedAt = 0;
  tracker.adaptiveMinIntervalMs = buckets[lastIdx]?.minIntervalMs ?? 0;
}

/**
 * Label of the bucket the tracker is currently sitting at. Used by UI to
 * tell the user what cap their subscription is throttled to right now.
 * Returns `"none"` for the no-cap bucket (or when the tracker's bucket
 * index is somehow out of range, which shouldn't happen in practice).
 */
export function getTrackerBucketLabel(tracker: BandwidthTracker, mode: ThrottleMode): string {
  const buckets = tracker.presets[mode];
  return buckets[tracker.currentBucket]?.label ?? 'none';
}

/**
 * Resolve which bucket a given lag value would land in for the active mode
 * under the library's **default** presets. Independent of any tracker —
 * pass a raw lag measurement (typically from `getMaxLagMs()`) and the
 * active throttle mode, and get back the bucket label the default-tuned
 * throttle would apply at that lag.
 *
 * Useful for diagnostics overlays that want to show "JS lag is N ms →
 * bucket X" so observers can correlate measured lag with the throttle
 * policy.
 *
 * **Note on `presetOverrides`:** this function is a stateless module-level
 * helper and has no awareness of per-client overrides. If a consumer
 * supplies `presetOverrides.auto`, calling `bucketLabelForLag('auto', lag)`
 * still returns the **default** bucket label for that lag value, not the
 * override's. For override-aware bucket labels, read
 * `getSubscriptionStats(topic).bucketLabel` off a live subscription.
 */
export function bucketLabelForLag(mode: ThrottleMode, lagMs: number): string {
  const buckets = DEFAULT_PRESETS[mode];
  let idx = 0;
  for (let i = buckets.length - 1; i >= 1; i--) {
    const bucket = buckets[i];
    if (bucket && lagMs >= bucket.threshold) {
      idx = i;
      break;
    }
  }
  return buckets[idx]?.label ?? 'none';
}
