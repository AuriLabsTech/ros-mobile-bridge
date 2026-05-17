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

  it('returns an empty array for arrays', () => {
    expect(jsonSchemaToTemplate({ type: 'array', items: { type: 'number' } })).toEqual([]);
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
