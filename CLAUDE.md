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
  (the last mutation before the model call), refuses at execution any call
  that sneaks through — the second layer is what protects a future backend
  swap — and turns a FAILING tool into a `status: 'error'` ToolMessage the
  model can adapt to, instead of letting it abort the run: a curation run died
  entirely on one `wiki_read_page` naming a page the model had guessed, before
  producing any proposal. Only an AbortError escapes;
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
  re-expresses the virtual path for the inner call. READS and WRITES alike keep
  the canonical (realpath) containment check (`confineForRead` /
  `confineForWrite`): reads were lexical only, so `ls`/`grep`/`read_file`
  followed a symlink out of the worktree. Feeding `/` straight to the host-path
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

Six named roles (`src/collective.js`): **Scout** (finds material), **Red Team**
(lot 6 — red-teams the RAW material: thin evidence, single-source claims,
contradictions), **Analyst** (structures it), **Critique** (structured
objections — one `[objection] severity: blocking|non-blocking — <path> — reason`
line per problem, NEVER blocks), **Redactor** (writes the corrections, worktree
runs only), **Archivist** (learned / obsolete / to re-verify). A capability's
`subagents` list selects which roles run.

The roles are scheduled by a declared GRAPH, not a list
(`COLLECTIVE_ROLE_GRAPH`): `scout` and `redteam` depend on nothing and may run
in parallel; `analyst` depends on `scout`, `critique` on `analyst`, `redactor`
on `analyst`/`critique`/`redteam`, `archivist` on `redactor`. Each role's input
is its TRANSITIVE dependencies' outputs in canonical order, so a parallel finish
order cannot reorder the context. `GATEWAY_COLLECTIVE_CONCURRENCY` is **1
(sequential) by default** and raising it is an explicit act: the plan gates the
parallel collective on phase metrics (p95 improves without losing an objection,
`GET /metrics`). The first role failure while roles are in flight lowers it back
to 1 and emits a `degraded` (`collective-concurrency`) — a silent fallback
would hide the bug the parallel mode introduced. An internal AbortController,
composed with the run's signal, cancels the roles still in flight when a
required role fails or the run is cancelled: otherwise they keep spending
tokens and emit findings that reach a closed stream. Every role's whole setup
is guarded, so a construction failure is a role failure, not a raw rejection
leaving siblings unhandled.

The per-role frontier is DECLARED, not inferred from `role === 'redactor'`:
`ROLE_TOOL_POLICY` gives each role its tool classes (`read`, plus `worktree` for
the Redactor alone), and the effective set is the intersection with the run's
pool — the manager's pool stays the ceiling. Any role whose declared classes
deny part of the pool is journalled as a `notice`, so a narrowing boundary is
auditable. An unknown role fails closed to reads.

The roles run as **bounded single-agent runs driven by the gateway**, each with
isolated context (own system prompt, own thread `<workspace>:<runId>:<role>`,
own boundary allow-list — the Critique and the Red Team have no write tools by
construction), passing a bounded handoff section to their dependents; the main
agent then assembles the final answer and must repeat unresolved objections
(from Critique AND Red Team) verbatim under `## Objections`. The gateway emits
`subagent_started` / `subagent_finished` / `tool_*` SSE events per role — the
manager's `runtimeEventAdapter` already surfaces them.

