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
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";

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
 * The net discipline's front gate: parse the URL, refuse non-http(s)
 * schemes, enforce the allowlist — an empty allowlist fetches nothing rather
 * than everything. Every net leg (plain fetch, browser, scrape router) walks
 * this same gate, so a refusal reads the same wherever it fires and a leg
 * cannot be looser than the discipline it sits behind.
 */
function gateUrl(url, allowlist) {
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
  return { ok: true, parsed };
}

/**
 * Bounded net-fetch. The grant is the caller's; the allowlist and the caps are
 * the plane's, and an empty allowlist fetches nothing rather than everything.
 * Reports where the response actually landed, so a redirect somewhere else is
 * visible instead of silently honored.
 */
export async function fetchUrl(url, { allowlist = [], maxBytes = FETCH_BODY_CAP, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const gate = gateUrl(url, allowlist);
  if (!gate.ok) return gate;
  try {
    const res = await fetch(gate.parsed.toString(), {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "agnostic-router-kit/plane-fetch" },
      redirect: "follow",
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      ok: true,
      status: res.status,
      url: String(res.url || gate.parsed.toString()),
      bytes: buf.byteLength,
      truncated: buf.byteLength > maxBytes,
      contentType: res.headers.get("content-type") ?? null,
      body: buf.subarray(0, maxBytes).toString("utf8"),
    };
  } catch (e) {
    return { ok: false, reason: `fetch failed: ${String(e?.message ?? e).slice(0, 120)}` };
  }
}

/** The refusal when the browser binary is simply not there. A machine without
 * moli is a configured absence, not a crash — the same law as a missing key. */
const MOLI_ABSENT = "browser not installed — the browser grant needs moli on PATH (see docs)";

/**
 * Bounded rendered fetch through the moli CLI. The gate, the byte cap, and the
 * wall clock are fetchUrl's — only the fetcher differs: a real browser renders
 * the page (JS-true, local, private) and dumps it as `format`. A page plain
 * fetch reads as an empty shell is exactly the case this exists for, so the
 * caps cannot be looser than the plain fetch's: a rendered page is still
 * untrusted input, and its bytes still ride an agent's history. Past the byte
 * cap the dump stops being drained — the child blocks on its full pipe and is
 * killed — and the truncation is reported, never hidden.
 */
export async function browserFetch(url, { format = "markdown", waitSelector = null, timeoutMs = FETCH_TIMEOUT_MS, maxBytes = FETCH_BODY_CAP, allowlist = [] } = {}) {
  const gate = gateUrl(url, allowlist);
  if (!gate.ok) return gate;
  const args = ["fetch", "--dump", String(format)];
  if (waitSelector) args.push("--wait-selector", String(waitSelector));
  args.push(gate.parsed.toString());
  return await new Promise((resolve) => {
    let settled = false;
    let total = 0;
    let out = Buffer.alloc(0);
    let err = "";
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn("moli", args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone — which is the outcome we wanted */
      }
      finish({ ok: false, reason: `browser fetch exceeded ${timeoutMs}ms wall clock — child killed` });
    }, timeoutMs);
    child.on("error", (e) => {
      if (e?.code === "ENOENT") finish({ ok: false, reason: MOLI_ABSENT });
      else finish({ ok: false, reason: `browser fetch failed: ${String(e?.message ?? e).slice(0, 120)}` });
    });
    child.stdout.on("data", (d) => {
      if (settled) return;
      total += d.length;
      if (out.length < maxBytes) out = Buffer.concat([out, d.subarray(0, maxBytes - out.length)]);
      if (total > maxBytes) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        finish({ ok: true, url: gate.parsed.toString(), bytes: total, truncated: true, content: out.toString("utf8") });
      }
    });
    child.stderr.on("data", (d) => {
      err = `${err}${d}`.slice(-8192);
    });
    child.on("close", (code) => {
      finish(
        code === 0
          ? { ok: true, url: gate.parsed.toString(), bytes: total, truncated: total > maxBytes, content: out.toString("utf8") }
          : { ok: false, reason: `moli fetch failed (exit ${code ?? "killed"}): ${err.slice(0, 160)}` }
      );
    });
  });
}

/** The refusal when the dev-decisions CLI is simply not there. A machine
 * without it is a configured absence, not a crash — the tabular loops report
 * the absence and the kit proceeds exactly as today, the same law as moli. */
const DEV_DECISIONS_ABSENT =
  "dev-decisions not installed — the tabular grant needs the dev-decisions CLI (see docs)";

/** The batch verbs dev-decisions' tabular lane ships. argv goes to a real CLI,
 * so the surface only speaks the commands that exist — anything else is
 * refused by name before a process is spawned. */
const TABULAR_COMMANDS = [
  "override-prior",
  "record-runs",
  "history-gate",
  "record-bench",
  "budget-gate",
  "risk-prior",
  "fleet-anomaly",
  "triage-issues",
];

/** Wall-clock cap on one tabular batch call. Batch-only — this never runs in a
 * synchronous path (the judge's 4s budget and the ask loop both forbid it), so
 * the cap is a batch budget, not a round-trip budget. */
export const TABULAR_TIMEOUT_MS = 120_000;

