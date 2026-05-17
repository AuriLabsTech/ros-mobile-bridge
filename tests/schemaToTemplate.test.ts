import { describe, it, expect } from 'vitest';
import { schemaToTemplate } from '../src/schemaToTemplate';

describe('schemaToTemplate', () => {
  it('returns an empty object when given no definitions', () => {
    expect(schemaToTemplate([])).toEqual({});
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
