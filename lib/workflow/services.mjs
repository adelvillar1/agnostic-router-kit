/**
 * The harness services a real runtime gives its agents, as pure capped
 * primitives. Each one is exactly as capable as its grant allows and no more:
 * an install restores a lockfile, a fetch obeys a domain allowlist, a dev server
 * dies at its lifetime, a format hook runs one configured script.
 *
 * These hold no journaling and no grant decisions — that lives in tools.mjs,
 * which is the one place that already owns both. Splitting them this way keeps
 * the caps testable without a run directory.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

/** A response body larger than this is truncated, never trusted. */
export const FETCH_BODY_CAP = 1024 * 1024;
/** Wall-clock cap on a single fetch. */
export const FETCH_TIMEOUT_MS = 20000;
/** A dev server's default lifetime; it dies even if the run forgets it. */
export const DEV_SERVER_LIFETIME_MS = 5 * 60 * 1000;
/**
 * A background command's default lifetime, and the ceiling for any process the
 * run starts. It sits above run_command's five-minute kill on purpose: a
 * ten-minute test suite is exactly the case a synchronous tool round cannot
 * serve, and that suite is not a dev server, so it does not share the server's
 * tighter default.
 */
export const COMMAND_LIFETIME_MS = 15 * 60 * 1000;
/** Output retained per background process, per stream. */
export const PROCESS_OUTPUT_CAP = 512 * 1024;
/** How long to wait for a started process to signal readiness before giving it back anyway. */
export const READY_WAIT_MS = 15000;
/** Poll interval while waiting for readiness. */
const READY_POLL_MS = 100;

const LOCKFILES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"];

/** The workspace's lockfile, if it has one — the thing `ci` is allowed to install from. */
export function findLockfile(workspace) {
  for (const name of LOCKFILES) {
    if (fs.existsSync(path.join(workspace, name))) return name;
  }
  return null;
}

/**
 * What a dependency-changing call is asking for: restoring what the manifest
 * already declares, or adding something the manifest does not.
 *
 * `ci` restores — the lockfile is the authority. `install`/`i`/`add` with no
 * package argument also restores. Naming a package adds a dependency, which is
 * a human decision, so it is refused here before any registry is contacted.
 */
export function installPolicy(command, args = [], workspace) {
  const subject = String(args[0] ?? "");
  if (subject === "ci") {
    const lock = findLockfile(workspace);
    return lock
      ? { kind: "restore", lockfile: lock }
      : {
          kind: "refuse",
          reason: `${command} ci has no lockfile to install from — committing a lockfile is what makes an in-run install reproducible`,
        };
  }
  const packages = args.slice(1).filter((a) => a && !String(a).startsWith("-"));
  if (packages.length) {
    return {
      kind: "refuse",
      reason: `${command} ${[subject, ...packages].join(" ")} adds a dependency — the manifest is a human decision, not an agent's (this run did not fetch it)`,
    };
  }
  if (!fs.existsSync(path.join(workspace, "package.json"))) {
    return { kind: "refuse", reason: `${command} ${subject} has no package.json to restore` };
  }
  return { kind: "restore", lockfile: null };
}

/**
 * Bounded net-fetch. The grant is the caller's; the allowlist and the caps are
 * the plane's, and an empty allowlist fetches nothing rather than everything.
 * Reports where the response actually landed, so a redirect somewhere else is
 * visible instead of silently honored.
 */
export async function fetchUrl(url, { allowlist = [], maxBytes = FETCH_BODY_CAP, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return { ok: false, reason: `not a URL: ${url}` };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: `unsupported scheme: ${parsed.protocol}` };
  }
  if (!allowlist.length) {
    return {
      ok: false,
      reason: "this run granted net-fetch with no domain allowlist, so nothing is fetchable — pass --allow-domain",
    };
  }
  const host = parsed.hostname.toLowerCase();
  const allowed = allowlist.some((d) => {
    const want = d.toLowerCase().replace(/^\*?\./, "");
    return host === want || host.endsWith(`.${want}`);
  });
  if (!allowed) {
    return { ok: false, reason: `host not in this run's allowlist: ${host} (allowed: ${allowlist.join(", ")})` };
  }
  try {
    const res = await fetch(parsed.toString(), {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "agnostic-router-kit/plane-fetch" },
      redirect: "follow",
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      ok: true,
      status: res.status,
      url: String(res.url || parsed.toString()),
      bytes: buf.byteLength,
      truncated: buf.byteLength > maxBytes,
      contentType: res.headers.get("content-type") ?? null,
      body: buf.subarray(0, maxBytes).toString("utf8"),
    };
  } catch (e) {
    return { ok: false, reason: `fetch failed: ${String(e?.message ?? e).slice(0, 120)}` };
  }
}