Deliberately NOT built on deepagents `subagents`: 1.13.2's subagent path and
its subagent streaming (issue #284) remain the open JS/Python question the
refonte report records. Sequencing in our code is the same collective without
that dependency, and the frontier test stays authoritative either way. If a
future deepagents version fixes the subagent path, this is the seam to
re-evaluate — the role specs and the event vocabulary stay unchanged.

## Metrics

`GET /metrics` returns local, content-free phase metrics: per-phase p50 / p95 /
avg duration plus tool and page counts, and run / heartbeat / degraded counters.
`phase_finished` carries `durationMs` (a fact, never content). Each phase keeps
a BOUNDED sliding window of the last `GATEWAY_METRICS_WINDOW` durations (default
500), so the accumulator has a ceiling like every other one in the repo. This is
the measurement the lot 6 gate reads — "p95 improves without losing objections"
— and it carries no prompt, no source text, no model output.

## Procedures (lot 5b)

Reusable instructions a role can load — NOT "skills": the product already owns
that word for `.wiki/skills/` + the compiler. Another owner, another format,
another executor, another trust model.

- three scopes, precedence base (shipped) → team (`GATEWAY_PROCEDURES_TEAM_DIR`)
  → workspace (`<workspace>/.wiki/procedures`). A later scope WINS a name clash
  and the shadowed definition is reported, never arbitrated in silence. Each
  procedure is `<scope>/<name>/SKILL.md`, YAML frontmatter (`name`,
  `description`, `roles`, `tools`, optional `version`/`license`/`source`/
  `risk`/`resources`);
- the catalogue a role is shown is SANITIZED (name, description, scope, risk,
  tools) and offers ONLY a procedure whose declared `tools` are all inside the
  role's allow-list — a procedure can never widen the frontier. The body is
  fetched on demand through `gateway__read_skill`, the one enumerated addition
  to the MCP pool (`frontier.test.js` pins it): bounded, and the reader REPLAYS
  the same role filter, so a role can only read a body its catalogue offered
  (a hidden procedure is not readable by name);
- every `SKILL.md` is confined to its SCOPE directory — at load AND on the body
  read — so a symlinked `SKILL.md` is neither enumerated nor able to leak its
  metadata through the catalogue and into a role's prompt. The containment root
  is the scope, never the procedure's own (linked) directory;
- a body is UNTRUSTED reference material, framed as data in the prompt: bounding
  the tools does not bound the text, and the human-in-the-loop remains the
  mitigation for any side effect;
- `src/procedureImporter.js` accepts the compatible subset of the Claude/Codex
  `SKILL.md` format and produces an explicit report (`imported` / `adapted` /
  `refused` with reason). A procedure that needs a shell, a browser, a secret or
  a direct write is refused, never imported silently;
- `GET /procedures` is the read-only diagnostic: available, shadowed and
  malformed entries with their declared prerequisites.

## Memory

The Deep Agent keeps a **conversation memory per workspace**: the MAIN run is
invoked with `configurable.thread_id = <memory scope>` — the workspace name
today — and the thread state is checkpointed to
`<GATEWAY_CONFIG_DIR>/memory.sqlite` (SqliteSaver, one saver per process). A
workspace's run therefore resumes its previous thread, across runs and across
gateway restarts. A request without a workspace lands on the `default` thread.
Do not key the main thread on anything else: per-run ids silently disabled the
memory this section advertises, for several releases.

`resolveMemoryScope` (`src/agent.js`) owns the namespace, because a thread key
IS a read capability — it decides whose past conversation this run resumes. A
`memoryScope` sent by the manager may only REFINE the workspace the gateway
resolved (`<workspace>:<actorId>`, the multi-user shape); anything else — a
different workspace, a traversal, an unbounded string — falls back to the
workspace and emits `degraded`. An absent scope is the normal single-user case
and is NOT a degradation.

The collective's **role threads stay bounded to one run**
(`<workspace>:<runId>:<role>`), and are deliberately not derived from the main
thread: they were, so making the main thread stable would have made them stable
by side effect. A Critique re-raising an objection settled three runs ago
degrades the collective instead of helping it. Their checkpoints are deleted
once the role finishes — bounded to the run means no reader afterwards.

The memory is BOUNDED, in three pieces that ship together:

- the **workspace dossier** (`src/dossier.js`) is the durable digest of the
  thread — the Archivist's factual memory and the unresolved objections — in
  its OWN table of the same `memory.sqlite` (not a second saver, not a second
  file). The next run reads it as a bounded `## Workspace memory` section, so a
  rotation costs the transcript, never the conclusions. A write MERGES: an
  empty run never clears the summary, objections accumulate (deduplicated on
  path+statement, capped by recency), and only an explicit resolution closes
  one — the Archivist emits `[resolved] <path> — <statement>` to do so.
  Silence is never resolution: a run that omits an objection has ignored it.
  When the ceiling abandons an objection it emits a `notice memory.capped`
  naming it — a silent cap would be the same defect it exists to prevent;
- **compaction**: after a run whose main thread holds more than
  `GATEWAY_MEMORY_MAX_CHECKPOINTS` checkpoints (default 200), the thread is
  rotated (`deleteThread`) and a `notice` is emitted — the dossier survives;
- **eviction**: at the start of every run, dossiers untouched for more than
  `GATEWAY_MEMORY_TTL_MS` (default 30 days) are purged with their threads, each
  announced as a `notice`. `GATEWAY_MEMORY_MAX_CHARS` (default 4000) bounds the
  injected section. A missing or unwritable volume emits `degraded` and the run
  continues without memory — a lost memory never loses the run.

## Transport

The SSE route is a cursor protocol, not a fire hose. Each stream's first frame
is `stream_epoch` (one identity per process). `/runs/:id/events` honours
`?after=<sequence>` by replaying strictly after it, and `?epoch=<id>` by
refusing a mixed history — a different epoch emits a `degraded` and closes, no
replay. `run.events` is bounded (`GATEWAY_MAX_RUN_EVENTS`, default 5000) and
finished runs are purged after `GATEWAY_RUN_TTL_MS` (default 10 min); a cursor
older than what the buffer retains is told events were lost. A stream is closed
once its run is terminal, so a subscriber never hangs on a dead tail.

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
