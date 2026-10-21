// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * The public definition built from a parser's output (ADR 0032): one flat map
 * of three-part names, ROS 2 field types, `nanosec` time, constants beside
 * the fields. Both parsers answer the same schema the same way.
 */

import { describe, it, expect } from 'vitest';
import { parse as parseRosMsgDef } from '@foxglove/rosmsg';
import { parseRos2idl } from '@foxglove/ros2idl-parser';
import type { MessageDefinition } from '@foxglove/message-definition';
import {
  goalDefinition,
  rawTypesDefinition,
  toSchemaDefinition as toDefinitionOrNull,
} from '../src/schemaDefinition';
import type { SchemaDefinition } from '../src/types';

/** For the cases that must be described: a `null` fails the test here. */
function toSchemaDefinition(defs: MessageDefinition[], root: string): SchemaDefinition {
  const def = toDefinitionOrNull(defs, root);
  expect(def).not.toBeNull();
  return def!;
}

const SEP = '='.repeat(80);

const MSG = `uint8 c
string<=5 s
int32[<=3] bs
uint8[4] fx
builtin_interfaces/Time t
float64 w 1.5
string[] names
int64 BIG=9007199254740993
int32 SMALL=3
${SEP}
MSG: builtin_interfaces/Time
int32 sec
uint32 nanosec`;

const IDL = `${SEP}
IDL: pkg/msg/Foo
module pkg { module msg {
  module Foo_Constants { const int64 BIG = 9007199254740993; const int32 SMALL = 3; };
  struct Foo {
    uint8 c;
    string<5> s;
    sequence<int32, 3> bs;
    uint8 fx[4];
    builtin_interfaces::msg::Time t;
    @default (value=1.5) double w;
    sequence<string> names;
  };
}; };
${SEP}
IDL: builtin_interfaces/msg/Time
module builtin_interfaces { module msg { struct Time { int32 sec; uint32 nanosec; }; }; };`;

const TIME = {
  name: 'builtin_interfaces/msg/Time',
  fields: [
    { name: 'sec', type: 'int32', isComplex: false, isArray: false },
    { name: 'nanosec', type: 'uint32', isComplex: false, isArray: false },
  ],
  constants: [],
};

const FOO = {
  root: 'pkg/msg/Foo',
  types: {
    'pkg/msg/Foo': {
      name: 'pkg/msg/Foo',
      fields: [
        { name: 'c', type: 'uint8', isComplex: false, isArray: false },
        { name: 's', type: 'string', isComplex: false, isArray: false, stringUpperBound: 5 },
        { name: 'bs', type: 'int32', isComplex: false, isArray: true, arrayUpperBound: 3 },
        { name: 'fx', type: 'uint8', isComplex: false, isArray: true, arrayLength: 4 },
        { name: 't', type: 'builtin_interfaces/msg/Time', isComplex: true, isArray: false },
        { name: 'w', type: 'float64', isComplex: false, isArray: false, defaultValue: 1.5 },
        { name: 'names', type: 'string', isComplex: false, isArray: true },
      ],
      constants: [
        { name: 'BIG', type: 'int64', value: 9007199254740993n },
        { name: 'SMALL', type: 'int32', value: 3 },
      ],
    },
    'builtin_interfaces/msg/Time': TIME,
  },
};

