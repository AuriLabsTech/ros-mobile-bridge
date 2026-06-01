# Changelog

All notable changes to `ros-mobile-bridge` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-06-01

### Performance

- **Zero-copy payload view on Foxglove WS binary topic ingest.** Previously every inbound `messageData` frame allocated a fresh `ArrayBuffer` (`ArrayBuffer.prototype.slice`) for the payload, costing roughly 10 MB/frame on raw 1080p image streams even on frames that the throttle subsequently dropped before parse. The library now uses a zero-copy `Uint8Array` view; downstream consumers (CDR reader, JSON decoder, byte-size accounting) see no behavior change. Verified end-to-end against a sustained 138 MB/s harness: `max` lag dropped from 96 ms to 29 ms (3.4× tail reduction), `mean` and `p50` unchanged.

### Changed

- **Control-priority publishes now coalesce by destination.** When multiple `priority: 'control'` publishes for the same topic queue in the outbox during JS-thread saturation, only the latest drains rather than every queued tick in FIFO order. The release-the-joystick zero-Twist that follows N stale-value Twists on `/cmd_vel` now sends in one WebSocket frame, so the robot stops within one round-trip of release regardless of how deep the queue grew during the block. Insertion order across **distinct** topics is preserved (intra-topic conflation only). Reduced the worst-case stop latency by orders of magnitude under sustained-overload scenarios.
- **Tightened CircuitBreaker defaults for CDR-realistic workloads.** The breaker's `lagThresholdMs` (`250 → 150`), `tripDwellMs` (`5000 → 2000`), and the internal `WARMUP_MS` grace period (`2000 → 500`) were originally tuned against JSON-sim spike patterns (transient 100–333 ms spikes interleaved with healthy stretches). CDR sensor streams on real hardware fail in a different regime — sustained multi-second freezes during the cold-start window — which warrants faster detection. Total subscribe-to-unsubscribe floor on a genuinely saturating topic drops from approximately 7 s to approximately 2.5 s, comfortably below the threshold at which a user perceives the app as frozen.

### Documented

- **Zero-copy contract on `RosMessage.data` when it is a `Uint8Array`.** The byte values delivered to a subscriber callback as `Uint8Array` are now views into the inbound WebSocket frame's `ArrayBuffer`, not copies. The view's `byteOffset` is significant. Consumers handing `data` directly to native bindings that ignore `byteOffset` (some Skia binding paths, some FFI calls) must first materialize an owned copy via `new Uint8Array(data)`. A `materializeBytes(view)` helper that performs this copy conditionally is planned for the next release; until then the explicit copy is the recommended idiom. TSDoc on `RosMessage` carries the full contract.

## [0.1.1] - 2026-05-27

### Fixed