/**
 * Bounded batch verdicts through the dev-decisions CLI's tabular lane —
 * forecast bands, flake scores, priors — the same external-binary posture the
 * swarm's evidence gate already holds (GATE_BIN, DEV_DECISIONS_BIN override,
 * absence is a refusal not a throw). `args` is a plain object of CLI flags
 * flattened to argv: a plain key becomes `--key value`, a `--flag` key with
 * `true` becomes the bare flag, `false`/null drops it, and an array value
 * repeats the flag once per item — `{ table: "x.csv", "--json": true }` →
 * `--table x.csv --json`. The contract on stdout is JSON lines: one JSON
 * object per non-empty line, non-JSON lines skipped (a CLI may chatter on
 * stdout), parsed rows returned whole.
 */
export async function tabular(command, args = {}, { timeoutMs = TABULAR_TIMEOUT_MS } = {}) {
  if (!TABULAR_COMMANDS.includes(String(command))) {
    return { ok: false, reason: `unknown tabular command: ${command} (shipped: ${TABULAR_COMMANDS.join(", ")})` };
  }
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, reason: "tabular args must be an object of CLI flags" };
  }
  const argv = [];
  for (const [name, value] of Object.entries(args)) {
    const flag = name.startsWith("--") ? name : `--${name}`;
    if (value === true) argv.push(flag);
    else if (value === false || value == null) continue;
    else if (Array.isArray(value)) for (const item of value) argv.push(flag, String(item));
    else argv.push(flag, String(value));
  }
  const bin = process.env.DEV_DECISIONS_BIN ?? "dev-decisions";
  return await new Promise((resolve) => {
    execFile(bin, [String(command), ...argv], { timeout: timeoutMs, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === "ENOENT") return resolve({ ok: false, reason: DEV_DECISIONS_ABSENT });
        if (err.killed) return resolve({ ok: false, reason: `tabular ${command} exceeded ${timeoutMs}ms wall clock — child killed` });
        return resolve({ ok: false, reason: `tabular ${command} failed (exit ${err.code ?? "killed"}): ${String(stderr ?? "").trim().slice(0, 160)}` });
      }
      const rows = String(stdout)
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter((r) => r !== null);
      resolve({ ok: true, command: String(command), rows });
    });
  });
}

/** The refusal when the dev-decisions CLI is simply not there — or predates
 * the semantic lane. Same configured-absence law as the tabular grant: the
 * semantic loops report the absence by name and the kit proceeds as today. */
const SEMANTIC_ABSENT =
  "dev-decisions not installed — the semantic grant needs the dev-decisions CLI with sem1";

/** The batch verbs dev-decisions' semantic lane ships. Same posture as the
 * tabular allowlist: argv goes to a real CLI, so the surface only speaks the
 * commands that exist — anything else is refused by name before a spawn. */
const SEMANTIC_COMMANDS = ["semantic-index", "semantic-dedup", "semantic-nn"];

/** Wall-clock cap on one semantic batch call. Batch-only, like the tabular
 * lane — this never runs in a synchronous path, so the cap is a batch budget,
 * not a round-trip budget. */
export const SEMANTIC_TIMEOUT_MS = 120_000;

/**
 * Bounded batch geometry through the dev-decisions CLI's semantic lane —
 * vector indexes, near-dupe pairs, nearest graded neighbors — the machine
 * contract for the semantic loops. `--json` is injected on every call (the
 * lane's machine output: one JSON object per line; the human default is never
 * parsed here), and everything else about the posture is the tabular surface
 * cloned: external binary via DEV_DECISIONS_BIN, flag flattener, absence is a
 * refusal not a throw, tolerant JSON-lines parsing. Embeddings propose,
 * sys1/sdm1 dispose — this surface returns rows for a workflow to render; it
 * never returns a verdict.
 */
export async function semantic(command, args = {}, { timeoutMs = SEMANTIC_TIMEOUT_MS } = {}) {
  if (!SEMANTIC_COMMANDS.includes(String(command))) {
    return { ok: false, reason: `unknown semantic command: ${command} (shipped: ${SEMANTIC_COMMANDS.join(", ")})` };
  }
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, reason: "semantic args must be an object of CLI flags" };
  }
  const argv = ["--json"];
  for (const [name, value] of Object.entries(args)) {
    const flag = name.startsWith("--") ? name : `--${name}`;
    if (value === true) argv.push(flag);
    else if (value === false || value == null) continue;
    else if (Array.isArray(value)) for (const item of value) argv.push(flag, String(item));
    else argv.push(flag, String(value));
  }
  const bin = process.env.DEV_DECISIONS_BIN ?? "dev-decisions";
  return await new Promise((resolve) => {
    execFile(bin, [String(command), ...argv], { timeout: timeoutMs, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === "ENOENT") return resolve({ ok: false, reason: SEMANTIC_ABSENT });
        if (err.killed) return resolve({ ok: false, reason: `semantic ${command} exceeded ${timeoutMs}ms wall clock — child killed` });
        return resolve({ ok: false, reason: `semantic ${command} failed (exit ${err.code ?? "killed"}): ${String(stderr ?? "").trim().slice(0, 160)}` });
      }
      const rows = String(stdout)
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter((r) => r !== null);
      resolve({ ok: true, command: String(command), rows });
    });
  });
}

