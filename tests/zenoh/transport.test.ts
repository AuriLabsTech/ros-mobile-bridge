import { describe, expect, it } from 'vitest';
import { ByteReader, ZenohProtocolError } from '../../src/zenoh/codec';
import {
  CLOSE_REASON,
  FRAGMENT_HEADER_MAX,
  encodeClose,
  encodeFragment,
  encodeFrame,
  encodeInitSyn,
  encodeKeepAlive,
  encodeOpenSyn,
  frameBodyContinues,
  readTransportMessage,
  type TransportMessage,
} from '../../src/zenoh/transport';

const hex = (u: Uint8Array): string =>
  Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (s: string): Uint8Array =>
  new Uint8Array((s.replace(/\s+/g, '').match(/../g) ?? []).map((b) => parseInt(b, 16)));

const ZID = fromHex('00112233445566778899aabbccddeeff');

/** Every transport message in a batch. Only for batches with no FRAME body: that is the network layer's to read. */
function readAll(batch: Uint8Array): TransportMessage[] {
  const r = new ByteReader(batch);
  const out: TransportMessage[] = [];
  while (r.more()) out.push(readTransportMessage(r));
  return out;
}

function one(batch: Uint8Array): TransportMessage {
  const all = readAll(batch);
  expect(all).toHaveLength(1);
  return all[0]!;
}

describe('INIT', () => {
  it('writes the 22-byte InitSyn every router accepted', () => {
    // Header 0x41 (INIT, S), version 0x09, 0xf2 (16-byte zid, client),
    // zid, resolution 0x0a (32-bit sn and request id), batch 65535 LE.
    expect(hex(encodeInitSyn(ZID))).toBe('4109f2' + hex(ZID) + '0affff');
    expect(encodeInitSyn(ZID)).toHaveLength(22);
  });

  it('refuses a zid outside 1 to 16 bytes', () => {
    expect(() => encodeInitSyn(new Uint8Array(0))).toThrow(RangeError);
    expect(() => encodeInitSyn(new Uint8Array(17))).toThrow(RangeError);
  });

  it('reads the InitAck a router sent: no S flag, so the defaults apply', () => {
    // Recorded from rmw_zenohd (Zenoh 1.x) answering the InitSyn above.
    const zid = '25a1b64d49bc0428e79421ed9175d2db';
    const cookie =
      '30d7238e83e6886ad8d5b913f2858756463af30f4bdced7f7ad7fb9178e6e2a8cf99b778ce42d6ea75ab89a03247d5bce2';
    const m = one(fromHex('2109f0' + zid + '31' + cookie));
    expect(m).toEqual({
      kind: 'init-ack',
      version: 0x09,
      whatami: 'router',
      zid: fromHex(zid),
      batchSize: 65535,
      cookie: fromHex(cookie),
      patch: 0,
    });
  });

  it('reads the size parameters and the Patch extension when present', () => {
    // 0xe1: INIT, A, S, Z. 1-byte zid (0x00 << 4 | router). Resolution 0x0a
    // (32-bit sn and request id), batch 0x2000 LE. Cookie 'ab'.
    // Extensions: QoS (unit, id 1, Z set), Patch (Z64, id 7) = 1.
    const m = one(fromHex('e1 09 00 7f 0a 0020 01ab 81 2701'));
    expect(m).toMatchObject({
      kind: 'init-ack',
      zid: fromHex('7f'),
      batchSize: 0x2000,
      cookie: fromHex('ab'),
      patch: 1,
    });
  });

  it('fails on any resolution but the 32-bit one the InitSyn asked for', () => {
    // 0x05: 16-bit sn and request id. 0x0b: 64-bit sn. 0x0e: 64-bit request id.
    for (const res of ['05', '0b', '0e']) {
      expect(() => readAll(fromHex('6109007f' + res + 'ffff01ab'))).toThrow(ZenohProtocolError);
    }
  });

  it('reports another protocol version without reading a layout it may not share', () => {
    // Version 8, then bytes that would not parse as a version-9 InitAck.
    const r = new ByteReader(fromHex('2108ffffff'));
    expect(readTransportMessage(r)).toEqual({ kind: 'init-ack-version', version: 8 });
    expect(r.more()).toBe(false);
  });

  it('fails on the reserved whatami 0b11', () => {
    expect(() => readAll(fromHex('210903aa01ab'))).toThrow(ZenohProtocolError);
  });

  it('fails on an InitSyn sent to the client', () => {
    expect(() => readAll(encodeInitSyn(ZID))).toThrow(ZenohProtocolError);
  });

  it('fails on a truncated InitAck', () => {
    expect(() => readAll(fromHex('2109f0aabb'))).toThrow(ZenohProtocolError);
  });

  it('fails on an unknown mandatory extension', () => {
    expect(() => readAll(fromHex('a10900aa01ab 1f'))).toThrow(ZenohProtocolError);
  });
});

