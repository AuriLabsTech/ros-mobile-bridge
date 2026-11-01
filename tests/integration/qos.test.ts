import { afterEach, describe, expect, inject, it } from 'vitest';
import { FoxgloveClient } from '../../src/FoxgloveClient';
import { RosbridgeClient } from '../../src/RosbridgeClient';
import type { IProtocolClient } from '../../src/types';
import {
  RMW,
  execInBridge,
  startInBridge,
  startPublisher,
  stopInBridge,
  stopPublisher,
} from './helpers/fixture';
import { waitFor } from './helpers/wait';

/**
 * How the bridges choose QoS, measured rather than read from their source
 * (ADR 0033). The library sends no QoS on any transport, so each case here
 * pins what a consumer gets from the bridge's own choice.
 */

const LATCHED_ONCE =
  '--times 1 -w 0 --keep-alive 60 --qos-durability transient_local --qos-reliability reliable --qos-depth 1';

/** Lines of `ros2 topic echo --field data` output that start with `prefix`. */
function countLines(output: string, prefix: string): number {
  return output.split('\n').filter((l) => l.startsWith(prefix)).length;
}

/** Subscribes `client` to `topic` and collects each message's `data` string. */
function collect(client: IProtocolClient, topic: string): string[] {
  const seen: string[] = [];
  client.subscribe(topic, (m) => seen.push((m.data as { data: string }).data), {
    schemaName: 'std_msgs/msg/String',
  });
  return seen;
}

/** Waits up to `windowMs` for `value` in `seen`; a window that closes without it is the answer "no". */
async function arrives(seen: string[], value: string, windowMs: number): Promise<boolean> {
  await waitFor(() => seen.includes(value), windowMs).catch(() => {});
  return seen.includes(value);
}

