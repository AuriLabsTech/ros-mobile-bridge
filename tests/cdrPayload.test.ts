import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { parse as parseRosMsgDef } from '@foxglove/rosmsg';
import { cdrPayloadCodec, fieldlessCdrPayloadCodec, type CdrDecodeResult } from '../src/cdrPayload';
import { arbitraryMessage } from './_helpers/arbitraryMessage';
import { normalizeDecoded } from './_helpers/populateMessage';
import { GOLDEN_DEFINITIONS } from './fixtures/cdr-golden/definitions';

/**
 * The internal CDR payload module both binary transports decode and encode
 * through. These tests pin what it does with headers the reader does not
 * understand and with payloads that lie about their own length: each gives
 * the typed undecodable result, never a throw, an out-of-bounds read or a
 * hang.
 */

const defs = (text: string) => parseRosMsgDef(text, { ros2: true });

const TWIST = defs(
  [
    'Vector3 linear',
    'Vector3 angular',
    '================================================================================',
    'MSG: geometry_msgs/Vector3',
    'float64 x',
    'float64 y',
    'float64 z',
  ].join('\n'),
);

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function expectUndecodable(result: CdrDecodeResult, reason: string): string {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('unreachable');
  expect(result.reason).toBe(reason);
  return result.detail;
}

describe('cdrPayloadCodec: decode and encode', () => {
  it('round-trips a nested message and encodes to a plain Uint8Array', () => {
    const codec = cdrPayloadCodec(TWIST);
    const msg = { linear: { x: 1.5, y: -2, z: 3 }, angular: { x: 0, y: 0, z: 0.25 } };
    const encoded = codec.encode(msg);
    expect(encoded.constructor).toBe(Uint8Array);
    expect(Array.from(encoded.subarray(0, 4))).toEqual([0x00, 0x01, 0x00, 0x00]);
    const decoded = codec.decode(encoded);
    expect(decoded).toEqual({ ok: true, message: msg });
  });

  it('decodes a payload that is a view into a larger buffer', () => {
    const codec = cdrPayloadCodec(defs('uint32 x'));
    const frame = bytes(0xaa, 0xbb, 0x00, 0x01, 0x00, 0x00, 0x2a, 0x00, 0x00, 0x00);
    expect(codec.decode(frame.subarray(2))).toEqual({ ok: true, message: { x: 42 } });
  });

  it('leaves trailing bytes alone on a codec built from a real definition', () => {
    // Leftover bytes after a schema the server sent mean the schema is older
    // than the payload: a different claim from a fieldless description being
    // wrong, and not acted on here.
    const codec = cdrPayloadCodec(defs('uint8 a'));
    const result = codec.decode(bytes(0x00, 0x01, 0x00, 0x00, 0x07, 0x01, 0x02, 0x03, 0x04, 0x05));
    expect(result).toEqual({ ok: true, message: { a: 7 } });
  });
});

