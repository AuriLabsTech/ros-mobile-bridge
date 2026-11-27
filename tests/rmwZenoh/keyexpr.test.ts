import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QOS,
  TYPE_HASH_NOT_SUPPORTED,
  dataKey,
  ddsTypeName,
  detectNamingForm,
  endpointToken,
  hashForm,
  livelinessKeyExpr,
  nodeToken,
  parseDataKey,
  parseLivelinessToken,
  rosTypeName,
  topicSubscriptionKeyExpr,
  type EndpointQos,
  type GraphEndpoint,
  type GraphEntity,
} from '../../src/rmwZenoh/keyexpr';
import { keyExprMatches } from '../../src/zenoh/keyExpr';

const readTokens = (file: string): string[] =>
  readFileSync(fileURLToPath(new URL(`../fixtures/rmw-zenoh/${file}`, import.meta.url)), 'utf8')
    .split('\n')
    .filter((l) => l.length > 0);

const HUMBLE = readTokens('humble-tokens.txt');
const JAZZY = readTokens('jazzy-tokens.txt');

const STRING_HASH = 'RIHS01_df668c740482bbd48fb39d76a70dfd4bd59db1288021743503259e948f6b1a18';
const ADD_TWO_INTS_HASH = 'RIHS01_e118de6bf5eeb66a2491b5bda11202e7b68f198d6f67922cf30364858239c81a';

const parseAll = (tokens: string[]): GraphEntity[] =>
  tokens.map((t) => {
    const e = parseLivelinessToken(t);
    if (e === null) throw new Error(`capture token did not parse: ${t}`);
    return e;
  });

const countKinds = (entities: GraphEntity[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const e of entities) out[e.kind] = (out[e.kind] ?? 0) + 1;
  return out;
};

const asEndpoint = (e: GraphEntity | null): GraphEndpoint => {
  if (e === null || e.kind === 'node') throw new Error('expected an endpoint');
  return e;
};

describe('type names', () => {
  it.each([
    ['std_msgs/msg/String', 'msg', 'std_msgs::msg::dds_::String_'],
    ['std_msgs/String', 'msg', 'std_msgs::msg::dds_::String_'],
    ['example_interfaces/srv/AddTwoInts', 'msg', 'example_interfaces::srv::dds_::AddTwoInts_'],
    ['example_interfaces/AddTwoInts', 'srv', 'example_interfaces::srv::dds_::AddTwoInts_'],
    // An action's parts keep their `action` kind (topic and service types alike).
    [
      'nav2_msgs/action/NavigateToPose_FeedbackMessage',
      'msg',
      'nav2_msgs::action::dds_::NavigateToPose_FeedbackMessage_',
    ],
  ] as const)('ddsTypeName(%s, %s) is %s', (ros, kind, dds) => {
    expect(ddsTypeName(ros, kind)).toBe(dds);
  });

  it.each([
    '',
    'String',
    'std_msgs/msg/',
    '/msg/String',
    'a/b/c/d',
    'std_msgs/foo/String',
    'a b/msg/C',
  ])('ddsTypeName refuses %j', (ros) => {
    expect(ddsTypeName(ros, 'msg')).toBeNull();
  });

  it.each([
    ['std_msgs::msg::dds_::String_', 'std_msgs/msg/String'],
    ['example_interfaces::srv::dds_::AddTwoInts_', 'example_interfaces/srv/AddTwoInts'],
    [
      'nav2_msgs::action::dds_::NavigateToPose_SendGoal_',
      'nav2_msgs/action/NavigateToPose_SendGoal',
    ],
  ])('rosTypeName(%s) is %s', (dds, ros) => {
    expect(rosTypeName(dds)).toBe(ros);
  });

  it.each([
    'std_msgs::msg::String_',
    'std_msgs::msg::dds_::String',
    'std_msgs::foo::dds_::String_',
    'std_msgs/msg/String',
    '::msg::dds_::String_',
    'std_msgs::msg::dds_::_',
    '',
  ])('rosTypeName refuses %j', (dds) => {
    expect(rosTypeName(dds)).toBeNull();
  });
});

