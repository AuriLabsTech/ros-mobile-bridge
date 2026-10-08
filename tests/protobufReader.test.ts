// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * `ProtobufReader` on its own, for the descriptor shapes the client-level
 * suite (`FoxgloveClient.protobuf.test.ts`) does not reach: nested and
 * package-less types, a file imported along two paths, repeated messages,
 * and the template of every field kind.
 */

import { describe, it, expect } from 'vitest';
import { ProtobufReader } from '../src/protobufReader';
import { descriptorSetBase64, T, L, type FileInit } from './_helpers/protobufDescriptor';

const mapEntry = (name: string, key: object, value: object) => ({
  name,
  options: { mapEntry: true },
  field: [
    { name: 'key', number: 1, label: L.OPTIONAL, ...key },
    { name: 'value', number: 2, label: L.OPTIONAL, ...value },
  ],
});

/**
 * ```proto
 * package demo;
 * message Outer {
 *   message Inner { int32 n = 1; }
 *   Inner inner = 1;
 *   repeated Inner items = 2;
 * }
 * ```
 */
const OUTER_FILE: FileInit = {
  name: 'demo/outer.proto',
  package: 'demo',
  syntax: 'proto3',
  messageType: [
    {
      name: 'Outer',
      nestedType: [
        { name: 'Inner', field: [{ name: 'n', number: 1, type: T.INT32, label: L.OPTIONAL }] },
      ],
      field: [
        {
          name: 'inner',
          number: 1,
          type: T.MESSAGE,
          typeName: '.demo.Outer.Inner',
          label: L.OPTIONAL,
        },
        {
          name: 'items',
          number: 2,
          type: T.MESSAGE,
          typeName: '.demo.Outer.Inner',
          label: L.REPEATED,
        },
      ],
    },
  ],
};

