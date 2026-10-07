/* workflow
description: "Floor calibration as a batch loop: dev-decisions' override-prior
  scores the kit's shared calibration store — the judge and swarm gates
  already feed it — into per-head override probabilities, and the loop
  renders each head's suggested confidence floor beside the roster's static
  ones (0.6 for agent asks, 0.4 for workflow escalations) as an artifact. It
  then asks the owner one question — apply these floors? — and does nothing
  else: v1 proposes and never writes, because learned floors crossing into
  the roster is the owner's `kit apply`, not a loop's. Deterministic
  tool-flow: no agents, no asks, no model calls. Fails open by name: no
  store to read or a refusing scorer ends the loop with the refusal verbatim
  and the static floors standing unchanged."
whenToUse: After enough judged runs have accrued in the calibration store,
  when the question is whether the roster's static confidence floors still
  fit. Run with `--grant tabular`. The loop has no roster write path — the
  proposal is the owner's to apply by editing the roster and running
  `kit apply`.
args: {}
*/
/**
 * calibrate-floors: the calibration store the kit already feeds, scored.
 *
 * Batch-only by the tabular lane's law — override-prior runs inside the
 * dev-decisions CLI between agent rounds, and this loop spawns no agents at
 * all. The fail-open law is the moli law: a machine without dev-decisions is
 * a configured absence, so the not-ok branch ends the loop with the
 * refusal's own words and the static floors standing unchanged.
 *
 * The one-way rule of the wave: v1 proposes, never writes. The loop renders
 * the proposal, escalates it, and stops — the roster's thresholds change
 * only through the owner's own apply path. The plan's C5 test greps this
 * file for the marker below, so it lives as its own line.
 */

// tabular-loops: this workflow has no roster write path

// The roster's static floors — the numbers every head is judged against
// today. Per-head floors do not exist in the roster yet; the statics are the
// standing numbers a proposal is rendered beside.
const STATIC_AGENT_FLOOR = 0.6; // roster routing.minConfidence — the agent-ask floor
const STATIC_WORKFLOW_FLOOR = 0.4; // roster routing.workflowMinConfidence — the escalation floor

const FAIL_OPEN = "floor calibration unavailable — the roster's static floors stand unchanged";

// Row fields override-prior may ship, read defensively: an unrecognized row
// is rendered as unrecognized and rides raw into the artifact — it is never
// guessed into a floor.
const pick = (row, names) => {
  for (const n of names) if (row && row[n] !== undefined && row[n] !== null) return row[n];
  return undefined;
};
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

phase("Read the override priors");

// No table argument: the calibration store is dev-decisions' own convention,
// the one its gate rows already write — the CLI knows where it lives.
const res = await world.tabular("override-prior");
if (!res.ok) {
  // The refusal verbatim — the CLI's words, unshortened, are the report.
  log(`${FAIL_OPEN} — override-prior refused: ${res.reason}`);
  report({ failOpen: true, command: "override-prior", refused: res.reason });
  return {
    conclusion: `${FAIL_OPEN} — ${res.reason}`,
    failOpen: true,
    command: "override-prior",
    refused: res.reason,
    proposal: [],
    verified: [`the refusal is reported verbatim: ${res.reason}`],
    notCovered: ["floor proposals — the scorer refused, and the loop does not retry it"],
  };
}

phase("Read the roster's static floors");

// The static floors come from the roster when the workspace has one, and
// from the documented literals when it does not — the loop reads, it never
// edits.
let staticFloors = {
  agent: STATIC_AGENT_FLOOR,
  workflow: STATIC_WORKFLOW_FLOOR,
  source: "the documented defaults (0.6 / 0.4) — no roster.json in the workspace",
};
try {
  const roster = JSON.parse(await files.read("roster.json"));
  const a = num(roster?.routing?.minConfidence);
  const w = num(roster?.routing?.workflowMinConfidence);
  if (Number.isFinite(a) || Number.isFinite(w)) {
    staticFloors = {
      agent: Number.isFinite(a) ? a : STATIC_AGENT_FLOOR,
      workflow: Number.isFinite(w) ? w : STATIC_WORKFLOW_FLOOR,
      source: "roster.json routing.minConfidence / routing.workflowMinConfidence",
    };
  }
} catch {
  /* no readable roster here — the defaults stand, and say so by name */
}
log(`static floors: agent asks ${staticFloors.agent}, workflow escalations ${staticFloors.workflow} (${staticFloors.source})`);

phase("Render the proposal");