describe('hashForm', () => {
  it('reads both forms', () => {
    expect(hashForm(STRING_HASH)).toBe('rihs01');
    expect(hashForm(TYPE_HASH_NOT_SUPPORTED)).toBe('unsupported');
  });

  it.each([
    'RIHS01_',
    STRING_HASH.slice(0, -1),
    STRING_HASH + '0',
    STRING_HASH.toUpperCase(),
    'RIHS02_' + STRING_HASH.slice(7),
    'typehashnotsupported',
    '*',
    '_buf_cpu',
  ])('refuses %j', (s) => {
    expect(hashForm(s)).toBeNull();
  });
});

describe('data keys', () => {
  it('builds the keys rmw_zenoh documents', () => {
    expect(dataKey(0, '/chatter', 'std_msgs::msg::dds_::String_', STRING_HASH)).toBe(
      `0/chatter/std_msgs::msg::dds_::String_/${STRING_HASH}`,
    );
    expect(dataKey(0, '/robot1/chatter', 'std_msgs::msg::dds_::String_', STRING_HASH)).toBe(
      `0/robot1/chatter/std_msgs::msg::dds_::String_/${STRING_HASH}`,
    );
    expect(
      dataKey(2, '/add_two_ints', 'example_interfaces::srv::dds_::AddTwoInts_', ADD_TWO_INTS_HASH),
    ).toBe(`2/add_two_ints/example_interfaces::srv::dds_::AddTwoInts_/${ADD_TWO_INTS_HASH}`);
    expect(dataKey(0, '/chatter', 'std_msgs::msg::dds_::String_', TYPE_HASH_NOT_SUPPORTED)).toBe(
      '0/chatter/std_msgs::msg::dds_::String_/TypeHashNotSupported',
    );
  });

  it.each([
    ['/a/b/c', 'example_interfaces::srv::dds_::AddTwoInts_', ADD_TWO_INTS_HASH],
    [
      '/talker/get_parameters',
      'rcl_interfaces::srv::dds_::GetParameters_',
      TYPE_HASH_NOT_SUPPORTED,
    ],
    ['/x', 'std_msgs::msg::dds_::String_', STRING_HASH],
  ])('round-trips %s', (name, dds, hash) => {
    const parsed = parseDataKey(dataKey(17, name, dds, hash));
    expect(parsed).toEqual({
      domainId: 17,
      name,
      ddsType: dds,
      rosType: rosTypeName(dds),
      hashSegment: hash,
      hashForm: hashForm(hash),
    });
  });

  it.each([
    ['relative name', 7, 'chatter'],
    ['trailing slash', 7, '/chatter/'],
    ['empty chunk', 7, '/a//b'],
    ['root only', 7, '/'],
    ['wildcard', 7, '/a/**'],
    ['single wildcard', 7, '/*'],
    ['dollar', 7, '/a$*'],
    ['percent', 7, '/a%b'],
    ['negative domain', -1, '/chatter'],
    ['fractional domain', 1.5, '/chatter'],
  ])('dataKey refuses a %s', (_label, domain, name) => {
    expect(() => dataKey(domain, name, 'std_msgs::msg::dds_::String_', STRING_HASH)).toThrow(
      RangeError,
    );
  });

  it('dataKey refuses a bad type or hash', () => {
    expect(() => dataKey(0, '/chatter', 'std_msgs/msg/String', STRING_HASH)).toThrow(RangeError);
    expect(() => dataKey(0, '/chatter', 'std_msgs::msg::dds_::String_', '*')).toThrow(RangeError);
  });

  it.each([
    ['too few chunks', `0/std_msgs::msg::dds_::String_/${STRING_HASH}`],
    ['non-numeric domain', `x/chatter/std_msgs::msg::dds_::String_/${STRING_HASH}`],
    ['empty chunk', `0//chatter/std_msgs::msg::dds_::String_/${STRING_HASH}`],
    ['type without dds_', `0/chatter/std_msgs::msg::String_/${STRING_HASH}`],
    ['wildcard hash', '0/chatter/std_msgs::msg::dds_::String_/*'],
    ['buffer cpu channel', `0/chatter/std_msgs::msg::dds_::String_/${STRING_HASH}/_buf_cpu`],
    [
      'buffer per-subscriber channel',
      `0/chatter/std_msgs::msg::dds_::String_/${STRING_HASH}/_buf/0123456789abcdef0123456789abcdef`,
    ],
    ['empty', ''],
  ])('parseDataKey refuses %s', (_label, key) => {
    expect(parseDataKey(key)).toBeNull();
  });
});

