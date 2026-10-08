import { describe, it, expect } from 'vitest';
import type { MessageDefinition } from '@foxglove/message-definition';
import { schemaToTemplate } from '../src/schemaToTemplate';

// The contract details of schemaToTemplate that the basic suite leaves
// implicit: the default for every primitive, the fill value of fixed arrays,
// how a referenced type is found when its name is written differently from
// the definition's, and where the depth guard cuts.

function field(name: string, type: string, extra: Record<string, unknown> = {}) {
  return { name, type, isArray: false, isComplex: false, ...extra };
}

describe('schemaToTemplate contract', () => {
  it('gives every primitive its zero value', () => {
    const template = schemaToTemplate([
      {
        name: 'test_msgs/msg/AllPrimitives',
        definitions: [
          field('b', 'bool'),
          field('s', 'string'),
          field('w', 'wstring'),
          field('i', 'int32'),
          field('f', 'float64'),
        ],
      },
    ]);

    expect(template).toEqual({ b: false, s: '', w: '', i: 0, f: 0 });
  });

  it('gives time and duration their ROS 1 and ROS 2 shapes', () => {
    const template = schemaToTemplate([
      {
        name: 'test_msgs/msg/Times',
        definitions: [
          field('t1', 'time'),
          field('d1', 'duration'),
          field('t2', 'builtin_interfaces/Time'),
          field('d2', 'builtin_interfaces/Duration'),
          field('t3', 'builtin_interfaces/msg/Time'),
          field('d3', 'builtin_interfaces/msg/Duration'),
        ],
      },
    ]);

    expect(template).toEqual({
      t1: { sec: 0, nsec: 0 },
      d1: { sec: 0, nsec: 0 },
      t2: { sec: 0, nanosec: 0 },
      d2: { sec: 0, nanosec: 0 },
      t3: { sec: 0, nanosec: 0 },
      d3: { sec: 0, nanosec: 0 },
    });
  });

  it('fills a fixed-length primitive array with zero values', () => {
    const template = schemaToTemplate([
      {
        name: 'test_msgs/msg/Fixed',
        definitions: [field('data', 'uint8', { isArray: true, arrayLength: 3 })],
      },
    ]);

    expect(template).toEqual({ data: [0, 0, 0] });
  });

  it('resolves a short type name against a fully qualified definition', () => {
    // A field written `Point` must find `geometry_msgs/msg/Point`.
    const template = schemaToTemplate([
      {
        name: 'geometry_msgs/msg/Pose',
        definitions: [field('position', 'Point', { isComplex: true })],
      },
      {
        name: 'geometry_msgs/msg/Point',
        definitions: [field('x', 'float64'), field('y', 'float64')],
      },
    ]);

    expect(template).toEqual({ position: { x: 0, y: 0 } });
  });

  it('resolves a fully qualified type name against a short definition', () => {
    const template = schemaToTemplate([
      {
        name: 'geometry_msgs/msg/Pose',
        definitions: [field('position', 'geometry_msgs/msg/Point', { isComplex: true })],
      },
      {
        name: 'Point',
        definitions: [field('x', 'float64')],
      },
    ]);

    expect(template).toEqual({ position: { x: 0 } });
  });

  it('ignores an unnamed root while resolving a referenced type by suffix', () => {
    // Parsers return the root without a name; it must not take part in the
    // name lookup for the types it references.
    const template = schemaToTemplate([
      { definitions: [field('position', 'Point', { isComplex: true })] },
      { name: 'geometry_msgs/msg/Point', definitions: [field('x', 'float64')] },
    ]);

    expect(template).toEqual({ position: { x: 0 } });
  });

  it('does not match a type name that is only a prefix of a definition', () => {
    const template = schemaToTemplate([
      {
        name: 'test_msgs/msg/Outer',
        definitions: [field('inner', 'test_msgs', { isComplex: true })],
      },
      { name: 'test_msgs/msg/Inner', definitions: [field('x', 'float64')] },
    ]);

    expect(template).toEqual({ inner: '' });
  });

  it('stops a self-referencing type reached by suffix lookup', () => {
    const template = schemaToTemplate([
      {
        name: 'test_msgs/msg/Node',
        definitions: [field('v', 'int32'), field('next', 'Node', { isComplex: true })],
      },
    ]);

    expect(template.v).toBe(0);
    expect(template.next).toBeTypeOf('object');
  });

  it('builds ten nested levels below the root and cuts the eleventh', () => {
    const template = schemaToTemplate([
      {
        name: 'test_msgs/msg/Node',
        definitions: [
          field('v', 'int32'),
          field('next', 'test_msgs/msg/Node', { isComplex: true }),
        ],
      },
    ]);

    let level: Record<string, unknown> = template;
    for (let depth = 0; depth < 10; depth++) {
      level = level.next as Record<string, unknown>;
    }
    // Depth 10 is still built; its `next` is where the guard returns `{}`.
    expect(level).toEqual({ v: 0, next: {} });
  });

  it('does not resolve a field the parser marked primitive against the type map', () => {
    const definitions: MessageDefinition[] = [
      { name: 'test_msgs/msg/Outer', definitions: [field('x', 'test_msgs/msg/Inner')] },
      { name: 'test_msgs/msg/Inner', definitions: [field('y', 'float64')] },
    ];

    expect(schemaToTemplate(definitions)).toEqual({ x: '' });
  });

  it('falls back to an empty string for a complex type it cannot find', () => {
    const template = schemaToTemplate([
      {
        name: 'test_msgs/msg/Outer',
        definitions: [field('missing', 'other_msgs/msg/Missing', { isComplex: true })],
      },
    ]);

    expect(template).toEqual({ missing: '' });
  });
});
