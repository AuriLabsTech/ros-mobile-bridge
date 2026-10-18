// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * The shared parameter surface (ADR 0021) against a fake node that follows
 * the ROS 2 rules measured on the integration fixture (ADR 0021, amendment
 * 2026-10-18): a get or describe naming an
 * undeclared parameter answers nothing for the whole request, a get naming a
 * declared parameter without a value does too, and get_parameter_types
 * answers 0 for such a parameter. The wiring through each client is covered
 * by the Docker integration suite.
 */

import { describe, expect, it } from 'vitest';
import { ParameterServiceError } from '../src/errors';
import * as parameters from '../src/parameters';
import type { ParameterPort } from '../src/parameters';

type Wire = ParameterPort['wire'];

interface Declared {
  code: number;
  field?: string;
  value?: unknown;
  readOnly?: boolean;
}

const NODE = '/params/demo';

/** A node in the shape of rcl_interfaces, answering as a bridge of `wire` would relay it. */
function fakeNode(
  wire: Wire,
  declared: Record<string, Declared>,
  opts: { allowUndeclared?: boolean } = {},
) {
  const calls: Array<{ service: string; request: Record<string, unknown> }> = [];
  const int = (n: number): bigint | number => (wire === 'cdr' ? BigInt(n) : n);
  const blank = (): Record<string, unknown> => ({
    type: 0,
    bool_value: false,
    integer_value: int(0),
    double_value: 0,
    string_value: '',
    byte_array_value: wire === 'cdr' ? new Uint8Array() : [],
    bool_array_value: [],
    integer_array_value: wire === 'cdr' ? new BigInt64Array() : [],
    double_array_value: wire === 'cdr' ? new Float64Array() : [],
    string_array_value: [],
  });
  const handlers: Record<string, (req: Record<string, unknown>) => Record<string, unknown>> = {
    get_parameters: (req) => {
      const names = req.names as string[];
      const out = [];
      for (const n of names) {
        const d = declared[n];
        // A static parameter never given a value is code 0 with no field.
        if (!d || (d.code === 0 && d.field === 'static')) return { values: [] };
        // rosbridge never answers a reply holding a non-empty byte array.
        if (wire === 'json' && d.code === 5 && (d.value as unknown[]).length > 0) {
          throw new Error(`Service call "${NODE}/get_parameters" timed out`);
        }
        out.push({
          ...blank(),
          type: d.code,
          ...(d.field && d.field !== 'static' ? { [d.field]: d.value } : {}),
        });
      }
      return { values: out };
    },
    describe_parameters: (req) => {
      const names = req.names as string[];
      if (names.some((n) => !declared[n])) return { descriptors: [] };
      return {
        descriptors: names.map((n) => ({
          name: n,
          type: declared[n]!.field === 'static' ? 2 : declared[n]!.code,
          description: n === 'ranged' ? 'between 0 and 10' : '',
          additional_constraints: '',
          read_only: declared[n]!.readOnly === true,
          dynamic_typing: false,
          floating_point_range: [],
          integer_range:
            n === 'ranged' ? [{ from_value: int(0), to_value: int(10), step: int(1) }] : [],
        })),
      };
    },
    get_parameter_types: (req) => {
      const names = req.names as string[];
      // A node started with allow_undeclared_parameters answers 0 for a name it does not hold.
      if (!opts.allowUndeclared && names.some((n) => !declared[n])) {
        return { types: wire === 'cdr' ? new Uint8Array() : '' };
      }
      const codes = Uint8Array.from(names.map((n) => declared[n]?.code ?? 0));
      // rosbridge relays uint8[] as base64.
      return { types: wire === 'cdr' ? codes : btoa(String.fromCharCode(...codes)) };
    },
    list_parameters: () => ({ result: { names: Object.keys(declared), prefixes: [] } }),
    set_parameters: (req) => ({
      results: (req.parameters as Array<{ name: string }>).map((p) =>
        declared[p.name]?.readOnly
          ? { successful: false, reason: `Trying to set a read-only parameter: ${p.name}.` }
          : { successful: true, reason: '' },
      ),
    }),
    set_parameters_atomically: (req) => {
      const ro = (req.parameters as Array<{ name: string }>).find(
        (p) => declared[p.name]?.readOnly,
      );
      return {
        result: ro ? { successful: false, reason: 'read-only' } : { successful: true, reason: '' },
      };
    },
  };
  const serviceNames = Object.keys(handlers).map((s) => `${NODE}/${s}`);
  const port: ParameterPort = {
    wire,
    callService: async (service, request) => {
      calls.push({ service, request });
      const srv = service.slice(NODE.length + 1);
      const handler = service.startsWith(`${NODE}/`) ? handlers[srv] : undefined;
      if (!handler) throw new Error(`Service ${service} does not exist`);
      return handler(request);
    },
    serviceNames: async () => [...serviceNames, '/other/list_parameters', '/rosapi/services'],
  };
  return { port, calls };
}

