// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * `ZenohSession`: one Zenoh client session over one link, tying the codec,
 * transport, network and reassembly modules together.
 *
 * The session never touches a socket. Its owner feeds each received binary
 * message to `receive` and gives it a `send` that writes one binary message
 * per batch. A session lives exactly as long as one link: reconnecting builds
 * a new one, so every table here (key ids, tokens, queries, reassembly) dies
 * with the object.
 *
 * Lease, both directions. The client promises the router a 10 s lease and
 * sends a KEEP_ALIVE whenever it has sent nothing for a quarter of it. The
 * router counts as gone after its own full lease with nothing received; the
 * session then sends CLOSE (EXPIRED) and ends. There is no handshake timer:
 * the owner's connect timeout governs the attempt.
 *
 * Callbacks must not throw. An exception from one escapes `receive` and the
 * rest of that batch is not read.
 *
 * @module
 */

import { randomBytes } from '../randomBytes';
import { ByteReader, ZenohProtocolError, vleLength } from './codec';
import {
  INTEREST_TOKENS,
  encodeDeclareSubscriber,
  encodeDeclareToken,
  encodeInterest,
  encodeInterestFinal,
  encodePut,
  encodeQuery,
  encodeUndeclareSubscriber,
  encodeUndeclareToken,
  isPushHeader,
  readNetworkMessage,
  readPushBody,
  resolveKey,
  skipPushBody,
  type Declaration,
  type Encoding,
  type NetworkMessage,
  type PushBody,
  type QueryTarget,
} from './network';
import { ChannelReassembler, type ReassemblyStats } from './reassembly';
import {
  CLOSE_REASON,
  FRAGMENT_HEADER_MAX,
  ZENOH_PROTOCOL_VERSION,
  encodeClose,
  encodeFragment,
  encodeFrame,
  encodeInitSyn,
  encodeKeepAlive,
  encodeOpenSyn,
  frameBodyContinues,
  readTransportMessage,
  type TransportMessage,
} from './transport';

/** The lease the client promises the router: Zenoh's own default. */
export const CLIENT_LEASE_MS = 10_000;

/** The client sends a KEEP_ALIVE after this long with nothing sent. */
const KEEP_ALIVE_MS = CLIENT_LEASE_MS / 4;

/** Our batch size, the most a u16 carries. The smaller of ours and the router's wins. */
const OUR_BATCH_SIZE = 0xffff;

/** Largest delay `setTimeout` arms without firing at once. */
const TIMER_MAX_MS = 2 ** 31 - 1;

const SN_MOD = 2 ** 32;

/** Why a session ended. Reported exactly once. */
export type SessionEnd =
  /**
   * A Zenoh CLOSE arrived. Before the session opens, reason 0 (GENERIC) can
   * mean the router requires a user and password, and reason 2 (INVALID) can
   * mean it speaks an older protocol (measured on 1.10.1 and 0.11.0 routers).
   * Neither reason names its cause on the wire; the router's log does.
   */
  | { kind: 'router-close'; reason: number }
  /** Nothing arrived from the router for its whole lease. */
  | { kind: 'lease-expired'; silentMs: number }
  | { kind: 'local-close' }
  /** Malformed or unsupported input. */
  | { kind: 'protocol-error'; message: string }
  /**
   * The router's InitAck named another protocol version; nothing more was
   * sent. A router that refuses our version without an InitAck ends the
   * session as `router-close` instead.
   */
  | { kind: 'version-mismatch'; ours: typeof ZENOH_PROTOCOL_VERSION; theirs: number };

/** A received PUT or DEL. */
export interface Sample {
  kind: 'put' | 'del';
  /** A view into the received batch, never copied; it stays valid after the callback returns. */
  payload: Uint8Array;
  attachment: Uint8Array | null;
  encoding: Encoding | null;
  /** The NTP64 time and the Zenoh id of the clock that stamped it. */
  timestamp: { time: bigint; zid: Uint8Array } | null;
  /** Whether it arrived on the reliable channel. */
  reliable: boolean;
}

