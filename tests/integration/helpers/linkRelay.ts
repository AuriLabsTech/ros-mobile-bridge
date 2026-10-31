/**
 * A TCP relay between a client and a bridge, so a test can drop one client's
 * link while the bridge keeps running. The fixture has no other way to drop a
 * single client's connection without restarting the bridge for every test.
 *
 * Each accepted connection is paired with its own upstream connection to the
 * bridge. `drop()` destroys both ends of every open pair, a prompt TCP close:
 * the client reads a close with no close frame (1006). A link that goes silent
 * and stays half-open, as a lost Wi-Fi often does, is not what it simulates.
 */
import net from 'node:net';

export interface LinkRelay {
  /** `ws://127.0.0.1:<port>`, to pass to `connect()` in place of the bridge's URL. */
  readonly url: string;
  /** Client connections accepted so far. */
  readonly accepted: number;
  /** Client connections open now. */
  readonly live: number;
  /** Destroys every open connection. New connections are still accepted. */
  drop(): void;
  /**
   * Stops passing the bridge's bytes to the client on every open connection,
   * for good: the bytes withheld are discarded, so a frozen connection is only
   * fit to be dropped. The client's bytes still reach the bridge, and a call
   * the client sends now gets no answer. Connections opened later are not
   * frozen.
   */
  freeze(): void;
  /** Destroys every connection and stops listening. */
  close(): Promise<void>;
}

/** Starts a relay on an ephemeral port in front of `targetUrl` (`ws://host:port`). */
export async function startLinkRelay(targetUrl: string): Promise<LinkRelay> {
  const target = new URL(targetUrl);
  if (target.port === '') {
    throw new Error(`startLinkRelay needs an explicit port in ${targetUrl}`);
  }
  const targetPort = Number(target.port);
  const pairs = new Set<{ client: net.Socket; upstream: net.Socket; frozen: boolean }>();
  let accepted = 0;

  const server = net.createServer((client) => {
    accepted++;
    const upstream = net.connect(targetPort, target.hostname);
    const pair = { client, upstream, frozen: false };
    pairs.add(pair);
    const end = (): void => {
      if (!pairs.delete(pair)) return;
      client.destroy();
      upstream.destroy();
    };
    for (const s of [client, upstream]) {
      s.on('error', end);
      s.on('close', end);
    }
    client.pipe(upstream);
    upstream.on('data', (chunk) => {
      if (!pair.frozen) client.write(chunk);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;

  const drop = (): void => {
    for (const pair of [...pairs]) {
      pairs.delete(pair);
      pair.client.destroy();
      pair.upstream.destroy();
    }
  };

  return {
    url: `ws://127.0.0.1:${port}`,
    get accepted() {
      return accepted;
    },
    get live() {
      return pairs.size;
    },
    drop,
    freeze() {
      for (const pair of pairs) pair.frozen = true;
    },
    close() {
      drop();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
