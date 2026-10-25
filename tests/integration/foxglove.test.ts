import { afterEach, describe, expect, inject, it } from 'vitest';
import { FoxgloveClient } from '../../src/FoxgloveClient';
import type { RosMessage } from '../../src/types';
import { execInBridge, startPublisher, stopPublisher } from './helpers/fixture';
import { waitFor } from './helpers/wait';

/**
 * FoxgloveClient against a real `foxglove_bridge` (the distro `RMB_ROS_DISTRO` picks; pinned except on Rolling).
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

  it("says publishing is 'allowed' on a bridge with the default capabilities (ADR 0022)", async () => {
    const client = makeClient();
    await client.connect(inject('foxgloveUrl'));
    expect(client.getPublishPermission()).toBe('allowed');
  });

  it('reads a small link backlog from the bridge stamps on an idle local link (ADR 0028)', async () => {
    const client = makeClient();
    await client.connect(inject('foxgloveUrl'));
    expect(client.getLinkBacklogMs()).toBeNull();

    const received: RosMessage[] = [];
    client.subscribe('/chatter', (m) => received.push(m));
    await waitFor(() => received.length >= 10, 30_000, 'delivery on /chatter');

    // A real bridge's stamps yield a reading, and a small one on a local link.
    // The bound is loose because this Docker host is shared and often loaded:
    // a stall has to hold through four frames in a row to reach it. The unit
    // arithmetic is pinned by the stamped frames in the unit tests.
    const backlog = client.getLinkBacklogMs();
    expect(backlog).not.toBeNull();
    expect(backlog).toBeGreaterThanOrEqual(0);
    expect(backlog).toBeLessThan(2_000);
  });

  it('stamps a latched replay when it delivers it, not when it was published (ADR 0028)', async () => {
    // One message, published once and held as transient-local. `-w 0`: with
    // `--times`, `ros2 topic pub` otherwise waits for a subscriber before it
    // publishes, and the message would not be old. The Header carries the
    // publisher's own clock, so the test can check the message was old.
    const topic = '/integration/fg_latched_replay';
    await startPublisher(
      topic,
      'std_msgs/msg/Header',
      '{stamp: now, frame_id: latched}',
      1,
      '--times 1 -w 0 --keep-alive 60 --qos-durability transient_local --qos-depth 1',
    );
    try {
      // `ros2 topic pub` takes a second or two to start, then publishes.
      await new Promise((r) => setTimeout(r, 5_000));
      const client = makeClient();
      await client.connect(inject('foxgloveUrl'));
      const received: Array<{ arrival: number; msg: RosMessage }> = [];
      client.subscribe(topic, (msg) => received.push({ arrival: Date.now(), msg }));
      await waitFor(() => received.length >= 1, 15_000, 'the latched message');

      const { arrival, msg } = received[0]!;
      const stampedMs = msg.receiveTime.sec * 1000 + msg.receiveTime.nsec / 1e6;
      const { stamp } = msg.data as { stamp: { sec: number; nanosec: number } };
      const publishedMs = stamp.sec * 1000 + stamp.nanosec / 1e6;

      // The bridge and the publisher share the container's clock. This process
      // reads the host's: the same clock on Linux, a VM synced to it under
      // Docker Desktop. The message was published seconds before the subscribe...
      expect(stampedMs - publishedMs).toBeGreaterThan(2_500);
      // ...and the bridge stamped it on delivery, not at publication.
      expect(Math.abs(arrival - stampedMs)).toBeLessThan(1_500);
    } finally {
      await stopPublisher(topic);
    }
  });

  it("lists a topic only this client publishes back to it, marked 'app' (ADR 0029)", async () => {
    const topic = '/integration/fg_source_probe';
    const client = makeClient();
    const other = makeClient();
    await client.connect(inject('foxgloveUrl'));
    await other.connect(inject('foxgloveUrl'));

    client.ensureAdvertised(topic, 'std_msgs/msg/String');
    let lastSent = 0;
    const listed = async (c: FoxgloveClient) =>
      (await c.getAvailableTopics()).find((t) => t.topic === topic);
    await waitFor(
      async () => {
        if (Date.now() - lastSent > 1_000) {
          client.publish(topic, 'std_msgs/msg/String', { data: 'probe' });
          lastSent = Date.now();
        }
        return (await listed(client)) !== undefined;
      },
      15_000,
      `${topic} listed back by the bridge`,
    );
    expect((await listed(client))?.source).toBe('app');
    await waitFor(
      async () => (await listed(other)) !== undefined,
      15_000,
      `${topic} for the other client`,
    );
    expect((await listed(other))?.source).toBe('robot');

    // The bridge may drop the channel at once or a moment later; while it is
    // listed it is no longer this client's.
    client.unadvertise(topic);
    const after = await listed(client);
    if (after) expect(after.source).toBe('robot');
  });

  it("resolves connect() when a status handler disconnects on 'connected', and stays closed", async () => {
    const client = makeClient();
    const statuses: string[] = [];
    // Registration replays the initial 'disconnected', so "closed" means a
    // 'disconnected' that follows the 'connected'.
    let closed = false;
    let topicListsAfterClose = 0;
    client.onStatusChange((s) => {
      if (s === 'disconnected' && statuses.includes('connected')) closed = true;
      statuses.push(s);
      if (s === 'connected') void client.disconnect();
    });
    client.onTopicsChange(() => {
      if (closed) topicListsAfterClose++;
    });

    await expect(client.connect(inject('foxgloveUrl'))).resolves.toBeUndefined();
    const last = () => statuses[statuses.length - 1];
    await waitFor(() => last() === 'disconnected', 5_000, "status 'disconnected'");
    // Long enough for the bridge's first advertise to have arrived.
    await new Promise((r) => setTimeout(r, 1_000));
    expect(client.isConnected).toBe(false);
    expect(last()).toBe('disconnected');
    expect(topicListsAfterClose).toBe(0);
  });
});

describe('FoxgloveClient against a foxglove_bridge without the clientPublish capability', () => {
  const clients: FoxgloveClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      await client.disconnect();
    }
  });

  it("says publishing is 'refused' (ADR 0022)", async () => {
    const client = new FoxgloveClient();
    clients.push(client);
    await client.connect(inject('foxgloveNoPublishUrl'));
    expect(client.getPublishPermission()).toBe('refused');
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

  it('describes a service request, an action goal and a topic type field by field (ADR 0032)', async () => {
    const client = new FoxgloveClient();
    clients.push(client);
    await client.connect(inject('foxgloveHiddenUrl'));
    await waitFor(
      () => client.getAvailableServices().some((s) => s.name === '/fixture/slow/_action/send_goal'),
      30_000,
      '/fixture/slow/_action/send_goal advertised',
    );

    expect(await client.getSchemaDefinition('std_srvs/srv/Empty_Request')).toEqual({
      root: 'std_srvs/srv/Empty_Request',
      types: {
        'std_srvs/srv/Empty_Request': {
          name: 'std_srvs/srv/Empty_Request',
          fields: [],
          constants: [],
        },
      },
    });

    const goal = await client.getSchemaDefinition(`${LOOKUP_TRANSFORM}_Goal`);
    expect(goal?.root).toBe(`${LOOKUP_TRANSFORM}_Goal`);
    const goalType = goal?.types[`${LOOKUP_TRANSFORM}_Goal`];
    expect(goalType?.fields.map((f) => [f.name, f.type])).toEqual([
      ['target_frame', 'string'],
      ['source_frame', 'string'],
      ['source_time', 'builtin_interfaces/msg/Time'],
      ['timeout', 'builtin_interfaces/msg/Duration'],
      ['target_time', 'builtin_interfaces/msg/Time'],
      ['fixed_frame', 'string'],
      ['advanced', 'bool'],
    ]);
    expect(goal?.types['builtin_interfaces/msg/Duration']?.fields.map((f) => f.name)).toEqual([
      'sec',
      'nanosec',
    ]);

    await waitFor(
      async () => (await client.getAvailableTopics()).some((t) => t.topic === '/rosout'),
      10_000,
      '/rosout advertised',
    );
    const log = await client.getSchemaDefinition('rcl_interfaces/msg/Log');
    expect(log?.types['rcl_interfaces/msg/Log']?.fields[0]?.type).toBe(
      'builtin_interfaces/msg/Time',
    );
  });
});

/**
 * Topic endpoints (ADR 0025) against both bridges: 8765 is named
 * /foxglove_bridge, 8767 is renamed /foxglove_bridge_hidden and runs on the
 * same robot as the first, so a client that left out "the node called
 * /foxglove_bridge" would get 8767 wrong. The fixture's three endpoint nodes
 * give a publish-only, a subscribe-only and a two-sided topic.
 */
