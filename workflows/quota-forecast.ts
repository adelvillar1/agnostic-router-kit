/* workflow
description: "Quota forecast as a batch loop: the kit's own spend table —
  quota-spend.csv, written by `npm run record:quota` — is scored by
  dev-decisions' budget-gate (an sdm1 quantile band over each plan's weighted
  spend series), and the loop renders each plan's forecast band and
  exhaustion estimate beside the table's own freshness. A plan whose earliest
  band edge lands inside the horizon escalates — the ladder exists so an
  owner answer can re-route tiers before anything dies. Deterministic
  tool-flow throughout: no agents, no asks, no model calls; the one blocking
  judgment is the owner's. Fails open by name: no table, no dev-decisions,
  or an empty answer ends the loop with the refusal verbatim and routing
  unchanged."
whenToUse: Between sessions or on a schedule, when the question is which
  token plans are burning toward exhaustion inside the horizon. Run with
  `--grant tabular`. The loop only reads — `npm run record:quota` is what
  refreshes the table it reads.
args:
  plan:
    type: string
    description: One plan (providerId) to forecast — omit to forecast every plan the spend table declares.
    required: false
  horizonHours:
    type: number
    description: The forecast window in hours (default 72) — a plan whose earliest exhaustion estimate lands inside it escalates.
    required: false
*/
/**
 * quota-forecast: the spend table the kit already produces, scored.
 *
 * Batch-only by the tabular lane's law — the sdm1 forecast runs inside the
 * dev-decisions CLI between agent rounds, never inside an ask, and this loop
 * spawns no agents at all. The fail-open law is the moli law: a machine
 * without dev-decisions is a configured absence, so every not-ok branch ends
 * the loop with the refusal's own words and "routing unchanged" — the kit
 * proceeds exactly as today.
 *
 * ASSUMPTION (noted per the plan): budget-gate is called with `--group
 * providerId` to split the series per plan, plus `--metric weightedSpend`
 * and `--horizon <h>` as the plan names them. The dev-decisions flag surface
 * is not verifiable from this repo; a wrong flag comes back as a tabular
 * not-ok carrying the CLI's own words, and the loop fails open with those
 * words verbatim rather than guessing twice.
 */

// The store path literal, once: dev-decisions' own store convention. execFile
// spawns no shell, so the tilde is not the plane's to expand — the CLI (and
// the one stat probe below, which expands it against $HOME itself) resolve it.
const QUOTA_TABLE = "~/.local/share/dev-decisions/tables/quota-spend.csv";

const horizonHours = Math.max(1, Number(args.horizonHours) || 72);
const planFilter = String(args.plan ?? "").trim();

const FAIL_OPEN = "quota forecast unavailable, routing unchanged";

// Row fields budget-gate may ship, read defensively: an unrecognized row is
// reported as unrecognized and rides raw into the artifact — it is never
// guessed into a verdict.
const pick = (row, names) => {
  for (const n of names) if (row && row[n] !== undefined && row[n] !== null) return row[n];
  return undefined;
};
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};
const cell = (h) => (h == null ? "—" : `${Math.round(h)}h`);

phase("Read the spend table");

// Freshness is surfaced, not assumed: stat the CSV before trusting it. `stat`
// is not on the plane's default executable allowlist; `node` is — the same
// bounded runner, fixed argv, no shell, journaled. The child expands the
// tilde itself and prints one JSON line.
const STAT = [
  'const fs=require("fs"),os=require("os"),path=require("path");',
  'let p=process.argv[process.argv.length-1];',
  'if(p.indexOf("~/")===0)p=path.join(os.homedir(),p.slice(2));',
  'try{const st=fs.statSync(p);',
  'process.stdout.write(JSON.stringify({ok:true,path:p,size:st.size,',
  'ageHours:Math.round(((Date.now()-st.mtimeMs)/3.6e6)*10)/10}))}',
  'catch(e){process.stdout.write(JSON.stringify({ok:false,',
  'reason:String(e.code||e.message)}))}',
].join("");
const statRun = await world.run("node", ["-e", STAT, QUOTA_TABLE]);
let stat;
try {
  stat = JSON.parse(String(statRun.stdout ?? "").trim());
} catch {
  stat = {
    ok: false,
    reason: `stat probe unreadable: ${String(statRun.stderr ?? statRun.stdout ?? "").trim().slice(0, 120) || "no output"}`,
  };
}
if (!stat.ok) {
  log(`${FAIL_OPEN} — the spend table could not be read (${stat.reason}).`);
  report({ failOpen: true, table: QUOTA_TABLE, reason: stat.reason });
  return {
    conclusion: `${FAIL_OPEN} — no readable spend table (${stat.reason}).`,
    failOpen: true,
    table: QUOTA_TABLE,
    tableAgeHours: null,
    forecasts: [],
    verified: ["an absent table ends the loop before any forecast is spent"],
    notCovered: ["the forecast — there is no table to forecast from"],
  };
}
const tableAgeHours = Number(stat.ageHours);
log(`spend table: ${stat.path} — ${stat.size} bytes, last write ${tableAgeHours}h ago`);
if (tableAgeHours > horizonHours) {
  log(`the table is older than the ${horizonHours}h horizon — run \`npm run record:quota\` to refresh it; this loop reads, it never writes`);
}