/**
 * The review-sweep dedup rule, pure and exported so a probe can execute it:
 * given the `semantic-nn` rows for one finding (summary row + hit rows), is
 * there a near-dupe of an already-dispositioned finding above the EVAL-ONLY
 * threshold? A hit row needs a score, a path (the exporter's per-finding text
 * file), and content sha — anything less is not a repeat. Returns
 * { key, score, path } or null. The threshold is advisory by the lane's law:
 * the caller annotates and shows, it never silently drops.
 */
export function repeatFromRows(rows, { threshold = 0.9 } = {}) {
  const hits = (Array.isArray(rows) ? rows : []).filter(
    (r) => r && r.key && r.path && r.score !== undefined && Number.isFinite(Number(r.score)),
  );
  const best = hits.map((r) => ({ key: String(r.key), score: Number(r.score), path: String(r.path) }))
    .sort((a, b) => b.score - a.score)[0];
  return best && best.score >= threshold ? best : null;
}

/**
 * The diagram lane's one verb. The archify CLI is a real external program like
 * dev-decisions and moli, so the surface only speaks the command that exists —
 * anything else is refused by name before a process is spawned, the same
 * allowlist law the tabular and semantic lanes hold.
 */
export const DIAGRAM_COMMANDS = ["finalize"];

/**
 * Wall-clock cap on one finalize. The run includes a real browser-check — a
 * headless Chrome load of the emitted HTML — so this is a batch budget, not a
 * round-trip one, and it never sits inside an agent turn.
 */
export const DIAGRAM_TIMEOUT_MS = 300_000;

/**
 * The refusal when the archify CLI is simply not there. The skill is installed
 * per machine (`~/.zcode/skills/archify` on this one, `~/.agents/skills/archify`
 * on others), so a machine without it is a configured absence, not a crash —
 * the loop reports it and the kit proceeds exactly as today, the same law as
 * moli and dev-decisions.
 */
const ARCHIFY_ABSENT =
  "archify CLI not found — the diagram grant needs the archify skill (set ARCHIFY_BIN=/path/to/archify.mjs; see docs)";

/** Where the CLI is looked for once ARCHIFY_BIN is silent. The first one that
 * exists wins, so a machine carrying both keeps a single resolution. Read at
 * call time, not at import time: a long-lived process that changes its home
 * (a test, a per-run environment) resolves against the home it runs under. */
function archifyHomes() {
  const home = os.homedir();
  return [
    path.join(home, ".zcode", "skills", "archify", "bin", "archify.mjs"),
    path.join(home, ".agents", "skills", "archify", "bin", "archify.mjs"),
  ];
}

/**
 * The archify CLI's path, or null. An explicit ARCHIFY_BIN must exist on disk
 * when set — a pointer at nothing is an absence by name, not a hint to keep
 * searching, so the refusal the caller reads is the one the operator can fix.
 */
export function resolveArchifyBin() {
  const pinned = process.env.ARCHIFY_BIN;
  if (pinned) return fs.existsSync(pinned) ? pinned : null;
  for (const home of archifyHomes()) {
    if (fs.existsSync(home)) return home;
  }
  return null;
}

/**
 * One git read, run under the audit's discipline: a failure is data, never a
 * throw. `git show <rev>:<path>` on a path that revision never carried is the
 * `missing` verdict — a finding about the repo, not a fault of the machine — so
 * only ENOENT, which says the binary itself is absent, is reported apart.
 */
function gitRead(args) {
  return new Promise((resolve) => {
    execFile("git", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 15_000 }, (err, stdout, stderr) => {
      if (err) {
        resolve(
          err.code === "ENOENT"
            ? { ok: false, absent: true }
            : { ok: false, absent: false, detail: String(stderr ?? "").trim().slice(0, 120) },
        );
        return;
      }
      resolve({ ok: true, stdout: String(stdout) });
    });
  });
}

/** The collections that carry `sources`, across both diagram shapes. An
 * architecture diagram's refs live on components/boundaries/connections; a
 * workflow's on nodes/edges. */
const REF_COLLECTIONS = ["components", "boundaries", "connections", "nodes", "edges"];

/**
 * Every source ref a parsed candidate carries, flattened, with the collection
 * it came from. `end_line` is optional in a hand-authored candidate, so a
 * one-line ref aliases its own start; a ref with no path or no numeric line
 * names no range at all and is dropped rather than guessed at.
 */
function candidateRefs(candidate) {
  const out = [];
  for (const collection of REF_COLLECTIONS) {
    const items = candidate?.[collection];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const refs = item.sources;
      if (!Array.isArray(refs)) continue;
      for (const ref of refs) {
        if (!ref || typeof ref !== "object") continue;
        const refPath = String(ref.path ?? "").trim();
        const line = Number(ref.line);
        if (!refPath || !Number.isFinite(line)) continue;
        const end = Number(ref.end_line);
        out.push({
          collection,
          path: refPath,
          line,
          endLine: Number.isFinite(end) && end >= line ? end : line,
          label: ref.label ?? null,
        });
      }
    }
  }
  return out;
}

/**
 * The whole pinned range, located verbatim at another place in the current
 * file. The anchor is the range's own first non-blank line — a label's own
 * anchor, never a paraphrase — and the candidate placement is verified over
 * the whole range before it is offered, so a three-line move is not mistaken
 * for a one-line coincidence. The first full-range match wins; an all-blank
 * range anchors nothing and returns null.
 */
