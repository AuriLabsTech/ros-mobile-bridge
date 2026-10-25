// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * The integration fixture's `startPublisher` refuses a count-limited publish
 * that does not state `-w`: `ros2 topic pub --times` otherwise waits for a
 * subscriber, and a test about an old message receives a fresh one. The cases
 * call the check `startPublisher` runs first, never `startPublisher` itself,
 * so a regression in the check fails here instead of reaching Docker.
 */

import { describe, it, expect } from 'vitest';
import { checkPublisherArgs } from './integration/helpers/fixture';

describe('integration fixture startPublisher', () => {
  it.each([
    '--times 1',
    '-t 3',
    '--once',
    '-1',
    '--times 1 --keep-alive 60 --qos-depth 1',
    '--times=1',
    '-t3',
    '--tim 1',
    '--time=1',
  ])('refuses "%s" without -w', (extraArgs) => {
    expect(() => checkPublisherArgs('/t', extraArgs)).toThrow(/-w 0/);
  });

  it.each([
    '--times 1 -w 0',
    '--times 1 -w0',
    '--times=1 -w0',
    '-t3 --wait-matching-subscriptions=0',
    '--times 1 --wait-matching 0',
    '',
    '--keep-alive 60',
  ])('accepts "%s"', (extraArgs) => {
    expect(() => checkPublisherArgs('/t', extraArgs)).not.toThrow();
  });
});
