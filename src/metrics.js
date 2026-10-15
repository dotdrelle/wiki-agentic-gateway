/*
 Local phase and role metrics — durations and counters, NEVER content.

 The lot 6 gate is explicit: the parallel collective only becomes the default if
 the phase p95 improves without losing objections. That needs a measurement that
 exists before the change, stays local (no SaaS), and carries no source text,
 no prompt, no model output — only "how long", "how many".
*/

// A sliding window per phase: only the last N durations are kept, so the p95
// stays just as faithful while the accumulator is the only one in the repo with
// a ceiling (MAX_RUN_EVENTS, MEMORY_SCOPE_MAX, the 20/50 caps).
const METRICS_WINDOW = Number.parseInt(process.env.GATEWAY_METRICS_WINDOW ?? '', 10) || 500;

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

// The role meter's counters (agent.js `createRoleMeter`): counts, never paths.
const SPEND_SUMS = ['modelCalls', 'tokensEstimated', 'distinctPages', 'rereads'];
const emptySpend = () => ({ modelCalls: 0, tokensEstimated: 0, maxCallTokens: 0, distinctPages: 0, rereads: 0 });

export function createPhaseMetrics() {
  const phases = new Map();
  const roles = new Map();
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
      const role = String(event?.role ?? phase);
      const update = (buckets, key, rolePhase = null) => {
        const entry = buckets.get(key) ?? { durations: [], tools: 0, pages: 0, ...emptySpend() };
        if (rolePhase) entry.phase = rolePhase;
        entry.durations.push(durationMs);
        if (entry.durations.length > METRICS_WINDOW) {
          entry.durations.splice(0, entry.durations.length - METRICS_WINDOW);
        }
        entry.tools += Number(event?.tools) || 0;
        entry.pages += Number(event?.pages) || 0;
        // The budget counters are totals; the largest call is a maximum.
        for (const counter of SPEND_SUMS) entry[counter] += Number(event?.[counter]) || 0;
        entry.maxCallTokens = Math.max(entry.maxCallTokens, Number(event?.maxCallTokens) || 0);
        buckets.set(key, entry);
      };
      update(phases, phase);
      // Keep the phase view for compatibility, and expose an unambiguous role
      // view as well. In particular, the Archivist and final answer both use
      // phase "assemble" but are separate agents with separate token budgets.
      update(roles, role, phase);
      return;
    }
    const counter = COUNTER_BY_EVENT[type];
    if (counter) counters[counter] += 1;
  }

  function snapshot() {
    const summarize = (buckets) => {
      const result = {};
      for (const [name, entry] of buckets) {
        const sorted = [...entry.durations].sort((a, b) => a - b);
        const total = sorted.reduce((sum, value) => sum + value, 0);
        result[name] = {
          ...(entry.phase ? { phase: entry.phase } : {}),
          count: sorted.length,
          p50: percentile(sorted, 50),
          p95: percentile(sorted, 95),
          avgMs: sorted.length > 0 ? Math.round(total / sorted.length) : null,
          tools: entry.tools,
          pages: entry.pages,
          modelCalls: entry.modelCalls,
          tokensEstimated: entry.tokensEstimated,
          maxCallTokens: entry.maxCallTokens,
          distinctPages: entry.distinctPages,
          rereads: entry.rereads,
        };
      }
      return result;
    }
    return { phases: summarize(phases), roles: summarize(roles), window: METRICS_WINDOW, ...counters };
  }

  return { record, snapshot };
}
