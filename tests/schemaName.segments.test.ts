// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

import { describe, it, expect } from 'vitest';
import { matchesSchema, stripInterfaceKind } from '../src/schemaName';

describe('stripInterfaceKind — only a whole three-segment name is stripped', () => {
  it('leaves a name with an extra leading segment unchanged', () => {
    expect(stripInterfaceKind('ns/geometry_msgs/msg/Twist')).toBe('ns/geometry_msgs/msg/Twist');
  });

  it('leaves a name with an extra trailing segment unchanged', () => {
    expect(stripInterfaceKind('geometry_msgs/msg/Twist/extra')).toBe(
      'geometry_msgs/msg/Twist/extra',
    );
  });

  it('does not match a four-segment name against its three-segment tail', () => {
    expect(matchesSchema('ns/geometry_msgs/msg/Twist', 'geometry_msgs/Twist')).toBe(false);
  });
});