describe('cdrPayloadCodec: encapsulation header', () => {
  const twoFields = defs('uint8 a\nfloat64 b');

  it('decodes big-endian plain CDR (00 00)', () => {
    const codec = cdrPayloadCodec(defs('uint32 x'));
    expect(codec.decode(bytes(0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02))).toEqual({
      ok: true,
      message: { x: 258 },
    });
  });

  it.each([
    [0x06, 'RTPS_CDR2_BE'],
    [0x07, 'RTPS_CDR2_LE'],
    [0x10, 'CDR2_BE'],
    [0x11, 'CDR2_LE'],
  ])('refuses plain XCDR2 header 00 %d (%s): no ROS 2 middleware sends it', (kind) => {
    // Every rmw and the micro-ROS agent write 00 01 in code on Humble
    // through Rolling, and no QoS or XML profile switches a ROS 2 publisher
    // to XCDR2. The reader's XCDR2 path has never met a real producer, so it
    // is not trusted to give right values: refused until one is captured.
    // Accepting it later is not a breaking change; dropping it would be.
    const b = new DataView(new ArrayBuffer(8));
    b.setFloat64(0, 1.5, true);
    const payload = bytes(0x00, kind, 0x00, 0x00, 0x05, 0, 0, 0, ...new Uint8Array(b.buffer));
    const detail = expectUndecodable(
      cdrPayloadCodec(twoFields).decode(payload),
      'unsupported-encapsulation',
    );
    expect(detail).toContain(`00 ${kind.toString(16).padStart(2, '0')}`);
  });

  it.each([
    [0x02, 'PL_CDR_BE'],
    [0x03, 'PL_CDR_LE'],
    [0x08, 'RTPS_DELIMITED_CDR2_BE'],
    [0x09, 'RTPS_DELIMITED_CDR2_LE'],
    [0x0a, 'RTPS_PL_CDR2_BE'],
    [0x0b, 'RTPS_PL_CDR2_LE'],
    [0x12, 'PL_CDR2_BE'],
    [0x13, 'PL_CDR2_LE'],
    [0x14, 'DELIMITED_CDR2_BE'],
    [0x15, 'DELIMITED_CDR2_LE'],
  ])('refuses header 00 %d (%s): its member or delimiter headers are not read', (kind) => {
    // The reader underneath accepts these and then reads the DHEADER or
    // EMHEADER as if it were the first field, producing wrong values without
    // an error. Refusing is the only honest answer until a capture shows a
    // ROS 2 middleware sending one.
    const payload = bytes(0x00, kind, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x05, 0, 0, 0);
    const detail = expectUndecodable(
      cdrPayloadCodec(twoFields).decode(payload),
      'unsupported-encapsulation',
    );
    expect(detail).toContain(`00 ${kind.toString(16).padStart(2, '0')}`);
  });

  it.each([[0x04], [0x05], [0x0c], [0x10 - 1], [0x16], [0xff]])(
    'refuses unknown header id 00 %d instead of reading it as big-endian XCDR2',
    (kind) => {
      const payload = bytes(0x00, kind, 0x00, 0x00, 0x2a, 0x00, 0x00, 0x00);
      const detail = expectUndecodable(
        cdrPayloadCodec(defs('uint32 x')).decode(payload),
        'unsupported-encapsulation',
      );
      expect(detail).toContain(`00 ${kind.toString(16).padStart(2, '0')}`);
    },
  );

  it('refuses a header whose first byte is not zero', () => {
    // The reader looks only at the second byte, so `80 01` would pass as
    // little-endian CDR.
    const detail = expectUndecodable(
      cdrPayloadCodec(defs('uint32 x')).decode(bytes(0x80, 0x01, 0x00, 0x00, 0x2a, 0, 0, 0)),
      'unsupported-encapsulation',
    );
    expect(detail).toContain('80 01');
  });

  it('refuses a payload too short to hold the header', () => {
    for (const n of [0, 1, 2, 3]) {
      const result = cdrPayloadCodec(defs('uint8 a')).decode(new Uint8Array(n));
      expectUndecodable(result, 'malformed');
    }
  });
});

