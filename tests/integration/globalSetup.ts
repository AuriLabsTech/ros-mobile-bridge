/**
 * Boots the pinned-bridge fixture once for the whole integration run:
 * compose up, assert the ujson serializer is present, resolve the ephemeral
 * host ports, and block on protocol-level readiness for both bridges.
 */
import type { GlobalSetupContext } from 'vitest/node';
import {
  assertDockerAvailable,
  assertUjsonPresent,
  composeDown,
  composeUp,
  mappedPort,
} from './helpers/fixture';
import { waitForFoxglove, waitForRosbridge } from './helpers/readiness';
import { ensureWebSocket } from './helpers/ws-global';

export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  await ensureWebSocket();
  await assertDockerAvailable();
  await composeUp();

  try {
    await assertUjsonPresent();

    const rosbridgeUrl = `ws://127.0.0.1:${await mappedPort(9090)}`;
    const foxgloveUrl = `ws://127.0.0.1:${await mappedPort(8765)}`;

    await waitForRosbridge(rosbridgeUrl, '/chatter');
    await waitForFoxglove(foxgloveUrl, '/chatter');

    provide('rosbridgeUrl', rosbridgeUrl);
    provide('foxgloveUrl', foxgloveUrl);
  } catch (err) {
    await composeDown();
    throw err;
  }

  return composeDown;
}

declare module 'vitest' {
  export interface ProvidedContext {
    rosbridgeUrl: string;
    foxgloveUrl: string;
  }
}
