#!/usr/bin/env node
/**
 * dupe-watch and the router-eval neighbor pre-pass, executed + structured
 * (C4/C5).
 *
 * dupe-watch: the surface calls driven against a stub CLI answering with the
 * lane's machine shapes — an index summary, then a dedup payload planted with
 * one divergent pair and one agreeing pair; the pair-classification rule is
 * the workflow's own reading, so the probe asserts the shapes the rule reads
 * and the workflow's structure holds the report-only law (no write path in
 * the file, the escalation is the divergent pair's). Plus a live shape check:
 * the real CLI's dedup answers in exactly these shapes (offline store, no
 * embedding server needed).
 *
 * router-eval: the pre-pass must be additive — structure greps prove the
 * neighbor context never touches the verdict (grades stay `answer.includes`),
 * the pre-pass degrades by name, and rows carry applied: false.
 *
 *   node tools/probe-semantic-loops.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const engineDir = path.resolve(import.meta.dirname, "..");
const { semantic } = await import(path.join(engineDir, "lib", "workflow", "services.mjs"));

let pass = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok — ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL — ${name}: ${String(e?.message ?? e).slice(0, 240)}`);
  }
}

const yard = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-loops-probe-"));
const STUB = path.join(yard, "dd-stub");
fs.writeFileSync(
  STUB,
  [
    `#!/usr/bin/env node`,
    `const cmd = process.argv[2];`,
    `if (cmd === "semantic-index") {`,
    `  process.stdout.write(JSON.stringify({ op: "semantic-index", ok: true, corpus: "calibration", indexed: 26, rows_skipped: 6483 }) + "\\n");`,
    `} else if (cmd === "semantic-dedup") {`,
    `  process.stdout.write(JSON.stringify({ op: "semantic-dedup", ok: true, corpus: "calibration", pairs: 2, threshold: 0.9 }) + "\\n");`,
    `  process.stdout.write(JSON.stringify({ pair: ["aaa", "bbb"], score: 0.95, ops: ["plan-gate", "plan-gate"], gradedA: [{ label: "correct", task: "plan_gate" }], gradedB: [{ label: "wrong", task: "plan_gate" }] }) + "\\n");`,
    `  process.stdout.write(JSON.stringify({ pair: ["ccc", "ddd"], score: 0.99, ops: ["evidence-gate", "evidence-gate"], gradedA: [{ label: "supported", task: "evidence_gate" }], gradedB: [{ label: "supported", task: "evidence_gate" }] }) + "\\n");`,
    `} else if (cmd === "semantic-nn") {`,
    `  process.stdout.write(JSON.stringify({ op: "semantic-nn", ok: true, corpus: "calibration", k: 3, hits: 2 }) + "\\n");`,
    `  process.stdout.write(JSON.stringify({ key: "k1", score: 0.71, op: "plan-gate", graded: [{ label: "correct", task: "plan_gate" }] }) + "\\n");`,
    `} else { process.exit(2); }`,
    ``,
  ].join("\n"),
  { mode: 0o755 },
);
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

// ── dupe-watch: the surface, the payload shapes, the law ────────────────────

await check("dupe-watch surface: index then dedup, both rows parse", async () => {
  const idx = await withBin(STUB, () => semantic("semantic-index", { corpus: "calibration" }, {}));
  assert.equal(idx.ok, true, idx.reason);
  const summary = idx.rows.find((r) => r.op === "semantic-index");
  assert.equal(summary.indexed, 26);
  const dedup = await withBin(STUB, () => semantic("semantic-dedup", { corpus: "calibration", limit: "20" }, {}));
  assert.equal(dedup.ok, true, dedup.reason);
  const pairs = dedup.rows.filter((r) => Array.isArray(r.pair));
  assert.equal(pairs.length, 2);
  // The workflow's divergence reading: label sets per side.
  const labels = (g) => (g ?? []).map((x) => x.label).sort();
  const divergent = pairs.filter((p) => JSON.stringify(labels(p.gradedA)) !== JSON.stringify(labels(p.gradedB)));
  const agreeing = pairs.filter((p) => JSON.stringify(labels(p.gradedA)) === JSON.stringify(labels(p.gradedB)) && p.gradedA?.length);
  assert.equal(divergent.length, 1, "the planted divergent pair");
  assert.equal(divergent[0].pair[0], "aaa");
  assert.equal(agreeing.length, 1, "the planted agreeing pair");
});
await check("dupe-watch structure: report-only — no write path, the escalation names divergence", () => {
  const src = fs.readFileSync(path.join(engineDir, "workflows", "dupe-watch.ts"), "utf8");
  assert.ok(!/files\.write|writeFile|fs\.write|appendFile|\.write\(/.test(src), "the loop writes nothing");
  const escalates = src.match(/await escalate\(/g) ?? [];
  assert.equal(escalates.length, 1, "one escalation: the divergent pair's");
  assert.match(src, /DIVERGENT grades/, "the escalation names the divergence");
  assert.match(src, /mergeProposals/, "agreeing pairs render merge proposals");
  assert.match(src, /never applied|nothing merges|writes nothing/i, "the report-only law is stated in the file");
});
await check("dupe-watch structure: the surrogate-text caveat is in the file", () => {
  const src = fs.readFileSync(path.join(engineDir, "workflows", "dupe-watch.ts"), "utf8");
  assert.match(src, /SURROGATE text|surrogate text/, "the lead-not-fact caveat is stated where the pairs render");
});

// ── router-eval: the pre-pass is additive ────────────────────────────────────

await check("router-eval structure: neighbors are context, never the grade", () => {
  const src = fs.readFileSync(path.join(engineDir, "workflows", "router-eval.ts"), "utf8");
  assert.match(src, /const hit = answer\.includes\(task\.expect\)/, "grading stays the mechanical substring check");
  assert.ok(src.indexOf("neighborNotes") > -1, "the pre-pass exists");
  assert.ok(!/verdict.*neighbor|neighbor.*verdict\s*=/.test(src), "no verdict line reads the neighbors");
  assert.match(src, /applied: false/, "pre-pass rows are journaled applied: false");
  assert.match(src, /pre-pass skipped, eval unchanged/, "degrades by name");
});
await check("router-eval surface: the nn call shape the pre-pass makes parses", async () => {
  const r = await withBin(STUB, () => semantic("semantic-nn", { corpus: "calibration", text: "golden task text", k: "3" }, {}));
  assert.equal(r.ok, true, r.reason);
  const hits = r.rows.filter((row) => row && row.key && row.score !== undefined);
  assert.equal(hits.length, 1);
  assert.ok(Array.isArray(hits[0].graded), "graded context rides the hit");
});

fs.rmSync(yard, { recursive: true, force: true });
if (failures.length) {
  console.log(`  failed: ${failures.join(" | ")}`);
}
console.log(`probe-semantic-loops: ${pass} checks pass, ${failures.length} fail`);
process.exitCode = failures.length ? 1 : 0;
