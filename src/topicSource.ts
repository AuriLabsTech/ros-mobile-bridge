// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

import type { TopicInfo } from './types';

/**
 * A topic list as handed to the consumer: the server's entries, each marked
 * from what this client advertises at this moment (ADR 0029). Every path that
 * returns or delivers a `TopicInfo[]` goes through here, so `source` is never
 * kept with the server's list, where it would go stale on the next `publish`
 * or `unadvertise`. Always new objects: the consumer cannot reach the
 * client's own cache through them.
 */
export function withSource(
  topics: Iterable<Omit<TopicInfo, 'source'>>,
  advertised: { has(topic: string): boolean },
): TopicInfo[] {
  return Array.from(topics, (t) => ({
    topic: t.topic,
    schemaName: t.schemaName,
    encoding: t.encoding,
    source: advertised.has(t.topic) ? 'app' : 'robot',
  }));
}
