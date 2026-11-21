// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * `check-lock-index.sh` compares every pinned row of
 * `bridge-versions.lock` with the packages.ros.org index, all distros in
 * one run, so a release that reached several distros is fixed in one
 * change instead of one red image build at a time. These tests feed it
 * index files from a temporary folder (`RMB_INDEX_DIR`), so they run
 * without network or Docker.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('./integration/docker/check-lock-index.sh', import.meta.url));

/** A Debian `Packages` index holding these package/version pairs. */
const packagesIndex = (entries: Record<string, string>): string =>
  Object.entries(entries)
    .map(([pkg, version]) => `Package: ${pkg}\nArchitecture: amd64\nVersion: ${version}\n`)
    .join('\n');

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rmb-lock-index-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(lock: string, indexes: Record<string, Record<string, string>>) {
  const lockPath = join(dir, 'bridge-versions.lock');
  writeFileSync(lockPath, lock);
  for (const [suite, entries] of Object.entries(indexes)) {
    writeFileSync(join(dir, `${suite}.Packages`), packagesIndex(entries));
  }
  const result = spawnSync('bash', [script, lockPath], {
    encoding: 'utf8',
    env: { ...process.env, RMB_INDEX_DIR: dir },
  });
  return { status: result.status, out: result.stdout + result.stderr };
}

/** Runs one pinned Jazzy row against a mirror folder served as file://. */
function runAgainstMirror(mirror: string) {
  const lockPath = join(dir, 'bridge-versions.lock');
  writeFileSync(lockPath, 'jazzy ros-jazzy-rosapi 2.7.1-1\n');
  const env: NodeJS.ProcessEnv = { ...process.env, RMB_INDEX_URL: `file://${mirror}` };
  delete env.RMB_INDEX_DIR;
  const result = spawnSync('bash', [script, lockPath], { encoding: 'utf8', env });
  return { status: result.status, out: result.stdout + result.stderr };
}

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

describe('check-lock-index.sh', () => {
  it('passes when every pinned row matches the index, ignoring the build stamp', () => {
    const { status, out } = run(
      'jazzy base ros:jazzy@sha256:abc\njazzy ros-jazzy-foxglove-bridge 3.6.3-1\n',
      { noble: { 'ros-jazzy-foxglove-bridge': '3.6.3-1noble.20261105.114855' } },
    );
    expect(out).toContain('ros-jazzy-foxglove-bridge 3.6.3-1 ok');
    expect(status).toBe(0);
  });

  it('lists the drift on every distro in one run, then fails', () => {
    const { status, out } = run(
      [
        'humble ros-humble-foxglove-bridge 3.6.0-1',
        'kilted ros-kilted-rmw-zenoh-cpp 0.6.8-1',
        'kilted ros-kilted-rosapi 3.3.1-1',
      ].join('\n') + '\n',
      {
        jammy: { 'ros-humble-foxglove-bridge': '3.6.3-1jammy.20261110.123757' },
        noble: {
          'ros-kilted-rmw-zenoh-cpp': '0.6.10-1noble.20261113.160343',
          'ros-kilted-rosapi': '3.3.1-1noble.20261114.100842',
        },
      },
    );
    expect(out).toContain(
      'humble ros-humble-foxglove-bridge: index has 3.6.3-1, lock says 3.6.0-1',
    );
    expect(out).toContain('kilted ros-kilted-rmw-zenoh-cpp: index has 0.6.10-1, lock says 0.6.8-1');
    expect(out).toContain('ros-kilted-rosapi 3.3.1-1 ok');
    expect(status).toBe(1);
  });

  it('skips rows pinned to "latest"', () => {
    const { status, out } = run('rolling ros-rolling-foxglove-bridge latest\n', {});
    expect(out).not.toContain('lock says');
    expect(status).toBe(0);
  });

  it('fails when a pinned package is missing from the index', () => {
    const { status, out } = run('jazzy ros-jazzy-rosapi 2.7.1-1\n', { noble: {} });
    expect(out).toContain('jazzy ros-jazzy-rosapi: not in the noble index');
    expect(status).toBe(1);
  });

  it('reads a lock whose last row has no final newline', () => {
    const { status, out } = run('jazzy ros-jazzy-rosapi 2.7.0-1', {
      noble: { 'ros-jazzy-rosapi': '2.7.1-1noble.20261106.003757' },
    });
    expect(out).toContain('jazzy ros-jazzy-rosapi: index has 2.7.1-1, lock says 2.7.0-1');
    expect(status).toBe(1);
  });

  it('has an Ubuntu suite for every pinned distro in the real lock', () => {
    const { out } = run(read('./integration/docker/bridge-versions.lock'), {
      jammy: {},
      noble: {},
      resolute: {},
    });
    expect(out).toContain('not in the');
    expect(out).not.toContain('no Ubuntu suite');
  });

  it('reports a missing local index file as unreadable, not as missing packages', () => {
    const { status, out } = run('jazzy ros-jazzy-rosapi 2.7.1-1\n', {});
    expect(out).toContain('could not read the noble index');
    expect(out).not.toContain('not in the noble index');
    expect(status).toBe(1);
  });

  it('reports a download that fails as unreadable, not as missing packages', () => {
    const { status, out } = runAgainstMirror(join(dir, 'nowhere'));
    expect(out).toContain('could not read the noble index');
    expect(out).not.toContain('not in the noble index');
    expect(status).toBe(1);
  });

  it('reports a download cut off partway as unreadable, not as missing packages', () => {
    const mirror = join(dir, 'mirror');
    mkdirSync(join(mirror, 'noble', 'main', 'binary-amd64'), { recursive: true });
    const full = gzipSync(
      packagesIndex(
        Object.fromEntries(
          Array.from({ length: 200 }, (_, i) => [`ros-jazzy-pkg-${i}`, '1.0.0-1noble.1']),
        ),
      ),
    );
    writeFileSync(
      join(mirror, 'noble', 'main', 'binary-amd64', 'Packages.gz'),
      full.subarray(0, full.length / 2),
    );
    const { status, out } = runAgainstMirror(mirror);
    expect(out).toContain('could not read the noble index');
    expect(out).not.toContain('not in the noble index');
    expect(status).toBe(1);
  });

  it('fails on a pinned distro it has no Ubuntu suite for', () => {
    const { status, out } = run('nextdistro ros-nextdistro-rosapi 1.0.0-1\n', {});
    expect(out).toContain("no Ubuntu suite for distro 'nextdistro'");
    expect(status).toBe(1);
  });
});