/** Per-result content cap when a scrape format is requested. A full markdown
 * page is bounded here; a summary is bounded far tighter — search results feed
 * an agent's history, and every round resends it, so generous snippets are how
 * a loop-shaped ask trips its token line. */
export const SEARCH_CONTENT_CAP = 20_000;
export const SEARCH_SUMMARY_CAP = 4_000;
/** Wall-clock cap on a single search. */
export const SEARCH_TIMEOUT_MS = 30_000;
/** Ceiling on rows per search, whatever the caller asked for. */
export const SEARCH_RESULT_CAP = 10;

/**
 * Bounded web search. One backend ships (Firecrawl v2); the `backend` param is
 * the seam for the next one, not a promise. The grant is the caller's; the caps
 * and the key discipline are the plane's: the key arrives through `envMap`
 * under its declared env-var name and never appears in a result, a journal
 * line, or an error. A missing key is a configured absence — a refusal naming
 * the variable, not a crash.
 */
export async function searchWeb(query, { backend = "firecrawl", apiKeyEnv = "FIRECRAWL_API_KEY", envMap = {}, limit = 5, scrape = null, timeoutMs = SEARCH_TIMEOUT_MS } = {}) {
  const q = String(query ?? "").trim();
  if (!q) return { ok: false, reason: "a search with no query is not a search" };
  if (backend !== "firecrawl") {
    return { ok: false, reason: `unknown search backend: ${backend} (shipped: firecrawl)` };
  }
  const key = envMap[apiKeyEnv];
  if (!key) {
    return {
      ok: false,
      reason: `no ${apiKeyEnv} in this run's environment — set it with \`kit env set ${apiKeyEnv}=…\` (or the spawner's own env file)`,
    };
  }
  const rows = Math.max(1, Math.min(Number(limit) || 5, SEARCH_RESULT_CAP));
  const body = { query: q.slice(0, 500), limit: rows, sources: ["web"] };
  if (scrape) {
    const format = String(scrape) === "markdown" ? "markdown" : "summary";
    body.scrapeOptions = { formats: [{ type: format }] };
  }
  try {
    const res = await fetch("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    if (!res.ok) {
      return { ok: false, reason: `search failed: HTTP ${res.status} — ${raw.slice(0, 160)}` };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: `search returned non-JSON (HTTP ${res.status})` };
    }
    if (!parsed?.success) {
      return { ok: false, reason: `search refused: ${String(parsed?.error ?? "unknown").slice(0, 160)}` };
    }
    const web = parsed?.data?.web ?? [];
    const contentCap = String(scrape) === "markdown" ? SEARCH_CONTENT_CAP : SEARCH_SUMMARY_CAP;
    const results = web
      .slice(0, rows)
      .map((r) => {
        const row = {
          url: String(r?.url ?? ""),
          title: String(r?.title ?? "").slice(0, 300),
          description: String(r?.description ?? "").slice(0, 1000),
        };
        if (r?.markdown) row.content = String(r.markdown).slice(0, contentCap);
        return row;
      })
      .filter((r) => r.url);
    return { ok: true, query: q, results, creditsUsed: Number(parsed.creditsUsed ?? 0) };
  } catch (e) {
    return { ok: false, reason: `search failed: ${String(e?.message ?? e).slice(0, 120)}` };
  }
}

/**
 * Bounded page scrape through a Firecrawl-compatible endpoint. This is the
 * enrichment half of search: the cloud /search bills per scraped result, so
 * selective scrapes point at a self-hosted instance (FIRECRAWL_SCRAPE_URL) —
 * same API surface, no cloud credits. No baseUrl configured is a configured
 * absence: the caller skips enrichment rather than spending cloud credits.
 */
