import assert from 'node:assert/strict';
import test from 'node:test';

import { createPhaseMetrics, percentile } from './metrics.js';

test('percentile is nearest-rank, and null on an empty sample', () => {
  assert.equal(percentile([], 95), null);
  const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(percentile(sorted, 50), 50);
  assert.equal(percentile(sorted, 95), 100);
});

test('phase metrics aggregate durations and counters', () => {
  const metrics = createPhaseMetrics();
  metrics.record({ type: 'run_started' });
  metrics.record({ type: 'phase_finished', phase: 'discover', durationMs: 100, tools: 3, pages: 1 });
  metrics.record({ type: 'phase_finished', phase: 'discover', durationMs: 300, tools: 2, pages: 2 });
  metrics.record({ type: 'phase_finished', phase: 'analyse', durationMs: 200 });
  metrics.record({ type: 'run_completed' });
  metrics.record({ type: 'heartbeat' });
  metrics.record({ type: 'degraded' });
  // A phase with no duration is ignored, not counted as a 0-duration sample.
  metrics.record({ type: 'phase_finished', phase: 'nominal' });

  const snapshot = metrics.snapshot();
  assert.deepEqual(snapshot.phases.discover, { count: 2, p50: 100, p95: 300, avgMs: 200, tools: 5, pages: 3 });
  assert.equal(snapshot.phases.analyse.count, 1);
  assert.equal(snapshot.phases.nominal, undefined);
  assert.equal(snapshot.runsStarted, 1);
  assert.equal(snapshot.runsCompleted, 1);
  assert.equal(snapshot.heartbeats, 1);
  assert.equal(snapshot.degraded, 1);
});

test('the snapshot carries durations and counts, never content', () => {
  const metrics = createPhaseMetrics();
  metrics.record({ type: 'phase_finished', phase: 'discover', durationMs: 1, summary: 'a secret page body' });
  const serialized = JSON.stringify(metrics.snapshot());
  assert.doesNotMatch(serialized, /secret page body|prompt|objective|content/i);
});

test('the per-phase duration sample is a bounded window, not an unbounded accumulator', () => {
  const metrics = createPhaseMetrics();
  for (let i = 1; i <= 600; i += 1) {
    metrics.record({ type: 'phase_finished', phase: 'discover', durationMs: i });
  }
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.window, 500);
  assert.equal(snapshot.phases.discover.count, 500, 'only the last N durations are kept');
  // The window is the MOST RECENT samples: durations 101..600 (500 of them),
  // so nearest-rank p95 is the 475th entry = 101 + 474 = 575.
  assert.equal(snapshot.phases.discover.p95, 575);
});
