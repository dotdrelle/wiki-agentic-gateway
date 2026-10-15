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
  assert.deepEqual(snapshot.phases.discover, {
    count: 2, p50: 100, p95: 300, avgMs: 200, tools: 5, pages: 3,
    modelCalls: 0, tokensEstimated: 0, maxCallTokens: 0, distinctPages: 0, rereads: 0,
  });
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

test('each phase says where its budget went: calls, tokens, largest call, pages and re-reads', () => {
  const metrics = createPhaseMetrics();
  metrics.record({ type: 'phase_finished', phase: 'discover', durationMs: 10, modelCalls: 4, tokensEstimated: 90_000, maxCallTokens: 40_000, distinctPages: 30, rereads: 2 });
  metrics.record({ type: 'phase_finished', phase: 'discover', durationMs: 20, modelCalls: 2, tokensEstimated: 10_000, maxCallTokens: 7_000, distinctPages: 5, rereads: 0 });
  const discover = metrics.snapshot().phases.discover;
  assert.equal(discover.modelCalls, 6);
  assert.equal(discover.tokensEstimated, 100_000);
  assert.equal(discover.maxCallTokens, 40_000, 'the largest call is a maximum, not a sum');
  assert.equal(discover.distinctPages, 35);
  assert.equal(discover.rereads, 2);
});

test('two agents of one phase stay apart in the role view', () => {
  const metrics = createPhaseMetrics();
  // The Archivist and the final assembly share phase "assemble" but are two
  // agents, each with its own budget.
  metrics.record({ type: 'phase_finished', phase: 'assemble', role: 'archivist', durationMs: 10, modelCalls: 2, tokensEstimated: 30_000, maxCallTokens: 20_000 });
  metrics.record({ type: 'phase_finished', phase: 'assemble', role: 'assemble', durationMs: 20, modelCalls: 1, tokensEstimated: 50_000, maxCallTokens: 50_000 });
  // An event without a role (an older runner) falls back to its phase.
  metrics.record({ type: 'phase_finished', phase: 'discover', durationMs: 5, modelCalls: 3 });
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.phases.assemble.modelCalls, 3);
  assert.equal(snapshot.phases.assemble.tokensEstimated, 80_000);
  assert.deepEqual(
    [snapshot.roles.archivist.phase, snapshot.roles.archivist.modelCalls, snapshot.roles.archivist.tokensEstimated],
    ['assemble', 2, 30_000],
  );
  assert.deepEqual(
    [snapshot.roles.assemble.phase, snapshot.roles.assemble.modelCalls, snapshot.roles.assemble.maxCallTokens],
    ['assemble', 1, 50_000],
  );
  assert.equal(snapshot.roles.discover.modelCalls, 3);
});
