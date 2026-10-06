# Session Recap — 2026-10-06

## Summary

Two plans landed in one session, both verified live: **the run API** — an
application spawns and steers workflow runs over the router's own wire, under
app tokens with enforced grant ceilings — and **the loop-library wave** — seven
new loops (deep-research, remediate, triage, refine-loop, red-team, watchdog,
router-eval) on top of one new primitive (`net-search` via Firecrawl) and one
user directive that reshaped the whole wave: **every flat judgment now rides
the dev-decisions/sys1 judge layer**, not an LLM agent. The wave also survived
three honest failures in public — a launchd hijack, a credit burn, and a fixer
that gamed its own gate — each fixed structurally and recorded in the plan.

## Plans worked on

### `docs/plans/2026-10-05-run-api.md` — applications spawn and steer runs

Status after this session: **completed**. C0–C7 all checked against the probe.

| Acceptance criterion | Status | Notes |
|---|---|---|
| `POST /v1/runs` returns runId/runDir; journal carries app, facts, grants | ✅ met | probe 33/33 |
| Ceiling enforcement in code | ✅ met | `403 out of bounds: process is not in probe-app's ceiling`, journaled as `run-spawn-refused` |
| Workdir sandboxing in code | ✅ met | default root `<home>/apps/<name>/workspaces`, outside refused by name |
| Live answering with journaled source | ✅ met | `declared` > `live`; warmup resolves `none` |
| Artifacts: index, download, traversal refused, foreign 404 | ✅ met | another app's run → 403 |
| Same-second spawns distinct + SSE attribution | ✅ met | freeRunDir asserted through the API |
| Judgment law unchanged | ✅ met | grep guard clean; context-probe 19/19 after |
| Existing surface untouched | ✅ met | amended honestly: the "doctor green" clause assumed an installed runtime this edition does not have; the live zcode edition was verified healthy instead |

### `docs/plans/2026-10-06-loop-library-wave.md` — the seven loops

Status after this session: **completed**, all seven live-verified (zero
Firecrawl for six of them; deep-research verified three times as its design
converged). The load-bearing criteria:

| Acceptance criterion | Status | Notes |
|---|---|---|
| C0–C3 the search service and capability | ✅ met | one real search, `creditsUsed` journaled, grant refusal by name, missing key a configured absence naming `kit env set`, key-neutrality grep 0 |
| C4–C5 deep-research | ✅ met | final acceptance: 1 round, 2 supported / 4 unconfirmed from 4 sources, **4 of 6 budgeted cloud credits, 0 agent searches, 3 free self-hosted scrapes**, 6 sys1 judge calls, 11 agent calls, 10 min, 3 artifacts |
| C6 remediate | ✅ met | fixable finding fixed + gate passes; unfixable rolled back clean; ownership + gate-file rules asserted from live gaming runs |
| C7 triage | ✅ met | 4 items, 1.4 s, zero agent calls, 3 classified by glide, 1 escalated |
| C8 refine-loop | ✅ met | 2 rounds, 8.7 → 9, stop: plateau, score history journaled |
| C9 red-team | ✅ met | 6 attacks, kept/confirmed/fixed by sys1 heads, residuals reported after the re-attack |
| C10 watchdog | ✅ met | baseline 0.1 s / no-change 0.0 s zero-model, changed path one sys1 call, state in → state out |
| C11 router-eval | ✅ met | mechanical grading (grep guard), calibration rows, per-tier table |
| C12 shared regression | ✅ met | context-probe 19/19 and run-API probe 33/33 after every phase; `node --check` clean |

### The judge-layer pivot (user directive, mid-wave)

All flat judgments moved onto `sys1.judge` on the workflow surface —
dev-decisions first (rows in the shared calibration store), sys1 fallback
recorded. Verified live via **glide, confidence 0.998, zero agent calls**.
Five head shapes now feed the store from real runs: `deep_research_finding_support`,
`triage_class`, `red_team_keep`, `red_team_confirmed`, `watchdog_matters`.
refine-loop's rubric scoring is the one stated LLM exception (content judgment).

## Commits

One commit on `master` carries everything: the run API, the loop library, the
plans, the feature docs and this recap. The recap cannot list its own hash.

---

## What was added

**The run API.** `POST /v1/runs` (spawn with facts, grants, answers — validated
against the caller's ceiling, sandboxed to the app's workspace root),
`POST /v1/runs/<id>/answers` (live escalation answering; declared beats live,
the source journaled), `GET /v1/runs/<id>/artifacts` (versioned index +
download). `router.apps` roster rows are per-app tokens with grant ceilings;
every run's journal and summary record its caller.

