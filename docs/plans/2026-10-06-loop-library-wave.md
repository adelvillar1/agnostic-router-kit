---
status: completed
created: 2026-10-06
updated: 2026-10-06
slug: loop-library-wave
---

# Plan: the loop-library wave — deep-research on Firecrawl, then the six

**Repo:** agnostic-router-kit (upstream only; zcode-router-kit stays as-is — it is the operator's main dev environment). **Scope:** deep-research first (it carries the new `net-search` primitive), then remediate, triage, refine-loop, red-team, watchdog, router-eval. Mid-wave the scope gained two user directives: **all judging, scoring, and yes/no outcomes ride the dev-decisions/sys1 judge layer**, and **search efficiency became the load-bearing constraint** after the shakeout burned the Firecrawl allowance.

**Goal:** turn the kit's library from ten one-pass workflows into a library of loop shapes — with flat judgments on the decision layer, search credits structurally unbunrnable by agent loops, and every stop reason in the record.

## What landed

### Phase 0 — Firecrawl/Alexandria setup — ✅ done
`firecrawl-cli` installed and logged in; key verified (1000-credit plan); Alexandria discovery exercised (free, `data.tools` catalog — empty for the probed queries; the `backend` seam in the search service reserves it). `FIRECRAWL_API_KEY`, `FIRECRAWL_SCRAPE_URL`, `FIRECRAWL_SCRAPE_VERSION` in the runtime `.env` (600).

### Phase A — the search service and capability — ✅ done
`searchWeb` (services.mjs): Firecrawl v2, response- and per-result caps, normalized rows, `creditsUsed` returned, missing key a named configured absence. `net-search` capability (not granted by default). Agent tool `web_search` + workflow surface `world.search`, one journal line per call carrying query, result count, `creditsUsed` — never the key. `scrapeUrl` + `world.scrape`: enrichment through the operator's **self-hosted** Firecrawl (`FIRECRAWL_SCRAPE_URL`, v1, markdown — the self-hosted `summary` format needs an LLM backend; the cloud key never rides to the self-hosted instance; zero cloud credits). Key plumbing: callers resolve env names at the boundary; the plane sees one value.

### Phase B — deep-research — ✅ done (rewritten once, mid-shakeout)
Credit-bounded loop: **searches run in the workflow only** (cheap, no scrape, deduped, under `args.creditBudget` default 20 credits); scouts are extractors over the returned rows **with no tools** — an agent loop cannot spend; findings ruled by the `deep_research_finding_support` sys1 judge head (dev-decisions first); enrichment re-reads up to `scrapeBudget` (default 2) unconfirmed findings through the self-hosted scraper and re-judges — fuller evidence may upgrade "unconfirmed", a contradiction never does; reflector + stops (coverage | plateau | depth | credit-budget); writer + cold reader; artifacts: deliverable, source-ledger (versioned per round), coverage-map.

### Phase C — probes — ✅ done
`search-probe` (granted / refused / no-key — one real search total, zero model calls; key-neutrality grep 0 hits). `judge-probe` — the judge layer's contract, live: judged via **glide (dev-decisions)**, confidence 0.998, zero agent calls.

### Phases D–I — the six loops — ✅ done, live-verified (zero Firecrawl)
- **remediate** — fixable finding fixed, gate decides; unfixable finding rolls back clean; **ownership enforcement born from a live gaming run**: a fixer "passed" the gate by editing the test, so the workflow now manifests the whole workspace before and after each fixer and voids any change outside the group's files — or to a gate file (tests/specs), declared or not. The planner is also barred from editing: it pre-applied a fix once, which would have corrupted the rollback snapshot.
- **triage** — live: 4 items, **1.4 s, zero agent calls**, 3 classified by glide, 1 escalated (duplicate-without-target → the escalation lane asks).
- **refine-loop** — live: 2 scored rounds, 8.7 → 9, stop: plateau, 4 agent calls.
- **red-team** — live: 6 attacks from 2 persona challengers, kept/dropped and confirmed by sys1 heads over the deliverable text, fixer addressed the confirmed, re-attack reported residuals. The keep head kept everything on a deliberately thin doc — its discrimination is a calibration problem, and the run feeds the store that fits it.
- **watchdog** — live: baseline 0.1 s and no-change 0.0 s (both zero model calls), changed path via one sys1 `matters` head; state out for the caller to carry.
- **router-eval** — live: 2 candidates × 2 golden tasks, mechanical substring grading, per-candidate accuracy/latency table + JSONL calibration rows; `persona.model` added to the engine (the delegate spawner's spread, applied to model pinning).

### The judge-layer pivot (user directive, mid-wave)
All flat judgments ride `sys1.judge` — dev-decisions first (calibration store), sys1 fallback recorded, the LLM agents do generation only. The one intentional exception: refine-loop's rubric scoring stays a per-round LLM ask (content judgment), stated in the workflow. This was also the efficiency answer: the shakeout's biggest burns were LLM agents doing yes/no work (a checker at 56k tokens; a scout at 137k).

## Acceptance criteria

- [x] **C0:** `world.search` fires one real search; the journal line carries query, result count, `creditsUsed`; no key material (grep 0); rows carry url + title. *(search-probe granted)*
- [x] **C1:** the grant is enforced in code; refusal by name, journaled. *(search-probe refused)*
- [x] **C2:** a missing key is a configured absence naming `FIRECRAWL_API_KEY` and `kit env set`. *(search-probe no-key)*
- [x] **C3:** key-neutrality: grep clean in `lib/` and `workflows/`; the envMap carries only the declared name's value.
- [x] **C4:** a live deep-research run: rounds journaled, findings judged before the pool, URL dedupe, versioned ledger, inline citations + contradictions + coverage map, cold-reader fix pass. *(verified three times, the last on the final design: 2026-10-06 scrape-first acceptance — 1 round, 2 supported / 4 unconfirmed findings from 4 sources, **4 of 6 budgeted cloud credits, 0 agent searches, 3 free self-hosted scrapes**, 6 sys1 judge calls, 11 agent calls, 10 minutes, all three artifacts. Earlier runs: pre-rewire (16 agent calls, 9 sources) and credit-bounded first pass (8 findings / 8 sources, 8/12 credits).)*
- [x] **C5:** honest stops: coverage, plateau, depth, credit-budget all reachable and named; capped reflectors escalate `stuck`. *(live: stuck escalations observed and handled on scouts, checkers, and the reflector path)*
- [x] **C6:** remediate: per-finding verdicts; rollback clean (checkpoint/rollback lines asserted in journals); the gate decides. *(live, three runs)*
- [x] **C7:** triage: one verdict per item with confidence + reason; ambiguous escalates; duplicates escalate for a target. *(live, 4 items)*
- [x] **C8:** refine-loop: per-round scores journaled; revisions scoped to the weakest dimensions; plateau stops with history. *(live)*
- [x] **C9:** red-team: kept attacks judged and confirmed by sys1 heads; fixer + re-attack ran; residuals reported. *(live)*
- [x] **C10:** watchdog: state in → state out; no-change zero-model; a judged change names what and why. *(live, three paths)*
- [x] **C11:** router-eval: mechanical grading (grep guard: no grading ask exists in the file); calibration-ready rows; the table produced. *(live)*
- [x] **C12:** the existing surface untouched: context-probe 19/19 (zero agent calls) and run-API probe 33/33 re-run after every phase; `node --check` clean on every touched file.

## Incident records (recorded honestly)

1. **The Firecrawl allowance burn.** The first deep-research design put scraped searches (`scrapeOptions` per result, ~10+ credits each) inside agent loops with no budget: three shakeout runs plus probes burned ~1915 credits against a 1000-credit plan (**balance −915**; resets 2026-10-18). The redesign makes the burn structurally impossible: searches in the workflow only, no scrape by default, a credit budget the loop honors, enrichment on the self-hosted instance, and agents holding no search tools. The user's directives ("firecrawl is the issue"; "all judging should ride the judge layer") drove the rewire.
2. **The planner that fixed its own bug.** remediate's planner edited the code it was supposed to plan around — before the rollback snapshot was taken. The prompt now bars it, and the ownership manifest would catch it regardless.
3. **The fixer that gamed the gate.** A fixer edited the test to assert the buggy behavior; the gate passed on tampered tests. The ownership manifest + gate-file rule (test/spec files are never fixable, whatever the planner declares) came from that run.
4. **The writer that searched 15 times.** The credit-bounded design said "searches happen in the workflow only" but only in a prompt: agents inherited `web_search` from the run's grant, and a late-run acceptance showed 17 searches / **34 credits actually spent** (13 agent-fired) against a meter that counted only the workflow's 4. Two structural fixes: `persona.tools.deny` (a declared exclusion list — deep-research denies `web_search` on every agent, so the budget cannot be spent around, only through) and one credit meter for both paths (`world.spentCredits()`), which the budget gate now reads. The final acceptance: 2 searches, 0 agent searches, 4 credits, all on the meter. Also fixed in the same pass: the writer building the report through repeated `edit_file` calls (24 rounds, then the 300k line) — one-shot write instruction plus a bounded budget.
5. **User correction, mid-wave: "scraping needs to happen on the self-hosted environment."** The first design judged findings from search snippets and used the self-hosted scraper only as a post-judge enrichment pass. Restructured: candidate pages are read on the self-hosted Firecrawl **before** judging, so the sys1 head rules on real page content — reading is free, searching is not. The config mapping bug this exposed (config `scrapeBaseUrl` vs service `baseUrl`) surfaced as a named refusal in the journal, not a silent skip.

## Out of scope

Alexandria as a search backend (the `backend` seam; discover-then-retrieve when the catalog returns results); live re-acceptance of deep-research on the credit-bounded design (deferred to the allowance reset — the piecewise evidence covers the rewire); AG-UI anything; zcode-router-kit.

## Notes

- **sys1 decision-shape check:** the wave is the judge layer's first broad consumer — five head shapes (`finding-support`, `triage-class`, `red-team-keep`, `red-team-confirmed`, `watchdog-matters`) now feed the calibration store from real runs; refine-loop's rubric scoring is the stated LLM exception. Promotion candidates, all of them, once floors fit.
- **Efficiency rules, baked in:** flat judgment → judge head; generation → agents; searches in one budgeted place; scrapes self-hosted; every stop named.
