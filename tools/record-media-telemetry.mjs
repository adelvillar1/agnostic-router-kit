#!/usr/bin/env node
/**
 * The daily media cadence: gen1's telemetry sink → dev-decisions'
 * media_runs table, one execFile of the CLI verb.
 *
 * The media-budget-watch loop forecasts next-day audio seconds from the
 * media-seconds table, and that table is only as honest as its ingest: the
 * sink carries no timestamp, so each row is stamped with its ingestion date,
 * and a daily band needs a daily ingest. This is that entry point — the
 * operator's cron line, in the repo's own vocabulary, exactly as
 * `npm run record:quota` is the quota table's.
 *
 * It is deliberately thin: the engine's verb is the accountable writer (it
 * owns the table's idempotence — content sha + occurrence index, so a re-run
 * lands nothing twice — and its own log row), and this tool relays it rather
 * than reimplementing it. Human output on purpose: a cron log is read by a
 * person, and the CLI's own words ("+ 3 new row(s), 1 duplicate(s) already
 * ingested") are the right log. The child's exit code rides out unchanged, so
 * a missing sink or an absent CLI is visible to whatever schedules this.
 *
 * Usage: node tools/record-media-telemetry.mjs [--telemetry <path>] [--bin <path>]
 *   --telemetry  gen1's telemetry JSONL (default the engine's own resolution:
 *                GEN1_TELEMETRY_FILE, else ~/.config/gen1/telemetry.jsonl)
 *   --bin        the dev-decisions CLI (default DEV_DECISIONS_BIN, else `dev-decisions`)
 */

import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TELEMETRY = path.join(os.homedir(), ".config", "gen1", "telemetry.jsonl");

function parseArgs(argv) {
  const flags = { telemetry: process.env.GEN1_TELEMETRY_FILE || DEFAULT_TELEMETRY, bin: process.env.DEV_DECISIONS_BIN || "dev-decisions" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const name = eq > 1 ? a.slice(0, eq) : a;
    const key = name.replace(/^--/, "");
    if (!(key in flags)) {
      console.error(`record-media-telemetry: unknown flag ${name} — flags: --telemetry <path> --bin <path>`);
      process.exit(1);
    }
    flags[key] = eq > 1 ? a.slice(eq + 1) : argv[++i];
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));
const argv = ["record-media-runs"];
// Only --telemetry rides when the caller named one: the engine's own sink
// resolution is the right answer for the daily cron line.
if (flags.telemetry) argv.push("--telemetry", flags.telemetry);

execFile(flags.bin, argv, { encoding: "utf8" }, (err, stdout, stderr) => {
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  if (!err) return process.exit(0);
  // An absent CLI is a configured absence, not a crash: name it the way the
  // kit's other lanes do and exit non-zero so the schedule can see it.
  if (err.code === "ENOENT") {
    console.error(
      `record-media-telemetry: ${flags.bin} not found — the media cadence needs the dev-decisions CLI with gen1 ` +
        `(set DEV_DECISIONS_BIN; see docs/features/media-lane.md)`,
    );
    return process.exit(1);
  }
  // A numeric code is the CLI's own refusal riding out verbatim — its exit
  // code is the report (a missing sink is its own named refusal, exit 3).
  if (typeof err.code === "number") return process.exit(err.code);
  // Anything else is a spawn failure (not executable, no permission, …): name
  // it rather than dying on a bare exit 1.
  console.error(
    `record-media-telemetry: could not run ${flags.bin} (${err.code ?? err.message}) — the media cadence needs the ` +
      `dev-decisions CLI with gen1 (set DEV_DECISIONS_BIN; see docs/features/media-lane.md)`,
  );
  process.exit(1);
});
