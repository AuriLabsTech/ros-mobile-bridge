// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * `n` random bytes from `Math.random`. Deliberate: the `crypto` global is
 * outside the library's platform floor (absent on the React Native
 * baseline). Callers use the bytes as correlation keys (a goal UUID, a Zenoh
 * session id), never as secrets; collisions across the handful a session
 * makes are negligible.
 *
 * @internal
 */
export function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}