const rows = Array.isArray(res.rows) ? res.rows : [];
const proposal = rows.map((row, i) => {
  const head = String(pick(row, ["head", "id", "name", "key"]) ?? `row-${i + 1}`);
  const suggested = num(pick(row, ["suggestedFloor", "floor", "suggested", "minConfidence", "threshold"]));
  const pOverride = num(pick(row, ["overrideProbability", "pOverride", "override", "p"]));
  const samples = num(pick(row, ["n", "samples", "count", "observations", "runs"]));
  return {
    head,
    // The current floor is the roster's static number that governs every
    // head today — per-head floors are exactly what this loop proposes.
    currentFloor: staticFloors.agent,
    suggestedFloor: Number.isFinite(suggested) ? suggested : null,
    overrideProbability: Number.isFinite(pOverride) ? pOverride : null,
    samples: Number.isFinite(samples) ? samples : null,
    recognized: Number.isFinite(suggested),
    row, // raw, for the artifact
  };
});

if (proposal.length === 0) {
  log(`${FAIL_OPEN} — override-prior returned no rows.`);
  report({ failOpen: true, rows: 0 });
  return {
    conclusion: `${FAIL_OPEN} — nothing to propose.`,
    failOpen: true,
    staticFloors: { agent: staticFloors.agent, workflow: staticFloors.workflow },
    proposal: [],
    verified: ["an empty answer ends the loop rather than proposing from nothing"],
    notCovered: ["floor proposals — the store named no head"],
  };
}
const unrecognized = proposal.filter((p) => !p.recognized);

const floor = (v) => (v == null ? "—" : String(v));
const col = (s, n) => (String(s).length >= n ? String(s).slice(0, n) : String(s) + " ".repeat(n - String(s).length));
log(
  `head                        current  suggested  samples\n` +
    proposal
      .map(
        (p) =>
          `${col(p.head, 28)}${col(floor(p.currentFloor), 9)}${col(floor(p.suggestedFloor), 11)}${p.samples ?? "—"}`,
      )
      .join("\n"),
);

const md = [
  `# Proposed confidence floors`,
  "",
  `Scored by: dev-decisions \`override-prior\` over the shared calibration store (batch — the judge and swarm gates already feed it).`,
  `Static floors today: agent asks ${staticFloors.agent}, workflow escalations ${staticFloors.workflow} (${staticFloors.source}).`,
  `Heads: ${proposal.length}. Unrecognized rows: ${unrecognized.length}.`,
  "",
  "| head | current floor (static) | suggested floor | override probability | samples |",
  "|---|---|---|---|---|",
  ...proposal.map(
    (p) =>
      `| ${p.head} | ${floor(p.currentFloor)} | ${floor(p.suggestedFloor)} | ` +
      `${p.overrideProbability != null ? p.overrideProbability : "—"} | ${p.samples ?? "—"} |`,
  ),
  "",
  "v1 proposes and never writes: this loop has no roster write path. Applying is the owner's — edit the roster's routing floors and run `kit apply`. The loop closes when the owner says apply.",
  "",
  "Raw rows, verbatim (an unrecognized row is shown, never guessed):",
  "```json",
  ...rows.map((r) => JSON.stringify(r)),
  "```",
].join("\n");
await artifact.markdown("floor-proposal", md, { title: "Proposed confidence floors", primary: true });

// The one escalation, and its text carries the law: the owner's answer does
// not make this loop write — it records the decision the owner then applies
// through their own path.
const answer = await escalate(
  "apply these floors to the roster? v1 does not write — this loop has no roster write path; applying is yours: edit the roster's routing floors and run `kit apply`.",
  JSON.stringify({
    staticFloors: { agent: staticFloors.agent, workflow: staticFloors.workflow, source: staticFloors.source },
    proposal: proposal.map(({ row, ...p }) => p),
  }),
  "calibrate-floors",
);
report({ escalated: true, question: "apply these floors to the roster?", ownerAnswer: String(answer ?? "").slice(0, 300) || null });

return {
  conclusion:
    `calibrate-floors: ${proposal.length} head(s) proposed beside the static floors ` +
    `(agent ${staticFloors.agent} / workflow ${staticFloors.workflow}) — nothing written; the apply is the owner's \`kit apply\`.` +
    (unrecognized.length ? ` ${unrecognized.length} row(s) unrecognized, shown raw in the artifact.` : ""),
  staticFloors: { agent: staticFloors.agent, workflow: staticFloors.workflow },
  proposal: proposal.map(({ row, ...p }) => p),
  ownerAnswer: String(answer ?? "").slice(0, 300) || null,
  verified: [
    "every head's override probability, suggested floor, and sample count is rendered beside the roster's static floors",
    "the proposal is an artifact and an escalation only — the marker `tabular-loops: this workflow has no roster write path` in the source holds",
    "the escalation's own text says v1 does not write and names the owner's apply path",
  ],
  notCovered: [
    "applying — the owner edits the roster and runs `kit apply`; the loop cannot and does not",
    ...(unrecognized.length ? ["rows whose fields shipped in a shape this loop does not know — they ride raw into the artifact"] : []),
  ],
};
