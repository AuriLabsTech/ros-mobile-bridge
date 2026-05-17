/**
 * schemaToTemplate — derive a default JSON payload from a parsed ROS message
 * definition.
 *
 * Takes the array returned by `@foxglove/rosmsg` (for `.msg` and ros2msg) or
 * `@foxglove/ros2idl-parser` (for ros2idl). The first element is the root
 * message; subsequent elements are referenced types. Returns a plain object
 * with every field set to its zero / empty default, ready to use as a
 * starting point for a publish payload editor.
 */

import type { MessageDefinition } from '@foxglove/message-definition';

const PRIMITIVE_DEFAULTS: Record<string, unknown> = {
  bool: false,
  int8: 0,
  uint8: 0,
  int16: 0,
  uint16: 0,
  int32: 0,
  uint32: 0,
  int64: 0,
  uint64: 0,
  float32: 0.0,
  float64: 0.0,
  string: '',
  wstring: '',
  time: { sec: 0, nsec: 0 },
  duration: { sec: 0, nsec: 0 },
  'builtin_interfaces/Time': { sec: 0, nanosec: 0 },
  'builtin_interfaces/Duration': { sec: 0, nanosec: 0 },
  'builtin_interfaces/msg/Time': { sec: 0, nanosec: 0 },
  'builtin_interfaces/msg/Duration': { sec: 0, nanosec: 0 },
};

/**
 * Build a default JSON template from a parsed message definition. Used by
 * `IProtocolClient.getSchemaTemplate` to surface ready-to-edit payloads for
 * publish UIs.
 */
export function schemaToTemplate(
  definitions: MessageDefinition[],
): Record<string, unknown> {
  if (!definitions.length) return {};

  const typeMap = new Map<string, MessageDefinition>();
  for (const def of definitions) {
    if (def.name) {
      typeMap.set(def.name, def);
    }
  }

  const root = definitions[0];
  if (!root) return {};
  return buildObject(root, typeMap, 0);
}

function buildObject(
  def: MessageDefinition,
  typeMap: Map<string, MessageDefinition>,
  depth: number,
): Record<string, unknown> {
  // Guard against self-referencing types.
  if (depth > 10) return {};

  const result: Record<string, unknown> = {};

  for (const field of def.definitions) {
    if (field.isConstant) continue;

    const defaultVal = getFieldDefault(field.type, field.isComplex, typeMap, depth);

    if (field.isArray) {
      result[field.name] = [];
    } else {
      result[field.name] = defaultVal;
    }
  }

  return result;
}

function getFieldDefault(
  typeName: string,
  isComplex: boolean | undefined,
  typeMap: Map<string, MessageDefinition>,
  depth: number,
): unknown {
  if (PRIMITIVE_DEFAULTS[typeName] !== undefined) {
    const val = PRIMITIVE_DEFAULTS[typeName];
    return typeof val === 'object' ? JSON.parse(JSON.stringify(val)) : val;
  }

  if (isComplex) {
    const subDef = typeMap.get(typeName);
    if (subDef) {
      return buildObject(subDef, typeMap, depth + 1);
    }
    for (const [key, def] of typeMap) {
      if (key.endsWith(`/${typeName}`) || typeName.endsWith(`/${key}`)) {
        return buildObject(def, typeMap, depth + 1);
      }
    }
  }

  return '';
}
