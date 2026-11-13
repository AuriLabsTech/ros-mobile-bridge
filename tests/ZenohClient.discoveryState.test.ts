// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

import { describe, it, expect } from 'vitest';
import { ZenohClient } from '../src/ZenohClient';
import type { DiscoveryState } from '../src/types';

const UNKNOWN: DiscoveryState = { topics: { state: 'unknown' }, services: { state: 'unknown' } };

/** The Zenoh skeleton reads nothing yet, so both lists are not read yet (ADR 0034). */
describe('ZenohClient skeleton discovery state (ADR 0034)', () => {
  it('reports both lists not read yet, and calls a new listener once with that', () => {
    const client = new ZenohClient();
    const seen: DiscoveryState[] = [];
    const off = client.onDiscoveryStateChange((s) => seen.push(s));

    expect(client.getDiscoveryState()).toEqual(UNKNOWN);
    expect(seen).toEqual([UNKNOWN]);
    off();
  });
});
