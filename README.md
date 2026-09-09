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
GET  /runs/:id/events   → SSE `data: {json}\n\n`, replay then live (run_*, approval_required, message, tool_*, subagent_*)
```

## Run

```bash
npm install
node bin/wiki-agentic-gateway.js        # GATEWAY_PORT (7789), GATEWAY_AUTH_TOKEN
```

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
per capability) runs the named roles — Scout, Analyst, Critique, Redactor,
Archivist — as bounded sequential runs with per-role tool allow-lists.

There is **no capabilities file of its own**: the gateway mounts the
manager's `agent-runtimes.json` (read-only) and serves the capabilities of its
own entry — one file, two readers. The model comes per run from the manager,
and so will the MCP pool (workspace-scoped endpoints are per-run by nature).

Ceilings (all optional, defaults in parentheses): `GATEWAY_RECURSION_LIMIT`
(40) graph steps, `GATEWAY_TOKEN_BUDGET` (500 000) estimated tokens,
`GATEWAY_WORKTREE_MAX_FILES` (40) / `GATEWAY_WORKTREE_MAX_DIFF_CHARS`
(300 000) — beyond them the run fails loudly and discards the branch —
and `GATEWAY_WORKTREE_MAX_AGE_MS` (7 days), after which startup prunes
abandoned worktrees.

`src/agent.js` is the single Deep Agents integration point; `src/worktree.js`
owns the confined backend and the worktree lifecycle; `src/collective.js` the
role definitions; `src/server.js` the HTTP contract.
