/* workflow
description: "Flake watch as a batch loop: the probe-outcomes table every
  `npm test` appends to is scored by dev-decisions' history-gate, and the
  loop reports each suite's run count, flake probability, and a
  chase-or-quarantine verdict — naming, for any suite that both failed
  recently and scores as a high-probability flake, that it is the likely
  known flake: quarantine, don't chase. Report-only by design — quarantine
  is an owner decision, because it changes what green means for every future
  run, so v1 never escalates, never edits CI, never silences anything.
  Deterministic tool-flow: no agents, no asks, no model calls. Fails open by
  name: no table or a refusing scorer ends the loop with the refusal
  verbatim and every suite chased exactly as today."
whenToUse: After probe runs or on a schedule, when the question is which
  suites are flaky rather than broken. Run with `--grant tabular`. The loop
  only reads — `npm test` (through run-probes) is what grows the table.
args:
  suites:
    type: string
    description: Comma-separated suite-name filters (substring match) — omit to score every suite the table declares.
    required: false
*/
/**
 * flake-watch: the outcomes table the kit already produces, scored.
 *
 * Batch-only by the tabular lane's law — history-gate's per-suite flake
 * scoring runs inside the dev-decisions CLI between agent rounds, and this
 * loop spawns no agents at all. The fail-open law is the moli law: a machine
 * without dev-decisions is a configured absence, so the not-ok branch ends
 * the loop with the refusal's own words and the standing behavior — every
 * suite chased exactly as today.
 *
 * v1 is report-only on purpose. Quarantine moves a suite out of the default
 * gate, which redefines "green" for everyone downstream — a call the loop
 * has no mandate to make, so it does not escalate it either. The report
 * names the likely known flake; the owner decides what happens to it. A
 * later wave may let review-sweep consume this table; this file stays a
 * read of it.
 */

// The store path literal, once: dev-decisions' own store convention, passed
// to the CLI verbatim — execFile spawns no shell, so the tilde is the CLI's
// to resolve.
const OUTCOMES_TABLE = "~/.local/share/dev-decisions/tables/probe-outcomes.csv";

// The loop's own line, not dev-decisions': the plan's example known flake
// scores 0.87, but the exact threshold where "chase" becomes "quarantine" is
// a review knob, so it is named here rather than inherited silently.
const QUARANTINE_ABOVE = 0.5;

const terms = String(args.suites ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const FAIL_OPEN = "flake scores unavailable — no verdicts this run; every suite is chased exactly as today";

// Row fields history-gate may ship, read defensively: an unrecognized field
// is reported as absent rather than guessed.
const pick = (row, names) => {
  for (const n of names) if (row && row[n] !== undefined && row[n] !== null) return row[n];
  return undefined;
};
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};
const pct = (p) => (p == null ? "?" : `${Math.round(p * 100)}%`);

phase("Score the probe outcomes");

const res = await world.tabular("history-gate", { table: OUTCOMES_TABLE });
if (!res.ok) {
  // The refusal verbatim — the CLI's words, unshortened, are the report.
  log(`${FAIL_OPEN} — history-gate refused: ${res.reason}`);
  report({ failOpen: true, command: "history-gate", refused: res.reason });
  return {
    conclusion: `${FAIL_OPEN} — ${res.reason}`,
    failOpen: true,
    command: "history-gate",
    refused: res.reason,
    suites: [],
    verified: [`the refusal is reported verbatim: ${res.reason}`],
    notCovered: ["flake verdicts — the scorer refused, and the loop does not retry it"],
  };
}

const rows = Array.isArray(res.rows) ? res.rows : [];
const scored = rows
  .map((row, i) => {
    const suite = String(pick(row, ["suite", "name", "key", "id"]) ?? `row-${i + 1}`);
    if (terms.length && !terms.some((t) => suite.includes(t))) return null;
    const runs = num(pick(row, ["runs", "n", "samples", "count", "observations"]));
    const p = num(pick(row, ["flakeProbability", "flake", "probability", "pFlake", "p"]));
    const failed = num(pick(row, ["failed", "failures", "recentFailures", "failedRuns"]));
    const given = String(pick(row, ["verdict", "gate", "decision"]) ?? "")
      .trim()
      .toLowerCase();
    const verdict =
      given === "chase" || given === "quarantine"
        ? given
        : Number.isFinite(p)
          ? p >= QUARANTINE_ABOVE
            ? "quarantine"
            : "chase"
          : "unreadable";
    return {
      suite,
      runs: Number.isFinite(runs) ? runs : null,
      flakeProbability: Number.isFinite(p) ? p : null,
      failedRecently: Number.isFinite(failed) ? failed : null,
      verdict,
      // The known-flake signature: failed AND flaky is an intermittent suite,
      // not a regression to chase — the report says so by name.
      likelyKnownFlake: verdict === "quarantine" && Number.isFinite(failed) && failed > 0,
      row, // raw, for the artifact
    };
  })
  .filter((s) => s !== null);