/** What the session reports to its owner. */
export interface SessionCallbacks {
  /** The handshake finished. */
  onOpen(info: { routerZid: Uint8Array; routerLeaseMs: number; batchSize: number }): void;
  /** The session ended. Called exactly once; nothing is sent or received after it. */
  onClosed(cause: SessionEnd): void;
  /**
   * Asked with a PUSH's key before its payload is read; false skips the
   * payload unread. For a fragmented PUSH it is asked on the first fragment
   * and again when the message is whole, so it must have no side effects.
   */
  admitPush(key: string): boolean;
  /** An admitted PUSH. */
  onPush(key: string, sample: Sample): void;
  /** A liveliness token declared or undeclared. The key is known on undeclare too. */
  onToken(ev: { kind: 'declare' | 'undeclare'; key: string; interestId: number | null }): void;
  /** The router finished sending what exists now for an interest. */
  onDeclareFinal(interestId: number): void;
}

/** What one query reports. */
export interface QueryHandlers {
  onReply(key: string, sample: Sample): void;
  onError(payload: Uint8Array): void;
  /** No more replies. */
  onFinal(): void;
  /** The session ended with the query pending. Never followed or preceded by `onFinal`. */
  onSessionEnd(): void;
}

/** How the session reaches its link. */
export interface SessionOptions {
  /** Write one batch as one binary message. */
  send(batch: Uint8Array): void;
  /** The client's Zenoh id, 1 to 16 bytes; 16 random bytes by default. */
  zid?: Uint8Array;
  /** First sequence number on both channels; 0 by default. */
  initialSn?: number;
}

/** Counters for debugging. Not exposed publicly. */
export interface SessionStats {
  /** PUSH messages delivered. */
  admitted: number;
  /** PUSH messages whose payload was skipped unread. */
  skipped: number;
  reliable: ReassemblyStats;
  bestEffort: ReassemblyStats;
}

type State = 'idle' | 'init-sent' | 'open-sent' | 'open' | 'closed';

/** Per-reliability state: the next sequence number we send and the reassembler for what we receive. */
interface Channel {
  txSn: number;
  rx: ChannelReassembler;
}

/** One Zenoh client session. See the module comment. */
export class ZenohSession {
  private state: State = 'idle';
  private readonly zid: Uint8Array;
  private batchSize = OUR_BATCH_SIZE;
  private routerLeaseMs = 0;
  private routerZid: Uint8Array = new Uint8Array(0);
  private readonly channels: { reliable: Channel; bestEffort: Channel };
  private readonly routerKeys = new Map<number, string>();
  private readonly tokens = new Map<number, string>();
  private readonly declared = new Map<number, 'subscriber' | 'token'>();
  private readonly queries = new Map<number, QueryHandlers>();
  private nextDeclId = 1;
  private nextRid = 1;
  private nextInterestId = 1;
  private lastTxMs = 0;
  private lastRxMs = 0;
  private keepAliveTimer: ReturnType<typeof setTimeout> | null = null;
  private leaseTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly counts = { admitted: 0, skipped: 0 };

  /**
   * @param callbacks What the session reports.
   * @param options The link's `send`, and test overrides.
   */
  constructor(
    private readonly callbacks: SessionCallbacks,
    private readonly options: SessionOptions,
  ) {
    this.zid = options.zid ?? randomBytes(16);
    const sn = options.initialSn ?? 0;
    this.channels = {
      reliable: { txSn: sn, rx: new ChannelReassembler() },
      bestEffort: { txSn: sn, rx: new ChannelReassembler() },
    };
  }

  /** Send the InitSyn. */
  start(): void {
    if (this.state !== 'idle') return;
    this.state = 'init-sent';
    this.sendBatch(encodeInitSyn(this.zid));
  }

