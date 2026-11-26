import { describe, expect, it } from 'vitest';
import { ByteReader, ZenohProtocolError } from '../../src/zenoh/codec';
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
  readNetworkMessage,
  readPushBody,
  resolveKey,
  skipPushBody,
  type NetworkMessage,
} from '../../src/zenoh/network';
import { frameBodyContinues, readTransportMessage } from '../../src/zenoh/transport';

const hex = (u: Uint8Array): string =>
  Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (s: string): Uint8Array =>
  new Uint8Array((s.replace(/\s+/g, '').match(/../g) ?? []).map((b) => parseInt(b, 16)));
const utf8 = (s: string): string => hex(new TextEncoder().encode(s));
const k = utf8('k'); // '6b'

/** Read one network message that fills `bytes`, its PUSH body included. */
function one(bytes: Uint8Array): NetworkMessage {
  const r = new ByteReader(bytes);
  const m = readNetworkMessage(r);
  if (m.kind === 'push') readPushBody(r);
  expect(r.more()).toBe(false);
  return m;
}

const NO_KEYS: ReadonlyMap<number, string> = new Map();

describe('PUSH, recorded', () => {
  // One FRAME from rmw_zenohd carrying a /chatter sample from a ROS talker:
  // PUSH with N and M, PUT with a timestamp and the rmw attachment, CDR
  // payload "Hello World: 399".
  const KEY =
    '0/chatter/std_msgs::msg::dds_::String_/RIHS01_df668c740482bbd48fb39d76a70dfd4bd59db1288021743503259e948f6b1a18';
  const ATTACHMENT = '8f01000000000000a9cc3bc22c36e0181069af54f7e43519b8448d201c2359967c';
  const PAYLOAD = '000100001100000048656c6c6f20576f726c643a2033393900';
  const BATCH = fromHex(
    '25dfbbb949' + // FRAME, reliable
      '7d00' + // PUSH (N, M), scope 0
      '6e' +
      utf8(KEY) +
      'a1' + // PUT (T, Z)
      '909887f898d7d0eb6a' + // NTP64 time, 9-byte VLE
      '10f03c5dfab535ec251a577f161aa865f2' + // 16-byte zid
      '4321' + // Attachment (ZBuf id 3), 33 bytes
      ATTACHMENT +
      '19' +
      PAYLOAD,
  );

  it('reads the key before the body, then the body', () => {
    const r = new ByteReader(BATCH);
    expect(readTransportMessage(r)).toMatchObject({ kind: 'frame', reliable: true });
    expect(frameBodyContinues(r)).toBe(true);
    const m = readNetworkMessage(r);
    expect(m).toEqual({ kind: 'push', wire: { scope: 0, suffix: KEY, senderMapping: true } });
    if (m.kind !== 'push') throw new Error('unreachable');
    expect(resolveKey(m.wire, NO_KEYS)).toBe(KEY);
    expect(readPushBody(r)).toEqual({
      kind: 'put',
      payload: fromHex(PAYLOAD),
      attachment: fromHex(ATTACHMENT),
      encoding: null,
      timestamp: { time: 0x6ad742b98f01cc10n, zid: fromHex('f03c5dfab535ec251a577f161aa865f2') },
    });
    expect(frameBodyContinues(r)).toBe(false);
  });

  it('returns the payload as a view into the batch', () => {
    const r = new ByteReader(BATCH);
    readTransportMessage(r);
    readNetworkMessage(r);
    expect(readPushBody(r).payload.buffer).toBe(BATCH.buffer);
  });

  it('skips the body without reading the payload: garbage payload bytes change nothing', () => {
    const planted = BATCH.slice();
    planted.fill(0xff, planted.length - PAYLOAD.length / 2);
    for (const batch of [BATCH, planted]) {
      const r = new ByteReader(batch);
      readTransportMessage(r);
      readNetworkMessage(r);
      skipPushBody(r);
      expect(r.more()).toBe(false);
    }
  });
});

