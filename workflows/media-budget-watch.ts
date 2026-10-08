/* workflow
description: "Media spend watched as a batch loop: gen1's telemetry sink is
  ingested into the tabular lane's media-seconds table (occurrence-keyed, so a
  re-run lands nothing twice), and the next day's audio-seconds are forecast
  per provider through sdm1 against a named budget. A provider with fewer than
  four recorded days degrades to recorded stats with the reason named — never
  a fabricated band — and degradation never escalates: a named reason is
  information, not a crossing. An estimate over the budget is reported and
  escalated exactly once. Report-only by law: the loop writes nothing of its
  own — the ingest verb owns its table — and it reads no file, so the
  forecast is the engine's row, never the loop's arithmetic. Fails open by
  name: no dev-decisions, no telemetry sink, or an empty table ends the loop
  with the refusal verbatim and the spend unjudged."
whenToUse: Daily after the render cadence, or before a batch of narration
  work, when the question is what the next day's media seconds cost and
  whether they fit the budget. Run with `--grant media`. The daily ingest is
  `npm run record:media`; this loop is the reading of what that cadence lands.
args:
  budgetSeconds:
    type: number
    description: Next-day media-seconds budget; the estimate over it is the one escalation. Absent = report only, no crossing judged.
    required: false
  scope:
    type: string
    description: Comma-separated provider tags to report on (default every provider in the row). A view filter, never the math: the estimate stays the engine's whole-provider number.
    required: false
  telemetry:
    type: string
    description: gen1 telemetry JSONL to ingest (default the engine's own sink: GEN1_TELEMETRY_FILE or ~/.config/gen1/telemetry.jsonl).
    required: false
*/
/**
 * media-budget-watch: the media-seconds table, forecast and judged.
 *
 * Batch-only by the media lane's law — record-media-runs and media-budget both
 * run inside the dev-decisions CLI between agent rounds, and this loop spawns
 * no agents at all. Two steps, in the engine's own order: ingest first (the
 * table the forecast reads is the table the ingest just wrote), then forecast.
 *
 * The report-only law is the lane's own and it has a wrinkle worth stating
 * plainly: this loop's first step DOES write — through the engine's ingest
 * verb, which owns its table and is accountable for every row it lands. The
 * loop itself writes nothing: no file, no config, no arithmetic of its own
 * over the engine's numbers. When a caller names a `scope`, the loop filters
 * the view and says so; it never recomputes the estimate, because the row
 * does not carry the per-provider values a scoped estimate would need — a
 * number the loop could not derive honestly is a number it does not print.
 *
 * The escalation law: `over` is a crossing and escalates once; `degraded` is
 * information and never escalates. The loop's fail-open law is the moli law —
 * no CLI, no sink, or an empty table ends the loop with the refusal's own
 * words and the spend unjudged.
 */

// media-loops: this workflow writes nothing of its own — the ingest verb owns its table

const budgetRaw = Number(args.budgetSeconds);
const budget = Number.isFinite(budgetRaw) && budgetRaw >= 0 ? budgetRaw : null;
const scopeRaw = String(args.scope ?? "").trim();
const scope = scopeRaw ? scopeRaw.split(",").map((s) => s.trim()).filter(Boolean) : null;
const FAIL_OPEN = "media budget unavailable — the spend is unjudged";

// One fail-open shape for every refusing branch: the refusal verbatim (a
// caller must be able to act on it), the conclusion naming the standing state.
const failOpen = (command, refused) => {
  log(`${FAIL_OPEN} — ${command} refused: ${refused}`);
  report({ failOpen: true, command, refused, budget });
  return {
    conclusion: `${FAIL_OPEN} — ${refused}`,
    failOpen: true,
    command,
    refused,
    budget,
    bands: {},
    estimateTotalS: null,
    degraded: [],
    escalated: false,
    verified: ["the refusal is reported verbatim, and the loop does not retry it"],
    notCovered: ["the media-seconds forecast — the verb refused, and no number is invented in its place"],
  };
};

phase("Ingest gen1's telemetry sink");

// Only --telemetry rides when the caller named one: the engine's own sink is
// the right answer for every other call.
const ingestArgs = args.telemetry ? { telemetry: String(args.telemetry) } : {};
const ingest = await world.media("record-media-runs", ingestArgs);
if (!ingest.ok) return failOpen("record-media-runs", ingest.reason);
// The lane prints refusals on stdout and still exits non-zero — the bridge
// hands that row back as `refused`. A missing sink is the engine's own words:
// "run a speak/transcribe first".
if (ingest.refused) return failOpen("record-media-runs", String(ingest.refused));

