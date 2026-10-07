#!/usr/bin/env node
/**
 * The review-sweep semantic dedup head, executed — the C6-precedent standard:
 * drive the real pieces and count, never review-only.
 *
 * Layers proven here, in order:
 *   1. the surface — semantic() against a stub DEV_DECISIONS_BIN that answers
 *      semantic-index / semantic-nn with fixture JSON lines, the exact call
 *      shape the sweep makes;
 *   2. the rule — repeatFromRows() (the single source the workflow binds as
 *      world.repeatFromRows) executed over planted rows: the repeat fires,
 *      the below-threshold neighbor does not, a path-less or empty answer
 *      never invents one;
 *   3. the producer — record-findings-index.mjs run end-to-end on a fixture
 *      JSONL: per-finding files with disposition lines, malformed lines
 *      counted and skipped;
 *   4. the workflow's structure — source assertions that only non-repeats
 *      reach the confirm gate and that repeats land in the report annotated,
 *      never dropped.
 *
 *   node tools/probe-sweep-semantic-dedup.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const engineDir = path.resolve(import.meta.dirname, "..");
const { semantic, repeatFromRows } = await import(path.join(engineDir, "lib", "workflow", "services.mjs"));

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

// ── 1. the surface, against a stub CLI ──────────────────────────────────────

const yard = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-dedup-probe-"));
const STUB = path.join(yard, "dd-stub");
fs.writeFileSync(
  STUB,
  [
    `#!/usr/bin/env node`,
    `const cmd = process.argv[2];`,
    `if (cmd === "semantic-index") {`,
    `  process.stdout.write(JSON.stringify({ op: "semantic-index", ok: true, corpus: "findings", indexed: 12 }) + "\\n");`,
    `} else if (cmd === "semantic-nn") {`,
    `  process.stdout.write(JSON.stringify({ op: "semantic-nn", ok: true, corpus: "findings", k: 1, hits: 1 }) + "\\n");`,
    `  process.stdout.write(JSON.stringify({ key: "abc123", score: 0.93, path: "/corpus/f-001.txt", graded: [] }) + "\\n");`,
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

await check("surface: semantic-index answers the sweep's exact call", async () => {
  const r = await withBin(STUB, () => semantic("semantic-index", { corpus: "findings" }, {}));
  assert.equal(r.ok, true, r.reason);
  const summary = r.rows.find((row) => row.op === "semantic-index");
  assert.equal(summary.indexed, 12);
});
await check("surface: semantic-nn rows parse into a repeat through the real rule", async () => {
  const r = await withBin(STUB, () => semantic("semantic-nn", { corpus: "findings", text: "same old bug", k: "1" }, {}));
  assert.equal(r.ok, true, r.reason);
  const hit = repeatFromRows(r.rows, { threshold: 0.9 });
  assert.ok(hit, "the planted 0.93 neighbor must be a repeat");
  assert.equal(hit.path, "/corpus/f-001.txt");
  assert.ok(hit.score >= 0.9);
});

// ── 2. the rule, executed over planted rows ─────────────────────────────────

await check("rule: below threshold is not a repeat", () => {
  const rows = [{ op: "semantic-nn", ok: true }, { key: "k", score: 0.74, path: "/c/f.txt" }];
  assert.equal(repeatFromRows(rows, { threshold: 0.9 }), null);
});
await check("rule: a hit without a path is never a repeat", () => {
  const rows = [{ key: "k", score: 0.99 }];
  assert.equal(repeatFromRows(rows, { threshold: 0.9 }), null);
});
await check("rule: empty or shapeless rows are not a repeat", () => {
  assert.equal(repeatFromRows([], { threshold: 0.9 }), null);
  assert.equal(repeatFromRows([{ op: "semantic-nn", ok: true }], { threshold: 0.9 }), null);
  assert.equal(repeatFromRows(null, { threshold: 0.9 }), null);
});
await check("rule: the best of several hits wins, threshold applies to it", () => {
  const rows = [
    { key: "a", score: 0.91, path: "/c/a.txt" },
    { key: "b", score: 0.96, path: "/c/b.txt" },
  ];
  const hit = repeatFromRows(rows, { threshold: 0.9 });
  assert.equal(hit.key, "b");
  assert.equal(repeatFromRows(rows, { threshold: 0.97 }), null);
});

// ── 3. the producer, end-to-end ─────────────────────────────────────────────

await check("producer: findings JSONL becomes per-finding files with disposition lines", () => {
  const from = path.join(yard, "findings.jsonl");
  const out = path.join(yard, "corpus");
  fs.writeFileSync(
    from,
    [
      JSON.stringify({ id: "f-001", what: "off-by-one in the loop", where: "lib/x.mjs", severity: "high", disposition: "fixed" }),
      JSON.stringify({ id: "f-002", what: "unbounded retry loop", where: "router/y.mjs", severity: "medium" }),
      `not json at all`,
      JSON.stringify({ what: "no id" }),
    ].join("\n"),
  );
  const outJson = execFileSync("node", [path.join(engineDir, "tools", "record-findings-index.mjs"), from, out], {
    encoding: "utf8",
  });
  const summary = JSON.parse(outJson.trim());
  assert.equal(summary.written, 2, "two well-formed findings");
  assert.equal(summary.skipped, 2, "a malformed line and an id-less line are counted, never guessed");
  const f1 = fs.readFileSync(path.join(out, "f-001.txt"), "utf8");
  assert.match(f1, /^off-by-one in the loop\n/);
  assert.match(f1, /disposition=fixed/);
  const f2 = fs.readFileSync(path.join(out, "f-002.txt"), "utf8");
  assert.match(f2, /disposition=open/, "a finding with no disposition records open");
});

// ── 4. the workflow's structure — repeats never reach the gate ──────────────

await check("structure: only non-repeats reach the confirm gate", () => {
  const src = fs.readFileSync(path.join(engineDir, "workflows", "review-sweep.ts"), "utf8");
  assert.match(src, /const toConfirm = annotated\.filter\(\(a\) => !a\.repeat\)/, "the gate takes the non-repeat list");
  assert.match(src, /confirmed: Finding\[\] = await Promise\.all\(\s*\n\s*toConfirm\.map/, "confirmers run over toConfirm, not the raw findings");
  assert.match(src, /status: "repeat"/, "repeats land in the report as repeats");
  assert.match(src, /repeatFromRows\(nn\.rows/, "the rule comes from the bound surface, one source of truth");
  assert.match(src, /threshold: REPEAT_SCORE/, "the threshold is named once and journaled");
  assert.ok(src.indexOf("findings corpus unavailable") < src.indexOf("phase(\"Confirm"), "fail-open precedes the gate");
});

// ── the tally ────────────────────────────────────────────────────────────────

fs.rmSync(yard, { recursive: true, force: true });
if (failures.length) {
  console.log(`  failed: ${failures.join(" | ")}`);
}
console.log(`probe-sweep-semantic-dedup: ${pass} checks pass, ${failures.length} fail`);
process.exitCode = failures.length ? 1 : 0;
