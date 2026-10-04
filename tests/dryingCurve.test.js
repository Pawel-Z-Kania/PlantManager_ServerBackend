import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  DEFAULT_PREDICTION_OPTIONS,
  predictNextWatering,
  smoothSeries,
} from '../api/_lib/dryingCurve.js';

const DAY = 86400;
const HOUR = 3600;
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/skrzydlokwiat-cycles.json', import.meta.url), 'utf8')
);
const profile = { target_logit: 2.6, smoothing_window_hours: 12, settle_hours: 12, min_cycle_age_hours: 48 };

function inputAt(cycle, ageDays, overrides = {}) {
  const t0 = fixture.onsets[cycle];
  const now = t0 + ageDays * DAY;
  return {
    now,
    input: {
      last_watered_at: new Date(t0 * 1000).toISOString(),
      ...profile,
      points: fixture.points.filter(([t]) => t > t0 && t <= now),
      events: fixture.onsets.slice(0, cycle + 1),
      ...overrides,
    },
  };
}

describe('smoothSeries', () => {
  const opts = { bucketHours: 1, minCoverage: 0.5 };

  it('keeps a linear trend unbiased (centroid timestamps)', () => {
    const points = Array.from({ length: 72 }, (_, i) => [i * HOUR, 400 + i]);
    const smoothed = smoothSeries(points, 12, opts);
    assert.ok(smoothed.length >= 8);
    for (const { t, y } of smoothed) assert.ok(Math.abs(y - (400 + t / HOUR)) < 1e-9);
  });

  it('drops windows that fall into a data gap instead of indexing by sample', () => {
    const points = [
      ...Array.from({ length: 24 }, (_, i) => [i * HOUR, 400]),
      ...Array.from({ length: 24 }, (_, i) => [(48 + i) * HOUR, 420]),
    ];
    const smoothed = smoothSeries(points, 12, opts);
    const inGap = smoothed.filter(({ t }) => t > 26 * HOUR && t < 46 * HOUR);
    assert.equal(inGap.length, 0);
  });
});

describe('predictNextWatering', () => {
  it('returns no prediction for a young cycle without history', () => {
    const { input, now } = inputAt(0, 1);
    const result = predictNextWatering({ ...input, events: [] }, now);
    assert.deepEqual([result.status, result.reason], ['skip', 'young_cycle']);
  });

  it('uses the median of previous cycle lengths and does not clamp past dates', () => {
    const t0 = 1_800_000_000;
    const input = {
      last_watered_at: new Date(t0 * 1000).toISOString(),
      ...profile,
      points: [],
      events: [t0 - 20 * DAY, t0 - 10 * DAY, t0],
    };
    const now = t0 + 14 * DAY;
    const result = predictNextWatering(input, now);
    assert.equal(result.source, 'interval');
    assert.equal(result.dateSec, t0 + 10 * DAY);
    assert.ok(result.dateSec < now);
  });

  it('skips a flat series (plateau after watering, no rise yet)', () => {
    const t0 = 1_800_000_000;
    const points = Array.from({ length: 24 * 8 }, (_, i) => [t0 + (i + 13) * HOUR, 413 + (i % 3) - 1]);
    const result = predictNextWatering(
      { last_watered_at: new Date(t0 * 1000).toISOString(), ...profile, points, events: [t0] },
      t0 + 8 * DAY
    );
    assert.equal(result.status, 'skip');
  });

  it('recovers the target time of a noise-free logistic curve', () => {
    const t0 = 1_800_000_000;
    const [floor, ceiling, k, tm] = [380, 520, 1, 5];
    const points = Array.from({ length: 24 * 9 }, (_, i) => {
      const days = (i + 13) / 24;
      return [t0 + days * DAY, floor + (ceiling - floor) / (1 + Math.exp(-k * (days - tm)))];
    });
    const result = predictNextWatering(
      { last_watered_at: new Date(t0 * 1000).toISOString(), ...profile, target_logit: 1.5, points, events: [t0] },
      t0 + 9 * DAY,
      { preferredSource: 'curve' }
    );
    assert.equal(result.source, 'curve');
    assert.ok(Math.abs((result.dateSec - t0) / DAY - (tm + 1.5 / k)) < 0.3);
  });
});

describe('backtest on recorded skrzydlokwiat cycles', () => {
  const curveFirst = { preferredSource: 'curve' };
  const actualAge = (cycle) => fixture.onsets[cycle + 1] - fixture.onsets[cycle];

  it('does not emit a curve prediction in the early phase of a cycle', () => {
    for (const cycle of [0, 1]) {
      const { input, now } = inputAt(cycle, 4, { events: [] });
      assert.equal(predictNextWatering(input, now, curveFirst).status, 'skip');
    }
  });

  it('predicts the next watering within one day late in the cycle', () => {
    for (const [cycle, ageDays] of [[0, 8], [1, 9]]) {
      const { input, now } = inputAt(cycle, ageDays, { events: [] });
      const result = predictNextWatering(input, now, curveFirst);
      assert.equal(result.source, 'curve');
      const errorDays = (result.dateSec - (fixture.onsets[cycle] + actualAge(cycle))) / DAY;
      assert.ok(Math.abs(errorDays) < 1, `cycle ${cycle}: error ${errorDays.toFixed(2)} d`);
    }
  });

  it('interval estimator from one previous cycle stays within two days', () => {
    const { input, now } = inputAt(1, 3);
    const result = predictNextWatering(input, now);
    assert.equal(result.source, 'interval');
    assert.ok(Math.abs((result.dateSec - fixture.onsets[2]) / DAY) < 2);
  });

  it('keeps the documented gate defaults', () => {
    assert.equal(DEFAULT_PREDICTION_OPTIONS.preferredSource, 'interval');
    assert.equal(DEFAULT_PREDICTION_OPTIONS.minAmplitudeAdc, 80);
  });
});
