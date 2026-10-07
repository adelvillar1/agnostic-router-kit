#!/usr/bin/env node
/**
 * The renders corpus producer: point it at a directory of rendered PNGs and
 * it indexes them into a named corpus of the semantic lane (dev-decisions
 * `semantic-index --inputs`, st-provider image leg). Idempotent per content
 * sha and accumulating across runs — the corpus is what render-watch compares
 * against. Thin by design: all model work is the CLI's, batch.
 *
 *   node tools/record-render-index.mjs <renders-dir> [corpus=renders-baseline]
 */
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: record-render-index.mjs <renders-dir> [corpus]");
  process.exit(2);
}
const corpus = process.argv[3] ?? "renders-baseline";
const bin = process.env.DEV_DECISIONS_BIN ?? "dev-decisions";
execFile(
  bin,
  ["semantic-index", "--corpus", corpus, "--inputs", path.resolve(dir), "--json"],
  { timeout: 300_000, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  (err, stdout, stderr) => {
    if (err) {
      console.error(`record-render-index: ${bin} refused (${err.code ?? "killed"}): ${String(stderr ?? err.message).trim().slice(0, 200)}`);
      process.exit(3);
    }
    for (const line of String(stdout).split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row.op === "semantic-index") {
          console.log(JSON.stringify({ ok: true, op: "record-render-index", corpus, ...row }));
          return;
        }
      } catch {
        /* chatter is skipped — the summary row is the answer */
      }
    }
    console.error("record-render-index: no summary row in the CLI's answer");
    process.exit(3);
  },
);
