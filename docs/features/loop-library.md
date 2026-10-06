# The loop library

*2026-10-06. One plan, seven loops: `docs/plans/2026-10-06-loop-library-wave.md`. The library's one-pass workflows (research-report, review-sweep, bug-hunt, decision-memo, deep-dive, postmortem, content-production) predate this wave; these seven add the loop shapes they lacked.*

## The judge layer

Every yes/no, keep/drop, class, and matters judgment in the loops rides the **sys1 judge layer** — `sys1.judge(spec, text)` on the workflow surface: dev-decisions first (rows land in the shared calibration store with `input_sha256`), raw sys1 as the recorded fallback. Flat judgments are the decision layer's job; the LLM agents do generation only. Where a judgment point intentionally stays an LLM ask (content scoring in refine-loop), the workflow says so. Consequences, measured in the shakeout: triage of four items runs in 1.4 seconds with zero agent calls; a stuck checker costs a sys1 call, not 56k tokens.

## The loops

- **deep-research** — `docs/features/deep-research.md`. Credit-bounded iterative research; searches run in the workflow only, findings judged by a sys1 head, enrichment through the operator's self-hosted scraper.
- **remediate** — applies confirmed findings: planner groups by file, fixers work under per-group checkpoints, the verify command decides, a group that cannot verify rolls back clean. Ownership is enforced in code: a whole-workspace manifest before and after each fixer, and any change outside the group's declared files — **or to a gate file (tests/specs), declared or not** — voids the fix and rolls it back. Born from a live run where a fixer "passed" the gate by editing the test.
- **triage** — high-volume classify and route: one sys1 head per item (class + confidence), ambiguous items escalate with a structured topic instead of being guessed, duplicates escalate for a target name. The first feed is CI failures, over the run API.
- **refine-loop** — rubric-scored fix rounds: score per dimension, revise the weakest only, stop on plateau (improvement under 0.5) with the score history in the record. The per-round scores are calibration rows collected as a side effect.
- **red-team** — hostile attack before ship: persona challengers (LLM), keep/drop and confirmation by sys1 heads over the deliverable text, a fixer for confirmed attacks, and one re-attack round — residuals are reported, not re-fixed.
- **watchdog** — state in, state out: the spawner carries prior state between runs (spawn facts / result state), the diff is deterministic hashes, and the sys1 `matters` head is the only judgment — a no-change run spends nothing.
- **router-eval** — the calibration feeder: golden tasks with mechanically checkable outcomes replayed across router profiles or pinned models (`persona.model`), graded by substring checks — never a model verdict — with a per-candidate accuracy/spend/latency table and JSONL calibration rows.

## Efficiency rules the wave bakes in

1. Flat judgment → sys1 judge head; generation → LLM agents. Never an agent asked for a yes/no.
2. Search credits are budgeted in the workflow, searched in one place, and agents hold no search tools.
3. Scrapes point at the self-hosted instance (`FIRECRAWL_SCRAPE_URL`); the cloud search API stays no-scrape.
4. Every stop — coverage, plateau, depth, credit-budget — is named in the result, never hidden in a last round.