function findVerbatimRange(currentText, pinnedRange) {
  const pinnedLines = pinnedRange.split("\n");
  const firstIdx = pinnedLines.findIndex((l) => l.trim() !== "");
  if (firstIdx === -1) return null;
  const currentLines = currentText.split("\n");
  for (let i = 0; i < currentLines.length; i++) {
    if (currentLines[i] !== pinnedLines[firstIdx]) continue;
    const start = i - firstIdx; // zero-based first line of the candidate placement
    if (start < 0) continue;
    if (currentLines.slice(start, start + pinnedLines.length).join("\n") !== pinnedRange) continue;
    return [start + 1, start + pinnedLines.length]; // one-based, the range's own height
  }
  return null;
}

/**
 * The bytes of [line..endLine] of `text`, joined — the unit of comparison. A
 * range that runs past the file's end reads short, so it can never compare
 * equal to something that fits, and the ref falls through to moved/changed
 * rather than passing on a truncation.
 */
function rangeOf(text, line, endLine) {
  const height = Math.max(0, endLine - line + 1);
  return text.split("\n").slice(line - 1, line - 1 + height).join("\n");
}

/**
 * The diagram audit. Reads every `*.candidate.json` under `dir` and verdicts
 * each of its source refs against the revision the candidate pins
 * (`meta.repository.revision`), comparing the bytes at [line..end_line] in the
 * current file with the bytes at that range in the pinned revision — identity,
 * never similarity, because fifteen of the repo's sixty-one labels are
 * paraphrases that match nothing verbatim in the anchored code, and a label
 * matcher would bury the real drift under that noise. A ref whose anchored
 * bytes moved reports where they went (located verbatim, whole range); a ref
 * whose anchored bytes were edited is `changed` — the claim may now be false,
 * which is the agent's judgment to make, never this function's. One
 * `git rev-parse HEAD` per call and one `git show` per distinct
 * (revision, path), so the audit is cheap enough for a doctor row to run on
 * every invocation.
 *
 * Pure read: it writes nothing, ever. The three ways it cannot answer — the
 * dir is absent, git is absent, no candidates live there — come back as
 * `ok:false` with the reason, the same refusal-not-throw law the tabular and
 * semantic lanes hold.
 */
export async function diagramAudit({ dir = "docs/architecture", revision = "HEAD", cwd = process.cwd() } = {}) {
  const archDir = path.resolve(cwd, dir);
  if (!fs.existsSync(archDir)) {
    return { ok: false, reason: `diagram audit: no ${dir} directory at ${archDir} — this repo pins no diagram refs` };
  }
  const headRead = await gitRead(["-C", cwd, "rev-parse", "HEAD"]);
  if (!headRead.ok) {
    return headRead.absent
      ? { ok: false, reason: "git not installed — the diagram audit pins every ref against a revision, so it needs git on PATH (see docs)" }
      : { ok: false, reason: `diagram audit: git rev-parse HEAD failed in ${cwd} (${headRead.detail ?? "not a git repo"})` };
  }
  const head = headRead.stdout.trim();
  let names;
  try {
    names = fs.readdirSync(archDir).filter((n) => n.endsWith(".candidate.json")).sort();
  } catch (e) {
    return { ok: false, reason: `diagram audit: ${dir} is unreadable (${String(e?.message ?? e).slice(0, 120)})` };
  }
  const candidates = [];
  for (const name of names) {
    try {
      candidates.push({ name, parsed: JSON.parse(fs.readFileSync(path.join(archDir, name), "utf8")) });
    } catch (e) {
      // A candidate the audit cannot parse is a file nobody can speak to, and
      // auditing around it would let a corrupted diagram report fresh.
      return { ok: false, reason: `diagram audit: ${name} is not valid JSON (${String(e?.message ?? e).slice(0, 120)}) — repair the candidate first` };
    }
  }
  if (!candidates.length) {
    return { ok: false, reason: `diagram audit: no *.candidate.json in ${archDir} — the archify diagrams are not this repo's` };
  }
  // One git show per distinct (revision, path): the diagrams share refs across
  // candidates, and a wave's batch of three diagrams must not re-read a file
  // the cache already holds.
  const shown = new Map();
  const showPinned = async (rev, refPath) => {
    const key = `${rev}\u0000${refPath}`;
    if (shown.has(key)) return shown.get(key);
    const read = await gitRead(["-C", cwd, "show", `${rev}:${refPath}`]);
    const body = read.ok ? read.stdout : null; // absent at that revision is data
    shown.set(key, body);
    return body;
  };
  const diagrams = [];
  const summary = { intact: 0, moved: 0, changed: 0, missing: 0 };
  for (const { name, parsed } of candidates) {
    const type = String(parsed?.diagram_type ?? "unknown");
    // A candidate that pins nothing is judged against the head it was read at;
    // a candidate that pins "HEAD" means exactly the same thing.
    const pinnedRaw = parsed?.meta?.repository?.revision ?? revision;
    const pinnedRevision = String(pinnedRaw === "HEAD" ? head : pinnedRaw);
    const stale = pinnedRevision !== head;
    const refs = { intact: 0, moved: [], changed: [], missing: [] };
    for (const ref of candidateRefs(parsed)) {
      const from = [ref.line, ref.endLine];
      const entry = { path: ref.path, from, label: ref.label };
      let current = null;
      try {
        current = fs.readFileSync(path.resolve(cwd, ref.path), "utf8");
      } catch {
        /* not in this tree — the ref's anchor has no current bytes */
      }
      const pinned = await showPinned(pinnedRevision, ref.path);
      // Missing names the file's absence at the pinned revision, which is what
      // a deleted-file ref reads as. A file missing from the working tree but
      // present at the pin has no current bytes to compare, and a claim whose
      // anchor is gone is missing all the same.
      if (pinned === null || current === null) {
        refs.missing.push(entry);
        summary.missing += 1;
        continue;
      }
      const pinnedRange = rangeOf(pinned, ref.line, ref.endLine);
      if (rangeOf(current, ref.line, ref.endLine) === pinnedRange) {
        refs.intact += 1;
        summary.intact += 1;
        continue;
      }
      const to = findVerbatimRange(current, pinnedRange);
      if (to) {
        refs.moved.push({ ...entry, to });
        summary.moved += 1;
      } else {
        refs.changed.push(entry);
        summary.changed += 1;
      }
    }
    diagrams.push({
      diagram: name.replace(/\.candidate\.json$/, ""),
      type,
      pinnedRevision,
      stale,
      refs,
    });
  }
  return { ok: true, head, diagrams, summary };
}

