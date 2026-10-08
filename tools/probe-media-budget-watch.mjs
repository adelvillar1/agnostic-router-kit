#!/usr/bin/env node
/**
 * media-budget-watch's composition, executed and held (C3/C6).
 *
 * The loop's promise: ingest, forecast, report — and escalate a crossing and
 * nothing else. Proven here two ways.
 *
 * Hermetically, by driving the REAL workflow body — the same text transform
 * the plane applies (`annotateAskSites`, the surface bound as globals,
 * `export default async function`) — over stub CLIs answering in the lane's
 * pinned machine rows: the ingest-then-forecast order, the per-provider band
 * table, the degraded providers named with the engine's own reasons, the
 * scope view filter (which never recomputes the estimate), exactly one
 * escalation for an over-budget verdict and none for a degraded one, the
 * conclusion carrying the estimate against the budget, and fail-open by name
 * on every refusing branch.
 *
 * Live, where the engine's own verbs can run without a key or a model:
 * `record-media-runs` is parse-only and `media-budget` degrades before it
 * ever reaches sdm1 when a provider has fewer than four recorded days, so the
 * two claims a stub cannot prove are proven by execution against the real CLI
 * in a redirected HOME — the ingest's idempotence (a second pass lands 0 new
 * rows) and the degraded path's named reason. Those cases skip, and say they
 * skip, when no dev-decisions CLI resolves.
 *
 *   node tools/probe-media-budget-watch.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const engineDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { media } = await import(path.join(engineDir, "lib", "workflow", "services.mjs"));
const { annotateAskSites } = await import(path.join(engineDir, "lib", "workflow", "schema.mjs"));

let pass = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok — ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL — ${name}: ${String(e?.message ?? e).slice(0, 300)}`);
  }
}

const yard = fs.mkdtempSync(path.join(os.tmpdir(), "media-budget-probe-"));

// ── the stub CLIs: the lane's pinned rows, one scenario per file ─────────────
// Each stub answers both verbs (the loop calls ingest, then forecast) and
// drops its argv into a file, so the composition proves what rode the wire.
function stub(name, { ingest, budget }) {
  const p = path.join(yard, name);
  const argvFile = path.join(yard, `${name}.argv`);
  const body = [
    `#!/usr/bin/env node`,
    `require("node:fs").appendFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
    `const cmd = process.argv[2];`,
    `if (cmd === "record-media-runs") {`,
    ...ingest.rows.map((r) => `  process.stdout.write(${JSON.stringify(JSON.stringify(r))} + "\\n");`),
    `  process.exit(${ingest.exit ?? 0});`,
    `}`,
    `if (cmd === "media-budget") {`,
    ...budget.rows.map((r) => `  process.stdout.write(${JSON.stringify(JSON.stringify(r))} + "\\n");`),
    `  process.exit(${budget.exit ?? 0});`,
    `}`,
    `process.exit(2);`,
  ];
  fs.writeFileSync(p, body.join("\n"), { mode: 0o755 });
  return p;
}
const INGEST_OK = { rows: [{ op: "record-media-runs", ok: true, provider: "gen1_raw/qwen+gen1_raw/stepfun", lines_total: 5, rows_new: 3, rows_duplicate: 2, rows_skipped: 0, verdict: "ok" }] };
const INGEST_REFUSED = { rows: [{ op: "record-media-runs", ok: false, error: "record-media-runs: no telemetry at /root/.config/gen1/telemetry.jsonl — run a speak/transcribe first" }], exit: 3 };
const BANDED = {
  rows: [
    {
      op: "media-budget",
      ok: true,
      target: "/tables/media_runs.csv",
      task: "media_budget_forecast",
      bands: {
        "gen1_raw/qwen": { median: 120.5, lo: 100.0, hi: 140.0 },
        "gen1_raw/stepfun": { median: 80.25, lo: 60.0, hi: 99.0 },
      },
      estimate_total_s: 200.75,
      budget_s: 500.0,
      degraded: ["gen1_raw/kokoro: only 2 recorded day(s) — forecast needs 4"],
      verdict: "pass",
      escalated: false,
    },
  ],
};
const OVER = {
  rows: [
    {
      op: "media-budget",
      ok: true,
      target: "/tables/media_runs.csv",
      task: "media_budget_forecast",
      bands: { "gen1_raw/qwen": { median: 120.5, lo: 100.0, hi: 140.0 } },
      estimate_total_s: 200.75,
      budget_s: 100.0,
      degraded: [],
      verdict: "over",
      escalated: true,
    },
  ],
  exit: 1, // the lane's advisory WARN exit — the bridge treats rows as payload
};
const DEGRADED = {
  rows: [
    {
      op: "media-budget",
      ok: true,
      target: "/tables/media_runs.csv",
      task: "media_budget_forecast",
      bands: {},
      estimate_total_s: 33.25,
      budget_s: 900.0,
      degraded: [
        "gen1_raw/qwen: only 1 recorded day(s) — forecast needs 4",
        "gen1_raw/stepfun: forecast declined — sdm1 unavailable; recorded mean 8.3s/day over 2 day(s) shown instead",
      ],
      verdict: "pass",
      escalated: false,
    },
  ],
};
const NO_TABLE = { rows: [{ op: "media-budget", ok: false, error: "media-budget: no media_runs.csv at /tables — run record-media-runs first" }], exit: 3 };

const BANDED_STUB = stub("banded", { ingest: INGEST_OK, budget: BANDED });
const OVER_STUB = stub("over", { ingest: INGEST_OK, budget: OVER });
const DEGRADED_STUB = stub("degraded", { ingest: INGEST_OK, budget: DEGRADED });
const NO_SINK_STUB = stub("no-sink", { ingest: INGEST_REFUSED, budget: NO_TABLE });
const NO_TABLE_STUB = stub("no-table", { ingest: INGEST_OK, budget: NO_TABLE });
const ABSENT = path.join(yard, "no-such-cli");

async function withBin(bin, body) {
  const real = process.env.DEV_DECISIONS_BIN;
  process.env.DEV_DECISIONS_BIN = bin;
  try {
    return await body();
  } finally {
    if (real === undefined) delete process.env.DEV_DECISIONS_BIN;
    else process.env.DEV_DECISIONS_BIN = real;
  }
}

// ── the loop, driven through the plane's own transform ───────────────────────
const source = fs.readFileSync(path.join(engineDir, "workflows", "media-budget-watch.ts"), "utf8");
const moduleText = `export default async function __wfRun() {\n${annotateAskSites(source).source}\n}`;
const modulePath = path.join(yard, "media-budget-watch.mts");
fs.writeFileSync(modulePath, moduleText);
const mod = await import(new URL(`file://${modulePath}`).href);

/** Bind the run surface as globals — the engine's own line — and call the loop. */
async function drive(runArgs) {
  const collected = { logs: [], phases: [], reports: [], artifacts: [], escalations: [] };
  const api = {
    args: runArgs,
    log: (m) => collected.logs.push(String(m)),
    phase: (n) => collected.phases.push(String(n)),
    report: (item) => collected.reports.push(item),
    escalate: async (question, context, tag) => {
      collected.escalations.push({ question: String(question), context: String(context), tag: String(tag) });
      return "the owner's answer, recorded never applied";
    },
    artifact: {
      markdown: async (id, content, opts) => {
        collected.artifacts.push({ id, content: String(content), title: opts?.title ?? id, primary: opts?.primary ?? false });
        return { id, version: 1 };
      },
      file: async (id) => {
        throw new Error(`media-budget-watch must never publish a file artifact (${id})`);
      },
    },
    files: {
      read: (rel) => {
        throw new Error(`media-budget-watch reads no file — the forecast is the engine's row (${rel})`);
      },
      glob: () => [],
      grep: () => [],
    },
    world: {
      // The kit's own bridge, so the advisory-exit and stdout-refusal handling
      // under test here is the one a real run exercises.
      media: (command, callArgs, callOpts) => media(command, callArgs, callOpts),
    },
  };
  const keys = Object.keys(api);
  for (const k of keys) globalThis[k] = api[k];
  try {
    const result = await mod.default();
    return { ...collected, result };
  } finally {
    for (const k of keys) delete globalThis[k];
  }
}
const argvLines = (name) => fs.readFileSync(path.join(yard, `${name}.argv`), "utf8").trim().split("\n").slice(-2);
const md = (run) => run.artifacts.find((a) => a.id === "media-budget-watch")?.content ?? "";

