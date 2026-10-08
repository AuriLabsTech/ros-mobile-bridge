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
 * Internal: build the rejection reason for a cancelled connection attempt
 * (ADR 0003). Passes through `signal.reason` when the runtime provides one
 * (fetch-style, including a custom `abort(reason)` value); otherwise
 * constructs an `Error` whose `name` is `'AbortError'`. Never constructs a
 * `DOMException` — not all React Native runtimes can. The public contract is
 * the name, not the type: consumers branch on `err.name === 'AbortError'`.
 *
 * Not exported from the package entry point.
 */
export function connectAbortReason(
  signal?: AbortSignal,
  message = 'Connection attempt aborted',
): unknown {
  if (signal !== undefined && signal.reason !== undefined) {
    return signal.reason;
  }
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

/**
 * Internal: validate a caller-supplied `CallServiceOptions.timeoutMs`. The
 * contract (pinned in the changelog) is a synchronous throw for zero or
 * below: on rosbridge a non-positive wire `timeout` means an unbounded
 * server-side wait whose worker survives the client's disconnect — a
 * remotely triggerable leak — so the value must never reach the wire.
 * Non-finite values (NaN, Infinity) are rejected for the same reason: they
 * do not survive JSON serialization as numbers.
 *
 * Not exported from the package entry point.
 */
export function validateCallServiceTimeoutMs(timeoutMs: number | undefined): void {
  if (timeoutMs === undefined) return;
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) return;
  throw new Error(
    `callService options.timeoutMs must be a finite number of milliseconds ` +
      `greater than zero; got ${timeoutMs}. On rosbridge a non-positive wire ` +
      `timeout means an unbounded server-side wait that survives disconnect, ` +
      `so it is never forwarded.`,
  );
}

/**
 * Why a dispatched action goal's `outcome` promise rejected — the cases where
 * there is no goal lifecycle to report:
 *
 * - `'rejected'`: the action server declined the goal. Rejection happens
 *   before execution starts; it is not a `GoalStatus` value and not a
 *   terminal outcome.
 * - `'unavailable'`: no action server exists for the action (or, on Foxglove
 *   WebSocket, the bridge does not expose the action's hidden services —
 *   launch it with `include_hidden:=true`).
 * - `'disconnected'`: the connection closed before the goal reached a
 *   terminal state. The outcome is permanently unobservable, but the robot
 *   may still be executing the goal — reassess robot state on reconnect
 *   rather than treating this as goal failure.
 * - `'server-error'`: the server, or the bridge relaying for it, reported an
 *   error the client cannot classify further; the verbatim text is in
 *   `ActionGoalError.detail`. The two speakers are not equal on the question
 *   of whether the goal exists: on Foxglove WebSocket a bridge-level failure
 *   reaches this reason only while the action server has said nothing about
 *   the goal, since once the status topic names it the server's account wins
 *   and the goal keeps running.
 *
 * This union may gain members in future releases as transports surface new
 * failure modes; branch with a default case.
 */
export type ActionGoalErrorReason =
  | 'rejected'
  | 'unavailable'
  | 'disconnected'
  | 'server-error';

function actionGoalMessage(reason: ActionGoalErrorReason, action: string): string {
  switch (reason) {
    case 'rejected':
      return `The action server declined the goal on "${action}".`;
    case 'unavailable':
      return `No action server is available for "${action}".`;
    case 'disconnected':
      return (
        `The connection closed before the goal on "${action}" reached a ` +
        `terminal state. The robot may still be executing it.`
      );
    default:
      return `The server reported an error for the goal on "${action}".`;
  }
}

/**
 * Rejection carried by `ActionGoalHandle.outcome` when a dispatched goal has
 * no lifecycle to report. A goal that *ran* and ended — succeeded, canceled,
 * or aborted — never produces this error; those are resolutions carrying the
 * terminal status.
 *
 * `reason` is the machine-readable branch point (see
 * {@link ActionGoalErrorReason}; branch with a default case, the union can
 * grow). `detail` preserves the server's verbatim message when one exists, or
 * a library-written description when the failure produced no server text
 * (`'disconnected'`). `message` is a clear, ready-to-show default.
 *
 * @example
 * ```ts
 * try {
 *   const { status, result } = await handle.outcome;
 * } catch (err) {
 *   if (err instanceof ActionGoalError && err.reason === 'disconnected') {
 *     // The robot may still be executing; reassess on reconnect.
 *   }
 * }
 * ```
 */
export class ActionGoalError extends Error {
  /** Why there is no lifecycle to report. Branch with a default case. */
  readonly reason: ActionGoalErrorReason;

  /** The action the goal was dispatched to (e.g. `'/dock'`). */
  readonly action: string;

  /**
   * The server's verbatim message when one exists (e.g.
   * `"Action goal was rejected"`), or a library-written description when the
   * failure produced no server text.
   */
  readonly detail: string;

