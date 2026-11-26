import { afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { RMW, ROS_DISTRO, bridgeVersions, startPublisher, stopPublisher } from './helpers/fixture';
import {
  RECORDING,
  openLiveSession,
  patternBytes,
  toHex,
  waitLive,
  writeRecording,
  type LiveSession,
  type ZenohRecording,
} from './helpers/zenohLive';

/**
 * The native Zenoh session layer (`src/zenoh/session.ts`) against the
 * fixture's own `rmw_zenohd`, over its `ws/` listener. Hand-written keys and
 * bytes, no ROS code: this proves the session, not a ROS client. Only under
 * `RMB_RMW=rmw_zenoh_cpp`; skipped otherwise.
 *
 * The fixture runs ROS domain 17, so ROS data keys start with `17/` and
 * liveliness tokens with `@ros2_lv/17/`. Keys under `rmb_test/` belong to no
 * ROS node: two sessions talk to each other through the router alone.
 *
 * With `RMB_ZENOH_RECORD=1` on Jazzy, two tests also write what their
 * session received to `tests/fixtures/zenoh/`, for the unit suite's replay
 * tests (`tests/integration/README.md`, "Zenoh session recordings").
 */

/** Three fragments each at the 65,535-byte batch: a lost middle one costs one message. */
const FRAGMENTED_SIZE = 150_000;
const TWO_MB = 2 * 1024 * 1024;

/** The fixture's `/fixture/empty` service, `std_srvs/srv/Empty`, any type hash. */
const EMPTY_SERVICE_KEY = '17/fixture/empty/std_srvs::srv::dds_::Empty_/*';
/** An `std_srvs/srv/Empty` request in CDR: the encapsulation header, then one padding byte. */
const EMPTY_REQUEST_CDR = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x00]);

/**
 * The 33-byte attachment rmw_zenoh puts on every message: sequence number
 * (int64 LE), source timestamp in ns (int64 LE), then the 16-byte GID behind
 * its length (one VLE byte, 16).
 */
function rmwAttachment(seq: number): Uint8Array {
  const a = new Uint8Array(33);
  const dv = new DataView(a.buffer);
  dv.setBigInt64(0, BigInt(seq), true);
  dv.setBigInt64(8, BigInt(Date.now()) * 1_000_000n, true);
  a[16] = 16;
  for (let i = 0; i < 16; i++) a[17 + i] = 0xa0 + i;
  return a;
}

