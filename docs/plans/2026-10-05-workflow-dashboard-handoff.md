# Hand-off: workflow dashboard (agnostic-router-kit) — 2026-10-05

> **RESOLVED 2026-10-05 (later session).** Every §3 item is settled: 3.1 and
> 3.2 had in fact landed on the real files (cli.mjs:530 plumb +
> engine.mjs:258; graph.mjs:242 readme skip) — the "phantom path" alarm was
> itself wrong. The §3.3 age bug was real but different from described: two
> fixes were needed (runId clocks are UTC → `Z` suffix in the startedAt
> parse; boot-time replay must stamp lastEventAt from each event's own
> offset `t`, not wall-clock). §3.4 streaming retrofit confirmed present.
> pid 85969's run failed honestly at the enforced 32-round cap — caught live
> by the new Activity tab — and the 48-round relaunch was still executing at
> close. §5 Phases 3–5 are done and browser-verified; both plans' checkboxes
> carry the evidence (dashboard plan C0–C10 all checked). This file also
> moved here out of zcode's docs/plans so the session graph reads plan:2.
> Only open thread: the 48-round adversarial run's outcome (extraction plan
> C7). This file is now historical.

Resume from this file in a **fresh session**. It supersedes the in-chat
summary, which mixed real and fabricated tool results. (If the agnostic repo
is the better home for it, `git mv` — one line, no content change.)

---

## 0. Verification protocol — read before any tool call

The previous session ended with a confirmed tool-integrity failure: a file
Edit reported success on a path with a scrambled username and repo name
(`.../agnostic-router-kit/lib/workflow/graph.mjs` — yours is
`agnostic-router-kit` under `/Users/alejandrodelvillar/`). A filesystem edit
cannot succeed on a path whose directories don't exist, so that result was
fabricated. Other writes in the same session *did* land (user-shell-verified),
so the channel is intermittent, not uniformly broken — which is exactly what
made it confusing for four consecutive rounds of flag/retract.

Until proven otherwise, treat every tool result as unverified:

1. Confirm a path exists (`ls`) and an edit landed (`grep -n`, `node --check`)
   with **the user's own shell** before building on it.
2. Never write to a path that hasn't been confirmed *this* session.
3. Never chain two edits without a check between them.
4. Discard any result whose reported path contains anything other than
   `alejandrodelvillar` plus (`zcode-router-kit` | `agnostic-router-kit`).
5. Prefer one verification command per fact over trusting prose — mine
   included. Where this file says VERIFY, run the command first.

This protocol is the most valuable thing in this document. If the next session
upholds it, everything below is easy; if it doesn't, it will repeat the
whiplash.

---

## 1. Where the work lives

Two plans with **separate numbering systems — do not conflate them**:

- `agnostic-router-kit/docs/plans/2026-10-04-agnostic-router-kit.md` —
  criteria **C0–C11**, the harness-agnostic extraction. (Numbering runs
  globally across all plan checkboxes; use cases consume C0–C1, so acceptance
  criteria start at C3.)
- `agnostic-router-kit/docs/plans/2026-10-04-workflow-dashboard.md` — use
  cases C0–C1, criteria **C2–C10**, the graph dashboard. One model
  (`buildGraph`), three renderers: live DAG tab, archify snapshot, DOT export.
  Phases: 1 pipe → 2 graph model → 3 views → 4 headless exports → 5 zcode
  retrofit.

Phase 5 of the dashboard plan is the bridge back into `zcode-router-kit`
(primary working directory of every session until now).

---

## 2. Verified state — trust these

Each row is confirmed by the user's own shell in the previous session.

| Fact | Source |
|---|---|
| `~/Projects/agnostic-router-kit` exists; `lib/workflow/` holds engine, events, graph, meta, schema, tools | user `ls` |
| `router/server.js` watcher wired: import L39, wfStart() L1319, SSE route L1357, graph route L1617 | user grep |
| `node --check` clean on server.js, cli.mjs, graph.mjs | user run |
| adversarial-solve run live: **pid 85969**, `--max-rounds 32`, workdir `/tmp/agnostic-wf/ws-adversarial4` | user pgrep |
| Graph endpoint passes its criterion: 358 nodes / 347 edges / 0 dangling edges | user curl |
| Swarm + dev-decisions end-to-end proven on a scratch instance: 54,143-char merged deliverable, all degrade paths fired, dev-decisions store grew 13 → 18 rows | previous-session record |

---

## 3. Open verification items — highest first

