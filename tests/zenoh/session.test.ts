import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ByteReader, ByteWriter, ZenohProtocolError } from '../../src/zenoh/codec';
import {
  encodeDeclareSubscriber,
  encodeDeclareToken,
  encodePut,
  readNetworkMessage,
  readPushBody,
} from '../../src/zenoh/network';
import {
  ZenohSession,
  type QueryHandlers,
  type Sample,
  type SessionCallbacks,
  type SessionEnd,
} from '../../src/zenoh/session';
import { FRAGMENT_HEADER_MAX, readTransportMessage } from '../../src/zenoh/transport';

const hex = (u: Uint8Array): string =>
  Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (s: string): Uint8Array =>
  new Uint8Array((s.replace(/\s+/g, '').match(/../g) ?? []).map((b) => parseInt(b, 16)));
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const w = new ByteWriter(64);
  for (const p of parts) w.raw(p);
  return w.finish().slice();
};
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const ZID = fromHex('00112233445566778899aabbccddeeff');
const ROUTER_ZID = '25a1b64d49bc0428e79421ed9175d2db';
const COOKIE = 'c0ffee';

// ---------------------------------------------------------------------------
// Router-side bytes, written by hand from the layouts in `transport.ts` and
// `network.ts`.

/** InitAck, version 9, router, 16-byte zid. With `batch`, the S flag and 32/32 resolution. */
function initAck(opts: { batch?: number; version?: number } = {}): Uint8Array {
  const w = new ByteWriter(64).u8(opts.batch === undefined ? 0x21 : 0x61);
  w.u8(opts.version ?? 0x09)
    .u8(0xf0)
    .raw(fromHex(ROUTER_ZID));
  if (opts.batch !== undefined)
    w.u8(0x0a)
      .u8(opts.batch & 0xff)
      .u8(opts.batch >> 8);
  return w.bytes(fromHex(COOKIE)).finish().slice();
}

/** OpenAck with the lease in seconds (T set) or milliseconds. */
function openAck(lease: number, inSeconds = true): Uint8Array {
  return new ByteWriter(16)
    .u8(0x22 | (inSeconds ? 0x40 : 0))
    .vle(lease)
    .vle(0)
    .finish()
    .slice();
}

function frame(reliable: boolean, sn: number, ...messages: Uint8Array[]): Uint8Array {
  return concat(
    new ByteWriter(8)
      .u8(reliable ? 0x25 : 0x05)
      .vle(sn)
      .finish(),
    ...messages,
  );
}

function fragment(
  reliable: boolean,
  sn: number,
  more: boolean,
  chunk: Uint8Array,
  marker?: 'first' | 'drop',
): Uint8Array {
  const h = 0x06 | (reliable ? 0x20 : 0) | (more ? 0x40 : 0) | (marker ? 0x80 : 0);
  const w = new ByteWriter(8 + chunk.length).u8(h).vle(sn);
  if (marker === 'first') w.u8(0x02); // unit extension, id 2
  if (marker === 'drop') w.u8(0x03); // unit extension, id 3
  return w.raw(chunk).finish().slice();
}

/** PUSH of a PUT whose key is `scope` (a router key id) plus `suffix`, M set. */
function scopedPut(scope: number, suffix: string, payload: Uint8Array): Uint8Array {
  return new ByteWriter(64)
    .u8(0x1d | 0x20 | 0x40)
    .vle(scope)
    .str(suffix)
    .u8(0x01)
    .bytes(payload)
    .finish()
    .slice();
}

function dKeyexpr(id: number, key: string): Uint8Array {
  return new ByteWriter(32)
    .u8(0x1e)
    .u8(0x00 | 0x20)
    .vle(id)
    .vle(0)
    .str(key)
    .finish()
    .slice();
}

function dToken(id: number, key: string, interestId?: number): Uint8Array {
  const w = new ByteWriter(32).u8(0x1e | (interestId === undefined ? 0 : 0x20));
  if (interestId !== undefined) w.vle(interestId);
  return w
    .u8(0x06 | 0x20)
    .vle(id)
    .vle(0)
    .str(key)
    .finish()
    .slice();
}

function uToken(id: number): Uint8Array {
  return new ByteWriter(8).u8(0x1e).u8(0x07).vle(id).finish().slice();
}

function dFinal(interestId: number): Uint8Array {
  return new ByteWriter(8)
    .u8(0x1e | 0x20)
    .vle(interestId)
    .u8(0x1a)
    .finish()
    .slice();
}

function reply(rid: number, key: string, payload: Uint8Array): Uint8Array {
  return new ByteWriter(64)
    .u8(0x1b | 0x20)
    .vle(rid)
    .vle(0)
    .str(key)
    .u8(0x04)
    .u8(0x01)
    .bytes(payload)
    .finish()
    .slice();
}

function replyErr(rid: number, key: string, payload: Uint8Array): Uint8Array {
  return new ByteWriter(64)
    .u8(0x1b | 0x20)
    .vle(rid)
    .vle(0)
    .str(key)
    .u8(0x05)
    .bytes(payload)
    .finish()
    .slice();
}

