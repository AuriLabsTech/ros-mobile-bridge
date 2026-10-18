// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * The parameter surface (ADR 0021), one implementation for every transport:
 * each node's own `rcl_interfaces` services, reached through the client's
 * `callService`. A client supplies a {@link ParameterPort}; everything else,
 * value encoding, the batch rule, byte arrays over rosbridge, and the typed
 * error, lives here. Internal; not exported from the package.
 */

import { base64ToUint8 } from './base64';
import { ParameterServiceError } from './errors';
import type {
  CallServiceOptions,
  ListParametersOptions,
  ParameterAtomicResult,
  ParameterChange,
  ParameterDescription,
  ParameterReading,
  ParameterSetResult,
  ParameterType,
  ParameterValue,
} from './types';

/** What a client gives the parameter surface. */
export interface ParameterPort {
  callService(
    service: string,
    request: Record<string, unknown>,
    options?: CallServiceOptions,
  ): Promise<Record<string, unknown>>;
  /**
   * Every service name the robot advertises, read fresh. Rejects with
   * `ParameterServiceError` reason `'discovery-unavailable'` when the list
   * cannot be read. Where reading it is itself a request, `options` bounds
   * that request as it bounds the caller's own.
   */
  serviceNames(options?: CallServiceOptions): Promise<string[]>;
  /**
   * How the transport carries the request. `'json'` (rosbridge): integers go
   * as JSON numbers, and a reply holding a non-empty byte array never
   * arrives. `'cdr'` (Foxglove): integers go as `bigint`, byte arrays travel
   * both ways.
   */
  wire: 'json' | 'cdr';
}

// rcl_interfaces/msg/ParameterType constants, by index.
const TYPE_BY_CODE: ReadonlyArray<ParameterType | 'not-set'> = [
  'not-set',
  'bool',
  'integer',
  'double',
  'string',
  'byte_array',
  'bool_array',
  'integer_array',
  'double_array',
  'string_array',
];

const CODE_BY_TYPE: Readonly<Record<ParameterType, number>> = {
  bool: 1,
  integer: 2,
  double: 3,
  string: 4,
  byte_array: 5,
  bool_array: 6,
  integer_array: 7,
  double_array: 8,
  string_array: 9,
};

// The rcl_interfaces/msg/ParameterValue field that holds each type.
const FIELD_BY_TYPE: Readonly<Record<ParameterType, string>> = {
  bool: 'bool_value',
  integer: 'integer_value',
  double: 'double_value',
  string: 'string_value',
  byte_array: 'byte_array_value',
  bool_array: 'bool_array_value',
  integer_array: 'integer_array_value',
  double_array: 'double_array_value',
  string_array: 'string_array_value',
};

function typeOf(code: unknown): ParameterType | 'not-set' | undefined {
  return typeof code === 'number' ? TYPE_BY_CODE[code] : undefined;
}

function toBigInt(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  return 0n;
}

function list(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<unknown>);
  return [];
}

function bytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v.slice();
  if (typeof v === 'string') return base64ToUint8(v);
  return Uint8Array.from(list(v).map((x) => (typeof x === 'number' ? x : 0)));
}

const bool = (x: unknown): boolean => x === true;
const num = (x: unknown): number => (typeof x === 'number' ? x : 0);
const str = (x: unknown): string => (typeof x === 'string' ? x : '');

// Each type's field, read into its public form. Both transports pass through
// here: plain JSON values from rosbridge, bigint and typed arrays from CDR.
const DECODE: {
  [K in ParameterType]: (v: unknown) => Extract<ParameterValue, { type: K }>['value'];
} = {
  bool,
  integer: toBigInt,
  double: num,
  string: str,
  byte_array: bytes,
  bool_array: (v) => list(v).map(bool),
  integer_array: (v) => list(v).map(toBigInt),
  double_array: (v) => list(v).map(num),
  string_array: (v) => list(v).map(str),
};

/** A wire `ParameterValue` as the public type; `undefined` for NOT_SET or an unknown type. */
export function decodeValue(raw: Record<string, unknown>): ParameterValue | undefined {
  const type = typeOf(raw.type);
  if (type === undefined || type === 'not-set') return undefined;
  return { type, value: DECODE[type](raw[FIELD_BY_TYPE[type]]) } as ParameterValue;
}

function wireInteger(v: bigint, wire: ParameterPort['wire']): bigint | number {
  if (wire === 'cdr') return v;
  const n = Number(v);
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(
      `The integer ${v} cannot be sent over rosbridge exactly: its JSON frames carry ` +
        'integers as numbers, which hold whole numbers only up to 2^53.',
    );
  }
  return n;
}

function wireDouble(v: number, wire: ParameterPort['wire']): number {
  if (wire === 'json' && !Number.isFinite(v)) {
    throw new RangeError(
      `The double ${v} cannot be sent over rosbridge: JSON has no form for NaN or infinity.`,
    );
  }
  return v;
}