const ingestRow = ingest.rows.find((r) => r && r.op === "record-media-runs") ?? {};
const rowsNew = Number(ingestRow.rows_new ?? 0);
const rowsDuplicate = Number(ingestRow.rows_duplicate ?? 0);
const rowsSkipped = Number(ingestRow.rows_skipped ?? 0);
log(
  `ingest: ${ingestRow.lines_total ?? 0} line(s) parsed — ${rowsNew} new, ${rowsDuplicate} duplicate(s), ${rowsSkipped} skipped` +
    (rowsNew === 0 && rowsDuplicate > 0 ? " (already ingested — occurrence-keyed, a re-run lands nothing twice)" : "") +
    (rowsSkipped > 0 ? ` (${rowsSkipped} corrupt line(s) skipped by name, never fatal)` : ""),
);
report({
  ingested: true,
  rowsNew,
  rowsDuplicate,
  rowsSkipped,
  providers: String(ingestRow.provider ?? "none"),
  target: String(ingestRow.target ?? ""),
});

phase("Forecast the next day's media seconds");

// Only --budget-seconds rides when a budget was named: absent means report
// only, and the engine's row says so with budget_s null.
const budgetArgs = budget !== null ? { "budget-seconds": budget } : {};
const res = await world.media("media-budget", budgetArgs);
if (!res.ok) return failOpen("media-budget", res.reason);
if (res.refused) return failOpen("media-budget", String(res.refused));

const row = res.rows.find((r) => r && r.op === "media-budget") ?? {};
const bandsRaw = row.bands && typeof row.bands === "object" ? row.bands : {};
const degradedRaw = Array.isArray(row.degraded) ? row.degraded.map(String) : [];
const estimate = Number(row.estimate_total_s);
const verdict = String(row.verdict ?? "pass");
const over = verdict === "over";

// The degraded entries are the engine's own "provider: reason" strings —
// split on the first colon, and a reason with no provider in front of it is
// kept whole rather than guessed into a provider.
const degraded = degradedRaw.map((entry) => {
  const at = entry.indexOf(":");
  return at > 0 ? { provider: entry.slice(0, at).trim(), reason: entry.slice(at + 1).trim() } : { provider: null, reason: entry };
});

// A scoped view: the providers the caller asked about, named as in-scope, and
// the row's other providers named as out-of-scope rather than dropped. The
// estimate is the engine's whole-provider number and stays labelled as one.
const bandProviders = Object.keys(bandsRaw);
const degradedProviders = degraded.map((d) => d.provider).filter(Boolean);
const knownProviders = [...new Set([...bandProviders, ...degradedProviders])];
const inScope = scope ? knownProviders.filter((p) => scope.includes(p)) : knownProviders;
const outOfScope = scope ? knownProviders.filter((p) => !scope.includes(p)) : [];
const unknownScope = scope ? scope.filter((p) => !knownProviders.includes(p)) : [];
const scopedBands = inScope.filter((p) => bandsRaw[p]);
const scopedDegraded = degraded.filter((d) => inScope.includes(d.provider));

phase("Report the bands, the estimate, and the crossing");

const secs = (v) => (Number.isFinite(v) ? `${Number(v).toFixed(1)}s` : "—");
log(
  `next-day estimate ${secs(estimate)}` +
    (budget !== null ? ` vs budget ${secs(budget)} → ${over ? "OVER" : "within"}` : " (no budget named — report only)") +
    ` — ${bandProviders.length} banded, ${degraded.length} degraded`,
);
for (const p of scopedBands) {
  const b = bandsRaw[p] ?? {};
  log(`  ${p}: next-day band ${secs(b.lo)}–${secs(b.hi)} (median ${secs(b.median)})`);
}
for (const d of scopedDegraded) log(`  ${d.provider ?? "(unnamed)"}: degraded — ${d.reason}`);
if (outOfScope.length) log(`  out of scope: ${outOfScope.join(", ")}`);
for (const p of unknownScope) log(`  scope names ${p}, which this run's rows never mention`);
for (const p of scopedBands) report({ provider: p, band: bandsRaw[p], inScope: true });
for (const d of scopedDegraded) report({ provider: d.provider, degraded: d.reason, inScope: true });

