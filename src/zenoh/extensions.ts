// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * The extension TLV that follows a Zenoh message header when its Z flag is
 * set. Header byte, from `zenoh-protocol/src/common/extension.rs`:
 *
 * ```text
 *  7 6 5 4 3 2 1 0
 * +-+-+-+-+-+-+-+-+
 * |Z|ENC|M|   ID  |
 * +-+-+-+-+-+-+-+-+
 * ```
 *
 * Z: another extension follows. ENC: 0 unit, 1 Z64, 2 ZBuf, 3 reserved.
 * M: mandatory, so a receiver that does not know the id must fail.
 *
 * @module
 */

import { ZenohProtocolError, type ByteReader, type ByteWriter } from './codec';

const FLAG_Z = 0x80;
const FLAG_M = 0x10;
const ID_MASK = 0x0f;
const ENC_SHIFT = 5;
const ENC_UNIT = 0;
const ENC_Z64 = 1;
const ENC_ZBUF = 2;

/** One decoded extension. */
export type Extension =
  | { id: number; mandatory: boolean; enc: 'unit' }
  | { id: number; mandatory: boolean; enc: 'z64'; value: bigint }
  | { id: number; mandatory: boolean; enc: 'zbuf'; value: Uint8Array };

/**
 * Read the extension chain at the reader's position.
 *
 * Extensions whose id is in `known` are returned in wire order, with ZBuf
 * values as views into the source. Unknown optional ones are skipped by
 * their length. An unknown mandatory one is a protocol error, as upstream's
 * `extension::read` treats it.
 *
 * @param known The extension ids this message defines.
 */
export function readExtensions(r: ByteReader, known: readonly number[]): Extension[] {
  const out: Extension[] = [];
  let more = true;
  while (more) {
    const h = r.u8();
    more = (h & FLAG_Z) !== 0;
    const id = h & ID_MASK;
    const mandatory = (h & FLAG_M) !== 0;
    const enc = (h >> ENC_SHIFT) & 0x3;
    const isKnown = known.includes(id);
    if (!isKnown && mandatory) {
      throw new ZenohProtocolError(`unknown mandatory extension 0x${id.toString(16)}`);
    }
    if (enc === ENC_UNIT) {
      if (isKnown) out.push({ id, mandatory, enc: 'unit' });
    } else if (enc === ENC_Z64) {
      const value = r.vle64();
      if (isKnown) out.push({ id, mandatory, enc: 'z64', value });
    } else if (enc === ENC_ZBUF) {
      const value = r.bytes();
      if (isKnown) out.push({ id, mandatory, enc: 'zbuf', value });
    } else {
      throw new ZenohProtocolError('extension with the reserved encoding');
    }
  }
  return out;
}

/** Write `exts` as a chain, setting Z on every one but the last. */
export function writeExtensions(w: ByteWriter, exts: readonly Extension[]): void {
  exts.forEach((ext, i) => {
    const more = i < exts.length - 1 ? FLAG_Z : 0;
    const base = more | (ext.mandatory ? FLAG_M : 0) | (ext.id & ID_MASK);
    if (ext.enc === 'unit') {
      w.u8(base | (ENC_UNIT << ENC_SHIFT));
    } else if (ext.enc === 'z64') {
      w.u8(base | (ENC_Z64 << ENC_SHIFT)).vle64(ext.value);
    } else {
      w.u8(base | (ENC_ZBUF << ENC_SHIFT)).bytes(ext.value);
    }
  });
}
