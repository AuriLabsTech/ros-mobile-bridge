// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * Add `cb` to `listeners` and call it once with `initial`: the registration
 * shape of `onStatusChange` and `onServicesChange` on every client.
 *
 * `cb` is added before the call, so a change the call itself causes reaches
 * it. When the call throws, the error goes on to the caller, who never
 * receives the unsubscribe, so the registration this call made is undone
 * first. An earlier registration of the same function is left in place.
 */
export function registerWithInitialCall<T>(
  listeners: Set<(value: T) => void>,
  cb: (value: T) => void,
  initial: T,
): () => void {
  const added = !listeners.has(cb);
  listeners.add(cb);
  try {
    cb(initial);
  } catch (err) {
    if (added) listeners.delete(cb);
    throw err;
  }
  return () => {
    listeners.delete(cb);
  };
}