/**
 * The re-pin: pure, and bounded to the mechanical half of a refresh. It applies
 * the `moved` verdicts — and nothing else — by matching on (path, from), sets
 * each matched ref's line/end_line to where its bytes now live, and repins the
 * revision in the same pass. The audit proved the bytes are identical before
 * anything moves here, so a move is arithmetic rather than judgment; a `changed`
 * or `missing` ref is not in `movedRefs`, is never touched, and is reported as
 * authored.
 *
 * It accepts the candidate as a parsed object or as the JSON text a workflow
 * read off disk, and returns the serialization the repo's files carry: two-space
 * pretty, the candidates' own key order, one trailing newline. Running it a
 * second time over its own result is a no-op — the moved refs no longer match
 * their old `from`, and the revision is already the head — so a loop that
 * re-pins twice is safe rather than corrupting.
 */
export function diagramRepin(candidateJson, movedRefs, { head } = {}) {
  // A candidate the caller just read is the caller's own file; a JSON that does
  // not parse here is a bug upstream, and it surfaces as the parse error.
  const candidate = typeof candidateJson === "string" ? JSON.parse(candidateJson) : candidateJson;
  const moves = Array.isArray(movedRefs) ? movedRefs : [];
  const changes = [];
  for (const move of moves) {
    const from = Array.isArray(move?.from) ? move.from.map(Number) : null;
    const to = Array.isArray(move?.to) ? move.to.map(Number) : null;
    const refPath = String(move?.path ?? "");
    if (!from || !to || !refPath) continue;
    if (!Number.isFinite(from[0]) || !Number.isFinite(to[0])) continue;
    const fromEnd = Number.isFinite(from[1]) ? from[1] : from[0];
    const toEnd = Number.isFinite(to[1]) ? to[1] : to[0];
    for (const collection of REF_COLLECTIONS) {
      const items = candidate?.[collection];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const refs = item?.sources;
        if (!Array.isArray(refs)) continue;
        for (const ref of refs) {
          if (!ref || typeof ref !== "object" || String(ref.path ?? "") !== refPath) continue;
          const start = Number(ref.line);
          const end = Number.isFinite(Number(ref.end_line)) ? Number(ref.end_line) : start;
          if (start !== from[0] || end !== fromEnd) continue;
          ref.line = to[0];
          ref.end_line = toEnd;
          changes.push({ path: refPath, from: [from[0], fromEnd], to: [to[0], toEnd] });
        }
      }
    }
  }
  if (head) {
    candidate.meta = candidate.meta ?? {};
    candidate.meta.repository = candidate.meta.repository ?? {};
    candidate.meta.repository.revision = String(head);
  }
  return { json: `${JSON.stringify(candidate, null, 2)}\n`, changes };
}

/**
 * The reason a non-zero archify exit gets reported with. Under `--json` the CLI
 * puts its failure on stdout — `{ok:false, status:"fail", failedStage,
 * diagnostics:[{code,message}]}` — and leaves stderr empty, so a refusal that
 * only reads stderr names the exit code and nothing else: a schema cap or a
 * layout gate rejection reaches the operator as "finalize failed (exit 1): ".
 * The stage and the first diagnostic say what actually stopped the run, so
 * they are folded in whenever they parse; stderr still wins when it has text,
 * and anything unparseable keeps the old shape.
 */
function archifyFailureReason(err, stdout, stderr) {
  const trimmedErr = String(stderr ?? "").trim();
  if (trimmedErr) return trimmedErr;
  try {
    const reported = JSON.parse(String(stdout ?? ""));
    const stage = reported?.failedStage ?? reported?.stage;
    const first = reported?.diagnostics?.[0];
    if (stage || first?.message) {
      const detail = first?.message ? `: ${String(first.message).trim().slice(0, 200)}` : "";
      return `${stage ?? "archify"} refused${detail}`;
    }
    if (reported?.ok === false) return "archify finalize reported failure with no diagnostic";
  } catch {
    /* the CLI prints something that is not its failure JSON — keep the bare exit */
  }
  return null;
}