function responseFinal(rid: number): Uint8Array {
  return new ByteWriter(8).u8(0x1a).vle(rid).finish().slice();
}

// ---------------------------------------------------------------------------
// Harness

interface Harness {
  session: ZenohSession;
  sent: Uint8Array[];
  pushes: { key: string; sample: Sample }[];
  admitted: string[];
  tokens: { kind: string; key: string; interestId: number | null }[];
  finals: number[];
  ends: SessionEnd[];
  opens: { routerZid: Uint8Array; routerLeaseMs: number; batchSize: number }[];
  admit: (key: string) => boolean;
}

function harness(opts: { initialSn?: number } = {}): Harness {
  const h: Partial<Harness> = {
    sent: [],
    pushes: [],
    admitted: [],
    tokens: [],
    finals: [],
    ends: [],
    opens: [],
    admit: () => true,
  };
  const callbacks: SessionCallbacks = {
    onOpen: (info) => h.opens!.push(info),
    onClosed: (cause) => h.ends!.push(cause),
    admitPush: (key) => {
      h.admitted!.push(key);
      return h.admit!(key);
    },
    onPush: (key, sample) => h.pushes!.push({ key, sample }),
    onToken: (ev) => h.tokens!.push(ev),
    onDeclareFinal: (id) => h.finals!.push(id),
  };
  h.session = new ZenohSession(callbacks, {
    send: (batch) => h.sent!.push(batch.slice()),
    zid: ZID,
    ...(opts.initialSn === undefined ? {} : { initialSn: opts.initialSn }),
  });
  return h as Harness;
}

/** A session through the handshake, with the router's lease in seconds. */
function opened(opts: { batch?: number; leaseS?: number; initialSn?: number } = {}): Harness {
  const h = harness(opts);
  h.session.start();
  h.session.receive(initAck(opts.batch === undefined ? {} : { batch: opts.batch }));
  h.session.receive(openAck(opts.leaseS ?? 60));
  h.sent.length = 0;
  return h;
}

/** The network messages inside one sent FRAME batch. */
function sentFrame(batch: Uint8Array): { reliable: boolean; sn: number; body: Uint8Array } {
  const r = new ByteReader(batch);
  const m = readTransportMessage(r);
  if (m.kind !== 'frame') throw new Error(`expected a FRAME, got ${m.kind}`);
  return { reliable: m.reliable, sn: m.sn, body: r.rest() };
}

function queryHandlers(): QueryHandlers & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    onReply: (key, sample) => log.push(`reply ${key} ${hex(sample.payload)}`),
    onError: (payload) => log.push(`err ${hex(payload)}`),
    onFinal: () => log.push('final'),
    onSessionEnd: () => log.push('session-end'),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('handshake', () => {
  it('sends the 22-byte InitSyn on start, then the OpenSyn echoing the cookie', () => {
    const h = harness();
    h.session.start();
    expect(h.sent.map(hex)).toEqual(['4109f2' + hex(ZID) + '0affff']);
    h.session.receive(initAck());
    // OPEN, lease 10,000 ms as a VLE (90 4e), initial sn 0, cookie.
    expect(hex(h.sent[1]!)).toBe('02904e0003' + COOKIE);
    expect(h.opens).toHaveLength(0);
  });

  it('opens on the OpenAck with the router zid, its lease and the batch size', () => {
    const h = harness();
    h.session.start();
    h.session.receive(initAck({ batch: 0x2000 }));
    h.session.receive(openAck(60));
    expect(h.opens).toEqual([
      { routerZid: fromHex(ROUTER_ZID), routerLeaseMs: 60_000, batchSize: 0x2000 },
    ]);
  });

  it('reads a lease in milliseconds when T is clear', () => {
    const h = harness();
    h.session.start();
    h.session.receive(initAck());
    h.session.receive(openAck(7_500, false));
    expect(h.opens[0]!.routerLeaseMs).toBe(7_500);
  });

  it('keeps our batch size when the router offers a larger one', () => {
    const h = opened();
    expect(h.opens[0]!.batchSize).toBe(65_535);
  });

  it('sends the initial sequence number it was given in the OpenSyn', () => {
    const h = harness({ initialSn: 300 });
    h.session.start();
    h.session.receive(initAck());
    expect(hex(h.sent[1]!)).toBe('02904eac0203' + COOKIE);
  });

  it('generates a 16-byte zid when none is given', () => {
    const sent: Uint8Array[] = [];
    const s = new ZenohSession(
      {
        onOpen() {},
        onClosed() {},
        admitPush: () => true,
        onPush() {},
        onToken() {},
        onDeclareFinal() {},
      },
      { send: (b) => sent.push(b.slice()) },
    );
    s.start();
    expect(sent[0]).toHaveLength(22);
  });

  it.each([0, FRAGMENT_HEADER_MAX])(
    'refuses a batch size of %i, which leaves no room for a fragment',
    (batch) => {
      const h = harness();
      h.session.start();
      h.session.receive(initAck({ batch }));
      expect(h.ends).toEqual([
        { kind: 'protocol-error', message: expect.stringContaining('batch') },
      ]);
      expect(hex(h.sent.at(-1)!)).toBe('2302');
    },
  );

  it('accepts the smallest batch size that fits a fragment header and one byte', () => {
    const h = harness();
    h.session.start();
    h.session.receive(initAck({ batch: FRAGMENT_HEADER_MAX + 1 }));
    h.session.receive(openAck(60));
    expect(h.ends).toEqual([]);
    expect(h.opens[0]!.batchSize).toBe(FRAGMENT_HEADER_MAX + 1);
  });

  it.each([
    [0, false],
    [2 ** 31, false],
    [3_000_000, true], // 3,000,000 s is past 2^31 - 1 ms
  ])('refuses a router lease of %i (seconds: %s), which setTimeout cannot arm', (lease, inS) => {
    const h = harness();
    h.session.start();
    h.session.receive(initAck());
    h.session.receive(openAck(lease, inS));
    expect(h.opens).toEqual([]);
    expect(h.ends).toEqual([{ kind: 'protocol-error', message: expect.stringContaining('lease') }]);
  });

  it('accepts a router lease of 2^31 - 1 ms', () => {
    const h = harness();
    h.session.start();
    h.session.receive(initAck());
    h.session.receive(openAck(2 ** 31 - 1, false));
    expect(h.opens).toHaveLength(1);
  });

  it('refuses an InitAck that arrives after the session opened', () => {
    const h = opened();
    h.session.receive(initAck());
    expect(h.ends).toEqual([{ kind: 'protocol-error', message: expect.any(String) }]);
  });

  it('refuses a FRAME before the session opened', () => {
    const h = harness();
    h.session.start();
    h.session.receive(frame(true, 0, encodePut('a', utf8('x'))));
    expect(h.ends).toEqual([{ kind: 'protocol-error', message: expect.any(String) }]);
  });

  it('refuses input before start', () => {
    const h = harness();
    h.session.receive(initAck());
    expect(h.ends).toEqual([{ kind: 'protocol-error', message: expect.any(String) }]);
    expect(h.sent).toEqual([]);
  });
});

