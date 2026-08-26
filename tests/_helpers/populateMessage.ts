// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * Fill a parsed message definition with distinctive, deterministic values.
 *
 * `schemaToTemplate` in `src/` produces zeros; this produces the opposite. A
 * round-trip through the real `MessageWriter` and `MessageReader` only proves
 * something if every field carries a value that is neither the type's zero nor
 * the schema's declared default, because both of those are what a *broken*
 * encoder writes. `nav2_msgs/action/DockRobot_SendGoal_Request` is the worked
 * example: it declares `use_dock_id True` and `max_staging_time 1000.0`, so an
 * encoder that serializes the schema instead of the caller's payload still
 * produces a message that is not all-zero.
 *
 * Values are derived from a running counter, so they are stable across runs
 * and a failure names the same field every time.
 */

import type { MessageDefinition, MessageDefinitionField } from '@foxglove/message-definition';

const TIME_LIKE = new Set([
  'builtin_interfaces/Time',
  'builtin_interfaces/Duration',
  'builtin_interfaces/msg/Time',
  'builtin_interfaces/msg/Duration',
]);

/** Populate the root definition of a parsed schema. */
export function populateMessage(definitions: MessageDefinition[]): Record<string, unknown> {
  const typeMap = new Map<string, MessageDefinition>();
  for (const def of definitions) {
    if (def.name) typeMap.set(def.name, def);
  }
  const root = definitions[0];
  if (!root) return {};
  return buildObject(root, typeMap, { n: 0 }, 0);
}

interface Counter {
  n: number;
}

function buildObject(
  def: MessageDefinition,
  typeMap: Map<string, MessageDefinition>,
  counter: Counter,
  depth: number,
): Record<string, unknown> {
  if (depth > 10) return {};
  const out: Record<string, unknown> = {};
  for (const field of def.definitions) {
    if (field.isConstant) continue;
    out[field.name] = buildField(field, typeMap, counter, depth);
  }
  return out;
}

function buildField(
  field: MessageDefinitionField,
  typeMap: Map<string, MessageDefinition>,
  counter: Counter,
  depth: number,
): unknown {
  if (!field.isArray) return buildValue(field.type, field.isComplex, typeMap, counter, depth);

  // A fixed-length array must carry exactly its declared count: CDR writes no
  // length prefix for one, so any other count is a writer error. A bounded
  // array must stay within its upper bound. Everything else gets three
  // elements, enough for an element-order bug to show.
  const fixed = field.arrayLength;
  const bound = field.arrayUpperBound;
  const count =
    typeof fixed === 'number' ? fixed : Math.min(3, typeof bound === 'number' ? bound : 3);
  return Array.from({ length: count }, () =>
    buildValue(field.type, field.isComplex, typeMap, counter, depth),
  );
}

function buildValue(
  type: string,
  isComplex: boolean | undefined,
  typeMap: Map<string, MessageDefinition>,
  counter: Counter,
  depth: number,
): unknown {
  const n = ++counter.n;

  switch (type) {
    case 'bool':
      // Alternating, so a field whose schema default is `True` gets `false`
      // for half the fixtures and a default-writing encoder is caught.
      return n % 2 === 0;
    case 'int8':
    case 'uint8':
    case 'int16':
    case 'uint16':
    case 'int32':
    case 'uint32':
      return (n % 100) + 1;
    case 'int64':
    case 'uint64':
      return BigInt((n % 100) + 1);
    case 'float32':
      // Exactly representable in 32 bits, so the round-trip compares equal
      // without an epsilon and a real precision bug still shows.
      return Math.fround(n + 0.5);
    case 'float64':
      return n + 0.25;
    case 'string':
    case 'wstring':
      return `fixture-${n}`;
    case 'time':
    case 'duration':
      // `sec,nanosec`, which is what `MessageReader` returns by default and
      // what ROS 2 calls the field. The writer accepts either spelling, so
      // using `nsec` here would fail the comparison, not the encode.
      return { sec: n, nanosec: n * 1000 };
    default:
      break;
  }

  if (TIME_LIKE.has(type)) return { sec: n, nanosec: n * 1000 };

  if (isComplex) {
    const sub = typeMap.get(type) ?? findByTail(typeMap, type);
    if (sub) return buildObject(sub, typeMap, counter, depth + 1);
  }

  throw new Error(`populateMessage: unhandled field type "${type}"`);
}

function findByTail(
  typeMap: Map<string, MessageDefinition>,
  typeName: string,
): MessageDefinition | undefined {
  for (const [key, def] of typeMap) {
    if (key.endsWith(`/${typeName}`) || typeName.endsWith(`/${key}`)) return def;
  }
  return undefined;
}

/**
 * Normalize a decoded message for comparison: `MessageReader` returns typed
 * arrays for primitive-array fields, and `toEqual` will not match those
 * against the plain arrays the writer was handed.
 */
export function normalizeDecoded(value: unknown): unknown {
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return Array.from(value as unknown as ArrayLike<number | bigint>);
  }
  if (Array.isArray(value)) return value.map(normalizeDecoded);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalizeDecoded(v);
    }
    return out;
  }
  return value;
}
