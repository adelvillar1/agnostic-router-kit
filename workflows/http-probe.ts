/* workflow
description: "Probe: the run API's zero-model fixture — one phase, two escalations, one artifact."
whenToUse: Probe only — never a real task. The run-API probe spawns this: it
  fires a warmup escalation no one answers, then the real escalation on the
  topic its spawn declared, then publishes the resolution as one markdown
  artifact — with zero model calls, so the wire can be verified without a
  provider. Spawn with declared answers to assert declared-beats-live; spawn
  without and POST a live answer to assert the live channel.
args:
  topic:
    type: string
    description: The escalation topic the real (second) escalation fires on.
    required: true
*/

phase("http-probe");

// 1. Warmup: nothing declared, nothing live yet, no owner — the no-owner
// clause comes back and the journal records source "none".
const warmup = await escalate(
  "Warmup question that nobody answers.",
  "the fixture's warmup escalation, fired before any answer could exist",
  "warmup",
);

// 2. Give the wire a beat to land the live answer before the real escalation
// fires, so the runner's POST reliably precedes the resolution it asserts on.
await new Promise((resolve) => setTimeout(resolve, 1500));

const answer = await escalate(
  "What should the probe do about the thing it escalated?",
  "the fixture escalates exactly once more, on the topic its spawn declared",
  String(args.topic),
);

const published = await artifact.markdown(
  "probe-answer",
  `# probe answer\n\n${answer}\n`,
);

return {
  conclusion: `http-probe: topic "${String(args.topic)}" resolved to "${String(answer).slice(0, 80)}"`,
  warmup,
  answer,
  artifactId: published.id,
  verified: ["one phase", "warmup escalation resolved with no owner", "real escalation resolved", "one artifact published"],
  notCovered: [],
};
