/* workflow
description: "Finds out why something is broken: a detective lists 3-5 distinct
  plausible causes, testers try to prove each one in parallel, and an
  independent confirmer reproduces the winning cause. Returns the diagnosed
  cause and a proposed fix, with unconfirmed hypotheses labelled."
whenToUse: When something is broken or misbehaving and the request is to find
  the root cause, not to fix it yet.
args:
  symptom:
    type: string
    description: "What is broken: the symptom, error, or misbehavior."
    required: true
*/
/**
 * bug-hunt: find out why something is broken.
 * A detective lists plausible causes, testers try to prove each one in
 * parallel, and an independent confirmer reproduces the winning cause.
 */

interface Hypothesis {
  /** One sentence: the suspected cause. */
  statement: string;
  /** How this hypothesis could be confirmed or refuted from the code or a check. */
  howToCheck: string;
}

interface HypothesisList {
  hypotheses: Hypothesis[];
}

interface TestResult {
  /** The hypothesis this test covered. */
  hypothesis: string;
  /** "supported" when evidence backs it, "refuted" when evidence rules it out. */
  verdict: "supported" | "refuted" | "inconclusive";
  /** What showed it: the lines read, or the command and its output. */
  evidence: string;
  /** The fix this cause implies, when supported. */
  fix: string | null;
}

interface Confirmation {
  /** True when the confirmer reproduced the cause from the evidence alone. */
  reproduced: boolean;
  /** What showed it. */
  evidence: string;
}

interface Finding {
  /** Where the problem is: a path when known, else "root cause". */
  where: string;
  /** One sentence: the cause, or what was found. */
  what: string;
  /** What showed it. */
  evidence: string;
  /** "verified" when an independent confirmer reproduced it; "unconfirmed" otherwise. */
  status: "verified" | "unconfirmed";
  /** How much it matters. */
  severity: "low" | "medium" | "high";
}

const symptom = String(args.symptom ?? "").trim() || "Something is broken.";

phase("List the plausible causes");
const detective = agent("Detective", {
  system:
    "You diagnose software bugs. Read the relevant code around a symptom and list 3 to 5 " +
    "distinct plausible causes — different mechanisms, not variations of one. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});
const list = await detective.ask<HypothesisList>(
  `Symptom: ${symptom}\n\n` +
    "Read the code involved. Return 3 to 5 distinct plausible causes, each with how it could be checked."
);
log(`Testing ${list.hypotheses.length} hypotheses in parallel`);

phase("Test each cause in parallel");
const results = await Promise.all(
  list.hypotheses.map(async (h, i) => {
    const tester = agent(`Tester for cause ${i + 1}`, {
      system:
        "You test one bug hypothesis against the code and never edit files. " +
        "Decide supported, refuted, or inconclusive — with evidence, never an assumption. " +
        "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
    });
    return tester.ask<TestResult>(
      `Symptom: ${symptom}\n\nHypothesis: ${h.statement}\nHow to check: ${h.howToCheck}\n\n` +
        "Read the code and run a check when one decides. Return hypothesis, verdict, evidence, and fix."
    );
  })
);

phase("Confirm the cause independently");
const findings: Finding[] = [];
const supported = results.filter((r) => r.verdict === "supported");
let cause = "no cause was confirmed";
let fix = "";
if (supported.length > 0) {
  const winner = supported[0];
  cause = winner.hypothesis;
  fix = winner.fix ?? "no fix proposed";
  const confirmer = agent("Confirmer", {
    system:
      "You confirm one diagnosed root cause from the evidence alone: read the code, run a " +
      "check when one decides it, and never edit files. Reproduce it or say you could not. " +
      "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
  });
  const c = await confirmer.ask<Confirmation>(
    `Symptom: ${symptom}\n\nA tester concluded this root cause: ${winner.hypothesis}\n` +
      `Evidence: ${winner.evidence}\n\nIndependently reproduce the connection between cause and symptom. Return reproduced and evidence.`
  );
  const main: Finding = {
    where: "root cause",
    what: winner.hypothesis,
    evidence: c.reproduced ? c.evidence : `not reproduced: ${c.evidence}`,
    status: c.reproduced ? "verified" : "unconfirmed",
    severity: "high",
  };
  findings.push(main);
  report(main);
  for (const extra of supported.slice(1)) {
    const f: Finding = {
      where: "root cause",
      what: extra.hypothesis,
      evidence: `${extra.evidence} (not independently confirmed)`,
      status: "unconfirmed",
      severity: "medium",
    };
    findings.push(f);
    report(f);
  }
}

const md = [
  `# Why is this broken: ${symptom}`,
  "",
  `**Cause:** ${cause}`,
  `**Proposed fix:** ${fix}`,
  "",
  "## Evidence",
  ...results.map((r) => `- ${r.verdict}: ${r.hypothesis}\n  - ${r.evidence}`),
].join("\n");
await artifact.markdown("deliverable", md, { title: "Diagnosis", primary: true });

return {
  conclusion: `Cause: ${cause}. Proposed fix: ${fix}`,
  findings,
  verified: findings.some((f) => f.status === "verified")
    ? ["the winning cause was reproduced by an independent confirmer"]
    : [],
  notCovered: [
    "a fix was proposed but not implemented or tested",
    ...(supported.length === 0 ? ["no hypothesis was supported — the cause is still open"] : []),
  ],
};
