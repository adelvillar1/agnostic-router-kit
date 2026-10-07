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
for (const f of files) {
  console.log(`\n── ${f} ${"─".repeat(Math.max(4, 62 - f.length))}`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(TOOLS, f)], { stdio: "inherit" });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status === 0) console.log(`── ${f} ok (${secs}s)`);
  else {
    failed.push(f);
    console.log(`── ${f} FAILED (${secs}s)`);
  }
}

console.log(`\n${files.length} suites, ${failed.length} failed${failed.length ? `: ${failed.join(", ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
