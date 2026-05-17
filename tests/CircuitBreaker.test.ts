import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CircuitBreaker,
  DEFAULT_BREAKER_CONFIG,
  HEAVY_BANDWIDTH_THRESHOLD_BYTES_PER_SEC,
} from '../src/CircuitBreaker';
import type { CircuitBreakerState } from '../src/types';

const WARMUP_MS = 2000;

function makeBreaker(extra: Partial<typeof DEFAULT_BREAKER_CONFIG> = {}) {
  const transitions: CircuitBreakerState[] = [];
  const breaker = new CircuitBreaker({
    ...DEFAULT_BREAKER_CONFIG,
    ...extra,
    onStateChange: (next) => {
      transitions.push(next);
    },
  });
  return { breaker, transitions };
}

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts in `closed` and reports it', () => {
    const { breaker } = makeBreaker();
    expect(breaker.getState()).toBe('closed');
    expect(breaker.getNextRetryAt()).toBeNull();
  });

  it('ignores observations during the warmup window', () => {
    const { breaker, transitions } = makeBreaker({ tripDwellMs: 100 });
    const t0 = Date.now();
    // First overload within WARMUP_MS — should not affect state.
    breaker.recordOverloaded(t0 + 200);
    breaker.recordOverloaded(t0 + 400);
    expect(transitions).toEqual([]);
    expect(breaker.getState()).toBe('closed');
  });

  it('trips after sustained overload past the warmup', () => {
    const { breaker, transitions } = makeBreaker({ tripDwellMs: 1000 });
    const t0 = Date.now();
    // First overload past warmup — starts the saturation timer.
    breaker.recordOverloaded(t0 + WARMUP_MS + 100);
    // Still within tripDwellMs — should not trip yet.
    breaker.recordOverloaded(t0 + WARMUP_MS + 500);
    expect(breaker.getState()).toBe('closed');
    // Past tripDwellMs of sustained overload — trips.
    breaker.recordOverloaded(t0 + WARMUP_MS + 1200);
    expect(breaker.getState()).toBe('tripped_auto');
    expect(transitions).toEqual(['tripped_auto']);
    expect(breaker.getNextRetryAt()).not.toBeNull();
  });

  it('auto-retries via half_open after cooldown expires', () => {
    const { breaker, transitions } = makeBreaker({
      tripDwellMs: 100,
      cooldownsMs: [5000],
    });
    const t0 = Date.now();
    breaker.recordOverloaded(t0 + WARMUP_MS + 50);
    breaker.recordOverloaded(t0 + WARMUP_MS + 200);
    expect(breaker.getState()).toBe('tripped_auto');

    vi.advanceTimersByTime(5000);
    expect(breaker.getState()).toBe('half_open');
    expect(transitions).toEqual(['tripped_auto', 'half_open']);
  });

  it('closes after sustained healthy in half_open', () => {
    const { breaker, transitions } = makeBreaker({
      tripDwellMs: 100,
      cooldownsMs: [1000],
      recoveryDwellMs: 2000,
    });
    const t0 = Date.now();
    breaker.recordOverloaded(t0 + WARMUP_MS + 50);
    breaker.recordOverloaded(t0 + WARMUP_MS + 200);
    vi.advanceTimersByTime(1000); // cooldown → half_open
    expect(breaker.getState()).toBe('half_open');

    // half_open also has its own warmup window — observations within
    // WARMUP_MS of openHalf are ignored.
    const halfOpenStart = Date.now();
    breaker.recordHealthy(halfOpenStart + WARMUP_MS + 100);
    breaker.recordHealthy(halfOpenStart + WARMUP_MS + 2200);
    expect(breaker.getState()).toBe('closed');
    expect(transitions).toEqual(['tripped_auto', 'half_open', 'closed']);
  });

  it('manual retry from tripped_manual jumps straight to half_open', () => {
    const { breaker, transitions } = makeBreaker({
      tripDwellMs: 50,
      cooldownsMs: [60_000], // long cooldown — only manual retry can finish in this test
    });
    const t0 = Date.now();
    breaker.recordOverloaded(t0 + WARMUP_MS + 25);
    breaker.recordOverloaded(t0 + WARMUP_MS + 100);
    breaker.disable();
    expect(breaker.getState()).toBe('tripped_manual');
    expect(breaker.getNextRetryAt()).toBeNull();

    breaker.retry();
    expect(breaker.getState()).toBe('half_open');
    expect(transitions).toEqual(['tripped_auto', 'tripped_manual', 'half_open']);
  });

  it('disable is a no-op from non-tripped states', () => {
    const { breaker, transitions } = makeBreaker();
    breaker.disable();
    expect(breaker.getState()).toBe('closed');
    expect(transitions).toEqual([]);
  });

  it('destroy clears the cooldown timer', () => {
    const { breaker, transitions } = makeBreaker({
      tripDwellMs: 50,
      cooldownsMs: [10_000],
    });
    const t0 = Date.now();
    breaker.recordOverloaded(t0 + WARMUP_MS + 25);
    breaker.recordOverloaded(t0 + WARMUP_MS + 100);
    expect(breaker.getState()).toBe('tripped_auto');

    breaker.destroy();
    vi.advanceTimersByTime(60_000);
    // No transition to half_open occurred because the timer was cleared.
    expect(transitions).toEqual(['tripped_auto']);
    expect(breaker.getState()).toBe('tripped_auto');
  });

  it('exposes a sensible default bandwidth threshold', () => {
    expect(HEAVY_BANDWIDTH_THRESHOLD_BYTES_PER_SEC).toBeGreaterThan(0);
    expect(HEAVY_BANDWIDTH_THRESHOLD_BYTES_PER_SEC).toBe(500_000);
  });
});
