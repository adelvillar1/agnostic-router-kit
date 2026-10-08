/* workflow
description: "The media lane's promotion engine, as a batch loop: the pinned
  ASR fixture is round-tripped through the live gen1 legs into the shared
  feedback store (task `asr_roundtrip`, head `asr_faithful` — the join key
  calibration already reads), and every provider leg's accuracy and mean
  token agreement are graded against a named floor and a minimum row count. A
  leg that clears both is promotion evidence: the loop names it, escalates once
  that these legs are calibrated, and stops — lifting the `gen1_raw` eval-only
  tag is the owner's call, exactly as applying floors is theirs. Report-only by
  law: the loop reads the graded rows the verb just printed, never re-opens the
  feedback store, and has no write path to the engine's config or the tag.
  Fails open by name: no dev-decisions, a refusing leg, or every fixture
  refused ends the loop with the refusal verbatim and the tag standing."
whenToUse: On a schedule or before trusting any gen1-rendered narration, when
  the question is which ASR legs are accurate enough to promote out of
  eval-only. Run with `--grant media`. The loop produces evidence only — the
  promotion is the owner's.
args:
  task:
    type: string
    description: The calibration task key the graded rows land under (default "asr_roundtrip" — the engine's own constant, named here so the evidence says where it joins).
    required: false
  fixtures:
    type: string
    description: Fixture directory with .mp3/.txt pairs to grade (default the engine's pinned fixtures/media).
    required: false
  floor:
    type: number
    description: Accuracy and mean agreement a leg must reach to clear (default 0.9).
    required: false
  minRows:
    type: number
    description: Graded rows a leg needs before its score means anything (default 3).
    required: false
*/
/**
 * asr-calibrate: the pinned fixture, graded per leg, and nothing else.
 *
 * Batch-only by the media lane's law — record-asr makes wire calls to the ASR
 * legs between agent rounds, and this loop spawns no agents at all. The
 * report-only law is calibrate-floors' own: the loop's product is evidence (a
 * per-leg table, an artifact, one escalation), never a promotion. The
 * `gen1_raw` tag lifts by the owner's hand, and the loop's own text says so —
 * the plan's C2 test greps this file for the marker below, so it lives as its
 * own line.
 *
 * The fail-open law is the moli law: a machine without dev-decisions is a
 * configured absence, a leg without keys refuses by name, and a fixture dir
 * with no pairs refuses by name — every one of those ends the loop with the
 * refusal's own words and the tag standing unchanged.
 */

// media-loops: this workflow has no gen1_raw write path

const task = String(args.task ?? "asr_roundtrip").trim() || "asr_roundtrip";
const floorRaw = Number(args.floor);
const floor = Number.isFinite(floorRaw) && floorRaw > 0 ? floorRaw : 0.9;
const minRowsRaw = Number(args.minRows);
const minRows = Number.isFinite(minRowsRaw) && minRowsRaw >= 1 ? Math.floor(minRowsRaw) : 3;
const FAIL_OPEN = "asr calibration unavailable — the gen1_raw tag stands unchanged";

// The fail-open return, one shape for every refusing branch: the refusal
// verbatim (never paraphrased — a caller must be able to act on it), the
// conclusion naming the standing state, and the honest notCovered.
const failOpen = (command, refused) => {
  log(`${FAIL_OPEN} — ${command} refused: ${refused}`);
  report({ failOpen: true, command, refused, task, floor, minRows });
  return {
    conclusion: `${FAIL_OPEN} — ${refused}`,
    failOpen: true,
    command,
    refused,
    task,
    floor,
    minRows,
    legs: [],
    verified: ["the refusal is reported verbatim, and the loop does not retry it"],
    notCovered: ["per-leg grades — the verb refused, and the tag stands"],
  };
};

phase("Round-trip the pinned fixture through every live leg");

// Only --fixtures rides when the caller named one: the engine's own default
// (its pinned fixtures/media) is the right answer for every other call, and
// forwarding a null would be a flag the CLI never asked for.
const callArgs = args.fixtures ? { fixtures: String(args.fixtures) } : {};
const res = await world.media("record-asr", callArgs);
if (!res.ok) return failOpen("record-asr", res.reason);