describe('PUSH, synthetic', () => {
  it('reads a PUT with an encoding and schema, and a DEL', () => {
    // PUT (E): encoding id 3 with schema (3 << 1 | 1 = 07), schema 'ab', payload 'cc'.
    expect(one(fromHex('3d0001' + k + '41 07 02 6162 01 cc'))).toEqual({
      kind: 'push',
      wire: { scope: 0, suffix: 'k', senderMapping: false },
    });
    const r = new ByteReader(fromHex('41 07 02 6162 01 cc'));
    expect(readPushBody(r)).toMatchObject({
      kind: 'put',
      encoding: { id: 3, schema: fromHex('6162') },
      payload: fromHex('cc'),
    });
    // DEL (Z), Attachment (ZBuf id 2) 'dd'.
    expect(readPushBody(new ByteReader(fromHex('82 42 01 dd')))).toEqual({
      kind: 'del',
      payload: new Uint8Array(0),
      attachment: fromHex('dd'),
      encoding: null,
      timestamp: null,
    });
  });

  it('skips the PUSH extensions it knows, NodeId (mandatory) included', () => {
    // PUSH (N, Z), QoS (Z64 id 1) with Z, NodeId (Z64, M, id 3) = 0, then PUT.
    const r = new ByteReader(fromHex('bd0001' + k + 'a105 3300 01 01 aa'));
    expect(readNetworkMessage(r)).toMatchObject({ kind: 'push' });
    expect(readPushBody(r)).toMatchObject({ kind: 'put', payload: fromHex('aa') });
  });

  it('fails on an unknown mandatory PUSH extension', () => {
    expect(() => one(fromHex('bd0001' + k + '1c 01 01 aa'))).toThrow(ZenohProtocolError);
  });

  it('fails on a shared-memory PUT, which this client cannot map', () => {
    // PUT (Z), Shm (unit, mandatory, id 2).
    expect(() => readPushBody(new ByteReader(fromHex('81 12 01 aa')))).toThrow(ZenohProtocolError);
  });

  it('fails on a PUSH body that is neither PUT nor DEL', () => {
    expect(() => readPushBody(new ByteReader(fromHex('03')))).toThrow(ZenohProtocolError);
  });

  it('fails on a payload length beyond the bytes left', () => {
    expect(() => readPushBody(new ByteReader(fromHex('01 05 aa')))).toThrow(ZenohProtocolError);
  });
});

describe('key resolution', () => {
  const ROUTER_KEYS = new Map([[7, 'robot/']]);

  it('joins a scope the router declared with the suffix', () => {
    expect(resolveKey({ scope: 7, suffix: 'odom', senderMapping: true }, ROUTER_KEYS)).toBe(
      'robot/odom',
    );
    expect(resolveKey({ scope: 7, suffix: '', senderMapping: true }, ROUTER_KEYS)).toBe('robot/');
  });

  it('fails on a scope the router never declared', () => {
    expect(() => resolveKey({ scope: 8, suffix: 'x', senderMapping: true }, ROUTER_KEYS)).toThrow(
      ZenohProtocolError,
    );
  });

  it('fails on a scope in our own mapping: the client declares no key ids', () => {
    expect(() => resolveKey({ scope: 7, suffix: 'x', senderMapping: false }, ROUTER_KEYS)).toThrow(
      ZenohProtocolError,
    );
  });

  it('fails on a scope above 16 bits', () => {
    expect(() => one(fromHex('1d 80808004 01 00'))).toThrow(ZenohProtocolError);
  });
});

describe('client declarations and interests, golden bytes Zenoh 1.x routers accept', () => {
  it('declares and undeclares a subscriber', () => {
    // DECLARE, D_SUBSCRIBER (N), id 1, scope 0, 'a/b'.
    expect(hex(encodeDeclareSubscriber(1, 'a/b'))).toBe('1e22010003' + utf8('a/b'));
    expect(hex(encodeUndeclareSubscriber(1))).toBe('1e0301');
  });

  it('declares and undeclares a token', () => {
    expect(hex(encodeDeclareToken(2, 'k'))).toBe('1e26020001' + k);
    expect(hex(encodeUndeclareToken(2))).toBe('1e0702');
  });

  it('sends an interest in tokens, current or current and future, and ends it', () => {
    // INTEREST mode 1 (0x39) or 3 (0x79), id 3, options T|R|N (0x38), scope 0, key.
    expect(hex(encodeInterest(3, 'current', 'k', INTEREST_TOKENS))).toBe('3903380001' + k);
    expect(hex(encodeInterest(3, 'current-future', 'k', INTEREST_TOKENS))).toBe('7903380001' + k);
    expect(hex(encodeInterestFinal(3))).toBe('1903');
  });
});

