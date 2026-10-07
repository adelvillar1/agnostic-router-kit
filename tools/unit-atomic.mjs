#!/usr/bin/env node
/**
 * The atomic writer's contract, proven on ALL THREE twins (router/, lib/,
 * lib/workflow/) — they exist once per vendor boundary and this is what keeps
 * them identical. Cases: the requested mode lands on the renamed file (never
 * world-readable, even for an instant), no temp siblings survive, a failed
 * write throws without destroying the previous file or leaving debris, and
 * IfChanged skips an identical write.
 *
 * Usage: node tools/unit-atomic.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TWINS = [
  ["router/atomic.mjs", "../router/atomic.mjs"],
  ["lib/atomic.mjs", "../lib/atomic.mjs"],
  ["lib/workflow/atomic.mjs", "../lib/workflow/atomic.mjs"],
];

let passed = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "unit-atomic-"));
const noTmpLeft = (dir) => fs.readdirSync(dir).filter((f) => f.includes(".tmp-")).length === 0;

for (const [label, spec] of TWINS) {
  const { writeFileAtomic, writeFileAtomicIfChanged } = await import(spec);
  console.log(`\n${label}`);

  {
    const dir = scratch();
    const f = path.join(dir, "state.json");
    writeFileAtomic(f, JSON.stringify({ ok: 1 }) + "\n", { mode: 0o600 });
    const st = fs.statSync(f);
    ok("the content lands", fs.readFileSync(f, "utf8") === JSON.stringify({ ok: 1 }) + "\n");
    ok("the requested mode lands on the renamed file (never briefly world-readable)", (st.mode & 0o777) === 0o600, (st.mode & 0o777).toString(8));
    ok("no temp sibling survives", noTmpLeft(dir), fs.readdirSync(dir).join(","));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  {
    const dir = scratch();
    const f = path.join(dir, "cache.bin");
    ok("IfChanged writes when different", writeFileAtomicIfChanged(f, "v1") === true);
    ok("IfChanged skips an identical write", writeFileAtomicIfChanged(f, "v1") === false);
    ok("IfChanged writes when it changes back", writeFileAtomicIfChanged(f, "v2") === true && fs.readFileSync(f, "utf8") === "v2");
    fs.rmSync(dir, { recursive: true, force: true });
  }

  {
    const dir = scratch();
    const blocker = path.join(dir, "occupied");
    fs.mkdirSync(blocker); // a directory where the rename wants to put a file
    let threw = false;
    try {
      writeFileAtomic(blocker, "nope");
    } catch {
      threw = true;
    }
    ok("a failed write throws", threw);
    ok("the previous file (here: the blocker) is untouched", fs.statSync(blocker).isDirectory());
    ok("no temp debris after a failed write", noTmpLeft(dir), fs.readdirSync(dir).join(","));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nunit-atomic: ${passed} cases pass across ${TWINS.length} twins, ${failures.length} fail`);
if (failures.length) {
  console.log(`failed: ${failures.join("; ")}`);
  process.exit(1);
}
