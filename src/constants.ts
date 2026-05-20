// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

import type { ProtocolType } from './types';

/**
 * Default TCP port for each supported protocol. Useful for consumers
 * building connection-configuration UIs that want a sensible starting
 * value when the user changes protocol.
 */
export const DEFAULT_PORTS: Record<ProtocolType, number> = {
  'foxglove-ws': 8765,
  rosbridge: 9090,
  zenoh: 7447,
};
