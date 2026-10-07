#!/usr/bin/env node
/**
 * The browsing services, mostly without a browser.
 *
 * browserFetch / scrapeUrl / browserSession hang off an external binary
 * (moli), and a machine without it is a supported shape, not a broken one —
 * so this suite is skip-aware: the checks that need the binary run only when
 * it is on PATH, and the checks that prove the refusals and fallbacks a
 * moli-less machine actually lives on run everywhere. The search routing is
 * stubbed at the global fetch (the transport suite's trick): the interesting
 * behaviour is which backend gets called in which order, and a stub makes
 * that deterministic and free. Nothing here talks to a real search engine.
 *
 *   node tools/unit-services-browser.mjs
 */
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";

const engineDir = path.resolve(import.meta.dirname, "..");
const { browserFetch, scrapeUrl, searchWeb, browserSession } = await import(
  path.join(engineDir, "lib", "workflow", "services.mjs")
);

// ── the harness ──────────────────────────────────────────────────────────────

const moliProbe = spawnSync("moli", ["--version"], { stdio: "ignore" });
const moliPresent = !moliProbe.error;

let pass = 0;
const failures = [];
/** One named case, run and counted; the name is what a failure reports. */
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok — ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL — ${name}: ${String(e?.message ?? e).slice(0, 220)}`);
  }
}

/** A loopback http server that answers every request with one page. */
function serveHtml(html) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

/** A loopback port nobody is listening on — bind, learn the number, let go. */
async function closedPort() {
  const server = await serveHtml("unused");
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
}

/** Replace globalThis.fetch with one that always answers from `responder`. */
async function withFetch(responder, body) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return responder(calls.length, String(url), init);
  };
  try {
    return { out: await body(), calls };
  } finally {
    globalThis.fetch = real;
  }
}

/** Enough of a Response for what searchWeb reads off one. */
function stubResponse({ status = 200, text = "" }) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => text,
  };
}

/** Poll until the port stops answering, or the patience runs out. */
async function portGoesQuiet(port, withinMs = 5000) {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// ── fixtures ─────────────────────────────────────────────────────────────────

const MARKER = "moli-probe-marker-9f31";
const LOCAL_PAGE = `<!doctype html><html><head><title>probe page</title></head>
<body><h1>${MARKER}</h1><p id="late">rendered text</p></body></html>`;

// The shape a DDG html results page actually has: result__a anchors whose
// href hides the target in a uddg param, snippets beside them, and anchors
// that are neither (nav, ads) in between.
const DDG_PAGE = `<!doctype html><html><body>
<div class="result">
<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ffirst&amp;rut=aaa">First <b>result</b> &amp; title</a>
<a class="result__snippet" href="//duckduckgo.com/l/">The first snippet says &quot;hello&quot; &amp; more</a>
</div>
<div class="result">
<a rel="nofollow" class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fsecond%3Fx%3D1%26y%3D2&amp;rut=bbb">Second result</a>
<a class="result__snippet">Second snippet text</a>
</div>
<a class="nav-link" href="//duckduckgo.com/?q=next">next page</a>
</body></html>`;

const DDG_EXPECTED = [
  {
    url: "https://example.com/first",
    title: "First result & title",
    description: `The first snippet says "hello" & more`,
  },
  { url: "https://example.org/second?x=1&y=2", title: "Second result", description: "Second snippet text" },
];

const FIRECRAWL_SEARCH = JSON.stringify({
  success: true,
  creditsUsed: 7,
  data: {
    web: [
      { url: "https://one.example/", title: "One", description: "first hit" },
      { url: "https://two.example/", title: "Two", description: "second hit", markdown: "## two\ncontent" },
    ],
  },
});

const KEY_ENV = { FIRECRAWL_API_KEY: "test-key" };
const isDdg = (url) => url.startsWith("https://html.duckduckgo.com/html/");
const isFirecrawl = (url) => url === "https://api.firecrawl.dev/v2/search";

// ── the gate: allowlist refusals come before any leg, binary or not ──────────

await check("browserFetch: an empty allowlist fetches nothing", async () => {
  const r = await browserFetch("https://example.com/page", { allowlist: [] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "this run granted net-fetch with no domain allowlist, so nothing is fetchable — pass --allow-domain");
});
await check("browserFetch: a host outside the allowlist is refused by name", async () => {
  const r = await browserFetch("https://off-list.example/page", { allowlist: ["example.com"] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /host not in this run's allowlist: off-list\.example/);
  assert.match(r.reason, /allowed: example\.com/);
});
await check("browserFetch: not a URL is refused as such", async () => {
  const r = await browserFetch("not a url at all", { allowlist: ["example.com"] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^not a URL: /);
});
await check("scrapeUrl: an empty allowlist scrapes nothing, before any leg runs", async () => {
  const r = await scrapeUrl("https://example.com/page", { allowlist: [] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "this run granted net-fetch with no domain allowlist, so nothing is fetchable — pass --allow-domain");
});
await check("scrapeUrl: a host outside the allowlist is refused by name", async () => {
  const r = await scrapeUrl("https://off-list.example/page", { allowlist: ["example.com"] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /host not in this run's allowlist: off-list\.example/);
});

// ── the scrape router: which leg answers, and what that is called ────────────

await check("scrapeUrl: total failure returns the last refusal — the plain leg's", async () => {
  // A closed port fails on every leg whatever moli does, so the refusal that
  // comes back must be the floor leg's — proof the router walked the ladder.
  const port = await closedPort();
  const r = await scrapeUrl(`http://127.0.0.1:${port}/gone`, { allowlist: ["127.0.0.1"], timeoutMs: 4000 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^fetch failed: /);
});

