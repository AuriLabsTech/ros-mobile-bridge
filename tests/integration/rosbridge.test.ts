import { afterEach, describe, expect, inject, it, onTestFinished } from 'vitest';
import { RosbridgeClient } from '../../src/RosbridgeClient';
import type { RosMessage, TopicEndpoints, TopicInfo } from '../../src/types';
import { execInBridge, startPublisher, stopPublisher } from './helpers/fixture';
import { waitFor } from './helpers/wait';

/**
 * RosbridgeClient against a real, pinned `rosbridge_server` (the distro `RMB_ROS_DISTRO` picks,
 * ujson serializer present). Every frame on this wire carries the escaped
 * slashes (`"\/chatter"`) that the MockWebSocket harness cannot produce
 * faithfully, so simply operating here exercises the RMB-46 surface.
 */
describe('RosbridgeClient against a stock ujson rosbridge_server', () => {
  const clients: RosbridgeClient[] = [];

  function makeClient(): RosbridgeClient {
    const client = new RosbridgeClient();
    clients.push(client);
    return client;
  }

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      await client.disconnect();
    }
  });

  it('reports who publishes and who subscribes through rosapi, leaving the bridge out (ADR 0025)', async () => {
    const client = new RosbridgeClient({ readTopicEndpoints: true });
    clients.push(client);
    await client.connect(inject('rosbridgeUrl'));
    // Makes /rosbridge_websocket a subscriber of the sensor topic, which the
    // answer must not list.
    const received: RosMessage[] = [];
    client.subscribe('/endpoints/sensor_out', (m) => received.push(m));
    await waitFor(() => received.length >= 1, 20_000, 'delivery on /endpoints/sensor_out');

    // rosapi's view of the graph can lag the robot's for a moment after the
    // fixture starts, and not all at once: one of 20 fresh Jazzy fixtures
    // answered every side of the three endpoint topics as empty, and a Kilted
    // run had the sensor topic's publisher while the other two topics still
    // showed nobody. So ask until the whole answer settles, then check it.
    const expected: TopicEndpoints[] = [
      { topic: '/endpoints/sensor_out', publishers: ['/endpoints_sensor'], subscribers: [] },
      { topic: '/endpoints/cmd_in', publishers: [], subscribers: ['/endpoints_listener'] },
      {
        topic: '/endpoints/both',
        publishers: ['/endpoints_relay'],
        subscribers: ['/endpoints_relay'],
      },
      { topic: '/endpoints/nowhere', publishers: [], subscribers: [] },
    ];
    const ask = (): Promise<TopicEndpoints[]> =>
      client.getTopicEndpoints(expected.map((e) => e.topic));
    let answer = await ask();
    await waitFor(
      async () => {
        if (JSON.stringify(answer) === JSON.stringify(expected)) return true;
        answer = await ask();
        return false;
      },
      10_000,
      'the endpoint topics in the rosapi answer',
    ).catch(() => {}); // the assertion below shows the difference

    expect(answer).toEqual(expected);
  });

  it('delivers a topic message the bridge sent as fragments (over max_message_size)', async () => {
    const client = makeClient();
    await client.connect(inject('rosbridgeUrl'));

    // The message goes out through the bridge and comes back on its own
    // subscription, inside the bridge's node. A message from another node
    // would cross DDS to the bridge's best-effort subscription (Humble,
    // Kilted, Rolling, Cyclone DDS), which lost every 2 MB and 10.5 MB sample
    // in the fixture. That loss is before the bridge, not in the client.
    // 10.2 M characters: over the bridge's 10,000,000 fragment size, under
    // the 10 MiB its WebSocket server accepts from a client.
    const topic = '/fragments/echo';
    const received: RosMessage[] = [];
    client.subscribe(topic, (m) => received.push(m), {
      schemaName: 'std_msgs/msg/String',
      maxFrequency: 0,
      disableAdaptive: true,
    });
    const big = { data: 'x'.repeat(10_200_000) };
    let lastSent = 0;
    await waitFor(
      () => {
        if (received.length >= 1) return true;
        // Re-send until the bridge's subscription is up and catches one.
        if (Date.now() - lastSent > 2_000) {
          client.publish(topic, 'std_msgs/msg/String', big);
          lastSent = Date.now();
        }
        return false;
      },
      20_000,
      `a 10.2 MB message on ${topic}`,
    );
    const text = (received[0]?.data as { data: string }).data;
    expect(text.length).toBe(10_200_000);
    expect(/^x+$/.test(text)).toBe(true);
  });

  it('resolves a service call whose response the bridge sent as fragments', async () => {
    const client = makeClient();
    await client.connect(inject('rosbridgeUrl'));

    const result = await client.callService('/fragments_big/get_parameters', { names: ['blob'] });
    const values = (result as { values: Array<{ string_value: string }> }).values;
    expect(values[0]?.string_value.length).toBe(10_500_000);
  });

  it('connects and discovers the live topic through real escaped-slash frames', async () => {
    const client = makeClient();
    await client.connect(inject('rosbridgeUrl'));

    // rosapi's topic list can leave out a live topic for about 2 s, measured
    // in roughly 1 of 10 fresh fixtures on Jazzy and on Kilted, right after
    // the readiness check's connection closes. So ask until it shows up.
    let chatter: TopicInfo | undefined;
    await waitFor(
      async () => {
        chatter = (await client.getAvailableTopics()).find((t) => t.topic === '/chatter');
        return chatter !== undefined;
      },
      10_000,
      '/chatter in the discovered topics',
    );
    expect(chatter?.schemaName).toBe('std_msgs/msg/String');
  });

  it('delivers a type-less subscribe on a live topic (server resolves the type)', async () => {
    const client = makeClient();
    await client.connect(inject('rosbridgeUrl'));

    const received: RosMessage[] = [];
    client.subscribe('/chatter', (m) => received.push(m));

    await waitFor(() => received.length >= 2, 15_000, 'immediate-mode delivery on /chatter');
    expect(received[0]?.data).toEqual({ data: 'integration' });
  });

  it('delivers to a latest-only subscriber through real escaped-slash frames (RMB-46 fast path)', async () => {
    const client = makeClient();
    await client.connect(inject('rosbridgeUrl'));

    const received: RosMessage[] = [];
    client.subscribe('/chatter', (m) => received.push(m), {
      dispatchMode: 'latest-only',
      disableAdaptive: true,
    });

    // The latest-only path is served exclusively by the pre-parse fast-path
    // drain; the original RMB-46 bug starved it to zero on this exact wire.
    await waitFor(() => received.length >= 2, 15_000, 'latest-only delivery on /chatter');
    expect(received[0]?.data).toEqual({ data: 'integration' });
  });

  it('activates a subscription made before the topic exists once a publisher appears (RMB-49)', async () => {
    const topic = '/integration/late_arrival';
    const client = makeClient();
    await client.connect(inject('rosbridgeUrl'));

    const received: RosMessage[] = [];
    client.subscribe(topic, (m) => received.push(m));
    expect(client.getSubscriptionState(topic)).toBe('pending');

    await startPublisher(topic, 'std_msgs/msg/String', '{data: late}');
    try {
      // The budget must exceed one whole discovery interval, not equal it.
      // rosbridge announces nothing when the graph changes on a live socket,
      // so a pending subscription activates on the next topics poll, which
      // `discoveryRefreshMs` puts 30 s apart by default. This wait was 30_000
      // and measured delivery at 30_152 ms: correct behaviour, losing to its
      // own deadline. It had ~5 s of slack until 0.1.13, when discovery moved
      // off the old 5 s latency probe onto the declared 30 s poll (ADR 0015
      // decision 4). The client keeps the default cadence here deliberately,
      // so this still covers what a consumer who sets no options gets.
      await waitFor(() => received.length >= 1, 45_000, `delivery on ${topic}`);
      expect(client.getSubscriptionState(topic)).toBe('active');
      expect(received[0]?.data).toEqual({ data: 'late' });
    } finally {
      await stopPublisher(topic);
    }
  });

  it('subscribes typed from the start with a correct schemaName hint on a not-yet-published topic', async () => {
    const topic = '/integration/hinted';
    const client = makeClient();
    await client.connect(inject('rosbridgeUrl'));

    const received: RosMessage[] = [];
    client.subscribe(topic, (m) => received.push(m), { schemaName: 'std_msgs/msg/String' });

    await startPublisher(topic, 'std_msgs/msg/String', '{data: hinted}');
    try {
      // The typed subscribe registers server-side, so delivery needs no
      // discovery poll to converge first.
      await waitFor(() => received.length >= 1, 30_000, `delivery on ${topic}`);
      expect(client.getSubscriptionState(topic)).toBe('active');
      expect(received[0]?.data).toEqual({ data: 'hinted' });
    } finally {
      await stopPublisher(topic);
    }
  });

  it('rejects an aborted connection attempt with AbortError and leaves the client reusable', async () => {
    const client = makeClient();
    const controller = new AbortController();

    const attempt = client.connect(inject('rosbridgeUrl'), { signal: controller.signal });
    controller.abort();

    await expect(attempt).rejects.toMatchObject({ name: 'AbortError' });

    // An abort is not an error: the same client connects cleanly afterwards.
    await client.connect(inject('rosbridgeUrl'));
    const topics = await client.getAvailableTopics();
    expect(topics.length).toBeGreaterThan(0);
  });

  it('cancels a running goal on an open connection well before the goal would end', async () => {
    // Humble's rosbridge launch defaults run a goal on the connection's own
    // thread, so a cancel waits until the 10 s goal is over. The fixture sets
    // the *_in_new_thread arguments on every distro; this pins that setup.
    const slowLog = (): Promise<string> =>
      execInBridge('cat /tmp/fixture_slow.log 2>/dev/null || true');
    const tag = `open-cancel-${Date.now()}`;
    const client = makeClient();
    await client.connect(inject('rosbridgeUrl'));
    const handle = client.sendActionGoal('/fixture/slow', 'tf2_msgs/action/LookupTransform', {
      target_frame: tag,
      source_frame: 'b',
      source_time: { sec: 0, nanosec: 0 },
      timeout: { sec: 0, nanosec: 0 },
      target_time: { sec: 0, nanosec: 0 },
      fixed_frame: '',
      advanced: false,
    });
    await waitFor(
      async () => (await slowLog()).includes(`EXEC ${tag}`),
      15_000,
      `goal ${tag} executing`,
    );

    const cancelledAt = Date.now();
    handle.cancel();
    const outcome = await handle.outcome;

    expect(outcome.status).toBe(5); // CANCELED
    expect(Date.now() - cancelledAt).toBeLessThan(3_000);
  }, 30_000);

  it('a goal cancel written just before disconnect() reaches the action server (ADR 0023)', async () => {
    // rosbridge drops ops it has not processed when the socket closes. With
    // nothing at control priority, 0.1.16-rc.1 closed in the same tick as the
    // cancels and lost the real one in 13 of 20 and 6 of 20 runs; an E-Stop
    // left the robot driving. Ten runs, because the loss is a rate: on the old
    // code all ten passing is about a 3 % chance at the lower measured rate.
    const slowLog = (): Promise<string> =>
      execInBridge('cat /tmp/fixture_slow.log 2>/dev/null || true');
    const cancelAll = {
      goal_info: { goal_id: { uuid: new Array(16).fill(0) }, stamp: { sec: 0, nanosec: 0 } },
    };

    for (let run = 0; run < 10; run++) {
      const tag = `teardown-${run}-${Date.now()}`;
      const client = new RosbridgeClient();
      await client.connect(inject('rosbridgeUrl'));
      const handle = client.sendActionGoal('/fixture/slow', 'tf2_msgs/action/LookupTransform', {
        target_frame: tag,
        source_frame: 'b',
        source_time: { sec: 0, nanosec: 0 },
        timeout: { sec: 0, nanosec: 0 },
        target_time: { sec: 0, nanosec: 0 },
        fixed_frame: '',
        advanced: false,
      });
      handle.outcome.catch(() => {});
      await waitFor(
        async () => (await slowLog()).includes(`EXEC ${tag}`),
        15_000,
        `goal ${tag} executing`,
      );

      // The E-Stop shape: cancel every configured action, unawaited, then
      // close. The first one names an action the robot does not have, as the
      // app's sweep did in the lab; a slow op in front is what leaves the real
      // cancel unprocessed when the socket closes.
      client
        .callService('/fixture/missing/_action/cancel_goal', cancelAll, { timeoutMs: 2000 })
        .catch(() => {});
      client
        .callService('/fixture/slow/_action/cancel_goal', cancelAll, { timeoutMs: 2000 })
        .catch(() => {});
      await client.disconnect();

      await waitFor(
        async () => (await slowLog()).includes(`CANCELED ${tag}`),
        3_000,
        `cancel of ${tag} reaching the server`,
      );
    }
  }, 180_000);

  it('a goal cancel behind a subscription teardown still reaches the action server (ADR 0026)', async () => {
    // rosbridge works through a connection's ops in order and drops the
    // unworked rest on close, so what sits in front of the cancels decides how
    // long the server needs. Unsubscribes in front of the sweep outran
    // 0.1.16-rc.2's fixed 20 ms in 4 of 15 runs on this fixture, usually with
    // neither cancel handled, the shape of a device failure on 2026-10-12. With
    // the eleven live topics below, rc.2 code failed this in 3 of 3 sessions,
    // each within its first three runs.
    const slowLog = (): Promise<string> =>
      execInBridge('cat /tmp/fixture_slow.log 2>/dev/null || true');
    const cancelAll = {
      goal_info: { goal_id: { uuid: new Array(16).fill(0) }, stamp: { sec: 0, nanosec: 0 } },
    };
    const probe = makeClient();
    await probe.connect(inject('rosbridgeUrl'));
    // A dashboard's worth of live topics: each unsubscribe destroys a ROS
    // subscription, which is the slow work the sweep queues behind.
    const load = Array.from({ length: 6 }, (_, i) => `/fixture/load_${i}`);
    onTestFinished(async () => {
      for (const topic of load) await stopPublisher(topic);
    });
    for (const topic of load) {
      await startPublisher(topic, 'std_msgs/msg/String', '{data: load}', 20);
    }
    const topics = [
      '/chatter',
      '/rosout',
      '/parameter_events',
      '/fixture/slow/_action/status',
      '/fixture/slow/_action/feedback',
      ...load,
    ];
    await waitFor(
      async () => {
        const known = new Set((await probe.getAvailableTopics()).map((t) => t.topic));
        return load.every((t) => known.has(t));
      },
      20_000,
      'load publishers discovered',
    );

    for (let run = 0; run < 10; run++) {
      const tag = `behind-teardown-${run}-${Date.now()}`;
      // makeClient, so a failed wait below cannot leak a live client with its
      // subscriptions into the tests after this one.
      const client = makeClient();
      await client.connect(inject('rosbridgeUrl'));
      const unsubscribes = topics.map((t) => client.subscribe(t, () => {}));
      // Let the server set the subscriptions up, as a screen open for a while
      // has; the hidden action topics never report active, so no state check.
      await new Promise((r) => setTimeout(r, 1500));
      const handle = client.sendActionGoal('/fixture/slow', 'tf2_msgs/action/LookupTransform', {
        target_frame: tag,
        source_frame: 'b',
        source_time: { sec: 0, nanosec: 0 },
        timeout: { sec: 0, nanosec: 0 },
        target_time: { sec: 0, nanosec: 0 },
        fixed_frame: '',
        advanced: false,
      });
      handle.outcome.catch(() => {});
      await waitFor(
        async () => (await slowLog()).includes(`EXEC ${tag}`),
        15_000,
        `goal ${tag} executing`,
      );

      // Screen teardown first, then the E-Stop sweep, then close, all in one
      // synchronous run.
      for (const unsubscribe of unsubscribes) unsubscribe();
      client
        .callService('/fixture/missing/_action/cancel_goal', cancelAll, { timeoutMs: 2000 })
        .catch(() => {});
      client
        .callService('/fixture/slow/_action/cancel_goal', cancelAll, { timeoutMs: 2000 })
        .catch(() => {});
      await client.disconnect();

      await waitFor(
        async () => (await slowLog()).includes(`CANCELED ${tag}`),
        3_000,
        `cancel of ${tag} reaching the server`,
      );
    }
  }, 300_000);
});