// ── the composition: ingest, then forecast, then report ──────────────────────

await check("ingest rides first, and --budget-seconds rides only when named", async () => {
  const run = await withBin(BANDED_STUB, () => drive({}));
  const argv = argvLines("banded");
  assert.equal(argv.length, 2, `two verb calls: ${argv.join(" | ")}`);
  assert.deepEqual(JSON.parse(argv[0]), ["record-media-runs", "--json"]);
  // Absent budgetSeconds = report only: no --budget-seconds flag at all.
  assert.deepEqual(JSON.parse(argv[1]), ["media-budget", "--json"]);
  await withBin(BANDED_STUB, () => drive({ budgetSeconds: 500, telemetry: "/sink.jsonl" }));
  const argv2 = argvLines("banded");
  assert.deepEqual(JSON.parse(argv2[0]), ["record-media-runs", "--json", "--telemetry", "/sink.jsonl"]);
  assert.deepEqual(JSON.parse(argv2[1]), ["media-budget", "--json", "--budget-seconds", "500"]);
});

await check("the per-provider bands and the degraded reasons ride the report", async () => {
  const run = await withBin(BANDED_STUB, () => drive({}));
  const r = run.result;
  assert.equal(r.failOpen, undefined, `fail-open fired: ${r.refused ?? ""}`);
  assert.equal(r.verdict, "pass");
  assert.equal(r.estimateTotalS, 200.75);
  assert.deepEqual(r.bandedProviders, ["gen1_raw/qwen", "gen1_raw/stepfun"]);
  assert.deepEqual(r.degraded, [{ provider: "gen1_raw/kokoro", reason: "only 2 recorded day(s) — forecast needs 4" }]);
  const body = md(run);
  assert.match(body, /\| `gen1_raw\/qwen` \| 100\.0s–140\.0s \| 120\.5s \| banded \|/);
  assert.match(body, /\| `gen1_raw\/stepfun` \| 60\.0s–99\.0s \| 80\.3s \| banded \|/);
  assert.match(body, /\| `gen1_raw\/kokoro` \| — \| — \| degraded — only 2 recorded day\(s\) — forecast needs 4 \|/);
  assert.match(body, /No budget named — report only\. Next-day estimate \*\*200\.8s\*\*\./);
  assert.match(body, /Degraded is information, not a crossing/);
  // The raw row rides verbatim, so an unrecognized field would be visible.
  assert.match(body, /"estimate_total_s": 200\.75/);
});

