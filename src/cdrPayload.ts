/**
 * The one place this library turns ROS 2 CDR payloads into messages and back.
 *
 * Every binary transport decodes and encodes through here: Foxglove's `cdr`
 * channels and service calls today, Zenoh's samples and queries next. The
 * rules that real bridges and middlewares taught the library live with the
 * codec rather than in a client, so a second transport gets them by calling
 * it: which encapsulation headers are read, the fieldless type and its
 * padding, and the promise that a hostile or truncated payload comes back as
 * a typed result instead of an exception thrown into a receive loop.
 *
 * Internal. Nothing here is exported from the package.
 *
 * The codec is called only for a message the throttle already admitted
 * (drop before parse, ADR 0030 decision 8): it has no notion of dropping.
 */
import type { MessageDefinition } from '@foxglove/message-definition';
import { parse as parseRosMsgDef } from '@foxglove/rosmsg';
import { MessageReader, MessageWriter } from '@foxglove/rosmsg2-serialization';

/** Why a payload could not be decoded. */
export type CdrUndecodableReason =
  /** The encapsulation header names a representation this codec does not read. */
  | 'unsupported-encapsulation'
  /** The bytes do not hold a message of the definition: truncated, a length past the end. */
  | 'malformed'
  /** A fieldless codec met bytes that CDR's final padding cannot account for. */
  | 'unaccounted-bytes';

/** The outcome of {@link CdrPayloadCodec.decode}. Never thrown, always returned. */
export type CdrDecodeResult =
  | { readonly ok: true; readonly message: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly reason: CdrUndecodableReason;
      /** A sentence for a log line or an error message, naming what was wrong. */
      readonly detail: string;
    };

/** A compiled reader and writer for one message definition. */
export interface CdrPayloadCodec {
  /** The definitions this codec was compiled from. */
  readonly definitions: MessageDefinition[];
  /** Decode a payload, header included. Never throws. */
  decode(payload: Uint8Array): CdrDecodeResult;
  /**
   * Encode a message as little-endian XCDR1, header included, as a
   * `Uint8Array` (never a bare `ArrayBuffer`: React Native drops those above
   * about 400 bytes in `WebSocket.send`). Throws when the message does not fit
   * the definition, as the writer underneath does; the caller owns that
   * error, because the message came from the application.
   */
  encode(message: unknown): Uint8Array;
}

/**
 * Encapsulation ids this codec reads: plain CDR (XCDR1), in both byte orders.
 *
 * `@foxglove/cdr` reads only the second header byte and accepts any value
 * there. For the parameter-list and delimited kinds it then reads the
 * DHEADER or EMHEADER as though it were the first field, and an id it has
 * never heard of it reads as big-endian XCDR2: both produce wrong values
 * without an error. So the codec lets through only what is known to decode
 * correctly, and refuses the rest by name.
 *
 * Plain XCDR2 is refused too, although the reader has rules for it. Every
 * ROS 2 middleware and the micro-ROS agent write `00 01` in code, Humble
 * through Rolling, rmw_zenoh included, and no QoS setting or XML profile
 * switches a ROS 2 publisher to XCDR2. A path no real producer has exercised
 * is not trusted to give right values. Accepting it once a producer is
 * captured is not a breaking change; dropping it after a release would be.
 */
const READABLE_ENCAPSULATIONS: ReadonlySet<number> = new Set([
  0x00, // CDR_BE
  0x01, // CDR_LE
]);

const HEADER_BYTES = 4;

function hex(byte: number): string {
  return byte.toString(16).padStart(2, '0');
}

/** The refusal for a header, or `null` when the reader handles it. */
function checkHeader(payload: Uint8Array): CdrDecodeResult | null {
  if (payload.byteLength < HEADER_BYTES) {
    return {
      ok: false,
      reason: 'malformed',
      detail: `a CDR payload needs a 4-byte header, this one is ${payload.byteLength} bytes`,
    };
  }
  const [high, low] = [payload[0] ?? 0, payload[1] ?? 0];
  if (high !== 0 || !READABLE_ENCAPSULATIONS.has(low)) {
    return {
      ok: false,
      reason: 'unsupported-encapsulation',
      detail:
        `encapsulation header ${hex(high)} ${hex(low)} is not plain CDR (00 00 or 00 01), ` +
        `the only representation this library reads`,
    };
  }
  return null;
}

