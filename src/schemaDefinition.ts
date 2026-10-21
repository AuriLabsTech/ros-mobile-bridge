// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * Builds the public {@link SchemaDefinition} from a schema parser's output
 * (ADR 0032). The two parsers the library uses disagree on the details, so
 * this is where they are made to agree:
 *
 * - `@foxglove/rosmsg` leaves the root unnamed, names nested types in two
 *   parts, and turns a `builtin_interfaces/Time` field into the primitive
 *   `time`.
 * - `@foxglove/ros2idl-parser` names types in three parts, renames Time's
 *   `nanosec` to `nsec`, and puts constants in a separate `<Type>_Constants`
 *   entry ahead of the struct.
 *
 * Neither keeps `byte` and `char` apart from `uint8`; that loss is
 * documented on `getSchemaDefinition`, not repaired here.
 */

import type { MessageDefinition, MessageDefinitionField } from '@foxglove/message-definition';
import { parse as parseRosMsgDef } from '@foxglove/rosmsg';
import type {
  ConstantDefinition,
  DefinitionValue,
  FieldDefinition,
  SchemaDefinition,
  TypeDefinition,
} from './types';
import { getBundledServiceSchema } from './builtinSchemas';
import { sameTypeName } from './schemaName';
import { rootDefinition } from './schemaToTemplate';

const TIME = 'builtin_interfaces/msg/Time';
const DURATION = 'builtin_interfaces/msg/Duration';
const CONSTANTS_SUFFIX = '_Constants';

/** Time and Duration as ROS 2 defines them, whatever a parser produced. */
function timeLike(name: string): TypeDefinition {
  return {
    name,
    fields: [
      { name: 'sec', type: 'int32', isComplex: false, isArray: false },
      { name: 'nanosec', type: 'uint32', isComplex: false, isArray: false },
    ],
    constants: [],
  };
}

/**
 * The three-part name of a type named inside the closure of `root`. A nested
 * type is a message, except the parts `rosidl` generates for an action
 * (`<Action>_Goal`, `_Result`, `_Feedback`) inside a root of the same action,
 * which are action types (ADR 0032 decision 2).
 */
function expander(root: string): (name: string) => string {
  const [rootPkg, rootKind, rootBare] = root.split('/');
  return (name: string): string => {
    const parts = name.split('/');
    if (parts.length !== 2) return name;
    const [pkg, bare] = parts as [string, string];
    const actionPart = /^(.+)_(Goal|Result|Feedback)$/.exec(bare);
    const ownActionPart =
      rootKind === 'action' &&
      pkg === rootPkg &&
      actionPart !== null &&
      (rootBare ?? '').startsWith(`${actionPart[1]}_`);
    return `${pkg}/${ownActionPart ? 'action' : 'msg'}/${bare}`;
  };
}

/**
 * `name` in three parts: a two-part name gains `kind`, or the kind of
 * `kindFrom` when that is a three-part name. Only for names whose kind the
 * caller knows from where it found them (ADR 0002).
 */
export function withKind(name: string, kind: string, kindFrom?: string): string {
  const parts = name.split('/');
  if (parts.length !== 2) return name;
  const known = kindFrom?.split('/');
  return `${parts[0]}/${known?.length === 3 ? known[1] : kind}/${parts[1]}`;
}

function isConstantsModule(def: MessageDefinition): boolean {
  return def.definitions.length > 0 && def.definitions.every((f) => f.isConstant === true);
}

const PLACEHOLDER_MEMBER = 'structure_needs_at_least_one_member';

function is64Bit(type: string): boolean {
  return type === 'int64' || type === 'uint64';
}

/** A 64-bit integer decodes to a `bigint`; the parsers give a number when it fits. */
function toValue(type: string, value: unknown): DefinitionValue {
  if (is64Bit(type) && typeof value === 'number') return BigInt(value);
  return value as DefinitionValue;
}

/**
 * A field default as the public type, or `undefined` when the parser has
 * already lost it: the IDL parser reads a 64-bit default into a number,
 * which rounds above 2^53, and unlike a constant keeps no source text. Left
 * out rather than reported wrong.
 */
function defaultOf(f: MessageDefinitionField): FieldDefinition['defaultValue'] {
  const values: unknown[] = Array.isArray(f.defaultValue) ? f.defaultValue : [f.defaultValue];
  const rounded = values.some((v) => typeof v === 'number' && !Number.isSafeInteger(v));
  if (is64Bit(f.type) && rounded) return undefined;
  return Array.isArray(f.defaultValue)
    ? values.map((v) => toValue(f.type, v))
    : toValue(f.type, f.defaultValue);
}

