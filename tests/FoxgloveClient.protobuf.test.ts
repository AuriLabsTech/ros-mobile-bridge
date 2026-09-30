// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * Decoding Foxglove channels advertised as `protobuf`.
 *
 * A protobuf channel carries its schema as a base64 `FileDescriptorSet`, and
 * the client decodes each message from it with no generated code. What it
 * delivers is the schema's own shape: field names exactly as the `.proto`
 * declares them (`frame_id`, never `frameId`), and values in the types
 * protobuf gives them (64-bit integers as `bigint`, `bytes` as `Uint8Array`, a
 * `google.protobuf.Timestamp` as `{ seconds, nanos }`).
 *
 * Payloads here are hand-encoded from the protobuf wire format, not produced
 * by the runtime the client decodes with, so a test cannot agree with the
 * decoder by construction. Field numbers come from the captured descriptors
 * (see `tests/fixtures/README.md`): `foxglove.CompressedImage` is
 * `timestamp=1 data=2 format=3 frame_id=4`.
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
import { CAPTURED_PROTOBUF_CHANNELS, capturedProtobufChannel } from './fixtures';
import {
  file_google_protobuf_struct,
  file_google_protobuf_timestamp,
  file_google_protobuf_wrappers,
} from '@bufbuild/protobuf/wkt';
import { descriptorSetBase64, T, L } from './_helpers/protobufDescriptor';

const COMPRESSED_IMAGE = capturedProtobufChannel('foxglove.CompressedImage');
const RAW_IMAGE = capturedProtobufChannel('foxglove.RawImage');
const JOINT_STATE = capturedProtobufChannel('foxglove.JointState');

const ascii = (s: string): number[] => Array.from(new TextEncoder().encode(s));

/** `foxglove.CompressedImage`, every field set, in field-number order. */
// prettier-ignore
const COMPRESSED_IMAGE_PAYLOAD = new Uint8Array([
  // 1 timestamp: { seconds: 5, nanos: 7 }
  0x0a, 0x04, 0x08, 0x05, 0x10, 0x07,
  // 2 data
  0x12, 0x03, 0x01, 0x02, 0x03,
  // 3 format
  0x1a, 0x04, ...ascii('jpeg'),
  // 4 frame_id
  0x22, 0x03, ...ascii('cam'),
]);

/**
 * `foxglove.RawImage` (`timestamp=1 width=2 height=3 encoding=4 step=5 data=6
 * frame_id=7`, the three sizes `fixed32`), with `timestamp` left unset: an unset sub-message is absent,
 * where unset scalars would still carry their defaults.
 */
// prettier-ignore
const RAW_IMAGE_PAYLOAD = new Uint8Array([
  // 2 width: 2 (fixed32, little-endian)
  0x15, 0x02, 0x00, 0x00, 0x00,
  // 3 height: 1 (fixed32)
  0x1d, 0x01, 0x00, 0x00, 0x00,
  // 4 encoding
  0x22, 0x04, ...ascii('mono'),
  // 5 step: 2 (fixed32)
  0x2d, 0x02, 0x00, 0x00, 0x00,
  // 6 data
  0x32, 0x02, 0xff, 0x00,
  // 7 frame_id
  0x3a, 0x01, ...ascii('f'),
]);

/**
 * A proto3 type exercising the shape rules the SDK's image types do not reach:
 *
 * ```proto
 * package demo;
 * enum Mode { MODE_UNSPECIFIED = 0; MODE_FAST = 2; }
 * message Inner { string name_tag = 1; }
 * message Sample {
 *   int64 big = 1;
 *   uint64 unsigned_big = 2;
 *   Mode mode = 3;
 *   repeated double values = 4;
 *   oneof choice { string label = 5; int32 code = 6; }
 *   Inner inner = 7;
 * }
 * ```
 */
