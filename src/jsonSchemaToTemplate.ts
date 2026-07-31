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
    // A ROS fixed-size array (`double[9]`) reaches JSON Schema as
    // `minItems === maxItems === 9`: an instance carrying any other count is
    // invalid, exactly as a fixed array has no CDR length prefix on the
    // ros2idl path. Materialize the required elements so a derived template
    // stays usable for types like `sensor_msgs/Imu.orientation_covariance`.
    //
    // Variable-length (`T[]`, no keyword) and bounded (`T[<=N]`, `maxItems`
    // only) arrays are both legal when empty, so they stay `[]`, which is also
    // the ROS shape for JointState.name, LaserScan.ranges, etc.
    const minItems = s.minItems;
    if (typeof minItems === 'number' && minItems > 0) {
      return Array.from({ length: minItems }, () => jsonSchemaToTemplate(s.items));
    }
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
