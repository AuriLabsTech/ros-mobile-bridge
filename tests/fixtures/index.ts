// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * Typed access to the advertised-schema fixture corpus.
 *
 * The corpus holds schema strings a real bridge sent, verbatim, with the
 * capture metadata beside them. Read `tests/fixtures/README.md` before adding
 * an entry: entries are captures, never hand-written schemas.
 */

import corpus from './advertised-schemas.json';

/** One side (request or response) of a captured service advertisement. */
export interface CapturedSchema {
  /** The `schemaName` the bridge advertised, e.g. `nav2_msgs/action/DockRobot_SendGoal_Request`. */
  schemaName: string;
  /** The advertised `encoding`, e.g. `ros2msg`. */
  encoding: string;
  /** The schema text, exactly as it arrived. */
  schema: string;
}

/** One service from a captured `advertiseServices` frame. */
export interface CapturedService {
  /** ROS service name, e.g. `/dock/_action/send_goal`. */
  name: string;
  /** ROS service type, e.g. `nav2_msgs/action/DockRobot_SendGoal`. */
  type: string;
  request: CapturedSchema;
  response: CapturedSchema;
}

/** One capture session: a set of services plus where and when they came from. */
export interface SchemaCapture {
  capturedUtc: string;
  source: string;
  rosDistro: string;
  foxgloveLibrary: string;
  subprotocol: string;
  services: CapturedService[];
}

const captures = corpus.captures as SchemaCapture[];

/** Every capture in the corpus. */
export const SCHEMA_CAPTURES: readonly SchemaCapture[] = captures;

/** Every captured service across every capture, flattened. */
export const CAPTURED_SERVICES: readonly CapturedService[] = captures.flatMap((c) => c.services);

/**
 * One captured service by ROS type. Throws rather than returning `undefined`:
 * a test naming a fixture that is not in the corpus is a broken test, and a
 * silent `undefined` would make it look like a passing one.
 */
export function capturedService(type: string): CapturedService {
  const found = CAPTURED_SERVICES.find((s) => s.type === type);
  if (!found) {
    throw new Error(
      `No captured service of type "${type}" in the fixture corpus. Available: ${CAPTURED_SERVICES.map((s) => s.type).join(', ')}`,
    );
  }
  return found;
}
