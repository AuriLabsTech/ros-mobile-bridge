// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * CircuitBreaker — per-subscription state machine that gracefully suspends
 * a topic when the adaptive throttle has done all it can but the JS thread
 * is still saturated.
 *
 * Design rationale: at the deepest throttle bucket (e.g. 0.5 Hz cap), each
 * 1080p q95 frame parse still takes ~200 ms on a modern phone — even one
 * frame every two seconds produces a perceptible 200 ms gesture freeze. No
 * amount of further throttle tuning fixes this; the workload is
 * fundamentally too heavy for the transport on this device. The breaker
 * detects sustained overload at the deepest bucket and unsubscribes from
 * the bridge, freeing the JS thread, network, and memory entirely for that
 * topic until the user (or auto-retry) decides to try again.
 *
 * The state machine has four states:
 *   - `closed`: normal, throttle handles the rest
 *   - `tripped_auto`: paused, auto-retry timer running (exponential backoff)
 *   - `tripped_manual`: paused, NO auto-retry — user opted out
 *   - `half_open`: re-subscribed, watching lag for `recoveryDwellMs`; if lag
 *     stays low, close; if it spikes, re-trip with longer cooldown.
 *
 * The breaker is a pure state machine — it doesn't send WebSocket ops
 * itself. The protocol client's `onStateChange` callback is responsible for
 * the side effects (send unsubscribe on enter `tripped_auto`, send
 * subscribe on enter `half_open`, etc).
 */

import type { CircuitBreakerState } from './types';

export interface CircuitBreakerConfig {
  /**
   * Lag threshold (ms) above which the breaker considers the subscription
   * "still saturated" while at the deepest throttle bucket. Suggest 150 ms —
   * comfortably above normal scheduler jitter (~5–30 ms on healthy hardware)
   * and below the threshold where a user perceives the UI as stalled.
   */
  lagThresholdMs: number;

  /**
   * Sustained ms of over-threshold lag before tripping. Suggest 2000 ms —
   * long enough that single-frame spikes (one heavy decode, a GC pause)
   * don't trigger, short enough that a genuinely saturating workload trips
   * before the user perceives the app as frozen. Together with the 500 ms
   * `WARMUP_MS` this puts the absolute minimum subscribe-to-unsubscribe
   * floor at ~2.5 s.
   */
  tripDwellMs: number;

  /**
   * ms of healthy operation in `half_open` before closing the breaker.
   * Suggest 10000 ms.
   */
  recoveryDwellMs: number;

  /**
   * Cooldown durations per consecutive trip within this connection. Index
   * `tripCount - 1` is read; the last value is reused for further trips.
   * Suggest `[30000, 60000, 120000, 300000]`.
   */
  cooldownsMs: number[];

  /**
   * Side-effect handler. Called on every state transition. The protocol
   * client uses it to send the actual `subscribe` / `unsubscribe` ops to
   * the bridge.
   */
  onStateChange: (newState: CircuitBreakerState, oldState: CircuitBreakerState) => void;
}

/**
 * ms of sustained healthy observations before we reset the saturation
 * timer. Without this debounce, lag oscillating around the trip threshold
 * resets the timer every other sample and the breaker never accumulates
 * enough dwell to trip even when the workload is plainly saturating things.
 */
const HEALTHY_DEBOUNCE_MS = 4000;

/**
 * Grace period after a (re)subscription before the breaker can register
 * any observations. The first few hundred ms after subscribe have transient
 * spikes (TCP-window fill, bridge backlog drain, first JIT pass through
 * the message-handler hot path) that don't reflect sustained workload.
 * Without warmup these can trip the breaker on lightweight topics before
 * the JIT settles in.
 *
 * Originally 2000 ms — tuned alongside the looser defaults below for
 * JSON-sim spike patterns. Tightened to 500 ms for the CDR-realistic
 * regime: schema parsing happens once in `subscribe()` rather than per
 * message, the per-frame hot path JITs in a handful of frames not seconds,
 * and on real workloads (1080p+ raw camera streams) the cold-start "flood"
 * window is what the user perceives as a freeze. A shorter warmup lets the
 * breaker step in before the user feels stuck. The remaining 500 ms is
 * still longer than any genuine cold-path JIT settle on the four target
 * runtimes; topics that legitimately fluctuate during the first half-second
 * also don't see their first sustained spike until the trip dwell anyway.
 */
const WARMUP_MS = 500;

export class CircuitBreaker {
  private state: CircuitBreakerState = 'closed';
  private tripCount = 0;
  private saturationObservedAt = 0;
  private healthyObservedAt = 0;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptionStartedAt: number = Date.now();
  private nextRetryAt: number | null = null;

  constructor(private readonly config: CircuitBreakerConfig) {}

  getState(): CircuitBreakerState {
    return this.state;
  }

  /**
   * `Date.now()` when auto-retry is scheduled to fire, or `null` if no
   * cooldown is running (closed / half_open / tripped_manual).
   */
  getNextRetryAt(): number | null {
    return this.nextRetryAt;
  }

