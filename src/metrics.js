/*
 Local phase metrics — durations and counters, NEVER content.

 The lot 6 gate is explicit: the parallel collective only becomes the default if
 the phase p95 improves without losing objections. That needs a measurement that
 exists before the change, stays local (no SaaS), and carries no source text,
 no prompt, no model output — only "how long", "how many".
*/

/** Nearest-rank percentile; null on an empty sample rather than a fake 0. */
export function percentile(sorted, p) {
  if (!Array.isArray(sorted) || sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

const COUNTER_BY_EVENT = {
  run_started: 'runsStarted',
  run_completed: 'runsCompleted',
  run_failed: 'runsFailed',
  run_cancelled: 'runsCancelled',
  heartbeat: 'heartbeats',
  degraded: 'degraded',
};

export function createPhaseMetrics() {
  const phases = new Map();
  const counters = {
    runsStarted: 0,
    runsCompleted: 0,
    runsFailed: 0,
    runsCancelled: 0,
    heartbeats: 0,
    degraded: 0,
  };

  function record(event) {
    const type = String(event?.type ?? '');
    if (type === 'phase_finished') {
      const durationMs = Number(event?.durationMs);
      if (!Number.isFinite(durationMs)) return;
      const phase = String(event?.phase ?? 'unknown');
      const entry = phases.get(phase) ?? { durations: [], tools: 0, pages: 0 };
      entry.durations.push(durationMs);
      entry.tools += Number(event?.tools) || 0;
      entry.pages += Number(event?.pages) || 0;
      phases.set(phase, entry);
      return;
    }
    const counter = COUNTER_BY_EVENT[type];
    if (counter) counters[counter] += 1;
  }

  function snapshot() {
    const result = {};
    for (const [phase, entry] of phases) {
      const sorted = [...entry.durations].sort((a, b) => a - b);
      const total = sorted.reduce((sum, value) => sum + value, 0);
      result[phase] = {
        count: sorted.length,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        avgMs: sorted.length > 0 ? Math.round(total / sorted.length) : null,
        tools: entry.tools,
        pages: entry.pages,
      };
    }
    return { phases: result, ...counters };
  }

  return { record, snapshot };
}
