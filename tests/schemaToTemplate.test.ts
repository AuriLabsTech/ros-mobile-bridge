import { describe, it, expect } from 'vitest';
import { parse as parseRosMsgDef } from '@foxglove/rosmsg';
import { parseRos2idl } from '@foxglove/ros2idl-parser';
import { MessageReader, MessageWriter } from '@foxglove/rosmsg2-serialization';
import { rootDefinition, schemaToTemplate } from '../src/schemaToTemplate';

describe('schemaToTemplate', () => {
  it('returns an empty object when given no definitions', () => {
    expect(schemaToTemplate([])).toEqual({});
  });

  it('builds from the type, not from a constants module declared ahead of it', () => {
    // `rosidl` writes a type's constants as a `<Type>_Constants` module before
    // its struct, and `parseRos2idl` keeps that order. The CDR reader and
    // writer skip such a module to find the root; the template must too.
    const defs = parseRos2idl(
      [
        'module pkg {',
        '  module msg {',
        '    module Mode_Constants {',
        '      const uint8 FAST = 1;',
        '    };',
        '    struct Mode {',
        '      uint8 mode;',
        '      string label;',
        '    };',
        '  };',
        '};',
      ].join('\n'),
    );
    expect(schemaToTemplate(defs)).toEqual({ mode: 0, label: '' });
  });

  it('picks the same root as the CDR reader and writer', () => {
    // The reader and writer keep a private copy of the rule. If a library
    // upgrade changes theirs, this goes red before templates and the goal
    // check quietly start describing a different type than the encoder.
    const defs = parseRos2idl(
      [
        'module pkg {',
        '  module msg {',
        '    module Mode_Constants {',
        '      const uint8 FAST = 1;',
        '    };',
        '    struct Mode {',
        '      uint8 mode;',
        '      string label;',
        '    };',
        '  };',
        '};',
      ].join('\n'),
    );
    const root = rootDefinition(defs)!;
    const decoded = new MessageReader(defs).readMessage(
      new MessageWriter(defs).writeMessage({ mode: 3, label: 'x' }),
    ) as Record<string, unknown>;
    expect(Object.keys(decoded)).toEqual(
      root.definitions.filter((f) => f.isConstant !== true).map((f) => f.name),
    );
  });

  it('gives an empty template for a type made only of constants', () => {
    const defs = parseRosMsgDef('uint8 PARAMETER_NOT_SET=0\nuint8 PARAMETER_BOOL=1\n', {
      ros2: true,
    });
    expect(schemaToTemplate(defs)).toEqual({});
  });

  it('names a ROS 2 time field nanosec, as the decoder and rosbridge do', () => {
    // The ros2msg parser turns builtin_interfaces/Time into the primitive
    // `time`. Up to 0.1.16 its template said `nsec`, the ROS 1 name, so a
    // body written with the real field name looked like an unknown field.
    const defs = parseRosMsgDef('builtin_interfaces/Time stamp\nbuiltin_interfaces/Duration d\n', {
      ros2: true,
    });
    expect(schemaToTemplate(defs)).toEqual({
      stamp: { sec: 0, nanosec: 0 },
      d: { sec: 0, nanosec: 0 },
    });
  });

  it('builds a template with primitive defaults', () => {
    const template = schemaToTemplate([
      {
        name: 'geometry_msgs/msg/Vector3',
        definitions: [
          { name: 'x', type: 'float64', isArray: false, isComplex: false },
          { name: 'y', type: 'float64', isArray: false, isComplex: false },
          { name: 'z', type: 'float64', isArray: false, isComplex: false },
        ],
      },
    ]);

    expect(template).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('handles arrays as empty by default', () => {
    const template = schemaToTemplate([
      {
        name: 'sensor_msgs/msg/JointState',
        definitions: [
          { name: 'name', type: 'string', isArray: true, isComplex: false },
          { name: 'position', type: 'float64', isArray: true, isComplex: false },
        ],
      },
    ]);

    expect(template).toEqual({ name: [], position: [] });
  });

  it('resolves complex types via the type map', () => {
    const template = schemaToTemplate([
      {
        name: 'geometry_msgs/msg/Twist',
        definitions: [
          {
            name: 'linear',
            type: 'geometry_msgs/msg/Vector3',
            isArray: false,
            isComplex: true,
          },
          {
            name: 'angular',
            type: 'geometry_msgs/msg/Vector3',
            isArray: false,
            isComplex: true,
          },
        ],
      },
      {
        name: 'geometry_msgs/msg/Vector3',
        definitions: [
          { name: 'x', type: 'float64', isArray: false, isComplex: false },
          { name: 'y', type: 'float64', isArray: false, isComplex: false },
          { name: 'z', type: 'float64', isArray: false, isComplex: false },
        ],
      },
    ]);

    expect(template).toEqual({
      linear: { x: 0, y: 0, z: 0 },
      angular: { x: 0, y: 0, z: 0 },
    });
  });

  it('skips constants', () => {
    const template = schemaToTemplate([
      {
        name: 'std_msgs/msg/HasConstant',
        definitions: [
          {
            name: 'CONST_VALUE',
            type: 'int32',
            isArray: false,
            isComplex: false,
            isConstant: true,
            value: 42,
          },
          { name: 'data', type: 'string', isArray: false, isComplex: false },
        ],
      },
    ]);

    expect(template).toEqual({ data: '' });
  });

  it('deep-copies object primitive defaults so callers can mutate safely', () => {
    const t1 = schemaToTemplate([
      {
        name: 'std_msgs/msg/Header',
        definitions: [
          {
            name: 'stamp',
            type: 'builtin_interfaces/msg/Time',
            isArray: false,
            isComplex: false,
          },
        ],
      },
    ]);
    const t2 = schemaToTemplate([
      {
        name: 'std_msgs/msg/Header',
        definitions: [
          {
            name: 'stamp',
            type: 'builtin_interfaces/msg/Time',
            isArray: false,
            isComplex: false,
          },
        ],
      },
    ]);

    (t1.stamp as Record<string, number>).sec = 42;

    expect((t2.stamp as Record<string, number>).sec).toBe(0);
  });

  it('returns empty object on circular type references past depth 10', () => {
    const template = schemaToTemplate([
      {
        name: 'self/Ref',
        definitions: [{ name: 'next', type: 'self/Ref', isArray: false, isComplex: true }],
      },
    ]);

    // Just verify it terminates and returns something object-shaped.
    expect(template).toBeTypeOf('object');
  });
});