const SAMPLE_CHANNEL = {
  topic: '/demo/sample',
  schemaName: 'demo.Sample',
  encoding: 'protobuf',
  schemaEncoding: 'protobuf',
  schema: descriptorSetBase64({
    name: 'demo/sample.proto',
    package: 'demo',
    syntax: 'proto3',
    enumType: [
      {
        name: 'Mode',
        value: [
          { name: 'MODE_UNSPECIFIED', number: 0 },
          { name: 'MODE_FAST', number: 2 },
        ],
      },
    ],
    messageType: [
      {
        name: 'Inner',
        field: [{ name: 'name_tag', number: 1, type: T.STRING, label: L.OPTIONAL }],
      },
      {
        name: 'Sample',
        oneofDecl: [{ name: 'choice' }],
        field: [
          { name: 'big', number: 1, type: T.INT64, label: L.OPTIONAL },
          { name: 'unsigned_big', number: 2, type: T.UINT64, label: L.OPTIONAL },
          { name: 'mode', number: 3, type: T.ENUM, typeName: '.demo.Mode', label: L.OPTIONAL },
          { name: 'values', number: 4, type: T.DOUBLE, label: L.REPEATED },
          { name: 'label', number: 5, type: T.STRING, label: L.OPTIONAL, oneofIndex: 0 },
          { name: 'code', number: 6, type: T.INT32, label: L.OPTIONAL, oneofIndex: 0 },
          { name: 'inner', number: 7, type: T.MESSAGE, typeName: '.demo.Inner', label: L.OPTIONAL },
        ],
      },
    ],
  }),
};

/** `demo.Sample` with `code` set in the oneof and `inner` left unset. */
// prettier-ignore
const SAMPLE_PAYLOAD = new Uint8Array([
  // 1 big: -3, a negative int64 is always a ten-byte varint
  0x08, 0xfd, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01,
  // 2 unsigned_big: 2^63, past what a JavaScript number holds exactly
  0x10, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01,
  // 3 mode: MODE_FAST
  0x18, 0x02,
  // 4 values: [1.5, -2], packed, two little-endian doubles
  0x22, 0x10,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf8, 0x3f,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0,
  // 6 code: 7
  0x30, 0x07,
]);

/**
 * Hypothetical proto3 type with map fields, keyed the ways a plain object
 * cannot hold natively:
 *
 * ```proto
 * message Maps {
 *   map<int64, Inner> by_id = 1;
 *   map<bool, string> flags = 2;
 *   map<string, int32> counts = 3;
 * }
 * ```
 */
const mapEntry = (name: string, key: object, value: object) => ({
  name,
  options: { mapEntry: true },
  field: [
    { name: 'key', number: 1, label: L.OPTIONAL, ...key },
    { name: 'value', number: 2, label: L.OPTIONAL, ...value },
  ],
});
const MAPS_CHANNEL = {
  topic: '/demo/maps',
  schemaName: 'demo.Maps',
  encoding: 'protobuf',
  schemaEncoding: 'protobuf',
  schema: descriptorSetBase64({
    name: 'demo/maps.proto',
    package: 'demo',
    syntax: 'proto3',
    messageType: [
      {
        name: 'Inner',
        field: [{ name: 'name_tag', number: 1, type: T.STRING, label: L.OPTIONAL }],
      },
      {
        name: 'Maps',
        nestedType: [
          mapEntry('ByIdEntry', { type: T.INT64 }, { type: T.MESSAGE, typeName: '.demo.Inner' }),
          mapEntry('FlagsEntry', { type: T.BOOL }, { type: T.STRING }),
          mapEntry('CountsEntry', { type: T.STRING }, { type: T.INT32 }),
        ],
        field: [
          {
            name: 'by_id',
            number: 1,
            label: L.REPEATED,
            type: T.MESSAGE,
            typeName: '.demo.Maps.ByIdEntry',
          },
          {
            name: 'flags',
            number: 2,
            label: L.REPEATED,
            type: T.MESSAGE,
            typeName: '.demo.Maps.FlagsEntry',
          },
          {
            name: 'counts',
            number: 3,
            label: L.REPEATED,
            type: T.MESSAGE,
            typeName: '.demo.Maps.CountsEntry',
          },
        ],
      },
    ],
  }),
};

