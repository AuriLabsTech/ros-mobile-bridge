// Minimal Node.js example for ros-mobile-bridge.
//
// Demonstrates that the published package imports cleanly, that the public
// API can be exercised, and that nothing in the library requires Node
// built-ins beyond what's globally available in Node 22+ (`WebSocket`,
// `TextEncoder`, `TextDecoder`, typed arrays).
//
// Set FOXGLOVE_HOST / FOXGLOVE_PORT to connect to a real bridge; otherwise
// the script verifies the API surface and exits cleanly.

import {
  ProtocolManager,
  DEFAULT_PORTS,
  FoxgloveClient,
  RosbridgeClient,
  getMaxLagMs,
} from 'ros-mobile-bridge';

console.log('ros-mobile-bridge example — node');
console.log('Default ports:', DEFAULT_PORTS);
console.log('FoxgloveClient is a function:', typeof FoxgloveClient === 'function');
console.log('RosbridgeClient is a function:', typeof RosbridgeClient === 'function');

const manager = new ProtocolManager();
manager.setClientOptions({
  logger: {
    log: (...args) => console.log('[lib]', ...args),
    warn: (...args) => console.warn('[lib]', ...args),
    error: (...args) => console.error('[lib]', ...args),
  },
});

console.log('Initial client (should be null):', manager.getClient());
console.log('Initial lag (should be 0):', getMaxLagMs());

const host = process.env.FOXGLOVE_HOST ?? '';
const port = process.env.FOXGLOVE_PORT ? Number(process.env.FOXGLOVE_PORT) : 0;

if (host && port > 0) {
  try {
    const client = await manager.connect({
      protocol: 'foxglove-ws',
      host,
      port,
    });
    console.log('Connected. Topics:', await client.getAvailableTopics());
    await manager.disconnect();
  } catch (err) {
    console.error('Connection failed:', err);
    process.exit(1);
  }
} else {
  console.log('FOXGLOVE_HOST not set — skipping live connect.');
  console.log('Set FOXGLOVE_HOST and FOXGLOVE_PORT to connect to a running bridge.');
}

console.log('Example complete.');
