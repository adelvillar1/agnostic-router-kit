# Session Recap — 2026-10-05

## Summary

The kanban board is ported to the neutral edition: the engine's dashboard now
carries the same Board tab the ZCode edition shipped, delivered as a pure
composition — the engine's current file plus the board patch — so both
editions stay in step on the feature without a second hand-written copy. This
is also the first recap in this repo; `docs/recaps/` was created for it,
deliberately, at the request that ended the session.

## Plans worked on

### `docs/plans/2026-10-05-kanban-board.md` — port the kanban board from zcode-router-kit

Status after this session: **completed** (flipped from active). Ten checkboxes:
two use cases (C0–C1) and eight acceptance criteria (C2–C9), each carrying its
own measured evidence rather than a claim. The load-bearing ones:

| Acceptance criterion | Status | Notes |
|---|---|---|
| The neutrality guard stays green | ✅ met | `grep -rni "zcode\|~/.zcode" lib bin router roster.json templates` returns nothing; the board patch against HEAD contains zero harness references |
| Composition-exact in both directions | ✅ met | ported vs the kit's current file = 10 hunks, all branding (header title, head-script theme key, two copy tweaks, the blank-line insertions, three localStorage keys); ported vs this repo's HEAD = 11 hunks / 526 diff lines, the board patch alone |
| The ported script parses; token injection survives | ✅ met | `node --check` on the 1,487-line inline body; the engine's body differs from the kit's in exactly three key lines (`TOKEN_KEY`, `THEME_KEY`, `BOARD_KEY`); the server's `INJECTED_TOKEN` replacement untouched |
| The Node harness renders four columns and every detail kind | ✅ met | from this repo's own plane and runs: graph 411 nodes / 264 edges (plan 1, run 100, agent 261, artifact 3, gate 20, commit 26); columns 1 planned / 3 executing / 89 completed / 8 abandoned, 101 cards; re-pointed at the kit repo's data the same code rendered 2/3/46/2 and an executing card with a 16-run plan and 99 real events |
| The browser pass holds on real data | ✅ met | scratch router at 18301: SVG drew 1,908 elements (411 node groups, 264 edge paths, 411 labels) with `gMeta` reading "411 nodes · 264 edges"; details of 248 / 265 / 395 / 1,669 chars all opened with sections; cross-link selected a 188-event feed; Activity listed 50 rows; only non-2xx on the page is the pre-existing `favicon.ico` 401 |
| No server, plane or roster change rides along | ✅ met | whole-repo `git diff --stat` is four files — the dashboard plus three docs, 461 insertions / 26 deletions; `router/server.js`, `lib/workflow/*` and `roster.json` absent |
| `kit doctor`'s problem count does not move | ✅ met | 13 before, 13 after, the same list — this checkout's standing state (no `.env`, no installed service, five unresolved roster keys) |
| The contract docs describe the surfaces as they now exist | ✅ met | spec §5, router README and the feature doc all updated |

## Commits

None before this recap. The dashboard, the three docs, the plan and this recap
land as one commit on `master` — the recap cannot list its own hash.

---

## What was added