if (moliPresent) {
  await check("browserFetch: a rendered dump comes back capped and labeled", async () => {
    const server = await serveHtml(LOCAL_PAGE);
    try {
      const url = `http://127.0.0.1:${server.address().port}/`;
      const r = await browserFetch(url, { allowlist: ["127.0.0.1"] });
      assert.equal(r.ok, true, `refused: ${r.reason}`);
      assert.equal(r.url, url);
      assert.ok(r.bytes > 0);
      assert.equal(r.truncated, false);
      assert.match(r.content, new RegExp(MARKER));
    } finally {
      server.close();
    }
  });
  await check("scrapeUrl: a live page routes to moli first, via names it", async () => {
    const server = await serveHtml(LOCAL_PAGE);
    try {
      const r = await scrapeUrl(`http://127.0.0.1:${server.address().port}/`, { allowlist: ["127.0.0.1"] });
      assert.equal(r.ok, true, `refused: ${r.reason}`);
      assert.equal(r.via, "moli");
      assert.match(r.content, new RegExp(MARKER));
    } finally {
      server.close();
    }
  });
} else {
  console.log("browser checks skipped (moli not installed)");
  await check("browserFetch: without moli the refusal is the install sentence", async () => {
    const r = await browserFetch("https://example.com/page", { allowlist: ["example.com"] });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "browser not installed — the browser grant needs moli on PATH (see docs)");
  });
  await check("scrapeUrl: without moli the plain fetch catches the page", async () => {
    // The moli-present machine proves leg one wins; this one proves the
    // floor leg still serves the page a moli-less machine asked for.
    const server = await serveHtml(LOCAL_PAGE);
    try {
      const r = await scrapeUrl(`http://127.0.0.1:${server.address().port}/`, { allowlist: ["127.0.0.1"] });
      assert.equal(r.ok, true, `refused: ${r.reason}`);
      assert.equal(r.via, "fetch");
      assert.equal(r.status, 200);
      assert.match(r.content, new RegExp(MARKER));
    } finally {
      server.close();
    }
  });
  await check("browserSession: without moli the refusal names the binary", async () => {
    const r = await browserSession();
    assert.equal(r.ok, false);
    assert.equal(r.reason, "the browser session needs moli on PATH");
  });
}

// ── searchWeb duckduckgo: the keyless leg, against a stubbed fetch ───────────