describe('cdrPayloadCodec: adversarial payloads', () => {
  it('reports a Twist truncated at every field boundary as malformed', () => {
    const codec = cdrPayloadCodec(TWIST);
    const full = codec.encode({ linear: { x: 1, y: 2, z: 3 }, angular: { x: 4, y: 5, z: 6 } });
    expect(full.byteLength).toBe(52);
    for (let fields = 0; fields < 6; fields++) {
      const cut = full.subarray(0, 4 + fields * 8);
      expectUndecodable(codec.decode(cut), 'malformed');
    }
  });

  it('reports a string length that runs past the end as malformed', () => {
    const payload = bytes(0x00, 0x01, 0x00, 0x00, 100, 0, 0, 0, 0x41, 0x42, 0x43);
    expectUndecodable(cdrPayloadCodec(defs('string data')).decode(payload), 'malformed');
  });

  it.each([
    ['float32[] ranges'],
    ['uint8[] data'],
    ['string[] names'],
    [
      'geometry_msgs/Point[] points\n===\nMSG: geometry_msgs/Point\nfloat64 x\nfloat64 y\nfloat64 z',
    ],
  ])('reports a sequence count of 2^31 as malformed (%s)', (text) => {
    const payload = bytes(0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80, 1, 2, 3, 4);
    const started = Date.now();
    expectUndecodable(cdrPayloadCodec(defs(text)).decode(payload), 'malformed');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('reports a definition with only constants as malformed instead of throwing', () => {
    // rcl_interfaces/msg/ParameterType has constants and no fields, and the
    // reader underneath refuses to be built from it. That refusal happens on
    // first decode, so it must come back as a result like any other.
    const codec = cdrPayloadCodec(defs('uint8 PARAMETER_NOT_SET=0\nuint8 PARAMETER_BOOL=1\n'));
    let result: CdrDecodeResult | undefined;
    expect(() => {
      result = codec.decode(bytes(0x00, 0x01, 0x00, 0x00, 0x00));
    }).not.toThrow();
    expectUndecodable(result!, 'malformed');
  });

  it('never throws, whatever the bytes', () => {
    const codec = cdrPayloadCodec(TWIST);
    for (let seed = 0; seed < 200; seed++) {
      const n = (seed * 7) % 64;
      const payload = new Uint8Array(n);
      for (let i = 0; i < n; i++) payload[i] = (seed * 31 + i * 17) & 0xff;
      expect(() => codec.decode(payload)).not.toThrow();
    }
  });
});

describe('cdrPayloadCodec: round trip over random values', () => {
  // Hypothetical, not a capture: one field of every primitive, each kind of
  // array, and a nested sequence, so the property covers what the golden
  // types do not (int64, bool, fixed arrays of strings).
  const EVERY_PRIMITIVE = [
    'bool a\nint8 b\nuint8 c\nint16 d\nuint16 e\nint32 f\nuint32 g\nint64 h\nuint64 i',
    'float32 j\nfloat64 k\nstring l\nbuiltin_interfaces/Time m',
    'string[3] n\nint64[] o\nuint8[] p\nInner[] q\nInner[2] r',
    '===\nMSG: pkg/Inner\nfloat32 x\nstring label\nint16[] counts',
  ].join('\n');

  const cases: [string, string][] = [
    ['every primitive (hypothetical)', EVERY_PRIMITIVE],
    ...Object.entries(GOLDEN_DEFINITIONS),
  ];

  it.each(cases)('%s', (_label, text) => {
    const definitions = defs(text);
    const codec = cdrPayloadCodec(definitions);
    fc.assert(
      fc.property(arbitraryMessage(definitions), (message) => {
        const result = codec.decode(codec.encode(message));
        expect(result.ok).toBe(true);
        if (result.ok) expect(normalizeDecoded(result.message)).toEqual(message);
      }),
      { numRuns: 200 },
    );
  });
});

describe('fieldlessCdrPayloadCodec', () => {
  it.each([
    ['5 bytes (the placeholder byte alone)', [0x00, 0x01, 0x00, 0x00, 0x00]],
    ['8 bytes (RTPS padding)', [0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]],
    ['8 bytes with uninitialised padding', [0x00, 0x01, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00]],
  ])('decodes %s to the empty object', (_label, payload) => {
    expect(fieldlessCdrPayloadCodec().decode(bytes(...payload))).toEqual({ ok: true, message: {} });
  });

  it('reports bytes that final padding cannot account for', () => {
    const payload = bytes(0x00, 0x01, 0x00, 0x00, 0x00, 1, 2, 3, 4);
    const detail = expectUndecodable(
      fieldlessCdrPayloadCodec().decode(payload),
      'unaccounted-bytes',
    );
    expect(detail).toContain('9');
  });

  it('encodes the empty message as the header plus the placeholder byte', () => {
    expect(Array.from(fieldlessCdrPayloadCodec().encode({}))).toEqual([
      0x00, 0x01, 0x00, 0x00, 0x00,
    ]);
  });

  it('is built from the definitions the parser gives a whitespace-only schema', () => {
    // A codec built from either spelling of "no fields" must read and write
    // the same bytes as this one; equal definitions are what guarantees it.
    expect(fieldlessCdrPayloadCodec().definitions).toEqual(defs('   \n'));
  });
});
