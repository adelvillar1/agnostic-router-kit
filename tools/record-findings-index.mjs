#!/usr/bin/env node
/**
 * The findings corpus producer: a findings JSONL in, per-finding text files
 * out — one file per finding id, idempotent by name, ready for the semantic
 * lane's `--inputs` indexing (the workflow indexes the corpus as a batch
 * call; this tool only writes files, deterministically).
 *
 * Input line shape (one JSON object per line):
 *   {"id":"f-001","what":"the problem in one sentence","where":"lib/x.mjs",
 *    "severity":"high","disposition":"fixed|waived|overridden|open","note":"...", "ts":"..."}
 *
 * Output file (out-dir/<id>.txt) — the first line is the indexed text, the
 * second carries the metadata the sweep reads back when a repeat matches:
 *   <what>
 *   [where=<where>] severity=<severity> disposition=<disposition|open> note=<note>
 *
 *   node tools/record-findings-index.mjs findings.jsonl [out-dir]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const from = process.argv[2];
if (!from) {
  console.error("usage: record-findings-index.mjs <findings.jsonl> [out-dir]");
  process.exit(2);
}
const outDir =
  process.argv[3] ?? path.join(os.homedir(), ".local", "share", "dev-decisions", "inputs", "findings");

let lines;
try {
  lines = fs.readFileSync(from, "utf8").split("\n");
} catch (e) {
  console.error(`record-findings-index: cannot read ${from}: ${String(e?.message ?? e)}`);
  process.exit(3);
}

fs.mkdirSync(outDir, { recursive: true });
let written = 0;
let skipped = 0;
for (const line of lines) {
  if (!line.trim()) continue;
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    skipped += 1; // a malformed line is counted, never guessed into a finding
    continue;
  }
  const id = String(rec.id ?? "").trim();
  const what = String(rec.what ?? "").trim();
  if (!id || !what) {
    skipped += 1;
    continue;
  }
  const meta = [
    `where=${rec.where ?? "?"}`,
    `severity=${rec.severity ?? "?"}`,
    `disposition=${rec.disposition ?? "open"}`,
    rec.note ? `note=${String(rec.note).replace(/\s+/g, " ").slice(0, 200)}` : null,
    rec.ts ? `ts=${rec.ts}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const body = `${what}\n${meta}\n`;
  fs.writeFileSync(path.join(outDir, `${id.replace(/[^A-Za-z0-9._-]+/g, "_")}.txt`), body);
  written += 1;
}
console.log(
  JSON.stringify({ ok: true, op: "record-findings-index", written, skipped, outDir }),
);