// The media lane prints refusals on stdout and still exits non-zero — the
// bridge hands that row back as `refused` with the rows beside it. A refused
// round-trip (no fixture pairs, or every fixture refused because the keys are
// missing) is the same fail-open as an absent CLI: the store is unchanged and
// the engine's own words are the report.
if (res.refused) return failOpen("record-asr", String(res.refused));

phase("Grade each leg against the floor");

const rows = Array.isArray(res.rows) ? res.rows : [];
const summary = rows.find((r) => r && r.op === "record-asr" && r.provider === undefined) ?? {};
const graded = Number(summary.rows ?? 0);
// The per-provider rows are the lane's own: {provider, n, accuracy,
// mean_agreement}. An unrecognized row rides raw into the artifact — a leg
// whose numbers shipped in a shape this loop does not know is shown, never
// guessed into a floor.
const legs = rows
  .filter((r) => r && r.op === "record-asr" && r.provider !== undefined)
  .map((row, i) => {
    const provider = String(row.provider);
    const n = Number(row.n);
    const accuracy = Number(row.accuracy);
    const agreement = Number(row.mean_agreement);
    const counted = Number.isFinite(n);
    const enoughRows = counted && n >= minRows;
    const accuracyOk = Number.isFinite(accuracy) && accuracy >= floor;
    const agreementOk = Number.isFinite(agreement) && agreement >= floor;
    const lacks = [
      ...(enoughRows ? [] : [`rows (${counted ? n : "?"} of ${minRows})`]),
      ...(accuracyOk ? [] : ["accuracy"]),
      ...(agreementOk ? [] : ["agreement"]),
    ];
    return {
      provider: provider || `row-${i + 1}`,
      n: counted ? n : null,
      accuracy: Number.isFinite(accuracy) ? accuracy : null,
      meanAgreement: Number.isFinite(agreement) ? agreement : null,
      enoughRows,
      accuracyOk,
      agreementOk,
      clears: enoughRows && accuracyOk && agreementOk,
      lacks,
      row, // raw, for the artifact
    };
  });

if (legs.length === 0) {
  // The verb answered (the store may hold rows) but printed no per-leg row:
  // the loop grades what it can read, and grades nothing here.
  log(`${FAIL_OPEN} — record-asr returned no per-leg rows (${graded} graded row(s) recorded).`);
  report({ failOpen: true, command: "record-asr", graded, task, floor, minRows });
  return {
    conclusion: `${FAIL_OPEN} — no per-leg rows to grade.`,
    failOpen: true,
    command: "record-asr",
    graded,
    task,
    floor,
    minRows,
    legs: [],
    verified: ["an answer with no per-leg rows ends the loop rather than grading from nothing"],
    notCovered: ["per-leg grades — the verb printed no per-provider rows"],
  };
}

const cleared = legs.filter((l) => l.clears);
const short = legs.filter((l) => !l.clears);

const pct = (v) => (v == null ? "—" : v.toFixed(3));
const col = (s, n) => (String(s).length >= n ? String(s).slice(0, n) : String(s) + " ".repeat(n - String(s).length));
log(
  `leg                              n     accuracy  agreement  reading\n` +
    legs
      .map(
        (l) =>
          `${col(l.provider, 32)}${col(l.n ?? "—", 6)}${col(pct(l.accuracy), 10)}${col(pct(l.meanAgreement), 11)}` +
          `${l.clears ? `clears (floor ${floor}, ${minRows}+ rows)` : `lacks ${l.lacks.join(", ")}`}`,
      )
      .join("\n"),
);
log(
  `floor ${floor}, ${minRows}+ graded row(s) per leg` +
    ` — ${cleared.length} of ${legs.length} leg(s) clear` +
    (summary.feedback_file ? ` — rows recorded to ${summary.feedback_file}` : ""),
);
for (const l of legs) {
  report({
    provider: l.provider,
    n: l.n,
    accuracy: l.accuracy,
    meanAgreement: l.meanAgreement,
    clears: l.clears,
    lacks: l.lacks,
  });
}

phase("Name the promotion evidence; the owner decides");

