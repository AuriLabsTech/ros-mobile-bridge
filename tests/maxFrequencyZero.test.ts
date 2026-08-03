/**
 * `maxFrequency: 0` is documented on `SubscribeOptions` as the explicit
 * spelling of "no user cap", equivalent to omitting the field. These pins hold
 * both clients to that contract, and to the second half of it: `0` disables
 * only the user cap, so the adaptive throttle still applies its floor unless
 * `disableAdaptive` is also set.
 *
 * Scope is `0` only. Negative and `NaN` reach the same internal branch as an
 * implementation detail and are deliberately not part of the contract.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import { RosbridgeClient } from '../src/RosbridgeClient';
import type { RosMessage } from '../src/types';
import {
  installMockWebSocket,
  foxgloveMessageDataFrame,
  type MockWebSocketHandle,
} from './_helpers/mock-websocket';

const BURST = 5;

describe('maxFrequency: 0 — FoxgloveClient', () => {
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
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertise',
        channels: [
          { id: 5, topic: '/raw', encoding: 'cdr', schemaName: 'sensor_msgs/msg/Image', schema: '' },
        ],
      }),
    );
    await connectPromise;
    return { client, socket };
  }

  function burst(socket: ReturnType<MockWebSocketHandle['last']>, subId: number) {
    for (let i = 0; i < BURST; i++) {
      socket.simulateMessage(foxgloveMessageDataFrame(subId, 0n, new Uint8Array(8).fill(i)));
    }
  }

  it('with disableAdaptive, delivers every message', async () => {
    const { client, socket } = await connectRawTopic();

    const received: RosMessage[] = [];
    client.subscribe('/raw', (m) => received.push(m), {
      maxFrequency: 0,
      disableAdaptive: true,
    });

    burst(socket, 1);

    expect(received).toHaveLength(BURST);
  });

  it('is equivalent to omitting the field', async () => {
    const { client, socket } = await connectRawTopic();

    const withZero: RosMessage[] = [];
    const withOmitted: RosMessage[] = [];
    client.subscribe('/raw', (m) => withZero.push(m), {
      maxFrequency: 0,
      disableAdaptive: true,
    });
    client.subscribe('/raw', (m) => withOmitted.push(m), { disableAdaptive: true });

    burst(socket, 1);

    expect(withZero.length).toBe(withOmitted.length);
    expect(withZero).toHaveLength(BURST);
  });

  it('alone, still takes the adaptive floor', async () => {
    const { client, socket } = await connectRawTopic();

    const capped: RosMessage[] = [];
    const uncapped: RosMessage[] = [];
    client.subscribe('/raw', (m) => capped.push(m), { maxFrequency: 0 }); // adaptive on
    client.subscribe('/raw', (m) => uncapped.push(m), {
      maxFrequency: 0,
      disableAdaptive: true,
    });

    burst(socket, 1);

    // `0` waives the user cap only. The adaptive throttle boots with a
    // non-zero floor, so this subscriber sees strictly fewer messages.
    expect(capped.length).toBeGreaterThanOrEqual(1);
    expect(capped.length).toBeLessThan(uncapped.length);
  });
});

describe('maxFrequency: 0 — RosbridgeClient', () => {
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

  function burst(socket: ReturnType<MockWebSocketHandle['last']>) {
    for (let i = 0; i < BURST; i++) {
      socket.simulateMessage(JSON.stringify({ op: 'publish', topic: '/state', msg: { seq: i } }));
    }
  }

  it('with disableAdaptive, delivers every message', async () => {
    const { client, socket } = await connectedClient();

    const received: RosMessage[] = [];
    client.subscribe('/state', (m) => received.push(m), {
      maxFrequency: 0,
      disableAdaptive: true,
    });

    burst(socket);

    expect(received).toHaveLength(BURST);
  });

  it('is equivalent to omitting the field', async () => {
    const { client, socket } = await connectedClient();

    const withZero: RosMessage[] = [];
    const withOmitted: RosMessage[] = [];
    client.subscribe('/state', (m) => withZero.push(m), {
      maxFrequency: 0,
      disableAdaptive: true,
    });
    client.subscribe('/state', (m) => withOmitted.push(m), { disableAdaptive: true });

    burst(socket);

    expect(withZero.length).toBe(withOmitted.length);
    expect(withZero).toHaveLength(BURST);
  });

  it('alone, still takes the adaptive floor', async () => {
    const { client, socket } = await connectedClient();

    const capped: RosMessage[] = [];
    const uncapped: RosMessage[] = [];
    client.subscribe('/state', (m) => capped.push(m), { maxFrequency: 0 }); // adaptive on
    client.subscribe('/state', (m) => uncapped.push(m), {
      maxFrequency: 0,
      disableAdaptive: true,
    });

    burst(socket);

    expect(capped.length).toBeGreaterThanOrEqual(1);
    expect(capped.length).toBeLessThan(uncapped.length);
  });
});
