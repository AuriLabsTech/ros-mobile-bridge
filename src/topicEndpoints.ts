// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * Transport-neutral pieces of `getTopicEndpoints` (ADR 0025): the one-lookup-
 * at-a-time gate both clients share, and the small helpers that shape an
 * answer. Internal; not exported from the package.
 */

import type { TopicEndpoints } from './types';

/** The distinct names in `topics`, first occurrence first. */
export function distinctTopics(topics: readonly string[]): string[] {
  return Array.from(new Set(topics));
}

/** Every side of every topic not known. */
export function notKnown(topics: readonly string[]): TopicEndpoints[] {
  return topics.map((topic) => ({ topic, publishers: null, subscribers: null }));
}

/** The string members of a wire value expected to be a string array; `[]` for anything else. */
export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** `ids` without the bridge's own, sorted, so answers compare stably. */
export function withoutBridge(ids: readonly string[], bridgeIds: ReadonlySet<string>): string[] {
  return ids.filter((id) => !bridgeIds.has(id)).sort();
}

/**
 * Runs one lookup at a time (ADR 0025 decision 3). A call for the same topics
 * as the newest lookup still running or waiting shares that lookup's promise;
 * any other call waits for everything before it to finish, then runs.
 */
export class LookupGate<T> {
  private tail: Promise<unknown> = Promise.resolve();
  private newest: { key: string; promise: Promise<T> } | null = null;

  run(key: string, lookup: () => Promise<T>): Promise<T> {
    if (this.newest && this.newest.key === key) return this.newest.promise;
    const promise = this.tail.then(lookup, lookup);
    const entry = { key, promise };
    this.newest = entry;
    this.tail = promise.catch(() => {});
    const clear = (): void => {
      if (this.newest === entry) this.newest = null;
    };
    promise.then(clear, clear);
    return promise;
  }
}