describe('OPEN', () => {
  it('writes the OpenSyn: lease in ms, initial sn, cookie echoed', () => {
    // 0x02 (OPEN, no T), lease 10000 = 90 4e, sn 0, cookie len 2.
    expect(hex(encodeOpenSyn(10_000, 0, fromHex('abcd')))).toBe('02904e0002abcd');
  });

  it('reads the OpenAck a router sent: T flag, lease in seconds', () => {
    // Recorded with the InitAck above: 0x62 (OPEN, A, T), 60 s, sn 0x92e5dde.
    expect(one(fromHex('623cdebbb949'))).toEqual({
      kind: 'open-ack',
      leaseMs: 60_000,
      initialSn: 0x49 * 2 ** 21 + 0x39 * 2 ** 14 + 0x3b * 2 ** 7 + 0x5e,
    });
  });

  it('reads a lease in milliseconds when T is clear and skips optional extensions', () => {
    // 0xa2 (OPEN, A, Z), lease 2500 = c4 13, sn 7, LowLatency (unit, id 5).
    expect(one(fromHex('a2c4130705'))).toEqual({ kind: 'open-ack', leaseMs: 2500, initialSn: 7 });
  });

  it('fails on an OpenSyn sent to the client', () => {
    expect(() => readAll(encodeOpenSyn(10_000, 0, fromHex('ab')))).toThrow(ZenohProtocolError);
  });

  it('fails on an initial sn above 32 bits', () => {
    expect(() => readAll(fromHex('623c8080808010'))).toThrow(ZenohProtocolError);
  });
});

describe('CLOSE and KEEP_ALIVE', () => {
  it('writes a session CLOSE with its reason', () => {
    expect(hex(encodeClose(CLOSE_REASON.GENERIC))).toBe('2300');
    expect(hex(encodeClose(CLOSE_REASON.INVALID))).toBe('2302');
    expect(hex(encodeClose(CLOSE_REASON.EXPIRED))).toBe('2305');
  });

  it('reads a CLOSE, link or session, skipping extensions', () => {
    expect(one(fromHex('2300'))).toEqual({ kind: 'close', reason: 0, session: true });
    expect(one(fromHex('0305'))).toEqual({ kind: 'close', reason: 5, session: false });
    // 0xa3 (CLOSE, S, Z), reason 1, ZBuf id 2 holding 'bb'.
    expect(one(fromHex('a301 42 01 bb'))).toEqual({ kind: 'close', reason: 1, session: true });
  });

  it('writes and reads a KEEP_ALIVE', () => {
    expect(hex(encodeKeepAlive())).toBe('04');
    expect(one(encodeKeepAlive())).toEqual({ kind: 'keep-alive' });
    // 0x84 (KEEP_ALIVE, Z), one unit extension id 1.
    expect(one(fromHex('8401'))).toEqual({ kind: 'keep-alive' });
  });

  it('reads two transport messages in one batch', () => {
    expect(readAll(fromHex('04 2300'))).toEqual([
      { kind: 'keep-alive' },
      { kind: 'close', reason: 0, session: true },
    ]);
  });
});

