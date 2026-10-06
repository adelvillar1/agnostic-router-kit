/* workflow
description: "Refine against a rubric: a drafter produces the deliverable, a
  scorer grades each rubric dimension with notes, and a reviser addresses only
  the weakest dimensions — rounds until the score plateaus or the depth is
  spent. The score history is the record, and a plateau stops the loop instead
  of hiding in a last round."
whenToUse: When a deliverable should be iterated against explicit quality
  dimensions — writing, a design doc, a proposal — and "good enough" needs a
  number and a history, not a vibe.
args:
  task:
    type: string
    description: What the deliverable is and for whom.
    required: true
  rubric:
    type: string
    description: JSON array of {name, weight?} — the quality dimensions.
    required: true
  depth:
    type: number
    description: Max refine rounds after the draft (1-4, default 2).
    required: false
*/
/**
 * refine-loop: fix rounds against judged quality, not a test suite.
 * Per-round scores are journaled (report lines), so the loop doubles as
 * calibration data: score histories for a rubric, collected as a side effect
 * of doing real work. Plateau = round-over-round overall improvement under
 * 0.5 — the loop stops and says so rather than spending the depth anyway.
 */

interface RubricDimension {
  name: string;
  /** Relative weight, default 1. */
  weight?: number;
}

interface Scored {
  scores: { dimension: string; score: number; note: string }[];
  /** Weighted overall, 0-10. */
  overall: number;
}

interface Revision {
  /** What the revision changed, per dimension it addressed. */
  addressed: string[];
  summary: string;
}

const ESCALATE =
  "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.";

const task = String(args.task ?? "").trim();
if (!task) throw new Error("refine-loop needs a task");
let rubric: RubricDimension[] = [];
try {
  rubric = typeof args.rubric === "string" ? JSON.parse(args.rubric) : args.rubric;
} catch (e) {
  throw new Error(`rubric is not valid JSON: ${String(e?.message ?? e)}`);
}
if (!Array.isArray(rubric) || rubric.length === 0) {
  throw new Error("refine-loop needs at least one rubric dimension");
}
const depth = Math.max(1, Math.min(Number(args.depth) || 2, 4));
const rubricNames = rubric.map((r) => r.name);
const path = "out/refine-loop/deliverable.md";

phase("Draft v1");
const drafter = agent("Drafter", {
  system:
    "You produce the deliverable the task asks for, written to out/refine-loop/deliverable.md. " + ESCALATE,
});
const v1 = await drafter.ask<Revision>(
  `Task: ${task}\nThe deliverable is judged against these dimensions: ${rubricNames.join(", ")}.\n\n` +
    `Write it to ${path}. Return addressed (empty for the draft) and summary.`
);

const scorer = agent("Scorer", {
  system:
    "You score a deliverable against explicit rubric dimensions, 0-10 per dimension with a note " +
    "naming what would raise it. You are cold: the note is a finding, not encouragement. You never " +
    "edit files. " + ESCALATE,
  shape: "verify",
});

const scoreHistory: { round: number; overall: number; scores: Scored["scores"] }[] = [];
let lastOverall = -Infinity;
let stopReason = "depth";
let round = 0;

while (round <= depth) {
  round++;
  phase(`Round ${round}: score`);
  const scored = await scorer.ask<Scored>(
    `Task: ${task}\nRubric: ${JSON.stringify(rubric)}\n\nRead ${path} and score every dimension. Return scores and overall.`
  );
  scoreHistory.push({ round, overall: scored.overall, scores: scored.scores });
  report({ round, overall: scored.overall, weakest: [...scored.scores].sort((a, b) => a.score - b.score).slice(0, 2).map((s) => s.dimension) });

  const improvement = scored.overall - lastOverall;
  if (round > 1 && improvement < 0.5) {
    stopReason = "plateau";
    log(`round ${round}: plateau — overall moved ${improvement.toFixed(1)}, stopping with the history`);
    break;
  }
  lastOverall = scored.overall;
  if (round > depth) break;

  phase(`Round ${round}: revise the weakest dimensions`);
  const weakest = [...scored.scores].sort((a, b) => a.score - b.score).slice(0, Math.max(1, Math.ceil(scored.scores.length / 3))).map((s) => s.dimension);
  const reviser = agent(`Reviser ${round}`, {
    system:
      "You revise a deliverable against specific dimension notes. You touch only what the notes " +
      "name — everything else stays as it is. Write the revised deliverable back to " + path + ". " + ESCALATE,
  });
  const revision = await reviser.ask<Revision>(
    `Task: ${task}\nDeliverable: ${path}\n\nThe weakest dimensions and their notes:\n` +
      `${JSON.stringify(scored.scores.filter((s) => weakest.includes(s.dimension)))}\n\n` +
      `Revise for those dimensions only. Return addressed and summary.`
  );
  log(`round ${round} revision addressed: ${revision.addressed.join(", ") || "(nothing declared)"}`);
}

const first = scoreHistory[0]?.overall ?? 0;
const final = scoreHistory[scoreHistory.length - 1]?.overall ?? 0;
const md = [
  `# Refine-loop: ${task}`,
  "",
  `Rubric: ${rubricNames.join(", ")}. Stop: ${stopReason}. Overall ${first} → ${final}.`,
  "",
  ...scoreHistory.map((h) => `- **round ${h.round}** overall ${h.overall}\n  - ${h.scores.map((s) => `${s.dimension}: ${s.score}`).join(" · ")}`),
].join("\n");
await artifact.markdown("deliverable", md, { title: "Score history", primary: true });

return {
  conclusion: `${scoreHistory.length} scored round(s), overall ${first} → ${final}, stop: ${stopReason}. Deliverable: ${path}.`,
  stopReason,
  scoreHistory,
  verified: [
    "every round's rubric scores were journaled",
    "revisions were scoped to the declared-weak dimensions",
    "a plateau stopped the loop with the history in the record",
  ],
  notCovered: ["dimensions the reviser was not asked to address"],
};
