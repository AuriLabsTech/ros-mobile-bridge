import * as fc from 'fast-check';
import type { MessageDefinition, MessageDefinitionField } from '@foxglove/message-definition';

/**
 * A fast-check arbitrary producing messages that fit a parsed ROS 2 message
 * definition, with every value one CDR carries exactly: floats are float32
 * values for `float32` fields, strings hold no NUL (CDR terminates strings
 * with one) and no lone surrogate (UTF-8 cannot carry one).
 *
 * The root is the definition with no name, as the parser returns it first.
 */
export function arbitraryMessage(defs: MessageDefinition[]): fc.Arbitrary<Record<string, unknown>> {
  const byName = new Map(defs.filter((d) => d.name).map((d) => [d.name as string, d]));
  const root = defs[0];
  if (!root) throw new Error('empty definition list');

  const forStruct = (def: MessageDefinition): fc.Arbitrary<Record<string, unknown>> => {
    const fields = def.definitions.filter((f) => f.isConstant !== true);
    const record: Record<string, fc.Arbitrary<unknown>> = {};
    for (const f of fields) record[f.name] = forField(f);
    return fc.record(record);
  };

  const forScalar = (field: MessageDefinitionField): fc.Arbitrary<unknown> => {
    if (field.isComplex === true) {
      const nested = byName.get(field.type);
      if (!nested) throw new Error(`no definition for ${field.type}`);
      return forStruct(nested);
    }
    return primitive(field.type);
  };

  const forField = (field: MessageDefinitionField): fc.Arbitrary<unknown> => {
    if (field.isArray !== true) return forScalar(field);
    const n = field.arrayLength;
    return n !== undefined
      ? fc.array(forScalar(field), { minLength: n, maxLength: n })
      : fc.array(forScalar(field), { maxLength: 5 });
  };

  return forStruct(root);
}

const CDR_STRING = fc.string({ unit: 'grapheme', maxLength: 12 }).filter((s) => !s.includes('\0'));

const UINT8 = fc.integer({ min: 0, max: 255 });
const TIME = fc.record({ sec: fc.integer(), nanosec: fc.integer({ min: 0, max: 0xffffffff }) });

const PRIMITIVES: Record<string, fc.Arbitrary<unknown>> = {
  bool: fc.boolean(),
  int8: fc.integer({ min: -128, max: 127 }),
  uint8: UINT8,
  byte: UINT8,
  char: UINT8,
  int16: fc.integer({ min: -32768, max: 32767 }),
  uint16: fc.integer({ min: 0, max: 65535 }),
  int32: fc.integer(),
  uint32: fc.integer({ min: 0, max: 0xffffffff }),
  int64: fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }),
  uint64: fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }),
  float32: fc.float({ noNaN: true }),
  float64: fc.double({ noNaN: true }),
  string: CDR_STRING,
  wstring: CDR_STRING,
  time: TIME,
  duration: TIME,
};

function primitive(type: string): fc.Arbitrary<unknown> {
  const arbitrary = PRIMITIVES[type];
  if (!arbitrary) throw new Error(`no arbitrary for primitive ${type}`);
  return arbitrary;
}
