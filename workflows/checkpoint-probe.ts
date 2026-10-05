/* workflow
description: "Probe: per-part checkpoint and rollback — a failing part leaves no trace."
whenToUse: Probe only — never a real task. Runs a part that writes its own paths
  and then fails, asserts the workspace is exactly what it was before the part
  ran, and proves the boundary: a sibling's work survives, a path no part
  declared is not the rollback's to delete, and a path escaping the workspace is
  refused. Run with `--grant workspace-io,process`.
args: {}
*/
/**
 * checkpoint-probe: parts write straight into the workspace, so a part that
 * fails mid-build leaves debris the champion then integrates as work.
 *
 * The probe drives the plane's own wrapper — `buildUnderCheckpoint` — because
 * that is what adversarial-solve's champion loop calls, and a probe that
 * reimplemented the ordering would be testing its own transcription. Three
 * shapes are exercised, in the order the plane meets them:
 *
 *   1. a part that THROWS mid-build (a builder that died, a cap escalation) — the
 *      wrapper rolls back and rethrows, so the tree is restored by the only code
 *      path that knows nothing else can help it;
 *   2. a part whose report does not check out, where the build function receives
 *      the checkpoint and rolls it back itself — the plane's other failure path,
 *      decided by the caller because only the caller can judge the report;
 *   3. a sibling that succeeds while its neighbour fails — the rollback must not
 *      reach past a part's own declared paths.
 *
 * No agent is dispatched: this is the plane's behaviour, and a model in the loop
 * would only make the assertions luckier.
 */

const problems: string[] = [];
const ns = "out/checkpoint-probe/1/";

/** A plane-side write, through the run's own command allowlist. */
const write = async (rel: string, content: string): Promise<void> => {
  const script =
    `const fs = require('node:fs');const path = require('node:path');` +
    `fs.mkdirSync(path.dirname(${JSON.stringify(rel)}), { recursive: true });` +
    `fs.writeFileSync(${JSON.stringify(rel)}, ${JSON.stringify(content)}, 'utf8')`;
  const r = await world.run("node", ["-e", script]);
  if (r.exitCode !== 0) throw new Error(`write of ${rel} failed: ${r.stderr || r.stdout}`);
};

/** Every file under the probe's namespace, as the champion's integrated tree would list it. */
const tree = (): string[] =>
  files
    .glob("**/*")
    .filter((f: string) => f.startsWith(ns))
    .sort();

/** Exact bytes of a workspace file, so a rollback is compared against what was there, not against a summary. */
const bytes = (rel: string): string | null => {
  try {
    return files.read(rel);
  } catch {
    return null;
  }
};

// The champion's namespace before any part ran: one file the parts will contend
// for, and nothing else.
const sharedRel = `${ns}shared.js`;
const SHARED_BEFORE = "// shared infrastructure — the state before any part ran\nconst shared = [];\n";
await write(sharedRel, SHARED_BEFORE);
report(`seeded ${sharedRel} (${SHARED_BEFORE.length} bytes)`);
if (bytes(sharedRel) !== SHARED_BEFORE) problems.push("the seeded shared file did not read back byte for byte");

// ── 1. a part that throws mid-build ────────────────────────────────────────
phase("A part that fails mid-build leaves no trace");

const aFailed = await buildUnderCheckpoint(
  world,
  { label: "failing part", paths: [`${ns}a.js`, sharedRel] },
  async (cp) => {
    await write(`${ns}a.js`, "const a = 1; // half-written by the doomed part\n".repeat(40));
    await write(sharedRel, "// CLOBBERED by the doomed part\n");
    await write(`${ns}undeclared.js`, "const undeclared = 1; // outside every declared contract\n");
    throw new Error("builder died mid-part (simulated)");
  }
)
  .then(() => null)
  .catch((e) => String(e?.message ?? e));

if (!aFailed || !/builder died mid-part/.test(aFailed)) {
  problems.push(`a throwing build was not rethrown after rollback: ${aFailed}`);
}
if (bytes(`${ns}a.js`) !== null) problems.push("the doomed part's own file survived the rollback");
if (bytes(`${ns}undeclared.js`) === null) {
  problems.push("the rollback deleted a file no part declared — the rollback is not the place to guess ownership");
}
if (bytes(sharedRel) !== SHARED_BEFORE) {
  problems.push(`the shared file was not restored byte for byte: ${JSON.stringify(String(bytes(sharedRel)).slice(0, 80))}`);
}
// The tree is exactly what it was before the part, plus the one file no part
// declared — the boundary the rollback refuses to cross.
const treeBeforePart = [sharedRel, `${ns}undeclared.js`].sort();
if (JSON.stringify(tree()) !== JSON.stringify(treeBeforePart)) {
  problems.push(`the integrated tree is not the pre-part tree plus the undeclared file: ${tree().join(", ")}`);
}
report(`rollback: a.js removed, shared.js restored byte for byte, undeclared.js left as the boundary demands — tree: ${tree().join(", ")}`);

// ── 2. the caller's own failure path: a report that does not check out ─────
phase("A part whose report does not check out rolls back itself");

