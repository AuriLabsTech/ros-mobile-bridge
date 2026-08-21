// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * Subscribing to a topic, or calling a service, whose message type has no
 * fields.
 *
 * A server describes such a type by advertising it with an empty schema
 * string. Foxglove WS v1 makes `schema` a required field, so the empty string
 * is a value the server chose rather than one it left out, and on
 * `foxglove_bridge`'s success path it means exactly one thing: the type's
 * definition file is empty. `std_msgs/msg/Empty.msg` is a zero-byte file.
 * Reading that as "no schema at all" is the conflation that made every
 * fieldless service request uncallable up to 0.1.10, and it failed the same
 * invisible way here, with a heartbeat surfacing as raw bytes.
 *
 * Two things guard the reading, and neither is a payload length:
 *
 * 1. The channel must also declare a real message encoding. The same bridges
 *    emit an empty schema when a definition *lookup* fails, and that branch
 *    never assigns `encoding`, so `cdr` plus an empty schema is reachable only
 *    from the success path.
 * 2. The decode must account for the payload. Bytes left over that CDR final
 *    padding does not explain mean the description was wrong, and the raw
 *    payload is handed back rather than an empty object that hides data.
 *
 * See ADR 0010. The rc.1 version of this fix keyed on the payload being 4 or 5
 * bytes long and never engaged against a real bridge, which is why the fixture
 * below is a capture and not a serializer call.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parse as parseRosMsgDef } from '@foxglove/rosmsg';
import { MessageWriter } from '@foxglove/rosmsg2-serialization';
import { FoxgloveClient } from '../src/FoxgloveClient';
import type { RosMessage } from '../src/types';
import {
  installMockWebSocket,
  foxgloveMessageDataFrame,
  findSentServiceCallRequest,
  foxgloveServiceCallResponseFrame,
  type MockWebSocketHandle,
  type MockWebSocket,
} from './_helpers/mock-websocket';

const HEARTBEAT = '/heartbeat';

/**
 * A real fieldless message, captured from the wire.
 *
 * Source: a stock `foxglove_bridge` publishing `std_msgs/msg/Empty` on
 * `/heartbeat` at about 1 Hz, read by a direct Node consumer of this library
 * during the 0.1.11-rc.1 validation pass on 2026-08-18. Every frame carried
 * these eight bytes.
 *
 * Do not regenerate this from `MessageWriter`. The bytes this library *writes*
 * for a fieldless type are five, and that number is also measured, but on the
 * send side: a bridge accepts five and emits eight. The two directions are not
 * symmetric, and a fixture derived from our own encoder cannot show the
 * difference, which is exactly how the rc.1 defect passed a green suite.
 *
 * The three extra bytes are RTPS submessage alignment, not part of the CDR
 * encoding, so they are not a constant of the message type either: a different
 * middleware under the same bridge can deliver the same message as five bytes.
 * Nothing in the library may key on this length.
 */
const MEASURED_EMPTY_BYTES = new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0]);

/** What this library's own writer produces for the same type. */
const WRITTEN_EMPTY_BYTES = new MessageWriter(parseRosMsgDef('', { ros2: true })).writeMessage({});

/** The bare encapsulation header, which is not a valid ROS 2 serialization. */
const BARE_HEADER = new Uint8Array([0x00, 0x01, 0x00, 0x00]);

