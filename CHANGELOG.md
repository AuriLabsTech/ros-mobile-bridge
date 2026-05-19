# Changelog

All notable changes to `ros-mobile-bridge` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

### Added

- Initial public release. `IProtocolClient` interface and two implementations: `FoxgloveClient` (Foxglove WebSocket v1, binary + JSON, CDR decoding) and `RosbridgeClient` (rosbridge v2 JSON over WebSocket, no `roslib` dependency).
- `ProtocolManager` factory with URL sanitization (strips `ws://`/`http://` prefixes, trailing `:port`, validates via `URL`).
- Per-subscription adaptive throttle driven by JS-thread lag (`SubscriptionBandwidth`), observable via `getSubscriptionStats`. The throttle curves themselves are overridable per-client via `ProtocolClientOptions.presetOverrides` — host applications shipping to a different device profile than the library's default tuning can supply their own bucket curves without forking. `BucketDef` and `ThrottleMode` are public types; `DEFAULT_PRESETS` is exported for consumers building extensions on top of the defaults.
- Per-subscription circuit breaker (`CircuitBreaker`) with exponential cooldown, manual retry, and disable. Observable via `getBreakerState`, `getBreakerNextRetryAt`, `onBreakerStateChange`.
- Control-priority publish outbox: `PublishOptions.priority: 'control'` for E-Stop, dead-man's-switch, and gesture-driven publishes that must not be starved by incoming-message parse work.
- `publishZeroTwist()` convenience for safety-critical disconnect / background paths.
- `ensureAdvertised(topic, schemaName)` to pre-advertise channels before time-critical first publish.
- Service discovery for both transports: `getAvailableServices`, `onServicesChange`.
- Schema templates: `getSchemaTemplate(schemaName)` derives default JSON from ros2idl, ros2msg, or JSON Schema declarations carried inline by Foxglove WS (returns `null` for rosbridge, which does not carry schemas inline).
- Diagnostics readers: `getMaxLagMs`, `getLagStats`, `getLagHistoryCsv`, `clearLagHistory` for consumers building "currently throttled" badges and bug-report exports.
- `DEFAULT_PORTS` constant: `{ 'foxglove-ws': 8765, rosbridge: 9090, zenoh: 7447 }`.
- Apache 2.0 license, security disclosure process, and contribution guidelines.

### Roadmap (not in this release)

- `ZenohClient` ships as an unimplemented skeleton (every method throws). `ProtocolManager.connect` throws a clear "Zenoh support is planned for v0.2.0" error for `protocol: 'zenoh'`. The class is not exported from `index.ts` in v0.1.0.

[0.1.0]: https://github.com/AuriLabsTech/ros-mobile-bridge/releases/tag/v0.1.0
