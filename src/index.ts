// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

// Public entry point for ros-mobile-bridge.
//
// Every name exported below is part of the public API and follows semver.
// Anything in src/ that isn't re-exported from here is internal and can
// change between any two patch versions without notice. See the "API
// stability" section of the README for the long-form policy.

// Core types
export type {
  BucketDef,
  IProtocolClient,
  RosMessage,
  TopicInfo,
  TopicSource,
  ServiceInfo,
  ConnectionStatus,
  ProtocolType,
  ConnectionOptions,
  SubscribeOptions,
  PublishOptions,
  CircuitBreakerState,
  SubscriptionStats,
  ProtocolClientOptions,
  ProtocolLogger,
  ThrottleMode,
} from './types';

// Implementations.
// ZenohClient is intentionally not exported in v0.1.0. ProtocolManager.connect
// throws a "planned for v0.2.0" error for protocol 'zenoh', so the only path
// to the stub is reading the source — which documents the v0.2.0 contract.
export { FoxgloveClient } from './FoxgloveClient';
export { RosbridgeClient } from './RosbridgeClient';

// Factory.
export { ProtocolManager } from './ProtocolManager';

// Schema utilities — usable independently of any client when consumers want
// to build templates from a schema they obtained another way.
export { schemaToTemplate } from './schemaToTemplate';
export { jsonSchemaToTemplate } from './jsonSchemaToTemplate';

// Schema-name matching — tolerant of the ROS 1 / ROS 2 `msg/` (and `srv/`,
// `action/`) asymmetry, so consumers routing by schema don't reimplement the
// strip-and-compare every time. `normalizeSchema` is deliberately not
// exported: a 2-part name cannot be safely expanded to canonical 3-part form.
export { matchesSchema } from './schemaName';

// Byte-ownership helper — materialize an owned, offset-0 copy of a zero-copy
// `RosMessage.data` view before retaining it past the callback or handing it
// to a native binding that ignores `byteOffset`.
export { materializeBytes } from './materializeBytes';

// Default-port constant — useful for connection-configuration UIs that want
// a sensible value when the user changes protocol.
export { DEFAULT_PORTS } from './constants';

// Default throttle curves — exported so consumers building custom
// `presetOverrides` can compose on top of the library's tuning rather than
// retyping the bucket arrays. Pair with the `BucketDef` and `ThrottleMode`
// types above.
export { DEFAULT_PRESETS } from './SubscriptionBandwidth';

// Diagnostics — readers only. Consumers can render "currently throttled at
// X Hz" badges and export lag data into bug reports. The corresponding
// writer (`setModeGetter`) stays internal; protocol clients invoke it from
// their constructors using the value they received from
// `ProtocolClientOptions.getThrottleMode`.
export {
  getMaxLagMs,
  getLagStats,
  getLagHistoryCsv,
  clearLagHistory,
} from './EventLoopMonitor';

// Diagnostics helper: resolve a raw lag value to the bucket label the
// adaptive throttle would apply at that lag for a given mode. Useful for
// debug overlays that want to show "JS lag is N ms → bucket X" without
// reaching into a specific subscription's tracker.
export { bucketLabelForLag } from './SubscriptionBandwidth';