const rolledBack = await buildUnderCheckpoint(
  world,
  { label: "unverifiable part", paths: [`${ns}b.js`] },
  async (cp) => {
    await write(`${ns}b.js`, "const b = 1; // built, but the report will not check out\n");
    // What adversarial-solve's `checked` does when the report still fails the
    // part's own contract: it cannot trust the tree, so it restores it.
    const rb = await world.rollback(cp);
    if (rb.removed !== 1) problems.push(`the caller's rollback removed ${rb.removed} path(s), expected 1`);
    return { built: "…", location: `${ns}b.js`, unverified: "simulated" };
  }
);
if (bytes(`${ns}b.js`) !== null) problems.push("a part rolled back by its caller left its file behind");

// Idempotence: the second restore of a checkpoint already restored is a no-op,
// because a part's rollback can be reached twice (a sub-part's own and its
// parent's) and the second one must not invent damage.
const twice = await buildUnderCheckpoint(world, { label: "idempotence", paths: [sharedRel] }, async (cp) => {
  const first = await world.rollback(cp);
  const second = await world.rollback(cp);
  if (first.restored !== 0 || second.restored !== 0 || second.removed !== 0) {
    problems.push(`a double rollback reported work: ${JSON.stringify([first, second])}`);
  }
  return first;
});
report("a second rollback of the same checkpoint restored and removed nothing");

// ── 3. a sibling that succeeds while its neighbour fails ───────────────────
phase("A sibling's work survives its neighbour's failure");

// Seed the state the failing part will clobber once more, then run two parts
// against the same namespace the way the champion loop does — concurrently,
// each under its own checkpoint. The survivor writes only its own path; the
// doomed one writes only its own and dies. A rollback that reached past a
// part's declared paths would take the survivor with it.
await write(sharedRel, SHARED_BEFORE);
const settled = await Promise.all([
  buildUnderCheckpoint(world, { label: "survivor part", paths: [`${ns}survivor.js`] }, async () => {
    await write(`${ns}survivor.js`, "const survivor = true; // built successfully\n");
    return "ok";
  }),
  buildUnderCheckpoint(world, { label: "doomed neighbour", paths: [`${ns}doomed.js`] }, async () => {
    await write(`${ns}doomed.js`, "const doomed = 1;\n");
    throw new Error("the neighbour died mid-part (simulated)");
  }).catch(() => "failed"),
]);
if (settled[0] !== "ok") problems.push(`the survivor part did not return its own result: ${settled[0]}`);
if (settled[1] !== "failed") problems.push(`the doomed neighbour did not fail: ${settled[1]}`);
if (bytes(`${ns}survivor.js`) !== "const survivor = true; // built successfully\n") {
  problems.push("the survivor's file was damaged by its neighbour's rollback");
}
if (bytes(`${ns}doomed.js`) !== null) problems.push("the doomed neighbour's file survived");
if (bytes(sharedRel) !== SHARED_BEFORE) problems.push("the shared file was not intact after both parts settled");
const finalTree = [sharedRel, `${ns}survivor.js`, `${ns}undeclared.js`].sort();
if (JSON.stringify(tree()) !== JSON.stringify(finalTree)) {
  problems.push(`the integrated tree after both parts is not the three files expected: ${tree().join(", ")}`);
}
report(`concurrent parts: the survivor built, the neighbour's rollback took only its own path — tree: ${tree().join(", ")}`);

// ── the boundary: a path that escapes the workspace ────────────────────────
phase("The checkpoint refuses a path outside the workspace");

const escape = await world
  .checkpoint({ label: "escaping part", paths: ["../../etc/passwd"] })
  .then(() => null)
  .catch((e) => String(e?.message ?? e));
if (!escape || !/escapes the workspace/.test(escape)) {
  problems.push(`a path outside the workspace was not refused: ${escape}`);
}
const escapeRestore = await world.rollback({
  id: "cp-forged",
  part: "forged",
  entries: [{ path: "../../etc/passwd", existed: true, bytes: 3, content: Buffer.from("x") }],
});
if (escapeRestore.restored !== 0 || escapeRestore.removed !== 0 || escapeRestore.left.length !== 1) {
  problems.push(`a forged rollback was not inert and reported: ${JSON.stringify(escapeRestore)}`);
}

// An empty checkpoint is legal — a part with no declared files has nothing to
// restore — and rolling it back is a no-op rather than a throw.
const empty = await buildUnderCheckpoint(world, { label: "file-free part", paths: [] }, async () => "ok");
if (empty !== "ok") problems.push(`a file-free part failed: ${empty}`);

report(
  `boundary: escaping path refused at take and at restore, forged rollback inert, file-free part builds — final tree: ${tree().join(", ")}`
);

return {
  conclusion: problems.length
    ? `${problems.length} problem(s)`
    : "a failing part left no trace, a survivor's tree was untouched, and the rollback refused everything outside the workspace",
  findings: problems,
  report: { namespace: ns, tree: tree(), throwRollback: aFailed, idempotentTwice: twice, escape, escapeRestore },
};