**The Board tab.** Four columns — Planned, Executing, Completed, Abandoned —
where one card is one work item: a plan with the runs it dispatched attached,
or a bare run when no plan claims it. Each card carries three rows:
*deliverables* (a plan's acceptance criteria with the checked count plus the
artifacts its runs produced; a run's artifacts with version, size and path),
*agents* (one row per actor name with asks and tool calls, aggregated across a
plan's runs; a swarm lists its parts with their last gate verdict), and *now* —
the latest phase, the latest tool call (`actor → tool`), or the artifact last
produced, with the age of the newest journal event for a live card. Clicking a
card opens the task's detail below the board: the `contract` events that name
which agent owns which files and what it provides, plus phases, the agent
table, artifacts and the dev-decisions gates attributed to the run's window;
a plan gets its full criterion list, phases, runs with state, artifacts, and
the commits and recaps that recorded it.

**Liveness.** The board reads the graph snapshot (`GET /api/workflow-graph`,
server-memoized 5s) and the SSE stream. The **heartbeat** frame is the
authority on whether a run is still live, so a finished card leaves Executing
within one 5-second heartbeat; the `summary` frame is applied on arrival, which
usually makes the move instant. `event` frames fill the per-run activity tail,
and `graph-node` / `graph-edge` deltas merge new agents and artifacts as they
appear. The tab polls the graph every 10s while visible.

**The DAG, one toggle away.** The layered plan→recap graph the board replaced
stays reachable over the same model with a `Board` / `Graph` toggle; the chosen
mode is remembered per browser.

**`docs/recaps/`** — this repo's first recap, and the directory that holds it.

## What was changed

- The **Graph tab** is no longer the tab's default view; it is now the toggle's
  second mode. The feature doc's Views list was amended to say so.
- **Activity** is now documented in `router/README.md` as well as the feature
  doc — the README previously named neither read-only tab.

## Files changed

**Dashboard**
- `router/dashboard.html` — the port: board markup, CSS, the render/detail/model
  path, the SSE branches, and the mode toggle (1,910 lines after the port)

**Documentation**
- `FUNCTIONAL-SPECIFICATIONS.md` §5 — the read-only workflow-surfaces paragraph
  (Activity and Board, the cross-link, live movement, the DAG one toggle away,
  "the kit CLI stays the only writer")
- `router/README.md` — "Six surfaces" (four edit the roster, two watch and are
  strictly read-only), the two new surface bullets, and a new
  `## Workflow surfaces: Activity and Board` section before the judge-backends
  section
- `docs/features/workflow-dashboard.md` — Views list gains the Board tab and
  re-describes the DAG as the toggle's second mode
- `docs/plans/2026-10-05-kanban-board.md` — the port's plan-as-contract
- `docs/recaps/SESSION-RECAP-2026-10-05.md` — this recap

## Doc updates applied

- `FUNCTIONAL-SPECIFICATIONS.md` §5 — the two read-only tabs, their data
  sources, and the no-write rule
- `router/README.md` — six surfaces, the Activity and Board entries, the
  workflow-surfaces section (data sources, column derivation, endpoints, SSE,
  the DAG as second mode)
- `docs/features/workflow-dashboard.md` — the Views list

## Doc updates deferred (debt)

None from this session. Two known items are recorded as open questions below
rather than doc debt.

## Open questions / next steps

- **The two forks still drift.** This repo and `zcode-router-kit` each keep a
  forked `router/` tree, and they will keep diverging — the kit already carries
  harness-specific provider wiring this repo must never have. The port keeps
  them in step on this feature and nothing more. Whether the dashboard should
  become a shared package is unresolved; the plane-split plan already recorded
  "a third repository" as rejected for the plane itself.
- **Swarm parts have no live per-part status feed.** `run-fact` status rows
  exist in the router log but `lib/workflow/graph.mjs` does not surface them, so
  a swarm card shows its parts and their gate verdicts but does not move parts
  between columns. Adding that means changing the plane, which is a plane
  decision, not a dashboard one.
- **No runtime install.** This checkout has no `.env` and no provider keys, so
  the board ships as source; `kit apply` installs it when this edition is
  deployed. Anyone re-running the doctor guard on another machine should record
  that machine's own `ENGINE_BASELINE_PROBLEMS`.
- **The board reads this repo's own plan as "0/0 criteria".** The plan's
  acceptance criteria are prose-numbered rather than `- [ ]` checkboxes, and
  `graph.mjs` derives criterion nodes from the checkbox form only — so the
  count is honest data, not a defect. A plan written with checkboxes shows them.

## Notes

- **The port was composition, not hand-editing, and it is provable.** The two
  dashboards are forks of one file; the engine's delta is the branding. The
  ported file is the kit's current file with that delta re-applied plus the one
  `BOARD_KEY` swap, and the two `diff` assertions (10 branding hunks one way,
  11 board hunks the other) turn "the port looks right" into "the port is
  exactly engine + board".
- **The browser pass ran on a scratch engine router only.** A copy of
  `router/` in `/tmp` with the root `node_modules` symlinked, a minimal config
  with a dummy token, and port 18301. Nothing was installed into
  `~/.agnostic-router-kit`, and every scratch process was stopped afterwards.
- **`router/server.js` needed no change.** It already imported `buildGraph`,
  served `/api/workflow-graph` and `/api/workflow-run/<id>`, and broadcast
  `heartbeat` / `event` / `summary` / `graph-node` / `graph-edge` frames. The
  board is a client-side consumer of a server surface that already existed.
- **The plan records its sequence honestly**: the board was designed, approved
  and verified in `zcode-router-kit` first; this plan is the port, delivered as
  "engine + board" so the two editions stay in step.
