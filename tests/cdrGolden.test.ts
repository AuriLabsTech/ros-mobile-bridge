import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parse as parseRosMsgDef } from '@foxglove/rosmsg';
import type { MessageDefinition, MessageDefinitionField } from '@foxglove/message-definition';
import { cdrPayloadCodec, type CdrPayloadCodec } from '../src/cdrPayload';
import { normalizeDecoded } from './_helpers/populateMessage';
import { GOLDEN_DEFINITIONS, RANGE_HUMBLE } from './fixtures/cdr-golden/definitions';

/**
 * Golden vectors: CDR bytes ROS 2's own serializer wrote on each distro, with
 * rmw_zenoh selected (`tests/fixtures/cdr-golden/generate.py`), decoded
 * through the library's codec with definitions the library holds, never ones
 * the robot reported.
 */

interface GoldenVector {
  type: string;
  values: Record<string, unknown>;
  fields: Record<string, Record<string, string>>;
  cdr: string;
}

interface GoldenFile {
  source: { distro: string; rmw: string; packages: Record<string, string | null> };
  vectors: GoldenVector[];
}

const DISTROS = ['humble', 'jazzy', 'kilted', 'lyrical', 'rolling'] as const;
const FIXTURES = join(__dirname, 'fixtures');

function load(distro: string): GoldenFile {
  const text = readFileSync(join(FIXTURES, 'cdr-golden', `${distro}.json`), 'utf8');
  return JSON.parse(text) as GoldenFile;
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function definitionText(distro: string, type: string): string {
  if (distro === 'humble' && type === 'sensor_msgs/msg/Range') return RANGE_HUMBLE;
  const text = GOLDEN_DEFINITIONS[type];
  if (text === undefined) throw new Error(`no golden definition for ${type}`);
  return text;
}

/** `pkg/msg/Name` to the `pkg/Name` form rosidl and the parser use. */
function shortName(type: string): string {
  return type.replace('/msg/', '/');
}

const ROSIDL_PRIMITIVE: Record<string, string> = {
  float32: 'float',
  float64: 'double',
  bool: 'boolean',
  byte: 'octet',
  // The parser turns these two into built-in types of its own.
  time: 'builtin_interfaces/Time',
  duration: 'builtin_interfaces/Duration',
};

/** A parsed field written the way rosidl's `get_fields_and_field_types` writes it. */
function rosidlType(field: MessageDefinitionField): string {
  const base = ROSIDL_PRIMITIVE[field.type] ?? field.type;
  if (field.isArray !== true) return base;
  return field.arrayLength !== undefined ? `${base}[${field.arrayLength}]` : `sequence<${base}>`;
}

/** Every type in a parsed definition, mapped to its fields in rosidl's spelling. */
function fieldLists(
  defs: MessageDefinition[],
  root: string,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const def of defs) {
    const fields: Record<string, string> = {};
    for (const f of def.definitions) {
      if (f.isConstant === true) continue;
      fields[f.name] = rosidlType(f);
    }
    out[def.name ?? root] = fields;
  }
  return out;
}

function codecFor(distro: string, type: string): CdrPayloadCodec {
  return cdrPayloadCodec(parseRosMsgDef(definitionText(distro, type), { ros2: true }));
}

function decodeValues(codec: CdrPayloadCodec, payload: Uint8Array): unknown {
  const result = codec.decode(payload);
  if (!result.ok) throw new Error(`undecodable: ${result.reason}: ${result.detail}`);
  return normalizeDecoded(result.message);
}

describe.each(DISTROS)('golden CDR vectors: %s', (distro) => {
  const file = load(distro);

  it('was generated on the distro it is named for, with rmw_zenoh', () => {
    expect(file.source.distro).toBe(distro);
    expect(file.source.rmw).toBe('rmw_zenoh_cpp');
    expect(file.vectors.length).toBeGreaterThanOrEqual(9);
  });

  describe.each(file.vectors.map((v, i) => [`${i} ${v.type}`, v] as const))(
    '%s',
    (_label, vector) => {
      const payload = hexBytes(vector.cdr);
      const codec = codecFor(distro, vector.type);

      it('matches the field list ROS 2 reports for every type it involves', () => {
        const ours = fieldLists(codec.definitions, shortName(vector.type));
        // Empty: rosidl reports no fields; the parser gives the root no fields too.
        for (const [type, fields] of Object.entries(vector.fields)) {
          expect(ours[type], type).toEqual(fields);
        }
      });

      it('decodes to the values it was built from', () => {
        expect(decodeValues(codec, payload)).toEqual(vector.values);
      });

      it('re-encodes to the same bytes, apart from padding no value is read from', () => {
        const encoded = codec.encode(vector.values);
        expect(decodeValues(codec, encoded)).toEqual(vector.values);

        // ROS 2 may pad the end to a 4- or 8-byte boundary; this codec does not.
        const tail = payload.byteLength - encoded.byteLength;
        const n = encoded.byteLength;
        expect([0, (4 - (n % 4)) % 4, (8 - (n % 8)) % 8]).toContain(tail);

        // Inside, bytes may differ only where CDR pads between fields: ROS 2
        // leaves that padding uninitialised, so it changes from run to run. A
        // byte proves itself padding when no value changes as it does.
        for (let i = 0; i < n; i++) {
          if (payload[i] === encoded[i]) continue;
          const flipped = payload.slice();
          flipped[i] = (flipped[i] ?? 0) ^ 0xff;
          expect(decodeValues(codec, flipped), `byte ${i}`).toEqual(vector.values);
        }
      });
    },
  );
});

describe('golden CDR vectors: across distros', () => {
  it('decodes the Humble Range only with the Humble definition', () => {
    const humble = load('humble').vectors.find((v) => v.type === 'sensor_msgs/msg/Range');
    expect(humble).toBeDefined();
    const payload = hexBytes(humble?.cdr ?? '');
    const later = codecFor('jazzy', 'sensor_msgs/msg/Range').decode(payload);
    expect(later.ok).toBe(false);
    if (!later.ok) expect(later.reason).toBe('malformed');
    expect(codecFor('humble', 'sensor_msgs/msg/Range').decode(payload).ok).toBe(true);
  });

  it('matches the bytes rmw_zenoh put on the wire for /chatter (Jazzy capture)', () => {
    // tests/fixtures/zenoh/chatter.json is a live session against the
    // fixture's router. If the script's bytes differed from it, the script
    // would be wrong, not the wire.
    const capture = JSON.parse(readFileSync(join(FIXTURES, 'zenoh', 'chatter.json'), 'utf8')) as {
      source: { distro: string };
      observed: { pushes: { payload: string }[] };
    };
    expect(capture.source.distro).toBe('jazzy');
    const wire = capture.observed.pushes[0]?.payload;
    const scripted = load('jazzy').vectors.find(
      (v) => v.type === 'std_msgs/msg/String' && v.values.data === 'integration',
    );
    expect(wire).toBeDefined();
    expect(scripted?.cdr).toBe(wire);
  });
});
