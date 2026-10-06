/* workflow
description: "Probe: the sys1 judge layer on the workflow surface — one flat
  choice head fired through sys1.judge (dev-decisions first, sys1 fallback),
  asserting the verdict shape, the source field, and the journal line. Zero
  model calls, zero search credits."
whenToUse: Probe only — never a real task. Verifies the judge layer the loops
  ride: deep-research's finding support, triage's class, red-team's keep and
  confirm, watchdog's matters.
args:
  text:
    type: string
    description: The text to judge (default: a trivial arithmetic sanity check).
    required: false
*/
/**
 * judge-probe: the judge layer's contract, asserted.
 * The head is a flat choice over a self-evident text, so a correct answer is
 * known in advance ("yes") — the probe asserts the envelope, not the model.
 */

phase("judge-probe");
const SPEC = {
  id: "judge_probe_sanity",
  description: "A trivial yes/no sanity head for the judge layer's contract.",
  heads: [
    {
      id: "holds",
      kind: "choice",
      task: "Does the stated arithmetic hold? Answer yes or no.",
      labels: ["yes", "no"],
    },
  ],
};
const text = String(args.text ?? "2 + 2 = 4. Does the stated arithmetic hold?");
const judged = await sys1.judge(SPEC, text);

if (!judged?.ok) {
  throw new Error(`the judge layer did not answer: ${String(judged?.reason ?? "unknown")}`);
}
const answers = judged.answers ?? {};
const provider = judged.provider ?? null;
const a = provider ? answers[provider]?.holds : null;
if (!a || typeof a.label !== "string") {
  throw new Error(`the judge envelope carried no usable verdict: ${JSON.stringify(answers).slice(0, 200)}`);
}
if (a.label !== "yes") {
  throw new Error(`the sanity head answered "${a.label}" — the judge layer answered wrong on a self-evident text`);
}
return {
  conclusion: `judge-probe: one head judged via ${provider} (${judged.source ?? "sys1-raw"}) — label "${a.label}", confidence ${a.confidence ?? "n/a"}.`,
  provider,
  source: judged.source ?? "sys1-raw",
  inputSha256: judged.inputSha256 ?? null,
  confidence: a.confidence ?? null,
  verified: [
    "sys1.judge answers on the workflow surface (dev-decisions first, sys1 fallback)",
    "the verdict carries provider, source, and confidence",
    "the journal carries the sys1.judge command line",
  ],
  notCovered: [],
};
