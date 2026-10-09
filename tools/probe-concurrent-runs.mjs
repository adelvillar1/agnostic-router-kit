#!/usr/bin/env node
/**
 * Two runs alive in one process keep their own surface (the router's run API
 * spawns them concurrently, so this is the shape that surface produces).
 *
 * The plane used to bind a run's surface — `phase`, `report`, `world`, `args` —
 * as process globals before importing the run's module. One run per process is
 * fine that way; two are not. Whichever run bound last won every free name, so
 * the first run's later `phase(...)`/`report(...)`/`world.media(...)` resolved
 * to the second run's closures: its journal lines landed in the other run's
 * run.jsonl, and its capability check read the other run's grants. Observed
 * live: a media-budget-watch run holding the media grant was refused with
 * "capability not granted in this run: media" by an asr-calibrate run started
 * 31ms later with no grants at all, and the budget loop's own journal lines
 * turned up inside the asr run's directory.
 *
 * The surface now rides into the module as an argument. This probe drives the
 * REAL engine (`runWorkflow`) with two workflows at once and asserts each run
 * reports its own identity, its own grants and its own journal — the three
 * things the global binding crossed.
 *
 *   node tools/probe-concurrent-runs.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const engineDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { runWorkflow } = await import(path.join(engineDir, "lib", "workflow", "engine.mjs"));

let pass = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok — ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL — ${name}: ${String(e?.message ?? e).slice(0, 400)}`);
  }
}

const yard = fs.mkdtempSync(path.join(os.tmpdir(), "concurrent-runs-probe-"));
const wfDir = path.join(yard, "workflows");
fs.mkdirSync(wfDir, { recursive: true });

/** One run's body: name itself, hold the process open, then read the surface. */
function workflow(id) {
  const file = path.join(wfDir, `${id}.ts`);
  fs.writeFileSync(
    file,
    `/* workflow
description: "Probe: a run that names itself, waits, then reads its own surface."
whenToUse: Probe only — never a real task.
*/
phase("${id} at work");
await new Promise((r) => setTimeout(r, 60));
const caps = world.grants().caps;
report({ who: "${id}", caps });
return { who: "${id}", caps };
`,
  );
  return file;
}

const journalOf = (runDir) =>
  fs
    .readFileSync(path.join(runDir, "run.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

const withEnv = (vars, fn) => {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

// The one holding a grant, started first so the other binds the surface while
// it is still between its phase and its report — the window the global binding
// crossed.
const holder = workflow("holder");
const plain = workflow("plain");

await check("concurrent: each run reports its own identity and its own grants", async () => {
  const memory = path.join(yard, "memory.jsonl");
  const [a, b] = await Promise.all([
    withEnv({ MEMORY_FILE_PATH: memory }, () =>
      runWorkflow(holder, { grants: "media", workdir: yard, outDir: path.join(yard, "run-holder") }),
    ),
    // A tick later, not after: the second run must bind its surface while the
    // first is still running, which is what made the globals cross.
    await new Promise((r) => setTimeout(r, 15)).then(() =>
      withEnv({ MEMORY_FILE_PATH: memory }, () =>
        runWorkflow(plain, { workdir: yard, outDir: path.join(yard, "run-plain") }),
      ),
    ),
  ]);
  assert.equal(a.summary.ok, true, `holder run failed: ${a.summary.error}\n${a.summary.stack ?? ""}`);
  assert.equal(b.summary.ok, true, `plain run failed: ${b.summary.error}\n${b.summary.stack ?? ""}`);
  assert.equal(a.result.who, "holder", "the granted run read another run's surface");
  assert.equal(b.result.who, "plain", "the ungranted run read another run's surface");
  assert.ok(a.result.caps.split(", ").includes("media"), `holder lost its grant: ${a.result.caps}`);
  assert.ok(!b.result.caps.split(", ").includes("media"), `plain gained a grant it never asked for: ${b.result.caps}`);
});

await check("concurrent: each journal holds only its own lines", async () => {
  const holderLines = journalOf(path.join(yard, "run-holder"));
  const plainLines = journalOf(path.join(yard, "run-plain"));
  // One run-start, one phase, one report per run — no line from the other.
  assert.equal(holderLines.filter((l) => l.kind === "run-start").length, 1);
  assert.equal(plainLines.filter((l) => l.kind === "run-start").length, 1);
  for (const l of holderLines) {
    if (l.name !== undefined) assert.equal(l.name, "holder", `the holder's journal names ${l.name}: ${JSON.stringify(l).slice(0, 120)}`);
    if (l.kind === "phase") assert.match(String(l.phase), /^holder/, `the holder's journal carries a ${l.phase} phase`);
    if (l.kind === "report") assert.equal(l.item.who, "holder");
  }
  for (const l of plainLines) {
    if (l.name !== undefined) assert.equal(l.name, "plain", `the plain run's journal names ${l.name}: ${JSON.stringify(l).slice(0, 120)}`);
    if (l.kind === "phase") assert.match(String(l.phase), /^plain/, `the plain run's journal carries a ${l.phase} phase`);
    if (l.kind === "report") assert.equal(l.item.who, "plain");
  }
  assert.equal(holderLines.filter((l) => l.kind === "report").length, 1);
  assert.equal(plainLines.filter((l) => l.kind === "report").length, 1);
});

await check("sequential: the same pair, one after the other, reads its own surface", async () => {
  const memory = path.join(yard, "memory-2.jsonl");
  const a = await withEnv({ MEMORY_FILE_PATH: memory }, () =>
    runWorkflow(holder, { grants: "media", workdir: yard, outDir: path.join(yard, "run-holder-seq") }),
  );
  const b = await withEnv({ MEMORY_FILE_PATH: memory }, () =>
    runWorkflow(plain, { workdir: yard, outDir: path.join(yard, "run-plain-seq") }),
  );
  assert.equal(a.result.who, "holder");
  assert.equal(b.result.who, "plain");
  assert.ok(a.result.caps.split(", ").includes("media"));
  assert.ok(!b.result.caps.split(", ").includes("media"));
});

// ── the tally ────────────────────────────────────────────────────────────────

fs.rmSync(yard, { recursive: true, force: true });
if (failures.length) {
  console.log(`  failed: ${failures.join(" | ")}`);
}
console.log(`probe-concurrent-runs: ${pass} cases pass, ${failures.length} fail`);
process.exitCode = failures.length ? 1 : 0;
