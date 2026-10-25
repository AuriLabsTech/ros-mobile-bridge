// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * The link-backlog arithmetic (ADR 0028): how far the delay between a server
 * stamp and local arrival has risen above its own recent floor. The clocks are
 * not synchronised, so every case below holds for any constant offset.
 */

import { describe, it, expect } from 'vitest';
import { createLinkBacklogTracker, readLinkBacklogMs, recordLinkDelay } from '../src/LinkBacklog';

const MINUTE = 60_000;

describe('LinkBacklog', () => {
  it('is not known before the first sample', () => {
    const t = createLinkBacklogTracker();
    expect(readLinkBacklogMs(t, 0)).toBeNull();
    recordLinkDelay(t, 0, 40);
    expect(readLinkBacklogMs(t, 0)).toBe(0);
  });

  it.each([1, 3, 10])(
    'reads 0 through a replay of %i old messages, oldest first, on a new tracker',
    (depth) => {
      const t = createLinkBacklogTracker();
      for (let i = 0; i < depth; i++) {
        recordLinkDelay(t, i, 3_600_000 - i * 1_000);
        expect(readLinkBacklogMs(t, i)).toBe(0);
      }
      recordLinkDelay(t, 100, 40);
      expect(readLinkBacklogMs(t, 100)).toBe(0);
    },
  );

  it.each([0, 3_600_000, -3_600_000])(
    'reads 0 on a steady link whatever the clock offset (%i ms)',
    (offset) => {
      const t = createLinkBacklogTracker();
      for (let i = 0; i < 20; i++) recordLinkDelay(t, i * 100, offset + 40);
      expect(readLinkBacklogMs(t, 1900)).toBe(0);
    },
  );

  it('reads the rise above the floor once the delay stays up', () => {
    const t = createLinkBacklogTracker();
    for (let i = 1; i < 10; i++) recordLinkDelay(t, i * 100, 40);
    for (let i = 10; i < 20; i++) recordLinkDelay(t, i * 100, 240);
    expect(readLinkBacklogMs(t, 1900)).toBe(200);
  });

  it('ignores a lone late frame among steady ones', () => {
    const t = createLinkBacklogTracker();
    for (let i = 1; i < 10; i++) recordLinkDelay(t, i * 100, 40);
    recordLinkDelay(t, 1000, 900);
    expect(readLinkBacklogMs(t, 1000)).toBe(0);
  });

  it('falls back to 0 when the queue drains', () => {
    const t = createLinkBacklogTracker();
    for (let i = 1; i < 10; i++) recordLinkDelay(t, i * 100, 40);
    for (let i = 10; i < 20; i++) recordLinkDelay(t, i * 100, 500);
    for (let i = 20; i < 30; i++) recordLinkDelay(t, i * 100, 40);
    expect(readLinkBacklogMs(t, 2900)).toBe(0);
  });

  it('follows a lower floor at once, so a clock stepped forward does not read as backlog', () => {
    const t = createLinkBacklogTracker();
    for (let i = 1; i < 10; i++) recordLinkDelay(t, i * 100, 40);
    for (let i = 10; i < 20; i++) recordLinkDelay(t, i * 100, -960);
    expect(readLinkBacklogMs(t, 1900)).toBe(0);
  });

  it('forgets a floor older than ten minutes', () => {
    const t = createLinkBacklogTracker();
    recordLinkDelay(t, 0, 40);
    // A standing queue of 100 ms from then on: read as backlog while the old
    // floor is remembered, and as the new normal once it ages out.
    for (let now = MINUTE / 2; now <= 9 * MINUTE; now += MINUTE / 2) recordLinkDelay(t, now, 140);
    expect(readLinkBacklogMs(t, 9 * MINUTE)).toBe(100);
    for (let now = 9 * MINUTE; now <= 11 * MINUTE; now += MINUTE / 2) recordLinkDelay(t, now, 140);
    expect(readLinkBacklogMs(t, 11 * MINUTE)).toBe(0);
  });

  it('is not known once the newest sample is more than ten seconds old', () => {
    const t = createLinkBacklogTracker();
    for (let i = 1; i < 10; i++) recordLinkDelay(t, i * 100, 40);
    expect(readLinkBacklogMs(t, 900 + 10_000)).toBe(0);
    expect(readLinkBacklogMs(t, 900 + 10_001)).toBeNull();
  });

  it('is not known ten seconds after the last sample when this device clock stepped back meanwhile', () => {
    const t = createLinkBacklogTracker();
    for (let i = 0; i < 10; i++) recordLinkDelay(t, 60 * MINUTE + i * 100, 40);
    // Stepped back an hour, then eleven seconds pass with no frame.
    expect(readLinkBacklogMs(t, 900 + 11_000)).toBeNull();
  });

  it('keeps at most ten minutes of buckets after this device clock steps back', () => {
    const t = createLinkBacklogTracker();
    recordLinkDelay(t, 400 * MINUTE, 40);
    for (let m = 0; m < 30; m++) recordLinkDelay(t, m * MINUTE, 40);
    expect(t.buckets.length).toBeLessThanOrEqual(10);
  });
});
