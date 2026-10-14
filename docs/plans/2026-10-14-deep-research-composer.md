# Plan — deep-research composes through the validated composer

```yaml
---
status: draft
created: 2026-10-14
updated: 2026-10-14
slug: deep-research-composer
---
```

## Context

The synthesis lane shipped today (plan `2026-10-14-synthesis-lane.md`,
completed): `world.synthesis` + the default-off batch-only `synthesis`
grant, `composed-report` as the standalone validated composer, and
research-report's Writer phase swapped to the composer with the per-angle
research as the givens. deep-research — the kit's flagship iterative
research loop — still has the **same unvalidated step the lane was built
to close**: its "Write the report" phase is an agent
(deep-research.ts:328-344) composing from the finding pool with inline
citations, a contradictions section, and a coverage map, checked only by
other agents (the cold reader, then a writer fix pass).

The difference from research-report makes this the *better* first swap:
deep-research's material is **pre-judged and structured**. Every finding
in the pool was ruled supported/unconfirmed by the sys1 judge head on real
scraped page content (deep-research.ts:238-268), each carries its url and
title, contradictions were extracted with both sides, and the loop
already versions a complete source-ledger artifact per round — so a
prompt-budget drop is visible against a complete record instead of being
a silent loss. The givens contract is the strongest in the kit.

### Verified current-state facts (read this session)

- Loop anatomy (workflows/deep-research.ts, 389 lines, read in full):
  Plan → rounds of (budgeted `world.search` → `world.scrape` ladder →
  scouts extract → sys1 judge head rules each finding) → reflect →
  **Write the report (the Writer agent, :328-344)** → cold reader + fix
  pass (:356-360) → artifact registration with a catch-fallback
  (:362-367) → coverage-map artifact → return
  (`{conclusion, stopReason, roundsRun, stats, verified, notCovered}`).
- The Writer's contract: inline numbered citations, a contradictions
  section keeping both sides, a coverage map naming gaps, ONE write_file
  call, NO_SEARCH, budget rounds:12/tokens:300000.
- The material handed to the Writer: `pool` (supported findings:
  claim/url/title/support/status/confidence/checkNote), `unconfirmed`
  (reported, never presented as fact), `contradictions`
  ({topic, sideA, sideB}), plus `topic` and `stopReason`.
- The composer-swap pattern, proven in research-report.ts today: the
  Writer phase becomes one `world.synthesis("ask", {prompt})` call; the
  givens ride between per-run-nonce markers framed as never-instructions;
  the deliverable is blend1's validated text; the GLiDE verdict rides in
  the journal and as a footer; a non-passing gate ships flagged, never
  blocked; the reader fix-up and the artifact fallback re-compose through
  the grant; `draftSummary` tracks the composition that SHIPS and a gate
  demotion is named.
- The service contract (services.mjs `synthesis()`): `BLEND1_BIN` CLI
  shell, `ask` only, positional prompt, `--json` injected, 180s cap,
  configured absence naming the install, never a crash (the ENOEXEC
  sync-throw fix included).
- Cost: a synthesized ask ≈ $0.0018 measured today (composed-report's
  live run: $0.00151, 44.8s); a re-compose is a second full ask.

### Documented defaults (resolved at draft; revisit at plan approval)

1. **The swap points** — exactly three, mirroring research-report: the
   Writer phase, the reader fix-up, the artifact catch-fallback.
   Everything else byte-identical.
2. **The givens shape** — `{topic, stopReason, pool, unconfirmed,
   contradictions, covered, gaps}` serialized as JSON between nonce'd
   markers. The writing requirements (numbered citations, contradictions
   section, coverage map, gaps named honestly) ride in the ask as the
   loop's own instructions, outside the markers.
3. **The givens budget** — 12000 chars (deep-research's pool is larger
   than research-report's perAngle), built **per finding** with every
   dropped finding named by claim + url in the ask, the report row, and
   the footer. The source-ledger artifact remains the complete record —
   the composer's contract is which findings it may cite, and a drop is
   never silent.
4. **The run record** — `draftSummary` rebuilt from the composition that
   ships after a reader fix-up; a gate demotion (first passed, retry did
   not) is named, never silent — the research-report fix carried over
   verbatim.
5. **Tests** — the text pins in tools/unit-services-synthesis.mjs gain
   deep-research's swap points (grant call, nonce markers, per-finding
   accounting, draftSummary tracking, demotion naming); the live run is
   the behavioral proof.
6. **Spend visibility** — one live run ≈ $0.0018 + the local-router agent
   calls the loop already makes; the journal carries the gate outcome,
   the cost, and any dropped findings.

## Approach

### Phase 1 — the swap

1. `workflows/deep-research.ts`, the Writer phase (:327-344): one
   `world.synthesis("ask", {prompt})` call — the prompt carries the
   topic, the stop reason, the writing requirements, and the givens
   (pool/unconfirmed/contradictions/covered/gaps) between per-run-nonce
   markers with the never-instructions sentence and the dropped-findings
   note. Fail-open returns for every refusal path (grant, absence, empty
   answer), the loop ending with the reason named and the ledger
   artifacts standing.
2. The reader fix-up (:356-360): re-compose through the grant with the
   reader's issues as feedback; a failed re-compose leaves the first
   composition standing, the failure named; `draftSummary` rebuilt from
   the shipped composition; demotions named.