  /** Read one received batch. */
  receive(batch: Uint8Array): void {
    if (this.state === 'closed') return;
    this.lastRxMs = Date.now();
    try {
      if (this.state === 'idle') throw new ZenohProtocolError('input before the handshake started');
      const r = new ByteReader(batch);
      while (r.more() && this.isLive()) this.onTransport(readTransportMessage(r), r);
    } catch (e) {
      if (!(e instanceof ZenohProtocolError)) throw e;
      this.fail(e.message);
    }
  }

  /** Declare a subscriber on `key`. Returns its id, for `undeclare`. */
  declareSubscriber(key: string): number {
    const id = this.nextDeclId++;
    this.sendNetwork(encodeDeclareSubscriber(id, key));
    this.declared.set(id, 'subscriber');
    return id;
  }

  /** Declare a liveliness token on `key`. Returns its id, for `undeclare`. */
  declareToken(key: string): number {
    const id = this.nextDeclId++;
    this.sendNetwork(encodeDeclareToken(id, key));
    this.declared.set(id, 'token');
    return id;
  }

  /** Undeclare a subscriber or token this session declared. An unknown id sends nothing. */
  undeclare(id: number): void {
    const kind = this.declared.get(id);
    if (kind === undefined || this.state === 'closed') return;
    this.declared.delete(id);
    this.sendNetwork(
      kind === 'subscriber' ? encodeUndeclareSubscriber(id) : encodeUndeclareToken(id),
    );
  }

  /** Publish `payload` on `key`, reliable unless asked otherwise. */
  put(
    key: string,
    payload: Uint8Array,
    opts: { attachment?: Uint8Array; reliable?: boolean } = {},
  ): void {
    this.sendNetwork(encodePut(key, payload, opts.attachment), opts.reliable ?? true);
  }

  /**
   * Send a query. Returns its request id, for `forgetQuery`. On a session
   * that already ended, `onSessionEnd` runs before this returns.
   */
  query(
    key: string,
    opts: { payload?: Uint8Array; attachment?: Uint8Array; target: QueryTarget },
    handlers: QueryHandlers,
  ): number {
    const rid = this.nextRid;
    this.nextRid = (this.nextRid + 1) % SN_MOD;
    if (this.state === 'closed') {
      handlers.onSessionEnd();
      return rid;
    }
    this.sendNetwork(encodeQuery(rid, key, opts));
    this.queries.set(rid, handlers);
    return rid;
  }

  /** Stop routing replies for a query. Local only: a late reply is dropped. */
  forgetQuery(rid: number): void {
    this.queries.delete(rid);
  }

  /**
   * Ask for the liveliness tokens on `key`: what exists now, and with
   * `current-future` what comes later. Returns its id. The end of the
   * current phase arrives as `onDeclareFinal(id)`; the session keeps no
   * per-interest state, so an owner waiting on that final settles the wait
   * in `onClosed` if the session ends first.
   */
  interest(key: string, mode: 'current' | 'current-future'): number {
    const id = this.nextInterestId++;
    this.sendNetwork(encodeInterest(id, mode, key, INTEREST_TOKENS));
    return id;
  }

  /**
   * End an interest: the router stops sending its declarations. A D_FINAL
   * already in flight still reaches `onDeclareFinal`.
   */
  endInterest(id: number): void {
    this.sendNetwork(encodeInterestFinal(id));
  }

  /** Send CLOSE and end with `local-close`. */
  close(): void {
    if (this.state === 'closed') return;
    if (this.state !== 'idle') this.sendQuietly(encodeClose(CLOSE_REASON.GENERIC));
    this.end({ kind: 'local-close' });
  }

  /** When the session last sent and received, and the keepalive interval. */
  linkState(): { lastTxMs: number; lastRxMs: number; keepAliveMs: number } {
    return { lastTxMs: this.lastTxMs, lastRxMs: this.lastRxMs, keepAliveMs: KEEP_ALIVE_MS };
  }

  /** Counters since construction. */
  stats(): SessionStats {
    return {
      ...this.counts,
      reliable: this.channels.reliable.rx.stats(),
      bestEffort: this.channels.bestEffort.rx.stats(),
    };
  }

