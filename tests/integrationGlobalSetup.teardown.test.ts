// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * A fixture that fails while starting is when its container logs matter most:
 * the global setup must save them and tear down (`composeDown`) whatever
 * step fails, `composeUp` included, so a red CI job has logs to upload and no
 * half-started containers stay behind.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import setup from './integration/globalSetup';

// vi.mock and vi.hoisted run before the imports above, whatever their place.
const fixture = vi.hoisted(() => ({
  RMW: 'rmw_fastrtps_cpp',
  assertDockerAvailable: vi.fn(async () => 1),
  assertUjsonPresent: vi.fn(async () => {}),
  bridgeVersions: vi.fn(async () => ''),
  composeDown: vi.fn(async () => {}),
  composeUp: vi.fn(async () => {}),
  mappedPort: vi.fn(async () => 1),
}));

vi.mock('./integration/helpers/fixture', () => fixture);
vi.mock('./integration/helpers/ws-global', () => ({ ensureWebSocket: vi.fn(async () => {}) }));
vi.mock('./integration/helpers/readiness', () => ({
  waitForFoxglove: vi.fn(async () => {}),
  waitForRosbridge: vi.fn(async () => {}),
  waitForZenoh: vi.fn(async () => {}),
}));

const context = { provide: vi.fn() } as unknown as Parameters<typeof setup>[0];

describe('integration global setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('tears down, saving the logs, when compose up fails', async () => {
    fixture.composeUp.mockRejectedValueOnce(new Error('compose up timed out'));
    await expect(setup(context)).rejects.toThrow('compose up timed out');
    expect(fixture.composeDown).toHaveBeenCalledTimes(1);
  });

  it('reports the start failure, not the teardown failure, when both fail', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fixture.composeUp.mockRejectedValueOnce(new Error('compose up timed out'));
    fixture.composeDown.mockRejectedValueOnce(new Error('compose down timed out'));
    await expect(setup(context)).rejects.toThrow('compose up timed out');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('compose down timed out'));
  });

  it('tears down when a readiness step fails', async () => {
    fixture.assertUjsonPresent.mockRejectedValueOnce(new Error('no ujson'));
    await expect(setup(context)).rejects.toThrow('no ujson');
    expect(fixture.composeDown).toHaveBeenCalledTimes(1);
  });

  it('leaves the fixture up and hands back the teardown when setup succeeds', async () => {
    const teardown = await setup(context);
    expect(fixture.composeDown).not.toHaveBeenCalled();
    expect(teardown).toBe(fixture.composeDown);
  });
});