/**
 * Hypothetical proto3 type with two traps for a JavaScript decoder: a field
 * whose name is `__proto__` (legal in protobuf, and silently dropped by a
 * plain `obj[name] = value`), and a 64-bit field carrying the JavaScript
 * code-generation hint `[jstype = JS_STRING]`.
 *
 * ```proto
 * message Traps {
 *   string __proto__ = 1;
 *   int64 wide = 2 [jstype = JS_STRING];
 * }
 * ```
 */
const TRAPS_CHANNEL = {
  topic: '/demo/traps',
  schemaName: 'demo.Traps',
  encoding: 'protobuf',
  schemaEncoding: 'protobuf',
  schema: descriptorSetBase64({
    name: 'demo/traps.proto',
    package: 'demo',
    syntax: 'proto3',
    messageType: [
      {
        name: 'Traps',
        field: [
          { name: '__proto__', number: 1, type: T.STRING, label: L.OPTIONAL },
          { name: 'wide', number: 2, type: T.INT64, label: L.OPTIONAL, options: { jstype: 1 } },
        ],
      },
    ],
  }),
};
// prettier-ignore
const TRAPS_PAYLOAD = new Uint8Array([
  // 1 __proto__: 'x'
  0x0a, 0x01, ...ascii('x'),
  // 2 wide: 300
  0x10, 0xac, 0x02,
]);

type Channel = {
  topic: string;
  schemaName: string;
  encoding: string;
  schemaEncoding?: string;
  schema: string;
};

