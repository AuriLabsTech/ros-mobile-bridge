// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * Public export shape of the event-loop diagnostics getters. Pins the v0.1.5
 * addition of `getSustainedLagMs` to the package entry point: the throttle's
 * *relax* input must stay importable from 'ros-mobile-bridge', the symmetric
 * counterpart to the already-public `getMaxLagMs` (*tighten*). A consumer that
 * records why the adaptive cap moved logs both getters per sample, so a
 * regression that dropped the export would break that trace silently rather
 * than at type-check time.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { getMaxLagMs, getSustainedLagMs } from '../src/index';
import { __resetEventLoopMonitor } from '../src/EventLoopMonitor';

afterEach(() => {
  // Calling either getter lazily starts the shared monitor; reset so the
  // interval does not leak across test files.
  __resetEventLoopMonitor();
});

describe('EventLoopMonitor diagnostics — public export shape', () => {
  it('exports getSustainedLagMs as a zero-arg number getter', () => {
    expect(typeof getSustainedLagMs).toBe('function');
    expect(getSustainedLagMs.length).toBe(0);
    const value = getSustainedLagMs();
    expect(typeof value).toBe('number');
    expect(value).toBe(0); // no probe samples collected yet
  });

  it('exposes both adaptive-throttle input getters (tighten + relax) from the entry point', () => {
    expect(typeof getMaxLagMs).toBe('function');
    expect(typeof getSustainedLagMs).toBe('function');
  });
});
