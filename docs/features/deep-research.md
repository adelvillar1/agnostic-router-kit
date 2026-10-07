# deep-research — the iterative research loop

*Shipped 2026-10-06. Plan: `docs/plans/2026-10-06-loop-library-wave.md`. Fixture probes: `workflows/search-probe.ts` (the search capability), `workflows/judge-probe.ts` (the judge layer).*

`research-report` is one fan-out pass. `deep-research` is the loop: reflect between rounds, decide what is still unknown, go again — and stop on honest grounds rather than on confidence.

## The loop

1. **Plan** — a planner splits the topic into `breadth` sub-questions.
2. **Round** — for each open sub-question, the **workflow** runs one cheap search (no page scrapes — the cloud API bills per scraped result) on the keyless-first backend (`auto`: DuckDuckGo, Firecrawl as fallback), then **reads the candidate pages through the scrape router** (`world.scrape` → moli locally first, the operator's self-hosted Firecrawl (`FIRECRAWL_SCRAPE_URL`) as fallback, plain fetch last — up to `scrapeBudget` per round, so the loop judges real page content, not search snippets). Every read names its path (`via: moli | firecrawl | fetch`) in the journal, the per-round logs carry a sources-by-path tally, and a suspiciously thin read is marked (`thin`) — a JS shell smelled, not silently judged. A **sys1 judge head** (`deep_research_finding_support`) rules each finding supported or unconfirmed on the scraped content. Dev-decisions first, sys1 fallback, calibration-store rows — the plane's judgment law. A **sys1 judge head** (`deep_research_finding_support`) rules each finding supported or unconfirmed on the scraped content. Dev-decisions first, sys1 fallback, calibration-store rows — the plane's judgment law.
3. **Reflect** — a reflector returns what is answered, the contradictions (both sides kept, never averaged), the gaps, and the next sub-questions.
4. **Stop** — coverage (no next questions), plateau (no new sources in a round), depth, or the credit budget. Every stop reason lands in the result.
5. **Synthesize** — a writer produces the report with inline numbered citations, a contradictions section, and a coverage map; a cold reader closes before handover.

Artifacts: `deliverable` (primary), `source-ledger` (versioned per round — the round history is the artifact history), `coverage-map`.

## The credit discipline

The first version of this loop burned ~1900 Firecrawl credits in three shakeout runs: scraped searches (`scrapeOptions` per result) inside agent loops, repeated, unbudgeted. The redesign makes that class of burn structural-impossible:

- **Searches happen in exactly one place** — the workflow, one cheap (no-scrape) call per sub-question, deduped by query. Agents have no search tools; an agent loop cannot spend.
- **A run-level credit budget** (`args.creditBudget`, default 20 credits; a search is roughly 2) — the loop stops searching when it is spent and says `credit-budget` in the result.
- **Enrichment rides the scrape router, not the cloud API.** After judging, up to `scrapeBudget` (default 2) unconfirmed findings are re-read through a self-hosted Firecrawl (`FIRECRAWL_SCRAPE_URL`, v1 markdown — the self-hosted `summary` format needs an LLM backend most deploys don't carry) and re-judged with the fuller page. Unconfigured, enrichment skips by name and the run proceeds on search rows. Unconfirmed means "not enough evidence", so fuller evidence may upgrade a finding; a contradiction never does.
- **Judgments are sys1 calls, not LLM asks** — a checker batch of six verify-shaped agents was the single biggest token burn in the shakeout; the judge head replaces it at a fraction of the cost, and every verdict lands in the calibration store.

## Knobs

`topic` (required) · `breadth` (1-6, default 3) · `depth` (1-3, default 2) · `creditBudget` (default 20).

## Embedding

Over the run API: `POST /v1/runs` with `workflow: "deep-research"`, the topic args, and `net-search` inside the app's grant ceiling. The report and ledger come back as artifacts; the journal answers "what did this research cost" in both currencies (`creditsUsed` per search, token accounting per ask).
