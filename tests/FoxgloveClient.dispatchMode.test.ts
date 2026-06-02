import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import type { RosMessage } from '../src/types';
import {
  installMockWebSocket,
  foxgloveMessageDataFrame,
  type MockWebSocketHandle,
} from './_helpers/mock-websocket';

describe('FoxgloveClient — dispatchMode', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });

  afterEach(() => {
    vi.useRealTimers();
    ws.restore();
  });

  // Connect and advertise one CDR topic with no schema, so messages are
  // delivered as raw `Uint8Array` — making the conflation and copy assertions
  // direct to write. The first subscribe on the connection gets id 1.
  async function connectRawTopic() {
    const client = new FoxgloveClient();
    const connectPromise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertise',
        channels: [
          {
            id: 5,
            topic: '/raw',
            encoding: 'cdr',
            schemaName: 'sensor_msgs/msg/Image',
            schema: '',
          },
        ],
      }),
    );
    await connectPromise;
    return { client, socket };
  }

  // A payload whose bytes are all `tag`, so frames are told apart by content.
  function framePayload(tag: number, size = 8): Uint8Array {
    return new Uint8Array(size).fill(tag);
  }

  it('immediate (default) delivers synchronously, with no timer to drain', async () => {
    const { client, socket } = await connectRawTopic();

    const received: RosMessage[] = [];
    client.subscribe('/raw', (m) => received.push(m)); // default: immediate

    socket.simulateMessage(foxgloveMessageDataFrame(1, 0n, framePayload(0x07)));

    expect(received).toHaveLength(1);
    expect(Array.from(received[0]!.data as Uint8Array)).toEqual(
      Array.from(framePayload(0x07)),
    );
  });

  it('latest-only defers off-tick and conflates a burst to the newest frame', async () => {
    const { client, socket } = await connectRawTopic();
    vi.useFakeTimers();

    const received: RosMessage[] = [];
    client.subscribe('/raw', (m) => received.push(m), {
      dispatchMode: 'latest-only',
      disableAdaptive: true,
    });

    // Three frames in the same tick (no timer advance between them).
    socket.simulateMessage(foxgloveMessageDataFrame(1, 0n, framePayload(0xa1)));
    socket.simulateMessage(foxgloveMessageDataFrame(1, 0n, framePayload(0xb2)));
    socket.simulateMessage(foxgloveMessageDataFrame(1, 0n, framePayload(0xc3)));

    // Nothing yet — delivery is deferred.
    expect(received).toHaveLength(0);

    vi.runOnlyPendingTimers();

    // Exactly one delivery, and it is the newest frame.
    expect(received).toHaveLength(1);
    expect(Array.from(received[0]!.data as Uint8Array)).toEqual(
      Array.from(framePayload(0xc3)),
    );
  });

  it('latest-only delivers a materialized (owned, offset-0) copy, not a view into the frame', async () => {
    const { client, socket } = await connectRawTopic();
    vi.useFakeTimers();

    const received: RosMessage[] = [];
    client.subscribe('/raw', (m) => received.push(m), {
      dispatchMode: 'latest-only',
      disableAdaptive: true,
    });

    const frame = foxgloveMessageDataFrame(1, 0n, framePayload(0xd4));
    socket.simulateMessage(frame);
    vi.runOnlyPendingTimers();

    expect(received).toHaveLength(1);
    const data = received[0]!.data as Uint8Array;
    expect(data).toBeInstanceOf(Uint8Array);
    // Stash materializes the payload so it survives the tick: owned buffer,
    // offset 0, distinct from the (now-reusable) inbound frame buffer.
    expect(data.byteOffset).toBe(0);
    expect(data.buffer).not.toBe(frame);
    expect(data.buffer.byteLength).toBe(data.byteLength);
    expect(Array.from(data)).toEqual(Array.from(framePayload(0xd4)));
  });

  it('latest-only discards the pending frame on unsubscribe — no post-teardown delivery', async () => {
    const { client, socket } = await connectRawTopic();
    vi.useFakeTimers();

    const received: RosMessage[] = [];
    const unsubscribe = client.subscribe('/raw', (m) => received.push(m), {
      dispatchMode: 'latest-only',
      disableAdaptive: true,
    });

    socket.simulateMessage(foxgloveMessageDataFrame(1, 0n, framePayload(0xe5)));
    expect(received).toHaveLength(0); // armed, not yet drained

    unsubscribe();
    vi.runOnlyPendingTimers();

    expect(received).toHaveLength(0); // pending dropped
  });

  it('latest-only discards the pending frame on disconnect', async () => {
    const { client, socket } = await connectRawTopic();
    vi.useFakeTimers();

    const received: RosMessage[] = [];
    client.subscribe('/raw', (m) => received.push(m), {
      dispatchMode: 'latest-only',
      disableAdaptive: true,
    });

    socket.simulateMessage(foxgloveMessageDataFrame(1, 0n, framePayload(0xf6)));
    expect(received).toHaveLength(0);

    await client.disconnect();
    vi.runOnlyPendingTimers();

    expect(received).toHaveLength(0);
  });

  it('a throwing latest-only callback is contained and does not wedge future delivery', async () => {
    const { client, socket } = await connectRawTopic();
    vi.useFakeTimers();

    let calls = 0;
    client.subscribe(
      '/raw',
      () => {
        calls++;
        if (calls === 1) throw new Error('boom');
      },
      { dispatchMode: 'latest-only', disableAdaptive: true },
    );

    socket.simulateMessage(foxgloveMessageDataFrame(1, 0n, framePayload(0x01)));
    vi.runOnlyPendingTimers(); // first drain throws, is caught
    expect(calls).toBe(1);

    socket.simulateMessage(foxgloveMessageDataFrame(1, 0n, framePayload(0x02)));
    vi.runOnlyPendingTimers(); // subscription is not wedged
    expect(calls).toBe(2);
  });
});
