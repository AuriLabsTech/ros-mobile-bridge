/**
 * Control-outbox drain on teardown.
 *
 * `disconnect()` flushes the control-priority outbox before closing the
 * socket so an E-Stop (release-the-joystick zero Twist, action cancel)
 * reaches the robot instead of dying with the connection. That flush shares
 * the live path's per-tick batch cap, so a dashboard publishing to more
 * distinct control topics than the cap loses the overflow silently: the
 * re-armed `setTimeout(0)` lands after the socket has closed and the flush
 * clears the outbox unsent.
 *
 * These tests pin both halves of the fix: teardown drains everything,
 * the live path keeps its cap and keeps re-arming.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import { RosbridgeClient } from '../src/RosbridgeClient';
import {
  installMockWebSocket,
  type MockWebSocketHandle,
  type MockWebSocket,
} from './_helpers/mock-websocket';

const TWIST = 'geometry_msgs/msg/Twist';

/**
 * Five distinct control topics: the real trigger is a multi-widget
 * dashboard, where each teleop widget owns its own `cmd_vel`. Conflation
 * is per destination, so five topics mean five outbox entries — two more
 * than the batch cap.
 */
const TOPICS = [
  '/cmd_vel',
  '/robot2/cmd_vel',
  '/robot3/cmd_vel',
  '/robot4/cmd_vel',
  '/robot5/cmd_vel',
];

/** One macrotask yield: lets exactly one armed `setTimeout(0)` flush run. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('control outbox: teardown drain', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });

  afterEach(() => {
    ws.restore();
  });

  describe('FoxgloveClient', () => {
    async function connectedClient(): Promise<{
      client: FoxgloveClient;
      socket: MockWebSocket;
    }> {
      const client = new FoxgloveClient();
      const promise = client.connect('ws://localhost:8765');
      const socket = ws.last();
      socket.simulateOpen('foxglove.websocket.v1');
      socket.simulateMessage(
        JSON.stringify({
          op: 'serverInfo',
          name: 'test-server',
          capabilities: ['publish'],
        }),
      );
      socket.simulateMessage(
        JSON.stringify({
          op: 'advertise',
          channels: [
            {
              id: 1,
              topic: '/chatter',
              encoding: 'json',
              schemaName: 'std_msgs/msg/String',
              schema: '',
            },
          ],
        }),
      );
      await promise;
      return { client, socket };
    }

    /** Topic → client channel id, read off the advertise ops the client sent. */
    function channelIds(socket: MockWebSocket): Map<number, string> {
      const byId = new Map<number, string>();
      for (const msg of socket.sentJson) {
        if (msg.op !== 'advertise') continue;
        const channels = msg.channels as Array<{ id: number; topic: string }>;
        for (const ch of channels) byId.set(ch.id, ch.topic);
      }
      return byId;
    }

    /** Topics of every client → server MESSAGE_DATA frame (binary op 0x01). */
    function publishedTopics(socket: MockWebSocket): string[] {
      const byId = channelIds(socket);
      const topics: string[] = [];
      for (const buf of socket.sentBinary) {
        const view = new DataView(buf);
        if (view.getUint8(0) !== 0x01) continue;
        const topic = byId.get(view.getUint32(1, true));
        if (topic) topics.push(topic);
      }
      return topics;
    }

    /**
     * Pre-advertise so each publish lands in the control outbox. The very
     * first publish to an unadvertised topic takes the delayed-first-message
     * path instead, which never touches the outbox.
     */
    function armControlPublishes(client: FoxgloveClient): void {
      for (const topic of TOPICS) client.ensureAdvertised(topic, TWIST);
      for (const topic of TOPICS) {
        client.publish(topic, TWIST, { linear: { x: 0.5 } }, { priority: 'control' });
      }
    }

    it('disconnect() drains every pending control publish, not just one batch', async () => {
      const { client, socket } = await connectedClient();
      armControlPublishes(client);

      // No yield: the outbox flush is still an unfired macrotask, exactly as
      // it is when a user hits E-Stop mid-tick.
      await client.disconnect();

      expect(new Set(publishedTopics(socket))).toEqual(new Set(TOPICS));
    });

    it('the live path still caps each tick at the batch size and re-arms for the rest', async () => {
      const { client, socket } = await connectedClient();
      armControlPublishes(client);

      await tick();
      expect(publishedTopics(socket)).toHaveLength(3);

      await tick();
      expect(new Set(publishedTopics(socket))).toEqual(new Set(TOPICS));
    });
  });

  describe('RosbridgeClient', () => {
    async function connectedClient(): Promise<{
      client: RosbridgeClient;
      socket: MockWebSocket;
    }> {
      const client = new RosbridgeClient();
      const promise = client.connect('ws://localhost:9090');
      const socket = ws.last();
      socket.simulateOpen();
      await promise;
      return { client, socket };
    }

    function publishedTopics(socket: MockWebSocket): string[] {
      return socket.sentJson
        .filter((m) => m.op === 'publish')
        .map((m) => m.topic as string);
    }

    function armControlPublishes(client: RosbridgeClient): void {
      for (const topic of TOPICS) {
        client.publish(topic, TWIST, { linear: { x: 0.5 } }, { priority: 'control' });
      }
    }

    it('disconnect() drains every pending control publish, not just one batch', async () => {
      const { client, socket } = await connectedClient();
      armControlPublishes(client);

      await client.disconnect();

      expect(new Set(publishedTopics(socket))).toEqual(new Set(TOPICS));
    });

    it('the live path still caps each tick at the batch size and re-arms for the rest', async () => {
      const { client, socket } = await connectedClient();
      armControlPublishes(client);

      await tick();
      expect(publishedTopics(socket)).toHaveLength(3);

      await tick();
      expect(new Set(publishedTopics(socket))).toEqual(new Set(TOPICS));
    });
  });
});
