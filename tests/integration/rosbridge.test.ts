import { afterEach, describe, expect, inject, it } from 'vitest';
import { RosbridgeClient } from '../../src/RosbridgeClient';
import type { RosMessage } from '../../src/types';
import { startPublisher, stopPublisher } from './helpers/fixture';
import { waitFor } from './helpers/wait';

/**
 * RosbridgeClient against a real, pinned `rosbridge_server` (ROS 2 Jazzy,
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

  it('connects and discovers the live topic through real escaped-slash frames', async () => {
    const client = makeClient();
    await client.connect(inject('rosbridgeUrl'));

    const topics = await client.getAvailableTopics();
    const chatter = topics.find((t) => t.topic === '/chatter');

    expect(chatter).toBeDefined();
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
});
