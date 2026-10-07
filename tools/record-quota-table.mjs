#!/usr/bin/env node
/**
 * Table producer: the usage ledger's hourly buckets → dev-decisions'
 * quota-spend table (~/.local/share/dev-decisions/tables/quota-spend.csv).
 *
 * The kit already produces everything the quota-forecast loop needs: the
 * ledger keeps per-provider hourly token buckets (usage.json "hourly"), and
 * quota steering weights each bucket by the provider's declared off-peak
 * schedule — the same math `weightedSince` in router/quota.mjs applies when
 * it sums any window: bucket tokens × offpeakWeight(quota, mid-hour). This
 * tool re-derives that weighted spend per provider-hour and lands it in the
 * shared calibration store as rows of (ts, providerId, weightedSpend), one
 * row per bucket, ts the UTC hour the bucket covers (the ledger's own
 * "YYYY-MM-DDTHH" key, resolved the same way usage.hourly() resolves it).
 *
 * Idempotent per bucket: (providerId, hour) pairs already in the CSV are
 * skipped, only new ones appended, so it can run after every router session
 * without duplicating history. The ledger prunes buckets after ~30 days;
 * the table is the long memory the ledger cannot be. No model calls, no
 * dependencies — a small deterministic producer, like the store's other
 * tables.
 *
 * Usage: node tools/record-quota-table.mjs [--usage <path>] [--out <csv>] [--roster <path>]
 *   --usage   the router's usage ledger (default ~/.agnostic-router-kit/router/logs/usage.json;
 *             a dev instance writes <repo>/router/logs/usage.json — pass it here)
 *   --out     the quota-spend table (default ~/.local/share/dev-decisions/tables/quota-spend.csv)
 *   --roster  roster supplying off-peak declarations (default the repo's roster.json;
 *             a provider absent from it weighs 1, exactly as steering treats it)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { offpeakWeight } from "../router/quota.mjs";

const HOUR_MS = 3600_000;
const HOUR_KEY = /^\d{4}-\d{2}-\d{2}T\d{2}$/; // the ledger's hour-bucket key

const DEFAULT_USAGE = path.join(os.homedir(), ".agnostic-router-kit", "router", "logs", "usage.json");
const DEFAULT_OUT = path.join(os.homedir(), ".local", "share", "dev-decisions", "tables", "quota-spend.csv");
const DEFAULT_ROSTER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "roster.json");

const expand = (p) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

function parseArgs(argv) {
  const flags = { usage: DEFAULT_USAGE, out: DEFAULT_OUT, roster: DEFAULT_ROSTER };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const name = eq > 1 ? a.slice(0, eq) : a;
    const key = name.replace(/^--/, "");
    if (!(key in flags)) {
      console.error(`record-quota-table: unknown flag ${name} — flags: --usage <path> --out <csv> --roster <path>`);
      process.exit(1);
    }
    flags[key] = expand(eq > 1 ? a.slice(eq + 1) : argv[++i]);
  }
  return flags;
}

/** Integers print bare; fractional (off-peak-discounted) spend keeps 6 decimals, no float noise. */
const fmtSpend = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1e6) / 1e6));

const flags = parseArgs(process.argv.slice(2));

if (!fs.existsSync(flags.usage)) {
  console.error(`record-quota-table: no usage ledger at ${flags.usage} — start the router to begin one, or pass --usage <path>`);
  process.exit(1);
}
let ledger;
try {
  ledger = JSON.parse(fs.readFileSync(flags.usage, "utf8"));
} catch (e) {
  console.error(`record-quota-table: cannot parse ${flags.usage}: ${e.message}`);
  process.exit(1);
}

let roster = {};
try {
  roster = JSON.parse(fs.readFileSync(flags.roster, "utf8"));
} catch {} // no roster (or unreadable): every bucket weighs 1 — the steering fallback too

// The steering math, reused: weightFor mirrors server.js's weightOf, and the
// mid-hour timestamp mirrors weightedSince's per-bucket weighting.
const weightFor = (pid, ts) => {
  try {
    return offpeakWeight(roster?.providers?.[pid]?.quota, ts);
  } catch {
    return 1;
  }
};

const buckets = []; // { ts, pid, weighted, key }
for (const pid of Object.keys(ledger?.hourly ?? {}).sort()) {
  const hours = ledger.hourly[pid] ?? {};
  for (const hourKey of Object.keys(hours).sort()) {
    if (!HOUR_KEY.test(hourKey)) continue; // not an hour key: leave it to the ledger's own readers
    const hourTs = Date.parse(hourKey + ":00:00Z");
    const tokens = hours[hourKey]?.tokens;
    if (!Number.isFinite(hourTs) || !Number.isFinite(tokens)) continue;
    buckets.push({
      ts: hourKey + ":00:00Z",
      pid,
      weighted: tokens * weightFor(pid, hourTs + HOUR_MS / 2),
      key: `${pid}@${hourKey}`,
    });
  }
}

// Idempotency: whatever the table already records for a (providerId, hour),
// the ledger will re-offer for its whole ~30-day retention — skip those.
const known = new Set();
if (fs.existsSync(flags.out)) {
  for (const line of fs.readFileSync(flags.out, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("ts,")) continue;
    const [ts, pid] = t.split(",");
    if (ts && pid) known.add(`${pid}@${ts.slice(0, 13)}`);
  }
}

fs.mkdirSync(path.dirname(flags.out), { recursive: true });
const fresh = buckets.filter((b) => !known.has(b.key));
if (fresh.length) {
  let out = "";
  if (!fs.existsSync(flags.out) || fs.statSync(flags.out).size === 0) out += "ts,providerId,weightedSpend\n";
  for (const b of fresh) out += `${b.ts},${b.pid},${fmtSpend(b.weighted)}\n`;
  fs.appendFileSync(flags.out, out);
}
console.log(`record-quota-table: ${flags.usage} → ${flags.out} — added ${fresh.length}, skipped ${buckets.length - fresh.length}`);
