// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * The discovery state holder (ADR 0034) shared by every client: listeners
 * hear each change once, and the last state a listener hears is the current
 * one, even when a listener changes the state from inside its callback.
 */

import { describe, it, expect } from 'vitest';
import { DiscoveryStateHolder } from '../src/discoveryState';
import type { DiscoveryState } from '../src/types';

describe('DiscoveryStateHolder', () => {
  it('leaves every listener holding the current state when a listener changes it mid-round', () => {
    const holder = new DiscoveryStateHolder(() => {});
    holder.onChange((s) => {
      if (s.topics.state === 'available') holder.reset();
    });
    const heard: DiscoveryState[] = [];
    holder.onChange((s) => heard.push(s));

    holder.set({ topics: { state: 'available' } });

    expect(holder.get().topics).toEqual({ state: 'unknown' });
    expect(heard.at(-1)?.topics).toEqual({ state: 'unknown' });
  });
});