await check("an over-budget verdict escalates exactly once, naming the crossing", async () => {
  const run = await withBin(OVER_STUB, () => drive({ budgetSeconds: 100 }));
  assert.equal(run.escalations.length, 1, `escalations: ${run.escalations.length}`);
  const esc = run.escalations[0];
  assert.match(esc.question, /next-day media-seconds estimate 200\.8s is over the 100\.0s budget/);
  assert.match(esc.question, /banded: gen1_raw\/qwen/);
  assert.match(esc.question, /this loop only reports/);
  assert.equal(esc.tag, "media-budget-watch");
  assert.equal(run.result.over, true);
  assert.equal(run.result.escalated, true);
  // The conclusion carries the estimate against the budget — the plan's C3.
  assert.match(run.result.conclusion, /next-day estimate 200\.8s vs budget 100\.0s → OVER/);
  assert.match(md(run), /\*\*The estimate is over the budget\.\*\*/);
  assert.equal(run.reports.filter((x) => x.escalated === true).length, 1);
});

await check("degraded never escalates, even under a budget that is not crossed", async () => {
  const run = await withBin(DEGRADED_STUB, () => drive({ budgetSeconds: 900 }));
  assert.equal(run.escalations.length, 0, `escalations: ${run.escalations.length}`);
  assert.equal(run.result.over, false);
  assert.equal(run.result.verdict, "pass");
  assert.deepEqual(run.result.degraded, [
    { provider: "gen1_raw/qwen", reason: "only 1 recorded day(s) — forecast needs 4" },
    { provider: "gen1_raw/stepfun", reason: "forecast declined — sdm1 unavailable; recorded mean 8.3s/day over 2 day(s) shown instead" },
  ]);
  assert.match(run.result.conclusion, /next-day estimate 33\.3s vs budget 900\.0s → within/);
  assert.match(run.result.conclusion, /0 banded, 2 degraded; no crossing to escalate/);
  // A degraded run still publishes its table — information, reported.
  assert.equal(run.artifacts.length, 1);
});