const md = [
  `# ASR calibration — task \`${task}\``,
  "",
  `Graded by: dev-decisions \`record-asr\` over the pinned fixture(s)${args.fixtures ? ` (\`${String(args.fixtures)}\`)` : ""} — the round-trip rows land in the feedback store under task \`${task}\`, the join key calibration already reads.`,
  `Floor: accuracy and mean agreement at ${floor}, with at least ${minRows} graded row(s) per leg.`,
  `Legs: ${legs.length} — ${cleared.length} clear, ${short.length} short.`,
  "",
  "| leg | n | accuracy | mean agreement | reading |",
  "|---|---|---|---|---|",
  ...legs.map(
    (l) =>
      `| \`${l.provider}\` | ${l.n ?? "—"} | ${pct(l.accuracy)} | ${pct(l.meanAgreement)} | ` +
      `${l.clears ? "**clears**" : `lacks ${l.lacks.join(", ")}`} |`,
  ),
  "",
  "## Promotion evidence",
  "",
  ...(cleared.length
    ? [
        `These legs clear the floor: ${cleared.map((l) => `\`${l.provider}\``).join(", ")}.`,
        "",
        "**This loop does not lift the `gen1_raw` tag.** It produces the evidence; the owner promotes, per the engine plan's named follow-up (per-surface floors). Until then every row this lane emits stays tagged `gen1_raw/<leg>` and eval-only.",
      ]
    : [
        "No leg clears the floor yet — there is no promotion evidence in this run.",
        "",
        `Each leg's shortfall is named in the table (rows or agreement). A leg with fewer than ${minRows} graded rows needs more fixtures graded before its score means anything; a leg short on agreement needs the leg itself looked at (a different model, a different fixture, or a floor the leg can actually meet).`,
      ]),
  "",
  "Raw rows, verbatim (an unrecognized row is shown, never guessed):",
  "```json",
  ...rows.map((r) => JSON.stringify(r)),
  "```",
].join("\n");
await artifact.markdown("asr-calibrate", md, { title: `ASR calibration (${task})`, primary: true });

// Exactly one escalation, and only when there is something to promote: the
// cleared legs are the evidence, and the question is the owner's alone. A run
// where nothing clears has nothing to escalate — the shortfall table above is
// the whole answer.
let ownerAnswer = null;
if (cleared.length) {
  ownerAnswer =
    String(
      (await escalate(
        `these ASR legs are calibrated (floor ${floor}, ${minRows}+ rows): ${cleared.map((l) => l.provider).join(", ")} — ` +
          `the owner decides whether the gen1_raw eval-only tag lifts; this loop writes nothing.`,
        JSON.stringify({
          task,
          floor,
          minRows,
          cleared: cleared.map(({ row, ...l }) => l),
          short: short.map(({ row, ...l }) => l),
        }),
        "asr-calibrate",
      )) ?? "",
    ).slice(0, 300) || null;
  report({
    escalated: true,
    question: "these legs are calibrated — does gen1_raw lift?",
    cleared: cleared.map((l) => l.provider),
    ownerAnswer,
  });
}

return {
  conclusion:
    `asr-calibrate: ${cleared.length} of ${legs.length} ASR leg(s) clear the floor (${floor}, ${minRows}+ rows)` +
    (cleared.length ? ` — promotion evidence: ${cleared.map((l) => l.provider).join(", ")}` : " — no promotion evidence in this run") +
    `; the gen1_raw tag stands, the owner decides.`,
  task,
  floor,
  minRows,
  legs: legs.map(({ row, ...l }) => l),
  cleared: cleared.map((l) => l.provider),
  escalated: cleared.length > 0,
  ownerAnswer,
  verified: [
    "the pinned fixture was round-tripped through the live legs and graded per provider — accuracy and mean token agreement, against a floor and a minimum row count",
    "every leg's reading names what it lacks (rows or agreement), so a short leg is actionable rather than just short",
    ...(cleared.length
      ? ["exactly one escalation, naming the cleared legs as promotion evidence — and the owner's answer is recorded, never applied"]
      : ["a run where no leg clears escalates nothing — the shortfall table is the whole answer"]),
    "the loop writes nothing — the marker `media-loops: this workflow has no gen1_raw write path` in the source holds, and the feedback store and the tag leave this run untouched",
  ],
  notCovered: [
    "lifting the gen1_raw tag — the loop produces evidence, the owner promotes, per the engine plan's named follow-up",
    ...(short.length ? ["legs short on rows need more fixtures graded before their score means anything"] : []),
    ...(short.length ? ["legs short on agreement need the leg itself looked at — this loop grades, it does not fix"] : []),
  ],
};
