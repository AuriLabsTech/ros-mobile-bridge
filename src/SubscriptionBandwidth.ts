/**
 * SubscriptionBandwidth — adaptive throttle driven by JS-thread saturation.
 *
 * Previously this was a byte/sec ladder: "if a subscription is doing more
 * than X MB/s, cap delivery to Y Hz." Calibration was specific to a phone
 * class and a message size; on different devices and sizes it under- or
 * over-throttled.
 *
 * Replaced with a lag-based ladder: bucket selection reads the actual
 * symptom we care about — JS-thread saturation, measured by
 * `EventLoopMonitor.getMaxLagMs()`. If a 250 ms parse is currently in
 * flight, the next probe lands ~250 ms late and the throttle tightens
 * regardless of which subscription caused the saturation. This handles:
 *
 * - single high-bandwidth camera streams
 * - multiple medium subscriptions (lidar + odom + imu) summing to load
 * - slower devices where the same byte budget hurts more
 * - larger messages (1080p vs 720p) where per-message cost is bigger
 *
 * Bytes/sec is still tracked per subscription for metrics / UI ("throttled
 * because /camera is at 5 MB/s") but is no longer the decision input.
 *
 * Hysteresis: tighten immediately on the spike (saturation costs gesture
 * authority — pay the cost up front), relax slowly (3 s below threshold) so
 * we don't oscillate around a boundary.
 */

import { getMaxLagMs } from './EventLoopMonitor';

const BANDWIDTH_WINDOW_MS = 1000;
const TIGHTEN_DWELL_MS = 0;
const RELAX_DWELL_MS = 3000;

interface Bucket {
  /**
   * Lower bound of the bucket in observed JS-thread lag (ms). The
   * highest-threshold bucket whose value the lag exceeds wins.
   */
  threshold: number;
  /** Min ms between deliveries this bucket enforces. `0` = no cap. */
  minIntervalMs: number;
  /** Display name for diagnostics / UI. */
  label: string;
}

export type ThrottleMode = 'performance' | 'auto' | 'efficient';

const PRESETS: Record<ThrottleMode, Bucket[]> = {
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
}

export function createBandwidthTracker(mode: ThrottleMode = 'auto'): BandwidthTracker {
  const initialBucket = INITIAL_BUCKET_PER_MODE[mode] ?? 0;
  const preset = PRESETS[mode];
  const initialIntervalMs = preset[initialBucket]?.minIntervalMs ?? 0;
  return {
    window: [],
    bytesPerSec: 0,
    currentBucket: initialBucket,
    targetBucket: initialBucket,
    targetObservedAt: 0,
    adaptiveMinIntervalMs: initialIntervalMs,
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

  const buckets = PRESETS[mode];
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
  const buckets = PRESETS[mode];
  const lastIdx = buckets.length - 1;
  tracker.currentBucket = lastIdx;
  tracker.targetBucket = lastIdx;
  tracker.targetObservedAt = 0;
  tracker.adaptiveMinIntervalMs = buckets[lastIdx]?.minIntervalMs ?? 0;
}

/**
 * Label of the bucket the tracker is currently sitting at. Used by UI to
 * tell the user what cap their subscription is throttled to right now.
 * Returns `"none"` for the no-cap bucket.
 */
export function getTrackerBucketLabel(tracker: BandwidthTracker, mode: ThrottleMode): string {
  const buckets = PRESETS[mode];
  return buckets[tracker.currentBucket]?.label ?? 'none';
}