/** A public value as a wire `ParameterValue`: the type code and the one field that holds it. */
export function encodeValue(
  value: ParameterValue,
  wire: ParameterPort['wire'],
): Record<string, unknown> {
  let field: unknown;
  switch (value.type) {
    case 'integer':
      field = wireInteger(value.value, wire);
      break;
    case 'integer_array':
      field = value.value.map((v) => wireInteger(v, wire));
      break;
    case 'double':
      field = wireDouble(value.value, wire);
      break;
    case 'double_array':
      field = value.value.map((v) => wireDouble(v, wire));
      break;
    case 'byte_array':
      field = wire === 'cdr' ? value.value : Array.from(value.value);
      break;
    default:
      field = value.value;
  }
  return { type: CODE_BY_TYPE[value.type], [FIELD_BY_TYPE[value.type]]: field };
}

/**
 * `port` with one service-list read shared by every failure inside one
 * public call: a one-name-at-a-time pass that fails as a whole would
 * otherwise read the list once per name, and on rosbridge each read is a
 * `/rosapi/services` call.
 */
function sharingServiceList(port: ParameterPort): ParameterPort {
  let names: Promise<string[]> | null = null;
  return { ...port, serviceNames: (options) => (names ??= port.serviceNames(options)) };
}

function records(v: unknown): Record<string, unknown>[] {
  return list(v).filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null);
}

/**
 * Call `<node>/<srv>`. On failure, the service list is read once: a node
 * without the service rejects as `'no-parameter-services'`; anything else
 * (a timeout, an unreadable reply, a list that cannot be read) rejects with
 * the call's own error.
 */
async function callNode(
  port: ParameterPort,
  node: string,
  srv: string,
  request: Record<string, unknown>,
  options?: CallServiceOptions,
): Promise<Record<string, unknown>> {
  const service = `${node}/${srv}`;
  try {
    return await port.callService(service, request, options);
  } catch (err) {
    let names: string[];
    try {
      names = await port.serviceNames(options);
    } catch {
      throw err;
    }
    if (!names.includes(service))
      throw new ParameterServiceError('no-parameter-services', node, service, err);
    throw err;
  }
}

const LIST_SUFFIX = '/list_parameters';

export async function getParameterNodes(
  port: ParameterPort,
  options?: CallServiceOptions,
): Promise<string[]> {
  const names = await port.serviceNames(options);
  return names
    .filter((n) => n.endsWith(LIST_SUFFIX) && n.length > LIST_SUFFIX.length)
    .map((n) => n.slice(0, -LIST_SUFFIX.length))
    .sort();
}

export async function listParameters(
  port: ParameterPort,
  node: string,
  options?: ListParametersOptions,
): Promise<string[]> {
  const { prefixes, depth, ...callOptions } = options ?? {};
  if (depth !== undefined && !(Number.isSafeInteger(depth) && depth >= 0)) {
    throw new RangeError(`listParameters depth must be a whole number of 0 or more, got ${depth}.`);
  }
  const resp = await callNode(
    port,
    node,
    'list_parameters',
    {
      prefixes: [...(prefixes ?? [])],
      depth: port.wire === 'cdr' ? BigInt(depth ?? 0) : (depth ?? 0),
    },
    callOptions,
  );
  const result = resp.result as Record<string, unknown> | undefined;
  return list(result?.names).filter((n): n is string => typeof n === 'string');
}

/**
 * Ask `names` together; when the node answers a batch with nothing (the
 * batch rule, ADR 0021 context), ask again one name at a time. `pick` reads
 * the reply's list; a name whose single request is still empty maps to
 * `undefined`.
 */
async function isolated(
  port: ParameterPort,
  node: string,
  srv: string,
  names: readonly string[],
  pick: (resp: Record<string, unknown>) => Record<string, unknown>[],
  options?: CallServiceOptions,
): Promise<Array<Record<string, unknown> | undefined>> {
  if (names.length === 0) return [];
  const batch = pick(await callNode(port, node, srv, { names: [...names] }, options));
  if (batch.length === names.length) return batch;
  if (names.length === 1) return [undefined];
  // One request at a time. rosbridge on Cyclone DDS loses replies to service
  // calls it has in flight together (ADR 0021 amendment 2026-10-18: 4 at once
  // failed 4 reads of 30, one at a time 0 of 30, 510 requests).
  const out: Array<Record<string, unknown> | undefined> = [];
  for (const name of names) {
    out.push(pick(await callNode(port, node, srv, { names: [name] }, options))[0]);
  }
  return out;
}

function describeOne(name: string, raw: Record<string, unknown> | undefined): ParameterDescription {
  const type = raw ? typeOf(raw.type) : undefined;
  if (!raw || type === undefined) return { name, state: 'undeclared' };
  const description: ParameterDescription = {
    name,
    state: 'declared',
    type,
    description: typeof raw.description === 'string' ? raw.description : '',
    additionalConstraints:
      typeof raw.additional_constraints === 'string' ? raw.additional_constraints : '',
    readOnly: raw.read_only === true,
    dynamicTyping: raw.dynamic_typing === true,
  };
  const ir = records(raw.integer_range)[0];
  if (ir) {
    description.integerRange = {
      from: toBigInt(ir.from_value),
      to: toBigInt(ir.to_value),
      step: toBigInt(ir.step),
    };
  }
  const fr = records(raw.floating_point_range)[0];
  if (fr) {
    description.floatingPointRange = {
      from: num(fr.from_value),
      to: num(fr.to_value),
      step: num(fr.step),
    };
  }
  return description;
}