describe('FRAME', () => {
  const PUSH = fromHex('1d00'); // a stand-in network message header

  it('writes a reliable and a best-effort FRAME around one network message', () => {
    expect(hex(encodeFrame(true, 0, PUSH))).toBe('25001d00');
    expect(hex(encodeFrame(false, 300, PUSH))).toBe('05ac021d00');
  });

  it('reads the header and leaves the reader on the first network message', () => {
    const r = new ByteReader(encodeFrame(true, 0xdeadbeef, PUSH));
    expect(readTransportMessage(r)).toEqual({ kind: 'frame', reliable: true, sn: 0xdeadbeef });
    expect(r.peek()).toBe(0x1d);
  });

  it('skips the QoS extension', () => {
    // 0xa5 (FRAME, R, Z), sn 1, QoS Z64 mandatory id 1 = 0x31 value 5.
    const r = new ByteReader(fromHex('a501310519'));
    expect(readTransportMessage(r)).toEqual({ kind: 'frame', reliable: true, sn: 1 });
    expect(r.peek()).toBe(0x19);
  });

  it('tells where a FRAME body ends: at the next transport header or the batch end', () => {
    // A reliable FRAME holding a network header byte, then a best-effort FRAME, then a KEEP_ALIVE.
    const r = new ByteReader(fromHex('2501 1d 0502 1e 04'));
    expect(readTransportMessage(r)).toMatchObject({ kind: 'frame', reliable: true, sn: 1 });
    expect(frameBodyContinues(r)).toBe(true);
    r.u8(); // the network layer consumes its message
    expect(frameBodyContinues(r)).toBe(false);
    expect(readTransportMessage(r)).toMatchObject({ kind: 'frame', reliable: false, sn: 2 });
    r.u8();
    expect(frameBodyContinues(r)).toBe(false);
    expect(readTransportMessage(r)).toEqual({ kind: 'keep-alive' });
    expect(frameBodyContinues(r)).toBe(false);
  });

  it('treats every network message id as a FRAME body, and transport ids as its end', () => {
    for (const id of [0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f]) {
      expect(frameBodyContinues(new ByteReader(new Uint8Array([id | 0xe0])))).toBe(true);
    }
    for (const id of [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]) {
      expect(frameBodyContinues(new ByteReader(new Uint8Array([id | 0xe0])))).toBe(false);
    }
  });
});

describe('FRAGMENT', () => {
  it('writes fragments: R and M flags, sn, chunk, no markers', () => {
    expect(hex(encodeFragment(true, true, 0, fromHex('aabb')))).toBe('6600aabb');
    expect(hex(encodeFragment(true, false, 1, fromHex('cc')))).toBe('2601cc');
    expect(hex(encodeFragment(false, true, 0xffffffff, fromHex('dd')))).toBe('46ffffffff0fdd');
  });

  it('keeps the header within FRAGMENT_HEADER_MAX bytes', () => {
    const f = encodeFragment(true, true, 0xffffffff, new Uint8Array(0));
    expect(f.length).toBe(FRAGMENT_HEADER_MAX);
  });

  it('reads a fragment: the chunk is the rest of the batch, as a view', () => {
    const batch = encodeFragment(true, true, 9, fromHex('010203'));
    const m = one(batch);
    expect(m).toEqual({
      kind: 'fragment',
      reliable: true,
      more: true,
      sn: 9,
      first: false,
      drop: false,
      chunk: fromHex('010203'),
    });
    if (m.kind !== 'fragment') throw new Error('unreachable');
    expect(m.chunk.buffer).toBe(batch.buffer);
  });

  it('reads the First and Drop markers', () => {
    // 0xe6 (FRAGMENT, R, M, Z), sn 0, First (unit id 2) with Z, then Drop (unit id 3).
    expect(one(fromHex('e600 82 03 ff'))).toMatchObject({
      kind: 'fragment',
      first: true,
      drop: true,
      chunk: fromHex('ff'),
    });
    // QoS (Z64 mandatory id 1) before First.
    expect(one(fromHex('a600 b105 02'))).toMatchObject({ first: true, drop: false, more: false });
  });
});

describe('OAM and unexpected input', () => {
  it('skips a transport OAM of each encoding and keeps reading', () => {
    // 0x00 unit id 1; 0x20 Z64 id 2 value 7; 0x40 ZBuf id 3 'aa'; 0xa0 Z64 with a QoS ext.
    expect(readAll(fromHex('0001 200207 400301aa a00431050a 04'))).toEqual([
      { kind: 'oam' },
      { kind: 'oam' },
      { kind: 'oam' },
      { kind: 'oam' },
      { kind: 'keep-alive' },
    ]);
  });

  it('fails on a network message outside a FRAME', () => {
    expect(() => readAll(fromHex('1d00'))).toThrow(ZenohProtocolError);
  });

  it('fails on JOIN, which is multicast only', () => {
    expect(() => readAll(fromHex('07'))).toThrow(ZenohProtocolError);
  });

  it('fails on an unassigned transport id', () => {
    expect(() => readAll(fromHex('08'))).toThrow(ZenohProtocolError);
  });
});