phase("Forecast each plan's exhaustion");

const res = await world.tabular("budget-gate", {
  table: QUOTA_TABLE,
  metric: "weightedSpend",
  horizon: String(horizonHours),
  group: "providerId", // the assumption the header notes
});
if (!res.ok) {
  // The refusal verbatim — the CLI's words, unshortened, are the report. The
  // loop ends here: nothing retried, nothing re-routed, routing unchanged.
  log(`${FAIL_OPEN} — budget-gate refused: ${res.reason}`);
  report({ failOpen: true, command: "budget-gate", refused: res.reason });
  return {
    conclusion: `${FAIL_OPEN} — ${res.reason}`,
    failOpen: true,
    command: "budget-gate",
    refused: res.reason,
    tableAgeHours,
    forecasts: [],
    verified: [`the refusal is reported verbatim: ${res.reason}`],
    notCovered: ["the forecast — the scorer refused, and the loop does not retry it"],
  };
}

const rows = Array.isArray(res.rows) ? res.rows : [];
const all = rows
  .map((row, i) => {
    const plan = String(pick(row, ["providerId", "plan", "group", "key", "id"]) ?? `row-${i + 1}`);
    // The exhaustion estimate, earliest edge first: an explicit hours field,
    // then the band object's lower edge, then a flat lower/p10 — the band's
    // conservative edge, not its center, is what a re-route decision gets.
    const bandObj = pick(row, ["band", "forecast"]);
    const estimates = [
      pick(row, ["exhaustHours", "hoursToExhaustion", "exhaustionHours", "exhaustsInHours", "etaHours", "hours"]),
      bandObj && typeof bandObj === "object" ? bandObj.lower ?? bandObj.p10 ?? bandObj.low : undefined,
      pick(row, ["lower", "p10", "low", "q10"]),
    ]
      .map(num)
      .filter((n) => !Number.isNaN(n));
    const lower = estimates.length ? estimates[0] : NaN;
    const mid = num(pick(row, ["p50", "mid", "estimate", "center"]));
    const upper = num(pick(row, ["upper", "p90", "high", "q90"]));
    const flag = pick(row, ["exhaustsWithinHorizon", "willExhaust", "exhausted"]);
    const withinHorizon =
      typeof flag === "boolean" ? flag : Number.isFinite(lower) ? lower <= horizonHours : null;
    return {
      plan,
      exhaustionHours: Number.isFinite(lower) ? lower : null,
      band: {
        lower: Number.isFinite(lower) ? lower : null,
        mid: Number.isFinite(mid) ? mid : null,
        upper: Number.isFinite(upper) ? upper : null,
      },
      withinHorizon, // true | false | null (row unreadable — shown, never guessed)
      recognized: estimates.length > 0 || typeof flag === "boolean",
      row, // raw, for the artifact
    };
  })
  .filter((f) => !planFilter || f.plan === planFilter);

if (all.length === 0) {
  log(`${FAIL_OPEN} — ${planFilter ? `plan ${planFilter} is not in the table` : "budget-gate returned no rows"}.`);
  report({ failOpen: true, rows: rows.length, plan: planFilter || null });
  return {
    conclusion: `${FAIL_OPEN} — nothing to forecast.`,
    failOpen: true,
    tableAgeHours,
    forecasts: [],
    verified: ["an empty answer ends the loop rather than forecasting from nothing"],
    notCovered: ["the forecast — the table named no plan"],
  };
}
const unrecognized = all.filter((f) => !f.recognized);
const crossings = all.filter((f) => f.withinHorizon === true);

phase("Report the bands; escalate the crossings");

