import { describe, it, expect } from 'vitest';
import { jsonSchemaToTemplate } from '../src/jsonSchemaToTemplate';

// Inputs a bridge should not send but a consumer can still hand over: a
// malformed `properties`, a `minItems` that is not a positive number, and a
// `type` this parser does not know. Each must yield a usable value, never a
// throw.

describe('jsonSchemaToTemplate edge cases', () => {
  it('returns an empty object when `properties` is missing or not an object', () => {
    expect(jsonSchemaToTemplate({ type: 'object' })).toEqual({});
    expect(jsonSchemaToTemplate({ type: 'object', properties: null })).toEqual({});
    expect(jsonSchemaToTemplate({ type: 'object', properties: 5 })).toEqual({});
  });

  it('returns an empty object when `properties` is an array', () => {
    expect(jsonSchemaToTemplate({ type: 'object', properties: [{ type: 'number' }] })).toEqual({});
  });

  it('leaves an array empty when `minItems` is not a number', () => {
    expect(
      jsonSchemaToTemplate({ type: 'array', minItems: '3', items: { type: 'number' } }),
    ).toEqual([]);
  });

  it('leaves an array empty when `minItems` is negative', () => {
    expect(
      jsonSchemaToTemplate({ type: 'array', minItems: -1, items: { type: 'number' } }),
    ).toEqual([]);
  });

  it('returns null for a type it does not know', () => {
    expect(jsonSchemaToTemplate({ type: 'tuple' })).toBeNull();
    expect(jsonSchemaToTemplate({})).toBeNull();
  });

  it('picks the first entry of a union that has no null member', () => {
    expect(jsonSchemaToTemplate({ type: ['string', 'number'] })).toBe('');
  });
});