describe('the subscription key expression', () => {
  const base = `0/chatter/sensor_msgs::msg::dds_::Image_/${STRING_HASH}`;

  it('is a type and a hash after the name, never `**`', () => {
    expect(topicSubscriptionKeyExpr(0, '/chatter')).toBe('0/chatter/*/*');
    expect(topicSubscriptionKeyExpr(3, '/robot1/chatter')).toBe('3/robot1/chatter/*/*');
  });

  it('matches the base key and neither buffer channel', () => {
    const expr = topicSubscriptionKeyExpr(0, '/chatter');
    const bufCpu = `${base}/_buf_cpu`;
    const bufSub = `${base}/_buf/0123456789abcdef0123456789abcdef`;
    expect(keyExprMatches(expr, base)).toBe(true);
    expect(keyExprMatches(expr, bufCpu)).toBe(false);
    expect(keyExprMatches(expr, bufSub)).toBe(false);
    // The `/**` form every probe used would also take both buffer channels,
    // whose `_buf/<gid>` payload is a descriptor, not CDR.
    expect(keyExprMatches('0/chatter/**', bufCpu)).toBe(true);
    expect(keyExprMatches('0/chatter/**', bufSub)).toBe(true);
  });

  it('does not match a longer topic under the same prefix', () => {
    expect(
      keyExprMatches(
        topicSubscriptionKeyExpr(0, '/odom'),
        `0/odom/filtered/nav_msgs::msg::dds_::Odometry_/${STRING_HASH}`,
      ),
    ).toBe(false);
  });

  it('refuses a name that would widen it', () => {
    expect(() => topicSubscriptionKeyExpr(0, '/**')).toThrow(RangeError);
    expect(() => topicSubscriptionKeyExpr(0, 'chatter')).toThrow(RangeError);
  });

  it('names the graph of one domain', () => {
    expect(livelinessKeyExpr(17)).toBe('@ros2_lv/17/**');
    expect(() => livelinessKeyExpr(-1)).toThrow(RangeError);
  });
});

