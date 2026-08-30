# wiki-agentic-gateway

External **agentic runtime gateway** for Wiki Manager: a standalone service
that runs Deep Agents and exposes the `RuntimeProvider` HTTP contract the
manager discovers through `agent-runtimes.json`
(`llm-wiki-manager/docs/agentic-runtime.md`).

## Contract

```
GET  /health            → { ok, version }
GET  /capabilities      → [ { name, operations, aliases, description, mutationClass } ]
POST /runs              → { runId, status }             (non-blocking)
GET  /runs/:id          → { runId, status, result? }
POST /runs/:id/cancel   → { ok }
POST /runs/:id/approve  → { ok }                        (HITL decision)
GET  /runs/:id/events   → SSE `data: {json}\n\n`, replay then live
```

## Run

```bash
npm install
node bin/wiki-agentic-gateway.js        # GATEWAY_PORT (7789), GATEWAY_AUTH_TOKEN
```

or via Docker: `dotdrelle/wiki-agentic-gateway` (port 7789).

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

The runtime has **eyes, ideas and a mouth** — but no hands on the workspace:

- **eyes**: read tools (wiki) and, when declared, web search;
- **mouth**: side-effects such as mail, declared `approvalGated` and gated by
  the HITL (`approval_required` → the manager pauses → `/approve` → `POST
  /runs/:id/approve`);
- **hands**: never. Workspace changes are proposals
  (`planExpansionRequest` in the run result) that the manager integrates into
  its DAG under approval.

`mcp.config.json` declares the pool and the capabilities; `src/agent.js` is the
single Deep Agents integration point; `src/server.js` owns the HTTP contract.