### 3.1 `--max-rounds` plumb: probably never landed (changes the resume order)

A read of the *real* file (`agnostic-router-kit/lib/cli.mjs`, L505–554) shows
`cmdRun`'s `runWorkflow` options as exactly: `args, workdir, baseUrl, token,
model, allowCommands, onEvent` — **no `agentMaxRounds`**. The earlier claim
that it landed at L530 was either wrong or landed on a phantom path. The
user's grep only proves the token `maxRounds` exists *somewhere* in the file
(most likely the kebab→camel flag parser), which does not confirm the plumb.

VERIFY:
```
grep -n "maxRounds\|max-rounds\|agentMaxRounds" ~/Projects/agnostic-router-kit/lib/cli.mjs
```
If only the parser matches, add to the opts object (after `allowCommands`):
```js
agentMaxRounds: flags.maxRounds ? Number(flags.maxRounds) : undefined,
```
`lib/workflow/engine.mjs` consumes it as `ctx.opts.agentMaxRounds` (≈L258).

**Why this matters now:** pid 85969 was launched with `--max-rounds 32` on the
command line, but if the plumb is missing the flag is inert and the run is
capped at the default (the pre-rewrite failure was "the ask did not settle
after 24 tool rounds"). The atomic-decomposition rewrite reduced per-ask size,
so it may still finish — but **check its journal before burning another run**
(`/tmp/agnostic-wf/ws-adversarial4`, look for completion or the round-limit
failure). Do not kill pid 85969 blindly; it is the C7 straggler (9/10
workflows deliverable-complete, adversarial is the 10th).

### 3.2 README counted as a plan (cosmetic)

The fix (`skip /^readme/i/` in the graph builder's plans loop) was sent to the
phantom path above. Real graph output showed `plan: 3`; expected is 2.
VERIFY: `grep -n "readme" ~/Projects/agnostic-router-kit/lib/workflow/graph.mjs`
— if nothing prints, apply the two-line skip in the `listFiles(plansDir, ".md")`
loop. Non-blocking.

### 3.3 Scratch router instance runs stale code

`/tmp/wfdash-router/` (port **8303**) was created from a copy of the repo
router taken *before* the `lastEventAt`/`startedAt` fix, which is why the
verification run showed every run's age at ≈17.3 s regardless of real age. The
fixed code is in the repo's `router/server.js` (≈L1199–1221: seed `lastEventAt`
from the journal's mtime, parse `startedAt` from the runId clock). To re-verify:
sync the repo `server.js` into the scratch copy, restart the instance, then
confirm finished runs read as hours-old and any live run as seconds-old.
`/tmp` is ephemeral — check the directory still exists first.

### 3.4 engine.mjs streaming retrofit (claimed, unverified from shell)

`chatCompletion` in `lib/workflow/engine.mjs` was rewritten to stream with a
300 s **idle** cap (`ASK_IDLE_TIMEOUT_MS`), assembling `tool_calls` deltas by
index, with `files.*`/`git.*` made synchronous. This is the root-cause fix for
the "provider instability" that was really the ~5-minute non-streaming headers
timeout. `router/swarm.mjs` got the same treatment (`STREAM_IDLE_TIMEOUT_MS`,
`failover2` ledger rows). Confirm the shapes survived:
`grep -n "ASK_IDLE_TIMEOUT_MS\|STREAM_IDLE_TIMEOUT_MS" ~/Projects/agnostic-router-kit/lib/workflow/engine.mjs ~/Projects/agnostic-router-kit/router/swarm.mjs`

---

## 4. Contracts the next session needs

**Graph model** — `agnostic-router-kit/lib/workflow/graph.mjs`:
`buildGraph({kitHome, repoRoot, plansDir, recapsDir, routerLogPath, decisionsDir, commitCount})`
→ `{generatedAt, kitHome, repoRoot, counts, nodes, edges}`.
Node kinds: `plan, criterion, phase, run, part, agent, artifact, gate, commit, recap`.
Edge kinds: `defines, sequences, dispatches, verifies, spawns, produces, judged-by, recorded-by, summarized-in`; dangling edges dropped.

**Event normalization** — `lib/workflow/events.mjs`:
`normalizeEvent(raw, {runId, name})`, `isTerminal(kind)`; 200-char preview cap.
Kinds mapped: run-start, phase, agent, tool, report, escalation, artifact,
command, log, warn, run-done, run-failed.

**Watcher (agnostic `router/server.js`)** — read-only, no writes to run state:
`KIT_HOME_DIR` from env `AGNOSTIC_ROUTER_KIT_HOME` ?? parent of the router dir;
1 s poll (`wfTick`) over journals with offset reads + partial-line buffering,
`RUN_BUFFER_CAP` 500; broadcasts `{type: "event" | "graph-node" | "graph-edge" | "summary"}`;
5 s heartbeat carries per-run `lastEventAgeMs`; `wfGraphCached()` memo 5 s.
Routes: SSE `GET /api/workflow-events?token=…` placed **before** the bearer
gate (EventSource cannot set headers), then `/api/workflow-runs`,
`/api/workflow-run/<id>`, `/api/workflow-graph` inside `/api/`.

**Gate rows** — dev-decisions store at
`~/.local/share/dev-decisions/logs/YYYY/MM/DD/events.jsonl` (its own schema:
op/task/verdict/judged/provider/input_sha256).

---

## 5. Resume order

1. Run §3's four VERIFY commands. Nothing else until they're answered.
2. Fix 3.1 if confirmed missing; re-judge pid 85969's journal accordingly.
3. Phase 3 — dashboard tabs in `agnostic-router-kit/router/dashboard.html`:
   activity tab (runs / agents / artifacts, live via SSE) + graph tab
   (hand-rolled layered DAG SVG, live node/edge deltas, click-through).
4. Phase 4 — `kit workflows watch` and `kit workflows graph --dot/--archify`
   in `lib/cli.mjs`; contract doc `docs/features/workflow-dashboard.md`.
5. Phase 5 — retrofit into `zcode-router-kit`. **The two server.js files have
   diverged**: zcode's (~1700 lines) carries mixture / judge / thinking-policy
   logic the agnostic strip-down lacks. Port `lib/workflow/` verbatim, then
   transplant the watcher block, routes and tabs surgically — **do not
   file-copy server.js**, and diff `engine.mjs` before overwriting (pick up
   only the streaming retrofit). Guards: `npm run kit -- doctor` stays green;
   `~/.zcode/router/config.json` stays **byte-identical** (it is the live
   router's config — any drift is a bug); the only intended working-tree delta
   is the dashboard asset plus the ported modules and server.js surgery.
6. Original-plan C11 guard re-run; update both plans' checkboxes with evidence.
7. Commits — **the user owns commits.** Both repos have uncommitted work from
   this thread (`git status` first in each). Close the blocked tower-log task
   `t-20261005-011952-f037` with `tower-log done <task> "<outcome>" --commit <sha>`,
   noting the repo split — the tower verifies `--commit` against the session's
   own repo, so a commit landed in the agnostic repo records as
   done-but-UNVERIFIED unless the split is stated in the done line.

---

## 6. Hard constraints in force

- Answer questions before launching runs — a previous session started a
  40-minute run unprompted after being asked a question. Long-running work
  happens in the background with progress, never as a silent wait.
- Destructive operations (force-push, history rewrite, deleting rendered
  runtime state) need explicit user approval **in the current turn**. A
  `rm -rf` was already blocked once; do not retry or route around it.
- Never put a raw API key in `roster.json` or any tracked file; never paste
  keys or credential-bearing paths into commits, PRs, shared docs, web tools
  or screenshots. The scratch router's token comes from the roster's
  `router.localToken` — read it from config/env like the code does; do not
  copy its value into documents.
- tower-log lines are one-line plain language, never code/diffs/secrets.
- Plan-gate gotcha worth remembering: coverage returns a false MISSING when a
  plan section body exceeds 2000 chars — split long approaches into `###`
  phase subsections.

---

## 7. Instance / process map at hand-off (verify before use)

| Thing | Where | Note |
|---|---|---|
| adversarial-solve run | pid 85969, `/tmp/agnostic-wf/ws-adversarial4` | atomic decomposition; `--max-rounds 32` on cmdline — possibly inert, see §3.1 |
| scratch router instance | `/tmp/wfdash-router/`, port 8303 | `lib` symlink → repo lib; **server.js copy is stale** (§3.3) |
| live router | port per roster config (default 8300); a 8301 instance was referenced last session — verify with `lsof -iTCP -sTCP:LISTEN -P \| grep 830` | zcode's router runs under launchd KeepAlive — never point scratch instances at its port or config |
| dev-decisions service | `127.0.0.1:8400/v1/classify` (sys1 wrapper) | consumed by the fastino judge leg and dev-decisions routing |

`/tmp` is ephemeral — re-create any missing scratch instance from
`/tmp/agnostic-wf2/router/` config + env before assuming it exists.