describe('liveliness tokens from the captures', () => {
  it.each([
    [
      'Humble, rmw_zenoh 0.1.11',
      HUMBLE,
      29,
      'unsupported',
      { node: 4, publisher: 9, subscriber: 3, 'service-server': 13 },
    ],
    [
      'Jazzy, rmw_zenoh 0.2.11',
      JAZZY,
      32,
      'rihs01',
      { node: 4, publisher: 9, subscriber: 3, 'service-server': 16 },
    ],
  ] as const)(
    '%s: every token parses, kinds and form match',
    (_label, tokens, total, form, kinds) => {
      expect(tokens).toHaveLength(total);
      const entities = parseAll(tokens);
      expect(countKinds(entities)).toEqual(kinds);
      expect(detectNamingForm(entities)).toBe(form);
      for (const e of entities) {
        expect(e.token).toBe(tokens[entities.indexOf(e)]);
        expect(e.node.domainId).toBe(0);
        expect(e.node.enclave).toBe('/');
        expect(e.node.namespace).toBe('/');
        if (e.kind !== 'node') {
          expect(e.hashForm).toBe(form);
          expect(e.name.startsWith('/')).toBe(true);
          expect(e.name).not.toContain('%');
          expect(e.rosType).toBe(rosTypeName(e.ddsType));
          expect(e.backends).toBeNull();
        }
      }
    },
  );

  it('reads a node token', () => {
    const e = parseLivelinessToken(HUMBLE[0] ?? '');
    expect(e).toEqual({
      kind: 'node',
      token: '@ros2_lv/0/a77146894ea0f206120611d6c2617252/0/0/NN/%/%/talker',
      node: {
        domainId: 0,
        zid: 'a77146894ea0f206120611d6c2617252',
        nodeId: '0',
        enclave: '/',
        namespace: '/',
        name: 'talker',
      },
    });
  });

  it('demangles nested service names', () => {
    const e = asEndpoint(parseLivelinessToken(HUMBLE[1] ?? ''));
    expect(e.kind).toBe('service-server');
    expect(e.name).toBe('/talker/get_parameters');
    expect(e.entityId).toBe('2');
    expect(e.rosType).toBe('rcl_interfaces/srv/GetParameters');
    expect(e.hashSegment).toBe(TYPE_HASH_NOT_SUPPORTED);
  });

  it('reads the QoS chunks the captures hold', () => {
    const chatter = asEndpoint(
      parseLivelinessToken(JAZZY.find((t) => t.includes('/MP/') && t.includes('%chatter/')) ?? ''),
    );
    expect(chatter.name).toBe('/chatter');
    expect(chatter.hashSegment).toBe(STRING_HASH);
    expect(chatter.qosRaw).toBe('::,7:,:,:,,');
    expect(chatter.qos).toEqual({ ...DEFAULT_QOS, depth: 7 });

    const rosout = asEndpoint(parseLivelinessToken(JAZZY[1] ?? ''));
    expect(rosout.name).toBe('/rosout');
    expect(rosout.qosRaw).toBe(':1:,1000:,:10,0:,,');
    expect(rosout.qos).toEqual({ ...DEFAULT_QOS, durability: 'transient-local', depth: 1000 });

    const echo = asEndpoint(
      parseLivelinessToken(
        HUMBLE.find((t) => t.includes('/MS/') && t.includes('%zjs_probe/')) ?? '',
      ),
    );
    expect(echo.qos).toEqual({ ...DEFAULT_QOS, reliability: 'best-effort', depth: 5 });
  });

  it('is mixed when both forms appear, unknown with no endpoint', () => {
    expect(detectNamingForm(parseAll([...HUMBLE, ...JAZZY]))).toBe('mixed');
    expect(detectNamingForm(parseAll(HUMBLE.filter((t) => t.includes('/NN/'))))).toBe('unknown');
    expect(detectNamingForm([])).toBe('unknown');
  });

  it('rebuilds every capture token whose QoS the builder can express', () => {
    let rebuilt = 0;
    for (const token of [...HUMBLE, ...JAZZY]) {
      const e = parseLivelinessToken(token);
      if (e === null) throw new Error(token);
      if (e.kind === 'node') {
        expect(nodeToken(e.node)).toBe(token);
        rebuilt++;
        continue;
      }
      // `/rosout` sets a lifespan, which the builder does not write.
      if (e.name === '/rosout') continue;
      expect(
        endpointToken({
          node: e.node,
          entityId: e.entityId,
          kind: e.kind,
          name: e.name,
          ddsType: e.ddsType,
          hashSegment: e.hashSegment,
          qos: e.qos,
        }),
      ).toBe(token);
      rebuilt++;
    }
    expect(rebuilt).toBe(61 - 8);
  });
});

