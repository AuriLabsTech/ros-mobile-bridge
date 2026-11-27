// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * When an integration job fails in CI, the fixture's container logs (the
 * bridges, rosapi, the Zenoh router, the `/chatter` publisher) are the only
 * record of what the robot side was doing. The fixture writes them to
 * `CONTAINER_LOG_DIR` at teardown; the CI integration job must upload that
 * same folder on failure, or a red run says nothing about which layer stalled.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { CONTAINER_LOG_DIR, describeExecError } from './integration/helpers/diagnostics';

/** The shape `child_process.execFile` rejects with. */
const execError = (fields: {
  message: string;
  stderr?: string;
  killed?: boolean;
  signal?: string;
}): Error => Object.assign(new Error(fields.message), fields);

describe('describeExecError', () => {
  it('names the stderr reason, not only "Command failed"', () => {
    const err = execError({
      message:
        'Command failed: docker info\nCannot connect to the Docker daemon at unix:///var/run/docker.sock.',
      stderr:
        'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is it running?\n',
    });
    expect(describeExecError(err)).toBe(
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is it running?',
    );
  });

  it('says the command timed out when execFile killed it', () => {
    const err = execError({
      message: 'Command failed: docker info\n',
      stderr: '',
      killed: true,
      signal: 'SIGTERM',
    });
    expect(describeExecError(err)).toBe('timed out (killed with SIGTERM)');
  });

  it('keeps the message when there is no stderr, as for a missing binary', () => {
    expect(describeExecError(execError({ message: 'spawn docker ENOENT' }))).toBe(
      'spawn docker ENOENT',
    );
  });

  it('folds a stderr of several lines into one line', () => {
    const err = execError({
      message: 'Command failed: docker info',
      stderr: 'WARNING: a\nWARNING: b\n  Cannot connect to the Docker daemon.\n',
    });
    expect(describeExecError(err)).toBe(
      'WARNING: a WARNING: b Cannot connect to the Docker daemon.',
    );
  });

  it('keeps only the end of a long stderr', () => {
    const err = execError({ message: 'Command failed: x', stderr: `${'a'.repeat(2000)}END` });
    const out = describeExecError(err);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out.endsWith('END')).toBe(true);
  });

  it('describes a value that is not an Error', () => {
    expect(describeExecError('boom')).toBe('boom');
  });
});

const ci = readFileSync(
  fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url)),
  'utf8',
);

/** The `integration` job's text, up to the next job at the same indent. */
const integrationJob = (text: string): string => {
  const start = text.search(/^ {2}integration:\s*$/m);
  if (start < 0) return '';
  const rest = text.slice(start + 1);
  const next = rest.search(/^ {2}[A-Za-z0-9_-]+:[ \t]*$/m);
  return next < 0 ? rest : rest.slice(0, next);
};

/** Each `- ` step of a job, as its own block of text. */
const steps = (job: string): string[] => job.split(/^ {6}- /m).slice(1);

describe('integration container logs in CI', () => {
  it('the integration job uploads the folder the fixture writes logs to, when it fails', () => {
    const upload = steps(integrationJob(ci)).find((s) =>
      /uses:\s*actions\/upload-artifact@/.test(s),
    );
    expect(upload, 'an actions/upload-artifact step in the integration job').toBeDefined();
    expect(upload).toMatch(/^\s*if:\s*failure\(\)\s*$/m);
    const path = /^\s*path:\s*(\S+)\s*$/m.exec(upload ?? '')?.[1];
    expect(path).toBe(CONTAINER_LOG_DIR);
  });

  it('names the artifact per matrix row, so two failed rows do not collide', () => {
    const upload = steps(integrationJob(ci)).find((s) => /actions\/upload-artifact@/.test(s)) ?? '';
    expect(upload).toMatch(/name:.*\$\{\{\s*matrix\.distro\s*\}\}.*\$\{\{\s*matrix\.rmw\s*\}\}/);
  });
});
