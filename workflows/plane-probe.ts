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

// The judging path: dev-decisions first, raw sys1 as the recorded fallback.
// One genuinely atomic part and one deliberately multi-concern part — the gate
// must accept the first and flag the second, whichever source judges.
const gateProbe = async (title: string, instruction: string, acceptance: string[]) => {
  const g = await judgeContract(
    { title, instruction, acceptance },
    String(args.task),
    sys1.judge
  );
  const v = gateVerdict(g);
  log(`gate probe "${title}" → ${v}`);
  return { title, verdict: v, needsFixup: gateNeedsFixup(g), source: g.source ?? null, ok: g.ok };
};

const atomicProbe = await gateProbe(
  "probe atom",
  "Create out/plane-probe/1/probe.js exporting answer() returning a string.",
  ["the file exists and exports answer"]
);
const blobProbe = await gateProbe(
  "probe blob (multi-concern by construction)",
  "Create probe.js AND copy it to backup.js AND edit probe.js again AND delete scratch.js.",
  ["all four files exist as described"]
);

return {
  conclusion: `plane probe: ${result.answer}`,
  findings: [],
  verified: [
    "environment measured through the plane's allowlisted probes",
    "harness block rendered by the plane",
    "the builder's contract was journaled at dispatch",
    `judge path (${atomicProbe.source}): atomic part → ${atomicProbe.verdict}`,
    `judge path (${blobProbe.source}): multi-concern part → ${blobProbe.verdict}`,
  ],
  notCovered: ["the contract's effect on builder behavior — that is adversarial-solve's evidence"],
};
