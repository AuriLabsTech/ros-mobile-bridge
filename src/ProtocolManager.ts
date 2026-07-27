// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * ProtocolManager — factory plus active-connection lifecycle manager.
 *
 * Builds the appropriate `IProtocolClient` for `options.protocol`, sanitizes
 * the user-entered host, validates the URL with `new URL()`, and forwards
 * the connection. Holds the active client so callers don't have to.
 *
 * `setClientOptions` is the injection point for the host's `onLatency`
 * callback, `logger`, and `getThrottleMode` selector. Options are stored
 * and forwarded into every client the manager constructs.
 */

import { FoxgloveClient } from './FoxgloveClient';
import { RosbridgeClient } from './RosbridgeClient';
import type {
  ConnectOptions,
  ConnectionOptions,
  IProtocolClient,
  ProtocolClientOptions,
} from './types';
import { connectAbortReason } from './errors';
import { DEFAULT_PORTS } from './constants';

/**
 * Normalize a user-entered host string into something safe to drop into
 * `${scheme}://${host}:${port}`. Strips `ws://`, `wss://`, `http://`,
 * `https://` prefixes (paste from a browser address bar or a Foxglove URL),
 * drops a trailing `:port` (so a `host:8766` paste doesn't poison the URL
 * with two ports — the dedicated `port` field always wins), and trims
 * trailing path / query / fragment plus whitespace.
 */
function sanitizeHost(raw: string): string {
  let host = (raw ?? '').trim();
  host = host.replace(/^(wss?|https?):\/\//i, '');
  // Drop trailing path/query/fragment.
  host = host.split('/')[0] ?? host;
  host = host.split('?')[0] ?? host;
  host = host.split('#')[0] ?? host;
  // Strip a trailing :port. IPv6 literals are bracketed and contain their own
  // colons (`[::1]`), so for a bracketed host strip only a `:port` that follows
  // the closing bracket (`[::1]:8765` -> `[::1]`), never the colons inside it.
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    if (close !== -1 && host[close + 1] === ':') {
      host = host.slice(0, close + 1);
    }
  } else {
    const colonIx = host.indexOf(':');
    if (colonIx !== -1) host = host.slice(0, colonIx);
  }
  return host;
}

export class ProtocolManager {
  private activeClient: IProtocolClient | null = null;
  private activeOptions: ConnectionOptions | null = null;
  private clientOptions: ProtocolClientOptions | undefined;

  /**
   * Set options forwarded to every client constructed by this manager.
   * Host applications typically call this once at startup.
   */
  setClientOptions(options: ProtocolClientOptions): void {
    this.clientOptions = options;
  }

  /**
   * Create and connect a protocol client for the given options.
   *
   * `connectOptions` is forwarded verbatim to the client's `connect` (see
   * `ConnectOptions.signal` for the cancellation contract). The signal is
   * checked before any side effect: a pre-aborted call rejects immediately
   * and leaves the currently active client connected and untouched.
   *
   * For `protocol: 'zenoh'`, throws a clear "planned for v0.3.0" error —
   * the v0.1.0 release does not ship a Zenoh implementation.
   */
  connect(
    options: ConnectionOptions,
    connectOptions?: ConnectOptions,
  ): Promise<IProtocolClient> {
    const signal = connectOptions?.signal;
    if (signal?.aborted) {
      const rejected = Promise.reject<IProtocolClient>(connectAbortReason(signal));
      rejected.catch(() => {}); // pre-handled cancellation (ADR 0003)
      return rejected;
    }

    const attempt = this.doConnect(options, connectOptions);
    if (!signal) return attempt;

    // Pre-handle the caller's promise only when an abort actually fires, so
    // cancellations never surface as unhandled rejections while genuine
    // failures keep their visibility. The listener attaches to the promise
    // the caller holds — `attempt` is this method's internal async wrapper.
    // Both callbacks run strictly after this block (abort events and promise
    // settlement are asynchronous), so each sees the other binding initialized.
    const returned = attempt.finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
    const onAbort = (): void => {
      returned.catch(() => {}); // pre-handled cancellation (ADR 0003)
    };
    signal.addEventListener('abort', onAbort);
    return returned;
  }

  private async doConnect(
    options: ConnectionOptions,
    connectOptions?: ConnectOptions,
  ): Promise<IProtocolClient> {
    if (this.activeClient) {
      await this.activeClient.disconnect();
    }

    const client = this.createClient(options);
    // Infer TLS from a pasted `wss://` / `https://` host when `secure` is unset,
    // so a user who pastes a wss:// URL doesn't silently get a plaintext
    // connection — the one input that explicitly asked for TLS. An explicit
    // `secure` (true or false) always wins.
    const pastedTls = /^\s*(wss|https):\/\//i.test(options.host);
    const scheme = (options.secure ?? pastedTls) ? 'wss' : 'ws';
    const port = options.port || DEFAULT_PORTS[options.protocol];
    const host = sanitizeHost(options.host);
    const url = `${scheme}://${host}:${port}`;

    // Validate before handing to the runtime's WebSocket implementation.
    // Some platforms (React Native on Android via okhttp3) throw on the
    // native message-queue thread for malformed ports/hosts — there's no
    // JS-side handler for that, so the process dies. Catching here keeps
    // the failure inside the connection flow where the host can surface
    // it as a regular connection error.
    try {
      // eslint-disable-next-line no-new
      new URL(url);
    } catch {
      throw new Error(
        `Invalid connection URL "${url}" — check host and port. Hosts should not include "ws://" or ":port"; use the port field instead.`,
      );
    }

    try {
      await client.connect(url, connectOptions);
    } catch (err) {
      // Tear the client down on a failed connect so a rejected connect() can't
      // leave a background reconnect loop or an open socket behind — the manager
      // never stored this client, so the caller has no handle to clean it up.
      await client.disconnect().catch(() => {});
      throw err;
    }

    this.activeClient = client;
    this.activeOptions = options;

    return client;
  }

  /**
   * Disconnect the active client and forget it.
   */
  async disconnect(): Promise<void> {
    if (this.activeClient) {
      await this.activeClient.disconnect();
      this.activeClient = null;
      this.activeOptions = null;
    }
  }

  /**
   * Currently active client, or `null` if not connected.
   */
  getClient(): IProtocolClient | null {
    return this.activeClient;
  }

  /**
   * Currently active connection options, or `null` if not connected.
   */
  getOptions(): ConnectionOptions | null {
    return this.activeOptions;
  }

  private createClient(options: ConnectionOptions): IProtocolClient {
    switch (options.protocol) {
      case 'foxglove-ws':
        return new FoxgloveClient(this.clientOptions);
      case 'rosbridge':
        return new RosbridgeClient(this.clientOptions);
      case 'zenoh':
        throw new Error('Zenoh support is planned for v0.3.0');
      default: {
        const exhaustive: never = options.protocol;
        throw new Error(`Unknown protocol: ${String(exhaustive)}`);
      }
    }
  }
}
