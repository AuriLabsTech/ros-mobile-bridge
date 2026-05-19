import { describe, it, expect } from 'vitest';
import type { BucketDef, ProtocolLogger, ThrottleMode } from '../src/types';
import {
  DEFAULT_PRESETS,
  buildEffectivePresets,
  createBandwidthTracker,
  getTrackerBucketLabel,
  setTrackerToDeepest,
} from '../src/SubscriptionBandwidth';

function makeLogger(): ProtocolLogger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    log: () => {},
    warn: (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    },
    error: () => {},
    warnings,
  };
}

describe('buildEffectivePresets', () => {
  it('returns the defaults verbatim when no overrides are supplied', () => {
    const logger = makeLogger();
    const presets = buildEffectivePresets(undefined, logger);
    expect(presets.performance).toBe(DEFAULT_PRESETS.performance);
    expect(presets.auto).toBe(DEFAULT_PRESETS.auto);
    expect(presets.efficient).toBe(DEFAULT_PRESETS.efficient);
    expect(logger.warnings).toEqual([]);
  });

  it('returns a fresh object, not the DEFAULT_PRESETS reference', () => {
    const logger = makeLogger();
    const presets = buildEffectivePresets(undefined, logger);
    expect(presets).not.toBe(DEFAULT_PRESETS);
  });

  it('overrides a single mode and leaves the others on defaults', () => {
    const logger = makeLogger();
    const customAuto: BucketDef[] = [
      { threshold: 0, minIntervalMs: 0, label: 'none' },
      { threshold: 200, minIntervalMs: 500, label: '2 Hz' },
    ];
    const presets = buildEffectivePresets({ auto: customAuto }, logger);
    expect(presets.auto).toBe(customAuto);
    expect(presets.performance).toBe(DEFAULT_PRESETS.performance);
    expect(presets.efficient).toBe(DEFAULT_PRESETS.efficient);
    expect(logger.warnings).toEqual([]);
  });

  it('does not mutate DEFAULT_PRESETS when every mode is overridden', () => {
    const before = {
      performance: DEFAULT_PRESETS.performance,
      auto: DEFAULT_PRESETS.auto,
      efficient: DEFAULT_PRESETS.efficient,
    };
    const logger = makeLogger();
    buildEffectivePresets(
      {
        performance: [{ threshold: 0, minIntervalMs: 50, label: 'cap' }],
        auto: [{ threshold: 0, minIntervalMs: 100, label: '10 Hz' }],
        efficient: [{ threshold: 0, minIntervalMs: 200, label: '5 Hz' }],
      },
      logger,
    );
    expect(DEFAULT_PRESETS.performance).toBe(before.performance);
    expect(DEFAULT_PRESETS.auto).toBe(before.auto);
    expect(DEFAULT_PRESETS.efficient).toBe(before.efficient);
  });

  it('two builds with different overrides do not share state', () => {
    const logger = makeLogger();
    const customA: BucketDef[] = [{ threshold: 0, minIntervalMs: 100, label: 'A' }];
    const customB: BucketDef[] = [{ threshold: 0, minIntervalMs: 200, label: 'B' }];
    const presetsA = buildEffectivePresets({ auto: customA }, logger);
    const presetsB = buildEffectivePresets({ auto: customB }, logger);
    expect(presetsA.auto).toBe(customA);
    expect(presetsB.auto).toBe(customB);
    expect(presetsA.auto).not.toBe(presetsB.auto);
  });
});

describe('buildEffectivePresets — validation', () => {
  it('rejects an empty array, warns, and falls back to default for that mode', () => {
    const logger = makeLogger();
    const presets = buildEffectivePresets({ auto: [] }, logger);
    expect(presets.auto).toBe(DEFAULT_PRESETS.auto);
    expect(logger.warnings.length).toBe(1);
    expect(logger.warnings[0]).toMatch(/auto.*empty/);
  });

  it('rejects an override whose first bucket has a non-zero threshold', () => {
    const logger = makeLogger();
    const presets = buildEffectivePresets(
      {
        auto: [
          { threshold: 100, minIntervalMs: 0, label: 'none' },
          { threshold: 200, minIntervalMs: 500, label: '2 Hz' },
        ],
      },
      logger,
    );
    expect(presets.auto).toBe(DEFAULT_PRESETS.auto);
    expect(logger.warnings.length).toBe(1);
    expect(logger.warnings[0]).toMatch(/auto.*first bucket.*threshold === 0/);
  });

  it('keeps other valid overrides when one mode is invalid', () => {
    const logger = makeLogger();
    const customEfficient: BucketDef[] = [
      { threshold: 0, minIntervalMs: 0, label: 'none' },
      { threshold: 50, minIntervalMs: 1000, label: '1 Hz' },
    ];
    const presets = buildEffectivePresets(
      {
        auto: [],
        efficient: customEfficient,
      },
      logger,
    );
    expect(presets.auto).toBe(DEFAULT_PRESETS.auto);
    expect(presets.efficient).toBe(customEfficient);
    expect(logger.warnings.length).toBe(1);
  });

  it('accepts a sparse override (missing modes use defaults, no warnings)', () => {
    const logger = makeLogger();
    const presets = buildEffectivePresets(
      { performance: [{ threshold: 0, minIntervalMs: 0, label: 'none' }] },
      logger,
    );
    expect(presets.performance).not.toBe(DEFAULT_PRESETS.performance);
    expect(presets.auto).toBe(DEFAULT_PRESETS.auto);
    expect(logger.warnings).toEqual([]);
  });
});