/**
 * The finalize: the receipt dance the refresh procedure spells out for humans,
 * encoded so it cannot be forgotten. The archify CLI is resolved (env, then the
 * two skill homes), the one verb is checked against the allowlist before a
 * process exists, and the run is a plain `node <cli> finalize` under the batch
 * timeout — `finalize` runs a real browser-check, so the cap is generous and
 * the call is batch-only. Every `<stem>.*.json` the run wrote into `outDir`
 * moves back beside the candidate, because the repo tracks its receipts and
 * leaves the refresh dir as scratch; the candidate copy the CLI leaves there is
 * the one file that stays out, since the candidate beside the candidate is not
 * a thing those files are.
 *
 * Absence, a refused verb, a timeout, and a non-zero exit all come back as
 * `ok:false` with the reason — never a throw, the same law as every other
 * lane. The `<n>` numbering of the refresh dir is the workflow's business;
 * this function takes the out-dir it is given and reuses nothing.
 */
export async function diagramFinalize(
  { type, candidate, outDir, repoRoot = ".", cwd = process.cwd(), command = "finalize" } = {},
  { timeoutMs = DIAGRAM_TIMEOUT_MS } = {},
) {
  if (!DIAGRAM_COMMANDS.includes(String(command))) {
    return { ok: false, reason: `unknown diagram command: ${command} (shipped: ${DIAGRAM_COMMANDS.join(", ")})` };
  }
  const cli = resolveArchifyBin();
  if (!cli) return { ok: false, reason: ARCHIFY_ABSENT };
  if (!candidate) {
    return { ok: false, reason: "diagram finalize names no candidate — pass the path to a <stem>.candidate.json" };
  }
  if (!outDir) {
    return { ok: false, reason: "diagram finalize names no outDir — a finalize round needs its own refresh-<n>" };
  }
  const absCandidate = path.resolve(cwd, String(candidate));
  const absOutDir = path.resolve(cwd, String(outDir));
  // The HTML lands beside the candidate under the stem both the repo and the
  // CLI already agree on: system-overview.candidate.json → system-overview.html.
  const outHtml = absCandidate.replace(/\.candidate\.json$/i, "").replace(/\.json$/i, "") + ".html";
  const stem = path.basename(absCandidate).replace(/\.candidate\.json$/i, "").replace(/\.json$/i, "");
  const run = await new Promise((resolve) => {
    execFile(
      "node",
      [cli, "finalize", String(type), absCandidate, outHtml, "--repo-root", String(repoRoot), "--quality", "showcase", "--json", "--out-dir", absOutDir],
      { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err) {
          if (err.code === "ENOENT") return resolve({ ok: false, reason: "node not installed — the diagram grant runs the archify CLI under node (see docs)" });
          if (err.killed) return resolve({ ok: false, reason: `archify finalize exceeded ${timeoutMs}ms wall clock — child killed` });
          const reported = archifyFailureReason(err, stdout, stderr);
          return resolve({ ok: false, reason: `archify finalize failed (exit ${err.code ?? "killed"}): ${(reported ?? "").slice(0, 200)}` });
        }
        resolve({ ok: true, stdout: String(stdout) });
      },
    );
  });
  if (!run.ok) return run;
  // The receipt list is read before it moves, so a run that wrote no summary
  // reports null rather than a stale file the repo already owns.
  let summary = null;
  try {
    summary = JSON.parse(fs.readFileSync(path.join(absOutDir, `${stem}.finalize-summary.json`), "utf8"));
  } catch {
    /* a run without its summary reports none */
  }
  let written;
  try {
    written = fs.readdirSync(absOutDir);
  } catch (e) {
    return { ok: false, reason: `archify finalize wrote nothing into ${absOutDir} (${String(e?.message ?? e).slice(0, 120)})` };
  }
  const receipts = [];
  for (const name of written.sort()) {
    if (!name.startsWith(`${stem}.`) || !name.endsWith(".json")) continue;
    if (name === `${stem}.candidate.json`) continue;
    const moved = path.join(path.dirname(absCandidate), name);
    fs.renameSync(path.join(absOutDir, name), moved);
    receipts.push(moved);
  }
  return { ok: true, type: String(type), outDir: absOutDir, receipts, summary };
}

/**
 * The next refresh dir for one base: `refresh-<n>` with n one past the highest
 * numeric suffix already there, so a round's receipts never land in a previous
 * round's dir and a rerun cannot silently mix two runs' evidence. A base with
 * no refresh dirs — or no directory at all yet — yields refresh-1.
 */
export function nextRefreshDir(dir) {
  const base = path.resolve(dir);
  let high = 0;
  try {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      const m = /^refresh-(\d+)$/.exec(entry.name);
      if (m) high = Math.max(high, Number(m[1]));
    }
  } catch {
    /* no rounds yet — refresh-1 is the right next one */
  }
  return path.join(base, `refresh-${high + 1}`);
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
 * Minimal entity decoding for scraped HTML text — the handful of named refs a
 * results page actually emits, plus numeric ones; `&amp;` last so a doubly
 * escaped ampersand unfolds exactly once.
 */
