# Changelog

All notable changes to `ros-mobile-bridge` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.5] - 2026-07-08

### Added

- **`ProtocolMismatchError`: a typed error raised when a client is pointed at a server speaking the other protocol.** It carries `expectedProtocol` (the client's own transport) and `detectedProtocol` (`'foxglove-ws'` / `'rosbridge'` / `'zenoh'`, or `'unknown'` when only the negative is known), and ships a clear, ready-to-show `message`. It is surfaced on both transports. The Foxglove client rejects `connect()` with it when the WebSocket opens but no `serverInfo` handshake arrives. The rosbridge client, which resolves `connect()` at socket open, detects a Foxglove-only frame (`serverInfo`, or an `advertise` carrying a `channels` array) after connect, transitions status to `error`, and exposes the error through the new `getLastError()`. Detection on the rosbridge side is precise: a real rosbridge server never sends those frames.
- **`IProtocolClient.getLastError(): Error | null`** returns the most recent error that drove the connection into a failure, or `null`. Read it on a `status === 'error'` transition to recover the reason; it is the only channel for a protocol mismatch detected after `connect()` has already resolved. Cleared at the start of the next `connect()`.
- **`getSustainedLagMs(): number` is now a public diagnostics export.** It returns the sustained JS-thread lag (the 75th percentile of probe samples over the last 4 s), the *relax* input to the adaptive throttle, alongside the already-exported `getMaxLagMs()` (1 s max, the *tighten* input). Both are `() => number` readers over the shared event-loop monitor. Exposing it makes the throttle's two controller inputs symmetric on the public surface: a consumer recording why the cap moved can now log the relax signal, not only the tighten signal. No behavior change; the value was already computed and used internally.

### Changed

- **Adaptive throttle controller dynamics reworked so the cap settles instead of hunting and recovers instead of ratcheting down.** Tighten and relax now read different signals across a deadband. Tighten reacts immediately to the worst-case lag spike (the 1 s rolling max), as before. Relax steps back only when a sustained lag percentile (a new several-second reading) falls a deadband below the bucket's threshold, then jumps straight to the justified bucket rather than one step per dwell. Three consequences: jitter around a threshold no longer makes the cap oscillate (it holds inside the deadband); an isolated main-thread spike no longer resets recovery, so a stream of isolated GC or animation spikes can no longer ratchet the cap one-way; and time from the floor back to uncapped is bounded to about one relax window instead of one bucket per dwell. No public API change: the preset shape and values, the cap label, and the throttle observers (`getSubscriptionStats`) are unchanged. The lag signal remains global (one JS thread), which is intentional and load-bearing.

### Fixed

- **rosbridge now re-discovers topics on every reconnect and mid-session, matching Foxglove's push-driven freshness.** Previously the discovered-topic list was fetched once and never refreshed, so after an automatic reconnect to a host now serving a different robot (or after a topic was advertised mid-session) `getAvailableTopics()` and `onTopicsChange()` kept reporting the previous set. Re-discovery now runs on every (re)connect, with a bounded retry for the empty-first-result race (a host that has not re-attached the robot yet), and reuses the latency probe's existing `/rosapi/topics` call for mid-session changes rather than adding a second timer. `onTopicsChange()` fires only when the topic set actually changes. No public API change; Foxglove is unaffected.
- **A re-advertised topic stays subscribable on Foxglove WS.** Unadvertising a stale channel id no longer deletes the topic-to-channel mapping when the same topic was already re-advertised under a new id; the mapping is cleared only when it still points at the unadvertised id.
- **A bracketed IPv6 host with a port no longer builds an invalid URL.** Host sanitization now strips a trailing `:port` after the closing bracket of an IPv6 literal (so `[::1]:8765` no longer becomes `ws://[::1]:8765:8765`) while preserving the colons inside the brackets; the dedicated `port` field still wins.

## [0.1.4] - 2026-06-14

### Fixed

- **A malformed JSON control message no longer crashes the host.** A bad `advertise` / `unadvertise` / `advertiseServices` frame from a buggy or hostile bridge (for example a non-array `channels`) previously threw out of the WebSocket message handler, surfacing as an uncaughtException on Node and a fatal error on React Native release builds. The Foxglove dispatch now contains handler errors and routes them through the injected logger, and the affected handlers guard their field shapes so a half-valid frame degrades instead of throwing.
- **`FoxgloveClient.connect()` no longer hangs forever against a wrong or silent endpoint.** A socket that opened but never spoke the Foxglove protocol (the classic "rosbridge port in a Foxglove profile"), or that closed before the handshake completed, left the connect promise pending indefinitely. The connection timeout now covers the full handshake, and a pre-handshake close rejects the promise.
- **A failed initial `connect()` no longer leaves a background reconnect loop.** Both transports previously rejected the caller yet kept retrying in the background; because the manager only stores the client after a successful connect, that produced an unreachable client holding a socket nobody could disconnect. Auto-reconnect now runs only after a connection has previously succeeded, or while a reconnect cycle is already in progress; first-connect retry is the consumer's responsibility. `ProtocolManager.connect` also disconnects the client when `connect()` rejects.
- **Circuit-breaker cooldown timers no longer outlive the connection.** Connection teardown now destroys each subscription's breaker, so a tripped breaker's cooldown cannot fire into the next connection (where subscription ids are reused).
- **`RosbridgeClient` detaches its WebSocket handlers before closing**, so a late `onclose` from a stale socket cannot tear down a newer connection.
- **A pasted `wss://` or `https://` host no longer silently downgrades to plaintext.** When `secure` is unset the scheme is inferred from the host; an explicit `secure` (true or false) still wins.

### Changed

- **`base64ToUint8` no longer uses `atob`.** It decodes with a small lookup table instead, removing a global that is outside the library's supported set and absent on older React Native (Hermes) runtimes. Only the legacy JSON service-response path is affected; the decoded bytes are unchanged.

### Documented

- **Corrected the disconnect safety boundary.** The library publishes a zero-Twist stop on `/cmd_vel` only on an intentional disconnect while the socket is open. It cannot stop the robot on an unexpected loss of connectivity (network drop, app kill, crash) because the transport is already gone; network-loss halting requires a robot-side `cmd_vel` watchdog. Stated affirmatively in the README, both client class headers, and the `publishZeroTwist` TSDoc.
- **Documented post-reconnect behavior:** subscriptions are not re-established after an automatic reconnect, so the consumer watches `onStatusChange` and resubscribes.
- Added a SECURITY.md threat-model section: inbound size and count caps plus a fuzz harness are scheduled for a later hardening milestone, so connect only to bridges you trust until then. Removed a stale class-header line describing a keep-alive ping that was dropped in v0.1.1.
- Reordered the ROADMAP milestones (the read-only introspection surface before the Zenoh transport before the hardening milestone).

## [0.1.3] - 2026-06-02

### Added

- **`SubscribeOptions.dispatchMode`** controls how throttle-surviving messages reach the callback. `'immediate'` (the default, and the only prior behavior) parses and delivers every surviving message synchronously on the message-handler tick. `'latest-only'` delivers only the newest message under back-pressure: superseded messages are dropped *before* being parsed and delivery is deferred off the message-handler tick, so a high-bandwidth topic like a raw camera stream decodes only the frame you will actually render. The conflation happens upstream of the CDR/JSON decode, which an external wrapper cannot do because it only ever receives already-parsed messages. Available on both Foxglove WS and rosbridge. On a binary (CDR) topic the surviving payload is copied to outlive the deferral, so `'latest-only'` is parse-cheap but not allocation-free; on rosbridge the stashed frame is an immutable string and the stash is copy-free. It composes below the throttle (`maxFrequency` and the adaptive cap decide eligibility, then `'latest-only'` keeps the newest of those). A callback that throws is logged and never wedges the subscription; on unsubscribe, disconnect, or a circuit-breaker trip any pending message is dropped rather than delivered.
- **`materializeBytes(view: Uint8Array): Uint8Array`** returns an owned, offset-0 copy of a `Uint8Array`. `RosMessage.data`, when it is a `Uint8Array`, is a zero-copy view into the inbound WebSocket frame (v0.1.2); call this before retaining the bytes past the callback or handing them to a native binding that ignores `byteOffset` (some Skia paths, `node-canvas`, `sharp`, FFI). It always copies and never returns the input view, so the result is always safe to retain. This supersedes the v0.1.2 note that anticipated a conditional (skip-when-already-owned) copy: a full-span view can still alias the shared frame buffer, so the conditional form would have skipped the copy in exactly the unsafe case.
- **`matchesSchema(a: string, b: string): boolean`** compares two ROS schema names tolerant of the ROS 1 / ROS 2 `msg/` (and `srv/`, `action/`) asymmetry, so `sensor_msgs/msg/Image` matches `sensor_msgs/Image`. It is kind-agnostic: it strips the interface-kind segment and compares `pkg` + `Type`. A `normalizeSchema` counterpart is deliberately not exported, because a 2-part name cannot be safely expanded to canonical 3-part form (the interface kind cannot be inferred from the string).

### Changed

- **Bundled service-schema lookup now tolerates the 2-part / 3-part name asymmetry.** A bridge advertising a well-known system service as `rcl_interfaces/ListParameters` (without the `srv/` segment) now resolves to the bundled schema, so parameter operations and goal cancellation work regardless of which form the bridge reports. Bridge-advertised schemas remain authoritative.

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

[0.1.4]: https://github.com/AuriLabsTech/ros-mobile-bridge/releases/tag/v0.1.4
[0.1.3]: https://github.com/AuriLabsTech/ros-mobile-bridge/releases/tag/v0.1.3
[0.1.2]: https://github.com/AuriLabsTech/ros-mobile-bridge/releases/tag/v0.1.2
[0.1.1]: https://github.com/AuriLabsTech/ros-mobile-bridge/releases/tag/v0.1.1
[0.1.0]: https://github.com/AuriLabsTech/ros-mobile-bridge/releases/tag/v0.1.0
