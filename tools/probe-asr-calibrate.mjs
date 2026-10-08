#!/usr/bin/env node
/**
 * asr-calibrate's composition, executed and held (C2/C6).
 *
 * The loop's promise: it turns the pinned fixture's per-leg grades into
 * promotion evidence and writes nothing. Proven here by driving the REAL
 * workflow body — the same text transform the plane applies
 * (`annotateAskSites`, the surface bound as globals, `export default async
 * function`) — over the kit's own `media()` bridge pointed at stub CLIs that
 * answer in the lane's pinned machine rows:
 *
 *   1. planted per-provider rows (one leg clearing the floor, one short on
 *      agreement, one short on rows) → the floor comparison → the per-leg
 *      artifact table → exactly one escalation naming the cleared leg, and no
 *      escalation at all when nothing clears;
 *   2. the caller's floor and minRows are the comparison's numbers (a stricter
 *      pair un-clears the leg that cleared at the default);
 *   3. fail-open by name on every refusing branch — the CLI absent, the
 *      fixture dir refusing on stdout with exit 3 (the lane's advisory exit,
 *      which the bridge hands back as `refused`), and an answer carrying no
 *      per-leg rows;
 *   4. the structure — the file spawns no agent, makes no model call, reads no
 *      file, and carries the no-write-path marker the plan greps for.
 *
 *   node tools/probe-asr-calibrate.mjs
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

const yard = fs.mkdtempSync(path.join(os.tmpdir(), "asr-calibrate-probe-"));

// ── the stub CLIs: the lane's pinned rows, one scenario per file ─────────────
// Each stub also drops its argv into an invocations file, so the composition
// proves what actually rode the wire (--json first, --fixtures only when the
// caller named one) rather than trusting the workflow's intent.
function stub(name, rows, { exit = 0 } = {}) {
  const p = path.join(yard, name);
  const argvFile = path.join(yard, `${name}.argv`);
  fs.writeFileSync(
    p,
    [
      `#!/usr/bin/env node`,
      `require("node:fs").writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));`,
      ...rows.map((r) => `process.stdout.write(${JSON.stringify(JSON.stringify(r))} + "\\n");`),
      `process.exit(${exit});`,
    ].join("\n"),
    { mode: 0o755 },
  );
  return p;
}
const row = (o) => ({ op: "record-asr", ok: true, ...o });
// The planted legs: qwen clears the default floor (0.9 / 3 rows), stepfun is
// accurate enough on rows but short on both scores, kokoro is perfect on one
// row — a leg whose score means nothing yet.
const CLEARS = stub("clears", [
  row({ provider: "gen1_raw/qwen", n: 4, accuracy: 1.0, mean_agreement: 0.97 }),
  row({ provider: "gen1_raw/stepfun", n: 5, accuracy: 0.75, mean_agreement: 0.71 }),
  row({ provider: "gen1_raw/kokoro", n: 1, accuracy: 1.0, mean_agreement: 1.0 }),
  row({ rows: 10, feedback_file: "/home/x/.local/share/dev-decisions/feedback.csv" }),
]);
const SHORT = stub("short", [
  row({ provider: "gen1_raw/qwen", n: 4, accuracy: 0.5, mean_agreement: 0.48 }),
  row({ provider: "gen1_raw/stepfun", n: 2, accuracy: 0.6, mean_agreement: 0.6 }),
  row({ rows: 6, feedback_file: "/home/x/.local/share/dev-decisions/feedback.csv" }),
]);
// The lane prints refusals on stdout and exits non-zero: the bridge hands the
// row's error back as `refused`, which is the fail-open this case pins.
const REFUSED = stub("refused", [{ op: "record-asr", ok: false, error: "record-asr: no .mp3/.txt fixture pairs in /tmp/fixtures" }], { exit: 3 });
const KEYS_MISSING = stub("keys-missing", [{ op: "record-asr", ok: false, error: "record-asr: no graded rows — every fixture refused (keys missing?)" }], { exit: 3 });
const NO_LEGS = stub("no-legs", [row({ rows: 0, feedback_file: "/home/x/.local/share/dev-decisions/feedback.csv" })]);
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
const source = fs.readFileSync(path.join(engineDir, "workflows", "asr-calibrate.ts"), "utf8");
const moduleText = `export default async function __wfRun() {\n${annotateAskSites(source).source}\n}`;
const modulePath = path.join(yard, "asr-calibrate.mts");
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
        throw new Error(`asr-calibrate must never publish a file artifact (${id})`);
      },
    },
    files: {
      read: (rel) => {
        throw new Error(`asr-calibrate reads no file — it grades the rows the verb printed (${rel})`);
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
const argvOf = (name) => JSON.parse(fs.readFileSync(path.join(yard, `${name}.argv`), "utf8"));
const md = (run) => run.artifacts.find((a) => a.id === "asr-calibrate")?.content ?? "";

// ── the composition: rows → floor comparison → table → one escalation ────────

await check("planted per-leg rows: the floor comparison clears exactly one leg", async () => {
  const run = await withBin(CLEARS, () => drive({}));
  assert.equal(run.result.failOpen, undefined, `fail-open fired: ${run.result.refused ?? run.result.reason ?? ""}`);
  const legs = run.result.legs;
  assert.equal(legs.length, 3);
  const byProvider = Object.fromEntries(legs.map((l) => [l.provider, l]));
  assert.equal(byProvider["gen1_raw/qwen"].clears, true);
  assert.equal(byProvider["gen1_raw/stepfun"].clears, false);
  assert.deepEqual(byProvider["gen1_raw/stepfun"].lacks, ["accuracy", "agreement"]);
  assert.equal(byProvider["gen1_raw/kokoro"].clears, false);
  assert.deepEqual(byProvider["gen1_raw/kokoro"].lacks, ["rows (1 of 3)"]);
  assert.deepEqual(run.result.cleared, ["gen1_raw/qwen"]);
  assert.equal(run.result.floor, 0.9);
  assert.equal(run.result.minRows, 3);
  assert.equal(run.result.task, "asr_roundtrip");
});

await check("the per-leg table and the promotion evidence ride the artifact", async () => {
  const run = await withBin(CLEARS, () => drive({}));
  const body = md(run);
  assert.match(body, /\| `gen1_raw\/qwen` \| 4 \| 1\.000 \| 0\.970 \| \*\*clears\*\* \|/);
  assert.match(body, /\| `gen1_raw\/stepfun` \| 5 \| 0\.750 \| 0\.710 \| lacks accuracy, agreement \|/);
  assert.match(body, /\| `gen1_raw\/kokoro` \| 1 \| 1\.000 \| 1\.000 \| lacks rows \(1 of 3\) \|/);
  assert.match(body, /## Promotion evidence/);
  assert.match(body, /These legs clear the floor: `gen1_raw\/qwen`\./);
  // The law, in the artifact's own words: evidence only, the owner promotes.
  assert.match(body, /\*\*This loop does not lift the `gen1_raw` tag\.\*\*/);
  // Every row the verb printed rides raw — an unrecognized row would be shown.
  assert.match(body, /"rows":10/);
  assert.match(body, /"mean_agreement":0\.97/);
  assert.equal(run.artifacts[0].primary, true);
});