await check("searchWeb duckduckgo: rows parsed from the html page, no key spent", async () => {
  // The key rides along to prove the pinned keyless backend never reaches for
  // it — one call total, and it is the html endpoint.
  const { out, calls } = await withFetch(
    () => stubResponse({ text: DDG_PAGE }),
    () => searchWeb("probe query", { backend: "duckduckgo", envMap: KEY_ENV, timeoutMs: 2000 })
  );
  assert.equal(calls.length, 1, "the pinned keyless backend must not fall back");
  assert.ok(isDdg(calls[0].url), `first call should be DDG, was ${calls[0].url}`);
  assert.equal(calls[0].url, `https://html.duckduckgo.com/html/?q=${encodeURIComponent("probe query")}`);
  assert.equal(calls[0].init.headers["user-agent"], "agnostic-router-kit/plane-search");
  assert.equal(out.ok, true, `refused: ${out.reason}`);
  assert.equal(out.creditsUsed, 0, "a keyless search spends nothing");
  assert.deepEqual(out.results, DDG_EXPECTED);
});
await check("searchWeb auto: prefers duckduckgo and leaves firecrawl unspent", async () => {
  const { out, calls } = await withFetch(
    () => stubResponse({ text: DDG_PAGE }),
    () => searchWeb("probe query", { envMap: KEY_ENV, timeoutMs: 2000 })
  );
  assert.equal(calls.length, 1);
  assert.ok(isDdg(calls[0].url));
  assert.equal(out.ok, true);
  assert.equal(out.results.length, 2);
  assert.equal(out.creditsUsed, 0);
});
await check("searchWeb auto: an empty DDG page falls back to firecrawl when the key resolves", async () => {
  const { out, calls } = await withFetch(
    (i, url) => (isDdg(url) ? stubResponse({ text: "<html><body>no results here</body></html>" }) : stubResponse({ text: FIRECRAWL_SEARCH })),
    () => searchWeb("probe query", { envMap: KEY_ENV, timeoutMs: 2000 })
  );
  assert.equal(calls.length, 2, "the fallback is one more call, not a replacement");
  assert.ok(isDdg(calls[0].url));
  assert.ok(isFirecrawl(calls[1].url));
  assert.equal(calls[1].init.method, "POST");
  assert.equal(JSON.parse(calls[1].init.body).query, "probe query");
  assert.equal(out.ok, true, `refused: ${out.reason}`);
  assert.deepEqual(out.results, [
    { url: "https://one.example/", title: "One", description: "first hit" },
    { url: "https://two.example/", title: "Two", description: "second hit", content: "## two\ncontent" },
  ]);
  assert.equal(out.creditsUsed, 7);
});
await check("searchWeb auto: a failed DDG falls back to firecrawl when the key resolves", async () => {
  const { out, calls } = await withFetch(
    (i, url) => (isDdg(url) ? stubResponse({ status: 503, text: " overloaded " }) : stubResponse({ text: FIRECRAWL_SEARCH })),
    () => searchWeb("probe query", { envMap: KEY_ENV, timeoutMs: 2000 })
  );
  assert.equal(calls.length, 2);
  assert.ok(isFirecrawl(calls[1].url));
  assert.equal(out.ok, true, `refused: ${out.reason}`);
  assert.equal(out.results.length, 2);
});
await check("searchWeb auto: a failed DDG without a key returns the DDG refusal", async () => {
  const { out, calls } = await withFetch(
    () => stubResponse({ status: 503, text: " overloaded " }),
    () => searchWeb("probe query", { envMap: {}, timeoutMs: 2000 })
  );
  assert.equal(calls.length, 1, "no key, no fallback call");
  assert.equal(out.ok, false);
  assert.match(out.reason, /HTTP 503/);
});
await check("searchWeb: a scrape ask is firecrawl-only whatever backend is pinned", async () => {
  const { out, calls } = await withFetch(
    () => stubResponse({ text: FIRECRAWL_SEARCH }),
    () => searchWeb("probe query", { backend: "duckduckgo", scrape: "markdown", envMap: KEY_ENV, timeoutMs: 2000 })
  );
  assert.equal(calls.length, 1, "a DDG search cannot scrape — the ask goes straight to firecrawl");
  assert.ok(isFirecrawl(calls[0].url));
  assert.deepEqual(JSON.parse(calls[0].init.body).scrapeOptions, { formats: [{ type: "markdown" }] });
  assert.equal(out.ok, true, `refused: ${out.reason}`);
  assert.equal(out.results[1].content.length, "## two\ncontent".length);
});
await check("searchWeb firecrawl: the explicit pin still works, row shape unchanged", async () => {
  const { out, calls } = await withFetch(
    () => stubResponse({ text: FIRECRAWL_SEARCH }),
    () => searchWeb("probe query", { backend: "firecrawl", envMap: KEY_ENV, timeoutMs: 2000 })
  );
  assert.equal(calls.length, 1);
  assert.ok(isFirecrawl(calls[0].url));
  assert.equal(out.ok, true);
  assert.deepEqual(
    out.results.map((r) => ({ url: r.url, title: r.title, description: r.description })),
    [
      { url: "https://one.example/", title: "One", description: "first hit" },
      { url: "https://two.example/", title: "Two", description: "second hit" },
    ]
  );
  assert.equal(out.results[0].content, undefined, "no markdown upstream, no content key — the shape callers depend on");
});
await check("searchWeb firecrawl: a missing key is a refusal naming the variable", async () => {
  const r = await searchWeb("probe query", { backend: "firecrawl", envMap: {} });
  assert.equal(r.ok, false);
  assert.equal(
    r.reason,
    "no FIRECRAWL_API_KEY in this run's environment — set it with `kit env set FIRECRAWL_API_KEY=…` (or the spawner's own env file)"
  );
});
await check("searchWeb: an unknown backend is refused, naming what ships", async () => {
  const r = await searchWeb("probe query", { backend: "gopher" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unknown search backend: gopher (shipped: auto, duckduckgo, firecrawl)");
});
await check("searchWeb: an empty query is still not a search", async () => {
  const r = await searchWeb("   ");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "a search with no query is not a search");
});

// ── the session tier: lifecycle, not automation ──────────────────────────────

if (moliPresent) {
  await check("browserSession: serve answers health, close stops the child", async () => {
    const s = await browserSession();
    assert.equal(s.ok, true, `refused: ${s.reason}`);
    assert.ok(Number.isInteger(s.port) && s.port > 0, `port should be a real one, got ${s.port}`);
    try {
      const health = await fetch(`http://127.0.0.1:${s.port}/json/version`, { signal: AbortSignal.timeout(2000) });
      assert.ok(health.ok, "the health endpoint should answer once the session is handed back");
    } finally {
      s.close();
    }
    assert.ok(await portGoesQuiet(s.port), "after close() the served port should stop answering — the child is dead");
  });
}

// ── the tally ────────────────────────────────────────────────────────────────

if (failures.length) {
  console.log(`  failed: ${failures.join(" | ")}`);
}
console.log(`unit-services-browser: ${pass} cases pass, ${failures.length} fail${moliPresent ? "" : " (moli-gated checks skipped)"}`);
process.exitCode = failures.length ? 1 : 0;
