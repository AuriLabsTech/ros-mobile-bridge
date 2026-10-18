// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * Base64 decoding with only the library's allowed globals. Internal; not
 * exported from the package.
 */

// Base64 alphabet → 6-bit value. Built once; every other byte (padding `=`,
// whitespace, junk) stays -1 and is skipped during decode.
const B64_LOOKUP: Int16Array = (() => {
  const table = new Int16Array(256).fill(-1);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < chars.length; i++) table[chars.charCodeAt(i)] = i;
  return table;
})();

/**
 * Decode a base64 string to a byte array. `atob` is deliberately not used:
 * it is outside the allowed global set (WebSocket, TextEncoder/Decoder, typed
 * arrays) and is absent on older React Native (Hermes) runtimes; `Buffer` is
 * Node-only and the `FileReader`/`Blob` round-trip is RN-finicky.
 */
export function base64ToUint8(b64: string): Uint8Array {
  let len = b64.length;
  while (len > 0 && b64.charCodeAt(len - 1) === 61 /* '=' */) len--;
  const out = new Uint8Array((len * 3) >> 2);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < len; i++) {
    const v = B64_LOOKUP[b64.charCodeAt(i)] ?? -1;
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 0xff;
    }
  }
  return o === out.length ? out : out.subarray(0, o);
}