await check("exactly one escalation, and its text names the cleared leg and the owner's call", async () => {
  const run = await withBin(CLEARS, () => drive({}));
  assert.equal(run.escalations.length, 1, `escalations: ${run.escalations.length}`);
  const esc = run.escalations[0];
  assert.match(esc.question, /gen1_raw\/qwen/);
  assert.match(esc.question, /floor 0\.9, 3\+ rows/);
  assert.match(esc.question, /the owner decides whether the gen1_raw eval-only tag lifts/);
  assert.match(esc.question, /this loop writes nothing/);
  assert.equal(esc.tag, "asr-calibrate");
  assert.equal(run.result.escalated, true);
  assert.equal(run.result.ownerAnswer, "the owner's answer, recorded never applied");
  const escalated = run.reports.filter((r) => r.escalated === true);
  assert.equal(escalated.length, 1);
  assert.deepEqual(escalated[0].cleared, ["gen1_raw/qwen"]);
});

await check("a run where nothing clears escalates nothing", async () => {
  const run = await withBin(SHORT, () => drive({}));
  assert.equal(run.escalations.length, 0, `escalations: ${run.escalations.length}`);
  assert.deepEqual(run.result.cleared, []);
  assert.equal(run.result.escalated, false);
  assert.match(run.result.conclusion, /no promotion evidence in this run/);
  // The shortfall is actionable, not just short: the artifact says what a leg
  // needs (more graded fixtures, or the leg itself looked at).
  assert.match(md(run), /No leg clears the floor yet/);
  assert.match(md(run), /needs more fixtures graded before its score means anything/);
});

await check("the caller's floor and minRows are the comparison's numbers", async () => {
  const run = await withBin(CLEARS, () => drive({ floor: 0.99, minRows: 10 }));
  assert.equal(run.result.floor, 0.99);
  assert.equal(run.result.minRows, 10);
  // The leg that cleared at 0.9/3 no longer clears at 0.99/10 — the numbers
  // came from the caller, not from a constant.
  assert.deepEqual(run.result.cleared, []);
  const qwen = run.result.legs.find((l) => l.provider === "gen1_raw/qwen");
  assert.deepEqual(qwen.lacks, ["rows (4 of 10)", "agreement"]);
  assert.equal(run.escalations.length, 0);
});

