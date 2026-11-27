// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * Zenoh key-expression matching, for a session that routes each received
 * sample to its own subscriptions (a sample names its key, not the
 * subscription it is for).
 *
 * Supported: `*` stands for exactly one chunk, `**` for zero or more. A chunk
 * that starts with `@` is verbatim: only the same chunk matches it, never a
 * wildcard, so `**` never reaches into `@ros2_lv` or `@adv`. Not supported:
 * `$*` inside a chunk, which nothing this library declares uses; an
 * expression holding one matches only the same literal chunk.
 *
 * Internal; not re-exported from `index.ts`.
 *
 * @module
 */

/**
 * Whether the key expression `expr` matches the concrete key `key`.
 *
 * Runs in O(chunks of `expr` × chunks of `key`) whatever the wildcards, so a
 * long key from a peer costs no more than its length.
 */
export function keyExprMatches(expr: string, key: string): boolean {
  const e = expr.split('/');
  const k = key.split('/');
  // reach[j]: the first i chunks of `e` match the first j chunks of `k`.
  let reach: boolean[] = k.map(() => false).concat(false);
  reach[0] = true;
  for (const chunk of e)
    reach = chunk === '**' ? stepDoubleStar(reach, k) : stepChunk(reach, k, chunk);
  return reach[k.length] === true;
}

/** `**`: zero chunks, or a match carried forward over one more non-verbatim chunk. */
function stepDoubleStar(reach: boolean[], k: string[]): boolean[] {
  const next: boolean[] = [];
  for (let j = 0; j <= k.length; j++) {
    next[j] = reach[j] === true || (j > 0 && next[j - 1] === true && !isVerbatim(k[j - 1] ?? ''));
  }
  return next;
}

/** A literal chunk or `*`: exactly one key chunk. */
function stepChunk(reach: boolean[], k: string[], chunk: string): boolean[] {
  const next: boolean[] = [false];
  for (let j = 1; j <= k.length; j++) {
    const kc = k[j - 1] ?? '';
    next[j] = reach[j - 1] === true && (chunk === kc || (chunk === '*' && !isVerbatim(kc)));
  }
  return next;
}

function isVerbatim(chunk: string): boolean {
  return chunk.startsWith('@');
}
