/**
 * The state a run owns: what it is called, where it writes, and how it fails.
 *
 * A run's journal is the only durable record it leaves behind, so this module
 * is where that record gets an address. Three concerns live here and nowhere
 * else: the run's error type, the directory its journal lives in, and the
 * artifacts it publishes into that directory.
 *
 * The directory deserves the care it gets. An id is second-granular
 * (`2026-10-05_21-04-11-checkpoint-probe`), so two runs started inside the same
 * second collide on the same path by construction — which is exactly what item
 * 11 fixed: the second run wrote its journal over the first's, and the first
 * run's durable record was gone the moment the second one ended. `freeRunDir`
 * is the whole of the fix, and it is the reason a run directory is never simply
 * the path its id names.
 *
 * The error type moved here first, ahead of the rest of the module, because
 * transport.mjs throws it: a run that failed raises `WorkflowRunError`, and
 * every caller distinguishes it from a programming error by `instanceof`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FILE_CAP = 20 * 1024 * 1024;
const MARKDOWN_CAP = 256 * 1024;

/**
 * A run that failed for a reason the operator should read.
 *
 * Deliberately bare: the message a caller passes is the whole diagnosis, and
 * its name says where it comes from. Nothing subclasses it, because a run has
 * one failure mode — it could not finish — and the reason lives in the text.
 */
export class WorkflowRunError extends Error {}

/**
 * Where run journals live. The kit and the engine edition each point this at
 * their own runtime directory through the same variable, so the plane has one
 * home rather than two hard-coded paths.
 */
export function KIT_WORKFLOW_RUNS() {
  const home = process.env.AGNOSTIC_ROUTER_KIT_HOME ?? path.join(os.homedir(), ".agnostic-router-kit");
  const dir = path.join(home, "workflow-runs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function slug(ts) {
  return new Date(ts).toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

/**
 * A run directory that does not already hold a journal, so no run erases one.
 *
 * The suffix is the second run's identity: a run started in a directory that
 * already has a journal gets `-2`, then `-3`, and so on, and each of those
 * journals survives. Without it, two runs in the same second share one
 * directory and the second one's summary.json and run.jsonl replace the
 * first's — the run that finished first loses its record to the one that
 * finished second, which is the bug this closes.
 *
 * Exported so the collision case can be asserted directly rather than hoped
 * for by launching two runs fast enough.
 */
export function freeRunDir(id) {
  const base = path.join(KIT_WORKFLOW_RUNS(), id);
  if (!fs.existsSync(path.join(base, "run.jsonl"))) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = path.join(KIT_WORKFLOW_RUNS(), `${id}-${n}`);
    if (!fs.existsSync(path.join(candidate, "run.jsonl"))) return candidate;
  }
  return base;
}

function artifactDest(runDir, id, version, base) {
  return path.join(runDir, "artifacts", id, `v${version}`, base);
}

/**
 * The `.artifact` surface a workflow sees: `artifact.file` publishes a workspace
 * file into the run, `artifact.markdown` publishes generated content. Versions
 * accumulate under one id, so asking twice for the same artifact keeps both.
 */
export function makeArtifacts(runDir, workdir, emit, state) {
  const nextVersion = (id) => {
    const arr = (state.artifacts[id] ??= []);
    const version = arr.length + 1;
    arr.push(version);
    return version;
  };
  return {
    async file(id, rel, opts2 = {}) {
      // Workspace-relative, like files.read — an absolute path is honoured only
      // when it really is inside the workspace.
      const full = path.resolve(workdir, rel);
      if (!fs.existsSync(full)) throw new Error(`artifact file missing: ${rel}`);
      const st = fs.statSync(full);
      if (!st.isFile()) throw new Error(`not a file: ${rel}`);
      if (st.size > FILE_CAP) throw new Error(`artifact over the ${FILE_CAP}-byte cap: ${rel}`);
      const version = nextVersion(id);
      const dest = artifactDest(runDir, id, version, path.basename(rel));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(full, dest);
      emit({ kind: "artifact", id, version, kindType: "file", path: rel, bytes: st.size, title: opts2.title ?? id, primary: Boolean(opts2.primary) });
      return { id, version };
    },
    async markdown(id, content, opts2 = {}) {
      const text = String(content ?? "");
      if (Buffer.byteLength(text) > MARKDOWN_CAP) throw new Error(`markdown over the ${MARKDOWN_CAP}-byte cap`);
      const version = nextVersion(id);
      const dest = artifactDest(runDir, id, version, `${id}.md`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, text);
      emit({ kind: "artifact", id, version, kindType: "markdown", bytes: Buffer.byteLength(text), title: opts2.title ?? id, primary: Boolean(opts2.primary) });
      return { id, version };
    },
  };
}