- **`FoxgloveClient.callService` against `foxglove_bridge >= 3.2.6` (foxglove-sdk-cpp v0.18.0+) hung until timeout because the bridge rejects JSON-encoded service requests** even when it advertises `supportedEncodings: ["cdr", "json"]` — that capability applies to topic messages, not service calls. Service-call requests are now CDR-encoded using the per-service `requestSchema` shipped by the bridge in `advertiseServices`; the response is decoded with the corresponding `responseSchema`. The fix is backward-compatible with older bridges (CDR is the canonical ROS 2 service encoding and has always been accepted). Verified at the wire level against ROS Jazzy + `foxglove_bridge` 3.2.6.
- **`FoxgloveClient` now handles the `serviceCallFailure` op** alongside `serviceCallResponse`. Failures from the bridge (unknown service, malformed request, schema mismatch, unsupported encoding) reject the in-flight call promise immediately with the bridge's message instead of being silently dropped until the 30 s timeout.
- **`FoxgloveClient.callService` against schemaless service advertisements now works for empty requests.** `foxglove_bridge` 3.2.6+ commonly advertises services with their type name but without inline request-schema text — the normal shape for services discovered via ROS 2 graph introspection rather than explicit `.srv` files. The client now detects this case: if the caller's request is empty (`{}`, `null`, or `undefined`), it sends only the 4-byte CDR encapsulation header and the bridge default-constructs the request server-side from the known type. Non-empty requests against schemaless services still surface a clear error explaining the limitation (the encoder genuinely cannot serialize without field-layout information).
- **`FoxgloveClient.callService` now resolves request and response schemas through a layered fallback.** Order of resolution: (1) the bridge-advertised `requestSchema` / `responseSchema` (authoritative when present), (2) a bundled IDL for six well-known ROS 2 system services — `rcl_interfaces/srv/{ListParameters,GetParameters,SetParameters,DescribeParameters,GetParameterTypes}` and `action_msgs/srv/CancelGoal` — which `foxglove_bridge` 3.2.6+ commonly discovers via introspection without shipping schemas inline, (3) the 4-byte encapsulation-header fallback for empty requests when neither source has a schema. Parameter operations and action cancellation now work against any compliant bridge configuration, not only ones that ship `.srv`-derived schemas. When defs are available, an empty caller request `{}` is now filled with zero values via `schemaToTemplate` rather than rejected on missing fields, making `{}` a stable "default request" sentinel across sim and real-bridge setups.
- **`FoxgloveClient` now dispatches inbound binary opcode `0x03` SERVICE_CALL_RESPONSE frames.** Previous revisions consumed only the JSON-op response shape; `foxglove-sdk-cpp` 0.18.0+ defaults to the binary 0x03 frame for every service-call response, so pending callIds never resolved and surfaced as 30-second timeouts. The binary path and the legacy JSON-op path now route through a shared decoder; both CDR and JSON response payloads are handled.
- **`FoxgloveClient` now sends SERVICE_CALL_REQUEST as the spec-defined binary opcode `0x02` frame** instead of the JSON op of the same name. The JSON form is not in the Foxglove WS v1 spec and is rejected by current bridges with a level-2 status message, leaving callIds hanging until the 30-second timeout.
- **`FoxgloveClient` no longer emits the JSON `ping` keep-alive every 5 seconds.** The op is not in the Foxglove WS v1 spec; modern bridges emit a level-2 status in response to each one. WebSocket-level RFC 6455 ping/pong handles connection liveness at the transport layer and does not need application-level emulation. Existing `pong` responses from older bridges are ignored without error.
- **`FoxgloveClient` now fast-fails in-flight service calls when the bridge sends a level-2 status message naming `serviceCallRequest`.** These undirected status messages do not carry a callId, so prior versions had no way to associate them with the failing call and all in-flight callIds hung until their 30-second timeout. The substring match keeps the rejection scoped to service-call surfaces; unrelated level-2 messages do not tear down healthy calls.
- **`FoxgloveClient` outbound binary frames are now sent as `Uint8Array`, not raw `ArrayBuffer`.** React Native's WebSocket native bridge silently drops `send(ArrayBuffer)` payloads above roughly 400 bytes; this manifested as 16-name `get_parameters` requests never leaving the device (confirmed via tcpdump). Sending via `Uint8Array` uses a different RN native serializer that handles every payload size we send. Same bytes on the wire for browsers and Node; this is load-bearing for React Native consumers and is covered by a regression test.

### Changed

- **`ProtocolClientOptions.onLatency` is no longer driven by `FoxgloveClient`** as a consequence of removing the JSON `ping`/`pong` keep-alive (see Fixed). The option remains in the public type and is still driven by `RosbridgeClient` via its dedicated latency-probe path. Foxglove WS RTT measurement will return when a portable spec-compliant signal is available; browsers do not expose `ws.ping()` from JavaScript.

## [0.1.0] - 2026-05-20

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

[0.1.1]: https://github.com/AuriLabsTech/ros-mobile-bridge/releases/tag/v0.1.1
[0.1.0]: https://github.com/AuriLabsTech/ros-mobile-bridge/releases/tag/v0.1.0