describe('ProtobufReader — finding the type', () => {
  it('decodes a message type nested inside another', () => {
    const reader = new ProtobufReader(descriptorSetBase64(OUTER_FILE), 'demo.Outer.Inner');
    // 1 n: 5
    expect(reader.readMessage(new Uint8Array([0x08, 0x05]))).toEqual({ n: 5 });
  });

  it('decodes a type from a file that declares no package', () => {
    const schema = descriptorSetBase64({
      name: 'bare.proto',
      syntax: 'proto3',
      messageType: [
        { name: 'Bare', field: [{ name: 'n', number: 1, type: T.INT32, label: L.OPTIONAL }] },
      ],
    });
    const reader = new ProtobufReader(schema, 'Bare');
    expect(reader.readMessage(new Uint8Array([0x08, 0x03]))).toEqual({ n: 3 });
  });

  it('throws naming the type when no file in the set defines it', () => {
    expect(() => new ProtobufReader(descriptorSetBase64(OUTER_FILE), 'demo.Missing')).toThrow(
      'descriptor does not define message "demo.Missing"',
    );
  });

  it('decodes when one file is imported along two paths', () => {
    // top imports a and b, and both import common: the shape of the SDK's
    // ImageAnnotations set, where common must be registered exactly once.
    const common: FileInit = {
      name: 'demo/common.proto',
      package: 'demo',
      syntax: 'proto3',
      messageType: [
        { name: 'C', field: [{ name: 'n', number: 1, type: T.INT32, label: L.OPTIONAL }] },
      ],
    };
    const holder = (file: string, name: string): FileInit => ({
      name: file,
      package: 'demo',
      syntax: 'proto3',
      dependency: ['demo/common.proto'],
      messageType: [
        {
          name,
          field: [
            { name: 'c', number: 1, type: T.MESSAGE, typeName: '.demo.C', label: L.OPTIONAL },
          ],
        },
      ],
    });
    const top: FileInit = {
      name: 'demo/top.proto',
      package: 'demo',
      syntax: 'proto3',
      dependency: ['demo/a.proto', 'demo/b.proto'],
      messageType: [
        {
          name: 'Top',
          field: [
            { name: 'a', number: 1, type: T.MESSAGE, typeName: '.demo.A', label: L.OPTIONAL },
            { name: 'b', number: 2, type: T.MESSAGE, typeName: '.demo.B', label: L.OPTIONAL },
          ],
        },
      ],
    };
    const schema = descriptorSetBase64(
      top,
      holder('demo/a.proto', 'A'),
      holder('demo/b.proto', 'B'),
      common,
    );
    const reader = new ProtobufReader(schema, 'demo.Top');
    // 1 a: { 1 c: { 1 n: 1 } }, 2 b: { 1 c: { 1 n: 2 } }
    // prettier-ignore
    const payload = new Uint8Array([
      0x0a, 0x04, 0x0a, 0x02, 0x08, 0x01,
      0x12, 0x04, 0x0a, 0x02, 0x08, 0x02,
    ]);
    expect(reader.readMessage(payload)).toEqual({ a: { c: { n: 1 } }, b: { c: { n: 2 } } });
  });

  it('rejects two files that import each other with an ordinary error, not a stack overflow', () => {
    // protoc rejects an import cycle, but the set arrives from the network,
    // and walking the imports must still end.
    const file = (name: string, other: string, message: string): FileInit => ({
      name,
      package: 'demo',
      syntax: 'proto3',
      dependency: [other],
      messageType: [
        { name: message, field: [{ name: 'n', number: 1, type: T.INT32, label: L.OPTIONAL }] },
      ],
    });
    const schema = descriptorSetBase64(
      file('demo/x.proto', 'demo/y.proto', 'X'),
      file('demo/y.proto', 'demo/x.proto', 'Y'),
    );
    let thrown: unknown;
    try {
      new ProtobufReader(schema, 'demo.X');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(RangeError);
  });
});

describe('ProtobufReader — decoded shape', () => {
  it('delivers a repeated message field as an array of plain objects', () => {
    const reader = new ProtobufReader(descriptorSetBase64(OUTER_FILE), 'demo.Outer');
    // 2 items: [{ n: 1 }, { n: 2 }]
    const payload = new Uint8Array([0x12, 0x02, 0x08, 0x01, 0x12, 0x02, 0x08, 0x02]);
    const decoded = reader.readMessage(payload);
    expect(decoded).toEqual({ items: [{ n: 1 }, { n: 2 }] });
    expect(Object.getPrototypeOf((decoded.items as object[])[0])).toBe(Object.prototype);
  });

  it('delivers a value the consumer can overwrite and delete, like any plain object', () => {
    const reader = new ProtobufReader(descriptorSetBase64(OUTER_FILE), 'demo.Outer');
    const decoded = reader.readMessage(new Uint8Array([0x0a, 0x02, 0x08, 0x07]));
    const inner = decoded.inner as Record<string, unknown>;
    inner.n = 8;
    expect(inner.n).toBe(8);
    delete decoded.items;
    expect(decoded).toEqual({ inner: { n: 8 } });
  });

  for (const syntax of ['proto2', 'proto3']) {
    it(`delivers an unset repeated or map field as empty, never absent (${syntax})`, () => {
      const schema = descriptorSetBase64({
        name: 'demo/coll.proto',
        package: 'demo',
        syntax,
        messageType: [
          {
            name: 'Coll',
            nestedType: [mapEntry('MEntry', { type: T.STRING }, { type: T.INT32 })],
            field: [
              { name: 'xs', number: 1, type: T.INT32, label: L.REPEATED },
              {
                name: 'm',
                number: 2,
                type: T.MESSAGE,
                typeName: '.demo.Coll.MEntry',
                label: L.REPEATED,
              },
            ],
          },
        ],
      });
      const reader = new ProtobufReader(schema, 'demo.Coll');
      expect(reader.readMessage(new Uint8Array())).toEqual({ xs: [], m: {} });
    });
  }
});

describe('ProtobufReader — template', () => {
  it('gives every field kind its JSON-safe default', () => {
    const schema = descriptorSetBase64({
      name: 'demo/kinds.proto',
      package: 'demo',
      syntax: 'proto3',
      enumType: [{ name: 'Mode', value: [{ name: 'MODE_UNSPECIFIED', number: 0 }] }],
      messageType: [
        {
          name: 'Kinds',
          nestedType: [mapEntry('MEntry', { type: T.STRING }, { type: T.INT32 })],
          field: [
            { name: 'flag', number: 1, type: T.BOOL, label: L.OPTIONAL },
            { name: 'text', number: 2, type: T.STRING, label: L.OPTIONAL },
            { name: 'raw', number: 3, type: T.BYTES, label: L.OPTIONAL },
            { name: 'count', number: 4, type: T.INT32, label: L.OPTIONAL },
            { name: 'mode', number: 5, type: T.ENUM, typeName: '.demo.Mode', label: L.OPTIONAL },
            { name: 'xs', number: 6, type: T.DOUBLE, label: L.REPEATED },
            {
              name: 'm',
              number: 7,
              type: T.MESSAGE,
              typeName: '.demo.Kinds.MEntry',
              label: L.REPEATED,
            },
          ],
        },
      ],
    });
    expect(new ProtobufReader(schema, 'demo.Kinds').template()).toEqual({
      flag: false,
      text: '',
      raw: [],
      count: 0,
      mode: 0,
      xs: [],
      m: {},
    });
  });
});