  /**
   * Single entry point for "I saw a message; here's the current bandwidth
   * and JS-thread lag." Internally gates by `HEAVY_BANDWIDTH_THRESHOLD_BYTES_PER_SEC`
   * and the breaker's `lagThresholdMs` so the trip policy lives in one place
   * instead of being replicated at every call site.
   */
  recordObservation(now: number, bytesPerSec: number, lagMs: number): void {
    if (bytesPerSec > HEAVY_BANDWIDTH_THRESHOLD_BYTES_PER_SEC && lagMs > this.config.lagThresholdMs) {
      this.recordOverloaded(now);
    } else {
      this.recordHealthy(now);
    }
  }

  /**
   * Called from the protocol client's `recordBytes` when the tracker is in
   * the heavily-throttled range (top buckets) and lag exceeds the threshold.
   */
  recordOverloaded(now: number): void {
    if (now - this.subscriptionStartedAt < WARMUP_MS) return;
    if (this.state === 'closed' || this.state === 'half_open') {
      if (this.saturationObservedAt === 0) {
        this.saturationObservedAt = now;
      } else if (now - this.saturationObservedAt >= this.config.tripDwellMs) {
        this.trip();
      }
      this.healthyObservedAt = 0;
    }
  }

  /**
   * Called from `recordBytes` when lag is below threshold or the tracker is
   * below the heavily-throttled range.
   */
  recordHealthy(now: number): void {
    if (now - this.subscriptionStartedAt < WARMUP_MS) return;
    if (this.state !== 'closed' && this.state !== 'half_open') return;

    if (this.healthyObservedAt === 0) {
      this.healthyObservedAt = now;
    }
    const healthyDwell = now - this.healthyObservedAt;

    if (this.saturationObservedAt > 0 && healthyDwell >= HEALTHY_DEBOUNCE_MS) {
      this.saturationObservedAt = 0;
    }

    if (this.state === 'half_open' && healthyDwell >= this.config.recoveryDwellMs) {
      this.close();
    }
  }

  /**
   * User pressed "try again now" — bypasses the cooldown timer and jumps
   * straight to `half_open`. Works from any tripped state.
   */
  retry(): void {
    if (this.state === 'tripped_auto' || this.state === 'tripped_manual') {
      this.clearCooldown();
      this.openHalf();
    }
  }

  /**
   * User pressed "stop trying" — switches `tripped_auto` to `tripped_manual`
   * and cancels the auto-retry timer. The subscription remains paused until
   * the user manually retries.
   */
  disable(): void {
    if (this.state === 'tripped_auto') {
      this.clearCooldown();
      this.transition('tripped_manual');
    }
  }

  /**
   * Called by the protocol client on disconnect or unsubscribe so the
   * cooldown timer doesn't outlive the connection.
   */
  destroy(): void {
    this.clearCooldown();
  }

  // ── Internal transitions ─────────────────────────────────────────────

  private trip(): void {
    this.tripCount++;
    this.saturationObservedAt = 0;
    const cooldownIdx = Math.min(this.tripCount - 1, this.config.cooldownsMs.length - 1);
    const cooldownMs = this.config.cooldownsMs[cooldownIdx] ?? 30_000;
    this.nextRetryAt = Date.now() + cooldownMs;
    this.transition('tripped_auto');
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null;
      this.nextRetryAt = null;
      if (this.state === 'tripped_auto') {
        this.openHalf();
      }
    }, cooldownMs);
  }

  private openHalf(): void {
    const now = Date.now();
    this.saturationObservedAt = 0;
    this.healthyObservedAt = 0;
    this.subscriptionStartedAt = now;
    this.transition('half_open');
  }

  private close(): void {
    this.saturationObservedAt = 0;
    this.transition('closed');
  }

  private transition(next: CircuitBreakerState): void {
    const prev = this.state;
    if (prev === next) return;
    this.state = next;
    try {
      this.config.onStateChange(next, prev);
    } catch {
      // The side-effect callback shouldn't throw; if it does we don't want
      // to leave the breaker in a half-applied state — `this.state` is
      // already updated above.
    }
  }

  private clearCooldown(): void {
    if (this.cooldownTimer !== null) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    this.nextRetryAt = null;
  }
}

/**
 * Default config tuned for the camera-on-modern-phone workload that
 * motivated the breaker. Protocol clients can override per subscription.
 *
 * v0.1.x history: the original `lagThresholdMs: 250 / tripDwellMs: 5000`
 * pair was calibrated against JSON-sim tests where the failure shape was
 * 100–333 ms transient spikes interleaved with healthy stretches. CDR
 * sensor streams on real hardware fail in a different regime — sustained
 * multi-second freezes during the cold-start window. The current values
 * (`150 / 2000`) trade some false-positive risk on transient spikes for
 * faster detection of the genuine-freeze pattern, since that's the case
 * where the user perceives the app as stuck and needs the breaker to
 * step in before the symptom passes the perception threshold.
 */
export const DEFAULT_BREAKER_CONFIG: Omit<CircuitBreakerConfig, 'onStateChange'> = {
  lagThresholdMs: 150,
  tripDwellMs: 2_000,
  recoveryDwellMs: 10_000,
  cooldownsMs: [30_000, 60_000, 120_000, 300_000],
};

/**
 * Bytes/sec floor a subscription must exceed before the breaker considers
 * tripping it. Without this gate, when one heavy publisher saturates the
 * thread, every subscription sees the same high lag and trips in lockstep
 * — killing innocent low-rate topics. With the gate, only the actual heavy
 * contributor qualifies.
 */
export const HEAVY_BANDWIDTH_THRESHOLD_BYTES_PER_SEC = 500_000;
