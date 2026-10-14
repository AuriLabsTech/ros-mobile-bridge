// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * The bundled service schemas declare the fields the ROS 2 interfaces
 * declare. Parsing cleanly (`builtinSchemas.test.ts`) is not enough on its
 * own: an empty schema also parses cleanly, and then encodes every request
 * as nothing and decodes every response as `{}`.
 *
 * Expected fields are copied from `rcl_interfaces` and `action_msgs` as
 * shipped in ROS 2 Jazzy.
 */

import { describe, it, expect } from 'vitest';
import { parse as parseRosMsgDef } from '@foxglove/rosmsg';
import { MessageReader, MessageWriter } from '@foxglove/rosmsg2-serialization';
import { getBundledServiceSchema } from '../src/builtinSchemas';

/** `name: type` (with `[]` for arrays) of each non-constant top-level field. */
function topLevelFields(schema: string): string[] {
  const root = parseRosMsgDef(schema, { ros2: true })[0]!;
  return root.definitions
    .filter((f) => f.isConstant !== true)
    .map((f) => `${f.name}: ${f.type}${f.isArray === true ? '[]' : ''}`);
}

const EXPECTED: Record<string, { request: string[]; response: string[] }> = {
  'rcl_interfaces/srv/ListParameters': {
    request: ['prefixes: string[]', 'depth: uint64'],
    response: ['result: rcl_interfaces/ListParametersResult'],
  },
  'rcl_interfaces/srv/GetParameters': {
    request: ['names: string[]'],
    response: ['values: rcl_interfaces/ParameterValue[]'],
  },
  'rcl_interfaces/srv/SetParameters': {
    request: ['parameters: rcl_interfaces/Parameter[]'],
    response: ['results: rcl_interfaces/SetParametersResult[]'],
  },
  'rcl_interfaces/srv/DescribeParameters': {
    request: ['names: string[]'],
    response: ['descriptors: rcl_interfaces/ParameterDescriptor[]'],
  },
  'rcl_interfaces/srv/GetParameterTypes': {
    request: ['names: string[]'],
    response: ['types: uint8[]'],
  },
  'action_msgs/srv/CancelGoal': {
    request: ['goal_info: action_msgs/GoalInfo'],
    response: ['return_code: int8', 'goals_canceling: action_msgs/GoalInfo[]'],
  },
};

describe('builtinSchemas — each bundled service declares the interface’s fields', () => {
  for (const [type, expected] of Object.entries(EXPECTED)) {
    it(`${type}: request and response fields`, () => {
      const b = getBundledServiceSchema(type)!;
      expect(topLevelFields(b.request)).toEqual(expected.request);
      expect(topLevelFields(b.response)).toEqual(expected.response);
    });
  }

  it('ListParameters response decodes names and prefixes from the nested result', () => {
    const b = getBundledServiceSchema('rcl_interfaces/srv/ListParameters')!;
    const defs = parseRosMsgDef(b.response, { ros2: true });
    const response = { result: { names: ['use_sim_time', 'rate'], prefixes: ['ns'] } };
    const bytes = new MessageWriter(defs).writeMessage(response);
    expect(new MessageReader(defs).readMessage(bytes)).toEqual(response);
  });

  it('GetParameterTypes response decodes the type codes', () => {
    const b = getBundledServiceSchema('rcl_interfaces/srv/GetParameterTypes')!;
    const defs = parseRosMsgDef(b.response, { ros2: true });
    const bytes = new MessageWriter(defs).writeMessage({ types: new Uint8Array([1, 4]) });
    expect(new MessageReader(defs).readMessage(bytes)).toEqual({ types: new Uint8Array([1, 4]) });
  });
});
