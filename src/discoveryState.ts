// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

import { registerWithInitialCall } from './listeners';
import type { DiscoveryState, ListDiscoveryState } from './types';

/** One of the two lists a {@link DiscoveryState} reports on. */
export type DiscoveryList = keyof DiscoveryState;

const UNKNOWN: ListDiscoveryState = { state: 'unknown' };

function sameState(a: ListDiscoveryState, b: ListDiscoveryState): boolean {
  return (
    a.state === b.state &&
    (a.state !== 'unavailable' || b.state !== 'unavailable' || a.reason === b.reason)
  );
}

/**
 * The discovery state of one client and its listeners (ADR 0034). Each
 * client decides when a list changes state; this owns the value, telling
 * listeners only when it actually changed, and the registration shape of
 * `onDiscoveryStateChange`.
 */
export class DiscoveryStateHolder {
  private state: DiscoveryState = { topics: UNKNOWN, services: UNKNOWN };
  private readonly listeners = new Set<(state: DiscoveryState) => void>();

  constructor(private readonly reportListenerError: (err: unknown) => void) {}

  /** A copy of the current state, safe to hand to a consumer. */
  get(): DiscoveryState {
    return { topics: { ...this.state.topics }, services: { ...this.state.services } };
  }

  /** Set the lists named in `next`; listeners hear one call if anything moved. */
  set(next: Partial<Record<DiscoveryList, ListDiscoveryState>>): void {
    let changed = false;
    const updated: DiscoveryState = { ...this.state };
    for (const list of ['topics', 'services'] as const) {
      const value = next[list];
      if (value && !sameState(value, this.state[list])) {
        updated[list] = value;
        changed = true;
      }
    }
    if (!changed) return;
    this.state = updated;
    // The listeners and the state as they stood at this change: a listener
    // registered from a callback has had its initial call. One that changes
    // the state again starts its own round, which tells every listener the
    // newer state, so this round stops rather than hand out the older one.
    const announced = updated;
    for (const cb of [...this.listeners]) {
      if (this.state !== announced) return;
      try {
        cb({ topics: { ...announced.topics }, services: { ...announced.services } });
      } catch (err) {
        this.reportListenerError(err);
      }
    }
  }

  /** Both lists back to not read yet, as on a disconnect. */
  reset(): void {
    this.set({ topics: UNKNOWN, services: UNKNOWN });
  }

  /** The current state of one list. */
  of(list: DiscoveryList): ListDiscoveryState {
    return this.state[list];
  }

  /** `onDiscoveryStateChange`: register `cb` and call it with the current state. */
  onChange(cb: (state: DiscoveryState) => void): () => void {
    return registerWithInitialCall(this.listeners, cb, this.get());
  }
}