describe('version', () => {
  it('ends with version-mismatch on a version-8 InitAck and sends nothing more', () => {
    const h = harness();
    h.session.start();
    h.session.receive(initAck({ version: 0x08 }));
    expect(h.ends).toEqual([{ kind: 'version-mismatch', ours: 9, theirs: 8 }]);
    expect(h.sent).toHaveLength(1); // the InitSyn alone
  });
});

describe('close', () => {
  it('sends CLOSE GENERIC and reports local-close once', () => {
    const h = opened();
    h.session.close();
    h.session.close();
    expect(h.sent.map(hex)).toEqual(['2300']);
    expect(h.ends).toEqual([{ kind: 'local-close' }]);
  });

  it('reports a router CLOSE with its reason and sends nothing back', () => {
    const h = opened();
    h.session.receive(fromHex('2300'));
    expect(h.ends).toEqual([{ kind: 'router-close', reason: 0 }]);
    expect(h.sent).toEqual([]);
  });

  it('sends CLOSE INVALID before ending on a protocol error', () => {
    const h = opened();
    h.session.receive(fromHex('1f')); // a network id outside a FRAME
    expect(h.sent.map(hex)).toEqual(['2302']);
    expect(h.ends).toEqual([{ kind: 'protocol-error', message: expect.any(String) }]);
  });

  it('ignores input and sends after it ended', () => {
    const h = opened();
    h.session.close();
    h.sent.length = 0;
    h.session.receive(frame(true, 0, encodePut('a', utf8('x'))));
    h.session.put('a', utf8('x'));
    h.session.undeclare(1);
    expect(h.pushes).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(h.ends).toHaveLength(1);
  });

  it('refuses a send before the session opened', () => {
    const h = harness();
    h.session.start();
    expect(() => h.session.put('a', utf8('x'))).toThrow(/not open/);
  });

  it('records no declaration that failed to send before open', () => {
    const h = harness();
    h.session.start();
    expect(() => h.session.declareSubscriber('a')).toThrow(/not open/);
    h.session.receive(initAck());
    h.session.receive(openAck(60));
    h.sent.length = 0;
    h.session.undeclare(1);
    expect(h.sent).toEqual([]);
  });

  it('sends nothing more and arms no timer when send closes the session', () => {
    const h = opened({ batch: 0x1000 });
    const send = h.sent.push.bind(h.sent);
    h.sent.push = (...b: Uint8Array[]) => {
      const n = send(...b);
      if (h.sent.length === 1) h.session.close();
      return n;
    };
    h.session.put('k', new Uint8Array(3 * 0x1000)); // four fragments
    expect(h.sent).toHaveLength(2); // the first fragment, then the CLOSE
    expect(hex(h.sent[1]!)).toBe('2300');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('arms no keepalive after a keepalive send closes the session', () => {
    const h = opened();
    const send = h.sent.push.bind(h.sent);
    h.sent.push = (...b: Uint8Array[]) => {
      const n = send(...b);
      if (hex(b[0]!) === '04') h.session.close();
      return n;
    };
    vi.advanceTimersByTime(2_500);
    expect(h.sent.map(hex)).toEqual(['04', '2300']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['close()', (h: Harness) => h.session.close(), 'local-close'],
    ['a protocol error', (h: Harness) => h.session.receive(fromHex('1f')), 'protocol-error'],
    ['the lease', () => vi.advanceTimersByTime(60_000), 'lease-expired'],
  ])('ends after %s even when sending the CLOSE throws', (_, end, kind) => {
    const h = opened();
    const q = queryHandlers();
    h.session.query('svc', { target: 'best-matching' }, q);
    h.sent.push = () => {
      throw new Error('socket gone');
    };
    end(h);
    expect(h.ends.map((e) => e.kind)).toEqual([kind]);
    expect(q.log).toEqual(['session-end']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops every timer when it ends', () => {
    const h = opened();
    h.session.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('sending', () => {
  it('sends each network message in its own reliable FRAME with consecutive sequence numbers', () => {
    const h = opened();
    const sub = h.session.declareSubscriber('17/chatter/**');
    const tok = h.session.declareToken('@ros2_lv/17/x');
    expect(sub).not.toBe(tok);
    expect(h.sent.map(hex)).toEqual([
      '2500' + hex(encodeDeclareSubscriber(sub, '17/chatter/**')),
      '2501' + hex(encodeDeclareToken(tok, '@ros2_lv/17/x')),
    ]);
  });

  it('keeps a separate sequence number per reliability', () => {
    const h = opened();
    h.session.put('a', utf8('1'));
    h.session.put('a', utf8('2'), { reliable: false });
    h.session.put('a', utf8('3'), { reliable: false });
    h.session.put('a', utf8('4'));
    expect(h.sent.map((b) => [sentFrame(b).reliable, sentFrame(b).sn])).toEqual([
      [true, 0],
      [false, 0],
      [false, 1],
      [true, 1],
    ]);
  });

  it('sends a PUT with its attachment', () => {
    const h = opened();
    h.session.put('k', utf8('v'), { attachment: fromHex('0102') });
    expect(hex(sentFrame(h.sent[0]!).body)).toBe(hex(encodePut('k', utf8('v'), fromHex('0102'))));
  });

  it('undeclares a subscriber and a token by their own kind', () => {
    const h = opened();
    const sub = h.session.declareSubscriber('a');
    const tok = h.session.declareToken('b');
    h.sent.length = 0;
    h.session.undeclare(sub);
    h.session.undeclare(tok);
    h.session.undeclare(999); // unknown: nothing sent
    const decls = h.sent.map((b) => sentFrame(b).body);
    expect(decls.map((d) => hex(d.subarray(1, 2)))).toEqual(['03', '07']);
    expect(h.sent).toHaveLength(2);
  });
});

describe('send-side fragmentation', () => {
  function reassembleInto(sent: Uint8Array[]): Sample[] {
    const b = opened();
    for (const batch of sent) b.session.receive(batch);
    expect(b.ends).toEqual([]);
    return b.pushes.map((p) => p.sample);
  }

  it('splits a 2 MB PUT into fragments no larger than the batch, and they reassemble', () => {
    const h = opened({ batch: 0x2000 });
    const payload = new Uint8Array(2 * 1024 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) & 0xff;
    h.session.put('rmb_test/big', payload);

    expect(h.sent.length).toBeGreaterThan((2 * 1024 * 1024) / 0x2000);
    const headers = h.sent.map((b) => {
      expect(b.length).toBeLessThanOrEqual(0x2000);
      const m = readTransportMessage(new ByteReader(b));
      if (m.kind !== 'fragment') throw new Error(m.kind);
      return m;
    });
    headers.forEach((m, i) => {
      expect(m.sn).toBe(i);
      expect(m.more).toBe(i < headers.length - 1);
      expect(m.reliable).toBe(true);
      expect(m.first).toBe(false);
    });
    // Every fragment but the last fills the batch.
    expect(h.sent.slice(0, -1).every((b) => b.length === 0x2000)).toBe(true);

    const [sample] = reassembleInto(h.sent);
    // Not toEqual: it walks 2 MB element by element, about 3.5 s on a fast
    // machine and past the 5 s default timeout on CI runners. -1 means every
    // byte matches.
    expect(sample!.payload.length).toBe(payload.length);
    expect(sample!.payload.findIndex((v, i) => v !== payload[i])).toBe(-1);
  });

  it('wraps sequence numbers at 2^32', () => {
    const h = opened({ batch: 0x1000, initialSn: 2 ** 32 - 2 });
    h.session.put('k', new Uint8Array(3 * 0x1000));
    const sns = h.sent.map((b) => {
      const m = readTransportMessage(new ByteReader(b));
      return m.kind === 'fragment' ? m.sn : -1;
    });
    expect(sns).toEqual([2 ** 32 - 2, 2 ** 32 - 1, 0, 1]);
    h.session.put('k', utf8('after'));
    expect(sentFrame(h.sent.at(-1)!).sn).toBe(2);
  });

  it('sends a message that exactly fills the batch as one FRAME, one byte more as fragments', () => {
    const h = opened({ batch: 0x1000 });
    // FRAME header at sn 0 is 2 bytes. encodePut('k', empty) is 6 bytes, the
    // last a 1-byte length; a 4 KB payload's length takes 2.
    const fill = 0x1000 - 2 - (encodePut('k', new Uint8Array(0)).length - 1) - 2;
    h.session.put('k', new Uint8Array(fill));
    expect(h.sent.map((b) => b.length)).toEqual([0x1000]);
    expect(sentFrame(h.sent[0]!).sn).toBe(0);
    h.session.put('k', new Uint8Array(fill + 1));
    expect(h.sent.map((b) => b.length)).toEqual([0x1000, 0x1000, 3]);
  });
});

describe('receiving pushes', () => {
  it('delivers a PUSH with the reliability of its FRAME', () => {
    const h = opened();
    h.session.receive(frame(false, 0, encodePut('a/b', utf8('hi'), fromHex('aa'))));
    expect(h.pushes).toHaveLength(1);
    const { key, sample } = h.pushes[0]!;
    expect(key).toBe('a/b');
    expect(sample).toMatchObject({
      kind: 'put',
      payload: utf8('hi'),
      attachment: fromHex('aa'),
      encoding: null,
      timestamp: null,
      reliable: false,
    });
  });

  it('reads two PUSH in one FRAME and two transport messages in one batch', () => {
    const h = opened();
    h.session.receive(
      concat(
        frame(true, 0, encodePut('a', utf8('1')), encodePut('b', utf8('2'))),
        fromHex('04'),
        frame(true, 1, encodePut('c', utf8('3'))),
      ),
    );
    expect(h.pushes.map((p) => p.key)).toEqual(['a', 'b', 'c']);
  });

  it('keeps payload views valid after the callback returns', () => {
    const h = opened();
    const batch = frame(true, 0, encodePut('a', utf8('keep')));
    h.session.receive(batch);
    h.session.receive(frame(true, 1, encodePut('a', utf8('next'))));
    expect(h.pushes[0]!.sample.payload).toEqual(utf8('keep'));
  });

  it('reads one batch holding a reliable, a best-effort and a reliable FRAME', () => {
    const h = opened();
    const big = new Uint8Array(100).fill(7);
    const msg = encodePut('m', big);
    // A partial reliable fragment (a FRAGMENT runs to the end of its batch), then
    // one batch of FRAMEs: rule 5 resets each channel on its own.
    h.session.receive(fragment(true, 0, true, msg.subarray(0, 40)));
    const batch = concat(
      frame(true, 1, encodePut('r1', utf8('a'))),
      frame(false, 0, encodePut('b1', utf8('b'))),
      frame(true, 2, encodePut('r2', utf8('c'))),
    );
    h.session.receive(batch);
    expect(h.pushes.map((p) => [p.key, p.sample.reliable])).toEqual([
      ['r1', true],
      ['b1', false],
      ['r2', true],
    ]);
    // The reliable fragment's tail now arrives at sn 1: a gap after the FRAMEs, so skipped.
    h.session.receive(fragment(true, 1, false, msg.subarray(40)));
    expect(h.pushes).toHaveLength(3);
    expect(h.ends).toEqual([]);
  });

  it('red control: the same batch read as one FRAME fails', () => {
    const batch = concat(
      frame(true, 1, encodePut('r1', utf8('a'))),
      frame(false, 0, encodePut('b1', utf8('b'))),
    );
    const r = new ByteReader(batch);
    readTransportMessage(r);
    readNetworkMessage(r);
    readPushBody(r);
    expect(() => readNetworkMessage(r)).toThrow(ZenohProtocolError);
  });
});

describe('receiving fragments', () => {
  const payload = new Uint8Array(300).map((_, i) => i & 0xff);
  const msg = encodePut('big', payload);
  const parts = [msg.subarray(0, 100), msg.subarray(100, 200), msg.subarray(200)];

  it('reassembles a fragmented PUSH and parses it as one message', () => {
    const h = opened();
    parts.forEach((p, i) => h.session.receive(fragment(true, i, i < 2, p)));
    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0]!.sample.payload).toEqual(payload);
  });

  it('lost middle fragment: one message fewer, no garbage, the next one arrives', () => {
    const h = opened();
    h.session.receive(fragment(true, 0, true, parts[0]!));
    h.session.receive(fragment(true, 2, false, parts[2]!));
    h.session.receive(frame(true, 3, encodePut('next', utf8('ok'))));
    expect(h.pushes.map((p) => p.key)).toEqual(['next']);
    expect(h.ends).toEqual([]);
  });

  it('a First marker mid-message starts a new one', () => {
    const h = opened();
    h.session.receive(fragment(true, 0, true, parts[0]!));
    parts.forEach((p, i) =>
      h.session.receive(fragment(true, 1 + i, i < 2, p, i === 0 ? 'first' : undefined)),
    );
    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0]!.sample.payload).toEqual(payload);
  });

  it('a Drop marker discards the partial message', () => {
    const h = opened();
    h.session.receive(fragment(true, 0, true, parts[0]!));
    h.session.receive(fragment(true, 1, false, new Uint8Array(0), 'drop'));
    parts.forEach((p, i) => h.session.receive(fragment(true, 2 + i, i < 2, p)));
    expect(h.pushes).toHaveLength(1);
  });

  it('a FRAME between fragments drops the partial message', () => {
    const h = opened();
    h.session.receive(fragment(true, 0, true, parts[0]!));
    h.session.receive(frame(true, 1, encodePut('mid', utf8('x'))));
    parts.forEach((p, i) => h.session.receive(fragment(true, 2 + i, i < 2, p)));
    // The old head is not glued to the new message.
    expect(h.pushes.map((p) => p.key)).toEqual(['mid', 'big']);
    expect(h.pushes[1]!.sample.payload).toEqual(payload);
  });

  it('reassembles a fragmented query reply without asking admitPush', () => {
    const h = opened();
    const q = queryHandlers();
    const rid = h.session.query('svc', { target: 'best-matching' }, q);
    const body = new Uint8Array(300).fill(0xab);
    const msg = reply(rid, 'svc', body);
    h.session.receive(fragment(true, 0, true, msg.subarray(0, 50)));
    h.session.receive(fragment(true, 1, false, msg.subarray(50)));
    expect(h.ends).toEqual([]);
    expect(q.log).toEqual([`reply svc ${hex(body)}`]);
    expect(h.admitted).toEqual([]);
  });

  it('admits a PUSH whose header the first fragment cuts, and decides when it is whole', () => {
    const h = opened();
    const long = 'k/' + 'x'.repeat(200);
    const m = encodePut(long, utf8('v'));
    h.session.receive(fragment(true, 0, true, m.subarray(0, 20)));
    h.session.receive(fragment(true, 1, false, m.subarray(20)));
    expect(h.ends).toEqual([]);
    expect(h.pushes.map((p) => p.key)).toEqual([long]);
    expect(h.admitted).toEqual([long]);
  });

  it('a reassembled message with trailing bytes is a protocol error', () => {
    const h = opened();
    const padded = concat(msg, fromHex('00'));
    h.session.receive(fragment(true, 0, true, padded.subarray(0, 150)));
    h.session.receive(fragment(true, 1, false, padded.subarray(150)));
    expect(h.ends).toEqual([
      { kind: 'protocol-error', message: expect.stringContaining('trailing') },
    ]);
  });
});

describe('drop before parse', () => {
  function bigPut(key: string, fill: number): Uint8Array {
    return encodePut(key, new Uint8Array(5000).fill(fill));
  }

  function fragments(start: number, message: Uint8Array, size = 1000): Uint8Array[] {
    const out: Uint8Array[] = [];
    for (let off = 0, i = 0; off < message.length; off += size, i++) {
      const end = Math.min(off + size, message.length);
      out.push(fragment(true, start + i, end < message.length, message.subarray(off, end)));
    }
    return out;
  }

  it('never delivers a refused PUSH and still reads the next message in the FRAME', () => {
    const h = opened();
    h.admit = (key) => key !== 'big';
    h.session.receive(frame(true, 0, bigPut('big', 1), encodePut('small', utf8('s'))));
    expect(h.pushes.map((p) => p.key)).toEqual(['small']);
    expect(h.session.stats()).toMatchObject({ admitted: 1, skipped: 1 });
  });

  it('planted check: garbage in a refused payload changes nothing', () => {
    const run = (garble: boolean): string[] => {
      const h = opened();
      h.admit = (key) => key !== 'big';
      const refused = bigPut('big', 1);
      if (garble) refused.fill(0xff, refused.length - 5000); // the payload bytes, not the length
      h.session.receive(frame(true, 0, refused, encodePut('small', utf8('s'))));
      expect(h.ends).toEqual([]);
      return h.pushes.map((p) => `${p.key}:${hex(p.sample.payload)}`);
    };
    expect(run(true)).toEqual(run(false));
  });

  it('refuses a fragmented PUSH from its first fragment and allocates no buffer', () => {
    const h = opened();
    h.admit = (key) => key !== 'big';
    for (const f of fragments(0, bigPut('big', 2))) h.session.receive(f);
    h.session.receive(frame(true, 5, encodePut('small', utf8('s'))));
    expect(h.pushes.map((p) => p.key)).toEqual(['small']);
    expect(h.admitted.filter((k) => k === 'big')).toHaveLength(1);
    expect(h.session.stats().reliable).toMatchObject({ refused: 1, buffersAllocated: 0 });
  });

  it('planted check: garbage after the first fragment of a refused message changes nothing', () => {
    const run = (garble: boolean): string[] => {
      const h = opened();
      h.admit = (key) => key !== 'big';
      const fs = fragments(0, bigPut('big', 2));
      if (garble) for (const f of fs.slice(1)) f.fill(0xee, 2);
      for (const f of fs) h.session.receive(f);
      h.session.receive(frame(true, fs.length, encodePut('small', utf8('s'))));
      expect(h.ends).toEqual([]);
      return h.pushes.map((p) => p.key);
    };
    expect(run(true)).toEqual(run(false));
  });

  it('asks again when an admitted fragmented PUSH completes, and drops it if refused then', () => {
    const h = opened();
    let allow = true;
    h.admit = () => allow;
    const fs = fragments(0, bigPut('big', 3));
    h.session.receive(fs[0]!);
    allow = false;
    for (const f of fs.slice(1)) h.session.receive(f);
    expect(h.pushes).toEqual([]);
    expect(h.ends).toEqual([]);
  });
});

describe('key ids', () => {
  it('resolves a scoped PUSH against the router D_KEYEXPR table', () => {
    const h = opened();
    h.session.receive(frame(true, 0, dKeyexpr(5, '17/chatter'), scopedPut(5, '/x', utf8('v'))));
    expect(h.pushes.map((p) => p.key)).toEqual(['17/chatter/x']);
  });

  it('ends with protocol-error on a scope the router never declared', () => {
    const h = opened();
    h.session.receive(frame(true, 0, scopedPut(9, '/x', utf8('v'))));
    expect(h.ends).toEqual([{ kind: 'protocol-error', message: expect.stringContaining('scope') }]);
    expect(h.pushes).toEqual([]);
  });

  it('forgets a key id on U_KEYEXPR', () => {
    const h = opened();
    const uKeyexpr = new ByteWriter(8).u8(0x1e).u8(0x01).vle(5).finish().slice();
    h.session.receive(frame(true, 0, dKeyexpr(5, 'a'), uKeyexpr, scopedPut(5, '/x', utf8('v'))));
    expect(h.ends).toEqual([{ kind: 'protocol-error', message: expect.any(String) }]);
  });
});

describe('tokens and interests', () => {
  it('reports the key on undeclare too, from the token table', () => {
    const h = opened();
    h.session.receive(frame(true, 0, dToken(4, '@ros2_lv/17/a', 1)));
    h.session.receive(frame(true, 1, uToken(4)));
    expect(h.tokens).toEqual([
      { kind: 'declare', key: '@ros2_lv/17/a', interestId: 1 },
      { kind: 'undeclare', key: '@ros2_lv/17/a', interestId: null },
    ]);
  });

  it('ignores an undeclare of a token it never saw', () => {
    const h = opened();
    h.session.receive(frame(true, 0, uToken(4)));
    expect(h.tokens).toEqual([]);
    expect(h.ends).toEqual([]);
  });

  it('prefers the key a U_TOKEN carries over the table entry for its id', () => {
    const h = opened();
    h.session.receive(frame(true, 0, dToken(0, 'b/y', 2)));
    const ext = concat(fromHex('01 00'), utf8('a/x'));
    const u = new ByteWriter(32)
      .u8(0x1e)
      .u8(0x07 | 0x80)
      .vle(0)
      .u8(0x5f)
      .bytes(ext)
      .finish();
    h.session.receive(frame(true, 1, u.slice()));
    expect(h.tokens.at(-1)).toEqual({ kind: 'undeclare', key: 'a/x', interestId: null });
  });

  it('reports an unseen token undeclare by the key its wire-expression extension names', () => {
    const h = opened();
    // U_TOKEN with Z: ZBuf extension 0x0f, mandatory (0x5f), holding flags N, scope 0, suffix.
    const ext = concat(fromHex('01 00'), utf8('@ros2_lv/17/n'));
    const u = new ByteWriter(32)
      .u8(0x1e)
      .u8(0x07 | 0x80)
      .vle(4)
      .u8(0x5f)
      .bytes(ext)
      .finish();
    h.session.receive(frame(true, 0, u.slice()));
    expect(h.tokens).toEqual([{ kind: 'undeclare', key: '@ros2_lv/17/n', interestId: null }]);
  });

  it('sends an INTEREST and reports its D_FINAL by id', () => {
    const h = opened();
    const id = h.session.interest('@ros2_lv/17/**', 'current-future');
    const body = sentFrame(h.sent[0]!).body;
    expect(readNetworkMessage(new ByteReader(body))).toEqual({
      kind: 'interest',
      id,
      mode: 'current-future',
    });
    h.session.receive(frame(true, 0, dFinal(id)));
    expect(h.finals).toEqual([id]);
  });

  it('ends an interest with INTEREST Final', () => {
    const h = opened();
    const id = h.session.interest('k', 'current');
    h.sent.length = 0;
    h.session.endInterest(id);
    expect(readNetworkMessage(new ByteReader(sentFrame(h.sent[0]!).body))).toEqual({
      kind: 'interest',
      id,
      mode: 'final',
    });
  });
});

describe('queries', () => {
  it('routes replies, errors and the final by request id', () => {
    const h = opened();
    const a = queryHandlers();
    const b = queryHandlers();
    const ra = h.session.query('svc/a', { target: 'best-matching' }, a);
    const rb = h.session.query('svc/b', { target: 'all', payload: fromHex('0001') }, b);
    expect(ra).not.toBe(rb);
    h.session.receive(
      frame(
        true,
        0,
        reply(ra, 'svc/a', fromHex('aa')),
        replyErr(rb, 'svc/b', fromHex('ee')),
        responseFinal(ra),
        responseFinal(rb),
      ),
    );
    expect(a.log).toEqual(['reply svc/a aa', 'final']);
    expect(b.log).toEqual(['err ee', 'final']);
  });

  it('drops a reply after forgetQuery, and one for an id it never sent', () => {
    const h = opened();
    const q = queryHandlers();
    const rid = h.session.query('svc', { target: 'best-matching' }, q);
    h.session.forgetQuery(rid);
    h.session.receive(frame(true, 0, reply(rid, 'svc', fromHex('aa')), responseFinal(rid)));
    h.session.receive(frame(true, 1, reply(777, 'svc', fromHex('aa')), responseFinal(777)));
    expect(q.log).toEqual([]);
    expect(h.ends).toEqual([]);
  });

  it('a session end calls onSessionEnd on every pending query, never onFinal', () => {
    for (const end of [
      (h: Harness) => h.session.close(),
      (h: Harness) => h.session.receive(fromHex('2300')),
      (h: Harness) => h.session.receive(fromHex('1f')),
      () => vi.advanceTimersByTime(60_000),
    ]) {
      const h = opened();
      const q = queryHandlers();
      const done = queryHandlers();
      h.session.query('svc', { target: 'best-matching' }, q);
      const rid = h.session.query('svc', { target: 'best-matching' }, done);
      h.session.receive(frame(true, 0, responseFinal(rid)));
      end(h);
      expect(q.log).toEqual(['session-end']);
      expect(done.log).toEqual(['final']);
    }
  });

  it('a query on an ended session reports onSessionEnd and sends nothing', () => {
    const h = opened();
    h.session.close();
    h.sent.length = 0;
    const q = queryHandlers();
    h.session.query('svc', { target: 'best-matching' }, q);
    expect(q.log).toEqual(['session-end']);
    expect(h.sent).toEqual([]);
  });

  it('onSessionEnd runs before onClosed', () => {
    const order: string[] = [];
    const h = opened();
    h.session.query(
      'svc',
      { target: 'best-matching' },
      {
        onReply() {},
        onError() {},
        onFinal() {},
        onSessionEnd: () => order.push('query'),
      },
    );
    const ends = h.ends;
    ends.push = (...e: SessionEnd[]) => {
      order.push('closed');
      return Array.prototype.push.apply(ends, e);
    };
    h.session.close();
    expect(order).toEqual(['query', 'closed']);
  });
});

describe('lease', () => {
  it('sends a KEEP_ALIVE after 2.5 s of client silence', () => {
    const h = opened();
    vi.advanceTimersByTime(2_499);
    expect(h.sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(h.sent.map(hex)).toEqual(['04']);
    vi.advanceTimersByTime(2_500);
    expect(h.sent.map(hex)).toEqual(['04', '04']);
  });

  it('sends none while other traffic flows', () => {
    const h = opened();
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(2_000);
      h.session.put('a', utf8('x'));
    }
    expect(h.sent.map(hex).filter((b) => b === '04')).toEqual([]);
  });

  it('ends with lease-expired and CLOSE EXPIRED after the router lease of silence', () => {
    const h = opened({ leaseS: 60 });
    vi.advanceTimersByTime(59_999);
    expect(h.ends).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(h.ends).toEqual([{ kind: 'lease-expired', silentMs: 60_000 }]);
    expect(hex(h.sent.at(-1)!)).toBe('2305');
  });

  it('a router KEEP_ALIVE at 30 s keeps the session', () => {
    const h = opened({ leaseS: 60 });
    vi.advanceTimersByTime(30_000);
    h.session.receive(fromHex('04'));
    vi.advanceTimersByTime(59_999);
    expect(h.ends).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(h.ends).toEqual([{ kind: 'lease-expired', silentMs: 60_000 }]);
  });

  it('keeps sending keepalives after the wall clock steps back', () => {
    const h = opened();
    vi.setSystemTime(Date.now() - 3_600_000);
    vi.advanceTimersByTime(2_500);
    expect(h.sent.map(hex)).toEqual(['04']);
    vi.advanceTimersByTime(2_500);
    expect(h.sent.map(hex)).toEqual(['04', '04']);
  });

  it('still expires a silent router after the wall clock steps back', () => {
    const h = opened({ leaseS: 60 });
    vi.setSystemTime(Date.now() - 3_600_000);
    vi.advanceTimersByTime(120_000);
    expect(h.ends.map((e) => e.kind)).toEqual(['lease-expired']);
  });

  it('reports the link state', () => {
    const h = opened();
    const t0 = Date.now();
    vi.advanceTimersByTime(1_000);
    h.session.put('a', utf8('x'));
    vi.advanceTimersByTime(500);
    h.session.receive(fromHex('04'));
    expect(h.session.linkState()).toEqual({
      lastTxMs: t0 + 1_000,
      lastRxMs: t0 + 1_500,
      keepAliveMs: 2_500,
    });
  });
});