/** A field's type in the public vocabulary: `time` and `duration` become the nested ROS 2 types. */
function fieldType(
  f: MessageDefinitionField,
  expand: (name: string) => string,
): Pick<FieldDefinition, 'type' | 'isComplex'> {
  if (f.type === 'time') return { type: TIME, isComplex: true };
  if (f.type === 'duration') return { type: DURATION, isComplex: true };
  return f.isComplex === true
    ? { type: expand(f.type), isComplex: true }
    : { type: f.type, isComplex: false };
}

function toField(f: MessageDefinitionField, expand: (name: string) => string): FieldDefinition {
  const field: FieldDefinition = {
    name: f.name,
    ...fieldType(f, expand),
    isArray: f.isArray === true,
  };
  if (field.isArray && f.arrayLength !== undefined) field.arrayLength = f.arrayLength;
  if (field.isArray && f.arrayUpperBound !== undefined) field.arrayUpperBound = f.arrayUpperBound;
  if (f.upperBound !== undefined) field.stringUpperBound = f.upperBound;
  const defaultValue = f.defaultValue === undefined ? undefined : defaultOf(f);
  if (defaultValue !== undefined) field.defaultValue = defaultValue;
  return field;
}

/**
 * A type's fields. `rosidl` gives an empty struct one `uint8` member named
 * `structure_needs_at_least_one_member` in its IDL, which `.msg` text does
 * not have; it is not a field anyone sets, so it is left out.
 */
function toFields(
  def: MessageDefinition | undefined,
  expand: (name: string) => string,
): FieldDefinition[] {
  const fields = (def?.definitions ?? []).filter((f) => f.isConstant !== true);
  if (fields.length === 1 && fields[0]!.name === PLACEHOLDER_MEMBER) return [];
  return fields.map((f) => toField(f, expand));
}

/**
 * The IDL parser reads a 64-bit constant into a number, which rounds one
 * past 2^53; its source text still has every digit.
 */
function constantValue(f: MessageDefinitionField): DefinitionValue {
  if (is64Bit(f.type) && typeof f.valueText === 'string' && /^-?\d+$/.test(f.valueText.trim())) {
    return BigInt(f.valueText.trim());
  }
  return toValue(f.type, f.value);
}

function toConstants(fields: readonly MessageDefinitionField[]): ConstantDefinition[] {
  return fields
    .filter((f) => f.isConstant === true && f.value !== undefined)
    .map((f) => ({ name: f.name, type: f.type, value: constantValue(f) }));
}

/**
 * The types `root` reaches, root first, from a map holding at least those.
 * Time and Duration are added when reached, whether or not `all` has them.
 */
function closure(
  all: ReadonlyMap<string, TypeDefinition>,
  root: string,
): Record<string, TypeDefinition> {
  const types: Record<string, TypeDefinition> = {};
  const queue = [root];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (types[name]) continue;
    const def = name === TIME || name === DURATION ? timeLike(name) : all.get(name);
    if (!def) continue;
    types[name] = def;
    for (const f of def.fields) if (f.isComplex) queue.push(f.type);
  }
  return types;
}

/**
 * The definition rooted at `root`, or `null` when some complex field names a
 * type the schema did not describe: the public promise is that every such
 * `type` is a key of `types`, and a lookup that cannot keep it answers
 * `null` rather than hand out a map a walker would fall off.
 */
function rooted(all: ReadonlyMap<string, TypeDefinition>, root: string): SchemaDefinition | null {
  const types = closure(all, root);
  if (!types[root]) return null;
  for (const t of Object.values(types)) {
    for (const f of t.fields) if (f.isComplex && !types[f.type]) return null;
  }
  return { root, types };
}

/**
 * The named entries other than the root, by three-part name: the types, and
 * the IDL `<Type>_Constants` modules keyed by the type they belong to.
 */
function splitNamed(
  defs: readonly MessageDefinition[],
  rootDef: MessageDefinition | undefined,
  expand: (name: string) => string,
): {
  parsed: Map<string, MessageDefinition>;
  constants: Map<string, MessageDefinitionField[]>;
} {
  const parsed = new Map<string, MessageDefinition>();
  const constants = new Map<string, MessageDefinitionField[]>();
  for (const def of defs) {
    if (def === rootDef || !def.name) continue;
    if (isConstantsModule(def) && def.name.endsWith(CONSTANTS_SUFFIX)) {
      constants.set(expand(def.name.slice(0, -CONSTANTS_SUFFIX.length)), def.definitions);
    } else {
      parsed.set(expand(def.name), def);
    }
  }
  return { parsed, constants };
}

