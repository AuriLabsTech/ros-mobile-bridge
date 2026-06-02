import { describe, it, expect } from 'vitest';
import { matchesSchema, stripInterfaceKind } from '../src/schemaName';

describe('stripInterfaceKind', () => {
  it('drops a recognized interface-kind segment', () => {
    expect(stripInterfaceKind('geometry_msgs/msg/Twist')).toBe('geometry_msgs/Twist');
    expect(stripInterfaceKind('std_srvs/srv/Trigger')).toBe('std_srvs/Trigger');
    expect(stripInterfaceKind('nav2_msgs/action/NavigateToPose')).toBe(
      'nav2_msgs/NavigateToPose',
    );
  });

  it('passes through 2-part names unchanged', () => {
    expect(stripInterfaceKind('geometry_msgs/Twist')).toBe('geometry_msgs/Twist');
  });

  it('passes through when the middle segment is not a recognized kind', () => {
    expect(stripInterfaceKind('foo/bar/Baz')).toBe('foo/bar/Baz');
  });

  it('passes through names without a kind segment', () => {
    expect(stripInterfaceKind('JustAType')).toBe('JustAType');
    expect(stripInterfaceKind('')).toBe('');
  });
});

describe('matchesSchema', () => {
  it('matches across the 2-part / 3-part asymmetry for all interface kinds', () => {
    expect(matchesSchema('sensor_msgs/msg/Image', 'sensor_msgs/Image')).toBe(true);
    expect(matchesSchema('std_srvs/srv/Trigger', 'std_srvs/Trigger')).toBe(true);
    expect(
      matchesSchema('nav2_msgs/action/NavigateToPose', 'nav2_msgs/NavigateToPose'),
    ).toBe(true);
  });

  it('matches two identical 3-part names', () => {
    expect(matchesSchema('std_msgs/msg/String', 'std_msgs/msg/String')).toBe(true);
  });

  it('does not match different types in the same package', () => {
    expect(matchesSchema('std_msgs/msg/String', 'std_msgs/msg/Header')).toBe(false);
  });

  it('does not match different packages', () => {
    expect(matchesSchema('a_msgs/msg/Foo', 'b_msgs/msg/Foo')).toBe(false);
  });

  it('collapses kinds: msg and srv of the same bare name compare equal (documented caveat)', () => {
    expect(matchesSchema('pkg/msg/Foo', 'pkg/srv/Foo')).toBe(true);
  });

  it('is exact on the surviving segments — no case or whitespace folding', () => {
    expect(matchesSchema('std_msgs/msg/String', 'std_msgs/msg/string')).toBe(false);
    expect(matchesSchema('std_msgs/msg/String ', 'std_msgs/msg/String')).toBe(false);
  });
});
