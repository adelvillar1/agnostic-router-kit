---
status: active
created: 2026-10-07
updated: 2026-10-07
slug: local-browsing
---

# Plan: local browsing (moli) — the plane's browser grant and the de-Firecrawl push

**Repo:** agnostic-router-kit. **Goal:** give the plane local, private, JS-true browsing (moli) so the research workflows stop depending on Firecrawl services where a local path exists. Two reductions: (1) the **scrape leg** — deep-research's candidate-page reads currently run on self-hosted Firecrawl (`FIRECRAWL_SCRAPE_URL`) — moves to moli-first with Firecrawl as fallback; (2) the **search leg** — currently Firecrawl cloud API only — gains a keyless backend (DuckDuckGo HTML) with `auto` preferring it, Firecrawl demoted to fallback. Firecrawl is never removed; it becomes the quality fallback when moli/DDG fail or are absent.

**Method:** delegated waves against the pinned interfaces below. The plane (`lib/workflow/`) is the engine's checkout and the kit's `file:` dependency — `npm run check:port` in ~/Projects/zcode-router-kit must stay green after every wave, and the kit's own `npm test` is a cross-edition regression gate.

## Install posture (operator, version-pinned)

moli is an external binary, never bundled, never auto-downloaded: documented version + SHA-256, operator installs to PATH. `kit doctor` reports it like sys1. For this machine: install the pinned release, record version+checksum in the plan's incident section.

## Pinned interfaces (the delegation contract — implement exactly these)

```js
// services.mjs — new exports
browserFetch(url, { format = "markdown", waitSelector = null, timeoutMs, maxBytes, allowlist = [] })
// → shells `moli fetch --dump <format> [--wait-selector <s>] <url>`; SAME discipline as fetchUrl:
//   allowlist honored (empty = refuse), byte cap, wall-clock cap, UA unchanged; moli absent →
//   { ok: false, reason: "browser not installed — the browser grant needs moli on PATH (see docs)" }.
scrapeUrl(url, { format = "markdown", maxBytes, timeoutMs, allowlist = [] })
// → the unified scrape router: moli (browserFetch) → self-hosted Firecrawl scrape (FIRECRAWL_SCRAPE_URL,
//   existing discipline) → fetchUrl fallback. Returns { ok, content, via: "moli"|"firecrawl"|"fetch" } — `via` is journaled.
searchWeb(query, { backend = "auto", limit, scrape = null, ... })
// → backend "auto": duckduckgo (keyless html.duckduckgo.com, parsed via the fetchUrl discipline) first;
//   firecrawl fallback (existing path, only when FIRECRAWL_API_KEY resolves). Explicit "duckduckgo" |
//   "firecrawl" pin a single backend. Refusals stay fail-open sentences.
browserSession({ layout = false, profileDir = null })  // v2 tier
// → spawns `moli serve [--layout] --port <free>` as a lifetime-capped child (ProcessRegistry), health-probes
//   /json/version over plain http, returns { port, close() }. Page automation via optional peer:
//   dynamic import("playwright") → chromium.connectOverCDP — absent → refusal
//   "the browser session needs playwright installed (npm i -D playwright) and moli on PATH".
```

```js
// tools.mjs — grant vocabulary + one new tool
// grants: "browser" (browserFetch / web_render / scrape-via-moli), "browser-layout" (serve --layout,
//         coordinate input, screenshots) — BOTH default-off, spawner opts in like package/net-fetch.
// tool web_render: { url, format?, waitSelector? } → browserFetch; journal kind "tool", tool "web_render",
//         records via + bytes. web_search gains opts.backend passthrough; web_fetch unchanged.
// world surface (harness): world.scrape routes to scrapeUrl; world.browser (v2) behind browser grants.
```

## Waves (the delegation map)

- **W1 — foundation (one agent, sequential; the coupled file):** services.mjs — browserFetch, scrapeUrl, searchWeb backends, browserSession + ProcessRegistry wiring. Unit-probe coverage in a new `tools/unit-services-browser.mjs` (moli-gated: checks run when moli is on PATH, report "skipped (moli not installed)" otherwise — never fail a machine without it).
- **W2 — parallel batch after W1's exports are verified (three agents, disjoint files):**
  - **A — tools + grants:** tools.mjs (web_render, grants, backend passthrough) + grant documentation strings.
  - **B — workflows:** deep-research.ts (scrape leg rides the new scrapeUrl — mostly free via world.scrape; shell-escalation: a scraped page under a tiny content floor gets one browserFetch retry) + research-report.ts backend plumb.
  - **C — doctor + docs:** lib/cli.mjs doctor line ("browser: moli <version> found / not installed — web_render and rendered scrapes disabled"); README browsing paragraph; docs/features/browsing.md; TROUBLESHOOTING entries; FUNC-SPEC/TECH-DOC touchpoints.
- **W3 — integration (me):** wire world.scrape/world.browser in harness.mjs (the one file W2 shouldn't touch), npm test both editions, check:port, probe against real moli.
- **W4 — docs close:** plan closed with deviations, recap.

## Acceptance criteria

- [ ] **C0** moli installed at the pinned version (checksum recorded in this plan's incident section); `kit doctor` reports it.
- [ ] **C1** `browserFetch`/`scrapeUrl`/`searchWeb` match the pinned interfaces; allowlist + caps discipline identical to fetchUrl.
- [ ] **C2** `world.scrape` routes moli → self-hosted Firecrawl → fetch, with `via` in the journal; deep-research reads show `via` per row.
- [ ] **C3** search `auto` prefers keyless DuckDuckGo; Firecrawl demoted to fallback (and unused when its key is absent); explicit backends still pin.
- [ ] **C4** `web_render` behind the `browser` grant, default-off, refusal journaled when absent; serve tier behind `browser-layout` + playwright-peer refusal sentence exactly as pinned.
- [ ] **C5** probes: new unit-services-browser green (moli present here); full `npm test` green in the engine AND the kit; `check:port` green.
- [ ] **C6** docs in-wave: features/browsing.md, README, doctor, TROUBLESHOOTING, specs; plan closed; recap.

## Out of scope

- Bundling/auto-downloading the moli binary; running `--layout` without the `browser-layout` grant; replacing the Firecrawl *search quality* — DDG is the keyless default, Firecrawl stays the quality fallback.
- WebDriver BiDi; multi-session pools; proxies.