describe('liveliness tokens not in the captures', () => {
  // Constructed from rmw_zenoh's docs/design.md (rolling): no capture holds an
  // SC token or a backends chunk.
  const SC = `@ros2_lv/0/e1dc8d1b45ae8717fce78689cc655685/0/10/SC/%/%/add_two_ints_client/%add_two_ints/example_interfaces::srv::dds_::AddTwoInts_/${ADD_TWO_INTS_HASH}/::,10:,:,:,,`;
  const BACKENDS = `@ros2_lv/0/aac3178e146ba6f1fc6e6a4085e77f21/0/10/MS/%/%/listener/%chatter/sensor_msgs::msg::dds_::Image_/${STRING_HASH}/::,10:,:,:,,/backends:cpu:;cuda:abc%3A1`;

  it('reads a service client (constructed row)', () => {
    const e = asEndpoint(parseLivelinessToken(SC));
    expect(e.kind).toBe('service-client');
    expect(e.name).toBe('/add_two_ints');
    expect(e.qos.depth).toBe(10);
  });

  it('accepts a backends chunk and keeps it raw (constructed row)', () => {
    const e = asEndpoint(parseLivelinessToken(BACKENDS));
    expect(e.kind).toBe('subscriber');
    expect(e.backends).toBe('backends:cpu:;cuda:abc%3A1');
    expect(e.qosRaw).toBe('::,10:,:,:,,');
  });

  it('reads namespaces, enclaves and every QoS value rmw_zenoh writes', () => {
    const token =
      '@ros2_lv/42/0011aabb/3/7/MP/%secure%robot/%robot1%arm/driver/%robot1%arm%joint_states/sensor_msgs::msg::dds_::JointState_/TypeHashNotSupported/2:1:2,0:1,2:3,4:3,5,6';
    const e = asEndpoint(parseLivelinessToken(token));
    expect(e.node).toEqual({
      domainId: 42,
      zid: '0011aabb',
      nodeId: '3',
      enclave: '/secure/robot',
      namespace: '/robot1/arm',
      name: 'driver',
    });
    expect(e.name).toBe('/robot1/arm/joint_states');
    expect(e.qos).toEqual({
      reliability: 'best-effort',
      durability: 'transient-local',
      history: 'keep-all',
      depth: 0,
    });
    expect(e.qosRaw).toBe('2:1:2,0:1,2:3,4:3,5,6');
  });

  it.each([
    ['0', 'system-default'],
    ['3', 'unknown'],
    ['4', 'best-available'],
  ])('reads reliability %s as %s', (n, name) => {
    const token = `@ros2_lv/0/aa/0/1/MP/%/%/n/%t/std_msgs::msg::dds_::String_/${STRING_HASH}/${n}::,:,:,:,,`;
    expect(asEndpoint(parseLivelinessToken(token)).qos.reliability).toBe(name);
  });

  it('round-trips built tokens through the parser', () => {
    const node = {
      domainId: 5,
      zid: 'f00d',
      nodeId: '1',
      enclave: '/',
      namespace: '/fleet/r2',
      name: 'rmb_client',
    };
    const nodeParsed = parseLivelinessToken(nodeToken(node));
    expect(nodeParsed).toEqual({ kind: 'node', token: nodeToken(node), node });

    const qos: EndpointQos = {
      reliability: 'best-effort',
      durability: 'volatile',
      history: 'keep-last',
      depth: 1,
    };
    for (const kind of ['publisher', 'subscriber', 'service-server', 'service-client'] as const) {
      const args = {
        node,
        entityId: '9',
        kind,
        name: '/fleet/r2/cmd_vel',
        ddsType: 'geometry_msgs::msg::dds_::Twist_',
        hashSegment: STRING_HASH,
        qos,
      };
      const token = endpointToken(args);
      const e = asEndpoint(parseLivelinessToken(token));
      expect(e).toMatchObject({
        ...args,
        token,
        rosType: 'geometry_msgs/msg/Twist',
        backends: null,
      });
      expect(e.qos).toEqual(qos);
    }
  });

  it('writes the all-default QoS as rmw_zenoh does', () => {
    const token = endpointToken({
      node: { domainId: 0, zid: 'aa', nodeId: '0', enclave: '/', namespace: '/', name: 'n' },
      entityId: '1',
      kind: 'publisher',
      name: '/t',
      ddsType: 'std_msgs::msg::dds_::String_',
      hashSegment: STRING_HASH,
      qos: DEFAULT_QOS,
    });
    expect(token.endsWith('/::,:,:,:,,')).toBe(true);
  });

  it.each([
    ['zid not hex', { zid: 'XYZ' }],
    ['node id not a number', { nodeId: 'a' }],
    ['relative namespace', { namespace: 'robot1' }],
    ['node name with slash', { name: 'a/b' }],
    ['node name with percent', { name: 'a%b' }],
    ['empty enclave', { enclave: '' }],
    ['negative domain', { domainId: -1 }],
  ])('nodeToken refuses a %s', (_label, change) => {
    const node = {
      domainId: 0,
      zid: 'aa',
      nodeId: '0',
      enclave: '/',
      namespace: '/',
      name: 'n',
      ...change,
    };
    expect(() => nodeToken(node)).toThrow(RangeError);
  });

  it('endpointToken refuses a bad name, type, hash or depth', () => {
    const base = {
      node: { domainId: 0, zid: 'aa', nodeId: '0', enclave: '/', namespace: '/', name: 'n' },
      entityId: '1',
      kind: 'publisher' as const,
      name: '/t',
      ddsType: 'std_msgs::msg::dds_::String_',
      hashSegment: STRING_HASH,
      qos: DEFAULT_QOS,
    };
    expect(() => endpointToken({ ...base, name: '/t/**' })).toThrow(RangeError);
    expect(() => endpointToken({ ...base, ddsType: 'std_msgs/msg/String' })).toThrow(RangeError);
    expect(() => endpointToken({ ...base, hashSegment: '*' })).toThrow(RangeError);
    expect(() => endpointToken({ ...base, entityId: '' })).toThrow(RangeError);
    expect(() => endpointToken({ ...base, qos: { ...DEFAULT_QOS, depth: -1 } })).toThrow(
      RangeError,
    );
    expect(() => endpointToken({ ...base, qos: { ...DEFAULT_QOS, depth: 1.5 } })).toThrow(
      RangeError,
    );
  });
});

