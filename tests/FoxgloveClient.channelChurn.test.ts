import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import {
  installMockWebSocket,
  foxgloveMessageDataFrame,
  withFakeTimers,
  type MockWebSocketHandle,
} from './_helpers/mock-websocket';

/**
 * An action-server restart makes `foxglove_bridge` unadvertise the action's
 * hidden channels and re-advertise them under NEW ids (measured on a live
 * bridge: 12/14 -> 16/17). A live subscription must survive that churn:
 * demoted to pending while the channel is gone, re-established when the
 * topic reappears, regardless of the id it comes back under.
 */
describe('FoxgloveClient subscription survival across channel churn', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });

  afterEach(() => {
    ws.restore();
  });

  async function connectedClient(): Promise<{
    client: FoxgloveClient;
    socket: ReturnType<MockWebSocketHandle['last']>;
  }> {
    const client = new FoxgloveClient();
    const connectPromise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertise',
        channels: [
          { id: 12, topic: '/dock/_action/status', encoding: 'json', schemaName: 'action_msgs/msg/GoalStatusArray', schema: '' },
        ],
      }),
    );
    await connectPromise;
    return { client, socket };
  }

  function subscribeOps(socket: ReturnType<MockWebSocketHandle['last']>): Array<{
    subscriptions: Array<{ id: number; channelId: number }>;
  }> {
    return socket.sentJson.filter((m) => m.op === 'subscribe') as Array<{
      subscriptions: Array<{ id: number; channelId: number }>;
    }>;
  }

  it('re-subscribes automatically when the channel is unadvertised and returns under a new id', async () => {
    const { client, socket } = await connectedClient();

    const received: unknown[] = [];
    client.subscribe('/dock/_action/status', (msg) => received.push(msg.data));

    expect(subscribeOps(socket).length).toBe(1);
    expect(subscribeOps(socket)[0]?.subscriptions[0]?.channelId).toBe(12);
    expect(client.getSubscriptionState('/dock/_action/status')).toBe('active');

    // Action server restarts: channel 12 goes away...
    socket.simulateMessage(JSON.stringify({ op: 'unadvertise', channelIds: [12] }));
    expect(client.getSubscriptionState('/dock/_action/status')).toBe('pending');

    // ...and the topic returns under a NEW id.
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertise',
        channels: [
          { id: 16, topic: '/dock/_action/status', encoding: 'json', schemaName: 'action_msgs/msg/GoalStatusArray', schema: '' },
        ],
      }),
    );

    const ops = subscribeOps(socket);
    expect(ops.length).toBe(2);
    const renewed = ops[1]?.subscriptions[0];
    expect(renewed?.channelId).toBe(16);
    expect(client.getSubscriptionState('/dock/_action/status')).toBe('active');

    // Messages on the new channel reach the original callback.
    const payload = new TextEncoder().encode(JSON.stringify({ status_list: [] }));
    socket.simulateMessage(foxgloveMessageDataFrame(renewed!.id, 0n, payload));
    expect(received).toEqual([{ status_list: [] }]);
  });

  it('an unsubscribe closure taken before the churn still detaches the callback afterwards', async () => {
    const { client, socket } = await connectedClient();

    const received: unknown[] = [];
    const unsub = client.subscribe('/dock/_action/status', (msg) => received.push(msg.data));

    socket.simulateMessage(JSON.stringify({ op: 'unadvertise', channelIds: [12] }));
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertise',
        channels: [
          { id: 16, topic: '/dock/_action/status', encoding: 'json', schemaName: 'action_msgs/msg/GoalStatusArray', schema: '' },
        ],
      }),
    );

    // The pre-churn closure must remove the callback from the re-established
    // subscription, not from a dead map.
    unsub();
    expect(client.getSubscriptionState('/dock/_action/status')).toBe('none');

    const renewed = subscribeOps(socket)[1]?.subscriptions[0];
    const payload = new TextEncoder().encode(JSON.stringify({ status_list: [] }));
    socket.simulateMessage(foxgloveMessageDataFrame(renewed!.id, 0n, payload));
    expect(received).toEqual([]);
  });

  it('unsubscribing during the churn window drops a trailing frame stashed before the unadvertise', async () => {
    await withFakeTimers(async () => {
      const { client, socket } = await connectedClient();

      const received: unknown[] = [];
      const unsub = client.subscribe('/dock/_action/status', (msg) => received.push(msg.data), {
        dispatchMode: 'latest-only',
        maxFrequency: 10, // 100 ms window
        disableAdaptive: true,
      });
      const subId = subscribeOps(socket)[0]!.subscriptions[0]!.id;

      const frame = (n: number): ArrayBuffer =>
        foxgloveMessageDataFrame(subId, 0n, new TextEncoder().encode(JSON.stringify({ n })));

      socket.simulateMessage(frame(1));
      vi.advanceTimersByTime(1);
      expect(received).toEqual([{ n: 1 }]);

      // Second frame lands inside the closed window: stashed, drain armed.
      socket.simulateMessage(frame(2));
      // The channel churns while the drain is armed...
      socket.simulateMessage(JSON.stringify({ op: 'unadvertise', channelIds: [12] }));
      // ...and the consumer unsubscribes before the window reopens. The
      // contract is no delivery after unsubscribe, so the stashed frame dies
      // with the subscription rather than firing from the demoted carrier.
      unsub();

      vi.advanceTimersByTime(500);
      expect(received).toEqual([{ n: 1 }]);
    });
  });
});
