# Session recap — 2026-10-07 (browsing): moli in the plane, Firecrawl demoted

**Plan:** `docs/plans/2026-10-07-local-browsing.md` (completed). Method: delegated waves against pinned interfaces — a foundation agent on the coupled file, then a three-agent parallel batch (tools+grants / workflows / doctor+docs) with integration and gates mine.

## What landed

- **Foundation (W1, `a5ddac8`)**: `services.mjs` gained `browserFetch` (moli CLI, the fetchUrl discipline — allowlist, byte cap, wall-clock kill), `scrapeUrl` as the unified router (**moli → self-hosted Firecrawl → plain fetch**, `via` on every result), `searchWeb` backends (`auto`: keyless DuckDuckGo first, Firecrawl fallback when the key resolves; explicit pins; scrape asks stay firecrawl-only), and `browserSession` (moli serve lifecycle). `gateUrl` now shares one code path across all three fetchers. moli **v1.1.14** installed at `/opt/homebrew/bin/moli` (checksum in the plan); `tools/unit-services-browser.mjs` — 19 checks, moli-gated so machines without it skip, not fail.
- **W2 (three agents, parallel)**: `web_render` behind the **`browser` grant, default-off** (resolveGrants proven: defaults unchanged), `browser-layout` reserved; `web_search` backends in the tool surface; deep-research records **`via` per row**, marks **`thin`** reads (shell heuristic), and tallies **sources-by-path** per round and in the report; `kit doctor` reports moli; `docs/features/browsing.md` (new), README, TROUBLESHOOTING, both specs.
- **Integration (W3, mine, found by the agents)**: `engine.mjs` recordTool now forwards `via`/`bytes`/`truncated` (web_render's stream line was being shaved); `lib/cli.mjs` runs workflows with `backend: "auto"` — the hard `firecrawl` pin would have made the whole keyless-first story dead code; `deep-research.md`'s scrape story rewritten to the ladder; the loop diagram's audit came in two passes — the label grep found no Firecrawl claims, but a fresh-eyed look at the rendered still caught the "Self-hosted scrape — the operator's Firecrawl, free" node, now "Read the candidates — moli first · Firecrawl falls back · fetch last".

## The de-Firecrawl ledger

- **Scrape leg**: moli first — self-hosted Firecrawl is now the *fallback*, plain fetch the floor. A run's journal answers "which path served this source" per row.
- **Search leg**: keyless DuckDuckGo is the default; Firecrawl search fires only on DDG failure/empty *and* only when the key resolves. Nothing removed — quality fallback by design.
- A CLI-run workflow with the old pin would have silently kept Firecrawl; the pin is gone.

## The honest list

- W1's first probe run applied to the live machine taught the kit's scratch contract; this session's W1-equivalent taught the opposite lesson — **read the call sites before pinning an interface**: `scrapeUrl` already existed, and its options bag is a superset of the plan's (recorded in the plan).
- `probe-keys-endpoint` went intermittently red under full-suite load (2 of 4 runs; always green standalone/re-run). Pre-wave it was stable. Open seam: root-cause the load sensitivity.
- The kit edition's installed runtime is 3 plane modules stale until someone runs `kit apply` there — deliberate mid-session abstention; its scratch-applied suite is green against the new plane (6/0), so the wave is proven cross-edition either way.

## Numbers

16 engine suites green (incl. the new 19-check browser probe against real moli) · kit 6/0 · check-plane green modulo the named deployment step · 7 commits · zero new runtime dependencies · the searches that leave the machine are now queries to DuckDuckGo, not queries + page contents to Firecrawl.