  // -------------------------------------------------------------------------
  // Receiving

  private isLive(): boolean {
    return this.state !== 'closed';
  }

  private onTransport(m: TransportMessage, r: ByteReader): void {
    const handler = this.transportHandlers[m.kind] as (m: TransportMessage, r: ByteReader) => void;
    handler(m, r);
  }

  private readonly transportHandlers: {
    [K in TransportMessage['kind']]: (
      m: Extract<TransportMessage, { kind: K }>,
      r: ByteReader,
    ) => void;
  } = {
    'init-ack': (m) => this.onInitAck(m),
    'init-ack-version': (m) => {
      this.expectState('init-sent', 'InitAck');
      this.end({ kind: 'version-mismatch', ours: ZENOH_PROTOCOL_VERSION, theirs: m.version });
    },
    'open-ack': (m) => this.onOpenAck(m.leaseMs),
    close: (m) => this.end({ kind: 'router-close', reason: m.reason }),
    'keep-alive': () => {},
    frame: (m, r) => this.onFrame(m.reliable, m.sn, r),
    fragment: (m) => this.onFragment(m),
    oam: () => {},
  };

  private expectState(state: State, what: string): void {
    if (this.state !== state) throw new ZenohProtocolError(`${what} outside the handshake`);
  }

  private onInitAck(m: Extract<TransportMessage, { kind: 'init-ack' }>): void {
    this.expectState('init-sent', 'InitAck');
    const batchSize = Math.min(OUR_BATCH_SIZE, m.batchSize);
    if (batchSize <= FRAGMENT_HEADER_MAX) {
      throw new ZenohProtocolError(`batch size ${batchSize} leaves no room for a fragment`);
    }
    this.batchSize = batchSize;
    this.routerZid = m.zid.slice();
    this.state = 'open-sent';
    this.sendBatch(encodeOpenSyn(CLIENT_LEASE_MS, this.channels.reliable.txSn, m.cookie));
  }

  private onOpenAck(leaseMs: number): void {
    this.expectState('open-sent', 'OpenAck');
    if (leaseMs <= 0 || leaseMs > TIMER_MAX_MS) {
      throw new ZenohProtocolError(`router lease of ${leaseMs} ms cannot be timed`);
    }
    this.routerLeaseMs = leaseMs;
    this.state = 'open';
    this.armKeepAlive(KEEP_ALIVE_MS - (Date.now() - this.lastTxMs));
    this.armLease(leaseMs);
    this.callbacks.onOpen({
      routerZid: this.routerZid,
      routerLeaseMs: leaseMs,
      batchSize: this.batchSize,
    });
  }

  private channel(reliable: boolean): Channel {
    return reliable ? this.channels.reliable : this.channels.bestEffort;
  }

  private expectOpen(what: string): void {
    if (this.state !== 'open') throw new ZenohProtocolError(`${what} before the session opened`);
  }

  private onFrame(reliable: boolean, sn: number, r: ByteReader): void {
    this.expectOpen('FRAME');
    this.channel(reliable).rx.frame(sn);
    while (frameBodyContinues(r) && this.isLive()) this.onNetwork(r, reliable);
  }

  private onFragment(m: Extract<TransportMessage, { kind: 'fragment' }>): void {
    this.expectOpen('FRAGMENT');
    const message = this.channel(m.reliable).rx.fragment(m, (chunk) => this.admitFirstChunk(chunk));
    if (message === null) return;
    const r = new ByteReader(message);
    this.onNetwork(r, m.reliable);
    if (r.more() && this.isLive()) {
      throw new ZenohProtocolError('trailing bytes after a reassembled message');
    }
  }

