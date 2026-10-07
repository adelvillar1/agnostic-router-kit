/**
 * Atomic file writes: temp sibling + fsync + rename. The requested mode is
 * applied to the TEMP inode, so the renamed file never briefly exists
 * world-readable. durable:false skips the fsync for derived caches.
 *
 * This is one of three deliberate twins (router/, lib/, lib/workflow/) — the
 * router runtime is copied by extension into the kit home and must stay
 * self-contained, so it cannot import across the vendor boundary. The unit
 * probe (tools/unit-atomic.mjs) runs the same cases against all three to keep
 * them identical.
 */
import fs from "node:fs";
import path from "node:path";

const sleepSync = (ms) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {}
};

export function writeFileAtomic(file, data, { mode = 0o644, durable = true } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}`);
  try {
    fs.writeFileSync(tmp, data, { mode });
    if (durable) {
      const fd = fs.openSync(tmp, "r");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    for (let i = 0; ; i++) {
      try {
        fs.renameSync(tmp, file);
        break;
      } catch (e) {
        // Windows EPERM/EBUSY/EACCES on rename: a short bounded retry — a
        // real permission problem must not be papered over by a busy-wait.
        if (i < 4 && ["EPERM", "EBUSY", "EACCES"].includes(e?.code)) {
          sleepSync(50);
          continue;
        }
        throw e;
      }
    }
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

export function writeFileAtomicIfChanged(file, data, opts = {}) {
  try {
    if (fs.readFileSync(file, "utf8") === data) return false;
  } catch {}
  writeFileAtomic(file, data, opts);
  return true;
}
