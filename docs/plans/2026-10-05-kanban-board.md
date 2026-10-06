---
status: completed
created: 2026-10-05
updated: 2026-10-05
slug: kanban-board
---

# Plan: port the kanban board from zcode-router-kit

> **Sequence, recorded honestly.** The board itself was designed, approved and
> verified in `zcode-router-kit` first (`docs/plans/2026-10-05-kanban-board.md`
> there). This plan is the *port*: the same feature, delivered as
> "engine + board" so the two editions stay in step on it. Drafted and
> approved through ExitPlanMode on 2026-10-05 and implemented the same day;
> this file is the repo's record of that contract, written at close per the
> `docs/plans/` convention.

**Goal:** the harness-neutral edition answers "where does the kit's work
stand" on a kanban board — Planned, Executing, Completed, Abandoned — with one
card per work item naming its deliverables, its agents and what its agent is
doing right now, and a click opening the task's detail.

**Architecture:** one source file changes — `router/dashboard.html` — plus
three docs. `router/server.js` is untouched: it already serves
`/api/workflow-graph` and `/api/workflow-run/<id>` and already broadcasts
every SSE frame the board reads (`hello`, `heartbeat`, `event`, `summary`,
`graph-node`, `graph-edge`). The workflow plane is untouched. Nothing installs
and nothing runs by this change; the board ships as source and `kit apply`
delivers it when the edition is deployed.

## Context

The kit and the engine each keep a forked `router/` tree, and they are not
identical: before the board existed, `diff` between the kit's dashboard and
this repo's was exactly 16 lines of branding — the product name in the header,
the theme/token/board localStorage keys, two copy tweaks that name the harness
instead of "any client", and two blank-line insertions this repo carries.
Nothing behavioural. So the port is **composition, not re-implementation**:
take the kit's board-carrying dashboard and re-apply this repo's branding, and
the result is provable in both directions by two diffs rather than by reading.

The board's own one harness reference is its view-mode key
(`BOARD_KEY`), and it follows the convention `THEME_KEY` already set: the
engine's variant is `agnostic-router-board-mode`, an env-neutral string beside
the two keys that were already engine-neutral.

## Approach

### Phase 1 — compose, never hand-edit

1. Build `router/dashboard.html` by `diff`-ing the kit's pre-board dashboard
   against this repo's current one, applying that branding patch to the kit's
   current (board-carrying) file, and swapping `BOARD_KEY`'s localStorage name
   to the engine's. No manual edits anywhere in the board module.
2. Assert both directions: engine-current vs kit-current must be branding only
   (proves no kit-specific code leaked in), and engine-current vs this repo's
   `HEAD` must be the board patch only (proves nothing engine-specific was
   lost).

### Phase 2 — run the real code against the real data

3. Static gates: the house-rule neutrality grep
   (`grep -rni "zcode\|~/.zcode" lib bin router roster.json templates | grep -v "^\S*: *\*"`)
   stays empty, and `node --check` passes on the inline script extracted from
   the ported file.
4. Node harness — the same rig the kit used, re-pointed at this repo: it
   extracts the real board module and helpers out of `router/dashboard.html`
   and evaluates them against the real `buildGraph()` over this repo's own
   workflow plane and `~/.agnostic-router-kit/workflow-runs` (411 nodes, 264
   edges over 100 runs). Columns, cards and card bodies are measured, not
   asserted by eye. Because this repo's single plan dispatched no runs and
   carries no acceptance criteria, the richer paths are exercised by pointing
   `AGNOSTIC_ROUTER_KIT_REPO_ROOT` at the kit repo — the port's own code then
   runs over data with a 16-run plan, 99 real journal events and every detail
   kind.
5. Browser pass on a scratch engine router: `router/` copied to `/tmp`, the
   root `node_modules/workflow-plane` symlinked in, a minimal `config.json`
   with a dummy local token on spare port 18301, `AGNOSTIC_ROUTER_KIT_HOME`
   at the real runs. This is a scratch rig only — nothing is installed into
   `~/.agnostic-router-kit`.
6. `kit doctor` immediately after the change, against the pre-change baseline
   of 13 problems (all dev-checkout state: no config, runtime, `.env` or
   plist, five unresolved keys, five unusable tiers, two unusable mixture
   parts). Two of doctor's checks are live network probes, so the count is the
   whole comparison — the port touches no file doctor reads.

### Phase 3 — docs, with the code and not after

7. `FUNCTIONAL-SPECIFICATIONS.md` §5 — the two read-only workflow surfaces.
   `router/README.md` — "Four surfaces" becomes six, plus a new
   `## Workflow surfaces: Activity and Board` section, because this README
   documented neither the Activity nor the Graph tab before.
   `docs/features/workflow-dashboard.md` — the Views list gains the Board tab
   and the DAG is re-described as that tab's second mode.

