// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * The integration matrix is `tests/integration/docker/bridge-versions.lock`;
 * the CI integration job lists its distros by hand. A distro added to the
 * lock and not to CI would be built locally and never tested on a push.
 *
 * Zenoh support is defined per distro: a distro's `rmw_zenohd` is supported
 * once the suite passes against it (ADR 0030 decision 4), so every lock
 * distro also needs its own `rmw_zenoh_cpp` row in CI.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const lockDistros = (): string[] =>
  read('./integration/docker/bridge-versions.lock')
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols[1] === 'base')
    .map((cols) => cols[0]!);

/**
 * The `include:` rows of the `integration` job's matrix as `distro rmw`
 * pairs. The job runs from its `  integration:` line to the next job at the
 * same two-space indent, so another job's rows are never counted.
 */
const ciIncludeRows = (ci: string): string[] => {
  const start = ci.search(/^ {2}integration:\s*$/m);
  if (start < 0) return [];
  const rest = ci.slice(start + 1);
  const next = rest.search(/^ {2}[A-Za-z0-9_-]+:[ \t]*$/m);
  const job = next < 0 ? rest : rest.slice(0, next);
  const rows: string[] = [];
  const re = /-\s*distro:\s*(\S+)\s*\n\s*rmw:\s*(\S+)/g;
  for (let m = re.exec(job); m; m = re.exec(job)) rows.push(`${m[1]} ${m[2]}`);
  return rows;
};

describe('ciIncludeRows', () => {
  it('reads only the integration job, not include rows of another job', () => {
    const ci = [
      'jobs:',
      '  integration:',
      '    strategy:',
      '      matrix:',
      '        include:',
      '          - distro: jazzy',
      '            rmw: rmw_zenoh_cpp',
      '  nightly:',
      '    strategy:',
      '      matrix:',
      '        include:',
      '          - distro: humble',
      '            rmw: rmw_zenoh_cpp',
      '',
    ].join('\n');
    expect(ciIncludeRows(ci)).toEqual(['jazzy rmw_zenoh_cpp']);
  });

  it('does not end the job at a comment line that ends in a colon', () => {
    const ci = [
      'jobs:',
      '  integration:',
      '  # Zenoh on every distro:',
      '    strategy:',
      '      matrix:',
      '        include:',
      '          - distro: jazzy',
      '            rmw: rmw_zenoh_cpp',
      '',
    ].join('\n');
    expect(ciIncludeRows(ci)).toEqual(['jazzy rmw_zenoh_cpp']);
  });
});

describe('integration matrix', () => {
  const ci = read('../.github/workflows/ci.yml');

  it('the CI integration job runs every distro in bridge-versions.lock, and no other', () => {
    const ciLine = /^\s*distro:\s*\[([^\]]*)\]/m.exec(ci);
    expect(ciLine).not.toBeNull();
    const ciDistros = (ciLine?.[1] ?? '').split(',').map((d) => d.trim());
    expect(lockDistros().length).toBeGreaterThan(0);
    expect([...ciDistros].sort()).toEqual([...lockDistros()].sort());
  });

  it('the CI integration job runs Zenoh on every distro in bridge-versions.lock', () => {
    const zenohDistros = ciIncludeRows(ci)
      .filter((row) => row.endsWith(' rmw_zenoh_cpp'))
      .map((row) => row.split(' ')[0]);
    expect([...zenohDistros].sort()).toEqual([...lockDistros()].sort());
  });
});