describe.each([
  ['the stock foxglove_bridge', 'foxgloveUrl'],
  ['the renamed foxglove_bridge_hidden', 'foxgloveHiddenUrl'],
] as const)('FoxgloveClient topic endpoints on %s', (_name, urlKey) => {
  const clients: FoxgloveClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      await client.disconnect();
    }
  });

  it('reports who publishes and who subscribes, leaving its own bridge out', async () => {
    const client = new FoxgloveClient({ readTopicEndpoints: true });
    clients.push(client);
    await client.connect(inject(urlKey));
    await waitFor(
      async () =>
        (await client.getAvailableTopics()).some((t) => t.topic === '/endpoints/sensor_out'),
      30_000,
      '/endpoints/sensor_out advertised',
    );
    // The app's own subscription puts the bridge in the graph, triggers the
    // rebuild the bridge needs before its map can be trusted, and is the
    // evidence of the bridge's name.
    client.subscribe('/endpoints/sensor_out', () => {});

    const topics = ['/endpoints/sensor_out', '/endpoints/cmd_in', '/endpoints/both'];
    let answer = await client.getTopicEndpoints(topics);
    await waitFor(
      async () => {
        answer = await client.getTopicEndpoints(topics);
        return answer.every((e) => e.publishers !== null && e.subscribers !== null);
      },
      20_000,
      'a known topic-endpoints answer',
    );

    expect(answer).toEqual([
      { topic: '/endpoints/sensor_out', publishers: ['/endpoints_sensor'], subscribers: [] },
      { topic: '/endpoints/cmd_in', publishers: [], subscribers: ['/endpoints_listener'] },
      {
        topic: '/endpoints/both',
        publishers: ['/endpoints_relay'],
        subscribers: ['/endpoints_relay'],
      },
    ]);
  }, 60_000);
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