## Use cases

- [x] A: An operator running the neutral edition — no harness installed, no
  harness dashboard anywhere — sees where the kit's work stands the same way
  the kit's operator does: four columns, a card per work item, live movement,
  detail on a click. *(C0 — 2026-10-05: the scratch engine router on 18301
  served over this repo's own 100 runs rendered Planned 1 / Executing 3 /
  Completed 89 / Abandoned 8 = 101 cards, with the three live runs carrying
  the live badge; clicking a card in each column opened four real details —
  248 characters for the plan, 265 for a live run, 395 for a completed
  plan-attached run, 1,669 across five sections for the abandoned
  adversarial-solve run)*
- [x] B: A reader of either repo can tell the two dashboards are the same
  feature, not two implementations of one — the port is provable rather than
  merely plausible. *(C1 — 2026-10-05: `diff` engine-current vs kit-current
  is 10 hunks and every differing line is branding; the inline scripts are
  1,487 lines each and differ in exactly three lines, the three localStorage
  keys)*

## Acceptance criteria

Order is identity: use cases are C0–C1, criteria C2–C9. Never reorder after
gating.

- [x] No harness reference reaches `lib bin router roster.json templates` — the engineered neutrality guard stays green. *(C2 — 2026-10-05: the house-rule grep returns nothing; the board patch against `HEAD` contains zero matches for the harness name)*
- [x] The port is composition-exact in both directions: no kit-specific code leaked in, nothing engine-specific was lost. *(C3 — 2026-10-05: engine vs kit-current = 10 hunks, all branding (header title, head-script theme key, two copy tweaks, the blank-line insertions, three localStorage keys); engine vs `HEAD` = 11 hunks / 526 diff lines, the board patch alone)*
- [x] The ported inline script parses, and the served page still carries the token-injection line byte-identical. *(C4 — 2026-10-05: `node --check` on both 1,487-line bodies passes; the engine's body differs from the kit's in exactly the three key lines — `TOKEN_KEY`, `THEME_KEY`, `BOARD_KEY` — and the server's `INJECTED_TOKEN` replacement is untouched)*
- [x] The Node harness renders four columns, one card per work item, and every detail kind from this repo's own plane and runs. *(C5 — 2026-10-05: graph 411 nodes / 264 edges, byKind plan 1 / run 100 / agent 261 / artifact 3 / gate 20 / commit 26; columns planned 1, executing 3, completed 89, abandoned 8, 101 cards; re-pointed at the kit repo's data the same code rendered planned 2 / executing 3 / completed 46 / abandoned 2, an executing card with a 16-run plan and 99 real events feeding its activity tail, and all four detail kinds)*
- [x] The browser pass holds on real data: four columns, a card click opening the detail, the DAG one toggle away over the same model, the Activity tab unregressed, and the board's own numbers matching the server's. *(C6 — 2026-10-05: on the scratch router at 18301, the SVG drew 1,908 elements (411 node groups, 264 edge paths, 411 node labels) with `gMeta` reading "411 nodes · 264 edges" and the toggle returning to all 101 cards; one detail per column plus a plan-attached run all opened with sections, the "open run in Activity tab" cross-link selected that run's 188-event feed; the Activity tab listed 50 rows with a live detail; the only non-2xx on the page is the pre-existing `favicon.ico` 401)*
- [x] No server, plane or roster change rides along. *(C7 — 2026-10-05: `git diff --stat` over the whole repo is four files — `router/dashboard.html`, `router/README.md`, `FUNCTIONAL-SPECIFICATIONS.md`, `docs/features/workflow-dashboard.md`, 461 insertions / 26 deletions — with `router/server.js`, `lib/workflow/*` and `roster.json` absent)*
- [x] `kit doctor`'s problem count does not move. *(C8 — 2026-10-05: 13 problems before, 13 after, the same list — router config present, router runtime present, router dependency, `.env`, roster keys resolve, five tiers, mixture aggregator, mixture proposers, service — the checkout's standing state)*
- [x] The contract docs describe the surfaces as they now exist. *(C9 — 2026-10-05: `FUNCTIONAL-SPECIFICATIONS.md` §5 carries the Activity/Board paragraph; `router/README.md` reads six surfaces and has the workflow-surfaces section; the feature doc's Views list names the Board tab and re-describes the DAG as the toggle's second mode)*

## Files to be touched