const md = [
  `# Media budget — next-day audio seconds`,
  "",
  `Ingested from \`${String(ingestRow.target ?? "the engine's own sink")}\` into \`${String(row.target ?? "the media_runs table")}\` — ${rowsNew} new row(s), ${rowsDuplicate} duplicate(s) skipped, ${rowsSkipped} skipped.`,
  `Forecast by: dev-decisions \`media-budget\` through sdm1 (task \`${String(row.task ?? "media_budget_forecast")}\`).`,
  budget !== null
    ? `Budget: **${secs(budget)}** — next-day estimate **${secs(estimate)}** → ${over ? "**OVER**" : "within"}.`
    : `No budget named — report only. Next-day estimate **${secs(estimate)}**.`,
  "",
  ...(scope ? [`Scope: ${scope.join(", ")} — a view filter over the row's providers, never the math.`] : []),
  "",
  "| provider | next-day band | median | reading |",
  "|---|---|---|---|",
  ...scopedBands.map((p) => {
    const b = bandsRaw[p] ?? {};
    return `| \`${p}\` | ${secs(b.lo)}–${secs(b.hi)} | ${secs(b.median)} | banded |`;
  }),
  ...scopedDegraded.map((d) => `| \`${d.provider ?? "(unnamed)"}\` | — | — | degraded — ${d.reason} |`),
  ...(outOfScope.length ? [`| _out of scope_ | ${outOfScope.join(", ")} | | |`] : []),
  ...(unknownScope.length ? [`| _not in this run's rows_ | ${unknownScope.join(", ")} | | |`] : []),
  "",
  ...(degraded.length
    ? [
        "Degraded is information, not a crossing: a provider with fewer than four recorded days has no band, and the engine says so by name rather than returning a fabricated one. The daily cadence is what earns a band — `npm run record:media` every day, and four days is four days.",
      ]
    : []),
  "",
  over
    ? "**The estimate is over the budget.** This loop reports the crossing and escalates it once; it does not throttle, queue, or refuse a render. Trimming is the owner's call."
    : "",
  "",
  "The estimate is the engine's whole-provider number, verbatim from the row. This loop recomputes nothing — a scoped view filters what is shown, and the row does not carry the per-provider values a scoped estimate would need.",
  "",
  "Raw row, verbatim:",
  "```json",
  JSON.stringify(row, null, 1),
  "```",
].join("\n");
await artifact.markdown("media-budget-watch", md, { title: "Media budget (next-day seconds)", primary: true });

// Exactly one escalation, and only for a crossing: an estimate over the named
// budget. A degraded provider is a named reason, not a crossing, and a run
// with no budget named has nothing to cross.
let ownerAnswer = null;
if (over) {
  ownerAnswer =
    String(
      (await escalate(
        `next-day media-seconds estimate ${secs(estimate)} is over the ${secs(budget)} budget` +
          `${bandProviders.length ? ` (banded: ${bandProviders.join(", ")})` : ""}` +
          `${degraded.length ? ` (${degraded.length} degraded, no band)` : ""}` +
          ` — the owner decides what to trim; this loop only reports.`,
        JSON.stringify({
          estimateTotalS: Number.isFinite(estimate) ? estimate : null,
          budgetS: budget,
          bands: bandsRaw,
          degraded,
          verdict,
          scope: scope ?? null,
        }),
        "media-budget-watch",
      )) ?? "",
    ).slice(0, 300) || null;
  report({
    escalated: true,
    question: "the next-day estimate is over budget — what gets trimmed?",
    estimateTotalS: Number.isFinite(estimate) ? estimate : null,
    budgetS: budget,
    ownerAnswer,
  });
}

return {
  conclusion:
    `media-budget-watch: next-day estimate ${secs(estimate)}` +
    (budget !== null ? ` vs budget ${secs(budget)} → ${over ? "OVER" : "within"}` : " (report only)") +
    ` — ${bandProviders.length} banded, ${degraded.length} degraded` +
    (over ? "; escalated once, the trim is the owner's" : "; no crossing to escalate") +
    ".",
  budget,
  scope: scope ?? null,
  estimateTotalS: Number.isFinite(estimate) ? estimate : null,
  budgetS: row.budget_s ?? null,
  bands: bandsRaw,
  degraded,
  bandedProviders: bandProviders,
  outOfScope,
  unknownScope,
  verdict,
  over,
  escalated: over,
  ownerAnswer,
  ingested: { rowsNew, rowsDuplicate, rowsSkipped },
  verified: [
    `the telemetry sink was ingested first (${rowsNew} new, ${rowsDuplicate} duplicate(s)) — occurrence-keyed, so the daily cadence never double-charges`,
    ...(budget !== null
      ? [`the conclusion carries the estimate against the budget: ${secs(estimate)} vs ${secs(budget)}`]
      : ["no budget was named, so nothing was judged a crossing — report only"]),
    ...(over
      ? ["exactly one escalation, for the crossing alone — the loop reports it and trims nothing"]
      : ["nothing crossed a budget, so nothing escalated — a degraded provider is a named reason, not a crossing"]),
    "the loop writes nothing of its own — the marker `media-loops: this workflow writes nothing of its own` in the source holds, and the estimate is the engine's row verbatim",
  ],
  notCovered: [
    "throttling, queueing, or refusing a render — the loop reports a crossing and stops; the trim is the owner's",
    "a scoped estimate — the row carries no per-provider values, so a scoped number would be invented, and this loop prints none",
    ...(degraded.length
      ? [`bands for ${degraded.map((d) => d.provider ?? "(unnamed)").join(", ")} — fewer than four recorded days, and the reason is the engine's own`]
      : []),
  ],
};