describe.runIf(RMW === 'rmw_zenoh_cpp')('ZenohSession against rmw_zenohd', () => {
  let url: string;
  let zenohVersion = 'unknown';
  const open: LiveSession[] = [];

  const session = async (): Promise<LiveSession> => {
    const s = await openLiveSession(url);
    open.push(s);
    return s;
  };

  const source = (test: string): ZenohRecording['source'] => ({
    test: `tests/integration/zenohSession.test.ts: ${test}`,
    distro: ROS_DISTRO,
    rmw: RMW,
    zenoh: zenohVersion,
    recorded: new Date().toISOString().slice(0, 10),
  });

  /**
   * Publishes small messages on `key` from `pub` until `sub` has one: the
   * router has then routed `sub`'s subscription. A subscription has no
   * acknowledgement on the wire.
   */
  async function warmUp(pub: LiveSession, sub: LiveSession, key: string): Promise<void> {
    await waitLive(
      [pub, sub],
      () => {
        pub.session.put(key, new Uint8Array([0x77]));
        return sub.pushes.some((p) => p.key === key);
      },
      `the first message on ${key}`,
    );
  }

  beforeAll(async () => {
    url = inject('zenohUrl')!;
    expect(url).toBeDefined();
    if (RECORDING) {
      const m = /libzenohc (v[0-9.]+)/.exec(await bridgeVersions());
      zenohVersion = m?.[1] ?? 'unknown';
    }
  });

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.shutdown()));
  });

  it('opens a session', async () => {
    const s = await session();
    expect(s.end).toBeNull();
    expect(s.session.linkState().lastRxMs).toBeGreaterThan(0);
  });

  it('lists the liveliness tokens on @ros2_lv/17/**, then D_FINAL, and receives /chatter', async () => {
    const s = await session();
    const interestId = s.session.interest('@ros2_lv/17/**', 'current');
    await waitLive([s], () => s.finals.includes(interestId), 'D_FINAL');
    const tokens = s.tokens.filter((t) => t.interestId === interestId);
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every((t) => t.kind === 'declare' && t.key.startsWith('@ros2_lv/17/'))).toBe(
      true,
    );
    // A token writes each `/` inside a ROS name as `%`: the fixture's /chatter
    // publisher is `.../MP/%/%/<node>/%chatter/<type>/...`.
    expect(tokens.some((t) => /\/MP\/.*\/%chatter\//.test(t.key))).toBe(true);

    s.session.declareSubscriber('17/chatter/**');
    await waitLive([s], () => s.pushes.length >= 3, 'three /chatter samples');
    for (const { key, sample } of s.pushes) {
      expect(key.startsWith('17/chatter/std_msgs::msg::dds_::String_/')).toBe(true);
      expect(sample.kind).toBe('put');
      // rmw_zenoh puts its 33-byte attachment on every message.
      expect(sample.attachment?.length).toBe(33);
    }
    // VERIFY (ticket): does rmw_zenohd forward a PUT timestamp at all?
    const stamped = s.pushes.filter((p) => p.sample.timestamp !== null).length;
    console.info(
      `[zenoh] /chatter: ${stamped} of ${s.pushes.length} samples carry a timestamp; ` +
        `reliable: ${s.pushes.map((p) => p.sample.reliable).join(',')}`,
    );

    if (RECORDING) {
      writeRecording('chatter', source('liveliness interest and /chatter'), s.received, {
        tokens: s.tokens,
        finals: s.finals,
        pushes: s.pushes.map(({ key, sample }) => ({
          key,
          kind: sample.kind,
          payload: toHex(sample.payload),
          attachment: toHex(sample.attachment),
          timestamp: sample.timestamp !== null,
          reliable: sample.reliable,
        })),
      });
    }
  });

  it('reports the key of every departed token: undeclared, its session closed, its node stopped', async () => {
    // rmw_zenohd puts a null wire expression (no key) on every U_TOKEN, so
    // the key must come from the D_TOKEN the session saw.
    const watcher = await session();
    watcher.session.interest('rmb_test/tok/**', 'current-future');
    watcher.session.interest('@ros2_lv/17/**', 'current-future');
    const gone = (match: (key: string) => boolean) => () =>
      watcher.tokens.some((t) => t.kind === 'undeclare' && match(t.key));
    const seen = (match: (key: string) => boolean) => () =>
      watcher.tokens.some((t) => t.kind === 'declare' && match(t.key));

    const other = await session();
    const one = other.session.declareToken('rmb_test/tok/one');
    await waitLive(
      [watcher, other],
      seen((k) => k === 'rmb_test/tok/one'),
      'token one declared',
    );
    other.session.undeclare(one);
    await waitLive(
      [watcher],
      gone((k) => k === 'rmb_test/tok/one'),
      'token one undeclared',
    );

    other.session.declareToken('rmb_test/tok/two');
    await waitLive(
      [watcher],
      seen((k) => k === 'rmb_test/tok/two'),
      'token two declared',
    );
    await other.shutdown();
    await waitLive(
      [watcher],
      gone((k) => k === 'rmb_test/tok/two'),
      'token two gone with its session',
    );

    // The publisher token of a `ros2 topic pub` node (the node itself is `_ros2cli_<pid>`).
    const publisherToken = (k: string) => k.includes('/%rmb_tok_probe/');
    try {
      await startPublisher('/rmb_tok_probe', 'std_msgs/msg/String', '{data: x}', 1);
      await waitLive([watcher], seen(publisherToken), 'the publisher token', 30_000);
    } finally {
      await stopPublisher('/rmb_tok_probe');
    }
    await waitLive([watcher], gone(publisherToken), 'the stopped publisher token');
    expect(watcher.tokens.filter((t) => t.kind === 'undeclare').every((t) => t.key !== '')).toBe(
      true,
    );
  });

  it('moves fragmented messages between two sessions through the router', async () => {
    const sub = await session();
    const pub = await session();
    sub.session.declareSubscriber('rmb_test/frag/**');
    await warmUp(pub, sub, 'rmb_test/frag/warm');

    pub.session.put('rmb_test/frag/big', patternBytes(FRAGMENTED_SIZE, 1));
    pub.session.put('rmb_test/frag/big', patternBytes(FRAGMENTED_SIZE, 2));
    pub.session.put('rmb_test/frag/small', patternBytes(16, 3));
    await waitLive(
      [pub, sub],
      () => sub.pushes.some((p) => p.key === 'rmb_test/frag/small'),
      'the small message after the two fragmented ones',
    );

    const big = sub.pushes.filter((p) => p.key === 'rmb_test/frag/big');
    expect(big.map((p) => p.sample.payload)).toEqual([
      patternBytes(FRAGMENTED_SIZE, 1),
      patternBytes(FRAGMENTED_SIZE, 2),
    ]);
    // Each big message came in fragments, one reassembly buffer each.
    expect(sub.session.stats().reliable).toMatchObject({ buffersAllocated: 2, gapDrops: 0 });

    if (RECORDING) {
      writeRecording(
        'fragments',
        source('fragmented messages between two sessions'),
        sub.received,
        {
          pushes: sub.pushes.map(({ key, sample }) => ({
            key,
            length: sample.payload.length,
            reliable: sample.reliable,
          })),
          patterns: { 'rmb_test/frag/big': [1, 2], 'rmb_test/frag/small': [3] },
        },
      );
    }
  });

  it('moves 2 MB from one session to another, identical bytes', async () => {
    const sub = await session();
    const pub = await session();
    sub.session.declareSubscriber('rmb_test/big');
    sub.session.declareSubscriber('rmb_test/big/warm');
    await warmUp(pub, sub, 'rmb_test/big/warm');

    const payload = patternBytes(TWO_MB, 5);
    pub.session.put('rmb_test/big', payload);
    await waitLive(
      [pub, sub],
      () => sub.pushes.some((p) => p.key === 'rmb_test/big'),
      'the 2 MB message',
    );
    const got = sub.pushes.find((p) => p.key === 'rmb_test/big')!;
    expect(got.sample.payload.length).toBe(TWO_MB);
    // Not toEqual, which walks 2 MB element by element (about 3.5 s). -1: every byte matches.
    expect(got.sample.payload.findIndex((v, i) => v !== payload[i])).toBe(-1);
  });

  it('queries /fixture/empty: one reply, then the final', async () => {
    const s = await session();
    const replies: string[] = [];
    let final = false;
    let sessionEnd = false;
    const errors: Uint8Array[] = [];
    s.session.query(
      EMPTY_SERVICE_KEY,
      { target: 'best-matching', payload: EMPTY_REQUEST_CDR, attachment: rmwAttachment(1) },
      {
        onReply: (key) => replies.push(key),
        onError: (payload) => errors.push(payload),
        onFinal: () => (final = true),
        onSessionEnd: () => (sessionEnd = true),
      },
    );
    await waitLive([s], () => final || sessionEnd, 'the query final');
    expect(sessionEnd).toBe(false);
    expect(errors).toEqual([]);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.startsWith('17/fixture/empty/std_srvs::srv::dds_::Empty_/')).toBe(true);
  });
});