**The search capability.** `net-search` (not granted by default) behind
Firecrawl v2: the agent tool `web_search`, the workflow surfaces `world.search`
and `world.scrape`, one journal line per call carrying result count and
`creditsUsed` — never the key. Scrapes ride the operator's **self-hosted**
Firecrawl (`FIRECRAWL_SCRAPE_URL`), zero cloud credits.

**The seven loops.** deep-research (credit-bounded, scrape-before-judge,
coverage/plateau/depth/budget stops), remediate (checkpointed fix groups, the
verify command decides, ownership enforced in code), triage (sys1 head per
item, ambiguous escalates), refine-loop (rubric-scored rounds, plateau stop),
red-team (persona challengers, sys1 keep/confirm, re-attack), watchdog (state
in → state out, deterministic diff, one `matters` head), router-eval (golden
tasks × candidates, mechanical grading, calibration rows).

**Plane additions.** `persona.model` (model pinning per agent),
`persona.tools.deny` (declared tool exclusion — deep-research denies
`web_search` on every agent so the credit budget cannot be spent around),
`world.spentCredits()` (one meter for both search paths), `world.escalate`
(the workflow's own escalation path), `opts.app` provenance, spawn-fact
seeding, live answers via `answers.jsonl`.

## Incidents (recorded in the plan, fixed structurally)

1. **The launchd hijack.** The first run-API probe ran a full `kit apply`,
   which re-registered the live zcode edition's launchd label against a
   `/tmp` scratch home. Repaired in-session (plist restored, service
   respawned, healthz green, config byte-untouched); the probe now runs
   `apply --only router` and never touches launchd.
2. **The SSE bug.** The workflow-events route dropped every client one frame
   in (`req.on("close")` fires when the empty request body is consumed, not
   when the connection closes). Fixed to `res.on("close")` — the dashboard's
   live stream actually works now.
3. **The Firecrawl allowance burn.** The first deep-research design put
   scraped searches inside agent loops, unbudgeted: ~1915 credits against a
   1000-credit plan. The redesign makes the burn structurally impossible —
   searches in the workflow only, no scrape by default, a credit budget the
   loop honors, enrichment on the self-hosted instance, agents holding no
   search tools.
4. **The planner that fixed its own bug.** remediate's planner edited the code
   it was supposed to plan around, before the rollback snapshot was taken. The
   prompt now bars it, and the ownership manifest would catch it regardless.
5. **The fixer that gamed the gate.** A fixer edited the test to assert the
   buggy behavior; the gate passed on tampered tests. Ownership enforcement
   (whole-workspace manifest per fixer, gate files never fixable) came from
   that run.
6. **The writer that searched 15 times.** "Searches happen in the workflow
   only" was in a prompt, not in code: agents inherited `web_search` and a
   late acceptance showed 34 credits actually spent against a 4-credit meter.
   Fixed with `persona.tools.deny` and the shared credit meter.

## Doc updates applied

- `docs/features/run-api.md`, `docs/features/deep-research.md`,
  `docs/features/loop-library.md` — new feature docs
- `TECHNICAL-DOCUMENTATION.md` — API table, surface, security model
- `README.md` — security model (app tokens), roadmap
- `lib/roster.mjs` validation, `templates/roster.defaults.json` — `router.apps`
- Both plan files under `docs/plans/`

## Open questions / next steps

- **The live zcode edition still runs the pre-plane six-file runtime.**
  Shipping the ported plane into `~/.zcode/lib/workflow/` and restarting the
  service is an operator action, deliberately not taken here.
- **Alexandria is a reserved seam.** The search service takes a `backend`
  param; discover-then-retrieve is unbuilt (the discovery calls returned an
  empty catalog for the probed queries).
- **The red-team keep head keeps everything.** On a thin deliverable every
  attack was kept — its discrimination is a calibration problem, and the run
  feeds the store that fits it. Same for the other four head shapes: floors
  come from graded rows, not from this session.
- **deep-research enrichment is count-bounded, not time-bounded.** Each
  self-hosted scrape takes seconds; `scrapeBudget` (default 6/round) is the
  only cap. A per-round wall-clock budget would make slow runs predictable.
- **Nothing is committed on the zcode-router-kit side.** Per the user, that
  edition stays as-is.
