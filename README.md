# ros-mobile-bridge

Protocol adapters for connecting JavaScript and TypeScript runtimes to ROS 2 robots. One `IProtocolClient` interface, two transports today (Foxglove WebSocket v1 and rosbridge v2), Zenoh on the [public roadmap](./ROADMAP.md). Runs in React Native, browsers, Node.js, and Electron from the same build.

- Apache 2.0 licensed.
- Zero React Native imports, zero Expo, zero Node-only globals. The package code uses only `WebSocket`, `TextEncoder`/`TextDecoder`, standard typed arrays, and standard timers.
- Foxglove WebSocket v1 with CDR binary decoding (ros2idl, ros2msg) and JSON.
- rosbridge v2 implemented directly over `WebSocket`, no `roslib` dependency.
- Adaptive throttle driven by JS-thread lag, per-subscription circuit breaker, control-priority publish outbox. Each one is observable through the public API, never hidden.
- 100% typed public surface. `IProtocolClient` is the contract; everything else is implementation detail.

## Install

```bash
npm install ros-mobile-bridge
```

Or with yarn / pnpm:

```bash
yarn add ros-mobile-bridge
pnpm add ros-mobile-bridge
```

Node.js consumers need a WebSocket polyfill (Node 22+ ships one natively, earlier versions need `ws` or similar). React Native and browsers have `WebSocket` globally.

## Quick start

```typescript
import { ProtocolManager } from 'ros-mobile-bridge';

const manager = new ProtocolManager();

const client = await manager.connect({
  protocol: 'foxglove-ws',
  host: 'robot.local',
});

const unsubscribe = client.subscribe('/odom', (msg) => {
  console.log(msg.topic, msg.data);
});

client.publish('/cmd_vel', 'geometry_msgs/msg/Twist', {
  linear: { x: 0.5, y: 0, z: 0 },
  angular: { x: 0, y: 0, z: 0 },
});

await manager.disconnect();
```

`port` defaults to the protocol's standard (`8765` for `foxglove-ws`, `9090` for `rosbridge`); `secure` defaults to `false`. Override either when you need to:

```typescript
const client = await manager.connect({
  protocol: 'rosbridge',
  host: 'robot.example.com',
  port: 443,
  secure: true,
});
```

## Concepts

### `IProtocolClient`

The single interface every transport implements. Methods are grouped into six concerns: lifecycle (`connect`, `disconnect`, `isConnected`), topic discovery (`getAvailableTopics`, `onTopicsChange`), subscribe and publish (`subscribe`, `publish`, `ensureAdvertised`, `unadvertise`, `publishZeroTwist`), reliability surfaces (the circuit breaker family and `getSubscriptionStats`), services (`callService`, `getAvailableServices`, `onServicesChange`), and schemas (`getSchemaTemplate`).

A consumer can write against `IProtocolClient` once and pick the transport at runtime.

### Control-priority publishes

`PublishOptions.priority: 'control'` routes a publish through a small outbox that drains at the top of every incoming WebSocket message handler. Designed for safety-critical messages (`/cmd_vel`, E-Stop, action cancel) that must not be starved by incoming-message parse work when the JS thread is loaded with camera frames. Defaults to `'data'`.

```typescript
client.publish('/cmd_vel', 'geometry_msgs/msg/Twist', zeroTwist, { priority: 'control' });
```

### Adaptive throttle and circuit breaker

Both reliability features are observable. Read the current throttle bucket per subscription:

```typescript
const stats = client.getSubscriptionStats('/camera/compressed');
if (stats && stats.adaptiveMinIntervalMs > 0) {
  console.log(`/camera is currently capped at ${stats.bucketLabel}`);
}
```

Watch breaker state changes:

```typescript
const unwatch = client.onBreakerStateChange('/camera/compressed', (state) => {
  if (state === 'tripped_auto') {
    showFallbackUi();
  }
});
```

Manual breaker controls (`breakerRetry`, `breakerDisable`) let consumers expose user-driven recovery in their UI.

### High-throughput subscriptions: `dispatchMode`

`SubscribeOptions.dispatchMode` controls how messages reach your callback when they arrive faster than you can use them. The default, `'immediate'`, parses and delivers every message that survives the throttle, synchronously on the message-handler tick. For a high-bandwidth topic where only the freshest message matters (a raw camera stream feeding a viewport), `'latest-only'` delivers just the newest message and drops the rest *before* they are parsed, so you decode only the frame you actually render:

```typescript
import { materializeBytes } from 'ros-mobile-bridge';

client.subscribe(
  '/camera/raw',
  (msg) => {
    if (msg.data instanceof Uint8Array) {
      // msg.data is a zero-copy view; copy it before retaining past the callback.
      render(materializeBytes(msg.data));
    }
  },
  { dispatchMode: 'latest-only' },
);
```

