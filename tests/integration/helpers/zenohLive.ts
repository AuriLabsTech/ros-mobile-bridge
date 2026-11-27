/**
 * A `ZenohSession` on a real WebSocket, for the integration tests, and the
 * recorder that turns a run into replay fixtures.
 *
 * The session never touches a socket, so this helper plays the owner the
 * Zenoh client will be: it opens the socket, feeds each binary message to
 * `receive`, and writes each batch as one binary message. Every received
 * batch is also kept, copied, in arrival order: that list is what a
 * recording stores and what a replay feeds back.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ZenohSession,
  type Sample,
  type SessionCallbacks,
  type SessionEnd,
} from '../../../src/zenoh/session';
import { patternBytes, type ZenohRecording } from '../../zenoh/recordings';
import { ROS_DISTRO } from './fixture';
import { waitFor } from './wait';

export interface TokenEvent {
  kind: 'declare' | 'undeclare';
  key: string;
  interestId: number | null;
}

/** One live session and everything it reported. */
export interface LiveSession {
  session: ZenohSession;
  /** Every received batch, copied, in arrival order. */
  received: Uint8Array[];
  pushes: Array<{ key: string; sample: Sample }>;
  tokens: TokenEvent[];
  finals: number[];
  /** Set once `onClosed` ran. */
  end: SessionEnd | null;
  /** Decides `admitPush`; admits everything unless replaced. */
  admit: (key: string) => boolean;
  /** Closes the session (Zenoh CLOSE) and then the socket. */
  shutdown(): Promise<void>;
}

const OPEN_TIMEOUT_MS = 10_000;

/** Opens a socket to `url` and a session on it; resolves once the session is open. */
export function openLiveSession(url: string): Promise<LiveSession> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    let socketClosed: () => void = () => {};
    const closedOnce = new Promise<void>((r) => (socketClosed = r));

    const live: LiveSession = {
      session: undefined as unknown as ZenohSession,
      received: [],
      pushes: [],
      tokens: [],
      finals: [],
      end: null,
      admit: () => true,
      async shutdown() {
        live.session.close();
        if (ws.readyState !== WebSocket.CLOSED) ws.close();
        await closedOnce;
      },
    };

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Zenoh session to ${url} did not open within ${OPEN_TIMEOUT_MS} ms`));
    }, OPEN_TIMEOUT_MS);

    const callbacks: SessionCallbacks = {
      onOpen: () => {
        clearTimeout(timer);
        resolve(live);
      },
      onClosed: (cause) => {
        live.end = cause;
        clearTimeout(timer);
        // Before open nobody holds `live` to shut it down; after open the
        // promise has settled and this close is the owner's anyway.
        if (ws.readyState !== WebSocket.CLOSED) ws.close();
        reject(new Error(`Zenoh session ended before it opened: ${JSON.stringify(cause)}`));
      },
      admitPush: (key) => live.admit(key),
      onPush: (key, sample) => live.pushes.push({ key, sample }),
      onToken: (ev) => live.tokens.push(ev),
      onDeclareFinal: (id) => live.finals.push(id),
    };

    live.session = new ZenohSession(callbacks, { send: (batch) => ws.send(batch) });

    ws.onopen = () => live.session.start();
    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        live.session.close();
        ws.close();
        return;
      }
      const bytes = new Uint8Array(event.data as ArrayBuffer);
      live.received.push(bytes.slice());
      live.session.receive(bytes);
    };
    // A no-op error listener: the plain `ws` global crashes the process on
    // an unlistened 'error' (see `ws-global.ts`). The close that follows ends
    // the session.
    ws.onerror = () => {};
    ws.onclose = () => {
      live.session.close();
      socketClosed();
    };
  });
}

export { patternBytes, type ZenohRecording };

/**
 * Recording is on when `RMB_ZENOH_RECORD=1`, and on Jazzy only: the replay
 * tests name Jazzy's router, and a matrix run would otherwise leave whichever
 * distro ran last in every recording file.
 */
export const RECORDING = process.env.RMB_ZENOH_RECORD === '1' && ROS_DISTRO === 'jazzy';

/**
 * Waits for `condition`, failing at once with the cause if any of `sessions`
 * ends first, instead of timing out with the cause lost.
 */
export async function waitLive(
  sessions: LiveSession[],
  condition: () => boolean,
  label: string,
  timeoutMs = 20_000,
): Promise<void> {
  await waitFor(
    () => {
      const ended = sessions.find((s) => s.end !== null);
      if (ended !== undefined) {
        throw new Error(`Zenoh session ended waiting for ${label}: ${JSON.stringify(ended.end)}`);
      }
      return condition();
    },
    timeoutMs,
    label,
  );
}

const FIXTURE_DIR = fileURLToPath(new URL('../../fixtures/zenoh/', import.meta.url));

/** Writes `tests/fixtures/zenoh/<name>.json`. Call only when `RECORDING`. */
export function writeRecording(
  name: string,
  source: ZenohRecording['source'],
  received: Uint8Array[],
  observed: unknown,
): void {
  const rec: ZenohRecording = {
    source,
    observed,
    batches: received.map((b) => Buffer.from(b).toString('base64')),
  };
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(`${FIXTURE_DIR}${name}.json`, `${JSON.stringify(rec, null, 2)}\n`);
}

export const toHex = (u: Uint8Array | null): string | null =>
  u === null ? null : Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
