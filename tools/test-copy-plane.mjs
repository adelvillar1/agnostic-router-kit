#!/usr/bin/env node
/**
 * The plane copy is the one part of `kit apply` that turns the repointed
 * router into a working install, and the real path to it needs a resolvable
 * roster. This drives `copyPlaneRuntime` against a throwaway install and
 * asserts the thing that actually matters: that a module sitting in the
 * installed router directory can resolve `workflow-plane/<module>.mjs`.
 *
 *   node tools/test-copy-plane.mjs [engineDir]
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const engineDir = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, ".."));
const { copyPlaneRuntime } = await import(path.join(engineDir, "lib", "cli.mjs"));

const install = fs.mkdtempSync(path.join(os.tmpdir(), "plane-install-"));
const routerDir = path.join(install, "router");
const planeSrc = path.join(engineDir, "lib", "workflow");

// ── 1. every manifest entry lands beside the router ─────────────────────────
const manifest = JSON.parse(fs.readFileSync(path.join(planeSrc, "package.json"), "utf8"));
const expected = Object.values(manifest.exports).map((e) => String(e).replace(/^\.\//, ""));
assert.ok(expected.length >= 9, `expected the plane's nine modules, manifest declares ${expected.length}`);

const steps = copyPlaneRuntime(planeSrc, routerDir, { dry: false });
const shippedDir = path.join(routerDir, "..", "lib", "workflow");
for (const f of expected) {
  assert.ok(fs.existsSync(path.join(shippedDir, f)), `shipped plane is missing ${f}`);
  assert.equal(
    fs.readFileSync(path.join(shippedDir, f), "utf8"),
    fs.readFileSync(path.join(planeSrc, f), "utf8"),
    `${f} did not ship byte for byte`
  );
}
console.log(`  shipped ${expected.length} modules byte for byte`);

// ── 2. the link is there, relative, and inside the install ──────────────────
const link = path.join(routerDir, "node_modules", "workflow-plane");
assert.ok(fs.existsSync(link), "no node_modules/workflow-plane link in the install");
assert.ok(fs.lstatSync(link).isSymbolicLink(), "the install linked a real directory, not a link");
assert.equal(fs.readlinkSync(link), path.relative(path.dirname(link), shippedDir));
assert.equal(fs.realpathSync(link), fs.realpathSync(shippedDir), "the link does not resolve to the shipped plane");
// Nothing in the install may point back at the checkout it came from.
assert.ok(
  !fs.realpathSync(link).startsWith(fs.realpathSync(engineDir)),
  "the shipped runtime reaches back into the source checkout"
);
console.log(`  link node_modules/workflow-plane -> ${fs.readlinkSync(link)}`);

// ── 3. a router-local module resolves the plane by specifier ────────────────
// server.js and swarm.mjs are copied into router/, so this is their resolution
// context: a module in that directory with router/package.json above it.
fs.copyFileSync(path.join(engineDir, "router", "package.json"), path.join(routerDir, "package.json"));
const probe = path.join(routerDir, "__specifier_probe.mjs");
fs.writeFileSync(
  probe,
  `import { normalizeEvent } from "workflow-plane/events.mjs";\n` +
    `import { buildGraph } from "workflow-plane/graph.mjs";\n` +
    `console.log(["ok", typeof normalizeEvent, typeof buildGraph].join(" "));\n`
);
const { execFileSync } = await import("node:child_process");
const out = execFileSync(process.execPath, [probe], { encoding: "utf8" }).trim();
assert.equal(out, "ok function function", `the installed router cannot resolve the plane: ${out}`);
fs.rmSync(probe);
console.log(`  a router-local module resolves workflow-plane/*.mjs`);

// ── 4. a second run is a no-op, so `kit apply` is idempotent ────────────────
const again = copyPlaneRuntime(planeSrc, routerDir, { dry: false });
const copySteps = again.filter((s) => s.startsWith("copied") || s.startsWith("would copy"));
const linkSteps = again.filter((s) => s.startsWith("linked") || s.startsWith("would link"));
assert.equal(copySteps.length, 0, `a second apply copied again: ${copySteps.join(", ")}`);
assert.equal(linkSteps.length, 0, `a second apply relinked: ${linkSteps.join(", ")}`);
console.log("  a second apply is a no-op");

// ── 5. dry run changes nothing on disk ──────────────────────────────────────
// A separate install root, so the destination is genuinely fresh: the plane
// lands at <routerDir>/../lib/workflow, so a router inside the same install
// would share the copy the earlier steps already made.
const dryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plane-dry-"));
const dryRouter = path.join(dryRoot, "router");
const drySteps = copyPlaneRuntime(planeSrc, dryRouter, { dry: true });
assert.equal(drySteps.length, expected.length + 1, `a dry run against a fresh install should report every file and the link: ${drySteps.join(" | ")}`);
assert.ok(drySteps.every((s) => s.startsWith("would")), `dry run mutated: ${drySteps.join(", ")}`);
assert.ok(!fs.existsSync(dryRouter), "a dry run created the router directory");
assert.ok(!fs.existsSync(path.join(dryRoot, "lib")), "a dry run copied the plane");
console.log(`  dry run reports ${drySteps.length} step(s) and writes nothing`);

// ── 6. a manifest that lost a module is a loud failure, not a silent one ────
const broken = fs.mkdtempSync(path.join(os.tmpdir(), "plane-broken-"));
fs.mkdirSync(path.join(broken, "lib", "workflow"), { recursive: true });
fs.copyFileSync(path.join(planeSrc, "package.json"), path.join(broken, "lib", "workflow", "package.json"));
assert.throws(
  () => copyPlaneRuntime(path.join(broken, "lib", "workflow"), path.join(broken, "router"), { dry: false }),
  /not on disk/,
  "a manifest declaring a module that is not on disk should fail loudly"
);
console.log("  a manifest whose file is missing fails loudly");

fs.rmSync(install, { recursive: true, force: true });
fs.rmSync(dryRoot, { recursive: true, force: true });
fs.rmSync(broken, { recursive: true, force: true });
console.log("test-copy-plane: all assertions pass");
