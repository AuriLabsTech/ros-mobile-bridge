import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parse as parseRosMsgDef } from '@foxglove/rosmsg';
import { MessageReader, MessageWriter } from '@foxglove/rosmsg2-serialization';
import { FoxgloveClient } from '../src/FoxgloveClient';
import {
  installMockWebSocket,
  findSentServiceCallRequest,
  foxgloveServiceCallResponseFrame,
  type MockWebSocketHandle,
} from './_helpers/mock-websocket';

/**
 * A service whose request message has no fields — `std_srvs/srv/Trigger`,
 * `std_srvs/srv/Empty`, and every `.srv` written with a bare `---` — could not
 * be called at all up to 0.1.10.
 *
 * An empty ROS 2 message does not serialize to zero bytes. `rosidl` gives a
 * fieldless struct a single `uint8 structure_needs_at_least_one_member`,
 * because the C and C++ backends cannot represent a zero-size struct, so the
 * wire form is the 4-byte CDR_LE encapsulation header plus one zero byte. The
 * client sent the bare header, which is not a valid serialization of any ROS 2
 * type: `foxglove_bridge` failed to deserialize it and answered
 * `serviceCallFailure` with "Internal server error: Service failed to send a
 * response", so a client-side encoding bug read to the user as a fault in
 * their robot. Measured at the wire level on foxglove-sdk-cpp v0.25.1 / jazzy:
 * 4 bytes failed in 8 ms with no arrival logged by the service, 5 bytes
 * returned the real response.
 *
 * That shape is the ordinary one for a robot's button actions: dock, undock,
 * reset odometry, start mapping, clear costmaps.
 */

/** `std_srvs/srv/Trigger` response: the request side has no fields at all. */
const TRIGGER_RESPONSE_SCHEMA = ['bool success', 'string message', ''].join('\n');

/** What a fieldless request type encodes to, straight from the serializer. */
const EMPTY_MESSAGE_BYTES = new MessageWriter(parseRosMsgDef('', { ros2: true })).writeMessage({});

describe('FoxgloveClient callService with a fieldless request type', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });

  afterEach(() => {
    ws.restore();
  });

  async function connectAdvertising(
    services: Record<string, unknown>[],
  ): Promise<{ client: FoxgloveClient; socket: ReturnType<MockWebSocketHandle['last']> }> {
    const client = new FoxgloveClient();
    const connectPromise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [] }));
    socket.simulateMessage(JSON.stringify({ op: 'advertiseServices', services }));
    await connectPromise;
    return { client, socket };
  }

  it('is a serialization the reader for a fieldless type can read back', () => {
    // The contract in one line, independent of any client: five bytes, and the
    // fifth is rosidl's dummy member. Everything below is pinned against this
    // rather than against a literal, so the tests follow the serializer if the
    // representation ever changes.
    expect(Array.from(EMPTY_MESSAGE_BYTES)).toEqual([0x00, 0x01, 0x00, 0x00, 0x00]);

    const reader = new MessageReader(parseRosMsgDef('', { ros2: true }));
    expect(reader.readMessage(EMPTY_MESSAGE_BYTES)).toEqual({});
  });

  it('sends a valid empty message, not the bare encapsulation header', async () => {
    const { client, socket } = await connectAdvertising([
      { id: 11, name: '/clear_costmaps', type: 'std_srvs/srv/Trigger' },
    ]);

    const call = client.callService('/clear_costmaps', {});
    call.catch(() => {}); // only the wire side matters here

    const sent = findSentServiceCallRequest(socket);
    expect(sent).not.toBeNull();
    expect(sent!.encoding).toBe('cdr');
    expect(Array.from(sent!.payload)).toEqual(Array.from(EMPTY_MESSAGE_BYTES));

    // The regression itself: the payload the bridge rejected was one byte short.
    expect(sent!.payload.byteLength).toBe(5);
  });

  it('sends the same bytes whether the bridge advertises an empty schema or none', async () => {
    // A fieldless type has nothing to put in its schema text, and bridges
    // differ on whether they send an empty string or omit the field. Neither
    // shape carries field layout, and both describe the same wire form, so the
    // caller must not be able to tell them apart from the payload.
    const { client, socket } = await connectAdvertising([
      { id: 21, name: '/dock', type: 'std_srvs/srv/Trigger' },
      {
        id: 22,
        name: '/undock',
        type: 'std_srvs/srv/Trigger',
        request: { encoding: 'cdr', schemaName: 'std_srvs/srv/Trigger_Request', schema: '' },
      },
    ]);

    client.callService('/dock', {}).catch(() => {});
    client.callService('/undock', {}).catch(() => {});

    const frames = socket.sentBinary
      .map((b) => new Uint8Array(b))
      .filter((b) => b[0] === 0x02);
    expect(frames).toHaveLength(2);

    const payloads = frames.map((f) => Array.from(f.slice(f.byteLength - 5)));
    expect(payloads[0]).toEqual(Array.from(EMPTY_MESSAGE_BYTES));
    expect(payloads[1]).toEqual(payloads[0]);
  });

  it('resolves the decoded response, so the call completes end to end', async () => {
    // The half a wire assertion cannot prove: a button wired to a Trigger
    // service now gets its answer back, decoded, instead of a rejection
    // blaming the robot.
    const { client, socket } = await connectAdvertising([
      {
        id: 31,
        name: '/reset_odometry',
        type: 'std_srvs/srv/Trigger',
        response: {
          encoding: 'cdr',
          schemaName: 'std_srvs/srv/Trigger_Response',
          schemaEncoding: 'ros2msg',
          schema: TRIGGER_RESPONSE_SCHEMA,
        },
      },
    ]);

    const call = client.callService('/reset_odometry', {});
    const sent = findSentServiceCallRequest(socket)!;
    expect(Array.from(sent.payload)).toEqual(Array.from(EMPTY_MESSAGE_BYTES));

    const responseBytes = new MessageWriter(
      parseRosMsgDef(TRIGGER_RESPONSE_SCHEMA, { ros2: true }),
    ).writeMessage({ success: true, message: 'ok' });
    socket.simulateMessage(
      foxgloveServiceCallResponseFrame(31, sent.callId, 'cdr', responseBytes),
    );

    await expect(call).resolves.toEqual({ success: true, message: 'ok' });
  });

  it('still refuses a non-empty request against a schemaless service', async () => {
    // Unchanged by the fix, and deliberately so: without field layout there is
    // nothing to encode, and guessing would put silent garbage on the wire.
    const { client } = await connectAdvertising([
      { id: 41, name: '/set_mode', type: 'my_msgs/srv/SetMode' },
    ]);

    await expect(client.callService('/set_mode', { mode: 3 })).rejects.toThrow(
      /no usable request schema/,
    );
  });
});
