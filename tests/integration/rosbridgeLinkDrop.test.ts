import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { RosbridgeClient } from '../../src/RosbridgeClient';
import type { ProtocolClientOptions } from '../../src/types';
import { startLinkRelay, type LinkRelay } from './helpers/linkRelay';
import { waitFor } from './helpers/wait';

/**
 * RosbridgeClient against a real `rosbridge_server` whose link drops, cut by a
 * TCP relay while the bridge keeps running. Each case is a reconnect path the
 * MockWebSocket suite covers with fake timers; here the sockets, the close
 * codes and the timing are real.
 */
describe('RosbridgeClient through a link that drops', () => {
  let relay: LinkRelay;
  const clients: RosbridgeClient[] = [];

  function makeClient(options?: ProtocolClientOptions): RosbridgeClient {
    const client = new RosbridgeClient(options);
    clients.push(client);
    return client;
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Rejects when `promise` has not settled within `ms`: a hang fails the test instead of timing it out. */
  async function settlesWithin<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms} ms`)), ms);
    });
    try {
      return await Promise.race([promise, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  beforeEach(async () => {
    relay = await startLinkRelay(inject('rosbridgeUrl'));
  });

  afterEach(async () => {
    try {
      for (const client of clients.splice(0)) {
        await client.disconnect();
      }
    } finally {
      await relay.close();
    }
  });

  it('a connect() while the automatic reconnect waits settles, and only one socket stays open', async () => {
    const client = makeClient();
    const statuses: string[] = [];
    client.onStatusChange((s) => statuses.push(s));
    await client.connect(relay.url);
    // Registration heard the status before the connect ('disconnected'):
    // only what follows the drop counts.
    statuses.length = 0;

    relay.drop();
    await waitFor(
      () => statuses.includes('disconnected'),
      5_000,
      "'disconnected' after the drop",
      20,
    );
    // The automatic reconnect now waits its first backoff (1 s) and has not
    // dialled yet; if it had, this test would no longer be about the wait.
    // This check, not the wait above, is what guards that.
    expect(relay.accepted).toBe(1);
    await settlesWithin(client.connect(relay.url), 5_000, 'connect() during the reconnect wait');
    // Past the replaced reconnect's deadline and the retry after it.
    await sleep(3_000);

    expect(relay.accepted).toBe(2);
    expect(relay.live).toBe(1);
    expect(client.isConnected).toBe(true);
  });

  it("a connect() from a status listener on 'disconnected' is not replaced by the automatic reconnect", async () => {
    const client = makeClient();
    await client.connect(relay.url);
    const listenerConnects: Promise<void>[] = [];
    client.onStatusChange((s) => {
      if (s === 'disconnected' && listenerConnects.length === 0) {
        listenerConnects.push(client.connect(relay.url));
      }
    });

    relay.drop();
    await waitFor(() => listenerConnects.length === 1, 5_000, "the listener's connect()");
    await settlesWithin(listenerConnects[0]!, 5_000, "the listener's connect()");
    await sleep(3_000);

    expect(relay.accepted).toBe(2);
    expect(relay.live).toBe(1);
    expect(client.isConnected).toBe(true);
  });

  it('the topic list empties at the drop and the listener hears the topics again after the reconnect', async () => {
    const client = makeClient();
    const heard: string[][] = [];
    client.onTopicsChange((topics) => heard.push(topics.map((t) => t.topic)));
    await client.connect(relay.url);
    await waitFor(() => heard.some((l) => l.includes('/chatter')), 10_000, '/chatter discovered');
    const beforeDrop = heard.length;

    // The link comes back at once, so the first reconnect attempt (1 s) succeeds.
    // A failed attempt also empties the list, which would hide the drop's own
    // emptying; checking inside the first second reads the drop alone.
    relay.drop();
    await waitFor(
      async () => !client.isConnected && (await client.getAvailableTopics()).length === 0,
      800,
      'an empty topic list before the first reconnect attempt',
      50,
    );

    // The reconnect lists the same robot's topics, and the listener hears them.
    await waitFor(
      () => heard.slice(beforeDrop).some((l) => l.includes('/chatter')),
      10_000,
      '/chatter heard again after the reconnect',
    );
    expect(relay.accepted).toBe(2);
    expect(client.isConnected).toBe(true);
  });

  it('a drop while a latency probe waits for its answer logs no "probe disabled" line', async () => {
    const client = makeClient({ latencyProbeMs: 1_000 });
    const logs: string[] = [];
    client.onLog((line) => logs.push(line));
    await client.connect(relay.url);

    // The bridge's answers stop reaching the client, so the probe sent within
    // the next second waits; the drop comes well inside its 5 s timeout.
    relay.freeze();
    await sleep(1_500);
    relay.drop();
    await waitFor(() => !client.isConnected, 5_000, 'the drop', 20);
    await waitFor(() => client.isConnected, 15_000, 'the automatic reconnect');
    // One probe interval on the new connection.
    await sleep(1_500);

    expect(relay.accepted).toBe(2);
    expect(client.isConnected).toBe(true);
    expect(logs.filter((l) => l.includes('probe disabled'))).toEqual([]);
  });
});
