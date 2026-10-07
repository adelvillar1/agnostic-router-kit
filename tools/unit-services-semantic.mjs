#!/usr/bin/env node
/**
 * The semantic service, entirely without the real CLI.
 *
 * semantic() is the tabular surface cloned one lane over — external binary,
 * flag flattener, JSON-lines parsing, absence-is-a-refusal — with two pinned
 * differences this probe exists to hold: `--json` is injected on every call
 * (the lane's machine contract; the human prose default is never parsed), and
 * the allowlist speaks exactly the three semantic verbs. The stub yard is the
 * tabular probe's: tiny node scripts standing in for dev-decisions, pointed
 * at through DEV_DECISIONS_BIN, so every path — happy, noisy, slow, failing,
 * absent — runs hermetically on any machine. Nothing here talks to a real
 * dev-decisions install, an embedding server, or any model; the grant
 * assertions read tools.mjs directly.
 *
 *   node tools/unit-services-semantic.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const engineDir = path.resolve(import.meta.dirname, "..");
const { semantic, SEMANTIC_TIMEOUT_MS } = await import(path.join(engineDir, "lib", "workflow", "services.mjs"));
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

const yard = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-probe-"));
function stub(name, body) {
  const p = path.join(yard, name);
  fs.writeFileSync(p, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return p;
}

// Echoes its argv — the proof that --json rides first on every call and that
// args flatten behind it — plus two fixture rows shaped like the lane's
// machine output (a summary object, then per-hit objects).
const ECHO_STUB = stub(
  "echo-rows",
  [
    `process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");`,
    `process.stdout.write(JSON.stringify({ op: "semantic-nn", ok: true, k: 2, hits: 1 }) + "\\n");`,
    `process.stdout.write(JSON.stringify({ key: "k0", score: 0.99, graded: [] }) + "\\n");`,
  ].join("\n")
);
const SILENT_STUB = stub("silent", ``);
const NOISY_STUB = stub(
  "noisy",
  [
    `console.log("embedding corpus via llama-server ...");`,
    `console.log(JSON.stringify({ op: "semantic-index", ok: true, indexed: 3 }));`,
    `console.log("  note: EVAL-ONLY lane");`,
  ].join("\n")
);
const SLOW_STUB = stub("slow", `setTimeout(() => console.log("{}"), 30_000);`);
const FAILING_STUB = stub("failing", `console.error("sem1 not importable — set DEV_DECISIONS_SEM1_PATH"); process.exit(3);`);

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

await check("semantic: --json rides first on every call, rows parse whole", async () => {
  const r = await withBin(ECHO_STUB, () => semantic("semantic-nn", { text: "quota band drift", k: 2 }, {}));
  assert.equal(r.ok, true, `refused: ${r.reason}`);
  assert.equal(r.command, "semantic-nn");
  assert.deepEqual(r.rows[0], { argv: ["semantic-nn", "--json", "--text", "quota band drift", "--k", "2"] });
  assert.deepEqual(r.rows[1], { op: "semantic-nn", ok: true, k: 2, hits: 1 });
  assert.deepEqual(r.rows[2], { key: "k0", score: 0.99, graded: [] });
});
await check("semantic: corpus and flag arrays flatten behind the injected --json", async () => {
  const r = await withBin(ECHO_STUB, () =>
    semantic("semantic-index", { corpus: "renders", inputs: "/tmp/wave", logDir: null }, {})
  );
  assert.equal(r.ok, true, `refused: ${r.reason}`);
  assert.deepEqual(r.rows[0], {
    argv: ["semantic-index", "--json", "--corpus", "renders", "--inputs", "/tmp/wave"],
  });
});
await check("semantic: empty stdout is an empty row set, not an error", async () => {
  const r = await withBin(SILENT_STUB, () => semantic("semantic-dedup", {}, {}));
  assert.equal(r.ok, true, `refused: ${r.reason}`);
  assert.deepEqual(r.rows, []);
});
await check("semantic: non-JSON chatter is skipped, JSON rows kept", async () => {
  const r = await withBin(NOISY_STUB, () => semantic("semantic-index", {}, {}));
  assert.equal(r.ok, true, `refused: ${r.reason}`);
  assert.deepEqual(r.rows, [{ op: "semantic-index", ok: true, indexed: 3 }]);
});

// ── the refusals ─────────────────────────────────────────────────────────────

await check("semantic: an absent CLI is the pinned semantic sentence", async () => {
  const r = await withBin(path.join(yard, "no-such-bin"), () => semantic("semantic-index", {}, {}));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "dev-decisions not installed — the semantic grant needs the dev-decisions CLI with sem1");
});
await check("semantic: an off-list command is refused, naming what ships", async () => {
  const r = await withBin(ECHO_STUB, () => semantic("embed", {}, {}));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unknown semantic command: embed (shipped: semantic-index, semantic-dedup, semantic-nn)");
});
await check("semantic: the gate verbs stay out of the surface", async () => {
  const r = await withBin(ECHO_STUB, () => semantic("docs-gate", { viaSemantic: true }, {}));
  assert.equal(r.ok, false);
  assert.match(r.reason, /^unknown semantic command: docs-gate/);
});
await check("semantic: a non-object args is refused before any process runs", async () => {
  const r = await withBin(ECHO_STUB, () => semantic("semantic-nn", "quota text", {}));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "semantic args must be an object of CLI flags");
});
await check("semantic: a child past its timeout is killed, and the refusal names the ms", async () => {
  const t0 = Date.now();
  const r = await withBin(SLOW_STUB, () => semantic("semantic-index", {}, { timeoutMs: 500 }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /exceeded 500ms wall clock — child killed/);
  assert.ok(Date.now() - t0 < 5000, "the kill should fire near the 500ms cap, not the stub's own sleep");
});
await check("semantic: a non-zero exit carries the stderr slice", async () => {
  const r = await withBin(FAILING_STUB, () => semantic("semantic-nn", {}, {}));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "semantic semantic-nn failed (exit 3): sem1 not importable — set DEV_DECISIONS_SEM1_PATH");
});
await check("semantic: the default timeout is the batch budget, not a round-trip one", () => {
  assert.equal(SEMANTIC_TIMEOUT_MS, 120_000);
});

// ── the grant: default-off, known, and never pre-granted ─────────────────────

await check("grant: semantic is a known capability and default-off", () => {
  assert.ok(CAPABILITIES.semantic, "CAPABILITIES must declare semantic");
  assert.equal(CAPABILITIES.semantic.granted, false);
});
await check("grant: resolveGrants({}) holds no semantic", () => {
  const g = resolveGrants({});
  assert.ok(!g.held.has("semantic"), "defaults must not include semantic");
  assert.ok(!g.summary().includes("semantic"));
});
await check("grant: --grant semantic is accepted, so a run can opt in", () => {
  const g = resolveGrants({ grants: "semantic" });
  assert.ok(g.held.has("semantic"));
});

// ── the tally ────────────────────────────────────────────────────────────────

fs.rmSync(yard, { recursive: true, force: true });
if (failures.length) {
  console.log(`  failed: ${failures.join(" | ")}`);
}
console.log(`unit-services-semantic: ${pass} cases pass, ${failures.length} fail`);
process.exitCode = failures.length ? 1 : 0;
