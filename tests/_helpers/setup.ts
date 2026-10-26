// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

import { afterEach, vi } from 'vitest';

// A test that times out under fake timers never reaches its own
// `vi.useRealTimers()`; without this the next tests in the file inherit
// the fake clock and hang.
afterEach(() => {
  vi.useRealTimers();
});
