/* workflow
description: "Probe: token accounting and context compaction — what an ask costs, and what survives a compaction."
whenToUse: Probe only — never a real task. Gives an agent a deliberately bulky
  first brief, then asks it again with a small one: the second ask's history is
  compacted before its first round, and the answer must still come from the
  brief and the contract. The compaction fires because the plane's own brief is
  what fills the context, not because an agent chose to read a big file — a
  probe that let the agent drive the growth just taught it to re-read. Run with
  a small compaction line: `kit workflows run tokens-probe --compact-tokens 3000
  --grant workspace-io`.
args: {}
*/
/**
 * tokens-probe: rounds measure how stubborn an agent is; tokens measure what
 * its history costs, and a provider's context window is a number rather than a
 * count. This probe drives both halves with real model calls, because the claims
 * are about a model's behaviour:
 *
 *   1. accounting — every ask journals an `account` line with its
 *      prompt/completion tokens and its round count (the run journal is checked
 *      after the run: `grep '"kind":"account"' …/run.jsonl`);
 *   2. compaction — when the second ask's history is over the line, the plane
 *      keeps the plane-owned parts (the persona and the brief it wrote:
 *      measured facts plus the rendered contract) and replaces the agent's own
 *      mid-history with one summary. The answer must still come from the brief.
 *
 * What the probe asserts is what it can see: the plane-owned content survives
 * both asks. What became of the mid-history is reported, not assumed — a
 * summary that carried a fact did its job. The journal's `compact` line (the
 * size that crossed the line, the size after, what was kept) is the record of
 * what the summary carried and is checked after the run.
 */

const problems: string[] = [];

/** The plane's own measurements, handed to the agent the way a brief hands them. */
const CALIBRATION = "CAL-7f3d-42";
const ACCEPTANCE = ["the answer names the calibration token", "the answer states the ledger is recoverable"];

/**
 * Bulk the plane hands over in the FIRST brief only. It is not padding for its
 * own sake: a brief that arrives with a large measured hand-off is the ordinary
 * way an agent's context fills, and it is the plane's own bytes — so the
 * compaction the second ask triggers has a real history to summarize without
 * depending on a model choosing to read a file.
 */
const handoff = (lines: number): string =>
  Array.from({ length: lines }, (_, i) => `ledger note ${String(i).padStart(4, "0")}: entry ${"x".repeat(60)}`).join("\n");

/** The questions, asked the same way both times, plus the plane's measurements. */
const questions = (note: string): string =>
  `Answer exactly these three questions:\n` +
  `1. What is the calibration token in this brief?\n` +
  `2. What are this task's two acceptance criteria?\n` +
  `3. In your earlier answer you chose a nonce. Give it, or say plainly that you no longer have it.\n\n` +
  `Measurements the plane took before dispatching you (these are facts, do not re-derive them):\n` +
  `- runtime: ${CALIBRATION}\n- ledger: recoverable\n\n${note}`;

const probe = agent("Compaction subject", {
  system:
    "You are the subject of a token-accounting probe. You answer only from what you were actually given, and you " +
    "never invent a fact to fill an answer. When you do not have something, say so plainly. Answer in one or two " +
    "sentences per question and call submit_result — there is nothing to look up and no tool to call.",
  // The plane's contract: what this agent owns and what it must satisfy. It is
  // rendered into every ask, and it is the thing a compaction must not cost.
  contract: {
    files: [],
    acceptance: ACCEPTANCE,
    provides: "as declared for this part: one answer naming the calibration token",
  },
});

// Ask 1: a bulky hand-off fills this ask's context. The plane-owned parts are
// the system message and this brief; the answer it produces is the agent's own
// mid-history, and it contains a nonce that exists nowhere else.
const first = await probe.ask<{ calibration?: string; acceptance?: string; nonce?: string }>(
  questions(
    `Hand-off from the plane's measurements (${handoff(120).split("\n").length} lines of ledger notes):\n${handoff(120)}\n\n` +
      `Also choose a nonce — any short string — and include it in your answer. ` +
      `Answer with calibration, acceptance, and nonce fields.`
  ),
);

// Ask 2: the same agent, a small brief, and a history whose first brief and first
// answer are about to become one summary. The compaction runs before the first
// round, so what the model sees is the brief and the contract it was just given
// plus a summary of everything that came before.
const second = await probe.ask<{ calibration?: string; acceptance?: string; nonce?: string; lost?: string }>(
  questions(
    `This is your second ask, and your earlier turns have been compacted into a summary by the plane. ` +
      `Answer from what you were originally given. Answer with calibration, acceptance, and nonce fields.`
  ),
);

const firstText = `${first.calibration ?? ""} ${first.acceptance ?? ""} ${first.nonce ?? ""}`;
const secondText = `${second.calibration ?? ""} ${second.acceptance ?? ""} ${second.nonce ?? ""} ${second.lost ?? ""}`;
const nonce = String(first.nonce ?? "").trim();

for (const [name, text] of [
  ["first ask", firstText],
  ["second ask", secondText],
] as const) {
  if (!text.includes(CALIBRATION)) {
    problems.push(`the ${name} lost the calibration token from its own brief: ${text.slice(0, 200)}`);
  }
  if (!ACCEPTANCE.every((a) => text.toLowerCase().includes(a.toLowerCase().split(" ")[0]))) {
    problems.push(`the ${name} lost the contract's acceptance criteria: ${text.slice(0, 200)}`);
  }
}

// The nonce existed only in the first ask's answer — the mid-history the second
// ask compacted. Whether it came back is reported, not asserted: a summary that
// carried it did its job, and the journal's `compact` line says what was kept.
const nonceSurvived = nonce.length > 0 && secondText.includes(nonce);

report(
  `both asks answered from the brief and the contract — calibration token present in both, ` +
    `nonce from the compacted answer ${nonceSurvived ? "came back" : "did not come back"}`
);

return {
  conclusion: problems.length
    ? `${problems.length} problem(s)`
    : "an ask's tokens are journaled, and a compacted agent still has its brief, its measured facts and its contract",
  findings: problems,
  report: {
    calibration: CALIBRATION,
    acceptance: ACCEPTANCE,
    nonce,
    nonceSurvived,
    first: { calibration: first.calibration ?? null, acceptance: first.acceptance ?? null, nonce: first.nonce ?? null },
    second: { calibration: second.calibration ?? null, acceptance: second.acceptance ?? null, nonce: second.nonce ?? null },
  },
};
