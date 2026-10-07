#!/usr/bin/env node
/**
 * render-watch's shadow law, executed and held (C7).
 *
 * The loop's promise: it counts, it never skips, and no visual judge is ever
 * touched. Proven in layers:
 *   1. the surface — semantic() against a stub CLI answering the exact
 *      index/nn calls the workflow makes, including a 1.0000 hit and a
 *      near-match, the two verdict shapes;
 *   2. the structure — the workflow source contains no agent spawn and no
 *      judge/dispatch invocation at all: skipping is not a guarded branch
 *      here, it is unwritable in this file; the deliverable fields are
 *      counts;
 *   3. the fail-open — an unavailable CLI surfaces the pinned refusal shape
 *      the loop renders verbatim.
 *
 *   node tools/probe-render-watch-shadow.mjs
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

const yard = fs.mkdtempSync(path.join(os.tmpdir(), "render-watch-probe-"));
const STUB = path.join(yard, "dd-stub");
fs.writeFileSync(
  STUB,
  [
    `#!/usr/bin/env node`,
    `const cmd = process.argv[2];`,
    `const argv = process.argv.slice(3);`,
    `if (cmd === "semantic-index") {`,
    `  const i = argv.indexOf("--inputs");`,
    `  process.stdout.write(JSON.stringify({ op: "semantic-index", ok: true, inputs_mode: true, corpus: argv[argv.indexOf("--corpus")+1], indexed: 3, model: "google/embeddinggemma-2", provider: "st-worker" }) + "\\n");`,
    `} else if (cmd === "semantic-nn") {`,
    `  const f = argv[argv.indexOf("--file")+1] ?? "";`,
    `  const score = f.includes("unchanged") ? 1.0 : 0.8521;`,
    `  process.stdout.write(JSON.stringify({ op: "semantic-nn", ok: true, corpus: "renders-baseline", k: 1, hits: 1 }) + "\\n");`,
    `  process.stdout.write(JSON.stringify({ key: "k" + score, score, path: f }) + "\\n");`,
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

await check("surface: the wave indexes through the exact inputs-mode call", async () => {
  const r = await withBin(STUB, () => semantic("semantic-index", { corpus: "renders-current", inputs: "/wave" }, {}));
  assert.equal(r.ok, true, r.reason);
  const summary = r.rows.find((row) => row.op === "semantic-index");
  assert.equal(summary.indexed, 3);
  assert.equal(summary.provider, "st-worker");
});
await check("surface: a 1.0000 baseline match and a near-match both parse", async () => {
  for (const [file, want] of [["wave/unchanged.png", 1.0], ["wave/changed.png", 0.8521]]) {
    const r = await withBin(STUB, () => semantic("semantic-nn", { corpus: "renders-baseline", file, k: "1" }, {}));
    assert.equal(r.ok, true, r.reason);
    const hit = r.rows.find((row) => row.key);
    assert.equal(Number(hit.score), want);
  }
});
await check("fail-open: an absent CLI is a refusal, not an error", async () => {
  const r = await withBin(path.join(yard, "nope"), () => semantic("semantic-index", { corpus: "c", inputs: "/wave" }, {}));
  assert.equal(r.ok, false);
  assert.match(r.reason, /dev-decisions not installed/);
});

await check("structure: the loop spawns no agent and touches no judge", () => {
  const src = fs.readFileSync(path.join(engineDir, "workflows", "render-watch.ts"), "utf8");
  assert.ok(!src.includes("agent("), "render-watch must not spawn agents — it is a counting loop");
  assert.ok(!src.includes("runWorkflow"), "render-watch must not dispatch workflows — reporting is its whole effect");
  const escalates = src.match(/await escalate\(/g) ?? [];
  assert.equal(escalates.length, 1, "the only escalation is the baseline promotion");
  assert.match(src, /promote this wave to baseline\?/, "the escalation's question is the promotion");
  assert.match(src, /shadow: true/, "the result is marked shadow");
  assert.match(src, /SHADOW RESULT/, "the counts are reported as the deliverable");
});
await check("structure: the deliverable is counts, and the plan's shadow law is in the file", () => {
  const src = fs.readFileSync(path.join(engineDir, "workflows", "render-watch.ts"), "utf8");
  for (const field of ["wouldSkip", "dispatchNeeded", "compared"]) {
    assert.ok(src.includes(field), `the result must carry ${field}`);
  }
  assert.match(src, /nothing was skipped and no judge was touched/i);
});

fs.rmSync(yard, { recursive: true, force: true });
if (failures.length) {
  console.log(`  failed: ${failures.join(" | ")}`);
}
console.log(`probe-render-watch-shadow: ${pass} checks pass, ${failures.length} fail`);
process.exitCode = failures.length ? 1 : 0;