**agnostic-router-kit (this repo, the only one changed):**
- `router/dashboard.html` — the ported board (the kit's module, this repo's branding).
- `FUNCTIONAL-SPECIFICATIONS.md` §5 — the two read-only workflow surfaces in the dashboard's contract.
- `router/README.md` — four surfaces becomes six, plus `## Workflow surfaces: Activity and Board`.
- `docs/features/workflow-dashboard.md` — the Views list gains the Board tab; the DAG becomes the toggle's second mode.
- `docs/plans/2026-10-05-kanban-board.md` — this plan.

**zcode-router-kit:** nothing changed here (its board work is a separate, already-recorded session). **Untouched here:** `router/server.js`, the watcher and SSE routes, `lib/workflow/graph.mjs`, `lib/workflow/events.mjs`, `roster.json`.

## Out of scope

- **Installing the engine runtime or service.** This checkout has no `.env` and no provider keys; minting keys to install it would break the no-raw-keys rule, and nothing in this port needs a running engine. The board ships as source; `kit apply` installs it when the edition is deployed.
- **Any server change.** Every frame and route the board reads already exists.
- **Solving the two-fork drift.** The kit keeps a forked `router/` that will keep diverging — the kit already carries provider wiring this repo must never have. This port syncs the two on one feature and nothing more; whether the dashboard should become a shared package is a separate architectural question.
- **A recap.** The house rules ask for one after every session, but `docs/recaps/` does not exist here; creating that directory is its own deliberate act rather than a side effect of a port.

## Verification

**C2:** `grep -rni "zcode\|~/.zcode" lib bin router roster.json templates | grep -v "^\S*: *\*"` must be empty; `git diff router/dashboard.html | grep -ci zcode` must be 0.
**C3:** `diff router/dashboard.html <kit's router/dashboard.html>` (branding only) and `git diff router/dashboard.html` (the board patch only).
**C4:** extract the `<script>` body that defines `BOARD_KEY` from both dashboards, `node --check` each, and `diff` the two bodies (three key lines).
**C5:** the Node harness re-pointed at this repo — `HARNESS_DASH`/`HARNESS_PLANE`/`AGNOSTIC_ROUTER_KIT_HOME` at this repo and its kit home, then the same harness with `AGNOSTIC_ROUTER_KIT_REPO_ROOT` at the kit repo.
**C6:** the scratch-engine browser pass — copy `router/` to /tmp, symlink the root's `node_modules/workflow-plane`, minimal `config.json` with a dummy token on port 18301, `AGNOSTIC_ROUTER_KIT_HOME` at the real runs; drive the page over CDP.
**C7:** `git diff --stat` over the repo.
**C8:** `node bin/agnostic-router-kit.mjs doctor` before and after, count and list.
**C9:** re-read the three edited docs.

Regression surface: the roster tabs (Usage, Delegation, Providers, Quota,
Workflows), save-and-apply, the Activity tab, the DAG and the CLI's graph
export are unchanged — the board is additive beside them and reuses only the
helpers and the SSE frame dispatch, both of which gained a call rather than a
change of behaviour. The browser pass measures the Activity tab and the
roster-editing tabs' nav for the same reason: an unregressed neighbour is
part of the port, not a nicety.

## Notes

- **The engine's plan card reads "0/0 criteria" and that is the data, not a
  defect.** This repo's single plan
  (`docs/plans/2026-10-05-workflow-dashboard-handoff.md`) numbers its
  criteria in prose ("C0–C11") and carries zero `- [ ]` checkboxes, and the
  graph builder counts checkboxes — so `buildGraph` emits no criterion nodes
  and the card honestly shows 0 of 0 with no criteria section. Verified with
  `grep -c '^- \[[ x]\]'` returning 0 before reading anything into the
  number; the kit's plans use checkboxes and its board shows 12 of them.
- **The neutralization of the board's one key is the whole branding delta the
  board adds.** `BOARD_KEY` sits beside `TOKEN_KEY` and `THEME_KEY`, which
  were already engine-neutral; the port's only new string is
  `agnostic-router-board-mode`.
- **The verification rigs are scratch, not committed.** The Node harness and
  the CDP browser driver live in `/tmp/kboard/`; nothing under a tracked path
  was added for them. The same gap exists in the kit's plan and is the next
  thing worth closing if the board is to keep a regression net.
- **Nothing here was installed, started or restarted as a service.** The
  scratch router ran on a spare port under a dummy token and was the only
  process bound to it; `~/.agnostic-router-kit` gained no `router/` runtime.
- Cross-referenced against `2026-10-05-workflow-dashboard-handoff.md`, which
  introduced the workflow dashboard into this repo; this port adds the board
  tab that hand-off's Views list had room for, and revises nothing else in it.
