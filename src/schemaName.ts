// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * ROS schema-name helpers.
 *
 * Bridges report the same logical type in two forms depending on ROS version
 * and bridge: the 3-part ROS 2 canonical `pkg/kind/Type`
 * (`geometry_msgs/msg/Twist`) and the 2-part ROS 1 / legacy `pkg/Type`
 * (`geometry_msgs/Twist`). Comparing names by exact string therefore gives
 * false mismatches. The kind segment cannot be inferred from a 2-part name, so
 * the only safe canonicalization is to *strip* the kind, never to insert one.
 */

// Matches a 3-part name whose middle segment is a recognized ROS 2 interface
// kind. Package and type names are single path segments (no embedded slash).
const INTERFACE_KIND = /^([^/]+)\/(?:msg|srv|action)\/([^/]+)$/;

/**
 * Reduce `pkg/kind/Type` to `pkg/Type` by dropping a recognized interface-kind
 * segment (`msg` / `srv` / `action`). Names already in 2-part form, or whose
 * middle segment is not a recognized kind, pass through unchanged. Internal —
 * the basis for the exported {@link matchesSchema} and for tolerant builtin
 * lookups; not re-exported from `index.ts`.
 */
export function stripInterfaceKind(name: string): string {
  const m = INTERFACE_KIND.exec(name);
  return m ? `${m[1]}/${m[2]}` : name;
}

/**
 * Compare two ROS schema names for equality, tolerant of the ROS 1 / ROS 2
 * `msg/` (and `srv/`, `action/`) asymmetry. An exact string compare reports a
 * false mismatch when one side carries the interface-kind segment and the
 * other does not.
 *
 * `matchesSchema` strips the interface-kind segment from both sides and
 * compares `pkg` + `Type`, so it is **kind-agnostic** and handles `msg`,
 * `srv`, and `action` types uniformly. Because the kind is dropped,
 * `pkg/msg/Foo` and `pkg/srv/Foo` compare equal — a theoretical collision that
 * does not arise in practice, since a topic's message type is never compared
 * against a service type. Comparison is exact on the surviving `pkg` and
 * `Type` segments; there is no case or whitespace folding.
 *
 * @example
 * ```ts
 * matchesSchema('sensor_msgs/msg/Image', 'sensor_msgs/Image'); // true
 * matchesSchema('std_srvs/srv/Trigger', 'std_srvs/Trigger');   // true
 * matchesSchema('std_msgs/msg/String', 'std_msgs/msg/Header'); // false
 * ```
 */
export function matchesSchema(a: string, b: string): boolean {
  return stripInterfaceKind(a) === stripInterfaceKind(b);
}
