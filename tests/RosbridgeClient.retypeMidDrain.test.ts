// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * rosbridge: a `latest-only` message stashed inside a closed throttle window
 * must be delivered labelled with the type it ARRIVED under, not the type the
 * subscription happens to carry when the drain fires.
 *
 * The two are not the same thing. `resubscribeNewlyTypedTopics` (the 0.1.7
 * discovery self-heal) iterates `activeSubscriptions` and mutates
 * `sub.schemaName` in place, and it does not cancel armed drains. So a
 * discovery pass landing between stash and drain re-types the subscription
 * while a message from the OLD type is still waiting. Reading the type at
 * drain time hands that message to the consumer under a type it was never
 * encoded as.
 *
 * Unlike the Foxglove half of this defect, which needs a channel to be
 * unadvertised and is therefore unreachable on a bridge that holds its own ROS
 * subscription for any topic a client is watching, this path is reachable
 * WHILE SUBSCRIBED: `resubscribeNewlyTypedTopics` only ever looks at
 * subscriptions that are active. Nothing exotic is required, only a discovery
 * pass inside the drain window, and trailing delivery widens that window from
 * a single `setTimeout(0)` gap to the full throttle interval.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RosbridgeClient } from '../src/RosbridgeClient';
import type { RosMessage } from '../src/types';
import {
  installMockWebSocket,
  type MockWebSocketHandle,
} from './_helpers/mock-websocket';

type Socket = ReturnType<MockWebSocketHandle['last']>;

const HINTED_TYPE = 'geometry_msgs/msg/PoseStamped';
const DISCOVERED_TYPE = 'nav_msgs/msg/Odometry';

/** Respond to the most recent `/rosapi/topics` call on `socket`. */
function respondTopics(socket: Socket, names: string[], types: string[]): void {
  const calls = socket.sentJson.filter(
    (m) => m.op === 'call_service' && m.service === '/rosapi/topics',
  );
  const last = calls[calls.length - 1] as { id: string } | undefined;
  if (!last) throw new Error('no /rosapi/topics call to respond to');
  socket.simulateMessage(
    JSON.stringify({
      op: 'service_response',
      id: last.id,
      result: true,
      values: { topics: names, types },
    }),
  );
}

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('RosbridgeClient — discovery re-type mid-drain', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    vi.useRealTimers();
    ws.restore();
  });

  async function connectedClient() {
    const client = new RosbridgeClient();
    const promise = client.connect('ws://localhost:9090');
    const socket = ws.last();
    socket.simulateOpen();
    await promise;
    return { client, socket };
  }

  const publishFrame = (topic: string, seq: number): string =>
    JSON.stringify({ op: 'publish', topic, msg: { seq } });

  it('labels a trailing frame with the type it arrived under, not the re-typed subscription', async () => {
    const { client, socket } = await connectedClient();
    vi.useFakeTimers();

    const received: RosMessage[] = [];
    // The hint is the documented 0.1.7 path: the consumer supplies a type up
    // front, and discovery is allowed to overrule it. `discoveredTopics` is
    // still empty at this instant, so the hint is what gets recorded.
    client.subscribe('/pose', (m) => received.push(m), {
      dispatchMode: 'latest-only',
      maxFrequency: 10,
      schemaName: HINTED_TYPE,
    });

    // Frame 1 opens the cadence: it delivers and moves `lastDeliveredAt`, so
    // frame 2 lands inside a genuinely closed window rather than draining on
    // the next tick.
    socket.simulateMessage(publishFrame('/pose', 1));
    vi.advanceTimersByTime(200);
    expect(received).toHaveLength(1);
    expect(received[0]!.schemaName).toBe(HINTED_TYPE);

    // Frame 2 is stashed, not delivered: the window is closed.
    socket.simulateMessage(publishFrame('/pose', 2));
    expect(received).toHaveLength(1);

    // Discovery now overrules the hint WHILE frame 2 is still waiting. This is
    // the self-heal doing exactly its job; it re-types the subscription and
    // re-issues the subscribe, and it leaves the armed drain alone.
    respondTopics(socket, ['/pose'], [DISCOVERED_TYPE]);
    await flush();

    // The self-heal really did fire, otherwise this test proves nothing.
    const subs = socket.sentJson.filter((m) => m.op === 'subscribe');
    expect(subs[subs.length - 1]!.type).toBe(DISCOVERED_TYPE);

    vi.advanceTimersByTime(200);

    // Frame 2 arrived while the topic was understood as HINTED_TYPE, and it is
    // those bytes that were stashed. Delivering them under DISCOVERED_TYPE
    // would hand the consumer a message labelled as a type it was never
    // encoded as. Pre-fix, this read `sub.schemaName` at drain time and
    // returned DISCOVERED_TYPE here.
    expect(received).toHaveLength(2);
    expect(received[1]!.data).toEqual({ seq: 2 });
    expect(received[1]!.schemaName).toBe(HINTED_TYPE);
  });

  it('a frame arriving after the re-type is labelled with the new type', async () => {
    const { client, socket } = await connectedClient();
    vi.useFakeTimers();

    const received: RosMessage[] = [];
    client.subscribe('/pose', (m) => received.push(m), {
      dispatchMode: 'latest-only',
      maxFrequency: 10,
      schemaName: HINTED_TYPE,
    });

    respondTopics(socket, ['/pose'], [DISCOVERED_TYPE]);
    await flush();

    socket.simulateMessage(publishFrame('/pose', 1));
    vi.advanceTimersByTime(200);

    // The counterpart to the test above: capturing at stash time must not
    // freeze the subscription's type forever. A message that genuinely arrives
    // after the re-type carries the new type.
    expect(received).toHaveLength(1);
    expect(received[0]!.schemaName).toBe(DISCOVERED_TYPE);
  });
});