function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&(?:apos|#x27|#39);/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** Anchor text or snippet → plain text: tags dropped, entities decoded. */
function htmlText(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** One attribute off an anchor's tag text, quoted either way. */
function attrValue(attrs, name) {
  const m = new RegExp(`${name}="([^"]*)"`, "i").exec(attrs) ?? new RegExp(`${name}='([^']*)'`, "i").exec(attrs);
  return m?.[1] ?? "";
}

/** The `uddg=` param of a DDG redirect href, decoded; null when it is not one. */
function uddgTarget(href) {
  const m = /[?&]uddg=([^&]+)/.exec(String(href));
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/**
 * The DDG results page, read with string ops: each hit is a `result__a`
 * anchor whose href carries the real target in a `uddg=` param, and its
 * snippet is the `result__snippet` anchor next to it. Pairing is positional —
 * DDG emits one of each per hit, in order. This is HTML scraping and it knows
 * it: the parser invents nothing, so a layout change reads as "no results",
 * which is exactly what demotes Firecrawl back up.
 */
function parseDuckDuckGoResults(html, rows) {
  const titles = [];
  const snippets = [];
  for (const [, attrs, inner] of String(html).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const cls = attrValue(attrs, "class");
    if (/\bresult__a\b/.test(cls)) titles.push({ href: attrValue(attrs, "href"), text: inner });
    else if (/\bresult__snippet\b/.test(cls)) snippets.push(inner);
  }
  const results = [];
  for (let i = 0; i < titles.length && results.length < rows; i++) {
    const url = uddgTarget(titles[i].href);
    if (!url || !/^https?:/i.test(url)) continue;
    const row = {
      url,
      title: htmlText(titles[i].text).slice(0, 300),
      description: htmlText(snippets[i] ?? "").slice(0, 1000),
    };
    results.push(row);
  }
  return results;
}

/**
 * The keyless search leg: DuckDuckGo's html endpoint under the same bounded
 * discipline as any page — one capped GET, wall clock, no key to resolve.
 */
async function duckduckgoSearch(q, rows, timeoutMs) {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": "agnostic-router-kit/plane-search" },
  });
  const html = await res.text();
  if (!res.ok) {
    return { ok: false, reason: `search failed: HTTP ${res.status} — ${html.slice(0, 160)}` };
  }
  return { ok: true, query: q, results: parseDuckDuckGoResults(html, rows), creditsUsed: 0 };
}

/**
 * The Firecrawl v2 search leg — the one leg that bills, and the only one that
 * can scrape its results. The key arrives under the caller's declared env-var
 * name and never appears in a result, a journal line, or an error.
 */
async function firecrawlSearch(q, { key, rows, scrape = null, timeoutMs = SEARCH_TIMEOUT_MS }) {
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
 * Bounded web search. Three backends: `duckduckgo` — keyless, the html
 * endpoint parsed with string ops; `firecrawl` — the v2 cloud API; and
 * `auto`, the default, which reads DuckDuckGo first and demotes Firecrawl to
 * a fallback it only reaches when DDG came up empty or failed AND the
 * Firecrawl key actually resolves. The demotion is the point: search works
 * on a machine that never configured anything, and the paid backend stays
 * as the quality fallback rather than a toll booth in front of every query.
 * A missing key is a configured absence — a refusal naming the variable, not
 * a crash. One ask is firecrawl-only whatever the caller pinned: a search
 * with `scrape`, because a DDG result page carries no markdown to scrape.
 * The row shape is the contract every caller already reads: url, title,
 * description, and content when a leg could produce it.
 */
export async function searchWeb(query, { backend = "auto", apiKeyEnv = "FIRECRAWL_API_KEY", envMap = {}, limit = 5, scrape = null, timeoutMs = SEARCH_TIMEOUT_MS } = {}) {
  const q = String(query ?? "").trim();
  if (!q) return { ok: false, reason: "a search with no query is not a search" };
  if (backend !== "auto" && backend !== "duckduckgo" && backend !== "firecrawl") {
    return { ok: false, reason: `unknown search backend: ${backend} (shipped: auto, duckduckgo, firecrawl)` };
  }
  const rows = Math.max(1, Math.min(Number(limit) || 5, SEARCH_RESULT_CAP));
  const key = envMap[apiKeyEnv];
  // The scrape ask has no keyless shape — route it straight to the one leg
  // that can honor it.
  if (backend === "firecrawl" || scrape) {
    if (!key) {
      return {
        ok: false,
        reason: `no ${apiKeyEnv} in this run's environment — set it with \`kit env set ${apiKeyEnv}=…\` (or the spawner's own env file)`,
      };
    }
    return firecrawlSearch(q, { key, rows, scrape, timeoutMs });
  }
  let ddg;
  try {
    ddg = await duckduckgoSearch(q, rows, timeoutMs);
  } catch (e) {
    ddg = { ok: false, reason: `search failed: ${String(e?.message ?? e).slice(0, 120)}` };
  }
  // Pinned keyless: no fallback, whatever the key situation looks like.
  if (backend === "duckduckgo") return ddg;
  if (ddg.ok && ddg.results.length) return ddg;
  // auto, and DDG had nothing: the fallback runs only where it can. When it
  // also fails, its refusal is the freshest diagnosis; with no key, DDG's own
  // answer — results, empty, or refusal — is the honest one.
  if (key) return firecrawlSearch(q, { key, rows, timeoutMs });
  return ddg;
}

/**
 * Bounded page scrape through a Firecrawl-compatible endpoint — the scrape
 * router's middle leg. No baseUrl configured is a configured absence: the leg
 * refuses by name and the router moves down the ladder rather than spending
 * cloud credits.
 */
export const SCRAPE_CONTENT_CAP = 20_000;
/** Where the scrape router's Firecrawl leg finds its endpoint when the caller did not pass one. */
const SCRAPE_URL_ENV = "FIRECRAWL_SCRAPE_URL";
async function firecrawlScrape(target, { baseUrl, apiVersion = "v2", apiKeyEnv = "FIRECRAWL_SCRAPE_KEY", envMap = {}, timeoutMs = FETCH_TIMEOUT_MS }) {
  const endpoint = baseUrl || envMap[SCRAPE_URL_ENV];
  if (!endpoint) {
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
    const res = await fetch(`${String(endpoint).replace(/\/+$/, "")}/${apiVersion}/scrape`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers,
      body: JSON.stringify({ url: target, formats }),
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
    return { ok: true, url: target, title: String(data.metadata?.title ?? "").slice(0, 300), content, creditsUsed: Number(parsedBody.creditsUsed ?? 0) };
  } catch (e) {
    return { ok: false, reason: `scrape failed: ${String(e?.message ?? e).slice(0, 120)}` };
  }
}

/**
 * The unified scrape router: moli first (rendered, local, private), then a
 * self-hosted Firecrawl scrape when one is configured, then the plain bounded
 * fetch. The order is the plane's quality ladder — a page moli can render is
 * the truest read of it, Firecrawl is the hosted fallback, and a plain GET is
 * the floor that still works on static HTML. `via` names the leg that
 * actually answered, because a workflow citing a page should be able to cite
 * how it was read. The grant, allowlist, and caps are the caller's — the same
 * gate every other net leg walks; an empty allowlist scrapes nothing rather
 * than everything. On total failure the last refusal is the answer: it names
 * the floor leg, which saw the page's absence most directly.
 */
export async function scrapeUrl(url, { format = "markdown", maxBytes = FETCH_BODY_CAP, timeoutMs = FETCH_TIMEOUT_MS, allowlist = [], baseUrl = null, apiVersion = "v2", apiKeyEnv = "FIRECRAWL_SCRAPE_KEY", envMap = {} } = {}) {
  const gate = gateUrl(url, allowlist);
  if (!gate.ok) return gate;
  const rendered = await browserFetch(url, { format, timeoutMs, maxBytes, allowlist });
  if (rendered.ok) {
    return { ok: true, url: rendered.url, via: "moli", bytes: rendered.bytes, truncated: rendered.truncated, content: rendered.content };
  }
  const hosted = await firecrawlScrape(gate.parsed.toString(), { baseUrl, apiVersion, apiKeyEnv, envMap, timeoutMs });
  if (hosted.ok) return { ...hosted, via: "firecrawl" };
  const plain = await fetchUrl(url, { allowlist, maxBytes, timeoutMs });
  if (plain.ok) {
    const { body, ...rest } = plain;
    return { ...rest, via: "fetch", content: body };
  }
  return plain;
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

/** A loopback port that was free a moment ago — bind and close. The race
 * between the close and the child's bind is real but tiny, and readiness is
 * decided by the health probe, not by the port number being lucky. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * A rendered-browser session (v2 tier): one `moli serve` child on a loopback
 * port and a close() that owns its death. Thin on purpose — this hands back a
 * verified port and the off switch; page automation is the caller's business
 * through the optional playwright peer. Readiness is proven, not assumed: the
 * /json/version endpoint is polled until it answers, and a serve that dies or
 * never comes up is reported with its own stderr instead of a port that
 * quietly connects to nothing.
 */
export async function browserSession({ layout = false, profileDir = null } = {}) {
  const args = ["serve"];
  if (layout) args.push("--layout");
  if (profileDir) args.push("--profile", String(profileDir));
  const port = await freePort();
  args.push("--port", String(port));
  return await new Promise((resolve) => {
    let settled = false;
    let err = "";
    const child = spawn("moli", args, { stdio: ["ignore", "pipe", "pipe"] });
    const finish = (r) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const closeChild = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone — which is the outcome we wanted */
      }
    };
    const deadline = Date.now() + READY_WAIT_MS;
    const probe = async () => {
      while (!settled && Date.now() < deadline) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
          if (res.ok) return finish({ ok: true, port, close: closeChild });
        } catch {
          /* not listening yet — that is what the polling is for */
        }
        await new Promise((r) => setTimeout(r, READY_POLL_MS));
      }
      if (!settled) {
        closeChild();
        finish({ ok: false, reason: `moli serve never answered /json/version within ${READY_WAIT_MS}ms${err ? `: ${err.slice(0, 160)}` : ""}` });
      }
    };
    child.on("error", (e) => {
      if (e?.code === "ENOENT") finish({ ok: false, reason: "the browser session needs moli on PATH" });
      else finish({ ok: false, reason: `browser session failed: ${String(e?.message ?? e).slice(0, 120)}` });
    });
    child.stderr.on("data", (d) => {
      err = `${err}${d}`.slice(-8192);
    });
    child.on("exit", (code, signal) => {
      finish({ ok: false, reason: `moli serve exited before it was ready (exit ${code ?? signal ?? "?"}): ${err.slice(0, 160)}` });
    });
    probe();
  });
}
