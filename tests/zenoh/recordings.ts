/**
 * The Zenoh session recordings in `tests/fixtures/zenoh/`, written by
 * `tests/integration/zenohSession.test.ts` under `RMB_ZENOH_RECORD=1`, and a
 * replay that feeds them to a fresh `ZenohSession`.
 *
 * A recording holds every batch one session received from a real router, in
 * order, starting with the InitAck. Replaying it needs no socket: the session
 * sends its InitSyn and OpenSyn into a recorder, and the router's half of the
 * handshake comes from the file.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ZenohSession,
  type Sample,
  type SessionEnd,
  type SessionStats,
} from '../../src/zenoh/session';

/** What one recording file holds. */
export interface ZenohRecording<Observed = unknown> {
  /** Where it came from: the test that wrote it and the router under it. */
  source: { test: string; distro: string; rmw: string; zenoh: string; recorded: string };
  /** What the live session reported, for a replay to match. */
  observed: Observed;
  /** Every batch the session received, base64, in arrival order. */
  batches: string[];
}

const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/zenoh/', import.meta.url));

/** Reads `tests/fixtures/zenoh/<name>.json`; its batches come back decoded. */
export function loadRecording<Observed>(name: string): {
  recording: ZenohRecording<Observed>;
  batches: Uint8Array[];
} {
  const recording = JSON.parse(
    readFileSync(`${FIXTURE_DIR}${name}.json`, 'utf8'),
  ) as ZenohRecording<Observed>;
  const batches = recording.batches.map((b) => new Uint8Array(Buffer.from(b, 'base64')));
  return { recording, batches };
}

/** Bytes `0..n` of a fixed pattern, different per `seed`, so a replay can rebuild them. */
export function patternBytes(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 7 + seed * 13) & 0xff;
  return out;
}

export interface ReplayResult {
  pushes: Array<{ key: string; sample: Sample }>;
  tokens: Array<{ kind: 'declare' | 'undeclare'; key: string; interestId: number | null }>;
  finals: number[];
  end: SessionEnd | null;
  opened: boolean;
  stats: SessionStats;
}

/** Feeds `batches` to a fresh session, after its `start`, and reports what it delivered. */
export function replay(
  batches: Uint8Array[],
  admit: (key: string) => boolean = () => true,
): ReplayResult {
  const result: Omit<ReplayResult, 'stats'> = {
    pushes: [],
    tokens: [],
    finals: [],
    end: null,
    opened: false,
  };
  const session = new ZenohSession(
    {
      onOpen: () => (result.opened = true),
      onClosed: (cause) => (result.end = cause),
      admitPush: admit,
      onPush: (key, sample) => result.pushes.push({ key, sample }),
      onToken: (ev) => result.tokens.push(ev),
      onDeclareFinal: (id) => result.finals.push(id),
    },
    { send: () => {} },
  );
  session.start();
  for (const b of batches) session.receive(b);
  // Read before the close below, which would itself end the session.
  const out: ReplayResult = { ...result, stats: session.stats() };
  session.close();
  return out;
}
