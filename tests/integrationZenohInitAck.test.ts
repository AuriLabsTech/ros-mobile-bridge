// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * The integration fixture's Zenoh readiness check reads the router's first
 * reply to an InitSyn. Its verdict is the setup failure a maintainer sees, so
 * every wrong reply has to say what actually arrived.
 */

import { describe, it, expect } from 'vitest';
import { readInitAck } from './integration/helpers/readiness';

describe('readInitAck', () => {
  it('accepts an InitAck in the expected version', () => {
    expect(readInitAck(new Uint8Array([0x21, 0x09, 0x00]), 0x09)).toEqual({
      ok: true,
      detail: 'ready',
    });
  });

  it('names both versions on a mismatch', () => {
    expect(readInitAck(new Uint8Array([0x21, 0x09]), 0x08)).toEqual({
      ok: false,
      detail: 'InitAck carries protocol version 0x9, expected 0x8',
    });
  });

  it('calls a reply with no version byte truncated, not a version mismatch', () => {
    expect(readInitAck(new Uint8Array([0x21]), 0x09)).toEqual({
      ok: false,
      detail: 'truncated InitAck (1 byte)',
    });
  });

  it('rejects a reply that is not an InitAck, and an empty one', () => {
    expect(readInitAck(new Uint8Array([0x03, 0x00]), 0x09)).toEqual({
      ok: false,
      detail: 'first reply is not an InitAck (header 0x3)',
    });
    expect(readInitAck(new Uint8Array([0x01, 0x09]), 0x09).ok).toBe(false);
    expect(readInitAck(new Uint8Array([]), 0x09)).toEqual({
      ok: false,
      detail: 'empty reply',
    });
  });
});
