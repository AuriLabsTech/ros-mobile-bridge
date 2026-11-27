// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * The hermetic unit suite imports the integration fixture for its pure
 * helpers. A wrong `RMB_RMW` left in a developer's shell must fail the
 * integration run when the fixture starts, never `npm test` when the file
 * loads.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const saved = process.env.RMB_RMW;

afterEach(() => {
  if (saved === undefined) delete process.env.RMB_RMW;
  else process.env.RMB_RMW = saved;
  vi.resetModules();
});

describe('fixture RMB_RMW check', () => {
  it('loads with an unknown RMB_RMW, and refuses it when the fixture starts', async () => {
    process.env.RMB_RMW = 'bogus';
    vi.resetModules();
    const fixture = await import('./integration/helpers/fixture');
    await expect(fixture.composeUp()).rejects.toThrow(
      'RMB_RMW must be one of rmw_fastrtps_cpp, rmw_cyclonedds_cpp, rmw_zenoh_cpp; got "bogus"',
    );
  });
});