await check("scope filters the view and never the math", async () => {
  const run = await withBin(BANDED_STUB, () => drive({ scope: "gen1_raw/stepfun" }));
  const r = run.result;
  assert.deepEqual(r.scope, ["gen1_raw/stepfun"]);
  assert.deepEqual(r.bandedProviders, ["gen1_raw/qwen", "gen1_raw/stepfun"], "the row's providers are unchanged");
  assert.equal(r.estimateTotalS, 200.75, "the estimate is the engine's whole-provider number, unrecomputed");
  assert.deepEqual(r.outOfScope, ["gen1_raw/qwen", "gen1_raw/kokoro"]);
  const body = md(run);
  assert.match(body, /\| `gen1_raw\/stepfun` \| 60\.0s–99\.0s \| 80\.3s \| banded \|/);
  assert.match(body, /\| _out of scope_ \| gen1_raw\/qwen, gen1_raw\/kokoro/);
  assert.match(body, /The estimate is the engine's whole-provider number, verbatim from the row/);
  // A scope naming a provider the row never mentions is named, not dropped.
  const unknown = await withBin(BANDED_STUB, () => drive({ scope: "gen1_raw/elevenlabs" }));
  assert.deepEqual(unknown.result.unknownScope, ["gen1_raw/elevenlabs"]);
  assert.match(md(unknown), /\| _not in this run's rows_ \| gen1_raw\/elevenlabs/);
});

await check("an idempotent re-ingest is named, not treated as new spend", async () => {
  const run = await withBin(stub("reingest", { ingest: { rows: [{ op: "record-media-runs", ok: true, lines_total: 5, rows_new: 0, rows_duplicate: 3, rows_skipped: 0, verdict: "ok", provider: "none" }] }, budget: BANDED }), () => drive({}));
  assert.equal(run.result.ingested.rowsNew, 0);
  assert.equal(run.result.ingested.rowsDuplicate, 3);
  assert.match(run.logs.join("\n"), /already ingested — occurrence-keyed, a re-run lands nothing twice/);
});

// ── fail-open by name, on every refusing branch ─────────────────────────────

await check("an absent CLI fails open with the bridge's pinned sentence", async () => {
  const run = await withBin(ABSENT, () => drive({}));
  assert.equal(run.result.failOpen, true);
  assert.equal(
    run.result.refused,
    "dev-decisions not installed — the media grant needs the dev-decisions CLI with gen1 (see docs)",
  );
  assert.match(run.result.conclusion, /^media budget unavailable — the spend is unjudged — dev-decisions not installed/);
  assert.equal(run.escalations.length, 0);
  assert.equal(run.artifacts.length, 0, "a fail-open run publishes no artifact");
});

await check("a missing telemetry sink fails open with the engine's own words", async () => {
  const run = await withBin(NO_SINK_STUB, () => drive({}));
  assert.equal(run.result.failOpen, true);
  assert.equal(run.result.command, "record-media-runs");
  assert.equal(run.result.refused, "record-media-runs: no telemetry at /root/.config/gen1/telemetry.jsonl — run a speak/transcribe first");
  assert.match(run.result.conclusion, /the spend is unjudged/);
});

await check("a missing media-seconds table fails open naming the ingest", async () => {
  const run = await withBin(NO_TABLE_STUB, () => drive({}));
  assert.equal(run.result.failOpen, true);
  assert.equal(run.result.command, "media-budget");
  assert.equal(run.result.refused, "media-budget: no media_runs.csv at /tables — run record-media-runs first");
});

// ── the structure: report-only, no agents, no model calls, no reads ──────────

await check("the source holds the report-only law the plan greps for", () => {
  assert.ok(
    source.includes("// media-loops: this workflow writes nothing of its own — the ingest verb owns its table"),
    "the no-own-write marker must live as its own line",
  );
  for (const forbidden of ["files.write", "files.edit", "world.run(", "artifact.file("]) {
    assert.ok(!source.includes(forbidden), `the source must not contain ${forbidden}`);
  }
  for (const forbidden of ["chatCompletion", ".ask<", "child_process", "execFile"]) {
    assert.ok(!source.includes(forbidden), `the source must not contain ${forbidden}`);
  }
});

await check("the loop spawns no agents and makes no model call (by execution)", async () => {
  const run = await withBin(BANDED_STUB, () => drive({}));
  assert.deepEqual(run.phases, [
    "Ingest gen1's telemetry sink",
    "Forecast the next day's media seconds",
    "Report the bands, the estimate, and the crossing",
  ]);
  assert.equal(run.artifacts.length, 1);
  assert.ok(run.reports.some((x) => x.ingested === true));
});

// ── the live legs: the real CLI, no key, no model ───────────────────────────
// record-media-runs is parse-only and media-budget degrades before sdm1 when a
// provider has under four recorded days, so the ingest's idempotence and the
// degraded reason are provable by execution against the real engine — in a
// redirected HOME so the table lands in this yard and the operator's own
// history is never touched.

function resolveLiveBin() {
  if (process.env.DEV_DECISIONS_BIN && process.env.DEV_DECISIONS_BIN !== ABSENT) return process.env.DEV_DECISIONS_BIN;
  const script = path.join(os.homedir(), ".agents", "skills", "dev-decisions", "scripts", "dev_decisions.py");
  if (fs.existsSync(script)) {
    const wrap = path.join(yard, "dd-live");
    fs.writeFileSync(wrap, `#!/bin/sh\nexec python3 ${JSON.stringify(script)} "$@"\n`, { mode: 0o755 });
    return wrap;
  }
  return "dev-decisions";
}

// One HOME for the whole live section: the media-seconds table is the thing
// under test, so the cases must share it (an idempotence proof needs the first
// pass's rows to still be there for the second). It is a yard dir — the
// operator's own history is never read or written.
const liveHome = path.join(yard, "home");
fs.mkdirSync(path.join(liveHome, ".local", "share", "dev-decisions", "tables"), { recursive: true });
async function withLive(bin, body) {
  const realBin = process.env.DEV_DECISIONS_BIN;
  const realHome = process.env.HOME;
  process.env.DEV_DECISIONS_BIN = bin;
  process.env.HOME = liveHome;
  try {
    return await body();
  } finally {
    if (realBin === undefined) delete process.env.DEV_DECISIONS_BIN;
    else process.env.DEV_DECISIONS_BIN = realBin;
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
  }
}
const TELEMETRY = path.join(yard, "telemetry.jsonl");
fs.writeFileSync(
  TELEMETRY,
  [
    JSON.stringify({ provider: "gen1_raw/qwen", model: "qwen-audio-3.0-tts-plus", duration_seconds: 12.5, request_id: "r1", input_sha256: "aaa", input_chars: 40, input_bytes: 80 }),
    JSON.stringify({ provider: "gen1_raw/stepfun", model: "stepaudio-2.5-tts", duration_seconds: 8.25, request_id: "r2", input_sha256: "bbb", input_chars: 30, input_bytes: 60 }),
    JSON.stringify({ provider: "gen1_raw/qwen", model: "qwen-audio-3.0-tts-plus", duration_seconds: 12.5, request_id: "r1", input_sha256: "aaa", input_chars: 40, input_bytes: 80 }),
    "not json at all",
    "",
  ].join("\n"),
);
const liveBin = resolveLiveBin();
// Liveness through the bridge's own spawn path: an absent binary answers with
// the pinned absence reason, and a present one refuses the (nonexistent) sink
// by name — which is itself a real answer.
const liveAvailable = await withBin(liveBin, () =>
  media("record-media-runs", { telemetry: path.join(yard, "probe-only.jsonl") }, { timeoutMs: 20_000 }),
)
  .then((r) => !String(r.reason ?? "").includes("dev-decisions not installed"))
  .catch(() => false);

if (!liveAvailable) {
  console.log("  skip — the live legs: no dev-decisions CLI resolves on this machine (the stub cases above hold the contract)");
} else {
  await check("live: the ingest is idempotent by execution — a second pass lands 0 new rows", async () => {
    const { first, second } = await withLive(liveBin, async () => ({
      first: await drive({ telemetry: TELEMETRY }),
      second: await drive({ telemetry: TELEMETRY }),
    }));
    assert.equal(first.result.failOpen, undefined, `fail-open fired: ${first.result.refused ?? ""}`);
    assert.equal(first.result.ingested.rowsNew, 3, "the first pass lands the three parseable lines");
    assert.equal(first.result.ingested.rowsSkipped, 1, "the corrupt line is skipped by name, never fatal");
    assert.equal(second.result.failOpen, undefined, `fail-open fired: ${second.result.refused ?? ""}`);
    assert.equal(second.result.ingested.rowsNew, 0, "the second pass lands nothing twice");
    assert.equal(second.result.ingested.rowsDuplicate, 3, "every line is already ingested, by occurrence");
  });

  await check("live: the degraded path names its reason (fewer than four recorded days)", async () => {
    const run = await withLive(liveBin, () => drive({ telemetry: TELEMETRY }));
    // Every row is stamped with the ingest date, so one pass is one recorded
    // day: both providers degrade before sdm1 is ever consulted — no key, no
    // model, and no fabricated band.
    assert.deepEqual(
      run.result.degraded.map((d) => d.provider).sort(),
      ["gen1_raw/qwen", "gen1_raw/stepfun"],
    );
    for (const d of run.result.degraded) assert.match(d.reason, /only 1 recorded day\(s\) — forecast needs 4/);
    assert.equal(run.result.estimateTotalS, 33.25, "the estimate is the recorded day's total, not a fabricated band");
    assert.equal(run.escalations.length, 0, "degraded never escalates");
    assert.match(md(run), /Degraded is information, not a crossing/);
  });

  await check("live: over-budget escalates exactly once against the real row", async () => {
    const run = await withLive(liveBin, () => drive({ telemetry: TELEMETRY, budgetSeconds: 5 }));
    assert.equal(run.result.verdict, "over");
    assert.equal(run.result.over, true);
    assert.equal(run.escalations.length, 1);
    assert.match(run.escalations[0].question, /estimate 33\.3s is over the 5\.0s budget/);
    assert.match(run.result.conclusion, /next-day estimate 33\.3s vs budget 5\.0s → OVER/);
    // And a budget the estimate fits crosses nothing.
    const within = await withLive(liveBin, () => drive({ telemetry: TELEMETRY, budgetSeconds: 900 }));
    assert.equal(within.result.over, false);
    assert.equal(within.escalations.length, 0);
    assert.match(within.result.conclusion, /vs budget 900\.0s → within/);
  });
}

// ── the tally ────────────────────────────────────────────────────────────────

fs.rmSync(yard, { recursive: true, force: true });
if (failures.length) {
  console.log(`  failed: ${failures.join(" | ")}`);
}
console.log(`probe-media-budget-watch: ${pass} cases pass, ${failures.length} fail`);
process.exitCode = failures.length ? 1 : 0;