if (scored.length === 0) {
  log(`${FAIL_OPEN} — ${rows.length === 0 ? "history-gate returned no rows" : "the filter matched no suite"}.`);
  report({ failOpen: true, rows: rows.length, filter: terms.join(",") || null });
  return {
    conclusion: `${FAIL_OPEN} — nothing to score.`,
    failOpen: true,
    suites: [],
    verified: ["an empty answer ends the loop rather than verdicting from nothing"],
    notCovered: ["flake verdicts — the table named no suite"],
  };
}
const known = scored.filter((s) => s.likelyKnownFlake);
const unreadable = scored.filter((s) => s.verdict === "unreadable");

phase("Report the verdicts");

const col = (s, n) => (String(s).length >= n ? String(s).slice(0, n) : String(s) + " ".repeat(n - String(s).length));
log(
  `suite                      runs  flake p  verdict\n` +
    scored
      .map(
        (s) =>
          `${col(s.suite, 27)}${col(s.runs ?? "—", 6)}${col(pct(s.flakeProbability), 9)}${s.verdict}` +
          (s.likelyKnownFlake ? "  ← likely the known flake" : ""),
      )
      .join("\n"),
);
for (const s of known) {
  log(`${s.suite}: ${pct(s.flakeProbability)} flake with recent failures — the likely known flake; quarantine, don't chase`);
}
for (const s of scored) {
  report({
    suite: s.suite,
    runs: s.runs,
    flakeProbability: s.flakeProbability,
    failedRecently: s.failedRecently,
    verdict: s.verdict,
    likelyKnownFlake: s.likelyKnownFlake,
  });
}

const md = [
  `# Flake watch`,
  "",
  `Table: \`${OUTCOMES_TABLE}\` — scored by dev-decisions \`history-gate\` (batch).`,
  `Suites: ${scored.length}. Quarantine: ${scored.filter((s) => s.verdict === "quarantine").length}. Likely known flakes: ${known.length}. Unreadable rows: ${unreadable.length}.`,
  `Quarantine line: flake probability at or above ${QUARANTINE_ABOVE} — this loop's own default, a review knob, not dev-decisions'.`,
  "",
  "| suite | runs | flake probability | recent failures | verdict |",
  "|---|---|---|---|---|",
  ...scored.map(
    (s) =>
      `| ${s.suite} | ${s.runs ?? "—"} | ${s.flakeProbability != null ? pct(s.flakeProbability) : "?"} | ${s.failedRecently ?? "—"} | ` +
      `${s.verdict}${s.likelyKnownFlake ? " — likely the known flake: quarantine, don't chase" : ""} |`,
  ),
  "",
  known.length
    ? `The likely known flake${known.length > 1 ? "s" : ""}: ${known.map((s) => `${s.suite} (${pct(s.flakeProbability)})`).join(", ")}. Failed recently and scores flaky — an intermittent suite, not a regression to chase.`
    : "No suite carries both recent failures and a high flake probability — nothing reads as the known flake this run.",
  "",
  "Report-only by design: quarantine is an owner decision (it changes what green means for every future run), so this loop never escalates, never edits CI, never silences a suite.",
  "",
  "Raw rows, verbatim:",
  "```json",
  ...rows.map((r) => JSON.stringify(r)),
  "```",
].join("\n");
await artifact.markdown("flake-watch", md, { title: "Flake watch", primary: true });

return {
  conclusion:
    `flake-watch: ${scored.length} suite(s) scored — ${scored.filter((s) => s.verdict === "quarantine").length} at or above the quarantine line` +
    (known.length ? `, the likely known flake: ${known.map((s) => s.suite).join(", ")}.` : ".") +
    (unreadable.length ? ` ${unreadable.length} row(s) unreadable, shown raw in the artifact.` : ""),
  suites: scored.map(({ row, ...s }) => s),
  likelyKnownFlakes: known.map((s) => s.suite),
  verified: [
    "every scored suite carries runs, flake probability, and a chase/quarantine verdict — from the row when it ships one, derived from the probability when it does not",
    "a suite with recent failures and a high flake probability is named the likely known flake, with the quarantine-not-chase reading",
    "the loop is report-only: no escalation, no CI edit, no silence — the marker comment in the source holds",
  ],
  notCovered: [
    "quarantine itself — an owner decision the loop reports toward but never makes",
    ...(unreadable.length ? ["rows whose fields shipped in a shape this loop does not know — they ride raw into the artifact"] : []),
  ],
};