// A per-plan table in the run stream, so the forecast is readable without
// opening the artifact.
const col = (s, n) => (String(s).length >= n ? String(s).slice(0, n) : String(s) + " ".repeat(n - String(s).length));
log(
  `plan                      exhaust    band              within ${horizonHours}h\n` +
    all
      .map((f) => {
        const bandText =
          f.band.upper != null
            ? `${cell(f.band.lower)}…${cell(f.band.upper)}`
            : cell(f.band.lower);
        const verdict = f.withinHorizon === true ? "ESCALATE" : f.withinHorizon === false ? "ok" : "unreadable";
        return `${col(f.plan, 26)}${col(cell(f.exhaustionHours), 11)}${col(bandText, 18)}${verdict}`;
      })
      .join("\n"),
);
for (const f of all) {
  report({
    plan: f.plan,
    exhaustionHours: f.exhaustionHours,
    band: f.band,
    withinHorizon: f.withinHorizon,
    recognized: f.recognized,
  });
}

// The ladder's whole point here: an owner answer can shift routing before a
// plan dies. One escalation per crossing plan, the row verbatim as evidence.
for (const f of crossings) {
  const h = f.exhaustionHours != null ? Math.max(0, Math.round(f.exhaustionHours)) : horizonHours;
  const answer = await escalate(
    `plan ${f.plan} forecasts exhaustion within ${h}h — re-route its tiers?`,
    JSON.stringify({ table: QUOTA_TABLE, tableAgeHours, horizonHours, exhaustionHours: f.exhaustionHours, row: f.row }),
    "quota-exhaustion",
  );
  f.ownerAnswer = String(answer ?? "").slice(0, 300) || null;
  report({ plan: f.plan, escalated: true, exhaustionHours: f.exhaustionHours, ownerAnswer: f.ownerAnswer });
}

const md = [
  `# Quota forecast — ${horizonHours}h horizon`,
  "",
  `Table: \`${QUOTA_TABLE}\` — ${stat.size} bytes, last write ${tableAgeHours}h ago` +
    (tableAgeHours > horizonHours ? " — older than the horizon; refresh with `npm run record:quota`" : ""),
  `Scored by: dev-decisions \`budget-gate\` (sdm1 quantile band, batch — group providerId, the assumption noted in the source).`,
  `Plans: ${all.length}. Crossings escalated: ${crossings.length}. Unrecognized rows: ${unrecognized.length}.`,
  "",
  "| plan | exhaustion | band lower | band mid | band upper | within horizon |",
  "|---|---|---|---|---|---|",
  ...all.map(
    (f) =>
      `| ${f.plan} | ${cell(f.exhaustionHours)} | ${cell(f.band.lower)} | ${cell(f.band.mid)} | ${cell(f.band.upper)} | ` +
      `${f.withinHorizon === true ? "ESCALATE" : f.withinHorizon === false ? "no" : "unreadable"}${f.ownerAnswer != null ? ` — owner: ${f.ownerAnswer}` : ""} |`,
  ),
  "",
  "The exhaustion column is the band's lower (earliest) edge — the conservative reading a re-route decision gets.",
  "",
  "Raw rows, verbatim (an unrecognized row is shown, never guessed):",
  "```json",
  ...rows.map((r) => JSON.stringify(r)),
  "```",
].join("\n");
await artifact.markdown("quota-forecast", md, { title: `Quota forecast (${horizonHours}h)`, primary: true });

return {
  conclusion:
    `quota-forecast: ${all.length} plan(s) over a ${horizonHours}h horizon — ` +
    `${crossings.length} crossing(s) escalated, table ${tableAgeHours}h old.` +
    (unrecognized.length ? ` ${unrecognized.length} row(s) unrecognized, shown raw in the artifact.` : ""),
  horizonHours,
  tableAgeHours,
  forecasts: all.map(({ row, ...f }) => f),
  escalated: crossings.map((f) => f.plan),
  verified: [
    "the spend table was stat'd before use; its age is reported, and an over-horizon table says so",
    "every plan's band and exhaustion estimate is reported; a crossing escalates, and the owner's answer is carried",
    "an unrecognized row is reported raw, never guessed into a verdict",
  ],
  notCovered: [
    "the loop never writes the table and never re-routes a tier — re-routing is the owner's answer to act on",
    ...(unrecognized.length ? ["rows whose fields shipped in a shape this loop does not know — they ride raw into the artifact"] : []),
  ],
};