describe('hostile tokens', () => {
  // Any session on the router can declare a token, so every one of these comes
  // from a peer the client does not control. Each must return null, none throw.
  const GOOD = `@ros2_lv/0/aa/0/1/MP/%/%/n/%t/std_msgs::msg::dds_::String_/${STRING_HASH}/::,:,:,:,,`;
  const chunks = GOOD.split('/');
  const withChunk = (i: number, v: string): string =>
    chunks.map((c, j) => (j === i ? v : c)).join('/');

  it('the base row parses', () => {
    expect(parseLivelinessToken(GOOD)).not.toBeNull();
  });

  it.each([
    ['empty', ''],
    ['a node token cut short', '@ros2_lv/0/aa/0/0/NN/%/%'],
    ['an endpoint without its QoS', chunks.slice(0, 12).join('/')],
    ['an empty chunk', withChunk(9, '')],
    ['a trailing slash', GOOD + '/'],
    ['the wrong admin space', withChunk(0, '@ros2_lx')],
    ['an unknown kind', withChunk(5, 'AS')],
    ['a lowercase kind', withChunk(5, 'mp')],
    ['a non-numeric domain', withChunk(1, 'zero')],
    ['a signed domain', withChunk(1, '-1')],
    ['a hex domain', withChunk(1, '0x1')],
    ['a domain past 2^53', withChunk(1, '9007199254740993')],
    ['a type without dds_', withChunk(10, 'std_msgs::msg::String_')],
    ['a wildcard hash', withChunk(11, '*')],
    ['a QoS chunk with five groups', withChunk(12, '::,:,:,')],
    ['a QoS chunk with seven groups', withChunk(12, '::,:,:,:,,:')],
    ['a history group without depth', withChunk(12, '::1:,:,:,,')],
    ['a liveliness group with two parts', withChunk(12, '::,:,:,:,')],
    ['an unknown reliability', withChunk(12, '9::,:,:,:,,')],
    ['an unknown durability', withChunk(12, ':5:,:,:,:,,')],
    ['an unknown history', withChunk(12, '::4,:,:,:,,')],
    ['manual-by-node liveliness, not in rmw_zenoh', withChunk(12, '::,:,:,:2,,')],
    ['a negative depth', withChunk(12, '::,-1:,:,:,,')],
    ['a depth with junk', withChunk(12, '::,7x:,:,:,,')],
    ['a depth past 2^64', withChunk(12, '::,18446744073709551616:,:,:,,')],
    ['a depth past 2^53', withChunk(12, '::,9007199254740993:,:,:,,')],
    ['a deadline past 2^64', withChunk(12, '::,:18446744073709551616,:,:,,')],
    ['a lease with a space', withChunk(12, '::,:,:,:, 1,')],
  ])('refuses %s', (_label, token) => {
    expect(() => parseLivelinessToken(token)).not.toThrow();
    expect(parseLivelinessToken(token)).toBeNull();
  });

  it('accepts a duration at 2^64 - 1, as rmw_zenoh does', () => {
    const e = asEndpoint(parseLivelinessToken(withChunk(12, '::,:18446744073709551615,:,:,,')));
    expect(e.qosRaw).toBe('::,:18446744073709551615,:,:,,');
  });

  it('refuses a two-digit enum field, which rmw_zenoh would read', () => {
    expect(parseLivelinessToken(withChunk(12, '01::,:,:,:,,'))).toBeNull();
  });

  it('ignores chunks past a node token’s 9th, as rmw_zenoh does', () => {
    const e = parseLivelinessToken('@ros2_lv/0/aa/0/0/NN/%/%/talker/x');
    expect(e?.kind).toBe('node');
    expect(e?.token).toBe('@ros2_lv/0/aa/0/0/NN/%/%/talker/x');
  });

  it('ignores chunks past the backends chunk, as rmw_zenoh does', () => {
    const e = asEndpoint(parseLivelinessToken(`${GOOD}/notbackends/more`));
    expect(e.backends).toBeNull();
    expect(e.token).toBe(`${GOOD}/notbackends/more`);
  });

  it('parses a very long token without backtracking', () => {
    // A backtracking regex on this input would not finish at all; a linear
    // parse takes milliseconds. The bound is loose so a busy machine passes.
    const token =
      withChunk(10, 'a::msg::dds_::' + 'b'.repeat(1_000_000)) + '/' + 'c'.repeat(1_000_000);
    const start = performance.now();
    expect(parseLivelinessToken(token)).toBeNull();
    expect(performance.now() - start).toBeLessThan(10_000);
  });
});

