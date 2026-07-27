import { afterEach, describe, expect, inject, it } from 'vitest';
import { FoxgloveClient } from '../../src/FoxgloveClient';
import type { RosMessage } from '../../src/types';
import { startPublisher, stopPublisher } from './helpers/fixture';
import { waitFor } from './helpers/wait';

/**
 * FoxgloveClient against a real, pinned `foxglove_bridge` (ROS 2 Jazzy).
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
});
