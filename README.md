# wiki-agentic-gateway

External **agentic runtime gateway** for Wiki Manager: a standalone service
that runs Deep Agents and exposes the `RuntimeProvider` HTTP contract the
manager discovers through `agent-runtimes.json`
(`llm-wiki-manager/docs/agentic-runtime.md`).

## Contract

```
GET  /health            → { ok, version }
GET  /capabilities      → [ { name, operations, aliases, description, mutationClass, worktree?, subagents? } ]
POST /runs              → { runId, status }             (non-blocking)
GET  /runs/:id          → { runId, status, result? }    (result may carry worktreeProposal)
POST /runs/:id/cancel   → { ok }
POST /runs/:id/approve  → { ok }                        (HITL decision)
GET  /runs/:id/proposal → { runId, proposal }           (worktree runs)
GET  /metrics           → content-free phase metrics (bounded sliding window)
GET  /procedures        → available / shadowed / malformed procedures
GET  /runs/:id/events   → SSE `data: {json}\n\n`, replay then live (stream_epoch, run_*, approval_required, message, tool_*, subagent_*, phase_*, progress, finding, degraded, notice; the heartbeat stays ephemeral)
```

## Run

```bash
npm install
node bin/wiki-agentic-gateway.js        # GATEWAY_PORT (7789), GATEWAY_AUTH_TOKEN
node bin/wiki-agentic-gateway.js import-procedure <SKILL.md> [--write] [--dir <scopeDir>]
```

`import-procedure` previews the compatible Claude/Codex `SKILL.md` subset — the
report is `imported`, `adapted` or `refused` with the reason — and writes only
with `--write`, into `--dir` or `GATEWAY_PROCEDURES_TEAM_DIR`.

or via Docker: `dotdrelle/wiki-agentic-gateway` (port 7789, image ships git for
the worktree runs).

There is **no model configuration here**: the manager sends its active
profile's model (baseUrl + model + apiKey) with every run — same LLM as the
manager itself, following `/config use` automatically. A run without a model
fails explicitly.

Then declare it in the manager's `agent-runtimes.json`:

```json
{ "runtimes": [ { "id": "deepagents", "type": "deepagents",
    "endpoint": "http://agent-runtime:7789", "enabled": true,
    "capabilities": [ …same list as /capabilities… ] } ] }
```

## The rule of the pool

The runtime has **eyes, ideas and a mouth** — and, since 0.15.86, **confined
hands on a branch**:

- **eyes**: read tools (wiki) and, when declared, web search;
- **mouth**: side-effects such as mail, declared approval-gated and gated by
  the HITL (`approval_required` → the manager pauses → `/approve` → `POST
  /runs/:id/approve`);
- **hands**: capabilities declared `worktree: true` (today `agent.curate`) get
  a git worktree per objective behind a canonical-path check; the run result
  carries a `worktreeProposal` (changed files, their new content, unified
  diff, the agent's justification and the collective's unresolved
  `[objection]` lines). The workspace is NEVER written here — the human merges
  or rejects on the served `/agent-proposals` page, and the merge IS the
  approval;
- everything else is a proposal (`planExpansionRequest` in the run result)
  that the manager integrates into its DAG under approval.

The harness frontier: deepagents attaches its own tools (filesystem set + a
generic subagent) under whatever the gateway declares. `src/agent.js` strips
them from every model call and refuses them at execution — pinned by a
contract test in `src/frontier.test.js`. The collective (`subagents: [...]`
per capability) runs the named roles — Scout, **Red Team**, Analyst, Critique,
Redactor, Archivist (the Red Team is supported but no packaged runtime declares
it) — as bounded runs ordered by a declared role graph, sequential by default
(`GATEWAY_COLLECTIVE_CONCURRENCY` raises it; `scout` and `redteam` may then run
in parallel, and the first in-flight role failure falls back to sequential with
a `degraded`), each with a per-role tool allow-list.

There is **no capabilities file of its own**: the gateway mounts the
manager's `agent-runtimes.json` (read-only) and serves the capabilities of its
own entry — one file, two readers. The model comes per run from the manager,
and so does the MCP pool (the manager sends it with every run; workspace-scoped
endpoints are per-run by nature).

Ceilings (all optional, defaults in parentheses): `GATEWAY_RECURSION_LIMIT`
(40) graph steps — a role that trips it hands over a partial result and only
fails when it gathered nothing; `GATEWAY_TOKEN_BUDGET` (500 000) estimated
tokens — a cumulative per-agent/per-run estimate checked before every model
call, so a whole-corpus curation may need it raised, and crossing it stops the
run before the next call with the reason announced; `GATEWAY_WORKTREE_MAX_FILES`
(40) / `GATEWAY_WORKTREE_MAX_DIFF_CHARS` (300 000) — beyond them the run fails
loudly and discards the branch. Memory: `GATEWAY_MEMORY_MAX_CHECKPOINTS` (200)
and `GATEWAY_MEMORY_MAX_THREAD_CHARS` (400 000) rotate the workspace thread
after a run, announced as `memory.compacted`; a model call whose prompt already
exceeds the provider context rotates the thread and retries the assembly once
(`degraded memory`); `GATEWAY_MEMORY_MAX_CHARS` (4000) bounds the injected
dossier and `GATEWAY_MEMORY_TTL_MS` (30 days) evicts inactive workspaces.
`GATEWAY_WORKTREE_MAX_AGE_MS` (7 days) prunes abandoned worktrees at startup.

`src/agent.js` is the single Deep Agents integration point; `src/worktree.js`
owns the confined backend and the worktree lifecycle; `src/collective.js` the
role definitions; `src/server.js` the HTTP contract.