/**
 * The public definition of `root`, a three-part name, from one parse of its
 * schema, or `null` when the schema leaves a nested type undescribed.
 * Builds new objects on every call, so the parse can be cached.
 */
export function toSchemaDefinition(
  defs: readonly MessageDefinition[],
  root: string,
): SchemaDefinition | null {
  const expand = expander(root);
  // A .msg type with constants and no fields is one unnamed all-constants
  // entry, which rootDefinition skips as an IDL constants module.
  const rootDef = rootDefinition(defs as MessageDefinition[]) ?? defs.find((d) => !d.name);
  const { parsed, constants } = splitNamed(defs, rootDef, expand);

  const build = (name: string, def: MessageDefinition | undefined): TypeDefinition => ({
    name,
    fields: toFields(def, expand),
    constants: toConstants([...(def?.definitions ?? []), ...(constants.get(name) ?? [])]),
  });

  const all = new Map<string, TypeDefinition>();
  for (const [name, def] of parsed) all.set(name, build(name, def));
  const rootName = rootDef?.name ? expand(rootDef.name) : root;
  all.set(root, build(root, rootDef));
  if (rootName !== root && constants.has(rootName)) {
    all.get(root)!.constants.push(...toConstants(constants.get(rootName)!));
  }
  return rooted(all, root);
}

/**
 * The request or response of a service the library bundles
 * (`builtinSchemas.ts`), by its `<Service>_Request` / `_Response` name, or
 * `null`. A name that carries a kind other than `srv` never matches: every
 * bundled type is a service.
 */
export function bundledServiceSideDefinition(schemaName: string): SchemaDefinition | null {
  const side = /^(.+)_(Request|Response)$/.exec(schemaName);
  if (!side) return null;
  const kind = schemaName.split('/').length === 3 ? schemaName.split('/')[1] : 'srv';
  if (kind !== 'srv') return null;
  const bundled = getBundledServiceSchema(side[1]!);
  if (!bundled) return null;
  const text = side[2] === 'Request' ? bundled.request : bundled.response;
  return toSchemaDefinition(parseRosMsgDef(text, { ros2: true }), withKind(schemaName, 'srv'));
}

/**
 * The definition of `schemaName` from a `/rosapi/topics_and_raw_types`
 * answer: parallel `types` and `typedefs_full_text` arrays, the second the
 * robot's own `ros2msg` text. `null` when no topic carries the type. The
 * arrays are read as sent, never filtered, so index i stays one topic.
 * Several topics can carry the type; the first whose text reads answers.
 */
export function rawTypesDefinition(
  result: Record<string, unknown>,
  schemaName: string,
): SchemaDefinition | null {
  const types: unknown[] = Array.isArray(result.types) ? result.types : [];
  const texts: unknown[] = Array.isArray(result.typedefs_full_text)
    ? result.typedefs_full_text
    : [];
  for (const [i, type] of types.entries()) {
    const text = texts[i];
    if (typeof type !== 'string' || typeof text !== 'string') continue;
    if (!sameTypeName(type, schemaName)) continue;
    try {
      const def = toSchemaDefinition(parseRosMsgDef(text, { ros2: true }), withKind(type, 'msg'));
      if (def) return def;
    } catch {
      // Unreadable text on this topic; another topic may carry the same type.
    }
  }
  return null;
}

/**
 * An action goal's definition from its `send_goal` request's: the nested
 * `goal` member's type when the request nests it, otherwise the request's
 * own fields without `goal_id`, under `goalName` (ADR 0027 decision 2).
 */
export function goalDefinition(
  request: SchemaDefinition,
  nests: boolean,
  goalName: string,
): SchemaDefinition | null {
  const req = request.types[request.root];
  if (!req) return null;
  const all = new Map(Object.entries(request.types));
  if (nests) {
    const goal = req.fields.find((f) => f.name === 'goal' && f.isComplex && !f.isArray);
    return goal ? rooted(all, goal.type) : null;
  }
  // Inlined, the request carries the goal's fields and its constants.
  all.set(goalName, {
    name: goalName,
    fields: req.fields.filter((f) => f.name !== 'goal_id'),
    constants: req.constants,
  });
  return rooted(all, goalName);
}
