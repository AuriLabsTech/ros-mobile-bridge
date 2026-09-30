// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * What a delivered message says about its own encoding, and what the client
 * does with a channel in an encoding it cannot decode.
 *
 * The rule: a client reports the encoding the wire actually carried, and says
 * once when it cannot decode it. Up to 0.1.13 the Foxglove client labelled
 * every non-JSON payload `cdr`, so a protobuf channel's bytes arrived under a
 * label that named the wrong format, while `getAvailableTopics()` reported the
 * same channel correctly. And it handed any non-JSON channel to the CDR reader
 * whenever the schema parsed as a ROS definition, which a `ros1` schema can, so
 * ROS 1 bytes could come back as a decoded object with wrong values in it.
 *
 * The protobuf channel below is a capture, not a hand-written schema: see
 * `tests/fixtures/README.md`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import type { RosMessage } from '../src/types';
import {
  installMockWebSocket,
  foxgloveMessageDataFrame,
  type MockWebSocketHandle,
  type MockWebSocket,
} from './_helpers/mock-websocket';
import { capturedProtobufChannel } from './fixtures';

const COMPRESSED_IMAGE = capturedProtobufChannel('foxglove.CompressedImage');

/**
 * Hypothetical: no rig in this project runs a ROS 1 bridge. The definition is
 * chosen because it parses as a ROS 2 message too, which is the whole hazard,
 * and the payload is its ROS 1 serialization (no encapsulation header). Read
 * as CDR, the first four bytes are taken as the header and `a` and `b` come
 * back as 33554432 and 50331648 without any error.
 */
const ROS1_CHANNEL = {
  topic: '/legacy/pair',
  schemaName: 'demo/Pair',
  encoding: 'ros1',
  schemaEncoding: 'ros1msg',
  schema: 'uint32 a\nuint32 b',
};
const ROS1_PAYLOAD = new Uint8Array([1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0]);

/**
 * Hypothetical: a channel in an encoding this client does not decode. Foxglove
 * WebSocket names `flatbuffer` among its message encodings; nothing here
 * decodes it, so it stands for every encoding the client meets without a
 * reader. (Until 0.1.15 protobuf played this part, and it is now decoded.)
 */
const FLATBUFFER_CHANNEL = {
  topic: '/scan/flat',
  schemaName: 'demo.Scan',
  encoding: 'flatbuffer',
  schemaEncoding: 'flatbuffer',
  schema: 'AAAA',
};
const FLATBUFFER_PAYLOAD = new Uint8Array([0x0c, 0x00, 0x00, 0x00, 0x08, 0x00]);

/** A few bytes of protobuf: field 1 (a nested message), then field 2 (a string). */
const PROTOBUF_PAYLOAD = new Uint8Array([0x0a, 0x02, 0x08, 0x01, 0x12, 0x03, 0x72, 0x61, 0x77]);

type Channel = {
  topic: string;
  schemaName: string;
  encoding: string;
  schemaEncoding?: string;
  schema: string;
};

