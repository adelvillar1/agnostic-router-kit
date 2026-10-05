#!/usr/bin/env node
/**
 * Run state, on a scratch home and no run at all.
 *
 * The journal is the only durable record a run leaves, so the two behaviours
 * that decide whether that record survives are here: a directory a run is
 * allowed to write into, and an artifact published into it. This module is
 * where item 11 was fixed — two runs started in the same second used to land in
 * one directory, and the second one's summary.json and run.jsonl replaced the
 * first's, quietly, because both runs had already finished by the time anyone
 * looked. The collision case below is the whole of that bug, asserted directly
 * rather than hoped for by racing two real runs.
 *
 *   node tools/test-runstate.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const engineDir = path.resolve(import.meta.dirname, "..");
const { WorkflowRunError, slug, KIT_WORKFLOW_RUNS, freeRunDir, makeArtifacts } = await import(
  path.join(engineDir, "lib", "workflow", "runstate.mjs")
);

// A run's home is read from the environment on every call, so pointing it at a
// scratch directory keeps this test off the machine's real journal tree.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "runstate-home."));
process.env.AGNOSTIC_ROUTER_KIT_HOME = home;

let n = 0;
function pass(what) {
  n += 1;
  console.log(`  ${what}`);
}

// ── 1. the runs directory follows the home the plane is pointed at ──────────
{
  const dir = KIT_WORKFLOW_RUNS();
  assert.equal(dir, path.join(home, "workflow-runs"));
  assert.ok(fs.statSync(dir).isDirectory(), "calling it creates the directory");
  assert.notEqual(dir, path.join(os.homedir(), ".agnostic-router-kit", "workflow-runs"), "the scratch home is in effect");
  pass("the runs directory is <home>/workflow-runs, created on first call");
}

// ── 2. the id is second-granular ───────────────────────────────────────────
{
  // 2026-10-05T21:04:11.512Z — the fraction is what makes two runs in one
  // second name the same path, so it is the thing the format drops.
  const ts = Date.parse("2026-10-05T21:04:11.512Z");
  assert.equal(slug(ts), "2026-10-05_21-04-11");
  assert.ok(!slug(ts).includes("."), "no fraction in the id");
  assert.ok(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(slug(ts)), "the id is a sortable timestamp");
  pass("an id is second-granular: 2026-10-05_21-04-11");
}

// ── 3. two runs in the same second each keep their journal ─────────────────
{
  const id = `${slug(Date.parse("2026-10-05T21:04:11.000Z"))}-checkpoint-probe`;
  const runs = path.join(home, "workflow-runs");

  // The two runs are simulated exactly as the engine drives them: allocate a
  // directory, then write the journal into it. Allocation alone reserves
  // nothing — a directory counts as taken once it holds a journal.
  const first = freeRunDir(id);
  assert.equal(first, path.join(runs, id), "the first run takes the plain path");
  fs.mkdirSync(first, { recursive: true });
  fs.writeFileSync(path.join(first, "run.jsonl"), '{"kind":"run-start"}\n');

  // The second run of the same second. This is the bug: before the fix it was
  // handed `first` too, and finished by erasing the record of the run that
  // ended first — both runs were already over by the time anyone looked.
  const second = freeRunDir(id);
  assert.notEqual(second, first, "the second run does not share the first's directory");
  assert.equal(second, path.join(runs, `${id}-2`), "it takes the sibling with -2");
  fs.mkdirSync(second, { recursive: true });
  fs.writeFileSync(path.join(second, "run.jsonl"), '{"kind":"run-start"}\n');

  const third = freeRunDir(id);
  assert.equal(third, path.join(runs, `${id}-3`), "a third run of the same second takes -3");

  // Both journals are intact, and the third directory was only named: the
  // allocation itself creates nothing on disk.
  assert.equal(fs.readFileSync(path.join(first, "run.jsonl"), "utf8"), '{"kind":"run-start"}\n');
  assert.equal(fs.readFileSync(path.join(second, "run.jsonl"), "utf8"), '{"kind":"run-start"}\n');
  assert.deepEqual(fs.readdirSync(first).sort(), ["run.jsonl"]);
  assert.ok(!fs.existsSync(third), "naming a directory creates nothing");
  pass("two runs in the same second get distinct directories, and each journal survives");
}

// ── 4. a directory without a journal is free, however many there are ────────
{
  const id = `${slug(Date.parse("2026-10-05T21:04:12.000Z"))}-artifacts-only`;
  const base = path.join(home, "workflow-runs", id);
  // A run that published artifacts and crashed before its first event leaves a
  // directory but no journal: it is not a run whose record must be kept.
  fs.mkdirSync(path.join(base, "artifacts", "report", "v1"), { recursive: true });
  assert.equal(freeRunDir(id), base, "a directory with no journal is still free");
  fs.rmSync(base, { recursive: true, force: true });
  pass("a directory holding artifacts but no journal does not block the id");
}

// ── 5. the published surface: versions, events, and the caps ────────────────
{
  const runDir = path.join(home, "workflow-runs", "surface-run");
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "runstate-wd."));
  const events = [];
  // The engine hands the plane's own run state in; this is the one field
  // `makeArtifacts` touches on it, so it is the one the test stands up.
  const state = { artifacts: {} };
  const artifact = makeArtifacts(runDir, workdir, (e) => events.push(e), state);
  const ref = (id) => path.join(runDir, "artifacts", id);

  fs.writeFileSync(path.join(workdir, "note.txt"), "hello");
  const first = await artifact.file("note", "note.txt", { title: "A note", primary: true });
  assert.deepEqual(first, { id: "note", version: 1 });
  assert.equal(fs.readFileSync(path.join(ref("note"), "v1", "note.txt"), "utf8"), "hello");
  assert.deepEqual(events.at(-1), {
    kind: "artifact", id: "note", version: 1, kindType: "file",
    path: "note.txt", bytes: 5, title: "A note", primary: true,
  });
  pass("artifact.file publishes into artifacts/<id>/v1/<name> and says what it did");

  // A second publish of the same id keeps the first: versions accumulate.
  fs.writeFileSync(path.join(workdir, "note.txt"), "hello again");
  const second = await artifact.file("note", "note.txt");
  assert.deepEqual(second, { id: "note", version: 2 });
  assert.equal(fs.readFileSync(path.join(ref("note"), "v1", "note.txt"), "utf8"), "hello", "v1 kept its contents");
  assert.equal(fs.readFileSync(path.join(ref("note"), "v2", "note.txt"), "utf8"), "hello again");
  assert.deepEqual(state.artifacts, { note: [1, 2] });
  pass("publishing the same id twice accumulates versions under one id");

  await artifact.markdown("report", "# Findings\n");
  assert.equal(fs.readFileSync(path.join(ref("report"), "v1", "report.md"), "utf8"), "# Findings\n");
  assert.equal(events.at(-1).kindType, "markdown");
  assert.equal(events.at(-1).bytes, 11);
  assert.equal(events.at(-1).title, "report", "the title defaults to the id");
  pass("artifact.markdown publishes text as <id>.md, defaulting its title to the id");

  await assert.rejects(() => artifact.file("gone", "missing.txt"), /artifact file missing: missing\.txt/);
  await assert.rejects(() => artifact.file("dir", "."), /not a file: \./);
  pass("a missing file and a directory are refusals, not empty artifacts");

  const oversized = "x".repeat(256 * 1024 + 1);
  await assert.rejects(() => artifact.markdown("big", oversized), /markdown over the 262144-byte cap/);
  pass("the markdown cap is 256KB and it refuses to publish past it");

  fs.rmSync(workdir, { recursive: true, force: true });
}

// ── 6. the error type a failed run raises ──────────────────────────────────
{
  const err = new WorkflowRunError("provider refused");
  assert.ok(err instanceof Error, "it is an Error");
  assert.equal(err.message, "provider refused");
  assert.equal(err.name, "Error", "bare by design: no subclass of a subclass");
  pass("WorkflowRunError carries the operator's message and nothing else");
}

fs.rmSync(home, { recursive: true, force: true });
console.log(`test-runstate: ${n} cases pass offline — run directories, collision, artifacts, the error type`);
