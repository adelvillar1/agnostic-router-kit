#!/usr/bin/env node
/**
 * The git boundary, against a real repository nobody else uses.
 *
 * `gitworld.mjs` is the plane's second external boundary and the only module
 * whose calls are subprocesses. It moved out of engine.mjs as pure code motion,
 * which is exactly the kind of move that can silently break: nothing in the
 * plane's own tests exercises it, so a swapped argv or a lost `export` would
 * only surface in a live workflow run.
 *
 * So this builds a throwaway repository and asks it the four questions the
 * workflow surface asks, plus the two failure branches — a path that is not a
 * repository at all, and a diff over the cap. Every repository lives in a fresh
 * temp directory and is deleted afterwards.
 *
 *   node tools/test-gitworld.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const { gitChangedFiles, gitDiff, gitStatus, gitLog } = await import(
  path.join(path.resolve(import.meta.dirname, ".."), "lib", "workflow", "gitworld.mjs")
);

/** A fresh repo with one commit, and the execFileSync the test itself needs. */
function makeRepo(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gitworld-${name}-`));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Plane Test",
    GIT_AUTHOR_EMAIL: "plane@test.invalid",
    GIT_COMMITTER_NAME: "Plane Test",
    GIT_COMMITTER_EMAIL: "plane@test.invalid",
  };
  const sh = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env });
  sh(["init", "-q", "--initial-branch=main"]);
  sh(["config", "user.name", "Plane Test"]);
  sh(["config", "user.email", "plane@test.invalid"]);
  return { dir, sh };
}

let n = 0;

// ── 1. a clean repository reports itself clean and names its branch ──────────
{
  n += 1;
  const { dir, sh } = makeRepo("clean");
  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
    sh(["add", "a.txt"]);
    sh(["commit", "-q", "-m", "first: a file"]);
    const s = await gitStatus(dir);
    assert.equal(s.clean, true, "a repo with nothing pending is clean");
    assert.equal(s.branch, "main");
    assert.deepEqual({ staged: s.staged, unstaged: s.unstaged, untracked: s.untracked }, {
      staged: [],
      unstaged: [],
      untracked: [],
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`  a clean repository reports clean, on its branch`);
}

// ── 2. every pending state lands in its own bucket ───────────────────────────
{
  n += 1;
  const { dir, sh } = makeRepo("buckets");
  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
    sh(["add", "a.txt"]);
    sh(["commit", "-q", "-m", "first: a file"]);
    fs.writeFileSync(path.join(dir, "a.txt"), "two\n");        // modified, unstaged
    fs.writeFileSync(path.join(dir, "b.txt"), "staged\n");      // new, staged
    sh(["add", "b.txt"]);
    fs.writeFileSync(path.join(dir, "c.txt"), "untracked\n");   // new, untracked

    const s = await gitStatus(dir);
    assert.deepEqual(s.unstaged, ["a.txt"], "the modified file is unstaged");
    assert.deepEqual(s.staged, ["b.txt"], "the added file is staged");
    assert.deepEqual(s.untracked, ["c.txt"], "the unadded file is untracked");
    assert.equal(s.clean, false);
    console.log(`  modified, staged and untracked land in their own buckets`);

    // ── 3. the same pending state, through changedFiles ────────────────────
    n += 1;
    const files = await gitChangedFiles(dir);
    assert.deepEqual(files.sort(), ["a.txt", "b.txt", "c.txt"]);
    console.log(`  changedFiles with no base is the whole pending set`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── 4. a diff against a base is the patch for that one path ──────────────────
{
  n += 1;
  const { dir, sh } = makeRepo("diff");
  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
    sh(["add", "a.txt"]);
    sh(["commit", "-q", "-m", "first: a file"]);
    const base = sh(["rev-parse", "HEAD"]).trim();
    fs.writeFileSync(path.join(dir, "a.txt"), "two\n");
    sh(["commit", "-q", "-am", "second: changed it"]);

    const d = await gitDiff(dir, base);
    assert.match(d, /^-one$/m, "the diff shows the line that was removed");
assert.match(d, /^\+two$/m, "and the line that replaced it");

    // Scoped to one path: the untracked neighbour does not leak in.
    fs.writeFileSync(path.join(dir, "b.txt"), "unrelated\n");
    const scoped = await gitDiff(dir, base, "a.txt");
    assert.match(scoped, /a\.txt/);
    assert.equal(/b\.txt/.test(scoped), false, "an explicit path excludes the neighbour");
    console.log(`  a diff against a base is the patch, and a path scopes it`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── 5. the log is structured, and honours the count's bounds ────────────────
{
  n += 1;
  const { dir, sh } = makeRepo("log");
  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "0\n");
    sh(["add", "a.txt"]);
    sh(["commit", "-q", "-m", "c0"]);
    for (const i of [1, 2, 3]) {
      fs.writeFileSync(path.join(dir, "a.txt"), `${i}\n`);
      sh(["commit", "-q", "-am", `c${i}`]);
    }
    const log = await gitLog(dir, 2);
    assert.equal(log.length, 2, "the count is honoured");
    assert.equal(log[0].subject, "c3", "newest first");
    assert.equal(log[1].subject, "c2");
    assert.match(log[0].hash, /^[0-9a-f]{40}$/, "a full hash, not the abbreviated one");
    assert.equal(log[0].author, "Plane Test");
    assert.match(log[0].date, /^\d{4}-\d{2}-\d{2}T/, "an ISO-8601 instant");

    // Out-of-range counts are clamped, not thrown on.
    assert.equal((await gitLog(dir, 0)).length, 1, "zero is clamped to one");
    assert.equal((await gitLog(dir, 500)).length, 4, "500 is clamped to what exists");
    console.log(`  the log is structured, newest first, and the count is clamped`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── 6. a path that is not a repository says so ───────────────────────────────
{
  n += 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitworld-norepo-"));
  try {
    await assert.rejects(gitStatus(dir), /git status failed in/);
    await assert.rejects(gitChangedFiles(dir), /is it a repository\?/, "the no-base branch asks the operator's question");
    await assert.rejects(gitLog(dir, 5), /git log failed in/);
    await assert.rejects(gitDiff(dir, "HEAD"), /git diff failed in/);
    console.log(`  a path that is not a repository fails with its own diagnosis`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── 7. a diff over the cap is refused rather than truncated ──────────────────
{
  n += 1;
  const { dir, sh } = makeRepo("cap");
  try {
    fs.writeFileSync(path.join(dir, "big.txt"), "x\n".repeat(250000));
    sh(["add", "big.txt"]);
    sh(["commit", "-q", "-m", "big"]);
    const base = sh(["rev-parse", "HEAD"]).trim();
    fs.writeFileSync(path.join(dir, "big.txt"), "y\n".repeat(250000));
    sh(["commit", "-q", "-am", "bigger"]);
    await assert.rejects(gitDiff(dir, base), /over the 512KB cap/, "a diff too large to hand a model is refused");
    console.log(`  a diff over the 512KB cap is refused, not silently truncated`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── 8. the boundary is fixed argv, never a shell ─────────────────────────────
{
  n += 1;
  // A path whose name is shell-active must not become a command. If anything
  // reaches a shell, `$(...)` or a backtick would execute and this writes a file.
  const { dir, sh } = makeRepo("argv");
  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
    sh(["add", "a.txt"]);
    sh(["commit", "-q", "-m", "first"]);
    const probe = path.join(dir, "PROBE-EXECUTED");
    await assert.rejects(gitStatus(`$(touch ${JSON.stringify(probe)})`), /git status failed in/);
    assert.equal(fs.existsSync(probe), false, "the cwd never reached a shell");
    // It is still reported as a failure with the operator's own words.
    await assert.rejects(gitStatus(`$(touch ${JSON.stringify(probe)})`), /git status failed in/);
    console.log(`  a shell-active cwd is reported as a failure, never executed`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`test-gitworld: ${n} cases pass against real repositories — buckets, diffs, logs, failures, argv`);
