/* workflow
description: "Probe: per-shape budgets — what a line the plane enforces looks like, and what it does when an ask runs out."
whenToUse: Probe only — never a real task. Drives both axes of an ask's budget
  (rounds and prompt tokens) with tightened lines, on both shapes: a
  verification-shaped ask escalates with the stuck reason at its cap, and a
  build-shaped ask still throws the round-count error its caller decomposes
  from. One negative control settles inside a tight line and proves the cap is
  a ceiling rather than a trap. Run as `kit workflows run budgets-probe
  --grant workspace-io`; add `--answers '{"stuck":"run it as a build ask"}'`
  and the owner's answer reaches the escalation.
args: {}
*/
/**
 * budgets-probe: rounds measure how stubborn an agent is, tokens measure what
 * its history costs, and a context window is a number rather than a count — so
 * an ask's budget is a line on both axes, and the line is the ask's shape's
 * policy rather than the caller's. What the probe asserts is what it can see at
 * runtime: the error an ask that ran out of budget produces, and whether the
 * escalation's answer reached it. The journal carries the rest — the `budget`
 * line the plane wrote, the `escalation` event with topic `stuck`, and the
 * `account` line naming the shape and its line — and is checked after the run:
 *
 *   grep -E '"kind":"(budget|escalation|account)"' …/run.jsonl
 *
 * A deliberately looping ask is not needed to prove the line fires, and is not
 * used: `budget: { tokens: 1 }` makes the cap unavoidable at the second round's
 * check whatever the model does, which is a stronger claim about the plane than
 * a model's willingness to keep calling a tool.
 */

const problems: string[] = [];
const findings: string[] = [];

/** The answer the run's owner supplies for the stuck escalation, if any. */
const STUCK_ANSWER = "re-run this part as a build ask and split it by hand";

// ── trial 1: a verification-shaped ask hits the token line ───────────────────
// One token of line: the first round always runs (the check is before a round,
// and nothing has been spent yet), the second round never happens. Whatever
// the model would have done next, the plane stops the ask here.
const verifier = agent("Verification subject", {
  system:
    "You verify one piece of evidence and answer plainly. " +
    "If a check is impossible to pass, escalate and say so plainly rather than working around it.",
  shape: "verify",
  budget: { tokens: 1 },
});
let stuckTokenError = "";
try {
  const answer = await verifier.ask(
    `Read the workspace listing with list_files and state in one sentence what is there.`
  );
  findings.push(`trial 1: the ask settled inside a one-token line — answer ${JSON.stringify(answer)}`);
} catch (e) {
  stuckTokenError = String(e?.message ?? e);
}

if (stuckTokenError) {
  if (!stuckTokenError.includes("the verify ask is stuck")) {
    problems.push(`trial 1: a verification-shaped ask that ran out of budget did not say it was stuck: ${stuckTokenError}`);
  }
  if (!stuckTokenError.includes("escalated with the stuck reason")) {
    problems.push(`trial 1: the stuck error does not say the plane escalated: ${stuckTokenError}`);
  }
  if (!stuckTokenError.includes("No owner is available") && !stuckTokenError.includes(STUCK_ANSWER)) {
    problems.push(`trial 1: the stuck error carries no escalation answer: ${stuckTokenError}`);
  }
} else {
  problems.push("trial 1: the ask settled inside a one-token line — the token budget never fired");
}

// ── trial 2: the same answer, on the rounds line ────────────────────────────
// The other axis, tightened the same way: one round, and the ask is asked to do
// something that takes more than one. A model that answers in a single round
// settles legitimately, and the probe reports that rather than claiming a cap.
const rounder = agent("Round-line subject", {
  system:
    "You answer precisely what you are asked. " +
    "If a check is impossible to pass, escalate and say so plainly rather than working around it.",
  shape: "verify",
  budget: { rounds: 1 },
});
let stuckRoundError = "";
try {
  const answer = await rounder.ask(
    `First call list_files on ".". Then, for every entry you see that starts with "lib", call read_file on it. ` +
      `Only then state what you found, in one sentence. Do not answer before the reads are done.`
  );
  findings.push(`trial 2: the ask settled inside one round — answer ${JSON.stringify(answer)}`);
} catch (e) {
  stuckRoundError = String(e?.message ?? e);
}

if (stuckRoundError) {
  if (!stuckRoundError.includes("stuck, not big")) {
    problems.push(`trial 2: the rounds line did not produce the stuck reason: ${stuckRoundError}`);
  }
  if (!stuckRoundError.includes("1 tool rounds")) {
    problems.push(`trial 2: the stuck error does not name the round line it crossed: ${stuckRoundError}`);
  }
} else {
  findings.push("trial 2: the ask settled in one round — the cap did not fire (a single-round ask is not stuck)");
}

// ── trial 3: a build-shaped ask still throws the countable cap ──────────────
// The shape is the policy: this is the error adversarial-solve's cap recovery
// matches, so the phrasing is the contract. Same tightened line, different
// shape, and the plane decomposes nothing.
const builder = agent("Build-shape subject", {
  system:
    "You build exactly what you are asked, one step at a time. " +
    "If a check is impossible to pass, escalate and say so plainly rather than working around it.",
  budget: { rounds: 1 },
});
let buildError = "";
try {
  await builder.ask(
    `First call list_files on ".". Then, for every entry you see that starts with "lib", call read_file on it. ` +
      `Only then state what you found, in one sentence. Do not answer before the reads are done.`
  );
  findings.push("trial 3: the ask settled inside one round — no cap to throw");
} catch (e) {
  buildError = String(e?.message ?? e);
}

if (buildError) {
  if (!/did not settle after 1 tool rounds/.test(buildError)) {
    problems.push(`trial 3: a build-shaped ask's cap error no longer matches the countable cap: ${buildError}`);
  }
  if (buildError.includes("stuck")) {
    problems.push(`trial 3: a build-shaped ask was escalated as stuck instead of throwing: ${buildError}`);
  }
} else {
  problems.push("trial 3: the build-shaped ask settled inside one round — the cap never fired");
}

// ── trial 4: a tight line is a ceiling, not a trap ───────────────────────────
// The negative control: an ask that settles inside the same tightened budget
// is not stopped by it. Without this the probe would only prove that budgets
// stop things.
let settled = "";
try {
  const answer = await verifier.ask(`Reply with the single word: ready.`);
  settled = String(answer);
} catch (e) {
  problems.push(`trial 4: an ask that fits the line was stopped by it: ${String(e?.message ?? e)}`);
}
if (settled && !settled.toLowerCase().includes("ready")) {
  findings.push(`trial 4: the answer is not the word asked for: ${JSON.stringify(settled)}`);
}

// ── verdict ─────────────────────────────────────────────────────────────────
const conclusion = problems.length
  ? `budgets probe: ${problems.length} problem(s) — ${problems.join("; ")}`
  : `budgets probe: both axes of both shapes behaved — the verify shape escalated stuck at the line, ` +
    `the build shape threw the countable cap, and a tight line did not stop an ask that fit it`;

if (problems.length) for (const p of problems) console.log(`  \u2717 ${p}`);
if (findings.length) for (const f of findings) console.log(`  \u2219 ${f}`);
console.log(`  ${problems.length ? "budgets probe FAILED" : "budgets probe passed"} — see the journal for the budget/escalation/account lines`);

return {
  conclusion,
  findings,
  report: { problems, trial1TokenLine: Boolean(stuckTokenError), trial2RoundLine: Boolean(stuckRoundError), trial3BuildCap: Boolean(buildError), trial4Settled: settled },
};