  constructor(reason: ActionGoalErrorReason, action: string, detail: string) {
    super(actionGoalMessage(reason, action));
    this.name = 'ActionGoalError';
    this.reason = reason;
    this.action = action;
    this.detail = detail;
    // Keep `instanceof` working when the class is transpiled to an older target.
    Object.setPrototypeOf(this, ActionGoalError.prototype);
  }
}

/**
 * Why a service response could not be read:
 *
 * - `'unsupported-encoding'`: the server answered in an encoding this client
 *   does not decode (for example `protobuf`, from a Foxglove SDK server).
 * - `'no-schema'`: neither the server nor the schemas bundled with this
 *   library describe the response type.
 * - `'schema-mismatch'`: the server described the response type as having no
 *   fields, but the response carries data, so the description was wrong.
 * - `'malformed'`: the payload could not be parsed in its declared encoding,
 *   or against the schema found for it, or parsed to something that is not a
 *   response record (a JSON `null`, number, string or array).
 *   A zero-length payload lands here: even a response with no fields
 *   serializes to a few bytes, so an empty one was lost or broken on the way.
 *
 * This union may gain members in future releases; branch with a default case.
 */
export type ServiceResponseDecodeErrorReason =
  | 'unsupported-encoding'
  | 'no-schema'
  | 'schema-mismatch'
  | 'malformed';

/**
 * Rejection carried by `callService()` when the server answered but this
 * client cannot read the answer. The call reached the server and a response
 * came back; it is not a transport failure or a timeout, and it says nothing
 * about whether the service succeeded.
 *
 * `bytes` is the response payload exactly as received, copied into its own
 * buffer, so a consumer that holds the type's definition can still decode it.
 * `encoding` is the encoding the server declared for it. `reason` is the
 * machine-readable branch point
 * (see {@link ServiceResponseDecodeErrorReason}; branch with a default case,
 * the union can grow). `message` is a clear, ready-to-show default.
 *
 * `name` is `'ServiceResponseDecodeError'`, so code can match on it where
 * `instanceof` fails because two copies of this package were bundled.
 *
 * @example
 * ```ts
 * try {
 *   const resp = await client.callService('/dock', {});
 * } catch (err) {
 *   if (err instanceof ServiceResponseDecodeError) {
 *     // The robot answered in a form this app cannot read: err.bytes holds it.
 *   }
 * }
 * ```
 */
export class ServiceResponseDecodeError extends Error {
  /** Why the response could not be read. Branch with a default case. */
  readonly reason: ServiceResponseDecodeErrorReason;

  /** The service that was called (e.g. `'/dock'`). */
  readonly service: string;

  /** The encoding the server declared for the response (e.g. `'cdr'`). */
  readonly encoding: string;

  /** The response payload, unchanged. */
  readonly bytes: Uint8Array;

  constructor(
    reason: ServiceResponseDecodeErrorReason,
    service: string,
    encoding: string,
    bytes: Uint8Array,
    detail?: string,
  ) {
    super(
      `The server answered the call to "${service}", but its response could not be read ` +
        `(${reason}, encoding "${encoding}", ${bytes.byteLength} bytes)` +
        (detail ? `: ${detail}` : '.'),
    );
    this.name = 'ServiceResponseDecodeError';
    this.reason = reason;
    this.service = service;
    this.encoding = encoding;
    // A copy: the payload arrives as a view into the whole frame, and a
    // consumer handing `bytes.buffer` to a decoder must get the payload alone.
    this.bytes = bytes.slice();
    // Keep `instanceof` working when the class is transpiled to an older target.
    Object.setPrototypeOf(this, ServiceResponseDecodeError.prototype);
  }
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

/**
 * Internal: validate a caller-supplied background-timer interval
 * (`ProtocolClientOptions.discoveryRefreshMs`, `latencyProbeMs`).
 *
 * The contract, following the `callService` `timeoutMs` precedent above: a
 * dangerous value is refused loudly at construction rather than clamped
 * silently. `undefined` takes the default and `0` disables the timer, both
 * of which are ordinary. Anything above `0` but below one second is refused,
 * because every one of these timers issues a service call to the robot and a
 * sub-second interval turns a background refresh into a load generator on a
 * device the consumer does not own. Non-finite and negative values are
 * refused for the same reason they are on `timeoutMs`: they cannot express
 * an interval.
 *
 * Not exported from the package entry point.
 */
export function validateBackgroundIntervalMs(
  optionName: string,
  intervalMs: number | undefined,
): void {
  if (intervalMs === undefined) return;
  if (intervalMs === 0) return;
  if (Number.isFinite(intervalMs) && intervalMs >= 1000) return;
  throw new Error(
    `ProtocolClientOptions.${optionName} must be 0 (disabled) or a finite ` +
      `number of milliseconds of at least 1000; got ${intervalMs}. These ` +
      `timers issue service calls to the robot, so a sub-second interval is ` +
      `refused rather than clamped.`,
  );
}
