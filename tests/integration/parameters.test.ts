import { afterEach, describe, expect, inject, it } from 'vitest';
import { ParameterServiceError } from '../../src/errors';
import { FoxgloveClient } from '../../src/FoxgloveClient';
import { RosbridgeClient } from '../../src/RosbridgeClient';
import type { IProtocolClient } from '../../src/types';

/**
 * The parameter surface (ADR 0021) against both stock bridges, on the
 * fixture's /params/demo node (tests/integration/docker/fixture_nodes.py).
 * Every read and write goes through the node's own rcl_interfaces services.
 * Writes use the `w_` parameters, one per test.
 */
const NODE = '/params/demo';

const TRANSPORTS = [
  {
    label: 'Foxglove WebSocket',
    make: () => new FoxgloveClient(),
    url: () => inject('foxgloveUrl'),
  },
  { label: 'rosbridge', make: () => new RosbridgeClient(), url: () => inject('rosbridgeUrl') },
] as const;

describe.each(TRANSPORTS)('parameters over $label', ({ label, make, url }) => {
  const clients: IProtocolClient[] = [];

  async function connected(): Promise<IProtocolClient> {
    const client = make();
    clients.push(client);
    await client.connect(url());
    return client;
  }

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.disconnect();
  });

  it('lists the node among the parameter nodes right after connect', async () => {
    const client = await connected();
    const nodes = await client.getParameterNodes();
    expect(nodes).toContain(NODE);
    expect(nodes).toEqual([...nodes].sort());
  });

  it('lists names, dotted ones included', async () => {
    const client = await connected();
    const names = await client.listParameters(NODE);
    expect(names).toEqual(expect.arrayContaining(['i', 'a.b.c', 'unset', 'ro']));
    expect(await client.listParameters(NODE, { prefixes: ['a'] })).toEqual(['a.b.c']);
  });

  it('reads every type, and tells set, not-set and undeclared apart in one call', async () => {
    const client = await connected();
    const readings = await client.getParameters(NODE, [
      'b',
      'i',
      'd',
      'd_whole',
      's',
      'bool_arr',
      'int_arr',
      'dbl_arr',
      'str_arr',
      'int_arr_empty',
      'a.b.c',
      'unset',
      'unset_dyn',
      'nope',
    ]);
    expect(readings).toEqual([
      { name: 'b', state: 'set', value: { type: 'bool', value: true } },
      { name: 'i', state: 'set', value: { type: 'integer', value: 42n } },
      { name: 'd', state: 'set', value: { type: 'double', value: 1.5 } },
      { name: 'd_whole', state: 'set', value: { type: 'double', value: 2 } },
      { name: 's', state: 'set', value: { type: 'string', value: 'hello/world "q"' } },
      { name: 'bool_arr', state: 'set', value: { type: 'bool_array', value: [true, false] } },
      { name: 'int_arr', state: 'set', value: { type: 'integer_array', value: [1n, 2n, 3n] } },
      { name: 'dbl_arr', state: 'set', value: { type: 'double_array', value: [1, 2.5] } },
      { name: 'str_arr', state: 'set', value: { type: 'string_array', value: ['a', 'b'] } },
      { name: 'int_arr_empty', state: 'set', value: { type: 'integer_array', value: [] } },
      { name: 'a.b.c', state: 'set', value: { type: 'string', value: 'dotted' } },
      { name: 'unset', state: 'not-set' },
      { name: 'unset_dyn', state: 'not-set' },
      { name: 'nope', state: 'undeclared' },
    ]);
  });

  it('reads a byte array where the transport can carry it, without holding up the rest', async () => {
    const client = await connected();
    const started = Date.now();
    const [i, ba] = await client.getParameters(NODE, ['i', 'ba'], { timeoutMs: 10_000 });
    expect(i).toEqual({ name: 'i', state: 'set', value: { type: 'integer', value: 42n } });
    if (label === 'rosbridge') {
      expect(ba).toEqual({ name: 'ba', state: 'unreadable', type: 'byte_array' });
    } else {
      expect(ba).toEqual({
        name: 'ba',
        state: 'set',
        value: { type: 'byte_array', value: new Uint8Array([0, 1, 255]) },
      });
    }
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('describes types, ranges and read-only, and an undeclared name', async () => {
    const client = await connected();
    const [ro, ranged, unset, nope] = await client.describeParameters(NODE, [
      'ro',
      'ranged',
      'unset',
      'nope',
    ]);
    expect(ro).toMatchObject({ name: 'ro', state: 'declared', type: 'integer', readOnly: true });
    expect(ranged).toMatchObject({
      state: 'declared',
      description: 'between 0 and 10',
      integerRange: { from: 0n, to: 10n, step: 1n },
    });
    expect(unset).toMatchObject({ state: 'declared', type: 'integer' });
    expect(nope).toEqual({ name: 'nope', state: 'undeclared' });
  });

  it('applies each change on its own and reports a refusal with the node reason', async () => {
    const client = await connected();
    // Both transports write the same value, so their order does not matter.
    const name = 'w_int';
    const results = await client.setParameters(NODE, [
      { name, value: { type: 'integer', value: 21n } },
      { name: 'ro', value: { type: 'integer', value: 8n } },
      { name: 'ranged', value: { type: 'integer', value: 99n } },
      { name: 'w_types', value: { type: 'string', value: 'nope' } },
    ]);
    expect(results[0]).toEqual({ name, successful: true, reason: '' });
    expect(results.slice(1).map((r) => r.successful)).toEqual([false, false, false]);
    expect(results[1]!.reason).toContain('read-only');
    const [after] = await client.getParameters(NODE, [name]);
    expect(after).toEqual({ name, state: 'set', value: { type: 'integer', value: 21n } });
  });

  it('applies an atomic change all together or not at all', async () => {
    const client = await connected();
    const refused = await client.setParametersAtomically(NODE, [
      { name: 'w_atomic_a', value: { type: 'integer', value: 100n } },
      { name: 'ro', value: { type: 'integer', value: 8n } },
    ]);
    expect(refused.successful).toBe(false);
    const [a] = await client.getParameters(NODE, ['w_atomic_a']);
    expect(a).toMatchObject({ state: 'set' });
    expect(a).not.toEqual({
      name: 'w_atomic_a',
      state: 'set',
      value: { type: 'integer', value: 100n },
    });
  });

  it('tells set from undeclared on a C++ node too (the bridge node itself)', async () => {
    // /foxglove_bridge is rclcpp; /params/demo is rclpy. The rules agree.
    const client = await connected();
    const readings = await client.getParameters('/foxglove_bridge', ['port', 'nope']);
    expect(readings).toEqual([
      { name: 'port', state: 'set', value: { type: 'integer', value: 8765n } },
      { name: 'nope', state: 'undeclared' },
    ]);
  });

  it('rejects a node that does not exist with ParameterServiceError', async () => {
    const client = await connected();
    const err = await client.getParameters('/no_such_node', ['x']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ParameterServiceError);
    expect(err).toMatchObject({ reason: 'no-parameter-services', node: '/no_such_node' });
  });
});

describe('parameters across transports', () => {
  it('a byte array written over rosbridge reads back over Foxglove WebSocket', async () => {
    const rosbridge = new RosbridgeClient();
    const foxglove = new FoxgloveClient();
    try {
      await rosbridge.connect(inject('rosbridgeUrl'));
      await foxglove.connect(inject('foxgloveUrl'));
      const [result] = await rosbridge.setParameters(NODE, [
        { name: 'ba', value: { type: 'byte_array', value: new Uint8Array([9, 8, 7]) } },
      ]);
      expect(result).toEqual({ name: 'ba', successful: true, reason: '' });
      const [read] = await foxglove.getParameters(NODE, ['ba']);
      expect(read).toEqual({
        name: 'ba',
        state: 'set',
        value: { type: 'byte_array', value: new Uint8Array([9, 8, 7]) },
      });
    } finally {
      await rosbridge.disconnect();
      await foxglove.disconnect();
    }
  });
});
