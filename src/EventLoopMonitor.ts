// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * EventLoopMonitor — direct measurement of JS-thread saturation.
 *
 * Hardcoded byte/sec bucket thresholds were a proxy for "is the JS thread
 * saturated?" calibrated to one device class and one message size; on
 * different devices or with bigger frames they under- or over-throttled.
 * This monitor measures the actual symptom.
 *
 * Mechanism: a `setInterval` fires every PROBE_INTERVAL_MS. Each tick
 * records how late it ran vs. when it was scheduled. Under saturation the
 * JS thread is busy with parse / reconcile work and the timer fires late —
 * that delta IS the lag. Under idle, lag is ~0-5 ms (normal scheduler
 * jitter).
 *
 * Smoothing: a 1 s rolling window keeps (timestamp, lag) pairs. The
 * reported value is the MAX over that window, not an EMA — bursty
 * saturation should be detected on the spike, not blurred away.
 *
 * The monitor starts on first `getMaxLagMs()` call (lazy) and runs forever.
 * Cost: one `setInterval` at 5 Hz reading `Date.now()`.
 *
 * Public surface: `getMaxLagMs`, `getLagStats`, `getLagHistoryCsv`, and
 * `clearLagHistory` are exported from the package and let consumers build
 * "currently throttled" diagnostics. `setModeGetter` is module-internal —
 * protocol clients call it from their constructors so the lag history is
 * tagged with the active throttle mode for bug-report exports, and
 * consumers never need to wire it themselves.
 */

const PROBE_INTERVAL_MS = 200;
const WINDOW_MS = 1000;
const HISTORY_MAX = 600;

interface LagSample {
  t: number;
  lag: number;
}

interface HistorySample {
  t: number;
  lag: number;
  mode: string;
}

let started = false;
let lastTickAt = 0;
const samples: LagSample[] = [];
const history: HistorySample[] = [];

let modeGetter: () => string = () => 'auto';

/**
 * Internal. Protocol clients invoke this from their constructors with the
 * value they received from `ProtocolClientOptions.getThrottleMode`. The
 * monitor uses the result to tag history samples with the active throttle
 * mode for the diagnostics CSV. Not re-exported from the package entry
 * point — consumers configure throttle mode through `getThrottleMode`.
 */
export function setModeGetter(fn: () => string): void {
  modeGetter = fn;
}

function startMonitor(): void {
  if (started) return;
  started = true;
  lastTickAt = Date.now();
  const handle: unknown = setInterval(() => {
    const now = Date.now();
    const elapsed = now - lastTickAt;
    const lag = Math.max(0, elapsed - PROBE_INTERVAL_MS);
    lastTickAt = now;

    samples.push({ t: now, lag });
    const cutoff = now - WINDOW_MS;
    while (samples.length > 0) {
      const head = samples[0];
      if (!head || head.t >= cutoff) break;
      samples.shift();
    }

    let mode = 'auto';
    try {
      mode = modeGetter();
    } catch {
      // mode tagging is best-effort; never break the monitor on a bad getter.
    }
    history.push({ t: now, lag, mode });
    if (history.length > HISTORY_MAX) {
      history.shift();
    }
  }, PROBE_INTERVAL_MS);

  // The monitor is a passive diagnostic; it must not keep a Node process
  // alive on its own. Once a consumer's real work (an active WebSocket,
  // an HTTP server) finishes, the process should exit even if the monitor
  // is still ticking. `unref` exists on Node's Timeout object; browsers,
  // React Native, and Electron's renderer don't have or need it.
  const unref = (handle as { unref?: () => void } | null)?.unref;
  if (typeof unref === 'function') {
    unref.call(handle);
  }
}

/**
 * Max observed JS-thread lag (ms) over the last `WINDOW_MS`. Auto-starts
 * the monitor on first call. Returns `0` if no samples have been collected
 * yet.
 */
export function getMaxLagMs(): number {
  if (!started) startMonitor();
  let max = 0;
  for (const s of samples) {
    if (s.lag > max) max = s.lag;
  }
  return max;
}

/**
 * Percentile statistics over the long-term history buffer (roughly the last
 * 2 minutes). Returns `null` when no samples have been collected yet.
 */
export function getLagStats(): {
  count: number;
  durationSec: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
} | null {
  if (history.length === 0) return null;
  const sorted = history.map((s) => s.lag).sort((a, b) => a - b);
  const pick = (q: number): number => {
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
    return sorted[idx] ?? 0;
  };
  const first = history[0];
  const last = history[history.length - 1];
  const span = first && last ? (last.t - first.t) / 1000 : 0;
  return {
    count: history.length,
    durationSec: Math.round(span),
    p50: pick(0.5),
    p90: pick(0.9),
    p99: pick(0.99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

/**
 * CSV dump of the history buffer. One row per sample, mode-tagged so a
 * recording that spans a throttle-mode change still tells you which lag
 * values belong to which mode. Useful for attaching to bug reports.
 */
export function getLagHistoryCsv(): string {
  const header = 'timestamp_ms,lag_ms,mode';
  const rows = history.map((s) => `${s.t},${s.lag},${s.mode}`);
  return [header, ...rows].join('\n');
}

/**
 * Clear the long-term history buffer. The rolling 1 s window used by the
 * throttle keeps running, so live throttle decisions stay correct. Useful
 * when starting a new test session.
 */
export function clearLagHistory(): void {
  history.length = 0;
}

/**
 * Test helper. Resets the monitor's internal state so unit tests get a
 * clean slate. Not exported from the package entry point.
 *
 * @internal
 */
export function __resetEventLoopMonitor(): void {
  samples.length = 0;
  history.length = 0;
  lastTickAt = Date.now();
}
