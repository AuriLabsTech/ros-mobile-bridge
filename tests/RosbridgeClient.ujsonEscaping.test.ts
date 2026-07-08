import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RosbridgeClient } from '../src/RosbridgeClient';
import type { RosMessage } from '../src/types';
import { installMockWebSocket, type MockWebSocketHandle } from './_helpers/mock-websocket';

/**
 * Regression: a stock ROS 2 `rosbridge_server` serializes outbound frames with
 * ujson, which escapes '/' as '\/'. Topics therefore arrive on the wire as
 * `"\/model\/pose"`. The receive fast-path must resolve the real topic so that
 * BOTH dispatch modes deliver. The original bug slice-matched the escaped
 * string against `activeSubscriptions`, missed, and dropped every inbound
 * publish before parse (immediate never reached `handlePublish`; latest-only,
 * which is served exclusively by the fast-path drain, was likewise starved).
 */
describe('RosbridgeClient — ujson escaped-slash topics (stock rosbridge_server)', () => {
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

  // Mimic ujson exactly: escape every forward slash, as a stock
  // rosbridge_server does on the wire.
  function ujsonFrame(topic: string, msg: Record<string, unknown>): string {
    return JSON.stringify({ op: 'publish', topic, msg }).replace(/\//g, '\\/');
  }

  it('delivers an escaped-slash publish to an immediate subscriber', async () => {
    const { client, socket } = await connectedClient();

    const received: RosMessage[] = [];
    client.subscribe('/model/pose', (m) => received.push(m)); // immediate (default)

    socket.simulateMessage(ujsonFrame('/model/pose', { seq: 7 }));

    expect(received).toHaveLength(1);
    expect(received[0]!.data).toEqual({ seq: 7 });
  });

  it('delivers an escaped-slash publish to a latest-only subscriber (served only by the fast-path drain)', async () => {
    const { client, socket } = await connectedClient();
    vi.useFakeTimers();

    const received: RosMessage[] = [];
    client.subscribe('/drone/front_camera/image/compressed', (m) => received.push(m), {
      dispatchMode: 'latest-only',
      disableAdaptive: true,
    });

    socket.simulateMessage(ujsonFrame('/drone/front_camera/image/compressed', { seq: 1 }));
    socket.simulateMessage(ujsonFrame('/drone/front_camera/image/compressed', { seq: 2 }));

    // Deferred off-tick; the drain conflates the burst to the newest frame.
    expect(received).toHaveLength(0);
    vi.runOnlyPendingTimers();

    expect(received).toHaveLength(1);
    expect(received[0]!.data).toEqual({ seq: 2 });
  });

  it('still delivers when the fast-path mis-identifies the topic (defers to the authoritative parse instead of dropping)', async () => {
    const { client, socket } = await connectedClient();

    const received: RosMessage[] = [];
    client.subscribe('/real', (m) => received.push(m)); // immediate

    // A decoy "topic" inside msg precedes the real envelope key, so the
    // pre-parse fast-path extracts "/decoy" and finds no subscription. It must
    // defer to the authoritative JSON.parse (which reads the real "/real"
    // topic) rather than silently drop a frame we are subscribed to.
    socket.simulateMessage('{"op":"publish","msg":{"topic":"/decoy","seq":9},"topic":"/real"}');

    expect(received).toHaveLength(1);
    expect(received[0]!.data).toEqual({ topic: '/decoy', seq: 9 });
  });
});
