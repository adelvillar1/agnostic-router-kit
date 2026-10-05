/* workflow
description: "Probe: the harnessed agent control plane's assembly surface."
whenToUse: Probe only — never a real task. Verifies the plane's environment
  measurement, brief rendering, and per-agent contract journaling.
args:
  task:
    type: string
    description: A trivial question the probe agent answers.
    required: true
*/

interface ProbeAnswer {
  answer: string;
}

// The plane's surface: measure the workspace through the run's own command
// allowlist, render a harness block, and contract an agent. This probe exists
// so the assembly can be verified without a competition run.
const env = await measureEnvironment((cmd: string, args: string[]) => world.run(cmd, args));
log(`plane measured: ${env.facts.join(" · ")}`);

const harness = renderBrief({
  stack: "JavaScript on Node 24, node:test, zero npm deps",
  ns: "out/plane-probe/1/",
  verification: "run only the tests your own files define",
  facts: env.facts,
});

const builder = agent("Plane probe builder", {
  system: "You answer a probe question in one short sentence. Nothing else.",
  contract: {
    title: "probe part",
    files: ["out/plane-probe/1/probe.js"],
    acceptance: ["the file exists and exports answer"],
    provides: "probe.js: answer()",
  },
});

const result = await builder.ask<ProbeAnswer>(
  `${harness}\n\nQuestion: ${String(args.task)}\n\nReturn the field answer.`
);

return {
  conclusion: `plane probe: ${result.answer}`,
  findings: [],
  verified: [
    "environment measured through the plane's allowlisted probes",
    "harness block rendered by the plane",
    "the builder's contract was journaled at dispatch",
  ],
  notCovered: ["the contract's effect on builder behavior — that is adversarial-solve's evidence"],
};