export const SCRAPE_CONTENT_CAP = 20_000;
export async function scrapeUrl(url, { baseUrl, apiVersion = "v2", apiKeyEnv = "FIRECRAWL_SCRAPE_KEY", envMap = {}, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const parsed = String(url ?? "").trim();
  if (!parsed) return { ok: false, reason: "scrape with no URL" };
  if (!baseUrl) {
    return { ok: false, reason: "no scrape endpoint configured — set FIRECRAWL_SCRAPE_URL (a self-hosted Firecrawl) to enable enrichment" };
  }
  const key = envMap[apiKeyEnv];
  const headers = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  try {
    // v2 (cloud) takes object formats and bills per scrape; self-hosted v1
    // takes plain strings and the summary format needs an LLM backend most
    // self-hosted deploys do not carry — markdown is the self-hosted format.
    const formats = apiVersion === "v2" ? [{ type: "summary" }] : ["markdown"];
    const res = await fetch(`${String(baseUrl).replace(/\/+$/, "")}/${apiVersion}/scrape`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers,
      body: JSON.stringify({ url: parsed, formats }),
    });
    const raw = await res.text();
    if (!res.ok) return { ok: false, reason: `scrape failed: HTTP ${res.status} — ${raw.slice(0, 160)}` };
    let parsedBody;
    try {
      parsedBody = JSON.parse(raw);
    } catch {
      return { ok: false, reason: `scrape returned non-JSON (HTTP ${res.status})` };
    }
    if (!parsedBody?.success) return { ok: false, reason: `scrape refused: ${String(parsedBody?.error ?? "unknown").slice(0, 160)}` };
    const data = parsedBody?.data ?? {};
    const content = String(data.markdown ?? data.summary ?? data.description ?? "").slice(0, SCRAPE_CONTENT_CAP);
    return { ok: true, url: parsed, title: String(data.metadata?.title ?? "").slice(0, 300), content, creditsUsed: Number(parsedBody.creditsUsed ?? 0) };
  } catch (e) {
    return { ok: false, reason: `scrape failed: ${String(e?.message ?? e).slice(0, 120)}` };
  }
}

/**
 * The workspace's own format/lint scripts, in a canonical order. None of these
 * is capability growth: they are the workspace's declared tools, and the 'test
 * runner' grant already covers running them.
 */
export const FORMAT_SCRIPTS = ["format", "lint", "fmt", "format:check"];

/** Which of the workspace's package.json scripts are format/lint hooks. */
export function formatScripts(workspace) {
  const pkg = path.join(workspace, "package.json");
  if (!fs.existsSync(pkg)) return [];
  try {
    const { scripts = {} } = JSON.parse(fs.readFileSync(pkg, "utf8"));
    return FORMAT_SCRIPTS.filter((name) => typeof scripts[name] === "string");
  } catch {
    return [];
  }
}

/**
 * Run the workspace's format hooks in the canonical order. Each is a fixed-argv
 * npm invocation under the run's own command contract, so the run's command
 * timeout is the cap and there is no second, weaker one to bypass. A hook that
 * fails is reported, not thrown — a failing lint is a finding the part needs, not
 * a reason to abandon the run.
 */
