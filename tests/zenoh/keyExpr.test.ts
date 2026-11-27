import { describe, expect, it } from 'vitest';
import { keyExprMatches } from '../../src/zenoh/keyExpr';

describe('keyExprMatches', () => {
  it.each([
    ['0/chatter/T/H', '0/chatter/T/H'],
    ['0/chatter/*/*', '0/chatter/T/H'],
    ['0/**', '0/chatter/T/H'],
    ['0/chatter/**', '0/chatter'],
    ['0/chatter/**', '0/chatter/T/H/_buf_cpu'],
    ['**', 'a'],
    ['a/**/z', 'a/z'],
    ['a/**/z', 'a/b/c/z'],
    ['a/**/b/**/c', 'a/x/b/y/b/z/c'],
    ['@ros2_lv/0/**', '@ros2_lv/0/zid/0/0/NN/%/%/talker'],
  ])('%s matches %s', (expr, key) => {
    expect(keyExprMatches(expr, key)).toBe(true);
  });

  it.each([
    ['0/chatter/*/*', '0/chatter/T'],
    ['0/chatter/*/*', '0/chatter/T/H/_buf_cpu'],
    ['0/chatter/*/*', '0/chatter/T/H/_buf/0123abcd'],
    ['0/chatter/*/*', '0/chatter/filtered/T/H'],
    ['0/chatter/T/H', '0/chatter/T/H2'],
    ['a/**/z', 'a/b/c'],
    ['*', 'a/b'],
    // A chunk that starts with `@` is verbatim: no wildcard stands in for it.
    ['**', '@ros2_lv/0/x'],
    ['*/0/**', '@ros2_lv/0/x'],
    ['0/chatter/**', '0/chatter/T/H/@adv/pub/zid/1/_'],
  ])('%s does not match %s', (expr, key) => {
    expect(keyExprMatches(expr, key)).toBe(false);
  });

  // A backtracking matcher would not finish on this input; the loose bound
  // only has to tell "finishes" from "does not".
  it('takes polynomial time on many `**` against a long key', () => {
    const expr = Array.from({ length: 30 }, () => '**').join('/') + '/nope';
    const key = Array.from({ length: 2000 }, () => 'a').join('/');
    const start = performance.now();
    expect(keyExprMatches(expr, key)).toBe(false);
    expect(performance.now() - start).toBeLessThan(10_000);
  });
});