describe('toSchemaDefinition', () => {
  it('reads a ros2msg schema into three-part names, nested Time and typed constants', () => {
    expect(toSchemaDefinition(parseRosMsgDef(MSG, { ros2: true }), 'pkg/msg/Foo')).toEqual(FOO);
  });

  it('reads the same schema written as ros2idl the same way', () => {
    // The IDL parser puts constants in a <Type>_Constants entry ahead of the
    // struct and renames Time's `nanosec` to `nsec`.
    expect(toSchemaDefinition(parseRos2idl(IDL), 'pkg/msg/Foo')).toEqual(FOO);
  });

  it('adds Time even when the ros2msg text never defines it', () => {
    const def = toSchemaDefinition(
      parseRosMsgDef('builtin_interfaces/Time stamp\nbuiltin_interfaces/Duration d', {
        ros2: true,
      }),
      'pkg/msg/Stamped',
    );
    expect(def.types['pkg/msg/Stamped']?.fields.map((f) => f.type)).toEqual([
      'builtin_interfaces/msg/Time',
      'builtin_interfaces/msg/Duration',
    ]);
    expect(def.types['builtin_interfaces/msg/Time']).toEqual(TIME);
    expect(def.types['builtin_interfaces/msg/Duration']?.fields.map((f) => f.name)).toEqual([
      'sec',
      'nanosec',
    ]);
  });

  it('expands two-part nested names to messages, and every complex type is a key', () => {
    const text = `geometry_msgs/Pose pose
${SEP}
MSG: geometry_msgs/Pose
geometry_msgs/Point position
${SEP}
MSG: geometry_msgs/Point
float64 x`;
    const def = toSchemaDefinition(parseRosMsgDef(text, { ros2: true }), 'pkg/msg/Holder');
    expect(Object.keys(def.types).sort()).toEqual([
      'geometry_msgs/msg/Point',
      'geometry_msgs/msg/Pose',
      'pkg/msg/Holder',
    ]);
    for (const t of Object.values(def.types)) {
      for (const f of t.fields) if (f.isComplex) expect(def.types[f.type]).toBeDefined();
    }
  });

  it("keeps an action's own parts as action types inside an action root", () => {
    const text = `unique_identifier_msgs/UUID goal_id
example_interfaces/Fibonacci_Goal goal
${SEP}
MSG: unique_identifier_msgs/UUID
uint8[16] uuid
${SEP}
MSG: example_interfaces/Fibonacci_Goal
int32 order`;
    const def = toSchemaDefinition(
      parseRosMsgDef(text, { ros2: true }),
      'example_interfaces/action/Fibonacci_SendGoal_Request',
    );
    expect(def.types['example_interfaces/action/Fibonacci_SendGoal_Request']?.fields).toEqual([
      { name: 'goal_id', type: 'unique_identifier_msgs/msg/UUID', isComplex: true, isArray: false },
      {
        name: 'goal',
        type: 'example_interfaces/action/Fibonacci_Goal',
        isComplex: true,
        isArray: false,
      },
    ]);
  });

  it('leaves out types the root does not reach', () => {
    const def = toSchemaDefinition(
      parseRos2idl(`${SEP}
IDL: pkg/msg/Used
module pkg { module msg { struct Used { int32 x; }; }; };
${SEP}
IDL: pkg/msg/Unused
module pkg { module msg { struct Unused { int32 y; }; }; };`),
      'pkg/msg/Used',
    );
    expect(Object.keys(def.types)).toEqual(['pkg/msg/Used']);
  });

  it('reads byte and char as uint8, the loss both parsers share (ADR 0032 decision 9)', () => {
    // Pins the documented loss: if a parser starts keeping the difference,
    // this goes red and the TSDoc sentence about it should change.
    const fromMsg = toSchemaDefinition(
      parseRosMsgDef('byte b\nchar c', { ros2: true }),
      'pkg/msg/Bytes',
    );
    const fromIdl = toSchemaDefinition(
      parseRos2idl(`${SEP}
IDL: pkg/msg/Bytes
module pkg { module msg { struct Bytes { octet b; char c; }; }; };`),
      'pkg/msg/Bytes',
    );
    for (const def of [fromMsg, fromIdl]) {
      expect(def.types['pkg/msg/Bytes']?.fields.map((f) => f.type)).toEqual(['uint8', 'uint8']);
    }
  });

  it('gives a fieldless type no fields', () => {
    expect(toSchemaDefinition(parseRosMsgDef('', { ros2: true }), 'std_msgs/msg/Empty')).toEqual({
      root: 'std_msgs/msg/Empty',
      types: { 'std_msgs/msg/Empty': { name: 'std_msgs/msg/Empty', fields: [], constants: [] } },
    });
  });

  it('returns fresh objects each time from one parse', () => {
    const parsed = parseRosMsgDef(MSG, { ros2: true });
    const a = toSchemaDefinition(parsed, 'pkg/msg/Foo');
    a.types['pkg/msg/Foo']!.fields.length = 0;
    expect(toSchemaDefinition(parsed, 'pkg/msg/Foo')).toEqual(FOO);
  });

  // Review leads, 2026-10-21: each went red before its fix.

  it('keeps the constants of a ros2msg type that declares only constants', () => {
    const def = toSchemaDefinition(
      parseRosMsgDef('uint8 AUTO=0\nuint8 MANUAL=1', { ros2: true }),
      'pkg/msg/Mode',
    );
    expect(def?.types['pkg/msg/Mode']).toEqual({
      name: 'pkg/msg/Mode',
      fields: [],
      constants: [
        { name: 'AUTO', type: 'uint8', value: 0 },
        { name: 'MANUAL', type: 'uint8', value: 1 },
      ],
    });
  });

  it('keeps every digit of a 64-bit default above 2^53', () => {
    const def = toSchemaDefinition(
      parseRosMsgDef('uint64 mask 18446744073709551615\nint64 small -5', { ros2: true }),
      'pkg/msg/Mask',
    );
    expect(def?.types['pkg/msg/Mask']?.fields.map((f) => f.defaultValue)).toEqual([
      18446744073709551615n,
      -5n,
    ]);
    const fromIdl = toSchemaDefinition(
      parseRos2idl(`${SEP}
IDL: pkg/msg/Mask
module pkg { module msg { struct Mask {
  @default (value=18446744073709551615) uint64 mask;
}; }; };`),
      'pkg/msg/Mask',
    );
    // The IDL parser has already rounded it and keeps no text: left out, not wrong.
    expect(fromIdl?.types['pkg/msg/Mask']?.fields[0]).not.toHaveProperty('defaultValue');
  });

  it("drops rosidl's placeholder member from an empty IDL struct", () => {
    const def = toSchemaDefinition(
      parseRos2idl(`${SEP}
IDL: std_msgs/msg/Empty
module std_msgs { module msg { struct Empty { uint8 structure_needs_at_least_one_member; }; }; };`),
      'std_msgs/msg/Empty',
    );
    expect(def?.types['std_msgs/msg/Empty']?.fields).toEqual([]);
  });

  it('answers null rather than name a nested type it does not describe', () => {
    // Parser output with a field naming a type it never defines. The .msg
    // parser refuses such text itself, so this is hand-built: a guard for a
    // parser or rosapi text that names a type in a form the lookup misses.
    const def = toDefinitionOrNull(
      [{ definitions: [{ name: 'p', type: 'geometry_msgs/Point', isComplex: true }] }],
      'pkg/msg/Holder',
    );
    expect(def).toBeNull();
  });
});