describe('FoxgloveClient — a topic whose message type has no fields', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  /**
   * Connect with one channel advertised. `schema` and `encoding` are passed
   * through verbatim so each test can script exactly what the server said.
   */
  async function connectAdvertising(
    channel: { schemaName: string; schema: string; encoding?: string },
    options?: ConstructorParameters<typeof FoxgloveClient>[0],
  ): Promise<{ client: FoxgloveClient; socket: MockWebSocket }> {
    const client = new FoxgloveClient(options);
    const promise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertise',
        channels: [
          {
            id: 7,
            topic: HEARTBEAT,
            encoding: channel.encoding ?? 'cdr',
            schemaName: channel.schemaName,
            schema: channel.schema,
          },
        ],
      }),
    );
    await promise;
    return { client, socket };
  }

  /** The id the client picked for its subscription, read off its subscribe op. */
  function subscriptionId(socket: MockWebSocket): number {
    const op = socket.sentJson.find((m) => m.op === 'subscribe');
    if (!op) throw new Error('client sent no subscribe op');
    const id = (op.subscriptions as Array<{ id: number }>)[0]?.id;
    if (id === undefined) throw new Error('subscribe op carried no subscription');
    return id;
  }

  /** The payload of the one message the subscription delivered. */
  function onlyMessage(received: RosMessage[]): RosMessage['data'] {
    expect(received).toHaveLength(1);
    const first = received[0];
    if (!first) throw new Error('no message was delivered');
    return first.data;
  }

  /** Subscribe, deliver one payload, hand back what the callback saw. */
  async function deliverOne(
    channel: { schemaName: string; schema: string; encoding?: string },
    payload: Uint8Array,
    options?: ConstructorParameters<typeof FoxgloveClient>[0],
  ): Promise<RosMessage['data']> {
    const { client, socket } = await connectAdvertising(channel, options);
    const received: RosMessage[] = [];
    client.subscribe(HEARTBEAT, (m) => received.push(m));
    socket.simulateMessage(foxgloveMessageDataFrame(subscriptionId(socket), 0n, payload));
    return onlyMessage(received);
  }

  it('delivers the empty object for the payload a real bridge sends', async () => {
    // The regression in one line: these are the bytes that arrive from a
    // robot, and rc.1 handed them to the consumer undecoded.
    const data = await deliverOne(
      { schemaName: 'std_msgs/msg/Empty', schema: '' },
      MEASURED_EMPTY_BYTES,
    );
    expect(data).toEqual({});
  });

  it('delivers the empty object for the payload this library writes', async () => {
    // Kept deliberately alongside the capture: the send and receive sides of
    // the same type differ on the wire, and both must decode.
    const data = await deliverOne(
      { schemaName: 'std_msgs/msg/Empty', schema: '' },
      WRITTEN_EMPTY_BYTES,
    );
    expect(data).toEqual({});
  });

  it('reads both spellings of "no fields" the same way, at the measured length', async () => {
    // A server can describe a fieldless type with an empty string or with
    // whitespace. Before ADR 0010 these took different code paths and gave
    // different answers for these exact bytes: the empty string yielded raw
    // bytes, the whitespace yielded {}. The old suite asserted they agreed but
    // only ever checked the one length at which they did.
    const fromEmpty = await deliverOne(
      { schemaName: 'std_msgs/msg/Empty', schema: '' },
      MEASURED_EMPTY_BYTES,
    );
    ws.restore();
    ws = installMockWebSocket();
    const fromWhitespace = await deliverOne(
      { schemaName: 'std_msgs/msg/Empty', schema: '\n  \n' },
      MEASURED_EMPTY_BYTES,
    );
    expect(fromEmpty).toEqual({});
    expect(fromWhitespace).toEqual(fromEmpty);
  });

  it('hands back raw bytes when the payload carries data a fieldless type cannot hold', async () => {
    // The anti-masking guard, rebuilt on the payload's structure rather than
    // on its length. A server that advertises an empty schema for a type that
    // does have fields is not absorbed into a clean-looking empty object.
    const warn = vi.fn();
    const payload = new Uint8Array([0x00, 0x01, 0x00, 0x00, 1, 2, 3, 4, 5, 6]);
    const data = await deliverOne({ schemaName: 'sensor_msgs/msg/Image', schema: '' }, payload, {
      logger: { log: vi.fn(), warn, error: vi.fn() },
    });

    expect(data).toBeInstanceOf(Uint8Array);
    expect(Array.from(data as Uint8Array)).toEqual(Array.from(payload));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(HEARTBEAT);
    expect(String(warn.mock.calls[0]?.[0])).toContain('sensor_msgs/msg/Image');
  });

  it('warns once per channel, not once per message', async () => {
    const warn = vi.fn();
    const { client, socket } = await connectAdvertising(
      { schemaName: 'sensor_msgs/msg/Image', schema: '' },
      { logger: { log: vi.fn(), warn, error: vi.fn() } },
    );
    const received: RosMessage[] = [];
    // Uncapped, so every frame reaches the decode path rather than being
    // dropped by the throttle before it can warn.
    client.subscribe(HEARTBEAT, (m) => received.push(m), {
      maxFrequency: 0,
      disableAdaptive: true,
    });

    const payload = new Uint8Array([0x00, 0x01, 0x00, 0x00, 1, 2, 3, 4, 5, 6]);
    for (let i = 0; i < 5; i++) {
      socket.simulateMessage(foxgloveMessageDataFrame(subscriptionId(socket), 0n, payload));
    }

    expect(received).toHaveLength(5);
    expect(received.every((m) => m.data instanceof Uint8Array)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('still guards a trailing frame whose channel was unadvertised before the drain', async () => {
    // The guard asks whether *this reader* was invented from an empty
    // description, and that is recorded when the reader is built. Deriving it
    // from the channel map at decode time instead would answer "no" here,
    // because a latest-only drain can run after the channel is gone, and the
    // payload would be delivered as a clean empty object. Same staleness the
    // 0.1.9 stash-time labelling fix was written for.
    vi.useFakeTimers();
    const { client, socket } = await connectAdvertising({
      schemaName: 'sensor_msgs/msg/Image',
      schema: '',
    });
    const received: RosMessage[] = [];
    client.subscribe(HEARTBEAT, (m) => received.push(m), {
      dispatchMode: 'latest-only',
      maxFrequency: 10,
      disableAdaptive: true,
    });

    const payload = new Uint8Array(8).fill(0xb2);
    socket.simulateMessage(foxgloveMessageDataFrame(subscriptionId(socket), 0n, payload));
    vi.advanceTimersByTime(1);
    socket.simulateMessage(foxgloveMessageDataFrame(subscriptionId(socket), 0n, payload));
    socket.simulateMessage(JSON.stringify({ op: 'unadvertise', channelIds: [7] }));
    vi.advanceTimersByTime(200);

    expect(received).toHaveLength(2);
    expect(received[1]!.data).toBeInstanceOf(Uint8Array);
    vi.useRealTimers();
  });

  it('hands back raw bytes for the bare encapsulation header', async () => {
    // Four bytes is not a valid serialization of any ROS 2 type: rosidl gives
    // a fieldless struct one dummy member, and 0.1.10 measured a bridge
    // rejecting the bare header outright. No server has been observed sending
    // it, so it is not treated as a fieldless message on the way in either.
    const data = await deliverOne({ schemaName: 'std_msgs/msg/Empty', schema: '' }, BARE_HEADER);
    expect(data).toBeInstanceOf(Uint8Array);
  });

  it('hands back raw bytes when the server also lost the message encoding', async () => {
    // The shape of a definition-lookup failure on both first-party bridges:
    // `encoding` is assigned only on the success path, so it comes through
    // empty. An empty schema on its own proves nothing, and this channel is
    // undecodable rather than fieldless.
    const data = await deliverOne(
      { schemaName: 'geometry_msgs/msg/Twist', schema: '', encoding: '' },
      MEASURED_EMPTY_BYTES,
    );
    expect(data).toBeInstanceOf(Uint8Array);
  });

  it('leaves a channel with a real schema alone', async () => {
    const writer = new MessageWriter(parseRosMsgDef('uint8 data\n', { ros2: true }));
    const data = await deliverOne(
      { schemaName: 'std_msgs/msg/UInt8', schema: 'uint8 data\n' },
      writer.writeMessage({ data: 42 }),
    );

    // Same five bytes on the wire as a fieldless message, and it must still
    // decode through its own reader: the fieldless reading is only reached
    // when the channel described no fields.
    expect(data).toEqual({ data: 42 });
  });

  it('a JSON-encoded fieldless message is unaffected', async () => {
    const data = await deliverOne(
      { schemaName: 'std_msgs/msg/Empty', schema: '', encoding: 'json' },
      new TextEncoder().encode('{}'),
    );
    expect(data).toEqual({});
  });
});

describe('FoxgloveClient — a service whose response type has no fields', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  /**
   * The response-side twin of the request-side bug fixed in 0.1.10.
   * `std_srvs/srv/Empty` and every `.srv` whose response side is bare resolved
   * to `{ rawBytes }`, for the same reason a heartbeat delivered raw bytes.
   *
   * Marked as reasoned rather than captured: unlike the topic path above,
   * there is no wire capture of a fieldless service response. The condition is
   * the same one ADR 0010 decides, applied to a second call site.
   */
  async function callAdvertising(
    service: Record<string, unknown>,
    responsePayload: Uint8Array,
    options?: ConstructorParameters<typeof FoxgloveClient>[0],
  ): Promise<unknown> {
    const client = new FoxgloveClient(options);
    const connectPromise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [] }));
    socket.simulateMessage(JSON.stringify({ op: 'advertiseServices', services: [service] }));
    await connectPromise;

    const call = client.callService('/reset', {});
    const sent = findSentServiceCallRequest(socket);
    if (!sent) throw new Error('client sent no service call request');
    socket.simulateMessage(
      foxgloveServiceCallResponseFrame(
        service.id as number,
        sent.callId,
        'cdr',
        responsePayload,
      ),
    );
    return call;
  }

  it('resolves the empty object rather than raw bytes', async () => {
    const result = await callAdvertising(
      {
        id: 41,
        name: '/reset',
        type: 'std_srvs/srv/Empty',
        response: { encoding: 'cdr', schemaName: 'std_srvs/srv/Empty_Response', schema: '' },
      },
      MEASURED_EMPTY_BYTES,
    );
    expect(result).toEqual({});
  });

  it('still resolves raw bytes when the response carries unexplained data', async () => {
    const warn = vi.fn();
    const payload = new Uint8Array([0x00, 0x01, 0x00, 0x00, 9, 9, 9, 9, 9, 9]);
    const result = await callAdvertising(
      {
        id: 42,
        name: '/reset',
        type: 'std_srvs/srv/Empty',
        response: { encoding: 'cdr', schemaName: 'std_srvs/srv/Empty_Response', schema: '' },
      },
      payload,
      { logger: { log: vi.fn(), warn, error: vi.fn() } },
    );
    expect(result).toHaveProperty('rawBytes');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('still resolves raw bytes when the server described no response side at all', async () => {
    // "The server said nothing" is not "the server said empty". Only the
    // second is a claim this client acts on.
    const result = await callAdvertising(
      { id: 43, name: '/reset', type: 'some_pkg/srv/Unknown' },
      MEASURED_EMPTY_BYTES,
    );
    expect(result).toHaveProperty('rawBytes');
  });
});
