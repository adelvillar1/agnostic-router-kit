/* workflow
description: "Proves the runtime contract: a workflow written against only the
  documented surface (agent, world.run, phase, report, artifact, files, git.changedFiles)
  runs unmodified on any machine with the kit."
whenToUse: As an acceptance probe for the runtime contract — and as the minimal
  example to copy when writing a new workflow.
args:
  probe:
    type: string
    description: "One thing to inspect in the workspace."
    required: true
*/
/**
 * runtime-surface-probe: the smallest workflow that touches every documented
 * primitive. It exists so "the contract works" is a thing that gets executed,
 * not asserted.
 *
 * Nothing here uses an engine-internal. If this file runs, a machine with the
 * kit and nothing else has the runtime.
 */

interface Summary {
  /** One sentence on what this workspace is for. */
  summary: string;
  /** How sure the analyst is. */
  confidence: "high" | "low";
}

const result = { readme: "", sources: 0, changed: 0 as number, grep: "", ran: "", probe: "" };

phase("Inspect the workspace with the documented file and git primitives");

const all = await files.glob("**/*");
const sources = (all ?? []).filter((p: string) => /\.(m?jsx?|tsx?)$/.test(p));
const changed = await git.changedFiles();
const matches = await files.grep("workflow");
result.sources = sources.length;
result.changed = changed.length;
result.grep = (matches ?? []).slice(0, 3).map((m: any) => `${m.path}:${m.line}`).join(" | ") || "(no matches)";
report(`sources: ${result.sources}, changed: ${result.changed}, grep hits: ${result.grep}`);

try {
  result.readme = (await files.read("README.md")).split("\n").slice(0, 3).join(" ");
} catch {
  result.readme = "(no README.md at the root)";
}
report(`readme head: ${result.readme}`);

phase("Run a command through the confined runner");

const ran = await world.run("node", ["-e", "process.stdout.write(String(2 + 2))"]);
result.ran = String(ran.stdout ?? "").trim();
report(`world.run node -e → ${result.ran} (exit ${ran.exitCode}, recorded in the journal)`);
if (result.ran !== "4") throw new Error(`world.run returned ${ran.exitCode}: ${ran.stderr}`);

phase("Ask one agent to reason about the probe target");

const analyst = agent("analyst", "You read code and say what it does.");
const summary = await analyst.ask<Summary>(
  `The probe target is: ${args.probe}\n\n` +
    `Workspace facts you did not ask for but may use:\n${result.readme}\n\n` +
    `Return a summary of what this workspace is for, in one sentence, plus your confidence.`
);
report(`summary (${summary.confidence} confidence): ${summary.summary}`);

phase("Prove escalation is reachable from inside an agent");

const escalated = agent("prober", "You follow instructions exactly, including tool instructions.");
const escalatedBack = await escalated.ask(
  `Call the escalate tool once with question "may the runtime-surface-probe continue?" and evidence ` +
    `"this call exists to exercise the escalation path". Then answer with the reply you were given.`
);
report(`escalate reply: ${String(escalatedBack).slice(0, 200)}`);

result.probe = `${args.probe} — ${summary.summary}`;

await artifact.markdown("surface-probe",
  `# Runtime surface probe\n\n` +
  `Target: ${args.probe}\n\n` +
  `- **readme head:** ${result.readme}\n` +
  `- **sources seen:** ${result.sources}\n` +
  `- **changed files:** ${result.changed}\n` +
  `- **grep("workflow"):** ${result.grep}\n` +
  `- **world.run:** ${result.ran} (exit 0)\n` +
  `- **escalate reply:** ${String(escalatedBack).slice(0, 300)}\n\n` +
  `## What the analyst said\n\n${summary.summary} (${summary.confidence} confidence)\n`,
  { title: "Runtime surface probe", primary: true }
);

report(`result: ${JSON.stringify(result)}`);
return { conclusion: result.probe, summary: summary.summary };
