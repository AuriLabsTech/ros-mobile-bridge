// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * `disconnect()` sends no stop of its own.
 *
 * Up to 0.1.15 the library published a zero Twist to the literal topic
 * `/cmd_vel` on the way out of a session, armed by a Twist published on any
 * topic. Which topics carry motion and when a stop is due are the app's
 * decision, so the stop was removed in 0.1.16. What stays is the mechanism the
 * app's own stop rides on: a publish at `priority: 'control'` sits in the
 * control outbox, and `disconnect()` drains that outbox before the socket
 * closes.
 *
 * The mock socket ignores every send after `close()`, so a frame present in
 * `sentMessages` is a frame that went out before the close.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import { RosbridgeClient } from '../src/RosbridgeClient';
import {
  installMockWebSocket,
  withFakeTimers,
  type MockWebSocketHandle,
  type MockWebSocket,
} from './_helpers/mock-websocket';

const TWIST = 'geometry_msgs/msg/Twist';
const MOVE = { linear: { x: 0.5, y: 0, z: 0 }, angular: { x: 0, y: 0, z: 0.2 } };
const ZERO = { linear: { x: 0, y: 0, z: 0 }, angular: { x: 0, y: 0, z: 0 } };

/** Longer than the Foxglove first-publish hold and the rosbridge settle. */
const PAST_ALL_TIMERS_MS = 1000;

describe('disconnect() sends no stop of its own', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  describe('FoxgloveClient', () => {
    async function connected(): Promise<{ client: FoxgloveClient; socket: MockWebSocket }> {
      const client = new FoxgloveClient();
      const promise = client.connect('ws://localhost:8765');
      const socket = ws.last();
      socket.simulateOpen('foxglove.websocket.v1');
      socket.simulateMessage(
        JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: ['clientPublish'] }),
      );
      socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [] }));
      await promise;
      return { client, socket };
    }

    /** The JSON payloads of every MESSAGE_DATA frame the client sent on `channelId`. */
    function payloadsOn(socket: MockWebSocket, channelId: number): unknown[] {
      return socket.sentBinary
        .map((buf) => new DataView(buf))
        .filter((v) => v.getUint8(0) === 0x01 && v.getUint32(1, true) === channelId)
        .map((v) => JSON.parse(new TextDecoder().decode(new Uint8Array(v.buffer, 5))));
    }

    /** The client channel id the client advertised for `topic`. */
    function channelIdOf(socket: MockWebSocket, topic: string): number {
      const channel = socket.sentJson
        .filter((m) => m.op === 'advertise')
        .flatMap((m) => m.channels as Array<{ id: number; topic: string }>)
        .find((c) => c.topic === topic);
      if (!channel) throw new Error(`no advertise for ${topic}`);
      return channel.id;
    }

    it('after driving /cmd_vel, disconnect() sends nothing more on /cmd_vel', async () => {
      await withFakeTimers(async () => {
        const { client, socket } = await connected();
        client.ensureAdvertised('/cmd_vel', TWIST);
        client.publish('/cmd_vel', TWIST, MOVE);
        const id = channelIdOf(socket, '/cmd_vel');
        expect(payloadsOn(socket, id)).toEqual([MOVE]);

        const teardown = client.disconnect();
        await vi.advanceTimersByTimeAsync(PAST_ALL_TIMERS_MS);
        await teardown;

        expect(payloadsOn(socket, id)).toEqual([MOVE]);
      });
    });

    it("a consumer's control-priority zero published just before disconnect() reaches the wire", async () => {
      const { client, socket } = await connected();
      client.ensureAdvertised('/robot1/cmd_vel', TWIST);
      client.publish('/robot1/cmd_vel', TWIST, MOVE);
      client.publish('/robot1/cmd_vel', TWIST, ZERO, { priority: 'control' });

      await client.disconnect();

      expect(payloadsOn(socket, channelIdOf(socket, '/robot1/cmd_vel'))).toEqual([MOVE, ZERO]);
      expect(socket.readyState).toBe(3);
    });
  });

  describe('RosbridgeClient', () => {
    async function connected(): Promise<{ client: RosbridgeClient; socket: MockWebSocket }> {
      const client = new RosbridgeClient();
      const promise = client.connect('ws://localhost:9090');
      const socket = ws.last();
      socket.simulateOpen();
      await promise;
      return { client, socket };
    }

    function payloadsOn(socket: MockWebSocket, topic: string): unknown[] {
      return socket.sentJson
        .filter((m) => m.op === 'publish' && m.topic === topic)
        .map((m) => m.msg);
    }

    it('after driving /cmd_vel, disconnect() sends nothing more on /cmd_vel', async () => {
      await withFakeTimers(async () => {
        const { client, socket } = await connected();
        client.publish('/cmd_vel', TWIST, MOVE);
        expect(payloadsOn(socket, '/cmd_vel')).toEqual([MOVE]);

        const teardown = client.disconnect();
        await vi.advanceTimersByTimeAsync(PAST_ALL_TIMERS_MS);
        await teardown;

        expect(payloadsOn(socket, '/cmd_vel')).toEqual([MOVE]);
      });
    });

    it("a consumer's control-priority zero published just before disconnect() reaches the wire", async () => {
      await withFakeTimers(async () => {
        const { client, socket } = await connected();
        client.publish('/robot1/cmd_vel', TWIST, MOVE);
        client.publish('/robot1/cmd_vel', TWIST, ZERO, { priority: 'control' });

        const teardown = client.disconnect();
        await vi.advanceTimersByTimeAsync(PAST_ALL_TIMERS_MS);
        await teardown;

        expect(payloadsOn(socket, '/robot1/cmd_vel')).toEqual([MOVE, ZERO]);
        expect(socket.readyState).toBe(3);
      });
    });
  });
});