describe('goalDefinition', () => {
  it("keeps an inlined goal's constants", () => {
    const request = toSchemaDefinition(
      parseRosMsgDef(
        `unique_identifier_msgs/UUID goal_id
uint8 MODE_FAST=1
uint8 mode
${SEP}
MSG: unique_identifier_msgs/UUID
uint8[16] uuid`,
        { ros2: true },
      ),
      'pkg/action/Move_SendGoal_Request',
    )!;
    expect(
      goalDefinition(request, false, 'pkg/action/Move_Goal')?.types['pkg/action/Move_Goal'],
    ).toEqual({
      name: 'pkg/action/Move_Goal',
      fields: [{ name: 'mode', type: 'uint8', isComplex: false, isArray: false }],
      constants: [{ name: 'MODE_FAST', type: 'uint8', value: 1 }],
    });
  });
});

describe('rawTypesDefinition', () => {
  it('tries every topic carrying the type, not only the first', () => {
    const def = rawTypesDefinition(
      {
        topics: ['/a', '/b'],
        types: ['std_msgs/msg/Bool', 'std_msgs/msg/Bool'],
        typedefs_full_text: [null, 'bool data\n'],
      },
      'std_msgs/msg/Bool',
    );
    expect(def?.root).toBe('std_msgs/msg/Bool');
  });
});