describe('PUT and QUERY, golden bytes Zenoh 1.x routers accept', () => {
  it('writes a PUT with and without an attachment', () => {
    // PUSH (N), scope 0, key; PUT; payload length-prefixed.
    expect(hex(encodePut('k', fromHex('aabb')))).toBe('3d0001' + k + '01' + '02aabb');
    // PUT (Z), Attachment (ZBuf id 3).
    expect(hex(encodePut('k', fromHex('aabb'), fromHex('cc')))).toBe(
      '3d0001' + k + '81' + '4301cc' + '02aabb',
    );
  });

  it('round-trips a PUT through the reader', () => {
    const r = new ByteReader(encodePut('a/b', fromHex('0102'), fromHex('03')));
    const m = readNetworkMessage(r);
    if (m.kind !== 'push') throw new Error('expected a push');
    expect(resolveKey(m.wire, NO_KEYS)).toBe('a/b');
    expect(readPushBody(r)).toEqual({
      kind: 'put',
      payload: fromHex('0102'),
      attachment: fromHex('03'),
      encoding: null,
      timestamp: null,
    });
  });

  it('writes a QUERY whose body payload has no length prefix', () => {
    // REQUEST (N, Z), rid 5, scope 0, key; QueryTarget (Z64, M, id 4) = 0, no more.
    // QUERY (Z); QueryBody (ZBuf id 3, Z) = encoding 0 then the raw payload;
    // Attachment (ZBuf id 5).
    const payload = '0001000000';
    expect(
      hex(
        encodeQuery(5, 'k', {
          target: 'best-matching',
          payload: fromHex(payload),
          attachment: fromHex('dd'),
        }),
      ),
    ).toBe('bc0500' + '01' + k + '3400' + '83' + 'c306' + '00' + payload + '4501dd');
  });

  it('writes the other targets, and a QUERY with no body or attachment', () => {
    expect(hex(encodeQuery(1, 'k', { target: 'all' }))).toBe('bc0100' + '01' + k + '3401' + '03');
    expect(hex(encodeQuery(1, 'k', { target: 'all-complete' }))).toBe(
      'bc0100' + '01' + k + '3402' + '03',
    );
  });
});

describe('RESPONSE and RESPONSE_FINAL', () => {
  it('reads a REPLY carrying a PUT', () => {
    // RESPONSE (N), rid 5, scope 0, key; REPLY; PUT payload 'aa'.
    expect(one(fromHex('3b0500' + '01' + k + '04' + '01' + '01aa'))).toEqual({
      kind: 'response',
      rid: 5,
      wire: { scope: 0, suffix: 'k', senderMapping: false },
      body: {
        kind: 'reply',
        sample: {
          kind: 'put',
          payload: fromHex('aa'),
          attachment: null,
          encoding: null,
          timestamp: null,
        },
      },
    });
  });

  it('reads a REPLY with consolidation and extensions, and RESPONSE extensions', () => {
    // RESPONSE (N, M, Z), ResponderId (ZBuf id 3) 'ee'; REPLY (C, Z) consolidation 2, unknown optional unit 0x09.
    const m = one(fromHex('fb0500' + '01' + k + '4301ee' + 'a40209' + '01' + '01aa'));
    expect(m).toMatchObject({ kind: 'response', body: { kind: 'reply' } });
  });

  it('reads an ERR with its encoding and payload', () => {
    // RESPONSE (N), rid 6; ERR (E), encoding id 1 (02), payload 'ff'.
    expect(one(fromHex('3b0600' + '01' + k + '45' + '02' + '01ff'))).toEqual({
      kind: 'response',
      rid: 6,
      wire: { scope: 0, suffix: 'k', senderMapping: false },
      body: { kind: 'err', payload: fromHex('ff'), encoding: { id: 1, schema: null } },
    });
  });

  it('fails on a RESPONSE body that is neither REPLY nor ERR', () => {
    expect(() => one(fromHex('3b0600' + '01' + k + '01'))).toThrow(ZenohProtocolError);
  });

  it('reads a RESPONSE_FINAL, with and without extensions', () => {
    expect(one(fromHex('1a05'))).toEqual({ kind: 'response-final', rid: 5 });
    expect(one(fromHex('9a05' + '2105'))).toEqual({ kind: 'response-final', rid: 5 });
  });
});