describe('what a parser returns, a builder accepts', () => {
  // Round 1 of review: every parsed field must be one the builders take back,
  // or a hostile peer's token turns into a RangeError at the next build.
  const HASH = STRING_HASH;
  const ep = (
    fields: Partial<
      Record<
        'domain' | 'zid' | 'nid' | 'id' | 'kind' | 'enclave' | 'ns' | 'node' | 'name' | 'type',
        string
      >
    >,
  ): string => {
    const f = {
      domain: '0',
      zid: 'aa',
      nid: '0',
      id: '1',
      kind: 'MP',
      enclave: '%',
      ns: '%',
      node: 'n',
      name: '%t',
      type: 'std_msgs::msg::dds_::String_',
      ...fields,
    };
    return `@ros2_lv/${f.domain}/${f.zid}/${f.nid}/${f.id}/${f.kind}/${f.enclave}/${f.ns}/${f.node}/${f.name}/${f.type}/${HASH}/::,:,:,:,,`;
  };

  it('the base row parses', () => {
    expect(parseLivelinessToken(ep({}))).not.toBeNull();
  });

  it.each([
    ['a name with an empty chunk', { name: '%%x' }],
    ['a name ending in a slash', { name: '%t%' }],
    ['a name with a wildcard', { name: '%a$*' }],
    ['a name with a space', { name: '%a b' }],
    ['a relative name', { name: 't' }],
    ['a node name holding a slash', { node: 'a%b' }],
    ['a node name with a wildcard', { node: '**' }],
    ['a relative namespace', { ns: 'robot1' }],
    ['a namespace with an empty chunk', { ns: '%%r' }],
    ['an enclave with a wildcard', { enclave: '%*' }],
    ['a zid not lowercase hex', { zid: 'AA' }],
    ['a node id not decimal', { nid: 'x' }],
    ['an entity id not decimal', { id: 'x' }],
    ['a domain with a leading zero', { domain: '007' }],
  ])('refuses %s', (_label, fields) => {
    expect(parseLivelinessToken(ep(fields))).toBeNull();
  });

  it('refuses a node token whose entity id is not its node id', () => {
    expect(parseLivelinessToken('@ros2_lv/0/aa/0/0/NN/%/%/talker')).not.toBeNull();
    expect(parseLivelinessToken('@ros2_lv/0/aa/0/5/NN/%/%/talker')).toBeNull();
    expect(parseLivelinessToken('@ros2_lv/007/aa/0/0/NN/%/%/talker')).toBeNull();
  });

  it.each([
    ['a space', `0/a b/std_msgs::msg::dds_::String_/${HASH}`],
    ['a wildcard', `0/a/$*/std_msgs::msg::dds_::String_/${HASH}`],
    ['a percent', `0/a%b/std_msgs::msg::dds_::String_/${HASH}`],
    ['a leading-zero domain', `00/a/std_msgs::msg::dds_::String_/${HASH}`],
  ])('parseDataKey refuses a name or domain with %s', (_label, key) => {
    expect(parseDataKey(key)).toBeNull();
  });

  it.each(['pkg/msg/Name_', 'pkg/_', 'pkg/msg/_'])(
    'ddsTypeName refuses %j, which no builder takes',
    (ros) => {
      expect(ddsTypeName(ros, 'msg')).toBeNull();
    },
  );
});
