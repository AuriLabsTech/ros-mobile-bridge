// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

import { connectAbortReason } from './errors';

/**
 * Run a `connect()` that was made while a `disconnect()` is still closing,
 * once that close is done.
 *
 * Both clients can spend a moment in `disconnect()` with the status still
 * `'connected'`: Foxglove while a first-publish hold runs out, rosbridge while
 * the teardown settles. A `connect()` made in that window must neither read
 * `'connected'` as done nor be lost when the close lands, so it waits here.
 *
 * Two promises the plain `closing.then(connect)` would break:
 * - A later `disconnect()` cancels it, as a `disconnect()` cancels any
 *   connect attempt in flight (ADR 0003). `stillWanted` reports whether one
 *   has happened since this call; if so the attempt rejects as aborted and no
 *   socket opens.
 * - A cancellation is pre-handled (ADR 0003). The promise returned here is not
 *   the inner attempt's, so it is pre-handled on its own when the caller's
 *   signal fires or a later `disconnect()` cancels it. A genuine failure stays
 *   unhandled, so it remains visible to a caller that did not await.
 */
export function connectAfterDisconnect(
  closing: Promise<void>,
  stillWanted: () => boolean,
  signal: AbortSignal | undefined,
  connect: () => Promise<void>,
): Promise<void> {
  const preHandle = (): void => {
    parked.catch(() => {});
  };
  const release = (): void => {
    signal?.removeEventListener('abort', preHandle);
  };
  const parked: Promise<void> = closing.then(() => {
    if (!stillWanted()) {
      release();
      preHandle();
      throw connectAbortReason(undefined, 'Connection attempt cancelled by disconnect()');
    }
    return connect().finally(release);
  });
  if (signal?.aborted) preHandle();
  else signal?.addEventListener('abort', preHandle);
  return parked;
}