describe('DECLARE from the router', () => {
  it('reads a D_TOKEN answering an interest, in the recorded form', () => {
    // DECLARE (I, Z), interest 2, QoS (Z64 id 1) 8; D_TOKEN (N, M), id 0, scope 0.
    expect(one(fromHex('be022108' + '66' + '0000' + '04' + utf8('@a/b')))).toEqual({
      kind: 'declare',
      interestId: 2,
      decl: { kind: 'd-token', id: 0, wire: { scope: 0, suffix: '@a/b', senderMapping: true } },
    });
  });

  it('reads a U_TOKEN with and without the wire-expression extension', () => {
    expect(one(fromHex('1e0709'))).toEqual({
      kind: 'declare',
      interestId: null,
      decl: { kind: 'u-token', id: 9, wire: null },
    });
    // U_TOKEN (Z), id 9, WireExpr (ZBuf, M, id 0xf): flags N|M, scope 0, raw suffix 'k'.
    expect(one(fromHex('1e8709' + '5f' + '03' + '0300' + k))).toEqual({
      kind: 'declare',
      interestId: null,
      decl: { kind: 'u-token', id: 9, wire: { scope: 0, suffix: 'k', senderMapping: true } },
    });
  });

  it('reads the null wire expression a router puts on an undeclare as no extension', () => {
    // rmw_zenohd (zenoh 1.10.1) sends every U_TOKEN with the extension holding
    // upstream's WireExprType::null(): no flags, scope 0, no suffix. It names
    // no key; the receiver resolves the id.
    expect(one(fromHex('1e8709' + '5f' + '02' + '0000'))).toEqual({
      kind: 'declare',
      interestId: null,
      decl: { kind: 'u-token', id: 9, wire: null },
    });
    expect(one(fromHex('1e8309' + '5f' + '02' + '0000'))).toEqual({
      kind: 'declare',
      interestId: null,
      decl: { kind: 'u-subscriber', id: 9, wire: null },
    });
  });

  it('reads key-id declarations', () => {
    // D_KEYEXPR (N), id 7, scope 0, 'robot/'.
    expect(one(fromHex('1e2007' + '00' + '06' + utf8('robot/')))).toEqual({
      kind: 'declare',
      interestId: null,
      decl: {
        kind: 'd-keyexpr',
        id: 7,
        wire: { scope: 0, suffix: 'robot/', senderMapping: false },
      },
    });
    expect(one(fromHex('1e0107'))).toEqual({
      kind: 'declare',
      interestId: null,
      decl: { kind: 'u-keyexpr', id: 7 },
    });
  });

  it('reads subscriber declarations', () => {
    expect(one(fromHex('1e6204' + '00' + '01' + k))).toEqual({
      kind: 'declare',
      interestId: null,
      decl: { kind: 'd-subscriber', id: 4, wire: { scope: 0, suffix: 'k', senderMapping: true } },
    });
    expect(one(fromHex('1e0304'))).toEqual({
      kind: 'declare',
      interestId: null,
      decl: { kind: 'u-subscriber', id: 4, wire: null },
    });
  });

  it('reads a D_FINAL closing an interest', () => {
    expect(one(fromHex('3e03' + '1a'))).toEqual({
      kind: 'declare',
      interestId: 3,
      decl: { kind: 'd-final' },
    });
  });

  it('parses and ignores queryable declarations', () => {
    // D_QUERYABLE (N, Z), id 1, scope 0, 'k', QueryableInfo (Z64 id 1) = 1.
    expect(one(fromHex('1ea401' + '00' + '01' + k + '2101'))).toEqual({
      kind: 'declare',
      interestId: null,
      decl: { kind: 'other' },
    });
    expect(one(fromHex('1e0501'))).toMatchObject({ decl: { kind: 'other' } });
  });

  it('fails on an unknown declaration', () => {
    expect(() => one(fromHex('1e08'))).toThrow(ZenohProtocolError);
  });
});

describe('other network messages', () => {
  it('parses an INTEREST from the router and reports its id and mode', () => {
    expect(one(fromHex('7903380001' + k))).toEqual({
      kind: 'interest',
      id: 3,
      mode: 'current-future',
    });
    // Unrestricted (no R): no key follows.
    expect(one(fromHex('390402'))).toEqual({ kind: 'interest', id: 4, mode: 'current' });
    expect(one(fromHex('1905'))).toEqual({ kind: 'interest', id: 5, mode: 'final' });
  });

  it('skips a network OAM', () => {
    // OAM (ENC Z64), id 1, value 5.
    expect(one(fromHex('3f0105'))).toEqual({ kind: 'oam' });
    // OAM (Z, ENC ZBuf), id 2, QoS (Z64 id 1) = 0, body 'aa'.
    expect(one(fromHex('df02' + '2100' + '01aa'))).toEqual({ kind: 'oam' });
  });

  it('fails on a REQUEST: the client declares no queryable', () => {
    expect(() => one(encodeQuery(1, 'k', { target: 'all' }))).toThrow(ZenohProtocolError);
  });

  it('fails on a transport id where a network message should be', () => {
    expect(() => one(fromHex('04'))).toThrow(ZenohProtocolError);
  });
});