/**
 * True when the last read left bytes that CDR's final padding cannot account
 * for: more than it takes to reach the next 4- or 8-byte boundary.
 *
 * Only the count is judged, never the values. The reader's own
 * `lastReadHadTrailingBytes()` also requires the padding to be zero, but CDR
 * gives padding no value and nothing upstream writes it: `foxglove_bridge`
 * 3.5.0 measured answering `std_srvs/srv/Empty` with `00 01 00 00 00 ff 00 00`,
 * the placeholder byte followed by three bytes nobody initialised. ROS 2's
 * own deserializers never look past the last field, so a client that does
 * would reject an ordinary empty answer as carrying data.
 */
function hasDataBeyondFinalPadding(consumed: number, payload: Uint8Array): boolean {
  const trailing = payload.byteLength - consumed;
  if (trailing <= 0) return false;
  return trailing !== (4 - (consumed % 4)) % 4 && trailing !== (8 - (consumed % 8)) % 8;
}

function compile(definitions: MessageDefinition[], fieldless: boolean): CdrPayloadCodec {
  // Both compiled on first use: a service's request side only encodes, its
  // response side only decodes.
  let reader: MessageReader | null = null;
  let writer: MessageWriter | null = null;
  return {
    definitions,
    decode(payload) {
      const refused = checkHeader(payload);
      if (refused) return refused;
      let message: Record<string, unknown>;
      try {
        // Built inside the try: the reader refuses some definitions outright,
        // one with only constants for instance, and that refusal is as
        // undecodable as a bad payload.
        reader ??= new MessageReader(definitions);
        message = reader.readMessage(payload) as Record<string, unknown>;
      } catch (err) {
        return {
          ok: false,
          reason: 'malformed',
          detail: err instanceof Error ? err.message : String(err),
        };
      }
      if (fieldless && hasDataBeyondFinalPadding(reader.lastReadByteLength(), payload)) {
        return {
          ok: false,
          reason: 'unaccounted-bytes',
          detail:
            `the type has no fields, but the payload is ${payload.byteLength} bytes, ` +
            `more than the header, the placeholder byte and padding`,
        };
      }
      return { ok: true, message };
    },
    encode(message) {
      writer ??= new MessageWriter(definitions);
      return writer.writeMessage(message);
    },
  };
}

/** A codec for a message definition, such as one parsed from schema text. */
export function cdrPayloadCodec(definitions: MessageDefinition[]): CdrPayloadCodec {
  return compile(definitions, false);
}

/**
 * The message definition of a type with no fields.
 *
 * Produced by the parser rather than written as a literal, so it is exactly
 * what the parser gives an empty or whitespace-only schema: the two spellings
 * of "no fields" a server can send. FoxgloveClient routes both here without
 * parsing either, and a codec built from either spelling would read the same.
 */
export const FIELDLESS_DEFINITIONS: MessageDefinition[] = parseRosMsgDef('', { ros2: true });

/**
 * The codec for a type described as having no fields, `std_msgs/msg/Empty`
 * being the ordinary case.
 *
 * A fieldless message is not one fixed size on the wire: RTPS pads a
 * submessage to a 32-bit boundary, and that padding is indistinguishable
 * from payload at the receiver, so the same message arrives as 5 bytes or 8
 * depending on the middleware. This codec therefore never checks the length
 * exactly. What it does check is that nothing is left beyond the padding:
 * such bytes mean the description was wrong and the message carried data,
 * reported as `unaccounted-bytes` rather than decoded as an empty object.
 * A codec built from a real definition does not make that check, because
 * leftover bytes there mean the schema is older than the payload, a
 * different claim.
 */
export function fieldlessCdrPayloadCodec(): CdrPayloadCodec {
  return compile(FIELDLESS_DEFINITIONS, true);
}
