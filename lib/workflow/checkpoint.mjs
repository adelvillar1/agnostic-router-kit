/**
 * Per-part checkpoints: the workspace isolation the swarm never had.
 *
 * Parts write straight into the workspace, so a part that fails mid-build
 * leaves debris behind and the champion integrates it. A checkpoint closes
 * that: taken before a part runs, it holds every path the part's contract
 * declared along with the bytes that were there, and a rollback restores
 * exactly those paths — after it, a failed part's tree is indistinguishable
 * from the workspace that existed before the part ran.
 *
 * The rule is deliberately narrow: a checkpoint covers the declared paths and
 * nothing else. The parts of one champion build concurrently into one
 * namespace, so a wider snapshot (the whole namespace) would restore over a
 * sibling's work — the exclusive ownership `validateContract` enforces is the
 * same ownership this relies on. A path no part declared is not this part's to
 * delete, so what a rollback could not clean is reported rather than removed:
 * the journal line names what survived, so debris is visible instead of
 * invisible.
 *
 * A checkpoint is a value, not a handle: nothing to leak, nothing to stop at
 * run-done, and the plane's failure path is the only thing that ever restores
 * one. These hold no grant decisions either — the paths come from a contract
 * the dispatch gate already validated, and an escaping path is refused here
 * because a rollback would otherwise write outside the workspace.
 */
import fs from "node:fs";
import path from "node:path";

/** Bytes one checkpoint may hold. Past it the remaining paths record existence only, and a rollback leaves them alone. */
export const CHECKPOINT_BYTE_CAP = 4 * 1024 * 1024;

/**
 * Checkpoint ids are sequential in-process so a journal's take and rollback
 * lines name the same record. The namespace is per-process by design: a
 * snapshot is an in-memory value, so it is only ever restored by the run that
 * took it.
 */
let seq = 0;

/** Resolve a workspace-relative path, refusing anything that escapes the workspace — the rule every file tool applies. */
function resolveIn(workspace, rel) {
  const p = path.resolve(workspace, rel);
  const root = path.resolve(workspace);
  if (p !== root && !p.startsWith(root + path.sep)) {
    throw new Error(`path escapes the workspace: ${rel}`);
  }
  return p;
}

/**
 * Snapshot a part's owned paths. `paths` are workspace-relative (or absolute
 * under the workspace); the namespace is the caller's to add, because only the
 * caller knows where its builders write. Returns the snapshot record, which is
 * also what a rollback takes and what the journal line names.
 */
export function takeCheckpoint(workspace, journal, { label, paths } = {}) {
  const part = String(label ?? "(unlabelled part)").slice(0, 80);
  const requested = (Array.isArray(paths) ? paths : []).map((p) => String(p ?? "").trim()).filter(Boolean);
  const id = `cp-${++seq}`;
  const entries = [];
  let bytes = 0;
  let oversized = false;
  for (const rel of requested) {
    let abs;
    try {
      abs = resolveIn(workspace, rel);
    } catch (e) {
      // An escaping path is refused, not skipped: silently dropping it would
      // leave a part "checkpointed" with less of its contract than it declared,
      // and the failure would only surface as a rollback that restored nothing.
      const refusal = String(e?.message ?? e);
      journal?.({ kind: "checkpoint", id, part, op: "refused", path: rel.slice(0, 200), reason: refusal });
      throw new Error(refusal);
    }
    const entry = { path: path.relative(path.resolve(workspace), abs).split(path.sep).join("/"), existed: false, bytes: 0, content: null };
    try {
      const st = fs.lstatSync(abs);
      entry.existed = true;
      if (st.isFile() && !st.isSymbolicLink()) {
        if (bytes + st.size > CHECKPOINT_BYTE_CAP) {
          oversized = true;
        } else {
          const content = fs.readFileSync(abs);
          entry.bytes = content.length;
          entry.content = content;
          bytes += content.length;
        }
      }
    } catch {
      entry.existed = false; // a declared path that was never created keeps its "absent" state, which is the state to restore to
    }
    entries.push(entry);
  }
  const snapshot = { id, part, entries, bytes, requested: entries.length, oversized, takenAt: Date.now() };
  journal?.({ kind: "checkpoint", id, part, op: "take", paths: entries.length, bytes, oversized });
  return snapshot;
}

/**
 * Restore a checkpoint: every captured path gets the bytes it had, every
 * absent path that appeared since is removed. Files captured past the byte cap
 * are left alone and counted — a rollback that cannot say what it did is worse
 * than one that reports a hole.
 */
export function restoreCheckpoint(workspace, journal, snapshot) {
  const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : [];
  const id = String(snapshot?.id ?? "cp-?");
  const part = String(snapshot?.part ?? "(unlabelled part)");
  let restored = 0;
  let removed = 0;
  let uncaptured = 0;
  const left = [];
  for (const entry of entries) {
    const rel = String(entry?.path ?? "");
    if (!rel) continue;
    let abs;
    try {
      abs = resolveIn(workspace, rel);
    } catch {
      // The take already refused an escaping path, so this is a record that did
      // not come from this module's own check. It is left and reported rather
      // than skipped silently: a restore says what it did.
      left.push({ path: rel, why: "path escapes the workspace" });
      continue;
    }
    if (entry.existed) {
      if (!entry.content) {
        uncaptured++;
        continue;
      }
      let current = null;
      try {
        current = fs.readFileSync(abs);
      } catch {
        current = null;
      }
      if (current && current.equals(entry.content)) continue; // untouched — rewriting would move an mtime for nothing
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, entry.content);
        restored++;
      } catch (e) {
        left.push({ path: rel, why: `restore failed: ${String(e?.message ?? e).slice(0, 120)}` });
      }
      continue;
    }
    // Absent at checkpoint time: anything here now is the part's own writing.
    let st = null;
    try {
      st = fs.lstatSync(abs);
    } catch {
      st = null;
    }
    if (!st) continue;
    if (st.isDirectory()) {
      left.push({ path: rel, why: "a directory now stands where the part owned a file — removing a tree is not this rollback's to do" });
      continue;
    }
    try {
      fs.rmSync(abs, { force: true });
      removed++;
    } catch (e) {
      left.push({ path: rel, why: `remove failed: ${String(e?.message ?? e).slice(0, 120)}` });
    }
  }
  const summary = { id, part, restored, removed, uncaptured, left };
  journal?.({ kind: "rollback", id, part, restored, removed, uncaptured, left: left.length });
  return summary;
}

/**
 * Run one part's build under a checkpoint: the snapshot is taken before the
 * build starts and restored if the build throws, so a part that dies mid-way
 * leaves no trace even though nothing around it knows it failed. `build` also
 * receives the checkpoint, because the plane's other failure path — a report
 * that did not check out against the part's own contract — is a decision only
 * the caller can make, and it needs the same snapshot.
 */
export async function buildUnderCheckpoint(world, spec, build) {
  const checkpoint = await world.checkpoint(spec);
  try {
    return await build(checkpoint);
  } catch (e) {
    await world.rollback(checkpoint);
    throw e;
  }
}
