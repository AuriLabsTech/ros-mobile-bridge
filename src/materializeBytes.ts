// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * Return an owned copy of `view`'s bytes.
 *
 * `RosMessage.data`, when it is a `Uint8Array`, is a zero-copy view into the
 * inbound WebSocket frame's `ArrayBuffer` (see the `RosMessage` TSDoc). That
 * view is only valid synchronously, inside the subscriber callback, and its
 * `byteOffset` is significant. Handing it to anything that retains the bytes
 * past the callback, or to a native binding that ignores `byteOffset` (some
 * Skia paths, `node-canvas`, `sharp`, FFI, ffmpeg bindings), risks corrupt or
 * aliased data.
 *
 * `materializeBytes` returns a fresh `Uint8Array` backed by its own
 * `ArrayBuffer` with `byteOffset === 0`, safe to retain and to hand to any
 * such consumer. It **always copies**: the result never aliases the input,
 * even when the input already spans its whole buffer. That keeps the contract
 * a single sentence — "the result is always an owned, offset-0 copy" — at the
 * cost of one allocation, so do not call it on a hot path where you already
 * hold an owned buffer.
 *
 * @example
 * ```ts
 * client.subscribe('/camera/raw', (msg) => {
 *   if (msg.data instanceof Uint8Array) {
 *     const owned = materializeBytes(msg.data);
 *     skia.MakeImageFromEncoded(owned); // safe: offset-0, owned
 *   }
 * });
 * ```
 */
export function materializeBytes(view: Uint8Array): Uint8Array {
  return new Uint8Array(view);
}
