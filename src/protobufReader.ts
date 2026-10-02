// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * Decodes one protobuf message type from the `FileDescriptorSet` a Foxglove
 * channel advertised, with no generated code.
 *
 * What it returns is the schema's own shape, not the runtime's: plain objects
 * keyed by the field names the `.proto` declares (`frame_id`, where the
 * runtime would say `frameId`), with the runtime's own bookkeeping (`$typeName`)
 * left out. Values keep the types protobuf gives them: 64-bit integers are
 * `bigint`, `bytes` are `Uint8Array`, a `google.protobuf.Timestamp` is an
 * ordinary `{ seconds, nanos }` message.
 */

import {
  create,
  createFileRegistry,
  fromBinary,
  ScalarType,
  type DescField,
  type DescMessage,
} from '@bufbuild/protobuf';
import {
  FeatureSet_FieldPresence,
  FileDescriptorSetSchema,
  type DescriptorProto,
  type FileDescriptorProto,
} from '@bufbuild/protobuf/wkt';
import { base64Decode } from '@bufbuild/protobuf/wire';
import { reflect, type ReflectMessage } from '@bufbuild/protobuf/reflect';

export class ProtobufReader {
  private readonly desc: DescMessage;

  /**
   * @param schema The channel's `schema`: a base64 `FileDescriptorSet`.
   * @param schemaName The channel's `schemaName`: the message type to decode.
   * @throws When the descriptor does not parse or does not contain `schemaName`.
   */
  constructor(schema: string, schemaName: string) {
    const typeName = schemaName.startsWith('.') ? schemaName.slice(1) : schemaName;
    const files = fromBinary(FileDescriptorSetSchema, base64Decode(schema)).file;
    const root = files.find((file) => definesMessage(file, typeName));
    if (!root) throw new Error(`descriptor does not define message "${typeName}"`);
    const set = create(FileDescriptorSetSchema, { file: withImportsFirst(root, files) });
    const desc = createFileRegistry(set).getMessage(typeName);
    if (!desc) throw new Error(`descriptor does not define message "${typeName}"`);
    this.desc = desc;
  }

  /** Decode one payload. Throws when the bytes are not a valid encoding of the type. */
  readMessage(payload: Uint8Array): Record<string, unknown> {
    return toPlainObject(reflect(this.desc, fromBinary(this.desc, payload)));
  }

  /**
   * A default for every field, for `getSchemaTemplate`. Same field names as a
   * decoded message; values follow the template contract the CDR path already
   * keeps, which is JSON-safe (`0` for 64-bit integers, `[]` for bytes), and
   * every oneof member is listed, because a template shows what can appear.
   */
  template(): Record<string, unknown> {
    return templateOf(this.desc, new Set());
  }
}

/**
 * `root` and every file it imports, transitively, each after its own imports:
 * the order `createFileRegistry` needs. `FileDescriptorSet` puts no order on
 * its files, so a sender may list them any way. (The runtime's own resolver
 * form of `createFileRegistry` is not used: it adds a file imported by two
 * others after one of them, so it rejects the SDK's `foxglove.ImageAnnotations`
 * set.) A file imported but not in the set throws, naming it.
 */
function withImportsFirst(
  root: FileDescriptorProto,
  files: FileDescriptorProto[],
): FileDescriptorProto[] {
  const byName = new Map(files.map((file) => [file.name, file]));
  const ordered: FileDescriptorProto[] = [];
  const visited = new Set<string>();
  const visit = (file: FileDescriptorProto): void => {
    if (visited.has(file.name)) return;
    visited.add(file.name);
    for (const name of file.dependency) {
      const dependency = byName.get(name);
      if (!dependency) throw new Error(`Cannot find ${name}, imported by ${file.name}`);
      visit(dependency);
    }
    ordered.push(file);
  };
  visit(root);
  return ordered;
}

/** Whether `file` declares the message `typeName`, at top level or nested. */
function definesMessage(file: FileDescriptorProto, typeName: string): boolean {
  const prefix = file.package ? `${file.package}.` : '';
  const walk = (messages: DescriptorProto[], scope: string): boolean =>
    messages.some(
      (m) => `${scope}${m.name}` === typeName || walk(m.nestedType, `${scope}${m.name}.`),
    );
  return walk(file.messageType, prefix);
}

/**
 * Set `key` as an ordinary own property. A protobuf field may be named
 * `__proto__`, and a plain `obj[key] = value` would set the object's
 * prototype instead of adding the key.
 */
function define(obj: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * `path` holds the types being expanded above this one. A type met again
 * inside itself becomes `{}` rather than another copy: a depth limit alone
 * would still expand a type with several self-references into a number of
 * objects exponential in that limit.
 */
function templateOf(desc: DescMessage, path: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (path.has(desc.typeName)) return out;
  path.add(desc.typeName);
  for (const field of desc.fields) {
    switch (field.fieldKind) {
      case 'message':
        define(out, field.name, templateOf(field.message, path));
        break;
      case 'list':
        define(out, field.name, []);
        break;
      case 'map':
        define(out, field.name, {});
        break;
      case 'enum':
        define(out, field.name, 0);
        break;
      case 'scalar':
        define(out, field.name, scalarDefault(field.scalar));
        break;
    }
  }
  path.delete(desc.typeName);
  return out;
}

function scalarDefault(scalar: ScalarType): unknown {
  switch (scalar) {
    case ScalarType.STRING:
      return '';
    case ScalarType.BOOL:
      return false;
    case ScalarType.BYTES:
      return [];
    default:
      return 0;
  }
}

/** Whether the wire can say this field was not set. */
function canBeUnset(field: DescField): boolean {
  if (field.fieldKind === 'list' || field.fieldKind === 'map') return false;
  return (
    field.fieldKind === 'message' ||
    field.oneof !== undefined ||
    field.presence !== FeatureSet_FieldPresence.IMPLICIT
  );
}

/**
 * Walk a decoded message into a plain object (ADR 0017, decision 4 and its
 * 2026-09-30 amendment). A field that can say "not set" on the wire, meaning a
 * sub-message, a oneof member, or any field with explicit presence (proto3
 * `optional`, proto2), appears only when the payload set it. A plain proto3
 * scalar carries its value, which for one the sender omitted is the default,
 * exactly what the wire means by omitting it.
 */
function toPlainObject(message: ReflectMessage): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of message.fields) {
    if (!message.isSet(field) && canBeUnset(field)) continue;
    define(out, field.name, plainValue(message, field));
  }
  return out;
}

/** One field's value, in the delivered shape. */
function plainValue(message: ReflectMessage, field: DescField): unknown {
  switch (field.fieldKind) {
    case 'message':
      return toPlainObject(message.get(field));
    case 'list':
      return Array.from(message.get(field), (item: unknown) =>
        field.listKind === 'message' ? toPlainObject(item as ReflectMessage) : item,
      );
    case 'map': {
      // A plain object has only string keys, so an integer or bool key is
      // written as its decimal or 'true'/'false' form, as protobuf's JSON
      // mapping does.
      const entries: Record<string, unknown> = {};
      for (const [key, value] of message.get(field)) {
        define(
          entries,
          String(key),
          field.mapKind === 'message' ? toPlainObject(value as ReflectMessage) : value,
        );
      }
      return entries;
    }
    default:
      return message.get(field);
  }
}
