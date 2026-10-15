/**
 * Boots the pinned-bridge fixture once for the whole integration run:
 * compose up, assert the ujson serializer is present, resolve the ephemeral
 * host ports, and block on protocol-level readiness for both bridges.
 */
import type { GlobalSetupContext } from 'vitest/node';
import {
  assertDockerAvailable,
  assertUjsonPresent,
  bridgeVersions,
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
    // A diagnostic: a failed lookup (a renamed package) must not skip the suite.
    const versions = await bridgeVersions().catch((err: unknown) => `unavailable: ${String(err)}`);
    console.log(`Bridge versions under test:\n${versions}`);

    const rosbridgeUrl = `ws://127.0.0.1:${await mappedPort(9090)}`;
    const foxgloveUrl = `ws://127.0.0.1:${await mappedPort(8765)}`;
    const foxgloveSdkUrl = `ws://127.0.0.1:${await mappedPort(8766)}`;
    const foxgloveHiddenUrl = `ws://127.0.0.1:${await mappedPort(8767)}`;
    const foxgloveNoPublishUrl = `ws://127.0.0.1:${await mappedPort(8768)}`;

    await waitForRosbridge(rosbridgeUrl, '/chatter');
    await waitForFoxglove(foxgloveUrl, '/chatter');
    await waitForFoxglove(foxgloveSdkUrl, '/sdk/image');
    await waitForFoxglove(foxgloveHiddenUrl, '/chatter');
    await waitForFoxglove(foxgloveNoPublishUrl, '/chatter');

    provide('rosbridgeUrl', rosbridgeUrl);
    provide('foxgloveUrl', foxgloveUrl);
    provide('foxgloveSdkUrl', foxgloveSdkUrl);
    provide('foxgloveHiddenUrl', foxgloveHiddenUrl);
    provide('foxgloveNoPublishUrl', foxgloveNoPublishUrl);
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
    foxgloveSdkUrl: string;
    foxgloveHiddenUrl: string;
    foxgloveNoPublishUrl: string;
  }
}
