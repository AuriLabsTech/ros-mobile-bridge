import { afterEach, describe, expect, inject, it } from 'vitest';
import { FoxgloveClient } from '../../src/FoxgloveClient';
import type { RosMessage } from '../../src/types';
import { waitFor } from './helpers/wait';

/**
 * FoxgloveClient against a real Foxglove SDK server (`docker/sdk_server.py`),
 * which publishes the SDK's own channel classes. Those are protobuf, with the
 * schema advertised as a FileDescriptorSet, so this is the decode path end to
 * end against the descriptors and payloads such a server actually sends. The
 * values asserted are the fixed ones the server script logs. One more channel
 * is encoded ros1, which the client passes through as raw bytes.
 */
describe('FoxgloveClient against a Foxglove SDK server', () => {
  const clients: FoxgloveClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      await client.disconnect();
    }
  });

  async function firstMessage(topic: string): Promise<RosMessage> {
    const client = new FoxgloveClient();
    clients.push(client);
    await client.connect(inject('foxgloveSdkUrl'));
    // A subscribe that lands before the advertisement is pending and
    // activates on it, so no separate wait for the channel is needed.
    const received: RosMessage[] = [];
    client.subscribe(topic, (m) => received.push(m));
    await waitFor(() => received.length >= 1, 15_000, `delivery on ${topic}`);
    return received[0] as RosMessage;
  }

  it('decodes a CompressedImage with the schema’s own field names and types', async () => {
    const msg = await firstMessage('/sdk/image');

    expect(msg.encoding).toBe('protobuf');
    expect(msg.schemaName).toBe('foxglove.CompressedImage');
    expect(msg.data).toEqual({
      timestamp: { seconds: 1_700_000_000n, nanos: 250 },
      frame_id: 'sdk_camera',
      data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      format: 'jpeg',
    });
  });

  it('decodes a FrameTransform, nested messages included', async () => {
    const msg = await firstMessage('/sdk/tf');

    expect(msg.data).toEqual({
      timestamp: { seconds: 1_700_000_000n, nanos: 250 },
      parent_frame_id: 'world',
      child_frame_id: 'sdk_camera',
      translation: { x: 1, y: 2, z: 3 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    });
  });

  it('gives no template or definition for a ros1 channel it delivers as raw bytes', async () => {
    const client = new FoxgloveClient();
    clients.push(client);
    await client.connect(inject('foxgloveSdkUrl'));
    const received: RosMessage[] = [];
    client.subscribe('/sdk/ros1', (m) => received.push(m));
    await waitFor(() => received.length >= 1, 15_000, 'delivery on /sdk/ros1');

    expect(received[0]?.encoding).toBe('ros1');
    // The server's ROS 1 serialization of "hi": a uint32 length, then the bytes.
    expect(received[0]?.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(received[0]?.data as Uint8Array)).toEqual([2, 0, 0, 0, 0x68, 0x69]);
    expect(client.getSchemaTemplate('std_msgs/String')).toBeNull();
    expect(await client.getSchemaDefinition('std_msgs/String')).toBeNull();
  });
});
