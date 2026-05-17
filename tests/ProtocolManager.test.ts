import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProtocolManager } from '../src/ProtocolManager';
import { installMockWebSocket, type MockWebSocketHandle } from './_helpers/mock-websocket';

describe('ProtocolManager', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });

  afterEach(() => {
    ws.restore();
  });

  describe('URL construction and sanitization', () => {
    const cases: Array<{
      name: string;
      host: string;
      port: number;
      secure: boolean;
      expectedUrl: string;
    }> = [
      {
        name: 'plain host',
        host: 'robot.local',
        port: 8765,
        secure: false,
        expectedUrl: 'ws://robot.local:8765',
      },
      {
        name: 'secure host',
        host: 'robot.local',
        port: 8765,
        secure: true,
        expectedUrl: 'wss://robot.local:8765',
      },
      {
        name: 'strips ws:// prefix',
        host: 'ws://robot.local',
        port: 8765,
        secure: false,
        expectedUrl: 'ws://robot.local:8765',
      },
      {
        name: 'strips wss:// prefix',
        host: 'wss://robot.local',
        port: 8765,
        secure: false,
        expectedUrl: 'ws://robot.local:8765',
      },
      {
        name: 'strips http:// prefix',
        host: 'http://robot.local',
        port: 8765,
        secure: false,
        expectedUrl: 'ws://robot.local:8765',
      },
      {
        name: 'strips trailing :port (port field always wins)',
        host: 'robot.local:9999',
        port: 8765,
        secure: false,
        expectedUrl: 'ws://robot.local:8765',
      },
      {
        name: 'strips trailing path/query/fragment',
        host: 'robot.local/some/path?query#frag',
        port: 8765,
        secure: false,
        expectedUrl: 'ws://robot.local:8765',
      },
      {
        name: 'trims surrounding whitespace',
        host: '  robot.local  ',
        port: 8765,
        secure: false,
        expectedUrl: 'ws://robot.local:8765',
      },
      {
        name: 'combined: ws:// prefix + trailing port',
        host: 'ws://robot.local:8766',
        port: 8765,
        secure: false,
        expectedUrl: 'ws://robot.local:8765',
      },
    ];

    for (const c of cases) {
      it(`builds correct URL: ${c.name}`, () => {
        const manager = new ProtocolManager();
        // Fire-and-forget — connect() blocks on client.connect() awaiting
        // the WS handshake; we only need to verify URL construction, which
        // happens before that. The promise will eventually reject when the
        // test tears down the mock; we attach a catch to silence it.
        void manager
          .connect({
            protocol: 'foxglove-ws',
            host: c.host,
            port: c.port,
            secure: c.secure,
          })
          .catch(() => {
            /* expected — handshake never completes in this test */
          });

        const instances = ws.getInstances();
        expect(instances.length).toBe(1);
        const last = instances[0];
        expect(last).toBeDefined();
        expect(last?.url).toBe(c.expectedUrl);
      });
    }
  });

  it('throws "planned for v0.2.0" for protocol "zenoh"', async () => {
    const manager = new ProtocolManager();
    await expect(
      manager.connect({
        protocol: 'zenoh',
        host: 'robot.local',
        port: 7447,
        secure: false,
      }),
    ).rejects.toThrow(/Zenoh support is planned for v0\.2\.0/);
  });

  it('throws on a host that produces an invalid URL after sanitization', async () => {
    const manager = new ProtocolManager();
    // Empty host after stripping prefixes — should yield an invalid URL.
    await expect(
      manager.connect({
        protocol: 'foxglove-ws',
        host: 'ws://',
        port: 8765,
        secure: false,
      }),
    ).rejects.toThrow(/Invalid connection URL/);
  });

  it('uses DEFAULT_PORTS when port is 0', async () => {
    const manager = new ProtocolManager();
    void manager
      .connect({
        protocol: 'rosbridge',
        host: 'robot.local',
        port: 0,
        secure: false,
      })
      .catch(() => {
        /* expected */
      });

    const last = ws.last();
    expect(last.url).toBe('ws://robot.local:9090');
  });

  it('uses DEFAULT_PORTS when port is omitted', async () => {
    const manager = new ProtocolManager();
    void manager
      .connect({
        protocol: 'foxglove-ws',
        host: 'robot.local',
      })
      .catch(() => {
        /* expected */
      });

    const last = ws.last();
    expect(last.url).toBe('ws://robot.local:8765');
  });

  it('defaults to insecure ws:// when secure is omitted', async () => {
    const manager = new ProtocolManager();
    void manager
      .connect({
        protocol: 'foxglove-ws',
        host: 'robot.local',
        port: 8765,
      })
      .catch(() => {
        /* expected */
      });

    const last = ws.last();
    expect(last.url.startsWith('ws://')).toBe(true);
  });
});
