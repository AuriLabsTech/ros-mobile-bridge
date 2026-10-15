// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * Reassembly of rosbridge `fragment` frames. Internal; not exported.
 *
 * rosbridge_server cuts any outgoing frame longer than its `max_message_size`
 * into `{"op":"fragment","id","data","num","total"}` frames, `num` from 0,
 * without being asked. Joining the `data` strings in `num` order gives back
 * the original frame.
 *
 * Wire facts this relies on (rosbridge_server 2.7.1, measured):
 * - Fragments of one message arrive in order, so only the next `num` extends
 *   a message; anything else drops it rather than fill a gap.
 * - Every fragmented topic message carries id `"0"`, so a `num: 0` under an id
 *   still in flight means the previous message under it lost a fragment.
 * - Concurrent service responses interleave fragment by fragment across their
 *   call ids, so several messages can be in flight at once.
 * - The server drops frames when its write queue is full, so a message can
 *   stay incomplete forever. Partials are dropped after an idle timeout and on
 *   disconnect, and the bytes held at once are capped.
 */

/**
 * A partial message idle this long since its last fragment is dropped. The
 * check runs as frames arrive (no timer of its own), so on a silent
 * connection the partial is held until the next frame or the disconnect.
 */
export const FRAGMENT_IDLE_TIMEOUT_MS = 10_000;

/** Upper bound on the characters held across all partial messages. */
export const FRAGMENT_MAX_BUFFERED_CHARS = 64 * 1024 * 1024;

interface Fragment {
  id: string;
  data: string;
  num: number;
  total: number;
}

/** Read a `fragment` frame's fields, or `null` when any is missing or out of range. */
function parseFragment(frame: Record<string, unknown>): Fragment | null {
  const { id, data, num, total } = frame;
  if (typeof id !== 'string' && typeof id !== 'number') return null;
  if (typeof data !== 'string') return null;
  if (typeof num !== 'number' || typeof total !== 'number') return null;
  if (!Number.isInteger(num) || !Number.isInteger(total)) return null;
  if (num < 0 || num >= total) return null;
  return { id: String(id), data, num, total };
}

interface PartialMessage {
  total: number;
  parts: Array<string | undefined>;
  received: number;
  chars: number;
  lastAt: number;
}

export interface FragmentAssemblerOptions {
  idleTimeoutMs?: number;
  maxBufferedChars?: number;
  /** Called with a one-line reason whenever a fragment or partial message is dropped. */
  onDrop: (reason: string) => void;
}

export class FragmentAssembler {
  private readonly partials = new Map<string, PartialMessage>();
  /** Per id, the `total` of the message last dropped, until the next start. */
  private readonly dropped = new Map<string, number>();
  private bufferedChars = 0;
  private readonly idleTimeoutMs: number;
  private readonly maxBufferedChars: number;
  private readonly onDrop: (reason: string) => void;

  constructor(options: FragmentAssemblerOptions) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? FRAGMENT_IDLE_TIMEOUT_MS;
    this.maxBufferedChars = options.maxBufferedChars ?? FRAGMENT_MAX_BUFFERED_CHARS;
    this.onDrop = options.onDrop;
  }

  /** Number of messages currently partly received. */
  get pending(): number {
    return this.partials.size;
  }

  /**
   * Take one parsed `fragment` frame. Returns the joined original frame when
   * this fragment completes it, otherwise `null`.
   */
  accept(frame: Record<string, unknown>, now: number): string | null {
    const fragment = parseFragment(frame);
    if (!fragment) {
      this.onDrop('malformed fragment frame ignored');
      return null;
    }
    const { id, data, num } = fragment;
    const partial = this.partialFor(fragment, now);
    if (!partial) return null;

    if (this.bufferedChars + data.length > this.maxBufferedChars) {
      this.drop(
        id,
        partial,
        `message ${id} dropped, fragments exceed ${this.maxBufferedChars} characters`,
      );
      return null;
    }
    partial.parts[num] = data;
    partial.received++;
    partial.chars += data.length;
    partial.lastAt = now;
    this.bufferedChars += data.length;

    if (partial.received < partial.total) return null;
    this.partials.delete(id);
    this.bufferedChars -= partial.chars;
    return partial.parts.join('');
  }

  /** Drop every partial message whose last fragment is older than the idle timeout. */
  sweep(now: number): void {
    for (const [id, partial] of this.partials) {
      if (now - partial.lastAt > this.idleTimeoutMs) {
        this.drop(
          id,
          partial,
          `message ${id} dropped, ${partial.received}/${partial.total} fragments after ${this.idleTimeoutMs} ms`,
        );
      }
    }
  }

  /** Forget every partial message (the connection ended). */
  clear(): void {
    this.partials.clear();
    this.dropped.clear();
    this.bufferedChars = 0;
  }

  /**
   * The partial message this fragment belongs to, started fresh on `num: 0`,
   * or `null` when the fragment has nothing to join. Only the next fragment
   * in order extends a message. Anything else under an id still in flight (a
   * start, a changed `total`, a skipped or repeated `num`) means the message
   * lost a fragment or another message is mixed in, and every topic message
   * shares id `"0"`, so filling a gap could splice two messages into one.
   */
  private partialFor(fragment: Fragment, now: number): PartialMessage | null {
    const { id, num, total } = fragment;
    const current = this.partials.get(id);
    if (current && num !== 0 && current.total === total && num === current.received) {
      return current;
    }
    if (current) {
      this.drop(id, current, `fragments of message ${id} out of order, message dropped`);
    }
    if (num !== 0) {
      // The rest of a message already dropped (and logged) goes quietly.
      if (this.dropped.get(id) !== total) {
        this.onDrop(`fragment ${num}/${total} of message ${id} ignored, its start never arrived`);
      }
      return null;
    }
    this.dropped.delete(id);
    const partial: PartialMessage = {
      total,
      parts: new Array<string | undefined>(total),
      received: 0,
      chars: 0,
      lastAt: now,
    };
    this.partials.set(id, partial);
    return partial;
  }

  private drop(id: string, partial: PartialMessage, reason: string): void {
    this.partials.delete(id);
    this.dropped.set(id, partial.total);
    this.bufferedChars -= partial.chars;
    this.onDrop(reason);
  }
}