3. The artifact catch-fallback (:362-367): re-compose once and
   re-register, exactly as research-report's does.
4. The gate footer on the deliverable: outcome, path, cost
   ("unmeasured" when null), latency, dropped-findings note.

### Phase 2 — pins + docs

5. tools/unit-services-synthesis.mjs: the deep-research pins (grant call,
   nonce'd END marker, per-finding cap with named drops, draftSummary +
   demotion, no Writer agent remains).
6. Docs: docs/features/synthesis-lane.md gains the deep-research row,
   README's loop table, CLAUDE.md's wave line, this plan, and the recap
   at completion.

## Acceptance Criteria

- [ ] **AC1** — deep-research's deliverable is composed by blend1 through
  the grant; the pool/unconfirmed/contradictions ride as the givens
  between nonce'd markers; the writing requirements ride in the ask;
  every refusal path fails open by name (text pins + live).
- [ ] **AC2** — the Plan/search/scrape/scout/judge/reflect phases, both
  artifacts (source ledger, coverage map), and the return are
  byte-identical (diff review against the pre-image).
- [ ] **AC3** — the givens budget is per-finding with every dropped
  finding named in the ask, the report row, and the footer; the
  source-ledger artifact stays the complete record (text pins + live).
- [ ] **AC4** — the run record tracks the composition that ships:
  `draftSummary` is rebuilt after a reader fix-up and a gate demotion is
  named (text pins + the research-report pattern's proof).
- [ ] **AC5** — eval-only unchanged: a non-passing gate ships the
  deliverable flagged with the footer, exit 0 (live).
- [ ] **AC6** — `npm test` green (the pins updated; the suite count is
  unchanged — no new file).
- [ ] **AC7** — live: one real `deep-research` run whose composed
  deliverable carries the gate verdict and whose journal row carries the
  outcome, cost, and any drops (parent-run — ~$0.002 + the loop's local
  agent calls). **Known caveat**: today's three live attempts at
  research-report died at the kit's 24-tool-round cap inside the
  byte-identical agent phases (Scoper/scouts) — deep-research shares
  those phases, so the live leg may need retries on a quiet machine; the
  compose phase under test is downstream of them.

## Files to be Touched

**New**
- `docs/plans/2026-10-14-deep-research-composer.md` (this plan)

**Modified**
- `workflows/deep-research.ts` — the Writer phase, the reader fix-up,
  the artifact fallback
- `tools/unit-services-synthesis.mjs` — the deep-research pins
- `docs/features/synthesis-lane.md`, `README.md`, `CLAUDE.md` — the lane
  gains its second loop
- `docs/recaps/` — the session recap at completion

**Deleted**
- none

## Out of Scope

- The free TinyFish search leg beside the metered Firecrawl one (the
  search leg stays exactly as it is in this plan — the credit discipline
  is the loop's shape, not the target).
- The router's "composed" tier (roster.json — separate).
- Per-project corpora × the plane's context (separate).
- The pre-existing scout/Scoper round-cap instability (recorded in the
  synthesis-lane plan's AC4; a loop-behavior fix, not this swap).
- Any blocking behavior on synthesis output.

## Verification

```bash
# offline gate
npm test                                              # 33 suites, the pins included
node tools/unit-services-synthesis.mjs                # the service + pins suite
git diff HEAD~1 -- workflows/deep-research.ts         # the three hunks, nothing else
# live (parent) — blend1's venv; a quiet machine helps the agent phases
export BLEND1_BIN=/Users/alejandrodelvillar/Projects/blend1/.venv/bin/blend1
node bin/agnostic-router-kit.mjs workflows run deep-research --workdir <dir> --grant synthesis \
  --args '{"topic":"<a research question>","depth":1}'
```

Expected: the deliverable is blend1's validated text with the gate
footer; the journal's `synthesis_ask` row carries the outcome, cost, and
any dropped findings; the source ledger and coverage map are unchanged;
the return's conclusion names the shipped composition's gate.

## Linked Artifacts

- `docs/plans/2026-10-14-synthesis-lane.md` — the lane (completed); its
  AC4 records the agent-phase instability this plan's live leg shares
- `workflows/research-report.ts` — the proven swap pattern this mirrors
- `workflows/composed-report.ts` — the standalone composer
- blend1 (`~/Projects/blend1`) — the lane behind the grant

## Risks

| Risk | Mitigation |
|---|---|
| The live leg rides the pre-existing agent-phase instability (Scoper/scouts hitting the 24-round cap) | The compose phase is downstream and byte-isolated; retries on a quiet machine; the text pins + the research-report pattern carry the offline proof; the caveat is recorded in AC7, not hidden |
| A big pool over the prompt budget silently loses supported findings | Per-finding accounting with every drop named in the ask, the report row, and the footer; the source-ledger artifact stays the complete record |
| The reader fix-up re-composes the whole report (~$0.0018) | The research-report finding accepted with accounting: the pool rides again as the givens; a failed re-compose leaves the first composition standing, named |
| Untrusted web text steering the synthesizer | The givens ride between per-run-nonce markers framed as never-instructions — a fetched page cannot carry the run's nonce; eval-only bounds the blast radius |
| blend1's router fires the web lane mid-run | The grant ships `ask` only and never `--live`; d1 decides per ask (observed live at 0.037 on a gate-explanation ask) |