describe('createBandwidthTracker', () => {
  it('attaches DEFAULT_PRESETS when no presets argument is supplied', () => {
    const tracker = createBandwidthTracker('auto');
    expect(tracker.presets).toBe(DEFAULT_PRESETS);
  });

  it('attaches the supplied presets reference, not a clone', () => {
    const logger = makeLogger();
    const presets = buildEffectivePresets(
      { auto: [{ threshold: 0, minIntervalMs: 0, label: 'none' }] },
      logger,
    );
    const tracker = createBandwidthTracker('auto', presets);
    expect(tracker.presets).toBe(presets);
  });

  it('clamps the initial bucket index to the override array length', () => {
    // The library's INITIAL_BUCKET_PER_MODE for 'auto' is 2, but a short
    // override with only one bucket should not produce an out-of-range index.
    const logger = makeLogger();
    const presets = buildEffectivePresets(
      { auto: [{ threshold: 0, minIntervalMs: 0, label: 'none' }] },
      logger,
    );
    const tracker = createBandwidthTracker('auto', presets);
    expect(tracker.currentBucket).toBe(0);
    expect(tracker.adaptiveMinIntervalMs).toBe(0);
  });
});

describe('getTrackerBucketLabel + setTrackerToDeepest with overrides', () => {
  it('reads labels from the tracker presets, not the defaults', () => {
    const logger = makeLogger();
    const auto: BucketDef[] = [
      { threshold: 0, minIntervalMs: 0, label: 'none' },
      { threshold: 50, minIntervalMs: 1000, label: 'custom-1Hz' },
    ];
    const presets = buildEffectivePresets({ auto }, logger);
    const tracker = createBandwidthTracker('auto', presets);
    setTrackerToDeepest(tracker, 'auto');
    expect(getTrackerBucketLabel(tracker, 'auto')).toBe('custom-1Hz');
  });

  it('setTrackerToDeepest indexes against the override length', () => {
    const logger = makeLogger();
    const auto: BucketDef[] = [
      { threshold: 0, minIntervalMs: 0, label: 'none' },
      { threshold: 100, minIntervalMs: 500, label: '2 Hz' },
    ];
    const presets = buildEffectivePresets({ auto }, logger);
    const tracker = createBandwidthTracker('auto', presets);
    setTrackerToDeepest(tracker, 'auto');
    expect(tracker.currentBucket).toBe(1);
    expect(tracker.adaptiveMinIntervalMs).toBe(500);
  });
});

describe('per-client preset isolation', () => {
  it('two trackers built from different effective-preset maps do not interfere', () => {
    const logger = makeLogger();
    const presetsA = buildEffectivePresets(
      { auto: [{ threshold: 0, minIntervalMs: 100, label: 'A-cap' }] },
      logger,
    );
    const presetsB = buildEffectivePresets(
      { auto: [{ threshold: 0, minIntervalMs: 200, label: 'B-cap' }] },
      logger,
    );
    const trackerA = createBandwidthTracker('auto', presetsA);
    const trackerB = createBandwidthTracker('auto', presetsB);

    expect(getTrackerBucketLabel(trackerA, 'auto')).toBe('A-cap');
    expect(getTrackerBucketLabel(trackerB, 'auto')).toBe('B-cap');
    expect(trackerA.presets).not.toBe(trackerB.presets);
  });
});

describe('ThrottleMode exhaustiveness', () => {
  it('the three documented modes all resolve in default presets', () => {
    const modes: ThrottleMode[] = ['performance', 'auto', 'efficient'];
    for (const mode of modes) {
      const tracker = createBandwidthTracker(mode);
      // Each mode's first bucket label must be readable.
      const firstBucket = DEFAULT_PRESETS[mode][0];
      expect(firstBucket).toBeDefined();
      expect(firstBucket?.threshold).toBe(0);
      expect(tracker.presets[mode]).toBeDefined();
    }
  });
});
