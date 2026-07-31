import { describe, it, expect } from 'vitest';
import { jsonSchemaToTemplate } from '../src/jsonSchemaToTemplate';

describe('jsonSchemaToTemplate', () => {
  it('returns zero values for primitives', () => {
    expect(jsonSchemaToTemplate({ type: 'string' })).toBe('');
    expect(jsonSchemaToTemplate({ type: 'number' })).toBe(0);
    expect(jsonSchemaToTemplate({ type: 'integer' })).toBe(0);
    expect(jsonSchemaToTemplate({ type: 'boolean' })).toBe(false);
    expect(jsonSchemaToTemplate({ type: 'null' })).toBeNull();
  });

  it('builds objects from properties', () => {
    expect(
      jsonSchemaToTemplate({
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'string' },
        },
      }),
    ).toEqual({ x: 0, y: '' });
  });

  it('returns an empty array for variable-length arrays', () => {
    expect(jsonSchemaToTemplate({ type: 'array', items: { type: 'number' } })).toEqual([]);
  });

  it('fills fixed-length arrays to minItems', () => {
    // `unique_identifier_msgs/UUID.uuid` is `uint8[16]`.
    expect(
      jsonSchemaToTemplate({
        type: 'array',
        items: { type: 'integer' },
        minItems: 16,
        maxItems: 16,
      }),
    ).toEqual(new Array(16).fill(0));
  });

  it('leaves bounded arrays empty (maxItems without minItems)', () => {
    // `T[<=N]` is legal when empty; only a fixed size demands elements.
    expect(
      jsonSchemaToTemplate({ type: 'array', items: { type: 'number' }, maxItems: 8 }),
    ).toEqual([]);
    expect(
      jsonSchemaToTemplate({ type: 'array', items: { type: 'number' }, minItems: 0 }),
    ).toEqual([]);
  });

  it('fills fixed-length arrays of complex elements', () => {
    expect(
      jsonSchemaToTemplate({
        type: 'array',
        items: { type: 'object', properties: { x: { type: 'number' }, id: { type: 'string' } } },
        minItems: 2,
        maxItems: 2,
      }),
    ).toEqual([
      { x: 0, id: '' },
      { x: 0, id: '' },
    ]);
  });

  it('fills fixed-length array fields nested in a message', () => {
    // `sensor_msgs/Imu.orientation_covariance` is `double[9]`; `header.stamp`
    // is variable-free and `angular_velocity` is a plain nested object.
    expect(
      jsonSchemaToTemplate({
        type: 'object',
        properties: {
          orientation_covariance: {
            type: 'array',
            items: { type: 'number' },
            minItems: 9,
            maxItems: 9,
          },
          angular_velocity: {
            type: 'object',
            properties: { x: { type: 'number' } },
          },
        },
      }),
    ).toEqual({
      orientation_covariance: new Array(9).fill(0),
      angular_velocity: { x: 0 },
    });
  });

  it('produces distinct element instances, not a shared reference', () => {
    const filled = jsonSchemaToTemplate({
      type: 'array',
      items: { type: 'object', properties: { x: { type: 'number' } } },
      minItems: 2,
      maxItems: 2,
    }) as Array<Record<string, unknown>>;
    const [first, second] = filled;
    if (!first || !second) throw new Error('expected two filled elements');
    first.x = 1;
    expect(second.x).toBe(0);
  });

  it('honours an explicit `default` over the fixed-length fill', () => {
    expect(
      jsonSchemaToTemplate({
        type: 'array',
        items: { type: 'integer' },
        minItems: 4,
        maxItems: 4,
        default: [1, 2, 3, 4],
      }),
    ).toEqual([1, 2, 3, 4]);
  });

  it('uses an explicit `default` over the type-derived value', () => {
    expect(jsonSchemaToTemplate({ type: 'number', default: 7 })).toBe(7);
    expect(jsonSchemaToTemplate({ type: 'string', default: 'hi' })).toBe('hi');
  });

  it('handles union types by picking the first non-null option', () => {
    expect(jsonSchemaToTemplate({ type: ['null', 'number'] })).toBe(0);
    expect(jsonSchemaToTemplate({ type: ['string', 'null'] })).toBe('');
  });

  it('returns null on non-object or null inputs', () => {
    expect(jsonSchemaToTemplate(null)).toBeNull();
    expect(jsonSchemaToTemplate(undefined)).toBeNull();
    expect(jsonSchemaToTemplate('not-a-schema')).toBeNull();
    expect(jsonSchemaToTemplate([])).toBeNull();
  });

  it('handles nested objects', () => {
    expect(
      jsonSchemaToTemplate({
        type: 'object',
        properties: {
          header: {
            type: 'object',
            properties: {
              frame_id: { type: 'string' },
            },
          },
          values: { type: 'array' },
        },
      }),
    ).toEqual({
      header: { frame_id: '' },
      values: [],
    });
  });
});