export async function describeParameters(
  port: ParameterPort,
  node: string,
  names: readonly string[],
  options?: CallServiceOptions,
): Promise<ParameterDescription[]> {
  port = sharingServiceList(port);
  const raws = await isolated(
    port,
    node,
    'describe_parameters',
    names,
    (r) => records(r.descriptors),
    options,
  );
  return names.map((name, i) => describeOne(name, raws[i]));
}

/** The type of each name (`get_parameter_types`), isolated the same way; `undefined` for an undeclared name. */
async function typesOf(
  port: ParameterPort,
  node: string,
  names: readonly string[],
  options?: CallServiceOptions,
): Promise<Array<ParameterType | 'not-set' | undefined>> {
  const pick = (r: Record<string, unknown>): Record<string, unknown>[] =>
    Array.from(bytes(r.types), (code) => ({ code }));
  const raws = await isolated(port, node, 'get_parameter_types', names, pick, options);
  return raws.map((r) => (r ? typeOf(r.code) : undefined));
}

export async function getParameters(
  port: ParameterPort,
  node: string,
  names: readonly string[],
  options?: CallServiceOptions,
): Promise<ParameterReading[]> {
  port = sharingServiceList(port);
  const readings: Array<ParameterReading | undefined> = names.map(() => undefined);
  let toRead = names.map((name, i) => ({ name, i }));
  // Names to settle by description: declared without a value, or not declared.
  const empty: Array<{ name: string; i: number }> = [];

  if (port.wire === 'json' && names.length > 0) {
    // rosbridge never sends a reply holding a non-empty byte array (ADR 0021,
    // amendment 2026-10-18), and one in a batch takes the whole batch down.
    // The types reply holds no byte arrays, so ask it first and leave those out.
    const types = await typesOf(port, node, names, options);
    toRead = toRead.filter(({ name, i }) => {
      const type = types[i];
      if (type === undefined) readings[i] = { name, state: 'undeclared' };
      else if (type === 'byte_array') readings[i] = { name, state: 'unreadable', type };
      // Type 0 is declared without a value. A node that accepts undeclared
      // parameters answers 0 for any name, and describes any name as declared
      // with no type, so no request could tell its unknown names apart.
      else if (type === 'not-set') readings[i] = { name, state: 'not-set' };
      else return true;
      return false;
    });
  }

  const raws = await isolated(
    port,
    node,
    'get_parameters',
    toRead.map((r) => r.name),
    (r) => records(r.values),
    options,
  );
  toRead.forEach(({ name, i }, k) => {
    const raw = raws[k];
    if (!raw) {
      empty.push({ name, i });
      return;
    }
    const value = decodeValue(raw);
    readings[i] = value ? { name, state: 'set', value } : { name, state: 'not-set' };
  });

  // A name still empty on its own is either declared without a value or not
  // declared at all; only a description tells them apart.
  if (empty.length > 0) {
    const described = await describeParameters(
      port,
      node,
      empty.map((e) => e.name),
      options,
    );
    empty.forEach(({ name, i }, k) => {
      readings[i] = { name, state: described[k]?.state === 'declared' ? 'not-set' : 'undeclared' };
    });
  }

  return readings as ParameterReading[];
}

function changeRequest(
  changes: readonly ParameterChange[],
  wire: ParameterPort['wire'],
): Record<string, unknown> {
  return { parameters: changes.map((c) => ({ name: c.name, value: encodeValue(c.value, wire) })) };
}

export async function setParameters(
  port: ParameterPort,
  node: string,
  changes: readonly ParameterChange[],
  options?: CallServiceOptions,
): Promise<ParameterSetResult[]> {
  if (changes.length === 0) return [];
  const request = changeRequest(changes, port.wire);
  const results = records((await callNode(port, node, 'set_parameters', request, options)).results);
  return changes.map((c, i) => {
    const r = results[i];
    return {
      name: c.name,
      successful: r?.successful === true,
      reason:
        typeof r?.reason === 'string'
          ? r.reason
          : r
            ? ''
            : 'The node sent no result for this change.',
    };
  });
}

export async function setParametersAtomically(
  port: ParameterPort,
  node: string,
  changes: readonly ParameterChange[],
  options?: CallServiceOptions,
): Promise<ParameterAtomicResult> {
  // Nothing to change is applied by definition, as in setParameters.
  if (changes.length === 0) return { successful: true, reason: '' };
  const request = changeRequest(changes, port.wire);
  const resp = await callNode(port, node, 'set_parameters_atomically', request, options);
  const r = resp.result as Record<string, unknown> | undefined;
  return {
    successful: r?.successful === true,
    reason: typeof r?.reason === 'string' ? r.reason : '',
  };
}
