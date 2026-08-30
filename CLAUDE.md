# Repository Guide

`wiki-agentic-gateway` is the external agentic runtime for `llm-wiki-manager`.
It is a **separate service and a separate npm package** — never a dependency
of the manager, which knows it only by URL and the HTTP contract below.

## Purpose

Run Deep Agents (`deepagents.js`) behind the `RuntimeProvider` contract, so
the manager can route open-ended analysis (`agent.review`, …) to an external
engine without embedding one. The manager stays agnostic: swap this engine for
another and nothing changes on its side.

## Boundary (do not violate)

Eyes, ideas and a mouth — no hands:

- the MCP pool is **read-only plus approval-gated tools** (mail). Never expose
  workspace write paths or orchestration tools (`agent_execute`,
  `production_start_job`) here — workspace changes are `planExpansionRequest`
  proposals the manager integrates into its DAG;
- mutating capabilities (`mutationClass` / `defaultRequiresApproval`) pause
  through the HITL: emit `approval_required`, stay `waiting_approval`, resume
  only on `POST /runs/:id/approve` with `approved: true`;
- the `plan` operation is always a dry-run: never pause, never mutate.

## Layout

```text
bin/wiki-agentic-gateway.js   CLI entry (port 7789 by default)
src/server.js                 HTTP contract (7 routes), in-memory runs, SSE
src/agent.js                  Deep Agents integration (single point)
src/config.js                 capabilities from the manager's agent-runtimes.json (own entry), token from env
```

## Version

Aligned with the coordinated release line (`0.15.66` at scaffold time), checked
optionally by `llm-wiki-manager/scripts/check-versions.js`. Built and pushed by
the workspace-root `build-and-push.sh` (`wiki-agentic-gateway` image) and
`build-local.sh` (`gateway` target).

## Validation

```bash
node --check bin/wiki-agentic-gateway.js src/server.js src/agent.js src/config.js
npm install && node bin/wiki-agentic-gateway.js   # then GET /health
```
