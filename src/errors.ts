// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

import type { ProtocolType } from './types';

/** The protocol a mismatch resolved to, or `'unknown'` when only the negative is known. */
export type DetectedProtocol = ProtocolType | 'unknown';

function protocolLabel(protocol: DetectedProtocol): string {
  switch (protocol) {
    case 'foxglove-ws':
      return 'Foxglove WebSocket';
    case 'rosbridge':
      return 'rosbridge';
    case 'zenoh':
      return 'Zenoh';
    default:
      return 'a different protocol';
  }
}

function defaultMessage(expected: ProtocolType, detected: DetectedProtocol): string {
  if (detected === 'unknown') {
    return (
      `The server did not complete the ${protocolLabel(expected)} handshake. ` +
      `It may speak a different protocol. Check the selected protocol and port.`
    );
  }
  return (
    `This looks like a ${protocolLabel(detected)} server, but the client is ` +
    `configured for ${protocolLabel(expected)}. Switch the protocol to ` +
    `${protocolLabel(detected)}.`
  );
}

/**
 * Raised when a client is pointed at a server that speaks a different protocol
 * than the client is configured for (for example, the rosbridge client aimed at
 * a Foxglove WebSocket server, or vice versa).
 *
 * How it reaches the consumer depends on when the mismatch is detected:
 *
 * - **At connect time** (the Foxglove client never receives the `serverInfo`
 *   handshake): the `connect()` promise rejects with this error.
 * - **After connect resolves** (the rosbridge client opens with no handshake to
 *   validate, then receives a Foxglove-only frame): the status transitions to
 *   `'error'` and this error is exposed via `IProtocolClient.getLastError()`.
 *
 * Either way it is also retrievable through `getLastError()`, so a consumer can
 * branch on `instanceof ProtocolMismatchError` in one place. The two carrier
 * fields let a consumer build its own copy; `message` is a clear, ready-to-show
 * default.
 *
 * @example
 * ```ts
 * client.onStatusChange((status) => {
 *   if (status !== 'error') return;
 *   const err = client.getLastError();
 *   if (err instanceof ProtocolMismatchError) {
 *     showModal(`Wrong protocol: detected ${err.detectedProtocol}, expected ${err.expectedProtocol}.`);
 *   }
 * });
 * ```
 */
export class ProtocolMismatchError extends Error {
  /** The protocol the client is configured for (its own transport). */
  readonly expectedProtocol: ProtocolType;

  /**
   * The protocol the server appears to speak, or `'unknown'` when the client
   * can only tell the server is *not* speaking `expectedProtocol` (e.g. the
   * Foxglove handshake timed out with no positive signal of the real protocol).
   */
  readonly detectedProtocol: DetectedProtocol;

  constructor(expectedProtocol: ProtocolType, detectedProtocol: DetectedProtocol, message?: string) {
    super(message ?? defaultMessage(expectedProtocol, detectedProtocol));
    this.name = 'ProtocolMismatchError';
    this.expectedProtocol = expectedProtocol;
    this.detectedProtocol = detectedProtocol;
    // Keep `instanceof` working when the class is transpiled to an older target.
    Object.setPrototypeOf(this, ProtocolMismatchError.prototype);
  }
}
