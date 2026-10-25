// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * LinkBacklog: how far the link's delay has risen above its own recent floor
 * (ADR 0028).
 *
 * Each sample is local arrival time minus the timestamp the server put on the
 * frame. The two clocks are not synchronised, so a sample on its own means
 * nothing: it is the true one-way delay plus an unknown, constant offset. The
 * difference between two samples does mean something, because the offset
 * cancels. This is the LEDBAT construction (RFC 6817): keep the minimum delay
 * seen over a long window as the base, and read the current delay against it.
 * A current delay above the base means a queue is standing somewhere on the
 * path: the bridge's per-client queue, either kernel, the radio, or the
 * device's native socket layer.
 *
 * - Base: minimum per one-minute bucket, the last ten buckets kept (RFC 6817's
 *   BASE_HISTORY). A lower sample takes over the base at once, so a robot
 *   clock stepped forward never reads as backlog. A standing queue older than
 *   ten minutes becomes the new floor and stops reading as backlog; a robot
 *   clock stepped back reads as backlog until the same ten minutes pass, and
 *   so does a forward step that is later undone (a clock slewed by NTP or
 *   chrony), because the low samples from the step stay in the base.
 * - Current: minimum of the last few samples (RFC 6817's CURRENT_FILTER), so
 *   one late frame among steady ones does not move the reading.
 * - A server may stamp a latched replay with its original time. On a new
 *   tracker that reads 0, not backlog, when the replays arrive oldest first
 *   or number at most CURRENT_SAMPLES: the newest one is then both the base
 *   and the current delay, and the first fresh frame lowers both. More
 *   replays than that in another order (several latched publishers on one
 *   topic) can read as backlog until a fresh frame arrives or the topic goes
 *   stale. The caller gives a re-subscribe a new tracker for this reason, and
 *   the topic's floor starts over with it.
 * - A tracker whose newest sample is older than STALE_MS reads "not known": a
 *   topic that stopped arriving says nothing about the link now.
 *
 * The constants come from RFC 6817, not from a measurement on this library's
 * links, and have not yet been measured on real ones.
 */

const BUCKET_MS = 60_000;
const BASE_BUCKETS = 10;
const CURRENT_SAMPLES = 4;
const STALE_MS = 10_000;

interface Bucket {
  /** `floor(arrival / BUCKET_MS)` for the samples in this bucket. */
  minute: number;
  minDelayMs: number;
}

/** State for one subscription; a new subscription starts a new tracker. */
export interface LinkBacklogTracker {
  buckets: Bucket[];
  recent: number[];
  /** Arrival time of the newest sample. */
  lastAt: number;
}

export function createLinkBacklogTracker(): LinkBacklogTracker {
  return { buckets: [], recent: [], lastAt: 0 };
}

/** Record one frame: `delayMs` is local arrival minus the server's stamp. */
export function recordLinkDelay(t: LinkBacklogTracker, nowMs: number, delayMs: number): void {
  const minute = Math.floor(nowMs / BUCKET_MS);
  const last = t.buckets[t.buckets.length - 1];
  if (last && last.minute === minute) {
    if (delayMs < last.minDelayMs) last.minDelayMs = delayMs;
  } else {
    // Once a minute, not per frame. By range, not from the front: after this
    // device's clock steps back, the newest buckets are no longer at the end.
    t.buckets = t.buckets.filter((b) => b.minute > minute - BASE_BUCKETS && b.minute < minute);
    t.buckets.push({ minute, minDelayMs: delayMs });
  }

  t.recent.push(delayMs);
  if (t.recent.length > CURRENT_SAMPLES) t.recent.shift();
  t.lastAt = nowMs;
}

/**
 * Current delay above the base in whole ms, or `null` before the first
 * sample or once the newest is stale. Rounded because the nanosecond stamp
 * loses sub-microsecond precision as a double, and a reading of 299.9999 ms
 * says nothing 300 does not.
 */
export function readLinkBacklogMs(t: LinkBacklogTracker, nowMs: number): number | null {
  // Both ways: after this device's clock steps back, `nowMs - lastAt` is
  // negative and would never pass STALE_MS.
  if (t.recent.length === 0 || Math.abs(nowMs - t.lastAt) > STALE_MS) return null;
  let base = Infinity;
  for (const b of t.buckets) if (b.minDelayMs < base) base = b.minDelayMs;
  const current = Math.min(...t.recent);
  return Math.max(0, Math.round(current - base));
}