const DEMO: Record<string, Declared> = {
  b: { code: 1, field: 'bool_value', value: true },
  i: { code: 2, field: 'integer_value', value: 42 },
  d: { code: 3, field: 'double_value', value: 1.5 },
  s: { code: 4, field: 'string_value', value: 'hello' },
  ba: { code: 5, field: 'byte_array_value', value: [0, 1, 255] },
  int_arr: { code: 7, field: 'integer_array_value', value: [1, 2, 3] },
  dbl_arr: { code: 8, field: 'double_array_value', value: [1, 2.5] },
  str_arr: { code: 9, field: 'string_array_value', value: ['a', 'b'] },
  ro: { code: 2, field: 'integer_value', value: 7, readOnly: true },
  ranged: { code: 2, field: 'integer_value', value: 5 },
  unset: { code: 0, field: 'static' },
  unset_dyn: { code: 0 },
};

/** DEMO as a CDR bridge relays it: integers as bigint, arrays typed. */
function cdrDemo(): Record<string, Declared> {
  const out: Record<string, Declared> = {};
  for (const [k, d] of Object.entries(DEMO)) {
    let value = d.value;
    if (d.code === 2) value = BigInt(d.value as number);
    if (d.code === 5) value = Uint8Array.from(d.value as number[]);
    if (d.code === 7) value = BigInt64Array.from((d.value as number[]).map(BigInt));
    if (d.code === 8) value = Float64Array.from(d.value as number[]);
    out[k] = { ...d, value };
  }
  return out;
}

describe('parameters: values', () => {
  it.each(['cdr', 'json'] as const)('reads every type the same way on %s', async (wire) => {
    const { port } = fakeNode(wire, wire === 'cdr' ? cdrDemo() : DEMO);
    const readings = await parameters.getParameters(port, NODE, [
      'b',
      'i',
      'd',
      's',
      'int_arr',
      'dbl_arr',
      'str_arr',
    ]);
    expect(readings).toEqual([
      { name: 'b', state: 'set', value: { type: 'bool', value: true } },
      { name: 'i', state: 'set', value: { type: 'integer', value: 42n } },
      { name: 'd', state: 'set', value: { type: 'double', value: 1.5 } },
      { name: 's', state: 'set', value: { type: 'string', value: 'hello' } },
      { name: 'int_arr', state: 'set', value: { type: 'integer_array', value: [1n, 2n, 3n] } },
      { name: 'dbl_arr', state: 'set', value: { type: 'double_array', value: [1, 2.5] } },
      { name: 'str_arr', state: 'set', value: { type: 'string_array', value: ['a', 'b'] } },
    ]);
    // Plain arrays on every transport (amendment 2026-10-18).
    const ints = readings[4]!.state === 'set' ? readings[4]!.value.value : null;
    expect(Array.isArray(ints)).toBe(true);
  });

  it('reads a byte array as a Uint8Array over CDR', async () => {
    const { port } = fakeNode('cdr', cdrDemo());
    const [ba] = await parameters.getParameters(port, NODE, ['ba']);
    expect(ba).toEqual({
      name: 'ba',
      state: 'set',
      value: { type: 'byte_array', value: new Uint8Array([0, 1, 255]) },
    });
  });

  it('encodes each type into its own field, integers as bigint over CDR and numbers over JSON', () => {
    expect(parameters.encodeValue({ type: 'integer', value: 5n }, 'cdr')).toEqual({
      type: 2,
      integer_value: 5n,
    });
    expect(parameters.encodeValue({ type: 'integer', value: 5n }, 'json')).toEqual({
      type: 2,
      integer_value: 5,
    });
    expect(parameters.encodeValue({ type: 'double', value: 2 }, 'json')).toEqual({
      type: 3,
      double_value: 2,
    });
    expect(parameters.encodeValue({ type: 'integer_array', value: [] }, 'json')).toEqual({
      type: 7,
      integer_array_value: [],
    });
    expect(
      parameters.encodeValue({ type: 'byte_array', value: new Uint8Array([1, 2]) }, 'json'),
    ).toEqual({
      type: 5,
      byte_array_value: [1, 2],
    });
  });

  it('refuses to send a double JSON cannot hold', () => {
    for (const v of [NaN, Infinity, -Infinity]) {
      expect(() => parameters.encodeValue({ type: 'double', value: v }, 'json')).toThrow(
        RangeError,
      );
      expect(() => parameters.encodeValue({ type: 'double_array', value: [1, v] }, 'json')).toThrow(
        RangeError,
      );
    }
    expect(parameters.encodeValue({ type: 'double', value: Infinity }, 'cdr')).toEqual({
      type: 3,
      double_value: Infinity,
    });
  });

  it('refuses to send an integer JSON cannot hold exactly', () => {
    expect(() => parameters.encodeValue({ type: 'integer', value: 2n ** 60n }, 'json')).toThrow(
      RangeError,
    );
    expect(parameters.encodeValue({ type: 'integer', value: 2n ** 60n }, 'cdr')).toEqual({
      type: 2,
      integer_value: 2n ** 60n,
    });
  });
});

