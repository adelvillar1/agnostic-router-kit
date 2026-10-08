---
status: completed
created: 2026-10-08
updated: 2026-10-08
slug: diagram-refresh
---

# Plan: diagram-refresh — archify diagram maintenance as a router workflow

**Repo:** agnostic-router-kit (the plane surface lands once; the kit edition inherits it through the `workflow-plane` symlink and gains the loop, the doctor row, and its own diagram refresh). **Source:** the archify skill's refresh procedure, executed by hand after every wave since 2026-10-06 (`~/.zcode/skills/archify`, MIT). **Composition law, the reading this wave keeps:** the system diagram is the repo's claim about itself, the workflow diagrams are its claims about its own run — every node text, every edge, every `sources` entry is a claim with a file and lines that make it true. *The loop keeps the claims anchored to the code; the owner judges whether the claim is worth keeping.* Nothing in this plan decides what a diagram says — that is authoring, and it stays with the agent and the reader.

**The idea, stated once:** the diagrams go stale on every code wave, two ways — each source ref pins `path`/`line`/`end_line` at an old commit (any file move desyncs the map), and node text can quietly become false when the code it describes is rewritten. Today the refresh is a hand-run procedure: an agent greps every ref's anchor, re-reads ranges, edits the candidate, runs `archify finalize` (the receipt dance is mandatory — the HTML owns its browser-evidence path, so every round needs a fresh `--out-dir`), moves the receipts back, renders the stills, and reads the PNGs to accept them. The mechanical 80% is deterministic and re-runnable; the judgment 20% (what a wave changed, what a claim now means, whether the still looks right) is not. **A workflow owns the mechanical 80% and hands the judgment 20% up by name.**

## Approach

The wave is built around one rule that decides everything below, validated against the repo's live state this session: **a source ref is intact iff the bytes at its pinned range are identical to the bytes at that range in the pinned revision** (`meta.repository.revision`, already in every candidate). Run across the three current candidates — 61 refs, pinned at `be3659aa`, HEAD six commits later — the rule reports 61 intact, 0 moved, 0 changed, zero false positives, because the intervening commits touched only docs. That is the born-verified core: no label-text heuristics (15 of 61 labels are paraphrases that match nothing verbatim in the anchored code — "run route", "judge spec" — so token matching over-flags and would bury the real signal), no model call, no guessing. A ref that moved reports its new range (the pinned content located verbatim elsewhere in the file, byte-identical over the whole range); a ref whose anchored bytes were *edited* is not a move — the claim may now be false, and it is escalated to the agent, never auto-corrected.

On that rule, three capabilities, each exactly as capable as its grant and no more:

