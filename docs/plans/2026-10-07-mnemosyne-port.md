---
status: completed
created: 2026-10-07
updated: 2026-10-07
slug: mnemosyne-port
---

# Plan: porting mnemosyne into the memory plane

**Repo:** agnostic-router-kit. **Scope:** mnemosyne's deterministic machinery — veracity, SPO facts with compounding confidence, derived conflicts with supersession, temporal triples, the scratch tier and its consolidation cycle, ranked recall — ported onto the kit's JSONL graph as a format superset, per the user's direction ("this needs to be ported to the agnostic-router-kit", "this" = the memory system Hermes has). The source was read in full first (beam.py 5,971 lines, veracity_consolidation, extraction, entities, the live DB schema); the port is by rule, not by translation.

**What deliberately did not port:** embeddings/vector search, passive conversation capture (`sync_turn`, identity phrases), LLM prose extraction, episodic degradation tiers (1→2→3), the shared-surface second DB, and the SQLite/Python implementation. Each is stated in the feature doc with the reason — the kit's durable tier is explicit-first and dependency-free.

## What landed

### Phase 0 — the enriched store — ✅ done
`lib/workflow/memory.mjs`: **unknown fields round-trip** (each row carries its `extra` through load→save — the format-superset guarantee); entity enrichment (`importance`, `veracity` clamped to mnemosyne's five labels, `validUntil`, `supersededBy`, `scope` defaulting global, `mentions`, `consolidatedOf`, `source`); relations as facts (`id` = mnemosyne's `f_`+sha24 of the SPO, `confidence`, `mentionCount`, `sources`); `addFact` (first mention = weight × 0.5; repeat = `c + (1-c)·w·0.3` cap 1.0; same S+P different O returns a conflict), `resolveConflict` (the winner supersedes the loser — mnemosyne's dormant auto-resolution, invoked), `addTriple` (temporal law: a new S+P closes the open predecessor — kept deliberately separate from the fact law, which mnemosyne also keeps separate), `invalidate`; the scratch tier (`addScratch`: session scope, 24h TTL, mnemosyne's default) and `consolidate` (eligibility = age over half-TTL, unclaimed; group by source; digests additive with `consolidatedOf`; `aggregateVeracity` votes non-unknown labels by mode); `searchGraph` gains mnemosyne's deterministic ranking (relevance × 0.45 + importance × 0.25 + recency decay over a half-week × 0.2 + veracity × 0.1, ×1.25 mention boost) while keeping the official server's substring match semantics (full query, or every word present).

### Phase 1 — the commands — ✅ done
`kit memory remember` (with `--fact "s p o"`, `--triple`, `--importance`, `--veracity`, `--extract`), `scratch add|list|clear`, `facts [--conflicts]` (the registry view with confidence/mentions/veracity and the resolve recipe), `consolidate [--dry-run]` (deterministic digest first; one fail-open `model: auto` summarization when the router is healthy — `lib/memory-summarize.mjs`), `resolve`, `invalidate`; `doctor` reports conflicts and expiries via stats; `import` carries importance/veracity from mnemosyne exports.

### Phase 2 — the wires — ✅ done
The MCP server's `create_entities` accepts the enrichment fields (schema superset, documented in the description) and gains `add_fact` (kit-extra tool returning the derived conflicts); `/api/memory` and `/v1/memory` accept `importance`/`veracity`/`scope`/`validUntil`/`extract` and `fact`, return ranked hits; `/chat`'s `/recall` shows ranked, veracity-tagged hits and `/remember` writes stated-at-0.7.

## Acceptance criteria

- [x] **C0** enrichment round-trips with the official loader — probe-memory I: extras survive load→save, every kit row parses in the official shape, foreign unknown fields round-trip.
- [x] **C1** veracity: clamping + the exact weight table; ranking demonstrably reorders (probe-memory E/H).
- [x] **C2** facts: compounding verified live (50% → 65% → 76% across three CLI mentions); conflict recorded and winner-by-confidence; resolution supersedes and hides the loser; temporal triple closes its predecessor. (probe-memory F + live CLI run)
- [x] **C3** tiers: scope visibility both ways; scratch TTL; consolidation eligibility at half-TTL; additive digests with `consolidatedOf`; dry-run leaves rows eligible; the claim marker (`extra.consolidatedAt`) makes consolidated rows ineligible. (probe-memory G)
- [x] **C4** ranked recall: importance+recency+veracity reorder a fixture; the mention boost wins. (probe-memory H)
- [x] **C5** wires: MCP enrichment + `add_fact` (probe-memory-mcp 9/9); routes accept enrichment with ceilings unchanged (probe-memory-api 14/14); chat parses.
- [x] **C6** import carries importance/veracity (import path shared with the enrichment fields).
- [x] **C7** zero new dependencies; neutrality grep clean; all suites green — memory 45, memory-mcp 9, memory-api 14, run-API 33, keys 30, chat-surface 14 (145 checks).
- [x] **C8** docs current in-wave (feature doc, TECH-DOC, README, this plan); diagram story unchanged by the port (the node already says "durable, cross-run" — the tier detail lives in the docs), so no re-finalize needed.

## Incident records (recorded honestly)
- **The env-var shadowing bug class, again**: the first probe run after enrichment read the wrong store — same failure mode the memory-server wave hit; the probes are the detector.
- **JS `split` with a limit discards the remainder** (unlike Python): `--fact "Alejandro uses ZCode daily"` parsed object = "ZCode", silently merging distinct facts into one compounding row. Caught by live testing (three mentions on one id), fixed to first-two-words + rest.
- **Port-fidelity catch, the valuable one**: the first `addFact` merged mnemosyne's two distinct mechanisms — it compounded AND auto-invalidated, so contradictions auto-expired instead of recording conflicts, and `facts --conflicts` was unreachable. The source reread split them: facts compound/conflict (consolidated_facts law); temporal triples invalidate (TripleStore law). Both now verified live.
- **A probe choreography bug**: the "dry-run" check ran a real consolidate on the shared graph, so the subsequent real run had nothing eligible. The module contract (a run marks only the graph it was given) is what makes the CLI's `--dry-run` correct — the probe now proves it with a clone.

## Out of scope
As stated: embeddings, passive capture, LLM prose extraction, degradation tiers, the shared-surface DB. Judge-ridden conflict resolution (which conflict should win?) is the kit-native next step — the conflicts are already derived and the judge layer already exists.

## Notes
The port's shape rule held: port mnemosyne's *deterministic machinery by rule*, keep the format superset compatible, and let the LLM-heavy parts stay where they already work. The kit's memory plane now answers the original ask — short/medium/long term with a knowledge graph — for every harness that speaks MCP or HTTP.
