#!/usr/bin/env node
/**
 * The tabular service, entirely without the real CLI.
 *
 * tabular() hangs off an external binary (dev-decisions), the way
 * browserFetch hangs off moli — but unlike the browser suite this one needs
 * no binary at all to be honest: the service reads DEV_DECISIONS_BIN on every
 * call, so the probe writes tiny fixture stub scripts (node scripts that emit
 * fixture JSON lines) into its own tmp dir and points the env var at them.
 * Every path — happy, empty, noisy, slow, failing, absent — runs hermetically
 * on any machine. Nothing here talks to a real dev-decisions install or any
 * model; the grant assertion reads tools.mjs directly.
 *
 *   node tools/unit-services-tabular.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const engineDir = path.resolve(import.meta.dirname, "..");
const { tabular, TABULAR_TIMEOUT_MS } = await import(path.join(engineDir, "lib", "workflow", "services.mjs"));
const { CAPABILITIES, resolveGrants } = await import(path.join(engineDir, "lib", "workflow", "tools.mjs"));

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

// ── the stub yard ────────────────────────────────────────────────────────────

/** A tmp dir of executable stub scripts standing in for the dev-decisions CLI. */
const yard = fs.mkdtempSync(path.join(os.tmpdir(), "tabular-probe-"));
/** Write one stub script and hand back its path — DEV_DECISIONS_BIN fodder. */
function stub(name, body) {
  const p = path.join(yard, name);
  fs.writeFileSync(p, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return p;
}

// Echoes what it was invoked as, so argv flattening is proven through a real
// child process, plus one fixture verdict row.
const ECHO_STUB = stub(
  "echo-verdicts",
  [
    `process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");`,
    `process.stdout.write(JSON.stringify({ suite: "auth", flake: 0.13 }) + "\\n");`,
  ].join("\n")
);
// Prints nothing — an empty table is a fine answer, not a failure.
const SILENT_STUB = stub("silent", ``);
// Chatters: a banner line, a blank line, a verdict, a non-JSON progress line,
// another verdict — the parser takes the two rows and skips the rest.
const NOISY_STUB = stub(
  "noisy",
  [
    `console.log("scoring checks table...");`,
    `console.log("");`,
    `console.log(JSON.stringify({ check: "lint", band: [0.1, 0.2] }));`,
    `console.log("warn: cold start");`,
    `console.log(JSON.stringify({ check: "test", band: [0.3, 0.9] }));`,
  ].join("\n")
);
// Sleeps past any sane timeout, so the kill path fires deterministically.
const SLOW_STUB = stub("slow", `setTimeout(() => console.log("{}"), 30_000);`);
// Exits non-zero with something on stderr — a real gate failure's shape.
const FAILING_STUB = stub("failing", `console.error("boom: no bench table for 'quota'"); process.exit(3);`);

/** Run one tabular call with DEV_DECISIONS_BIN pinned, then restore the env. */
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

// ── the happy paths ──────────────────────────────────────────────────────────

await check("tabular: JSON lines parse into rows, shape {ok, command, rows}", async () => {
  const r = await withBin(ECHO_STUB, () => tabular("history-gate", {}, {}));
  assert.equal(r.ok, true, `refused: ${r.reason}`);
  assert.equal(r.command, "history-gate");
  assert.deepEqual(r.rows, [
    { argv: ["history-gate"] },
    { suite: "auth", flake: 0.13 },
  ]);
});
await check("tabular: args flatten to argv — plain keys, bare --flags, repeated arrays", async () => {
  const r = await withBin(ECHO_STUB, () =>
    tabular("override-prior", { table: "x.csv", "--json": true, suite: ["a", "b"], verbose: false }, {})
  );
  assert.equal(r.ok, true, `refused: ${r.reason}`);
  assert.deepEqual(r.rows[0], {
    argv: ["override-prior", "--table", "x.csv", "--json", "--suite", "a", "--suite", "b"],
  });
});
await check("tabular: empty stdout is an empty table, not an error", async () => {
  const r = await withBin(SILENT_STUB, () => tabular("record-runs", {}, {}));
  assert.equal(r.ok, true, `refused: ${r.reason}`);
  assert.deepEqual(r.rows, []);
});
await check("tabular: non-JSON lines are skipped, rows kept whole", async () => {
  const r = await withBin(NOISY_STUB, () => tabular("budget-gate", {}, {}));
  assert.equal(r.ok, true, `refused: ${r.reason}`);
  assert.deepEqual(r.rows, [
    { check: "lint", band: [0.1, 0.2] },
    { check: "test", band: [0.3, 0.9] },
  ]);
});

// ── the refusals ─────────────────────────────────────────────────────────────

await check("tabular: an absent CLI is the pinned install sentence", async () => {
  const r = await withBin(path.join(yard, "no-such-bin"), () => tabular("risk-prior", {}, {}));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "dev-decisions not installed — the tabular grant needs the dev-decisions CLI (see docs)");
});
await check("tabular: an off-list command is refused, naming what ships", async () => {
  const r = await withBin(ECHO_STUB, () => tabular("not-a-verb", {}, {}));
  assert.equal(r.ok, false);
  assert.equal(
    r.reason,
    "unknown tabular command: not-a-verb (shipped: override-prior, record-runs, history-gate, record-bench, budget-gate, risk-prior, fleet-anomaly, triage-issues)"
  );
});
await check("tabular: a non-object args is refused before any process runs", async () => {
  const r = await withBin(ECHO_STUB, () => tabular("record-bench", "quota", {}));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "tabular args must be an object of CLI flags");
});
await check("tabular: a child past its timeout is killed, and the refusal names the ms", async () => {
  const t0 = Date.now();
  const r = await withBin(SLOW_STUB, () => tabular("history-gate", {}, { timeoutMs: 500 }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /exceeded 500ms wall clock — child killed/);
  assert.ok(Date.now() - t0 < 5000, "the kill should fire near the 500ms cap, not the stub's own sleep");
});
await check("tabular: a non-zero exit carries the stderr slice", async () => {
  const r = await withBin(FAILING_STUB, () => tabular("record-bench", {}, {}));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "tabular record-bench failed (exit 3): boom: no bench table for 'quota'");
});
await check("tabular: the default timeout is the batch budget, not a round-trip one", () => {
  assert.equal(TABULAR_TIMEOUT_MS, 120_000);
});

// ── the grant: default-off, known, and never pre-granted ─────────────────────

await check("grant: tabular is a known capability and default-off", () => {
  assert.ok(CAPABILITIES.tabular, "CAPABILITIES must declare tabular");
  assert.equal(CAPABILITIES.tabular.granted, false);
});
await check("grant: resolveGrants({}) holds no tabular", () => {
  const g = resolveGrants({});
  assert.ok(!g.held.has("tabular"), "defaults must not include tabular");
  assert.ok(!g.summary().includes("tabular"));
});
await check("grant: --grant tabular is accepted, so a run can opt in", () => {
  const g = resolveGrants({ grants: "tabular" });
  assert.ok(g.held.has("tabular"));
});

// ── the tally ────────────────────────────────────────────────────────────────

fs.rmSync(yard, { recursive: true, force: true });
if (failures.length) {
  console.log(`  failed: ${failures.join(" | ")}`);
}
console.log(`unit-services-tabular: ${pass} cases pass, ${failures.length} fail`);
process.exitCode = failures.length ? 1 : 0;