1. **The audit** (`world.diagram.audit`): reads the candidates, resolves paths against the repo, spawns one `git show` per distinct (revision, path) pair, and returns per-diagram verdicts — intact / moved (with old→new lines) / changed (agent's problem) / missing file — plus revision staleness. Pure read: it writes nothing, ever, and it is cheap enough for `kit doctor` to run it on every invocation.
2. **The re-pin** (`world.diagram.repin`, a pure function): applies *moved* verdicts only — rewrite `line`/`end_line`, repin the revision — and returns `{ candidate, changes }`. Runs twice = no second change. `changed` and `missing` refs are left exactly as authored and reported. This is the manual procedure's grep-and-verify step, executed: the audit proved the bytes are identical before the re-pin moves anything.
3. **The finalize** (`world.diagram.finalize`): spawns the archify CLI (allowlist: the one verb this wave speaks, `finalize`), runs the gates into a fresh `docs/architecture/refresh-<n>/`, and moves the receipt JSONs back beside the candidate — the whole fiddly dance the memory's procedure spells out for humans, encoded so it cannot be forgotten. Absence of the CLI is a configured absence: a refusal by name, the loop reports it, the kit proceeds as today — the same law as moli and dev-decisions.

The render leg needs no new surface: `docs/architecture/render-png.mjs` is the repo's own script, driven under the existing process grant (`world.run`). The workflow itself (`workflows/diagram-refresh.ts`) is report-first: audit → re-pin (mechanical moves only) → finalize what the re-pin touched → render stills → a markdown artifact that lists, per diagram, what moved, what changed and now needs a human reading, and the stills' sizes — with the eye-acceptance line standing in the artifact as an instruction, not a claim. The loop ends every run naming what it does not cover: it never authors a node, never verifies that a claim is still true, never repairs a layout the archify gates rejected, and never looks at the PNGs.

## Pinned interfaces (the delegation contract)

```js
// lib/workflow/services.mjs — the only new plane surface (the kit inherits it via node_modules/workflow-plane)
export const DIAGRAM_COMMANDS = ["finalize"];            // the one archify verb this wave speaks
export const DIAGRAM_TIMEOUT_MS = 300_000;               // finalize runs a real browser-check: a batch budget

// The audit. dir defaults to docs/architecture; cwd defaults to process.cwd(). Never writes.
diagramAudit({ dir, revision = "HEAD", cwd })
// → { ok, head, diagrams: [{ diagram, type, pinnedRevision, stale,
//      refs: { intact, moved: [{ path, from:[line,end_line], to:[line,end_line], label }],
//              changed: [{ path, from, label }], missing: [{ path, from, label }] } }],
//     summary: { intact, moved, changed, missing } }
//   A ref is intact when the bytes at [line..end_line] equal the bytes at that range in
//   `git show <pinnedRevision>:<path>` — identity, not similarity. Moved when the whole
//   pinned range is found verbatim elsewhere in the current file (the first full-range match
//   wins; no match is a changed verdict, never a guess). One git show per distinct
//   (revision, path); one `git rev-parse HEAD` per call. `ok:false` (git absent, dir absent)
//   is a refusal with the reason, not a throw.

// The re-pin. Pure: candidate JSON in, candidate JSON + changes out.
diagramRepin(candidateJson, movedRefs, { head })
// → { json, changes: [{ path, from, to }] } — moved refs rewritten, revision repinned;
//   anything not in movedRefs is byte-identical after. Second application is a no-op.

// The finalize. Spawns the archify CLI; absences are refusals by name.
diagramFinalize({ type, candidate, outDir, repoRoot, cwd }, { timeoutMs = DIAGRAM_TIMEOUT_MS })
// → { ok, type, outDir, receipts: [paths moved back], summary } on success;
//   { ok:false, reason } for: CLI not resolved ("archify CLI not found — the diagram grant
//   needs the archify skill (set ARCHIFY_BIN=/path/to/archify.mjs; see docs)"),
//   command outside DIAGRAM_COMMANDS (refused before spawn), timeout, non-zero exit
//   (stderr tail, verbatim). Receipts: every <stem>.*.json the run wrote into outDir moves
//   back beside the candidate; refresh-<n> is never reused (n = 1 + max existing).
//
// ARCHIFY_BIN (env) → ~/.zcode/skills/archify/bin/archify.mjs → ~/.agents/skills/archify/bin/archify.mjs
// Grant: "diagram" (default-off, like browser/tabular/semantic). Journal: kind "command",
// command "diagram_<audit|repin|finalize>", args.type/diagram, receipts count, refusal.
```

## The loop (workflows/diagram-refresh.ts — router-assignable, batch-only)

Phases, each naming its own refusal path (fail-open law: every not-ok branch ends the loop with the refusal's own words and the reports unchanged):

1. **Audit.** `world.diagram.audit()`. All-intact at HEAD → the loop's honest conclusion is "drift-free": skip to the render check, change nothing, done.
2. **Re-pin.** Per drifted candidate, `world.diagram.repin(json, moved)` → write the candidate (idempotent; every change journaled old→new). `--dry-run` reports without writing. Refs that `changed` stay pinned as authored and are the artifact's to-do list for the agent.
3. **Finalize.** Each candidate the re-pin touched (plus any named via `--scope`): `world.diagram.finalize` into `refresh-<n>/`, receipts moved back. CLI absent → named refusal; loop concludes "re-pinned, finalize awaits the archify CLI" and stops — the repin stands on its own.
4. **Stills.** `world.run("node", ["docs/architecture/render-png.mjs", …])` (`--check` verifies sizes without Chrome; the write leg needs headless Chrome and reports its own error verbatim).
5. **Report.** Markdown artifact: per-diagram verdict table, the unresolved refs with their labels, the receipts, the stills' sizes, and the standing line — *eye-verify the stills before committing*. `verified` names what the loop proved; `notCovered` names the four things it structurally cannot do (author claims, verify claim truth, repair a rejected layout, accept a still visually).

## Waves (the delegation map)

- **W1 — foundation (one agent):** the three interfaces in `services.mjs` (archify CLI resolution, allowlist, timeout, journal-free by the file's law) + the `diagram` grant row in `tools.mjs` + the `world.diagram` binding with grant-refusal journaling in `engine.mjs` + the `kit doctor` diagram row (archify CLI dim-if-absent, audit freshness counts — the audit is cheap enough for doctor by the one-git-show rule) + `tools/unit-services-diagram.mjs` (fixture candidates covering all four ref verdicts, idempotence, refusal sentences, allowlist, receipt move-back against a stub CLI, ARCHIFY_BIN resolution).
- **W2 — the loop (one agent):** `workflows/diagram-refresh.ts` + `tools/probe-diagram-refresh.mjs` (the C3 standard: a real temp git repo, a planted candidate with each drift class, a stub archify CLI, the real audit → repin → finalize loop body driven end-to-end, then a second pass proving idempotence and the archify-absent fail-open).
- **W3 — integration (me):** both editions `npm test`, `check:port`, the documentation pass, this wave's own archify sweep (executed by the procedure below), plan close + recap.
- **W4 — kit port (one agent):** `workflows/diagram-refresh.dwf.ts` (byte-identical to the engine's loop), the kit's own `lib/cli.mjs` doctor row, kit docs, and the kit's four-candidate refresh (its candidates carry the same shape and `meta.repository.revision` pins) — the plane surface needs no port: the `workflow-plane` symlink already inherits it, which W4 proves by execution.

## Documentation (in-wave, explicit)

README: the loop library gains diagram-refresh with its one-line what/when, and the grants bullet gains `diagram`. New feature doc `docs/features/diagram-lane.md` (house style): the staleness law (two ways), the identity rule and why label-matching is not it, what the loop does and refuses, the archify CLI resolution (this machine has the skill at `~/.zcode/skills/archify` — the built-ins live elsewhere and need `ARCHIFY_BIN`), and the acceptance discipline (the stills are read, never assumed — the fixed-context grep false-negative lesson). TROUBLESHOOTING: "diagrams audit moved/changed" (run the loop; `changed` refs are the agent's repair list — grep the label's anchor in the current file, re-read the range, and only then edit), "archify CLI not found", "finalize rejects the layout" (over-long sublabels and position collisions are the two known gate rejections — shorten or move, never widen; the gate's error names both boxes), "stills are byte-identical" (expected after a label-only edit — that is success, not a render failure). FUNC-SPEC + TECH-DOC: the plane surfaces list gains the diagram surface; the loop library table gains the row. CLAUDE.md Today's state. Plan closed with deviations; recap filed.

## Archify diagrams (in-wave, explicit — the wave's own recursion)

This wave moves the plane and `lib/cli.mjs`, so system-overview's chart changes for real: a new node for the diagram lane under the decision stack — the grant, the loop, the refresh dirs — with source refs to `lib/workflow/services.mjs` (the three functions), `lib/cli.mjs` (the doctor row), and `workflows/diagram-refresh.ts`. The authoring of that node is agent work (this plan does not license the loop to invent it). The wave's acceptance dogfood is the loop itself: after authoring, the loop runs against the real candidates — audit shows the new refs intact and the moved ones re-pinned, the finalize re-emits the HTML and receipts, `render-png.mjs` rewrites the stills, and **a human reads the PNGs** before commit. W4 repeats the same for the kit's four candidates (its plane diagram's module count is unchanged — `world.diagram` rides the shared plane, not a kit-local module). Until then the procedure stays exactly as it was: re-sync by anchor, finalize with a fresh `--out-dir`, receipts back, render, read.

## Verification

Evidence per criterion lands in the close-out bundle as it is produced, not reconstructed: C0–C2 via `tools/unit-services-diagram.mjs` output; C3–C5 via the executed probe `tools/probe-diagram-refresh.mjs` (the C6-precedent standard: drive the real composition over a real temp git repo and a stub CLI, count what ran, prove the absence path and the no-second-change property by execution and grep); C6 via `kit doctor` output on this machine (archify present) and with `ARCHIFY_BIN` pointed at nothing (the dim absence row, verbatim); C7 via the both-edition `npm test` + `check:port` runs, the docs pass, and this wave's re-finalized stills (committed PNGs + the eye-verification recorded in the recap); C8 via the kit port's proof — the same unit suite passing through `node_modules/workflow-plane` in the kit, plus the kit's four-candidate audit run.

## Acceptance criteria

- [x] **C0** the audit matches the pinned contract: all four ref verdicts correct on a planted fixture (planted moves, a planted edited range, a planted deleted file, untouched refs), one `git show` per distinct (revision, path), revision staleness reported per diagram, zero writes from the audit path, `ok:false` refusals name their reason, journaled with the diagram and counts.
- [x] **C1** the re-pin is pure, bounded, and idempotent: only `moved` verdicts are applied; a `changed` or `missing` ref is byte-identical after any number of runs; a second repin application produces zero changes; the revision repin lands with the same batch.
- [x] **C2** the finalize matches the pinned contract: `DIAGRAM_COMMANDS` allows only `finalize` (every other verb refused before spawn, verbatim), `ARCHIFY_BIN` resolution in the pinned order, the absence sentence verbatim, the receipts move back beside the candidate, `refresh-<n>` is never reused across rounds, timeout and non-zero-exit refusals carry stderr tails.
- [x] **C3** the loop drives the real composition end-to-end on a planted temp repo: audit finds the planted drift, the repin fixes exactly the moves, the finalize runs through the stub CLI, the stills leg runs `render-png.mjs`, the artifact lists every unresolved ref, and the second pass is a no-op (0 moved, 0 changes, no second finalize receipt).
- [x] **C4** archify absent ends the loop fail-open by name: the repin stands, the conclusion carries the refusal verbatim, no receipt is moved, no stub is required to prove it, and the exit is a normal loop result (no crash).
- [x] **C5** the repo's real candidates audit clean at the wave's start (report, not assertion — waves legitimately move refs later) and the wave's own candidates audit intact at the wave's end after the authoring pass and the loop's re-pin.
- [x] **C6** `kit doctor` gains the row: archify CLI found (this machine) vs the dim configured-absence note when `ARCHIFY_BIN` is unset and discovery fails, plus the audit's freshness counts from the real candidates.
- [x] **C7** docs in-wave per the Documentation section; both editions `npm test` green; `check:port` green; the wave's archify sweep executed (new node authored, all engine candidates re-finalized at wave HEAD, stills rendered and read); plan closed; recap filed.
- [x] **C8** the kit port is byte-identical plus proof: `diagram-refresh.dwf.ts` diff-clean against the engine loop, the unit suite passing in the kit through the `workflow-plane` symlink, the kit's four candidates audited and refreshed at kit HEAD, kit docs updated, kit recap filed.

## What landed (deviations recorded honestly)

**The commits.** Eight across W1–W4, every stage green on its own: `8e042a8` (foundation — the three interfaces, the grant, the `world.diagram` binding, the doctor row, 26-case unit suite; 25 suites green), `1ddb223` (the loop + the 13-check executed probe), `61bb7ca` (the documentation pass), `039172e` (the finalize refusal now names what stopped the run — a `--json` failure arrives on stdout, so the stderr-only slice read "archify finalize failed (exit 1): " with an empty reason; fixed in `services.mjs` and pinned by a new case, 27 cases), `49c03a4` (the archify sweep — the `diagramlane` node authored, all three candidates re-pinned and re-finalized at wave HEAD, stills rewritten), `4c07fd5` (the audit's type assertion reads the audit's own types — the kit's `quota` diagram is a `dataflow`, so the engine's two-type list was over-fitted), kit `52c1729` (the port — loop `.dwf`-re-header, doctor row, candidates and suite), kit `ad90ef3` (the kit's four candidates re-pinned and re-finalized at the port's HEAD, the suite shipped beside them), kit `fd1df53` (the kit's documentation pass).

**Per-criterion evidence, as it was produced:**

- **C0–C2** — `tools/unit-services-diagram.mjs`, 27 cases pass, 0 fail, in both editions (the kit's copy differs from the engine's by seven import lines and imports through `node_modules/workflow-plane`). The four verdicts on one planted fixture ("audit: classifies intact / moved / changed / missing on the planted fixture"), one `git show` per distinct (revision, path) plus one `rev-parse` per call, the dir checked before git, three refusal-by-name paths (no candidates, git absent, an unparseable candidate), the re-pin's three pure laws (applies moved only; second application zero changes and byte-identical; parsed object and JSON text agree), an edge ref that grows its `end_line`, the five finalize cases (allowlist, receipt move-back with the candidate copy left behind, `ARCHIFY_BIN` pointing at nothing, non-zero exit carrying the stderr tail, the stdout-JSON refusal), `nextRefreshDir`, and the binding/grant cases.
- **C3–C4** — `tools/probe-diagram-refresh.mjs`, 13 checks, 0 failed: one of every drift class found at the pinned revision, exactly the move re-pinned at the bytes' verbatim new lines, one round into `refresh-1` with the receipts moved back and the CLI's candidate copy left in the round dir, the stills leg running `render-png.mjs --check`, the artifact listing the unresolved refs and commanding the eye pass, the phases in order with no escalation, the second pass a no-op, `--dry-run` writing nothing and running no round, archify absent (re-pin stands, refusal verbatim, nothing else runs), and the structural greps (no agent, no model call, one writer).
- **C5** — the engine's own candidates audited at the wave's start and end: 61 refs at `be3659aa` all intact (the Approach's born-verified run); after the authoring pass and the loop's re-pin, at wave HEAD `4c07fd5`, **64 refs intact, 0 moved, 0 changed, 0 missing** across the three candidates (32 system-overview at pin `039172e`, 15 deep-research-loop at `039172e`, 17 run-lifecycle at `61bb7ca`). Two pins sit behind HEAD by construction — the re-pin moves the revision only in the same batch as moves, and an all-intact candidate needs neither.
- **C6** — `kit doctor`: `✓ diagrams — 3 candidate(s), 0 moved / 0 changed (pin 039172e/61bb7ca)` with the archify CLI found, and with `ARCHIFY_BIN` pointed at nothing the dim note `· archify CLI not found — diagram refresh falls back (set ARCHIFY_BIN; see docs)`. The kit's own row reads `✓ diagrams — 4 candidate(s), 0 moved / 0 changed (pin 52c1729)`.
- **C7** — the docs pass at `61bb7ca` (README grants bullet + loop-library row at 40 files/sixteen loops, the feature doc, TROUBLESHOOTING's four entries, both specs, CLAUDE.md); `npm test` green in **both** editions (25 suites in the engine, 14 in the kit); the sweep at `49c03a4` with the stills committed. Two deviations, both named: **check:port is red on the kit** (the installed runtime beside the router is 3/16 current — engine.mjs, services.mjs, tools.mjs — the same pre-cause the tabular and semantic ports carry; the checkout's plane is current, and the fix is the operator's `kit apply` + service restart, not done by precedent), and **the stills' eye pass is owed to a human** (this session's model cannot read a PNG; the sweep verified sizes and committed the renders, and the loop's artifact commands the reader's pass).
- **C8** — `workflows/diagram-refresh.dwf.ts` is the engine's loop with line 1 rewritten (`/* workflow` → `/* zcode-workflow`) and the other 417 lines byte-identical; the same 27-case suite passes in the kit at 14 suites green; the kit's four candidates audited and refreshed at kit HEAD `fd1df53` — **116 refs intact, 0 moved, 0 changed** (architecture 38, plane 19, quota 29, request-lifecycle 30, all at pin `52c1729`); kit docs at `fd1df53`.

**The deviations:**

- **The `diagramlane` node has no edge.** The plan's Archify section licenses a new node; it does not license re-planning the diagram's edge routing, and the attempt to connect the node to the plane displaced the layout router's own plan for the existing `agents-artifacts` edge onto a label rect (`composition/label-route-clearance`). Every authored variant — 2-, 3-, and 4-point vias, node repositioning, label moves, pinning the node's neighbour — produced the same class of violation, and an auto-routed edge tripped the crossing gate. Node-only authoring validates clean, so that is what shipped: the node carries its three anchored refs (the audit/repin/finalize block in `services.mjs`, the doctor row in `lib/cli.mjs`, the loop itself) and the loop's own doctor row is the reader's path to it.
- **The finalize's failure channel was wrong at first and fixed mid-wave** (`039172e`): under `--json`, archify writes the refusal to *stdout*, and the service sliced only stderr, so a layout rejection read as an empty reason. The fixed version parses the JSON and names the stage and first diagnostic; a planted case pins it. That fix landed before the sweep's re-pin, by the authoring-order law — the refs pin the post-fix ranges and the committed HTML carries them.
- **The kit's `plane.candidate.json` renders under a different name than it declares.** Its `meta.output` is `zcode-router-plane.html`, while the finalize surface names the output from the candidate's own stem, so a refresh round leaves an untracked, byte-identical `plane.html`/`plane.png` pair beside the tracked still. The pair was deleted; the wart is recorded in the kit's TROUBLESHOOTING as its own entry rather than papered over.
- **The kit's registry derives `scope` as diagram-refresh's task argument** (`ARG_PREFERENCE` ranks `scope` above `dir`), so the judge can assign the loop in that edition. A task sentence landing in `scope` is named in the loop's report and skipped as an unknown diagram name, and the audit and re-pin still run — the engine edition has no registry, so the wart is kit-only. Recorded in the kit's STATE-SNAPSHOT.
- **One `changed` ref in the kit was repaired by hand** (`request-lifecycle`'s `failopen` node, `router/server.js:463-464` → `476-476`): the loop correctly refused to touch it — the anchored bytes were edited, so the claim is an author's problem — and the repair is the loop's design working, not a gap.
- **The stills' eye pass is outstanding** for the reader, and `check:port`'s red is outstanding for the operator. Both are named where a reader will meet them (the loop's artifact, the kit's snapshot and TROUBLESHOOTING, and this section).

## Out of scope (with reasons, each naming its trigger)

- **Authoring nodes, edges, labels, or whole diagrams** — the loop moves and verifies refs; it never invents a claim. Trigger: none — this is the wave's boundary, not a backlog.
- **Verifying a claim is still true** — the audit proves byte-identity, not meaning; a `changed` verdict is by design an escalation with the old range and the new file for an agent to read. Trigger: none (semantics are not mechanical).
- **Eye acceptance of stills** — a reader's pass; the loop's artifact commands it and its `notCovered` claims it. Trigger: none.
- **Layout repair** (position collisions, the 8px-overlap rule, over-long sublabels) — archify's gates reject and an agent repairs; the loop takes the gate failure as a refusal by name. Trigger: a failed finalize in any loop run.
- **Cross-repo diagram maintenance** (sys1 / sdm1 / sem1 / dev-decisions each carry their own `docs/architecture`) — the loop is repo-local. Trigger: a wave in a sibling repo that wants its own loop.
- **New-diagram authoring from scratch** (the archify skill's fast path: choose type, write the candidate, finalize) — a different job entirely. Trigger: a user ask for a new diagram.
- **Media generation (images, narration, video renders)** — that is the gen1 lane, not this loop. Trigger: `docs/plans/2026-10-08-gen1-foundation.md` reaching W3's hyperframes seam.

## Linked artifacts

- The procedure this plan encodes (two worked refresh rounds, the lessons that shaped every refusal path here): memory `agnostic-archify-diagrams` — fixed-context grep false-negatives, position-guess collisions, label-only edits keep PNGs byte-identical, mirror an existing edge's shape, receipts and refresh dirs stay untracked.
- The skill: `~/.zcode/skills/archify` (MIT, `bin/archify.mjs finalize` contract — the `--out-dir` dance, the showcase/strict gates, the delivery receipt's update notice).
- The human-readable twin of the diagrams: `docs/architecture/overview.md`.
- Structural template: `docs/plans/2026-10-07-semantic-loops.md` (this plan mirrors its grant → `world.*` surface → loop → docs → diagrams → waves shape, and reuses its C6 executed-probe standard and fail-open law).
- The plane-sharing fact W4 inherits: kit `package.json`'s `"workflow-plane": "file:../agnostic-router-kit/lib/workflow"` (`node_modules/workflow-plane` symlink).
