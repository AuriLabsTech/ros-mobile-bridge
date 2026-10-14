import { afterEach, describe, expect, inject, it } from 'vitest';
import { FoxgloveClient } from '../../src/FoxgloveClient';
import type { RosMessage } from '../../src/types';
import { execInBridge, startPublisher, stopPublisher } from './helpers/fixture';
import { waitFor } from './helpers/wait';

/**
 * FoxgloveClient against a real, pinned `foxglove_bridge` (the distro `RMB_ROS_DISTRO` picks).
 * Current foxglove_bridge negotiates only the `foxglove.sdk.v1` subprotocol,
 * so connecting at all proves the negotiation; delivery proves the binary
 * MessageData path and the CDR decode end to end.
 */
describe('FoxgloveClient against a stock foxglove_bridge', () => {
  const clients: FoxgloveClient[] = [];

  function makeClient(): FoxgloveClient {
    const client = new FoxgloveClient();
    clients.push(client);
    return client;
  }

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      await client.disconnect();
    }
  });

  it('negotiates foxglove.sdk.v1 and delivers CDR-decoded messages on a live topic', async () => {
    const client = makeClient();
    await client.connect(inject('foxgloveUrl'));

    const received: RosMessage[] = [];
    client.subscribe('/chatter', (m) => received.push(m));

    await waitFor(() => received.length >= 2, 15_000, 'delivery on /chatter');
    expect(received[0]?.data).toEqual({ data: 'integration' });
  });

  it('activates a subscription made before the channel is advertised (RMB-51)', async () => {
    const topic = '/integration/fg_late_arrival';
    const client = makeClient();
    await client.connect(inject('foxgloveUrl'));

    const received: RosMessage[] = [];
    client.subscribe(topic, (m) => received.push(m));
    expect(client.getSubscriptionState(topic)).toBe('pending');

    await startPublisher(topic, 'std_msgs/msg/String', '{data: late}');
    try {
      await waitFor(() => received.length >= 1, 30_000, `delivery on ${topic}`);
      expect(client.getSubscriptionState(topic)).toBe('active');
      expect(received[0]?.data).toEqual({ data: 'late' });
    } finally {
      await stopPublisher(topic);
    }
  });

  it('rejects an aborted connection attempt with AbortError and leaves the client reusable', async () => {
    const client = makeClient();
    const controller = new AbortController();

    const attempt = client.connect(inject('foxgloveUrl'), { signal: controller.signal });
    controller.abort();

    await expect(attempt).rejects.toMatchObject({ name: 'AbortError' });

    // An abort is not an error: the same client connects cleanly afterwards.
    await client.connect(inject('foxgloveUrl'));
    const topics = await client.getAvailableTopics();
    expect(topics.some((t) => t.topic === '/chatter')).toBe(true);
  });

  it('resolves {} for std_srvs/srv/Empty, whose reply padding the bridge leaves uninitialised', async () => {
    // foxglove_bridge 3.5.0 answers `00 01 00 00 00 ff 00 00`: the padding
    // after the placeholder byte is stale memory. 0.1.16-rc.1 read that as
    // data and rejected every call (lab row 4, 2026-10-09).
    const client = makeClient();
    await client.connect(inject('foxgloveUrl'));
    await waitFor(
      () => client.getAvailableServices().some((s) => s.name === '/fixture/empty'),
      30_000,
      '/fixture/empty advertised',
    );

    for (let i = 0; i < 3; i++) {
      await expect(client.callService('/fixture/empty', {})).resolves.toEqual({});
    }
  });

  it('fails an action goal fast with unavailable on a bridge launched without include_hidden', async () => {
    const client = makeClient();
    await client.connect(inject('foxgloveUrl'));
    await waitFor(
      () => client.getAvailableServices().some((s) => s.name === '/fixture/empty'),
      30_000,
      'services advertised',
    );

    const handle = client.sendActionGoal('/fixture/slow', LOOKUP_TRANSFORM, slowGoal('stock'));
    await expect(handle.outcome).rejects.toMatchObject({ reason: 'unavailable' });
  });
});

describe('FoxgloveClient against a foxglove_bridge launched with include_hidden:=true', () => {
  const clients: FoxgloveClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      await client.disconnect();
    }
  });

  it('dispatches an action goal and cancels it while it runs', async () => {
    const slowLog = (): Promise<string> =>
      execInBridge('cat /tmp/fixture_slow.log 2>/dev/null || true');
    const tag = `fg-cancel-${Date.now()}`;
    const client = new FoxgloveClient();
    clients.push(client);
    await client.connect(inject('foxgloveHiddenUrl'));
    await waitFor(
      () => client.getAvailableServices().some((s) => s.name === '/fixture/slow/_action/send_goal'),
      30_000,
      '/fixture/slow/_action/send_goal advertised',
    );

    const handle = client.sendActionGoal('/fixture/slow', LOOKUP_TRANSFORM, slowGoal(tag));
    await waitFor(
      async () => (await slowLog()).includes(`EXEC ${tag}`),
      15_000,
      `goal ${tag} executing`,
    );

    const cancelledAt = Date.now();
    handle.cancel();
    const outcome = await handle.outcome;

    expect(outcome.status).toBe(5); // CANCELED
    // Well inside the goal's 10 s, with room for a loaded CI host.
    expect(Date.now() - cancelledAt).toBeLessThan(5_000);
    expect(await slowLog()).toContain(`CANCELED ${tag}`);
  }, 45_000);

  it('builds service request and action goal templates from the advertised schemas', async () => {
    const client = new FoxgloveClient();
    clients.push(client);
    await client.connect(inject('foxgloveHiddenUrl'));
    await waitFor(
      () => client.getAvailableServices().some((s) => s.name === '/fixture/slow/_action/send_goal'),
      30_000,
      '/fixture/slow/_action/send_goal advertised',
    );

    expect(client.getSchemaTemplate('std_srvs/srv/Empty_Request')).toEqual({});
    expect(client.getSchemaTemplate(`${LOOKUP_TRANSFORM}_Goal`)).toEqual({
      target_frame: '',
      source_frame: '',
      source_time: { sec: 0, nanosec: 0 },
      timeout: { sec: 0, nanosec: 0 },
      target_time: { sec: 0, nanosec: 0 },
      fixed_frame: '',
      advanced: false,
    });
  });
});

const LOOKUP_TRANSFORM = 'tf2_msgs/action/LookupTransform';

/** A /fixture/slow goal; the fixture logs `target_frame` as the goal's tag. */
function slowGoal(tag: string): Record<string, unknown> {
  return {
    target_frame: tag,
    source_frame: 'b',
    source_time: { sec: 0, nanosec: 0 },
    timeout: { sec: 0, nanosec: 0 },
    target_time: { sec: 0, nanosec: 0 },
    fixed_frame: '',
    advanced: false,
  };
}