Delivery is deferred off the message-handler tick, and the conflation happens upstream of the decode, which a wrapper around `subscribe` cannot do because it only ever sees already-parsed messages. `'latest-only'` composes below the throttle: `maxFrequency` and the adaptive cap still decide which messages are eligible, then the newest of those is delivered. For lossless-but-deferred delivery, keep your own bounded queue in the callback (the `dispatchMode` TSDoc shows the pattern); the bound and drop policy are yours to set because they depend on the device.

### Host-app injection

Construct clients with `ProtocolClientOptions` to receive latency callbacks, route logs, and tell the throttle which mode the user picked:

```typescript
manager.setClientOptions({
  onLatency: (rttMs) => metrics.recordLatency(rttMs),
  logger: console,
  getThrottleMode: () => settings.throttleMode, // 'performance' | 'auto' | 'efficient'
});
```

These are optional. The library has sensible no-op defaults.

### Diagnostics

The event-loop lag monitor is the signal the adaptive throttle reads. Consumers can read it too, for diagnostics:

```typescript
import { getMaxLagMs, getLagStats, getLagHistoryCsv } from 'ros-mobile-bridge';

console.log(`current max JS-thread lag: ${getMaxLagMs()} ms`);
console.log(getLagStats()); // p50, p90, p99, count over ~2 min
console.log(getLagHistoryCsv()); // full history dump for bug reports
```

## Why implement the protocols directly?

`ros-mobile-bridge` speaks the Foxglove WebSocket v1 and rosbridge v2 protocols directly over the runtime's global `WebSocket`. It does not wrap `roslib` or the `@foxglove/ws-protocol` SDK.

The reason is the reliability layer. The adaptive throttle drops messages before they are parsed, the control-priority outbox flushes safety-critical publishes at the top of every incoming message handler, and the per-subscription circuit breaker responds to JS-thread saturation as it happens. All three need direct ownership of the WebSocket message loop. A client library that parses and dispatches messages for you sits in exactly the spot these features need to own. (`roslib` also pulls in Node-only dependencies that break under React Native.)

This is a narrow kind of "from scratch." The genuinely hard parts, CDR deserialization and ROS 2 schema parsing, still come from Foxglove's MIT libraries (`@foxglove/rosmsg2-serialization`, `@foxglove/ros2idl-parser`, `@foxglove/rosmsg`). The hand-written code is only the transport, framing, and dispatch layer the reliability features depend on, which also keeps the runtime dependency surface to three permissively licensed parsing packages.

Implementing the protocols directly means each transport supports a deliberate subset. Today that is publish/subscribe and service calls on both; ROS parameter access and connection-graph introspection are on the [roadmap](./ROADMAP.md).

## Supported runtimes

| Runtime | Status | Notes |
|---|---|---|
| React Native (Hermes) | Tested in production | Uses RN's `WebSocket` |
| Browsers (evergreen) | Tested | Uses native `WebSocket` |
| Node.js 22+ | Supported | Native `WebSocket` |
| Node.js 18–21 | Supported with polyfill | Set `globalThis.WebSocket` to a `ws`-compatible implementation |
| Electron (renderer) | Supported | Browser `WebSocket` |

## API stability

The package follows semver. Pre-1.0, breaking changes are restricted to minor version bumps (0.1.x → 0.2.0); after 1.0, only majors break. See `CHANGELOG.md` for migration notes.

## Documentation

- Type-level docs: every public symbol carries TSDoc, surfaced through your editor.
- Generated reference: `https://aurilabstech.github.io/ros-mobile-bridge/` (published from `main` on release).
- Examples: `examples/` in this repository.
- Roadmap: [`ROADMAP.md`](./ROADMAP.md) — current milestone, what `v0.2.0` and `v0.3.0` will deliver, and what is permanently out of scope.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). The short version: discuss non-trivial changes in an issue first, keep the API small, write tests, follow Conventional Commits.

## Security

See [SECURITY.md](./SECURITY.md) for the coordinated-disclosure process. Email `security@aurilabs.tech` for private reports.

## License

Apache 2.0. See [LICENSE](./LICENSE).

## Acknowledgements

This library was extracted from the protocol layer of [Tinca](https://aurilabs.tech/tinca), an iOS and Android ROS 2 teleoperation app, after the layer had stabilized against real hardware. Tinca remains the primary integration test and a reference implementation for a sophisticated mobile consumer of this library, but the library is independent and intended for any JavaScript or TypeScript consumer of ROS 2.

Created and maintained by Benjamín Arratia (Auri Labs).