await check("the engine's own default fixtures ride when the caller names none", async () => {
  await withBin(CLEARS, () => drive({}));
  assert.deepEqual(argvOf("clears"), ["record-asr", "--json"]);
  await withBin(CLEARS, () => drive({ fixtures: "/tmp/my-fixtures" }));
  assert.deepEqual(argvOf("clears"), ["record-asr", "--json", "--fixtures", "/tmp/my-fixtures"]);
});

// ── fail-open by name, on every refusing branch ─────────────────────────────

await check("an absent CLI fails open with the bridge's pinned sentence", async () => {
  const run = await withBin(ABSENT, () => drive({}));
  assert.equal(run.result.failOpen, true);
  assert.equal(
    run.result.refused,
    "dev-decisions not installed — the media grant needs the dev-decisions CLI with gen1 (see docs)",
  );
  assert.match(
    run.result.conclusion,
    /^asr calibration unavailable — the gen1_raw tag stands unchanged — dev-decisions not installed/,
  );
  assert.match(run.result.conclusion, /the gen1_raw tag stands unchanged/);
  assert.equal(run.escalations.length, 0);
  assert.equal(run.artifacts.length, 0, "a fail-open run publishes no artifact");
  assert.ok(run.logs.some((l) => l.includes("record-asr refused: dev-decisions not installed")));
});

await check("a fixture dir with no pairs fails open with the engine's words verbatim", async () => {
  const run = await withBin(REFUSED, () => drive({ fixtures: "/tmp/fixtures" }));
  assert.equal(run.result.failOpen, true);
  // The refusal row rode stdout with exit 3 — the advisory exit — and the
  // loop reports the row's error, not a stderr tail.
  assert.equal(run.result.refused, "record-asr: no .mp3/.txt fixture pairs in /tmp/fixtures");
  assert.match(run.result.conclusion, /the gen1_raw tag stands unchanged/);
  assert.equal(run.escalations.length, 0);
});

await check("every fixture refusing (keys missing) fails open by name", async () => {
  const run = await withBin(KEYS_MISSING, () => drive({}));
  assert.equal(run.result.failOpen, true);
  assert.equal(run.result.refused, "record-asr: no graded rows — every fixture refused (keys missing?)");
  assert.ok(run.reports.some((r) => r.failOpen === true && r.command === "record-asr"));
});

await check("an answer with no per-leg rows ends the loop rather than grading from nothing", async () => {
  const run = await withBin(NO_LEGS, () => drive({}));
  assert.equal(run.result.failOpen, true);
  assert.match(run.result.conclusion, /no per-leg rows to grade/);
  assert.equal(run.escalations.length, 0);
});

// ── the structure: report-only, no agents, no model calls, no reads ──────────

await check("the source holds the report-only laws the plan greps for", () => {
  assert.ok(
    source.includes("// media-loops: this workflow has no gen1_raw write path"),
    "the no-write-path marker must live as its own line",
  );
  // The loop never writes the store, the config, or the tag: no file write
  // surface is touched at all (the drive above proves it by throwing on
  // files.read and artifact.file), and the source carries no process-spawn or
  // model-call verb. ("spawns no agents" in the docstring is the law's own
  // prose — the greps below are for the verbs that would break it.)
  for (const forbidden of ["files.write", "files.edit", "world.run(", "artifact.file("]) {
    assert.ok(!source.includes(forbidden), `the source must not contain ${forbidden}`);
  }
  for (const forbidden of ["chatCompletion", ".ask<", "child_process", "execFile"]) {
    assert.ok(!source.includes(forbidden), `the source must not contain ${forbidden}`);
  }
});

await check("the loop spawns no agents and makes no model call (by execution)", async () => {
  const run = await withBin(CLEARS, () => drive({}));
  // Every phase the run passed through is a named one — the loop's own shape,
  // not an agent's.
  assert.deepEqual(run.phases, [
    "Round-trip the pinned fixture through every live leg",
    "Grade each leg against the floor",
    "Name the promotion evidence; the owner decides",
  ]);
  // The reports are the graded legs, the artifact, and the one escalation —
  // nothing else was asked of the surface.
  assert.equal(run.reports.filter((r) => r.provider !== undefined).length, 3);
  assert.equal(run.artifacts.length, 1);
});

// ── the tally ────────────────────────────────────────────────────────────────

fs.rmSync(yard, { recursive: true, force: true });
if (failures.length) {
  console.log(`  failed: ${failures.join(" | ")}`);
}
console.log(`probe-asr-calibrate: ${pass} cases pass, ${failures.length} fail`);
process.exitCode = failures.length ? 1 : 0;
