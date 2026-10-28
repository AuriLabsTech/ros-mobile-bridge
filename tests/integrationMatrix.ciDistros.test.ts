// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * The integration matrix is `tests/integration/docker/bridge-versions.lock`;
 * the CI integration job lists its distros by hand. A distro added to the
 * lock and not to CI would be built locally and never tested on a push.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

describe('integration matrix', () => {
  it('the CI integration job runs every distro in bridge-versions.lock, and no other', () => {
    const lockDistros = read('./integration/docker/bridge-versions.lock')
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter((cols) => cols[1] === 'base')
      .map((cols) => cols[0]);
    const ciLine = /^\s*distro:\s*\[([^\]]*)\]/m.exec(read('../.github/workflows/ci.yml'));
    expect(ciLine).not.toBeNull();
    const ciDistros = (ciLine?.[1] ?? '').split(',').map((d) => d.trim());
    expect(lockDistros.length).toBeGreaterThan(0);
    expect([...ciDistros].sort()).toEqual([...lockDistros].sort());
  });
});
