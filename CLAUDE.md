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
- the `plan` operation is always a dry-run: never pause, never mutate;
- `POST /runs` refuses (`400`, with the served list) a capability or operation
  this gateway does not serve. Governance is decided from the served entry, so
  an unknown name must never resolve to "not mutating" — a gateway degraded to
  its built-in default would otherwise run `agent.research` ungated.

### The harness frontier (lot 0)

`deepagents` attaches its own tools UNDER whatever the gateway declares — the
filesystem set (`ls, read_file, write_file, edit_file, delete, glob, grep,
execute`) and a generic `task` subagent. They write to the in-memory
`StateBackend` (declared explicitly, never defaulted), so nothing on the
workspace is reachable through them — but without the boundary the model is
*told* it can write, edit and delete, and pays those definitions in tokens.

`src/agent.js` closes the gap in one place:

- `createGatewayBoundaryMiddleware` (middleware name `GatewayToolBoundary`)
  strips every tool outside the run's MCP allow-list from the model request
  (the last mutation before the model call), and refuses at execution any
  call that sneaks through — the second layer is what protects a future
  backend swap;
- `buildGatewayAgent` is the single assembly used by both the runner and the
  contract test, with the backend declared explicitly;
- ceilings that did not exist: `GATEWAY_RECURSION_LIMIT` (default 40) and
  `GATEWAY_TOKEN_BUDGET` (default 500 000, estimated before each model call
  with the harness's own counter). The 600s task timeout stays.

`src/frontier.test.js` is the contract: it builds the production wiring with a fake
model and asserts the visible tool set is exactly the declared MCP pool.
A future `deepagents` version that adds a default tool fails that test by
name — the degradation announces itself instead of reopening the gap in
silence. Any change to the backend, the middleware order, or the deepagents
version must keep this test green.

### Worktree hands (lot 1, `worktree: true` capabilities)

A capability declared `"worktree": true` (today: `agent.curate`) arms real but
confined hands, and the merge is the approval:

- one git worktree per objective: `git worktree add -b agent/<runId>` under
  the workspace's `.wiki/agent-worktrees/<runId>` (gitignored state, same
  mount every container shares; the image carries git for this);
- the backend is `FilesystemBackend({ virtualMode: true })` wrapped by
  `createConfinedBackend` (`src/worktree.js`), because the inner backend takes
  the harness's **virtual** absolute paths rooted at the worktree (`/`,
  `/wiki/x.md`). The wrapper strips the leading `/`, resolves the remainder
  under the real root, refuses `..`/`~` and enforces lexical containment, then
  re-expresses the virtual path for the inner call; writes additionally keep the
  canonical (realpath) containment check. Feeding `/` straight to the host-path
  helper treated it as the host root and refused it (`path escapes the
  worktree: /`), which killed every curate run at its first `ls('/')`;
  `src/worktree.test.js` exercises the virtual root, read and write. Without the
  wrapper "the hands are bounded by the worktree" is false; it must move with
  the backend;
- the declared tool set widens to the filesystem names minus `execute`
  (`GATEWAY_WORKTREE_TOOL_NAMES`); `task` stays absent until lot 2;
- the run result carries `worktreeProposal` (`changedFiles`, per-file new
  `changes`, unified `diff`, workspace-relative worktree path, branch). The
  manager persists it into `.wiki/agent-proposals/`, the served review page
  (`/agent-proposals`) merges or rejects — the gateway NEVER writes the
  workspace, and a failed run removes its own worktree;
- the capability declares no `mutationClass`/`defaultRequiresApproval`: no
  pre-run approval pause — the human merge IS the approval.

### The collective (lot 2, declared per capability via `subagents: [...]`)

Five named roles (`src/collective.js`): **Scout** (finds material), **Analyst**
(structures it), **Critique** (structured objections — one
`[objection] severity: blocking|non-blocking — <path> — reason` line per
problem, NEVER blocks), **Redactor** (writes the corrections, worktree runs
only), **Archivist** (learned / obsolete / to re-verify). A capability's
`subagents` list selects which roles run, in the canonical order above.

The roles run as a **sequence of bounded single-agent runs driven by the
gateway**, each with isolated context (own system prompt, own thread
`<workspace>:<runId>:<role>`, own boundary allow-list — the Critique has no
write tools by construction), passing a bounded handoff section to the next;
the main agent then assembles the final answer and must repeat unresolved
objections verbatim under `## Objections`. The gateway emits
`subagent_started` / `subagent_finished` / `tool_*` SSE events per role — the
manager's `runtimeEventAdapter` already surfaces them.

Deliberately NOT built on deepagents `subagents`: 1.13.2's subagent path and
its subagent streaming (issue #284) remain the open JS/Python question the
refonte report records. Sequencing in our code is the same collective without
that dependency, and the frontier test stays authoritative either way. If a
future deepagents version fixes the subagent path, this is the seam to
re-evaluate — the role specs and the event vocabulary stay unchanged.

## Memory

The Deep Agent keeps a **conversation memory per workspace**: every run is
invoked with `configurable.thread_id = <workspace name>` (the manager sends the
workspace with each run), and the thread state is checkpointed to
`<GATEWAY_CONFIG_DIR>/memory.sqlite` (SqliteSaver, one saver per process). A
workspace's run therefore resumes its previous thread — across runs and across
gateway restarts. A request without a workspace lands on the `default` thread.
Do not key threads on anything else: per-run ids would silently disable the
memory the boundary advertises.

## Layout


```text
bin/wiki-agentic-gateway.js   CLI entry (port 7789 by default)
src/server.js                 HTTP contract (7 routes), in-memory runs, SSE
src/agent.js                  Deep Agents integration (single point): harness boundary, limits, buildGatewayAgent
src/frontier.test.js          Contract test: the model sees exactly the declared MCP pool
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