  /**
   * The drop-before-parse check on a fragmented message's first chunk. Only
   * a PUSH is asked about, and only its header is read. A header the chunk
   * cuts is admitted: the check runs again on the whole message, where a
   * malformed one fails.
   */
  private admitFirstChunk(chunk: Uint8Array): boolean {
    if (chunk.length === 0 || !isPushHeader(chunk[0]!)) return true;
    let key: string;
    try {
      const m = readNetworkMessage(new ByteReader(chunk));
      if (m.kind !== 'push') return true;
      key = resolveKey(m.wire, this.routerKeys);
    } catch (e) {
      if (e instanceof ZenohProtocolError) return true;
      throw e;
    }
    return this.callbacks.admitPush(key);
  }

  private onNetwork(r: ByteReader, reliable: boolean): void {
    const m = readNetworkMessage(r);
    switch (m.kind) {
      case 'push':
        return this.onPush(m, r, reliable);
      case 'response':
        return this.onResponse(m, reliable);
      case 'response-final':
        return this.onResponseFinal(m.rid);
      case 'declare':
        return this.onDeclaration(m.decl, m.interestId);
      default:
        // INTEREST from the router (it asks for our declarations, which we
        // send unasked) and network OAM.
        return;
    }
  }

  private onPush(
    m: Extract<NetworkMessage, { kind: 'push' }>,
    r: ByteReader,
    reliable: boolean,
  ): void {
    const key = resolveKey(m.wire, this.routerKeys);
    if (!this.callbacks.admitPush(key)) {
      skipPushBody(r);
      this.counts.skipped++;
      return;
    }
    const body = readPushBody(r);
    this.counts.admitted++;
    this.callbacks.onPush(key, sampleOf(body, reliable));
  }

  private onResponse(m: Extract<NetworkMessage, { kind: 'response' }>, reliable: boolean): void {
    const q = this.queries.get(m.rid);
    if (q === undefined) return;
    if (m.body.kind === 'err') {
      q.onError(m.body.payload);
      return;
    }
    q.onReply(resolveKey(m.wire, this.routerKeys), sampleOf(m.body.sample, reliable));
  }

  private onResponseFinal(rid: number): void {
    const q = this.queries.get(rid);
    if (q === undefined) return;
    this.queries.delete(rid);
    q.onFinal();
  }

  private onDeclaration(decl: Declaration, interestId: number | null): void {
    switch (decl.kind) {
      case 'd-keyexpr':
        this.routerKeys.set(decl.id, resolveKey(decl.wire, this.routerKeys));
        return;
      case 'u-keyexpr':
        this.routerKeys.delete(decl.id);
        return;
      case 'd-token':
        return this.onDeclareToken(decl.id, resolveKey(decl.wire, this.routerKeys), interestId);
      case 'u-token':
        return this.onUndeclareToken(
          decl.id,
          decl.wire === null ? null : resolveKey(decl.wire, this.routerKeys),
          interestId,
        );
      case 'd-final':
        return this.onDeclareFinal(interestId);
      default:
        // Subscribers and queryables the router declares: the client routes
        // nothing, so they carry nothing it needs.
        return;
    }
  }

  private onDeclareToken(id: number, key: string, interestId: number | null): void {
    this.tokens.set(id, key);
    this.callbacks.onToken({ kind: 'declare', key, interestId });
  }

  /**
   * The key comes from the U_TOKEN's own wire-expression extension when it
   * names one (rmw_zenohd's never does: it sends the null wire expression),
   * else from the token table. With neither, there is no key to report and
   * the undeclare is dropped.
   */
  private onUndeclareToken(id: number, wireKey: string | null, interestId: number | null): void {
    const key = wireKey ?? this.tokens.get(id) ?? null;
    if (key === null) return;
    this.tokens.delete(id);
    this.callbacks.onToken({ kind: 'undeclare', key, interestId });
  }

  private onDeclareFinal(interestId: number | null): void {
    if (interestId === null) return;
    this.callbacks.onDeclareFinal(interestId);
  }

  // -------------------------------------------------------------------------
  // Sending

  /** Write one batch, unless the session ended (the link's `send` may itself end it). */
  private sendBatch(batch: Uint8Array): void {
    if (!this.isLive()) return;
    this.lastTxMs = Date.now();
    this.options.send(batch);
  }

