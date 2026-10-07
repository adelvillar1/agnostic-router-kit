# Local browsing — the plane's browser, and the de-Firecrawl ladder

*Shipped 2026-10-07. Plan: `docs/plans/2026-10-07-local-browsing.md`. Unit probes: `tools/unit-services-browser.mjs` (moli-gated — they run where moli is installed and report skipped where it is not, never failing a machine without it).*

The plane's net legs used to be a plain bounded fetch and a paid search API. They are now a ladder: a real browser
renders pages locally first, a hosted fallback catches what the browser cannot, and search works with no key at all.
The rendered read is JS-true — a page plain fetch sees as an empty shell, the browser sees as the operator sees it —
and it is local and private: nothing leaves the machine but the page request itself.

## The stack

- **`browserFetch(url, opts)`** — the rendered leg. Shells the moli CLI (`moli fetch --dump <format>
  [--wait-selector <s>] <url>`) under exactly `fetchUrl`'s discipline: the run's domain allowlist is honored (an empty
  allowlist fetches nothing rather than everything), the byte cap and the wall clock are the plain fetch's own, and a
  dump past the cap stops being drained — the child is killed and the truncation is reported, never hidden. `format`
  is `markdown` by default; `waitSelector` holds the dump until a selector exists, for pages that paint late.
- **`scrapeUrl(url, opts)`** — the scrape router: moli first, then a self-hosted Firecrawl scrape
  (`FIRECRAWL_SCRAPE_URL`, the operator's own instance, unchanged), then the plain bounded fetch as the floor that
  still works on static HTML. The result carries **`via`** — `moli`, `firecrawl`, or `fetch` — the leg that actually
  answered, because a workflow citing a page should be able to cite how it was read; the `via` lands in the run
  journal with every scrape.
- **`searchWeb(query, opts)`** — three backends. `duckduckgo` is keyless (the html endpoint, parsed under the same
  bounded discipline as any page, `creditsUsed: 0`); `firecrawl` is the v2 cloud API, the only leg that can scrape its
  results inline; **`auto`**, the default, reads DuckDuckGo first and demotes Firecrawl to a fallback it reaches only
  when DDG came up empty or failed *and* the `FIRECRAWL_API_KEY` actually resolves. One ask is firecrawl-only
  whatever was pinned: a search with `scrape`, because a DDG result page carries no markdown to scrape. The row shape
  is unchanged — `url`, `title`, `description`, and `content` when a leg could produce it.
- **`browserSession(opts)`** — the v2 tier: one `moli serve [--layout]` child on a free loopback port, readiness
  proven by polling `/json/version`, and a `close()` that owns its death. It hands back a verified port and the off
  switch; page automation rides the optional playwright peer (`chromium.connectOverCDP`), and its absence is a
  refusal, not a crash.

## Install posture: moli is the operator's binary

moli is never bundled, never auto-downloaded. The pinned release and its checksum are recorded in the browsing plan;
the operator installs it onto `PATH` (e.g. from the
[release page](https://github.com/lexmount/moli/releases)) and verifies it:

```bash
moli --version                                   # → moli 1.1.14
shasum -a 256 moli-aarch64-apple-darwin.tar.gz   # → db123f0fe3ccb25149a2a756ff71eb08e640854ba89bc2f42f2dcd73a526eec4
```

`kit doctor` reports the stack like it reports sys1: moli on PATH → a green line with the version
(`local browser (moli) — v1.1.14 — …`); moli absent → a dim note, not a failing check — a machine without a browser
is a configured absence, the same law as a missing key.

## The grants

Two capabilities, both **default-off**, opted in at spawn exactly like `package` and `net-fetch`:

- **`browser`** — `browserFetch`, the `web_render` tool, and the moli leg of the scrape router.
- **`browser-layout`** — `moli serve --layout` and everything layout enables: coordinate input and screenshots.

A run without the grant gets the usual refusal, by name and journalled:
`capability not granted in this run: browser — … — rerun with --grant browser`. `web_render` is the agent-facing tool
(`{ url, format?, waitSelector? }`); its journal line is a `tool` line carrying the grant, the `via`, and the bytes.
`web_fetch` and `web_search` are unchanged except that `web_search` passes a `backend` through.

## Refusals are sentences, and Firecrawl is not gone

Every failure in the stack is a fail-open sentence naming the fix — the plane never throws a run away over a missing
binary or key. moli absent: *"browser not installed — the browser grant needs moli on PATH (see docs)"*. No session
peer: *"the browser session needs playwright installed (npm i -D playwright) and moli on PATH"*. No Firecrawl key
where one is required: a refusal naming the variable.

The de-Firecrawl story is a demotion, not a removal. The scrape leg is moli-first with self-hosted Firecrawl as the
middle rung and plain fetch as the floor; search is keyless-first with Firecrawl as the quality fallback — and with
no key configured, DuckDuckGo's answer (results, empty, or its own refusal) is the honest one. Workflows that never
knew moli exists keep working; they just read truer pages and spend fewer credits.
