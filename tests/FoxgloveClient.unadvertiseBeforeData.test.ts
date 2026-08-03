// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * KNOWN LIMITATION, deliberately pinned and deliberately skipped. Scheduled for
 * v0.1.10; see the note at the bottom of this comment before un-skipping.
 *
 * v0.1.9 moved the read of `encoding` and `schemaName` from drain time to stash
 * time, which closes the wide window: an `unadvertise` landing between a stash
 * and its drain, up to two seconds under the adaptive floor. It does NOT close
 * the narrow one. If the `unadvertise` reaches the socket AHEAD of a
 * `MessageData` frame for that same channel, the channel is already gone from
 * `this.channels` when the frame is stashed, and both the stash path
 * (`FoxgloveClient.ts`, `stashChannel`) and the synchronous `immediate` path
 * (`channelInfo`) fall back to `encoding: 'json'` with an empty `schemaName`.
 *
 * That reordering is not hypothetical. The Foxglove SDK's WebSocket server
 * drains its control and data queues with an unbiased `tokio::select!`, so
 * enqueue order is well defined but wire order is not, and an `unadvertise` can
 * be written ahead of `MessageData` enqueued earlier for that channel. See
 * `rust/foxglove/src/websocket/connected_client/poller.rs` in
 * `foxglove/foxglove-sdk`, whose writer loop selects over the control-plane and
 * data-plane receivers with no `biased;`.
 *
 * Why this is skipped rather than fixed in v0.1.9:
 *
 * - It is NOT a regression. Pre-v0.1.9 the drain read the channel map too, so
 *   this case behaved identically. v0.1.9 is strictly better, not worse.
 * - It does not throw. `decodePayload` catches and returns the raw payload, so
 *   the consumer gets undecoded bytes rather than a crash.
 * - Its trigger is unreachable on `foxglove_bridge`, whose channels mirror the
 *   ROS graph and whose own subscription keeps a watched topic listed, so no
 *   device pass against that bridge can validate a fix for it either way.
 *
 * The fix, for v0.1.10: capture `encoding` and `schemaName` onto the
 * subscription record at SUBSCRIBE time, where the channel is known present and
 * is already being read to build the CDR reader, then have both paths read from
 * the subscription instead of from `this.channels`. The protocol makes this
 * sound rather than merely convenient: a server may reuse a channel id only if
 * topic, encoding, schemaName and schema are all identical, so a given
 * channel id's metadata is immutable and reading it live never bought anything.
 *
 * Un-skip this block, make it green, and delete this paragraph.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import type { RosMessage } from '../src/types';
import {
  installMockWebSocket,
  foxgloveMessageDataFrame,
  type MockWebSocketHandle,
} from './_helpers/mock-websocket';

const CHANNEL_ID = 5;
const SCHEMA_NAME = 'sensor_msgs/msg/Image';

describe.skip('FoxgloveClient — unadvertise arriving before its channel data (v0.1.10)', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    vi.useRealTimers();
    ws.restore();
  });

  async function connectRawTopic() {
    const client = new FoxgloveClient();
    const connectPromise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(
      JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }),
    );
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertise',
        channels: [
          {
            id: CHANNEL_ID,
            topic: '/raw',
            encoding: 'cdr',
            schemaName: SCHEMA_NAME,
            schema: '',
          },
        ],
      }),
    );
    await connectPromise;
    return { client, socket };
  }

  const unadvertise = (socket: ReturnType<MockWebSocketHandle['last']>): void => {
    socket.simulateMessage(
      JSON.stringify({ op: 'unadvertise', channelIds: [CHANNEL_ID] }),
    );
  };

  const payload = (tag: number): Uint8Array => new Uint8Array(8).fill(tag);

  it('labels a latest-only frame correctly even when the unadvertise preceded it', async () => {
    const { client, socket } = await connectRawTopic();
    vi.useFakeTimers();

    const received: RosMessage[] = [];
    client.subscribe('/raw', (m) => received.push(m), {
      dispatchMode: 'latest-only',
      disableAdaptive: true,
    });

    // The channel goes away FIRST, then its data arrives. The subscription is
    // untouched by an unadvertise, so the frame still routes here.
    unadvertise(socket);
    socket.simulateMessage(foxgloveMessageDataFrame(1, 0n, payload(0xa1)));

    vi.runOnlyPendingTimers();

    expect(received).toHaveLength(1);
    // These bytes were advertised as CDR under a real schema name. Losing the
    // channel must not turn them into an unlabelled JSON frame.
    expect(received[0]!.encoding).toBe('cdr');
    expect(received[0]!.schemaName).toBe(SCHEMA_NAME);
  });

  it('labels an immediate frame correctly even when the unadvertise preceded it', async () => {
    const { client, socket } = await connectRawTopic();

    const received: RosMessage[] = [];
    client.subscribe('/raw', (m) => received.push(m)); // default: immediate

    unadvertise(socket);
    socket.simulateMessage(foxgloveMessageDataFrame(1, 0n, payload(0xb2)));

    // The synchronous path reads the channel map at parse time and has the same
    // exposure as the deferred one, so the v0.1.10 fix has to cover both.
    expect(received).toHaveLength(1);
    expect(received[0]!.encoding).toBe('cdr');
    expect(received[0]!.schemaName).toBe(SCHEMA_NAME);
  });
});
