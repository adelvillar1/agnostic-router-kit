#!/usr/bin/env node
/**
 * The verification runner: `npm test`. Runs every suite in tools/ by glob —
 * test-*.mjs, unit-*.mjs, probe-*.mjs — sequentially (each probe owns a fixed
 * 127.0.0.1 port, so sequential is the collision guard), inheriting stdio so
 * each suite's own ✓/✗ lines read as-is. A new suite file auto-enrolls; there
 * is no hand list to go stale. tools/visual/ is its own Playwright package
 * and stays a deliberate manual run.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const files = fs
  .readdirSync(TOOLS)
  .filter((f) => /^(test|unit|probe)-.+\.mjs$/.test(f))
  .sort();

if (!files.length) {
  console.error("run-probes: no suites found in tools/");
  process.exit(1);
}

const failed = [];
const results = []; // one per suite, for the outcomes table below
for (const f of files) {
  console.log(`\n── ${f} ${"─".repeat(Math.max(4, 62 - f.length))}`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(TOOLS, f)], { stdio: "inherit" });
  const ms = Date.now() - t0;
  const secs = (ms / 1000).toFixed(1);
  results.push({ suite: f, ok: r.status === 0, ms });
  if (r.status === 0) console.log(`── ${f} ok (${secs}s)`);
  else {
    failed.push(f);
    console.log(`── ${f} FAILED (${secs}s)`);
  }
}

console.log(`\n${files.length} suites, ${failed.length} failed${failed.length ? `: ${failed.join(", ")}` : ""}`);

// Outcome log for the tabular lane: one row per suite per run, appended to
// dev-decisions' probe-outcomes table — an event log, never deduped; the
// flake-watch loop reads its history to score per-suite flakiness. The
// counts are suite-level (a suite is one verify or one fail — the runner
// inherits stdio and does not parse the checks inside). A failed append is
// a byproduct, not a gate: it must never fail the run.
try {
  const table = path.join(os.homedir(), ".local", "share", "dev-decisions", "tables", "probe-outcomes.csv");
  fs.mkdirSync(path.dirname(table), { recursive: true });
  const runTs = new Date().toISOString();
  const lines = results.map((r) => `${runTs},${r.suite},${r.ok ? 1 : 0},${r.ok ? 0 : 1},${r.ms}`);
  if (!fs.existsSync(table) || fs.statSync(table).size === 0) lines.unshift("ts,suite,passed,failed,ms");
  fs.appendFileSync(table, lines.join("\n") + "\n");
} catch (e) {
  console.error(`run-probes: could not append the probe-outcomes table (${e.message}) — the run stands`);
}

process.exit(failed.length ? 1 : 0);