export async function runFormatHooks(workspace, { run, scripts = formatScripts(workspace) } = {}) {
  const out = [];
  for (const name of scripts) {
    try {
      const r = await run("npm", ["run", name]);
      out.push({ script: name, exitCode: r.exitCode ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" });
    } catch (e) {
      out.push({ script: name, exitCode: 1, stdout: "", stderr: String(e?.message ?? e).slice(0, 200) });
    }
  }
  return { ok: out.every((r) => r.exitCode === 0), hooks: out };
}

/**
 * The background-process registry, per run. Dev servers (item 7) and background
 * commands (item 11) both live here: a handle, an offset-readable output ring, a
 * lifetime cap, and an idempotent stop — stopping a process that a lifetime cap
 * already killed is the outcome we wanted, not an error.
 */
export class ProcessRegistry {
  constructor(journal, { lifetimeCapMs = DEV_SERVER_LIFETIME_MS } = {}) {
    this.journal = journal;
    this.lifetimeCapMs = lifetimeCapMs;
    this.procs = new Map();
  }

  /**
   * Start one. `label` names the effect in the journal; `waitFor` is a readiness
   * marker read from the child's output — a dev server that isn't listening yet
   * is not usable, and handing back a URL that fails makes the caller guess.
   * `cap` is the capability the caller was granted under; it rides along so a
   * later poll or stop of this handle is judged on the same subject it was
   * started on rather than on a capability chosen by whoever looks next.
   */
  async start({ label, command, args = [], cwd, waitFor = null, lifetimeMs = DEV_SERVER_LIFETIME_MS, env = {}, cap = null }) {
    const id = `${label}-${Math.random().toString(36).slice(2, 8)}`;
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const rec = {
      id,
      label,
      command,
      args,
      child,
      cap,
      startedAt: Date.now(),
      lifetimeMs: Math.min(lifetimeMs, this.lifetimeCapMs),
      stdout: "",
      stderr: "",
      // A process killed by a signal has exitCode null — exactly what a still-
      // running one has — so "exited" must be recorded independently, or a
      // lifetime-killed server polls as running forever.
      exitCode: null,
      signal: null,
      doneAt: null,
      // `ready` means the readiness marker was seen. Without a marker nothing has
      // checked the server, so it reads false rather than true — a start that
      // verified nothing must not claim it did.
      ready: false,
      checked: waitFor !== null,
      waitFor,
    };
    child.stdout.on("data", (d) => {
      rec.stdout += d.toString();
      if (rec.stdout.length > PROCESS_OUTPUT_CAP) rec.stdout = rec.stdout.slice(-PROCESS_OUTPUT_CAP);
      if (rec.waitFor && rec.stdout.includes(rec.waitFor)) rec.ready = true;
    });
    child.stderr.on("data", (d) => {
      rec.stderr += d.toString();
      if (rec.stderr.length > PROCESS_OUTPUT_CAP) rec.stderr = rec.stderr.slice(-PROCESS_OUTPUT_CAP);
    });
    child.on("error", (e) => {
      rec.spawnError = String(e?.message ?? e);
    });
    child.on("exit", (code, signal) => {
      rec.exitCode = code ?? null;
      rec.signal = signal ?? null;
      rec.doneAt = Date.now();
      this.journal?.({
        kind: "service",
        service: label,
        handle: id,
        event: "exit",
        exitCode: rec.exitCode,
        signal: rec.signal,
      });
    });
    const timer = setTimeout(() => {
      this.journal?.({ kind: "service", service: label, handle: id, event: "lifetime-expired" });
      this.stop(id);
    }, rec.lifetimeMs);
    child.on("exit", () => clearTimeout(timer));
    this.procs.set(id, rec);
    this.journal?.({
      kind: "service",
      service: label,
      handle: id,
      event: "start",
      command,
      args,
      lifetimeMs: rec.lifetimeMs,
      pid: child.pid ?? null,
    });
    if (rec.waitFor && !rec.ready) await this.#awaitReady(id);
    return {
      handle: id,
      label,
      pid: child.pid ?? null,
      running: rec.doneAt === null,
      ready: rec.ready,
      checked: rec.checked,
      spawnError: rec.spawnError ?? null,
      startedAt: rec.startedAt,
      stdout: rec.stdout,
      stderr: rec.stderr,
    };
  }

  /** Poll one process's output from an offset, so a reader can stream it. */
  poll(handle, offset = 0) {
    const rec = this.procs.get(handle);
    if (!rec) return { ok: false, reason: `no such handle: ${handle}` };
    const stdout = rec.stdout.slice(offset);
    return {
      ok: true,
      handle,
      running: rec.doneAt === null,
      exitCode: rec.exitCode,
      signal: rec.signal,
      stdout,
      stderr: rec.stderr,
      offset: offset + stdout.length,
    };
  }

  /** The capability this handle was started under, so its poll and stop match. */
  capFor(handle) {
    const rec = this.procs.get(handle);
    return rec?.cap ?? null;
  }

  /** Idempotent: a stop after a lifetime kill or an early exit is a recorded no-op. */
  stop(handle) {
    const rec = this.procs.get(handle);
    if (!rec) return { ok: false, reason: `no such handle: ${handle}` };
    if (rec.doneAt !== null) {
      this.journal?.({ kind: "service", service: rec.label, handle, event: "stop", alreadyStopped: true });
      return { ok: true, handle, alreadyStopped: true, exitCode: rec.exitCode, signal: rec.signal };
    }
    try {
      rec.child.kill("SIGTERM");
    } catch {
      /* already gone — which is the outcome we wanted */
    }
    this.journal?.({ kind: "service", service: rec.label, handle, event: "stop", alreadyStopped: false });    setTimeout(() => {
      if (rec.doneAt === null) {
        try {
          rec.child.kill("SIGKILL");
        } catch {
          /* ditto */
        }
      }
    }, 1500).unref?.();
    return { ok: true, handle, alreadyStopped: false };
  }

  /** Stop everything this run started — the engine calls it on run-done. */
  stopAll() {
    const ids = [...this.procs.keys()];
    for (const id of ids) this.stop(id);
    return ids.length;
  }

  async #awaitReady(id) {
    const rec = this.procs.get(id);
    const deadline = Date.now() + READY_WAIT_MS;
    while (!rec.ready && rec.doneAt === null && !rec.spawnError && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
    if (!rec.ready) {
      this.journal?.({ kind: "service", service: rec.label, handle: id, event: "ready-timeout" });
    }
    return rec.ready;
  }
}
