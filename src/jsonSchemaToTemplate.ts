// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * jsonSchemaToTemplate — derive a zero-valued JSON payload from a JSON Schema.
 *
 * Used by the Foxglove WebSocket path to turn bridges that ship JSON Schema
 * into Topic-Publisher / field-path templates. The reference foxglove_bridge
 * ships ros2idl instead, which `schemaToTemplate` handles; this parser
 * covers the remaining gap so consumers don't need a hard-coded table of
 * well-known ROS 2 types.
 *
 * Scope: draft-07-compatible JSON Schema, restricted to the subset a bridge
 * typically emits for ROS message shapes (object / array / primitive).
 * Does not resolve `$ref`, `allOf` / `oneOf` / `anyOf`, or enum defaults.
 */

export function jsonSchemaToTemplate(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
  const s = schema as Record<string, unknown>;

  // Explicit `default` wins over type-derived zero value.
  if ('default' in s) return s.default;

  const type = s.type;
  if (type === 'object') {
    const props = s.properties;
    if (!props || typeof props !== 'object' || Array.isArray(props)) return {};
    const result: Record<string, unknown> = {};
    for (const [key, sub] of Object.entries(props as Record<string, unknown>)) {
      result[key] = jsonSchemaToTemplate(sub);
    }
    return result;
  }

  if (type === 'array') {
    // Zero-length array matches the ROS shape for variable-length fields
    // (JointState.name, LaserScan.ranges, etc.).
    return [];
  }

  if (type === 'string') return '';
  if (type === 'number' || type === 'integer') return 0;
  if (type === 'boolean') return false;
  if (type === 'null') return null;

  // Union type (e.g. ['number', 'null']) — pick the first non-null entry.
  if (Array.isArray(type)) {
    const first = type.find((t) => t !== 'null') ?? type[0];
    return jsonSchemaToTemplate({ ...s, type: first });
  }

  return null;
}