  private nextSn(ch: Channel): number {
    const sn = ch.txSn;
    ch.txSn = (ch.txSn + 1) % SN_MOD;
    return sn;
  }

  /**
   * Send one network message: a FRAME when it fits the batch, else
   * consecutive FRAGMENTs, each filling its batch. Ignored once the session
   * ended; a caller bug before it opened.
   */
  private sendNetwork(message: Uint8Array, reliable = true): void {
    if (this.state === 'closed') return;
    if (this.state !== 'open') throw new Error('Zenoh session not open');
    const ch = this.channel(reliable);
    if (1 + vleLength(ch.txSn) + message.length <= this.batchSize) {
      this.sendBatch(encodeFrame(reliable, this.nextSn(ch), message));
      return;
    }
    let off = 0;
    while (off < message.length && this.isLive()) {
      const sn = this.nextSn(ch);
      const end = Math.min(off + this.batchSize - 1 - vleLength(sn), message.length);
      this.sendBatch(
        encodeFragment(reliable, end < message.length, sn, message.subarray(off, end)),
      );
      off = end;
    }
  }

  // -------------------------------------------------------------------------
  // Timers and the end

  /**
   * Check for client silence after `delayMs`; send a KEEP_ALIVE if nothing
   * went out for the interval. A negative idle time means the wall clock
   * stepped back, so the silence is unknown and a KEEP_ALIVE goes out.
   */
  private armKeepAlive(delayMs: number): void {
    this.keepAliveTimer = setTimeout(
      () => {
        const idle = Date.now() - this.lastTxMs;
        const due = idle >= KEEP_ALIVE_MS || idle < 0;
        if (due) this.sendQuietly(encodeKeepAlive());
        if (!this.isLive()) return;
        this.armKeepAlive(due ? KEEP_ALIVE_MS : KEEP_ALIVE_MS - idle);
      },
      Math.max(0, delayMs),
    );
  }

  /**
   * Check for router silence after `delayMs`; expire the session after a
   * whole lease of it. A negative silence means the wall clock stepped back:
   * the count restarts from now, so expiry comes late, never early.
   */
  private armLease(delayMs: number): void {
    this.leaseTimer = setTimeout(() => {
      const silent = Date.now() - this.lastRxMs;
      if (silent < 0) this.lastRxMs = Date.now();
      if (silent < this.routerLeaseMs) {
        this.armLease(silent < 0 ? this.routerLeaseMs : this.routerLeaseMs - silent);
        return;
      }
      this.sendQuietly(encodeClose(CLOSE_REASON.EXPIRED));
      this.end({ kind: 'lease-expired', silentMs: silent });
    }, delayMs);
  }

  /**
   * Send a batch the session makes on its own (a KEEP_ALIVE from a timer, a
   * CLOSE on the way out). A `send` that throws here is ignored, so nothing
   * escapes a timer and the end still runs: the owner learns of a dead link
   * from its socket, and the router lease ends the session if it stays dead.
   */
  private sendQuietly(batch: Uint8Array): void {
    try {
      this.sendBatch(batch);
    } catch {
      // The link is gone; the owner's socket and `onClosed` report it.
    }
  }

  private fail(message: string): void {
    if (this.state === 'closed') return;
    if (this.state !== 'idle') this.sendQuietly(encodeClose(CLOSE_REASON.INVALID));
    this.end({ kind: 'protocol-error', message });
  }

  private end(cause: SessionEnd): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    if (this.keepAliveTimer !== null) clearTimeout(this.keepAliveTimer);
    if (this.leaseTimer !== null) clearTimeout(this.leaseTimer);
    this.keepAliveTimer = null;
    this.leaseTimer = null;
    const pending = [...this.queries.values()];
    this.queries.clear();
    for (const q of pending) q.onSessionEnd();
    this.callbacks.onClosed(cause);
  }
}

function sampleOf(body: PushBody, reliable: boolean): Sample {
  return { ...body, reliable };
}
