/**
 * The workflow's view of a repository.
 *
 * A workflow says `git.status()`, `git.diff(base, path)`, `git.log(20)`,
 * `git.changedFiles(base)`, and each of those is one fixed argv on a real
 * repository. This module is the whole of that surface and the `git()` helper
 * beneath it, and it is the plane's second external boundary — a subprocess
 * rather than an HTTP call.
 *
 * Two rules are load-bearing. The argv is fixed and never a shell string, so
 * nothing a workspace path or a model supplies can become a command. And a
 * failure is data: `git()` returns `{ ok, ... }` and each wrapper turns it into
 * a thrown error with its own diagnosis, because "git status failed in /x — is
 * it a repository?" is the message that tells the operator what to fix.
 *
 * It imports one thing — `node:child_process` — and nothing from the plane, so
 * it can be exercised against a real repository in a temp directory.
 */
import { execFileSync } from "node:child_process";

// ── git observations (fixed argv, never a shell) ─────────────────────────────
function git(cwd, args) {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export async function gitChangedFiles(cwd, base) {
  if (base) {
    const r = git(cwd, ["diff", "--name-only", base]);
    if (!r.ok) throw new Error(`git diff --name-only ${base} failed in ${cwd}`);
    return r.out.split("\n").map((s) => s.trim()).filter(Boolean);
  }
  const r = git(cwd, ["status", "--porcelain"]);
  if (!r.ok) throw new Error(`git status failed in ${cwd} — is it a repository?`);
  return r.out
    .split("\n")
    .map((l) => l.replace(/^(..)\s+/, "").replace(/^ "(.*)"$/, "$1").trim())
    .filter(Boolean);
}

export async function gitDiff(cwd, base, rel) {
  const args = ["diff", base ?? "HEAD"];
  if (rel) args.push("--", rel);
  const r = git(cwd, args);
  if (!r.ok) throw new Error(`git diff failed in ${cwd}`);
  const d = r.out;
  if (d.length > 512 * 1024) throw new Error("diff over the 512KB cap — narrow the path");
  return d;
}

export async function gitStatus(cwd) {
  const r = git(cwd, ["status", "--porcelain"]);
  if (!r.ok) throw new Error(`git status failed in ${cwd}`);
  const staged = [];
  const unstaged = [];
  const untracked = [];
  for (const line of r.out.split("\n").filter(Boolean)) {
    const x = line[0];
    const y = line[1];
    const p = line.slice(3).replace(/^"(.*)"$/, "$1");
    if (x === "?" && y === "?") untracked.push(p);
    else {
      if (x !== " " && x !== "?") staged.push(p);
      if (y !== " " && y !== "?") unstaged.push(p);
    }
  }
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return { branch: branch.ok ? branch.out.trim() : undefined, clean: r.out.trim().length === 0, staged, unstaged, untracked };
}

export async function gitLog(cwd, count = 20) {
  const n = Math.min(Math.max(count, 1), 100);
  const r = git(cwd, ["log", `-n${n}`, "--pretty=format:%H%x1f%s%x1f%an%x1f%aI"]);
  if (!r.ok) throw new Error(`git log failed in ${cwd}`);
  return r.out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, subject, author, date] = line.split("\x1f");
      return { hash, subject, author, date };
    });
}
