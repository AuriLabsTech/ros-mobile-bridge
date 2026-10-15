import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RosbridgeClient } from '../src/RosbridgeClient';
import type { RosMessage } from '../src/types';
import { installMockWebSocket, type MockWebSocketHandle } from './_helpers/mock-websocket';

/**
 * rosbridge_server cuts any outgoing frame longer than its `max_message_size`
 * (10 MB on the stock launch file, 1 MB on a plain `ros2 run`) into
 * `{"op":"fragment","id","data","num","total"}` frames, whether or not the
 * client asked. Every fragmented topic message carries id "0"; concurrent
 * service responses interleave fragment by fragment across their call ids.
 * The client must join the slices back into the original frame.
 */
// Gate nothing, so back-to-back messages are not thinned by the throttle.
const EVERY_MESSAGE = { maxFrequency: 0, disableAdaptive: true };

describe('RosbridgeClient: fragment reassembly', () => {
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

  /** Cut a frame the way rosbridge's `fragmentation.py` does. */
  function fragments(frame: string, id: string, total: number): string[] {
    const size = Math.ceil(frame.length / total);
    const out: string[] = [];
    for (let num = 0; num < total; num++) {
      const data = frame.slice(num * size, (num + 1) * size);
      out.push(JSON.stringify({ op: 'fragment', id, data, num, total }));
    }
    return out;
  }

  function publishFrame(topic: string, msg: Record<string, unknown>): string {
    return JSON.stringify({ op: 'publish', topic, msg });
  }

  function serviceId(socket: ReturnType<MockWebSocketHandle['last']>, service: string): string {
    const call = socket.sentJson.find((m) => m.op === 'call_service' && m.service === service);
    return (call as { id: string }).id;
  }

  it('delivers a topic message that arrives in fragments, once and whole', async () => {
    const { client, socket } = await connectedClient();
    const received: RosMessage[] = [];
    client.subscribe('/map', (m) => received.push(m), EVERY_MESSAGE);

    const msg = { info: { width: 3 }, data: Array.from({ length: 300 }, (_, i) => i % 100) };
    for (const f of fragments(publishFrame('/map', msg), '0', 3)) socket.simulateMessage(f);

    expect(received).toHaveLength(1);
    expect(received[0]!.data).toEqual(msg);
  });

  it('delivers two fragmented topic messages in a row, both under id "0"', async () => {
    const { client, socket } = await connectedClient();
    const received: RosMessage[] = [];
    client.subscribe('/map', (m) => received.push(m), EVERY_MESSAGE);

    for (const f of fragments(publishFrame('/map', { seq: 1, pad: 'a'.repeat(200) }), '0', 4)) {
      socket.simulateMessage(f);
    }
    for (const f of fragments(publishFrame('/map', { seq: 2, pad: 'b'.repeat(200) }), '0', 2)) {
      socket.simulateMessage(f);
    }

    expect(received.map((m) => (m.data as { seq: number }).seq)).toEqual([1, 2]);
  });

  it('resolves two service calls whose fragmented responses interleave', async () => {
    const { client, socket } = await connectedClient();
    const pa = client.callService('/a', {});
    const pb = client.callService('/b', {});
    const idA = serviceId(socket, '/a');
    const idB = serviceId(socket, '/b');

    const respA = JSON.stringify({
      op: 'service_response',
      id: idA,
      result: true,
      values: { v: 'A'.repeat(90) },
    });
    const respB = JSON.stringify({
      op: 'service_response',
      id: idB,
      result: true,
      values: { v: 'B'.repeat(90) },
    });
    const fa = fragments(respA, idA, 3);
    const fb = fragments(respB, idB, 3);
    for (const f of [fa[0], fb[0], fa[1], fb[1], fb[2], fa[2]]) socket.simulateMessage(f!);

    await expect(pa).resolves.toEqual({ v: 'A'.repeat(90) });
    await expect(pb).resolves.toEqual({ v: 'B'.repeat(90) });
  });

  it('drops a message that lost a fragment when the next one starts under the same id', async () => {
    const { client, socket } = await connectedClient();
    const received: RosMessage[] = [];
    client.subscribe('/map', (m) => received.push(m), EVERY_MESSAGE);

    const lost = fragments(publishFrame('/map', { seq: 1, pad: 'x'.repeat(200) }), '0', 3);
    socket.simulateMessage(lost[0]!);
    socket.simulateMessage(lost[1]!); // lost[2] never arrives (server write queue full)
    for (const f of fragments(publishFrame('/map', { seq: 2, pad: 'y'.repeat(200) }), '0', 3)) {
      socket.simulateMessage(f);
    }

    expect(received.map((m) => (m.data as { seq: number }).seq)).toEqual([2]);
  });

  it('drops a partial message that stays incomplete past the idle timeout', async () => {
    const { client, socket } = await connectedClient();
    vi.useFakeTimers();
    const received: RosMessage[] = [];
    client.subscribe('/map', (m) => received.push(m), EVERY_MESSAGE);

    const f = fragments(publishFrame('/map', { seq: 1, pad: 'x'.repeat(200) }), '0', 3);
    socket.simulateMessage(f[0]!);
    socket.simulateMessage(f[1]!);
    vi.advanceTimersByTime(60_000);
    socket.simulateMessage(f[2]!);

    expect(received).toHaveLength(0);
  });

  it('drops a partial message when total changes under the same id', async () => {
    const { client, socket } = await connectedClient();
    const received: RosMessage[] = [];
    client.subscribe('/map', (m) => received.push(m), EVERY_MESSAGE);

    const frame = publishFrame('/map', { seq: 1, pad: 'x'.repeat(200) });
    const three = fragments(frame, '0', 3);
    const two = fragments(frame, '0', 2);
    socket.simulateMessage(three[0]!);
    socket.simulateMessage(two[1]!);
    socket.simulateMessage(three[1]!);
    socket.simulateMessage(three[2]!);

    expect(received).toHaveLength(0);
  });

  it('forgets a partial message on disconnect', async () => {
    const { client, socket } = await connectedClient();
    const f = fragments(publishFrame('/map', { seq: 1, pad: 'x'.repeat(200) }), '0', 2);
    socket.simulateMessage(f[0]!);
    // The socket closing under the teardown fence ends the wait.
    const teardown = client.disconnect();
    socket.simulateClose();
    await teardown;

    const p = client.connect('ws://localhost:9090');
    const socket2 = ws.last();
    socket2.simulateOpen();
    await p;
    const received: RosMessage[] = [];
    client.subscribe('/map', (m) => received.push(m), EVERY_MESSAGE);
    socket2.simulateMessage(f[1]!);

    expect(received).toHaveLength(0);
  });

  it('ignores a malformed fragment frame without throwing', async () => {
    const { client, socket } = await connectedClient();
    const received: RosMessage[] = [];
    client.subscribe('/map', (m) => received.push(m), EVERY_MESSAGE);

    socket.simulateMessage(
      JSON.stringify({ op: 'fragment', id: '0', data: '{"op"', num: 5, total: 2 }),
    );
    socket.simulateMessage(JSON.stringify({ op: 'fragment', id: '0', num: 0, total: 2 }));
    for (const f of fragments(publishFrame('/map', { seq: 3 }), '0', 2)) socket.simulateMessage(f);

    expect(received.map((m) => (m.data as { seq: number }).seq)).toEqual([3]);
  });
});
