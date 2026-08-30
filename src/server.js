import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createAgentRunner } from './agent.js';

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
 *   GET  /runs/:id/events   -> SSE `data: {json}\n\n`, replay then live
 */
export function startGateway({
  port = 7789,
  config,
  createRunner = null,
  now = () => new Date(),
} = {}) {
  const runs = new Map();
  let sequence = 0;

  function nextRunId() {
    sequence += 1;
    return `gateway-${sequence}`;
  }

  function runFor(runId) {
    const run = runs.get(String(runId));
    if (!run) throw new Error(`unknown run ${runId}`);
    return run;
  }

  function emit(run, event) {
    const stamped = {
      ...event,
      runId: run.runId,
      ts: now().toISOString(),
      sequence: run.sequence++,
    };
    run.events.push(stamped);
    for (const write of run.streams) write(stamped);
  }

  function capabilityFor(name) {
    return (config?.capabilities ?? []).find((capability) => capability.name === name) ?? null;
  }

  // Resolved in the BODY, not as a default parameter: default initializers
  // evaluate in the parameter scope, which does not see `emit` — the closure
  // crashed with "emit is not defined" on the first tool callback.
  const resolveRunner = createRunner ?? ((run, model) => createAgentRunner({
    model,
    mcpServers: config.mcpServers,
    signal: run.controller.signal,
    onTool: (event) => emit(run, mapToolEvent(event)),
  }));

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
            readTools: Object.keys(config?.mcpServers ?? {}),
            mutations: [{ kind: capability?.mutationClass ?? 'default', summary: String(request.objective ?? '') }],
          },
        });
        await run.approvalGate();
        if (run.status === 'cancelled') return;
        run.status = 'running';
      }
      const runModel = request.model ?? null;
      if (!runModel?.baseUrl || !(runModel.model || runModel.name)) {
        run.status = 'failed';
        run.error = 'no model: the manager must send the active profile model with every run';
        emit(run, { type: 'run_failed', error: run.error });
        return;
      }
      const runner = resolveRunner(run, runModel);
      const result = await runner.run({
        objective: request.objective ?? request.input ?? null,
        operation,
        capability: request.capability ?? null,
        language: request.language ?? null,
      });
      run.result = { status: 'completed', content: result };
      run.status = 'completed';
      emit(run, { type: 'message', content: result });
      emit(run, { type: 'run_completed' });
    } catch (error) {
      if (error?.name === 'AbortError' || run.aborted) {
        run.status = 'cancelled';
        emit(run, { type: 'run_cancelled' });
        return;
      }
      run.status = 'failed';
      run.error = error instanceof Error ? error.message : String(error);
      // The operator watches this console: say WHY, like the manager does.
      console.error(`run ${run.runId} failed: ${run.error}`);
      emit(run, { type: 'run_failed', error: run.error });
    }
  }

  const server = createServer((request, response) => {
    if (!authorized(request, config?.authToken)) {
      return sendJson(response, 401, { error: 'Unauthorized' });
    }
    const url = new URL(request.url ?? '/', 'http://gateway.local');
    const path = url.pathname;
    const runMatch = /^\/runs\/([^/]+)(\/(cancel|approve|events))?$/.exec(path);

    if (request.method === 'GET' && path === '/health') {
      return sendJson(response, 200, { ok: true, version: config?.version ?? 'unknown' });
    }
    if (request.method === 'GET' && path === '/capabilities') {
      return sendJson(response, 200, config?.capabilities ?? []);
    }
    if (request.method === 'POST' && path === '/runs') {
      return readBody(request, async (body) => {
        const runId = nextRunId();
        const run = {
          runId,
          status: 'running',
          events: [],
          streams: new Set(),
          sequence: 0,
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
        for (const event of run.events) response.write(`data: ${JSON.stringify(event)}\n\n`);
        const write = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
        run.streams.add(write);
        request.on('close', () => run.streams.delete(write));
        return;
      }
      if (sub === '/cancel' && request.method === 'POST') {
        run.aborted = true;
        run.controller.abort();
        run.status = 'cancelled';
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
  return server;
}

function mapToolEvent(event) {
  return { type: event.done ? 'tool_finished' : 'tool_started', tool: event.name ?? 'agent' };
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

export { TERMINAL };