describe('FoxgloveClient — message encoding', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  async function connectAdvertising(
    channels: Channel[],
    warn = vi.fn(),
  ): Promise<{ client: FoxgloveClient; socket: MockWebSocket; warn: typeof warn }> {
    const client = new FoxgloveClient({ logger: { log: vi.fn(), warn, error: vi.fn() } });
    const promise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertise',
        channels: channels.map((c, i) => ({ id: 10 + i, ...c })),
      }),
    );
    await promise;
    return { client, socket, warn };
  }

  /** The subscription id of the most recent subscribe op. */
  function lastSubscriptionId(socket: MockWebSocket): number {
    const ops = socket.sentJson.filter((m) => m.op === 'subscribe');
    const id = (ops.at(-1)?.subscriptions as Array<{ id: number }> | undefined)?.[0]?.id;
    if (id === undefined) throw new Error('client sent no subscribe op');
    return id;
  }

  function warnings(warn: ReturnType<typeof vi.fn>): string[] {
    return warn.mock.calls.map((c) => String(c[0]));
  }

  it('labels a protobuf message protobuf, agreeing with the topic list', async () => {
    const { client, socket } = await connectAdvertising([COMPRESSED_IMAGE]);
    const received: RosMessage[] = [];
    client.subscribe(COMPRESSED_IMAGE.topic, (m) => received.push(m));
    socket.simulateMessage(
      foxgloveMessageDataFrame(lastSubscriptionId(socket), 0n, PROTOBUF_PAYLOAD),
    );

    expect(received).toHaveLength(1);
    expect(received[0]?.encoding).toBe('protobuf');
    const topics = await client.getAvailableTopics();
    expect(topics.find((t) => t.topic === COMPRESSED_IMAGE.topic)?.encoding).toBe(
      received[0]?.encoding,
    );
  });

  it('delivers a payload it cannot decode as the raw bytes it arrived as', async () => {
    const { client, socket } = await connectAdvertising([FLATBUFFER_CHANNEL]);
    const received: RosMessage[] = [];
    client.subscribe(FLATBUFFER_CHANNEL.topic, (m) => received.push(m));
    socket.simulateMessage(
      foxgloveMessageDataFrame(lastSubscriptionId(socket), 0n, FLATBUFFER_PAYLOAD),
    );

    expect(received[0]?.encoding).toBe('flatbuffer');
    const data = received[0]?.data;
    expect(data).toBeInstanceOf(Uint8Array);
    expect(Array.from(data as Uint8Array)).toEqual(Array.from(FLATBUFFER_PAYLOAD));
  });

  it('labels the latest-only drain the same way as the immediate path', async () => {
    const { client, socket } = await connectAdvertising([COMPRESSED_IMAGE]);
    const received: RosMessage[] = [];
    client.subscribe(COMPRESSED_IMAGE.topic, (m) => received.push(m), {
      dispatchMode: 'latest-only',
    });
    socket.simulateMessage(
      foxgloveMessageDataFrame(lastSubscriptionId(socket), 0n, PROTOBUF_PAYLOAD),
    );
    await new Promise((r) => setTimeout(r, 5));

    expect(received).toHaveLength(1);
    expect(received[0]?.encoding).toBe('protobuf');
  });

  it('warns once per channel it cannot decode, naming the topic and the encoding', async () => {
    const { client, socket, warn } = await connectAdvertising([FLATBUFFER_CHANNEL]);
    const unsubA = client.subscribe(FLATBUFFER_CHANNEL.topic, () => {});
    client.subscribe(FLATBUFFER_CHANNEL.topic, () => {});
    const subId = lastSubscriptionId(socket);
    for (let i = 0; i < 3; i++) {
      socket.simulateMessage(foxgloveMessageDataFrame(subId, BigInt(i), FLATBUFFER_PAYLOAD));
    }
    unsubA();

    const hits = warnings(warn).filter((w) => w.includes(FLATBUFFER_CHANNEL.topic));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('flatbuffer');
  });

  it('does not warn again when the same channel is subscribed afresh', async () => {
    const { client, warn } = await connectAdvertising([FLATBUFFER_CHANNEL]);
    const unsub = client.subscribe(FLATBUFFER_CHANNEL.topic, () => {});
    unsub();
    client.subscribe(FLATBUFFER_CHANNEL.topic, () => {});

    expect(warnings(warn).filter((w) => w.includes(FLATBUFFER_CHANNEL.topic))).toHaveLength(1);
  });

  it('never reads a ros1 channel as CDR, even when its schema parses', async () => {
    const { client, socket, warn } = await connectAdvertising([ROS1_CHANNEL]);
    const received: RosMessage[] = [];
    client.subscribe(ROS1_CHANNEL.topic, (m) => received.push(m));
    socket.simulateMessage(foxgloveMessageDataFrame(lastSubscriptionId(socket), 0n, ROS1_PAYLOAD));

    expect(received[0]?.encoding).toBe('ros1');
    expect(received[0]?.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(received[0]?.data as Uint8Array)).toEqual(Array.from(ROS1_PAYLOAD));
    expect(warnings(warn).filter((w) => w.includes(ROS1_CHANNEL.topic))).toHaveLength(1);
  });

  it('leaves cdr and json channels labelled and decoded as before, with no warning', async () => {
    const { client, socket, warn } = await connectAdvertising([
      {
        topic: '/count',
        schemaName: 'std_msgs/msg/UInt32',
        encoding: 'cdr',
        schemaEncoding: 'ros2msg',
        schema: 'uint32 data',
      },
      { topic: '/status', schemaName: 'demo/Status', encoding: 'json', schema: '{}' },
    ]);
    const received: RosMessage[] = [];
    client.subscribe('/count', (m) => received.push(m));
    socket.simulateMessage(
      foxgloveMessageDataFrame(
        lastSubscriptionId(socket),
        0n,
        new Uint8Array([0, 1, 0, 0, 7, 0, 0, 0]),
      ),
    );
    client.subscribe('/status', (m) => received.push(m));
    socket.simulateMessage(
      foxgloveMessageDataFrame(
        lastSubscriptionId(socket),
        0n,
        new TextEncoder().encode('{"ok":true}'),
      ),
    );

    expect(received.map((m) => [m.encoding, m.data])).toEqual([
      ['cdr', { data: 7 }],
      ['json', { ok: true }],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });
});