describe('FoxgloveClient — protobuf channels', () => {
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

  /** Subscribe to `channel`, send one payload, return what arrived. */
  async function receiveOne(channel: Channel, payload: Uint8Array): Promise<RosMessage[]> {
    const { client, socket } = await connectAdvertising([channel]);
    const received: RosMessage[] = [];
    client.subscribe(channel.topic, (m) => received.push(m));
    socket.simulateMessage(foxgloveMessageDataFrame(lastSubscriptionId(socket), 0n, payload));
    return received;
  }

  it('decodes a captured SDK CompressedImage into the schema’s own field names and types', async () => {
    const received = await receiveOne(COMPRESSED_IMAGE, COMPRESSED_IMAGE_PAYLOAD);

    expect(received).toHaveLength(1);
    expect(received[0]?.encoding).toBe('protobuf');
    expect(received[0]?.data).toEqual({
      timestamp: { seconds: 5n, nanos: 7 },
      frame_id: 'cam',
      data: new Uint8Array([1, 2, 3]),
      format: 'jpeg',
    });
  });

  it('decodes a captured SDK RawImage, leaving the unset timestamp out', async () => {
    const received = await receiveOne(RAW_IMAGE, RAW_IMAGE_PAYLOAD);

    expect(received[0]?.data).toStrictEqual({
      width: 2,
      height: 1,
      encoding: 'mono',
      step: 2,
      data: new Uint8Array([0xff, 0x00]),
      frame_id: 'f',
    });
  });

  it('keeps 64-bit integers as bigint, enums as numbers, and a repeated field as an array', async () => {
    const received = await receiveOne(SAMPLE_CHANNEL, SAMPLE_PAYLOAD);
    const data = received[0]?.data as Record<string, unknown>;

    expect(data.big).toBe(-3n);
    expect(data.unsigned_big).toBe(9223372036854775808n);
    expect(data.mode).toBe(2);
    expect(data.values).toEqual([1.5, -2]);
  });

  it('shows only the oneof member that was set, under its own name, and leaves an unset message out', async () => {
    const received = await receiveOne(SAMPLE_CHANNEL, SAMPLE_PAYLOAD);
    const data = received[0]?.data as Record<string, unknown>;

    expect(data.code).toBe(7);
    expect(Object.keys(data).sort()).toEqual(['big', 'code', 'mode', 'unsigned_big', 'values']);
  });

  it('decodes with the new descriptor when a channel id is re-advertised with a different type', async () => {
    const { client, socket } = await connectAdvertising([
      { ...SAMPLE_CHANNEL, topic: '/demo/reused' },
    ]);
    const received: RosMessage[] = [];
    client.subscribe('/demo/reused', (m) => received.push(m));

    socket.simulateMessage(JSON.stringify({ op: 'unadvertise', channelIds: [10] }));
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertise',
        channels: [{ ...COMPRESSED_IMAGE, id: 10, topic: '/demo/reused' }],
      }),
    );
    socket.simulateMessage(
      foxgloveMessageDataFrame(lastSubscriptionId(socket), 0n, COMPRESSED_IMAGE_PAYLOAD),
    );

    expect(received).toHaveLength(1);
    expect(received[0]?.schemaName).toBe('foxglove.CompressedImage');
    expect(received[0]?.data).toEqual({
      timestamp: { seconds: 5n, nanos: 7 },
      frame_id: 'cam',
      data: new Uint8Array([1, 2, 3]),
      format: 'jpeg',
    });
  });

  it('builds a schema template with the decoded names and JSON-safe defaults, as CDR templates do', async () => {
    const { client } = await connectAdvertising([COMPRESSED_IMAGE, SAMPLE_CHANNEL]);

    expect(client.getSchemaTemplate('foxglove.CompressedImage')).toEqual({
      timestamp: { seconds: 0, nanos: 0 },
      frame_id: '',
      data: [],
      format: '',
    });
    // Every oneof member is listed: a template shows what a message can carry.
    expect(client.getSchemaTemplate('demo.Sample')).toEqual({
      big: 0,
      unsigned_big: 0,
      mode: 0,
      values: [],
      label: '',
      code: 0,
      inner: { name_tag: '' },
    });
  });

  it('leaves an unset explicit-presence field out, and keeps one set to zero', async () => {
    // `foxglove.JointState`: `name=1` plain, `position=2 velocity=3
    // acceleration=4 effort=5` all proto3 `optional` doubles. The SDK leaves
    // out a value the robot did not report, and writes eight zero bytes for a
    // position that is really 0.0.
    // prettier-ignore
    const payload = new Uint8Array([
      // 1 name
      0x0a, 0x01, ...ascii('j'),
      // 2 position: 0.0, explicitly
      0x11, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    const received = await receiveOne(JOINT_STATE, payload);

    expect(received[0]?.data).toStrictEqual({ name: 'j', position: 0 });
  });

  it('decodes a zero-length payload on every descriptor the SDK ships, with no warning', async () => {
    // An all-default proto3 message encodes to zero bytes, and the SDK sends
    // it that way. It is a message, not a failure to decode one.
    const sdkChannels = CAPTURED_PROTOBUF_CHANNELS.filter((c) => c.topic.startsWith('/fixture/'));
    expect(sdkChannels).toHaveLength(48);
    const { client, socket, warn } = await connectAdvertising(sdkChannels);
    const received = new Map<string, RosMessage>();
    for (const channel of sdkChannels) {
      client.subscribe(channel.topic, (m) => received.set(channel.topic, m));
      socket.simulateMessage(
        foxgloveMessageDataFrame(lastSubscriptionId(socket), 0n, new Uint8Array(0)),
      );
      expect(client.getSchemaTemplate(channel.schemaName)).not.toBeNull();
    }

    expect(received.size).toBe(48);
    for (const [topic, m] of received) {
      expect(m.data, topic).not.toBeInstanceOf(Uint8Array);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('delivers an all-default message with plain defaults and no unset sub-message', async () => {
    const received = await receiveOne(COMPRESSED_IMAGE, new Uint8Array(0));

    expect(received[0]?.data).toStrictEqual({
      frame_id: '',
      data: new Uint8Array(0),
      format: '',
    });
  });

  it('tells an empty sub-message on the wire from an absent one', async () => {
    // `0a 00`: field 1, a timestamp of length zero, so present with defaults.
    const received = await receiveOne(COMPRESSED_IMAGE, new Uint8Array([0x0a, 0x00]));

    expect((received[0]?.data as Record<string, unknown>).timestamp).toStrictEqual({
      seconds: 0n,
      nanos: 0,
    });
  });

  it('delivers maps as plain objects with string keys, and an omitted map as {}', async () => {
    // prettier-ignore
    const payload = new Uint8Array([
      // 1 by_id entry (16 bytes): key -9 as a ten-byte varint, value Inner { name_tag: 'a' }
      0x0a, 0x10,
      0x08, 0xf7, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01,
      0x12, 0x03, 0x0a, 0x01, ...ascii('a'),
      // 2 flags entry (6 bytes): key true, value 'on'
      0x12, 0x06, 0x08, 0x01, 0x12, 0x02, ...ascii('on'),
    ]);
    const received = await receiveOne(MAPS_CHANNEL, payload);

    expect(received[0]?.data).toStrictEqual({
      by_id: { '-9': { name_tag: 'a' } },
      flags: { true: 'on' },
      counts: {},
    });
  });

  it('keeps a field named __proto__ as an ordinary key', async () => {
    const received = await receiveOne(TRAPS_CHANNEL, TRAPS_PAYLOAD);
    const data = received[0]?.data as Record<string, unknown>;

    expect(Object.getOwnPropertyDescriptor(data, '__proto__')?.value).toBe('x');
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
  });

  it('keeps a 64-bit integer as bigint even under jstype = JS_STRING', async () => {
    const received = await receiveOne(TRAPS_CHANNEL, TRAPS_PAYLOAD);

    expect((received[0]?.data as Record<string, unknown>).wide).toBe(300n);
  });

  describe('shapes the runtime would otherwise change', () => {
    /**
     * Hypothetical proto3 type holding well-known types the runtime unboxes
     * when they are fields: `google.protobuf.Int64Value boxed = 1;
     * google.protobuf.Struct props = 2;`
     */
    const WKT_CHANNEL = {
      topic: '/demo/wkt',
      schemaName: 'demo.Wkt',
      encoding: 'protobuf',
      schemaEncoding: 'protobuf',
      schema: descriptorSetBase64(
        file_google_protobuf_wrappers.proto,
        file_google_protobuf_struct.proto,
        {
          name: 'demo/wkt.proto',
          package: 'demo',
          syntax: 'proto3',
          dependency: ['google/protobuf/wrappers.proto', 'google/protobuf/struct.proto'],
          messageType: [
            {
              name: 'Wkt',
              field: [
                {
                  name: 'boxed',
                  number: 1,
                  type: T.MESSAGE,
                  typeName: '.google.protobuf.Int64Value',
                  label: L.OPTIONAL,
                },
                {
                  name: 'props',
                  number: 2,
                  type: T.MESSAGE,
                  typeName: '.google.protobuf.Struct',
                  label: L.OPTIONAL,
                },
              ],
            },
          ],
        },
      ),
    };

    it('keeps wrapper and Struct fields in their message shape, in schema names', async () => {
      // prettier-ignore
      const payload = new Uint8Array([
        // 1 boxed: Int64Value { value (1): 7 }
        0x0a, 0x02, 0x08, 0x07,
        // 2 props: Struct { fields (1): entry { key 'n', value Value { number_value (2): 1.0 } } }
        0x12, 0x10,
        0x0a, 0x0e,
        0x0a, 0x01, ...ascii('n'),
        0x12, 0x09, 0x11, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f,
      ]);
      const received = await receiveOne(WKT_CHANNEL, payload);

      expect(received[0]?.data).toStrictEqual({
        boxed: { value: 7n },
        props: { fields: { n: { number_value: 1 } } },
      });
    });

    it('drops fields the descriptor does not declare', async () => {
      // Field 15 is not in CompressedImage: a sender with a newer schema.
      const payload = new Uint8Array([...COMPRESSED_IMAGE_PAYLOAD, 0x78, 0x01]);
      const received = await receiveOne(COMPRESSED_IMAGE, payload);

      expect(Object.keys(received[0]?.data as object).sort()).toEqual([
        'data',
        'format',
        'frame_id',
        'timestamp',
      ]);
    });

    it('leaves an unset proto2 field out even when it declares a default, and an unknown closed-enum value too', async () => {
      // Hypothetical proto2: `optional int32 level = 1 [default = 5];
      // optional Mode mode = 2;` with `enum Mode { A = 1; B = 2; }`.
      const channel = {
        topic: '/demo/p2',
        schemaName: 'demo.P2',
        encoding: 'protobuf',
        schemaEncoding: 'protobuf',
        schema: descriptorSetBase64({
          name: 'demo/p2.proto',
          package: 'demo',
          syntax: 'proto2',
          enumType: [
            {
              name: 'Mode',
              value: [
                { name: 'A', number: 1 },
                { name: 'B', number: 2 },
              ],
            },
          ],
          messageType: [
            {
              name: 'P2',
              field: [
                { name: 'level', number: 1, type: T.INT32, label: L.OPTIONAL, defaultValue: '5' },
                {
                  name: 'mode',
                  number: 2,
                  type: T.ENUM,
                  typeName: '.demo.Mode',
                  label: L.OPTIONAL,
                },
              ],
            },
          ],
        }),
      };
      // 2 mode: 9, a value the closed enum does not have
      const received = await receiveOne(channel, new Uint8Array([0x10, 0x09]));

      expect(received[0]?.data).toStrictEqual({});
    });

    it('delivers raw bytes with the warning when a proto3 string is not valid UTF-8', async () => {
      // 4 frame_id: 0xff 0xfe, which is not UTF-8
      const payload = new Uint8Array([0x22, 0x02, 0xff, 0xfe]);
      const { client, socket, warn } = await connectAdvertising([COMPRESSED_IMAGE]);
      const received: RosMessage[] = [];
      client.subscribe(COMPRESSED_IMAGE.topic, (m) => received.push(m));
      socket.simulateMessage(foxgloveMessageDataFrame(lastSubscriptionId(socket), 0n, payload));

      expect(received[0]?.data).toBeInstanceOf(Uint8Array);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('hands a bytes field over as a view of the received frame, not a copy', async () => {
      const { client, socket } = await connectAdvertising([COMPRESSED_IMAGE]);
      const received: RosMessage[] = [];
      client.subscribe(COMPRESSED_IMAGE.topic, (m) => received.push(m));
      const frame = foxgloveMessageDataFrame(
        lastSubscriptionId(socket),
        0n,
        COMPRESSED_IMAGE_PAYLOAD,
      );
      socket.simulateMessage(frame);

      const data = (received[0]?.data as Record<string, unknown>).data as Uint8Array;
      expect(Array.from(data)).toEqual([1, 2, 3]);
      expect(data.buffer).toBe(frame);
      expect(data.byteOffset).toBeGreaterThan(0);
    });

    it('lists explicit-presence fields in the schema template', async () => {
      const { client } = await connectAdvertising([JOINT_STATE]);

      expect(client.getSchemaTemplate('foxglove.JointState')).toEqual({
        name: '',
        position: 0,
        velocity: 0,
        acceleration: 0,
        effort: 0,
      });
    });
  });

  describe('finding the type in the descriptor', () => {
    /** `demo/uses.proto`: `message Uses { demo.Dep dep = 1; google.protobuf.Timestamp at = 2; }`. */
    const usesFile = (dependency: string[]) => ({
      name: 'demo/uses.proto',
      package: 'demo',
      syntax: 'proto3',
      dependency,
      messageType: [
        {
          name: 'Uses',
          field: [
            { name: 'dep', number: 1, type: T.MESSAGE, typeName: '.demo.Dep', label: L.OPTIONAL },
            {
              name: 'at',
              number: 2,
              type: T.MESSAGE,
              typeName: '.google.protobuf.Timestamp',
              label: L.OPTIONAL,
            },
          ],
        },
      ],
    });
    const depFile = {
      name: 'demo/dep.proto',
      package: 'demo',
      syntax: 'proto3',
      messageType: [
        { name: 'Dep', field: [{ name: 'n', number: 1, type: T.INT32, label: L.OPTIONAL }] },
      ],
    };
    const timestampFile = file_google_protobuf_timestamp.proto;
    const usesChannel = (schema: string) => ({
      topic: '/demo/uses',
      schemaName: 'demo.Uses',
      encoding: 'protobuf',
      schemaEncoding: 'protobuf',
      schema,
    });
    // 1 dep: { n: 4 }
    const USES_PAYLOAD = new Uint8Array([0x0a, 0x02, 0x08, 0x04]);

    it('resolves a schema name written with a leading dot', async () => {
      const received = await receiveOne(
        { ...COMPRESSED_IMAGE, schemaName: '.foxglove.CompressedImage' },
        COMPRESSED_IMAGE_PAYLOAD,
      );

      expect((received[0]?.data as Record<string, unknown>).frame_id).toBe('cam');
    });

    it('decodes when the set lists a file before the files it imports', async () => {
      const schema = descriptorSetBase64(
        usesFile(['demo/dep.proto', 'google/protobuf/timestamp.proto']),
        depFile,
        timestampFile,
      );
      const received = await receiveOne(usesChannel(schema), USES_PAYLOAD);

      expect(received[0]?.data).toStrictEqual({ dep: { n: 4 } });
    });

    it('delivers raw bytes and names the file when the set lacks an import, even a standard one', async () => {
      const schema = descriptorSetBase64(
        usesFile(['demo/dep.proto', 'google/protobuf/timestamp.proto']),
        depFile,
      );
      const { client, socket, warn } = await connectAdvertising([usesChannel(schema)]);
      const received: RosMessage[] = [];
      client.subscribe('/demo/uses', (m) => received.push(m));
      socket.simulateMessage(
        foxgloveMessageDataFrame(lastSubscriptionId(socket), 0n, USES_PAYLOAD),
      );

      expect(received[0]?.data).toBeInstanceOf(Uint8Array);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('google/protobuf/timestamp.proto');
    });
  });

  describe('when it cannot decode', () => {
    /** Field 1 claims a 16-byte sub-message; two bytes follow. */
    const TRUNCATED = new Uint8Array([0x0a, 0x10, 0x08, 0x05]);

    async function sendThree(channel: Channel, payload: Uint8Array) {
      const { client, socket, warn } = await connectAdvertising([channel]);
      const received: RosMessage[] = [];
      client.subscribe(channel.topic, (m) => received.push(m));
      const subId = lastSubscriptionId(socket);
      for (let i = 0; i < 3; i++) {
        socket.simulateMessage(foxgloveMessageDataFrame(subId, BigInt(i), payload));
      }
      const hits = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((w) => w.includes(channel.topic));
      return { received, hits };
    }

    // Back-to-back frames meet the default throttle, so not all three are
    // delivered; the warning count is the per-channel claim under test.
    function expectRawBytes(received: RosMessage[], payload: Uint8Array) {
      expect(received.length).toBeGreaterThan(0);
      for (const m of received) {
        expect(m.encoding).toBe('protobuf');
        expect(m.data).toBeInstanceOf(Uint8Array);
        expect(Array.from(m.data as Uint8Array)).toEqual(Array.from(payload));
      }
    }

    it('delivers raw bytes and warns once when the descriptor cannot be read', async () => {
      const { received, hits } = await sendThree(
        { ...COMPRESSED_IMAGE, schema: 'bm90IGEgZGVzY3JpcHRvcg==' },
        COMPRESSED_IMAGE_PAYLOAD,
      );

      expectRawBytes(received, COMPRESSED_IMAGE_PAYLOAD);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toContain('descriptor');
    });

    it('delivers raw bytes and warns once when the descriptor does not define the type', async () => {
      const { received, hits } = await sendThree(
        { ...COMPRESSED_IMAGE, schemaName: 'foxglove.NotInThisSet' },
        COMPRESSED_IMAGE_PAYLOAD,
      );

      expectRawBytes(received, COMPRESSED_IMAGE_PAYLOAD);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toContain('foxglove.NotInThisSet');
    });

    it('delivers raw bytes and warns once per channel when a payload does not decode', async () => {
      const { received, hits } = await sendThree(COMPRESSED_IMAGE, TRUNCATED);

      expectRawBytes(received, TRUNCATED);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toContain('foxglove.CompressedImage');
    });

    it('never claims the client does not decode protobuf', async () => {
      const { hits } = await sendThree(COMPRESSED_IMAGE, TRUNCATED);

      expect(hits[0]).not.toContain('does not decode');
    });
  });
});
