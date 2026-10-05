/* workflow
description: "Probe: escalation topics resolve from the run's --answers table deterministically."
whenToUse: Probe only — never a real task. Verifies that an escalation carrying a
  structured topic receives the operator's answer (when one is supplied) and the
  no-owner clause otherwise.
args:
  task:
    type: string
    description: Ignored beyond seeding the problem text.
    required: true
*/

interface EscalationAnswer {
  answer: string;
}

// The builder is told to escalate on the "stack" topic — the structured form the
// plane matches against the run's --answers table before any default. Run this
// probe twice: once with --answers '{"stack":"..."}' (the operator's answer
// comes back verbatim) and once without (the no-owner clause comes back).
const builder = agent("Escalation probe builder", {
  system:
    "You are a probe. Call the escalate tool exactly once with topic 'stack', " +
    "question 'Which stack should this part target?', and evidence 'the brief does not pin one'. " +
    "Then reply with the exact text the tool returned, in the answer field.",
});

const result = await builder.ask<EscalationAnswer>(
  `Task context: ${String(args.task)}\n\nEscalate on topic 'stack' as instructed, then return the answer field.`
);

return {
  conclusion: `escalation probe: ${result.answer}`,
  findings: [],
  verified: ["the escalation's topic resolved through the run's answers table"],
  notCovered: [],
};