describe('parameters: the batch rule', () => {
  it.each(['cdr', 'json'] as const)(
    'one undeclared name does not hide the others, and states come back in request order on %s',
    async (wire) => {
      const { port } = fakeNode(wire, wire === 'cdr' ? cdrDemo() : DEMO);
      const readings = await parameters.getParameters(port, NODE, [
        'i',
        'nope',
        'unset',
        'unset_dyn',
        's',
      ]);
      expect(readings).toEqual([
        { name: 'i', state: 'set', value: { type: 'integer', value: 42n } },
        { name: 'nope', state: 'undeclared' },
        { name: 'unset', state: 'not-set' },
        { name: 'unset_dyn', state: 'not-set' },
        { name: 's', state: 'set', value: { type: 'string', value: 'hello' } },
      ]);
    },
  );

  it('asks once when the whole batch is readable', async () => {
    const { port, calls } = fakeNode('cdr', cdrDemo());
    await parameters.getParameters(port, NODE, ['b', 'i', 's']);
    expect(calls.map((c) => c.service)).toEqual([`${NODE}/get_parameters`]);
  });

  it('tells a lone never-set name from an undeclared one by describing it', async () => {
    const { port, calls } = fakeNode('cdr', cdrDemo());
    expect(await parameters.getParameters(port, NODE, ['unset'])).toEqual([
      { name: 'unset', state: 'not-set' },
    ]);
    expect(await parameters.getParameters(port, NODE, ['nope'])).toEqual([
      { name: 'nope', state: 'undeclared' },
    ]);
    expect(calls.filter((c) => c.service.endsWith('describe_parameters'))).toHaveLength(2);
  });

  it('describes with ranges and read-only, and isolates an undeclared name', async () => {
    const { port } = fakeNode('cdr', cdrDemo());
    const out = await parameters.describeParameters(port, NODE, ['ro', 'nope', 'ranged']);
    expect(out[0]).toMatchObject({
      name: 'ro',
      state: 'declared',
      type: 'integer',
      readOnly: true,
    });
    expect(out[1]).toEqual({ name: 'nope', state: 'undeclared' });
    expect(out[2]).toMatchObject({
      name: 'ranged',
      description: 'between 0 and 10',
      integerRange: { from: 0n, to: 10n, step: 1n },
    });
    expect(out[2]).not.toHaveProperty('floatingPointRange');
  });

  it('answers an empty name list without asking the node', async () => {
    const { port, calls } = fakeNode('json', DEMO);
    expect(await parameters.getParameters(port, NODE, [])).toEqual([]);
    expect(await parameters.describeParameters(port, NODE, [])).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('parameters: byte arrays over rosbridge (amendment 2026-10-18)', () => {
  it('reports a byte array as unreadable and reads the rest without waiting on it', async () => {
    const { port, calls } = fakeNode('json', DEMO);
    const readings = await parameters.getParameters(port, NODE, ['i', 'ba', 's']);
    expect(readings).toEqual([
      { name: 'i', state: 'set', value: { type: 'integer', value: 42n } },
      { name: 'ba', state: 'unreadable', type: 'byte_array' },
      { name: 's', state: 'set', value: { type: 'string', value: 'hello' } },
    ]);
    const gets = calls.filter((c) => c.service.endsWith('/get_parameters'));
    expect(gets.map((c) => c.request.names)).toEqual([['i', 's']]);
  });

  it('settles not-set and undeclared from the types alone, without a get', async () => {
    const { port, calls } = fakeNode('json', DEMO);
    expect(await parameters.getParameters(port, NODE, ['unset', 'nope'])).toEqual([
      { name: 'unset', state: 'not-set' },
      { name: 'nope', state: 'undeclared' },
    ]);
    expect(calls.some((c) => c.service.endsWith('/get_parameters'))).toBe(false);
  });

  it('reads an unknown name as not-set on a node that allows undeclared names, as the node says', async () => {
    // rclpy (Jazzy, node.py describe_parameter) answers such a node's unknown
    // names with type 0 and a default descriptor: no request tells them apart.
    const { port, calls } = fakeNode('json', DEMO, { allowUndeclared: true });
    expect(await parameters.getParameters(port, NODE, ['unset', 'nope', 'i'])).toEqual([
      { name: 'unset', state: 'not-set' },
      { name: 'nope', state: 'not-set' },
      { name: 'i', state: 'set', value: { type: 'integer', value: 42n } },
    ]);
    expect(calls.some((c) => c.service.endsWith('/describe_parameters'))).toBe(false);
  });
});

describe('parameters: writes', () => {
  it.each(['cdr', 'json'] as const)(
    'reports each change on its own, with the node reason, on %s',
    async (wire) => {
      const { port, calls } = fakeNode(wire, DEMO);
      const results = await parameters.setParameters(port, NODE, [
        { name: 'ro', value: { type: 'integer', value: 8n } },
        { name: 'i', value: { type: 'integer', value: 43n } },
      ]);
      expect(results).toEqual([
        { name: 'ro', successful: false, reason: 'Trying to set a read-only parameter: ro.' },
        { name: 'i', successful: true, reason: '' },
      ]);
      expect(calls[0]!.request).toEqual({
        parameters: [
          { name: 'ro', value: { type: 2, integer_value: wire === 'cdr' ? 8n : 8 } },
          { name: 'i', value: { type: 2, integer_value: wire === 'cdr' ? 43n : 43 } },
        ],
      });
    },
  );

  it.each(['cdr', 'json'] as const)(
    'refuses a value of unknown type before asking the node, on %s',
    async (wire) => {
      // An unknown type would go out as type 0, PARAMETER_NOT_SET, which a
      // node that allows type changes reads as "undeclare this parameter".
      const { port, calls } = fakeNode(wire, DEMO);
      const bad = [{ name: 'i', value: { type: 'int', value: 2 } }] as unknown as Parameters<
        typeof parameters.setParameters
      >[2];
      await expect(parameters.setParameters(port, NODE, bad)).rejects.toThrow(RangeError);
      await expect(parameters.setParametersAtomically(port, NODE, bad)).rejects.toThrow(RangeError);
      expect(calls).toEqual([]);
    },
  );

  it('answers no changes without asking the node, atomically or not', async () => {
    const { port, calls } = fakeNode('cdr', DEMO);
    expect(await parameters.setParameters(port, '/missing', [])).toEqual([]);
    expect(await parameters.setParametersAtomically(port, '/missing', [])).toEqual({
      successful: true,
      reason: '',
    });
    expect(calls).toEqual([]);
  });

  it('answers an atomic change with the node one answer', async () => {
    const { port } = fakeNode('cdr', DEMO);
    expect(
      await parameters.setParametersAtomically(port, NODE, [
        { name: 'i', value: { type: 'integer', value: 1n } },
        { name: 'ro', value: { type: 'integer', value: 1n } },
      ]),
    ).toEqual({ successful: false, reason: 'read-only' });
  });
});

describe('parameters: nodes and errors', () => {
  it('lists the nodes that advertise list_parameters, sorted', async () => {
    const { port } = fakeNode('json', DEMO);
    expect(await parameters.getParameterNodes(port)).toEqual(['/other', NODE]);
  });

  it('lists names, passing prefixes and depth in the wire integer form', async () => {
    const { port, calls } = fakeNode('cdr', DEMO);
    expect(await parameters.listParameters(port, NODE, { prefixes: ['a'], depth: 2 })).toContain(
      'unset',
    );
    expect(calls[0]!.request).toEqual({ prefixes: ['a'], depth: 2n });
  });

  it('rejects a node without parameter services with ParameterServiceError', async () => {
    const { port } = fakeNode('json', DEMO);
    const err = await parameters.getParameters(port, '/nope', ['x']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ParameterServiceError);
    expect(err).toMatchObject({
      name: 'ParameterServiceError',
      reason: 'no-parameter-services',
      node: '/nope',
      service: '/nope/get_parameter_types',
    });
  });

  it('keeps the call own error when the node does have the service', async () => {
    const { port } = fakeNode('json', DEMO);
    port.callService = async () => {
      throw new Error('Service call timed out after 30s');
    };
    await expect(parameters.listParameters(port, NODE)).rejects.toThrow('timed out after 30s');
  });

  it('keeps the call own error when the service list cannot be read either', async () => {
    const { port } = fakeNode('json', DEMO);
    port.callService = async () => {
      throw new Error('boom');
    };
    port.serviceNames = async () => {
      throw new ParameterServiceError('discovery-unavailable', '', '');
    };
    await expect(parameters.listParameters(port, '/nope')).rejects.toThrow('boom');
  });

  it('sends one-name requests one at a time', async () => {
    const { port } = fakeNode('json', DEMO);
    const names = Array.from({ length: 14 }, (_, i) => `n${i}`);
    let inFlight = 0;
    let most = 0;
    port.callService = async (_service, request) => {
      const asked = request.names as string[];
      if (asked.length > 1) return { descriptors: [] };
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return { descriptors: [] };
    };
    const out = await parameters.describeParameters(port, NODE, names);
    expect(out).toHaveLength(14);
    expect(most).toBe(1);
  });

  it('reads the service list once for a whole failed one-at-a-time pass', async () => {
    const { port } = fakeNode('json', DEMO);
    let reads = 0;
    const inner = port.serviceNames;
    port.serviceNames = () => {
      reads++;
      return inner();
    };
    // The batch comes back empty, then every one-name request times out.
    port.callService = async (service, request) => {
      if ((request.names as string[]).length > 1) return { descriptors: [] };
      throw new Error(`Service call "${service}" timed out`);
    };
    await expect(parameters.describeParameters(port, NODE, ['a', 'b', 'c', 'd'])).rejects.toThrow(
      'timed out',
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(reads).toBe(1);
  });

  it('refuses a depth that is not a whole number of 0 or more, before asking the node', async () => {
    const { port, calls } = fakeNode('cdr', DEMO);
    for (const depth of [1.5, -1, NaN]) {
      await expect(parameters.listParameters(port, NODE, { depth })).rejects.toThrow(RangeError);
    }
    expect(calls).toEqual([]);
  });

  it('passes discovery-unavailable through from getParameterNodes', async () => {
    const { port } = fakeNode('json', DEMO);
    port.serviceNames = async () => {
      throw new ParameterServiceError('discovery-unavailable', '', '');
    };
    await expect(parameters.getParameterNodes(port)).rejects.toMatchObject({
      reason: 'discovery-unavailable',
    });
  });
});
