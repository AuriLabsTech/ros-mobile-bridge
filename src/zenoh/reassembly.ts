// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * Reassembly of fragmented network messages, one state machine per channel
 * (reliable and best effort each have their own sequence numbers).
 *
 * The rules follow upstream's receive path
 * (`zenoh-transport/src/unicast/universal/rx.rs` at 1.10.1), with rule 2
 * widened as it says:
 *
 * 1. Fragments with consecutive sequence numbers are appended; the one with
 *    M=0 ends the message, which the caller parses as exactly one network
 *    message.
 * 2. A First marker always starts a new message and discards a partial one.
 *    Routers send it even when Patch was not negotiated, so it is honoured
 *    regardless.
 * 3. A Drop marker discards the partial message; its own chunk is ignored.
 * 4. After a sequence gap the partial message is dropped and every fragment
 *    up to and including the next M=0 is skipped, unless a First marker
 *    comes first. A message never restarts mid-way: without the marker, the
 *    receiver cannot tell a lost first fragment from a middle one.
 * 5. A FRAME on the channel resets it and advances its expected sequence
 *    number.
 *
 * Buffers grow by doubling and have no size cap. A cap that dropped messages
 * silently would hide data loss from the consumer; a bound on inbound sizes
 * belongs in a resource-budget design with a public observer, which does not
 * exist yet. Until then, a router can make this buffer as large as the
 * message it sends.
 *
 * @module
 */

import { ByteWriter } from './codec';

const SN_MOD = 2 ** 32;

/** The parts of a FRAGMENT the reassembler reads. */
export interface FragmentInput {
  sn: number;
  /** M flag: another fragment of this message follows. */
  more: boolean;
  first: boolean;
  drop: boolean;
  chunk: Uint8Array;
}

/** Counters for debugging. Not exposed publicly. */
export interface ReassemblyStats {
  /** Sequence gaps that dropped a fragment, with or without a partial message (rule 4). */
  gapDrops: number;
  /** Messages the first-fragment check refused. */
  refused: number;
  /** Reassembly buffers allocated. */
  buffersAllocated: number;
}

/** Fragment state for one channel. */
export class ChannelReassembler {
  private buf: ByteWriter | null = null;
  private skipping = false;
  private expected: number | null = null;
  private readonly counts: ReassemblyStats = { gapDrops: 0, refused: 0, buffersAllocated: 0 };

  /**
   * Take one fragment. Returns the whole message when this fragment ends
   * one, else null.
   *
   * A lone M=0 fragment is returned as its chunk, a view into the batch.
   * A reassembled message is a fresh buffer, never reused.
   *
   * @param admit Asked with the first chunk of each multi-fragment message
   *   before any buffer exists. False skips the rest of the message without
   *   storing it. An exception from it escapes, and the channel skips the
   *   rest of that message as if it had returned false.
   */
  fragment(f: FragmentInput, admit?: (firstChunk: Uint8Array) => boolean): Uint8Array | null {
    const inSequence = this.expected === null || f.sn === this.expected;
    this.expected = (f.sn + 1) % SN_MOD;

    if (f.drop) {
      this.reset();
      return null;
    }
    if (f.first) {
      this.reset();
      return this.start(f, admit);
    }
    if (this.skipping) {
      if (!f.more) this.skipping = false;
      return null;
    }
    if (this.buf === null) {
      if (!inSequence) {
        // A gap before what looks like a message start: it may be a middle
        // fragment of a message whose start was lost (rule 4).
        this.skipping = f.more;
        this.counts.gapDrops++;
        return null;
      }
      return this.start(f, admit);
    }
    if (!inSequence) {
      this.buf = null;
      this.skipping = f.more;
      this.counts.gapDrops++;
      return null;
    }
    this.buf.raw(f.chunk);
    if (f.more) return null;
    const message = this.buf.finish();
    this.buf = null;
    return message;
  }

  /** A FRAME arrived on this channel with sequence number `sn` (rule 5). */
  frame(sn: number): void {
    this.reset();
    this.expected = (sn + 1) % SN_MOD;
  }

  /** Counters since construction. */
  stats(): ReassemblyStats {
    return { ...this.counts };
  }

  private reset(): void {
    this.buf = null;
    this.skipping = false;
  }

  private start(f: FragmentInput, admit?: (firstChunk: Uint8Array) => boolean): Uint8Array | null {
    if (!f.more) return f.chunk;
    if (admit !== undefined) {
      // Skip from here unless admitted, so that if `admit` throws, the rest
      // of this message is skipped and never read as a message of its own.
      this.skipping = true;
      if (!admit(f.chunk)) {
        this.counts.refused++;
        return null;
      }
      this.skipping = false;
    }
    this.buf = new ByteWriter(f.chunk.length * 2).raw(f.chunk);
    this.counts.buffersAllocated++;
    return null;
  }
}
