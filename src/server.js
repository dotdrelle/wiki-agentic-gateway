import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createAgentRunner } from './agent.js';
import { pruneStaleWorktrees, workspaceRootFor } from './worktree.js';
import { describeProcedures, loadProcedureRegistry } from './procedures.js';
import { createPhaseMetrics } from './metrics.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/**
 * HTTP gateway implementing the Wiki Manager RuntimeProvider contract
 * (llm-wiki-manager/docs/agentic-runtime.md):
 *
 *   GET  /health            -> { ok, version }
 *   GET  /capabilities      -> [ { name, operations, aliases, description, mutationClass } ]
 *   POST /runs              -> { runId, status }          (non-blocking)
 *   GET  /runs/:id          -> { runId, status, result? }
 *   POST /runs/:id/cancel   -> { ok }
 *   POST /runs/:id/approve  -> { ok }                     (HITL decision)
 *   GET  /runs/:id/events   -> SSE `data: {json}\n\n`, cursor replay then live
 *   GET  /metrics           -> content-free phase metrics
 *   GET  /procedures        -> read-only procedure diagnostic
 */
export function startGateway({
  port = 7789,
  config,
  createRunner = null,
  now = () => new Date(),
} = {}) {
  const runs = new Map();
  // Local, content-free phase metrics: the measurement the lot 6 gate reads.
  const metrics = createPhaseMetrics();
  let sequence = 0;
  // One identity per process: a cursor is only meaningful inside the instance
  // that produced it. A reconnect carrying another epoch is a gateway restart,
  // and the correct answer is "no replay", never a mixed history.
  const STREAM_EPOCH = randomUUID();
  // Same discipline as the manager's MAX_SESSION_EVENTS: an unbounded buffer
  // made replay and memory grow with everything a run had ever emitted.
  const MAX_RUN_EVENTS = Number(process.env.GATEWAY_MAX_RUN_EVENTS ?? 5000);
  const RUN_TTL_MS = Number(process.env.GATEWAY_RUN_TTL_MS ?? 10 * 60 * 1000);

  function nextRunId() {
    sequence += 1;
    return `gateway-${sequence}`;
  }

  function runFor(runId) {
    const run = runs.get(String(runId));
    if (!run) throw new Error(`unknown run ${runId}`);
    return run;
  }

  /*
   A heartbeat says "alive NOW". Replayed in bulk to a client that reconnects,
   it is at best useless and at worst a false history — twenty beats arriving
   at once describe a run that is not beating. So it is streamed to the
   subscribers present and never stored: only facts with historical value
   (`phase_*`, `finding`, `degraded`, tool and role events) are replayable.

   It still takes a sequence number, so a client counting frames does not see a
   gap where a beat went by.
  */
  const EPHEMERAL_EVENT_TYPES = new Set(['heartbeat']);

  function emit(run, event) {
    const stamped = {
      ...event,
      runId: run.runId,
      ts: now().toISOString(),
      sequence: run.sequence++,
    };
    if (!EPHEMERAL_EVENT_TYPES.has(String(event?.type))) {
      run.events.push(stamped);
      // What the ceiling drops is remembered, so a cursor older than the
      // buffer is TOLD events were lost instead of silently resuming on a gap.
      if (Number.isFinite(MAX_RUN_EVENTS) && MAX_RUN_EVENTS > 0 && run.events.length > MAX_RUN_EVENTS) {
        const overflow = run.events.splice(0, run.events.length - MAX_RUN_EVENTS);
        run.droppedThrough = Math.max(
          run.droppedThrough ?? 0,
          ...overflow.map((entry) => Number(entry.sequence) || 0),
        );
        console.warn(
          `gateway: run ${run.runId} event buffer trimmed by ${overflow.length} (ceiling ${MAX_RUN_EVENTS})`,
        );
      }
    }
    for (const stream of run.streams) stream.write(stamped);
  }

  /*
   The proof a long run is still working when no tool is firing.

   Started with the run and cleared on EVERY exit — success, failure,
   cancellation, and the approval pause, where the run is deliberately idle and
   a beat would claim work that is not happening.
  */
  const HEARTBEAT_MS = Number(process.env.GATEWAY_HEARTBEAT_MS || 15_000);

  function startHeartbeat(run) {
    stopHeartbeat(run);
    if (!(HEARTBEAT_MS > 0)) return;
    const startedAt = Date.now();
    run.heartbeat = setInterval(() => {
      if (run.status !== 'running') return stopHeartbeat(run);
      emit(run, { type: 'heartbeat', elapsedMs: Date.now() - startedAt });
    }, HEARTBEAT_MS);
    run.heartbeat.unref?.();
  }

  function stopHeartbeat(run) {
    if (!run?.heartbeat) return;
    clearInterval(run.heartbeat);
    run.heartbeat = null;
  }

  function capabilityFor(name) {
    return (config?.capabilities ?? []).find((capability) => capability.name === name) ?? null;
  }

  // Resolved in the BODY, not as a default parameter: default initializers
  // evaluate in the parameter scope, which does not see `emit` — the closure
  // crashed with "emit is not defined" on the first tool callback.
  // The runner also receives the REQUEST: the MCP pool travels per run (the
  // manager sends the active workspace's wiki), nothing MCP lives in the
  // static gateway config.
  const resolveRunner = createRunner ?? ((run, model, request) => {
    const capability = capabilityFor(String(request.capability ?? ''));
    return createAgentRunner({
      model,
      mcpServers: request.mcp ?? [],
      signal: run.controller.signal,
      onEvent: (event) => {
        metrics.record(event);
        emit(run, event);
      },
      // The hands follow the served capability declaration, never the request:
      // `worktree: true` on the capability is what arms the confined backend.
      worktree: capability?.worktree === true,
      // The collective (named subagents) is declared per capability too.
      roles: Array.isArray(capability?.subagents) ? capability.subagents.map(String) : [],
      runId: run.runId,
      // Carried, never trusted: the runner validates it against the workspace
      // it resolved (resolveMemoryScope). Absent is the normal mono-user case.
      memoryScope: request.memoryScope ?? null,
    });
  });

  async function executeRun(run, request) {
    const capability = capabilityFor(String(request.capability ?? ''));
    const operation = String(request.operation ?? 'run');
    const mutating = operation !== 'plan'
      && (Boolean(capability?.mutationClass) || capability?.defaultRequiresApproval === true);
    try {
      emit(run, { type: 'run_started' });
      if (mutating) {
        run.status = 'waiting_approval';
        emit(run, {
          type: 'approval_required',
          approvalId: `${run.runId}-proposal`,
          reason: 'analysis complete before execution',
          proposal: {
            summary: `Analysis for "${String(request.objective ?? '')}": read-only inspection, then the announced mutation.`,
            // The pool travels with the run (no static mcpServers since the
            // per-run MCP pool): list what the runtime will actually see.
            readTools: (request.mcp ?? []).flatMap((server) => (server?.tools ?? []).map(String)),
            mutations: [{ kind: capability?.mutationClass ?? 'default', summary: String(request.objective ?? '') }],
          },
        });
        await run.approvalGate();
        if (run.status === 'cancelled') return;
        run.status = 'running';
      }
      // After the approval gate on purpose: a run parked on a human decision
      // is idle, and a beat there would claim work nobody is doing.
      startHeartbeat(run);
      const runModel = request.model ?? null;
      if (!runModel?.baseUrl || !(runModel.model || runModel.name)) {
        run.status = 'failed';
        run.error = 'no model: the manager must send the active profile model with every run';
        emit(run, { type: 'run_failed', error: run.error });
        return;
      }
      const runner = resolveRunner(run, runModel, request);
      const output = await runner.run({
        objective: request.objective ?? request.input ?? null,
        operation,
        capability: request.capability ?? null,
        language: request.language ?? null,
        mcp: request.mcp ?? [],
        systemPrompt: request.systemPrompt ?? null,
        workspace: request.workspace ?? null,
      });
      const content = typeof output === 'string' ? output : (output?.content ?? '');
      run.result = {
        status: 'completed',
        content,
        // The agent proposes structural changes in prose (its system prompt
        // says so). Lifted here into the structured field the manager's DAG
        // integration reads (result.planExpansionRequest): a proposal left in
        // free text is a finding nobody acts on.
        ...(extractPlanExpansionRequest(content)
          ? { planExpansionRequest: extractPlanExpansionRequest(content) }
          : {}),
        // Worktree hands (lot 1): the confined branch the run edited, with
        // the diff the human merges or rejects. The manager persists it into
        // the workspace review queue; nothing here touched the wiki.
        ...(output?.worktreeProposal ? { worktreeProposal: output.worktreeProposal } : {}),
        // What the run lost on the way (a role that failed but did not stop
        // it). Carried on the RESULT so the proposal a human opens tomorrow
        // still says a role was missing when it was written.
        ...(Array.isArray(output?.degradations) && output.degradations.length > 0
          ? { degradations: output.degradations }
          : {}),
        ...(Array.isArray(output?.refusedParams) && output.refusedParams.length > 0
          ? { refusedParams: output.refusedParams }
          : {}),
      };
      run.worktreeProposal = output?.worktreeProposal ?? null;
      // The terminal event is in the buffer BEFORE the status says terminal: a
      // poll that sees "completed" must be able to replay the event that says
      // so. The reverse order let a fast reader connect in the window, get a
      // closed stream and no `run_completed`.
      emit(run, { type: 'message', content });
      emit(run, { type: 'run_completed' });
      run.status = 'completed';
    } catch (error) {
      if (error?.name === 'AbortError' || run.aborted) {
        emit(run, { type: 'run_cancelled' });
        run.status = 'cancelled';
        return;
      }
      run.error = error instanceof Error ? error.message : String(error);
      // The operator watches this console: say WHY, like the manager does.
      console.error(`run ${run.runId} failed: ${run.error}`);
      emit(run, { type: 'run_failed', error: run.error });
      run.status = 'failed';
    } finally {
      // Every exit, without exception: the beat must not outlive the work it
      // claims. A timer left armed is both a false liveness signal and a
      // handle holding the run object alive.
      stopHeartbeat(run);
      run.finishedAt = Date.now();
      // A finished run closes its streams: a subscriber must not hang on a
      // connection that will never carry another event.
      for (const stream of run.streams) stream.close();
      run.streams.clear();
    }
  }

  const server = createServer((request, response) => {
    if (!authorized(request, config?.authToken)) {
      return sendJson(response, 401, { error: 'Unauthorized' });
    }
    const url = new URL(request.url ?? '/', 'http://gateway.local');
    const path = url.pathname;
    const runMatch = /^\/runs\/([^/]+)(\/(cancel|approve|events|proposal))?$/.exec(path);

    if (request.method === 'GET' && path === '/health') {
      return sendJson(response, 200, { ok: true, version: config?.version ?? 'unknown' });
    }
    if (request.method === 'GET' && path === '/capabilities') {
      return sendJson(response, 200, config?.capabilities ?? []);
    }
    // Durations and counters only — no prompt, no source text, no model output.
    if (request.method === 'GET' && path === '/metrics') {
      return sendJson(response, 200, metrics.snapshot());
    }
    // The procedure diagnostic: what exists, what a later scope shadowed, what
    // is malformed, and the tools each one declares. Read-only; execution still
    // goes through the gateway and the role contract.
    if (request.method === 'GET' && path === '/procedures') {
      const workspace = url.searchParams.get('workspace');
      let workspaceRoot = null;
      try {
        workspaceRoot = workspace ? workspaceRootFor(workspace) : null;
      } catch {
        workspaceRoot = null;
      }
      return sendJson(response, 200, describeProcedures(loadProcedureRegistry({ workspaceRoot })));
    }
    if (request.method === 'POST' && path === '/runs') {
      return readBody(request, async (body) => {
        // A run names a capability THIS gateway serves, or it does not start.
        // Governance (approval gate, mutation class) is decided from the
        // served entry: an unknown name used to resolve to `null`, which read
        // as "not mutating" — so a gateway degraded to its built-in default
        // (the /config mount hidden under the data volume) executed
        // agent.research / agent.notify with no approval at all. Refusing
        // here makes the drift visible where it happens, and the manager
        // reports the refused capability as such.
        const requested = String(body.capability ?? '').trim();
        const served = (config?.capabilities ?? []).map((capability) => String(capability?.name ?? ''));
        if (!requested || !served.includes(requested)) {
          return sendJson(response, 400, {
            error: requested
              ? `unknown capability "${requested}": this gateway serves ${served.join(', ') || 'nothing'}`
              : 'the run must name a capability',
            served,
          });
        }
        const capability = capabilityFor(requested);
        const operation = String(body.operation ?? 'run');
        const operations = Array.isArray(capability?.operations) && capability.operations.length > 0
          ? capability.operations.map(String)
          : ['run'];
        if (!operations.includes(operation)) {
          return sendJson(response, 400, {
            error: `operation "${operation}" not offered by ${requested} (offered: ${operations.join(', ')})`,
            served,
          });
        }
        const runId = nextRunId();
        const run = {
          runId,
          status: 'running',
          events: [],
          streams: new Set(),
          sequence: 0,
          droppedThrough: 0,
          finishedAt: null,
          controller: new AbortController(),
          resolveApproval: null,
          rejectApproval: null,
          approvalGate: () => new Promise((resolveGate, rejectGate) => {
            run.resolveApproval = resolveGate;
            run.rejectApproval = rejectGate;
          }),
        };
        runs.set(runId, run);
        void executeRun(run, body);
        sendJson(response, 200, { runId, status: 'running' });
      });
    }
    if (runMatch) {
      const runId = runMatch[1];
      const sub = runMatch[2];
      const run = runs.get(runId);
      if (!run) return sendJson(response, 404, { error: `unknown run ${runId}` });

      if (sub === '/events' && request.method === 'GET') {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const asFrame = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
        // Always first: the client learns which instance it is talking to
        // before it decides to trust its cursor.
        asFrame({ type: 'stream_epoch', epoch: STREAM_EPOCH, ts: now().toISOString() });
        const requestedEpoch = url.searchParams.get('epoch');
        if (requestedEpoch && requestedEpoch !== STREAM_EPOCH) {
          asFrame({
            type: 'degraded',
            capability: 'stream',
            cause: 'the gateway restarted since the last cursor',
            fallback: 'reconnect from a fresh subscription; no events were replayed',
          });
          return response.end();
        }
        const afterRaw = url.searchParams.get('after');
        const after = afterRaw != null && afterRaw !== '' ? Number(afterRaw) : null;
        if (Number.isFinite(after) && after < (run.droppedThrough ?? 0)) {
          asFrame({
            type: 'degraded',
            capability: 'stream',
            cause: `events up to sequence ${run.droppedThrough} left the runtime buffer`,
            fallback: 'replaying only the events still retained',
          });
        }
        // Replay strictly AFTER the cursor: a reconnect must never duplicate an
        // event the client already delivered.
        const replay = Number.isFinite(after)
          ? run.events.filter((event) => Number(event.sequence) > after)
          : run.events;
        for (const event of replay) asFrame(event);
        // A finished run has no live tail: close rather than let a subscriber
        // hang on a connection that will never carry another event.
        if (TERMINAL.has(run.status)) return response.end();
        const stream = {
          write: asFrame,
          close: () => { try { response.end(); } catch { /* already closed */ } },
        };
        run.streams.add(stream);
        request.on('close', () => run.streams.delete(stream));
        return;
      }
      if (sub === '/cancel' && request.method === 'POST') {
        run.aborted = true;
        run.controller.abort();
        run.status = 'cancelled';
        stopHeartbeat(run);
        run.rejectApproval?.(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
        return sendJson(response, 200, { ok: true });
      }
      if (sub === '/approve' && request.method === 'POST') {
        return readBody(request, async (body) => {
          if (body.approved === false) {
            run.status = 'cancelled';
            run.rejectApproval?.(Object.assign(new Error(body.reason ?? 'refused'), { name: 'AbortError' }));
            return sendJson(response, 200, { ok: true, status: 'cancelled' });
          }
          run.resolveApproval?.(body.scope ?? null);
          sendJson(response, 200, { ok: true });
        });
      }
      if (sub === '/proposal' && request.method === 'GET') {
        if (!run.worktreeProposal) {
          return sendJson(response, 404, { error: `run ${runId} carries no worktree proposal` });
        }
        return sendJson(response, 200, { runId, proposal: run.worktreeProposal });
      }
      if (request.method === 'GET') {
        return sendJson(response, 200, {
          runId: run.runId,
          status: run.status,
          ...(run.result ? { result: run.result } : {}),
          ...(run.error ? { error: run.error } : {}),
        });
      }
    }
    sendJson(response, 404, { error: 'not found' });
  });

  server.listen(port);
  // Stale worktrees (merged elsewhere, abandoned reviews, crashed runs) are
  // pruned at startup: the hands are bounded in time too. Best-effort — a
  // workspace whose worktrees cannot be cleaned still serves.
  void pruneStaleWorktrees({
    workspacesRoot: process.env.GATEWAY_WORKSPACES_ROOT ?? '/workspaces',
  }).then((result) => {
    if (result.pruned.length > 0) {
      console.warn(`pruned ${result.pruned.length} stale agent worktree(s): ${result.pruned.map((entry) => `${entry.workspace}/${entry.runId}`).join(', ')}`);
    }
  }).catch(() => {});
  // A finished run is kept only long enough for a late status poll; after that
  // its buffer and streams are pure memory. The purge is logged.
  const sweeper = setInterval(() => {
    const cutoff = Date.now() - RUN_TTL_MS;
    for (const [id, run] of runs) {
      if (!TERMINAL.has(run.status)) continue;
      if (!run.finishedAt || run.finishedAt > cutoff) continue;
      for (const stream of run.streams) stream.close();
      runs.delete(id);
      console.warn(`gateway: purged finished run ${id}`);
    }
  }, Math.max(1_000, Math.min(60_000, RUN_TTL_MS)));
  sweeper.unref?.();
  server.on('close', () => clearInterval(sweeper));
  return server;
}

// The Deep Agent writes its proposals in the final answer as
// {"planExpansionRequest": {...}}. Parse defensively: the whole content as
// JSON first, then the first balanced {...} block containing the key. A
// proposal must name a non-empty capability — anything else stays prose and
// the manager simply reads the content.
function extractPlanExpansionRequest(content) {  const text = String(content ?? '');
  const candidates = [];
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') candidates.push(parsed);
  } catch {
    const open = text.indexOf('{');
    if (open !== -1) {
      for (let depth = 0, i = open; i < text.length; i += 1) {
        if (text[i] === '{') depth += 1;
        if (text[i] === '}') depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(open, i + 1));
            if (parsed && typeof parsed === 'object') candidates.push(parsed);
          } catch { /* keep scanning for a later balanced block */ }
          break;
        }
      }
    }
  }
  for (const candidate of candidates) {
    const request = candidate?.planExpansionRequest ?? candidate;
    if (request && typeof request === 'object'
      && typeof request.capability === 'string'
      && request.capability.trim() !== '') {
      return request;
    }
  }
  return null;
}

// When a token is configured, every route requires it — including /health,
// mirroring the manager's own runtime (7788). No token configured = no auth
// (dev mode).
function authorized(request, token) {
  if (!token) return true;
  const header = String(request.headers.authorization ?? '');
  return header === `Bearer ${token}`;
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function readBody(request, handler) {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    let body = {};
    try {
      body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    } catch {
      return sendJson(request.socket && { writeHead: () => {}, end: () => {} }, 400, { error: 'invalid JSON' });
    }
    handler(body).catch((error) => {
      console.error('run handler error:', error);
    });
  });
  return undefined;
}

export { TERMINAL, extractPlanExpansionRequest };