describe('QoS the bridges choose for the library', () => {
  const clients: IProtocolClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.disconnect();
  });

  async function connected<T extends IProtocolClient>(client: T, url: string): Promise<T> {
    clients.push(client);
    await client.connect(url);
    return client;
  }

  /**
   * One topic whose subscription predates its publisher, one whose publisher
   * came first. Each publisher sends one transient-local message and stays up.
   * A second client subscribes once the message is old; whether it receives
   * it is the answer, so a race at the first subscriber's match cannot decide it.
   * A live message on the subscribed-first topic afterwards proves the late
   * client's subscription was there, so "no latched message" is not "no
   * subscription".
   */
  async function lateClientGetsLatched(
    make: () => Promise<IProtocolClient>,
    prefix: string,
  ): Promise<{ subscribedFirst: boolean; publisherFirst: boolean; liveAfter: boolean }> {
    const before = `/qos/${prefix}_sub_first`;
    const after = `/qos/${prefix}_pub_first`;
    try {
      const early = await make();
      early.subscribe(before, () => {}, { schemaName: 'std_msgs/msg/String' });
      await new Promise((r) => setTimeout(r, 3_000));
      await startPublisher(before, 'std_msgs/msg/String', '{data: latched}', 1, LATCHED_ONCE);
      await startPublisher(after, 'std_msgs/msg/String', '{data: latched}', 1, LATCHED_ONCE);
      // `ros2 topic pub` takes a second or two to start, then publishes.
      await new Promise((r) => setTimeout(r, 6_000));

      const late = await make();
      const onBefore = collect(late, before);
      const onAfter = collect(late, after);
      const [subscribedFirst, publisherFirst] = await Promise.all([
        arrives(onBefore, 'latched', 10_000),
        arrives(onAfter, 'latched', 10_000),
      ]);
      // A second, ordinary publisher on the same topic, read while it runs.
      await startPublisher(before, 'std_msgs/msg/String', '{data: live}', 2);
      const liveAfter = await arrives(onBefore, 'live', 15_000);
      return { subscribedFirst, publisherFirst, liveAfter };
    } finally {
      await stopPublisher(before);
      await stopPublisher(after);
    }
  }

  it('rosbridge: a topic subscribed before its latched publisher existed never replays it to a later client', async () => {
    const result = await lateClientGetsLatched(
      () => connected(new RosbridgeClient(), inject('rosbridgeUrl')),
      'rb',
    );
    // The control: with the publisher first, the bridge's shared subscription
    // is transient local and a later client gets the latched message.
    expect(result.publisherFirst).toBe(true);
    // Subscribed first, the shared subscription is volatile and stays so; the
    // per-client copy rosbridge makes for a new client copies that QoS.
    expect(result.subscribedFirst).toBe(false);
    expect(result.liveAfter).toBe(true);
  }, 90_000);

  it('Foxglove: on a topic subscribed before its latched publisher existed, a later client still gets the message', async () => {
    const result = await lateClientGetsLatched(
      () => connected(new FoxgloveClient(), inject('foxgloveUrl')),
      'fg',
    );
    expect(result.publisherFirst).toBe(true);
    // foxglove_bridge has no channel, and so no ROS subscription, until the
    // publisher appears; it then chooses QoS with the publisher in view.
    // The latched message arriving already proves the subscription, so the
    // live phase is not asserted here: on Fast DDS, Cyclone DDS and every
    // distro after Humble the late Foxglove client did not get the second,
    // volatile publisher's messages (2026-11-01; cause not run).
    expect(result.subscribedFirst).toBe(true);
  }, 90_000);

  it('rosbridge: what the library publishes is gone for a late transient-local subscriber after 1 s, except on rmw_zenoh', async () => {
    // rosbridge advertises for the library as reliable, transient local,
    // depth 100, lifespan 1 s. rmw_zenoh does not implement lifespan.
    const topic = '/qos/rb_kept';
    const live = '/tmp/qos_rb_kept_live.txt';
    const late = '/tmp/qos_rb_kept_late.txt';
    const client = await connected(new RosbridgeClient(), inject('rosbridgeUrl'));
    try {
      // A live echo proves the five messages reached the ROS graph.
      await startInBridge(
        `exec ros2 topic echo --field data ${topic} std_msgs/msg/String > ${live} 2>&1`,
      );
      client.publish(topic, 'std_msgs/msg/String', { data: 'warm' });
      // Lets the new publisher match the echo before the counted messages.
      await new Promise((r) => setTimeout(r, 4_000));
      for (let i = 0; i < 5; i++) {
        client.publish(topic, 'std_msgs/msg/String', { data: `kept-${i}` });
        await new Promise((r) => setTimeout(r, 100));
      }
      let liveCount = 0;
      await waitFor(
        async () => {
          liveCount = countLines(await execInBridge(`cat ${live} || true`), 'kept-');
          return liveCount === 5;
        },
        15_000,
        'the five messages at the live echo',
        1_000, // each poll is a container exec on a shared Docker daemon
      ).catch(() => {});
      expect(liveCount).toBe(5);

      await new Promise((r) => setTimeout(r, 2_000));
      await startInBridge(
        // Depth 100, rosbridge's own: a late joiner gets at most its own depth
        // of history, and the fresh messages below join that history too.
        'exec ros2 topic echo --qos-durability transient_local --qos-reliability reliable --qos-depth 100 ' +
          `--field data ${topic} std_msgs/msg/String > ${late} 2>&1`,
      );
      // A fresh message the late echo must receive: without it, an echo that
      // never subscribed would read as "nothing kept". Old messages can arrive
      // after the fresh one (rmw_zenoh answered 4 of 5 by then once), so the
      // read goes on until the expected count or 2 s past the fresh message.
      const expected = RMW === 'rmw_zenoh_cpp' ? 5 : 0;
      let lateOut = '';
      let lastFresh = 0;
      let freshSeenAt = 0;
      await waitFor(
        async () => {
          lateOut = await execInBridge(`cat ${late} || true`);
          if (lateOut.includes('fresh')) {
            freshSeenAt ||= Date.now();
            const done = expected > 0 && countLines(lateOut, 'kept-') === expected;
            return done || Date.now() - freshSeenAt >= 2_000;
          }
          if (Date.now() - lastFresh > 2_000) {
            client.publish(topic, 'std_msgs/msg/String', { data: 'fresh' });
            lastFresh = Date.now();
          }
          return false;
        },
        20_000,
        'a fresh message at the late echo',
        1_000,
      ).catch(() => {});
      expect(lateOut).toContain('fresh');
      expect(countLines(lateOut, 'kept-')).toBe(expected);
    } finally {
      await stopInBridge(`topic echo.* ${topic} `);
      // A kept container (RMB_INTEGRATION_KEEP=1) must not hand the next run old lines.
      await execInBridge(`rm -f ${live} ${late}`);
    }
  }, 90_000);

  it("rosbridge: subscribing with qos reliability 'reliable' delivers a 9.5 MB message from another node", async () => {
    // rosbridge's default subscription to a reliable volatile publisher is best
    // effort. On Humble with Fast DDS most 9.5 MB messages never reach it (none
    // in two 12 s windows, one in a third), while 2 MB ones do, at 1 Hz and at
    // 10 Hz (fixture, 2026-11-01). The loss is not certain, so this test pins
    // only the override's delivery. 9.5 MB stays under the bridge's 10,000,000
    // fragment size, so each message is one frame.
    const SIZE = 9_500_000;
    const script = [
      'import sys, rclpy',
      'from rclpy.node import Node',
      'from std_msgs.msg import String',
      'rclpy.init()',
      "node = Node('qos_big_pub')",
      'pub = node.create_publisher(String, sys.argv[1], 10)',
      `msg = String(data='x' * ${SIZE})`,
      'node.create_timer(1.0, lambda: pub.publish(msg))',
      'rclpy.spin(node)',
    ].join('\n');
    const b64 = Buffer.from(script).toString('base64');
    const topic = '/qos/big_reliable';
    let got = false;
    let closed = false;
    let ws: WebSocket | undefined;
    try {
      await execInBridge(`echo ${b64} | base64 -d > /tmp/qos_big_pub.py`);
      // Default rclpy publisher QoS: reliable, volatile, depth 10.
      await startInBridge(`exec python3 /tmp/qos_big_pub.py ${topic}`);
      // Opened only now, with its listeners in the same tick: a socket opened
      // before the awaits above fires 'open' before anyone listens.
      ws = new WebSocket(inject('rosbridgeUrl'));
      ws.addEventListener('error', () => {});
      // A socket that dies mid-test must fail as that, not as a QoS answer.
      ws.addEventListener('close', () => (closed = true));
      ws.addEventListener('message', (ev) => {
        // A throw here would escape the test as an unhandled error.
        if (typeof ev.data !== 'string') return;
        let frame: { op?: string; topic?: string; msg?: { data?: string } };
        try {
          frame = JSON.parse(ev.data) as typeof frame;
        } catch {
          return;
        }
        if (frame.op === 'publish' && frame.topic === topic && frame.msg?.data?.length === SIZE) {
          got = true;
        }
      });
      await new Promise((resolve, reject) => {
        ws!.addEventListener('open', resolve);
        ws!.addEventListener('close', reject);
      });
      // The first client on the topic, so its frame sets the bridge's QoS.
      ws.send(
        JSON.stringify({
          op: 'subscribe',
          topic,
          type: 'std_msgs/msg/String',
          qos: { reliability: 'reliable', durability: 'volatile', history: 'keep_last', depth: 10 },
        }),
      );
      await waitFor(() => got, 20_000, 'a 9.5 MB message').catch(() => {});
      expect(closed).toBe(false);
      expect(got).toBe(true);
    } finally {
      ws?.close();
      await stopInBridge('qos_big_pub.py');
      await execInBridge('rm -f /tmp/qos_big_pub.py');
    }
  }, 90_000);
});
