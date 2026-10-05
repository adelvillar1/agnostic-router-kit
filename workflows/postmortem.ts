/* workflow
description: "Writes up an incident: investigators reconstruct the timeline from
  each evidence source in parallel, one analyst finds the root cause and
  contributing factors, an independent confirmer checks the causal claim against
  the evidence, and a blameless postmortem is written with concrete actions."
whenToUse: When an incident, outage, or data problem happened and the request is
  to understand and write up what occurred and why.
args:
  incident:
    type: string
    description: "What happened: the incident, its symptoms, and the time window if known."
    required: true
*/
/**
 * postmortem: write up an incident. Investigators reconstruct the timeline
 * from each evidence source in parallel, one analyst finds the cause, an
 * independent confirmer checks the causal claim, and the postmortem is written.
 */

interface Source {
  /** Short id like "1". */
  id: string;
  /** What this source is: logs, a diff, deploy records, a report. */
  name: string;
  /** Where to look. */
  where: string;
}

interface SourceList {
  sources: Source[];
}

interface Timeline {
  /** The source covered. */
  source: string;
  events: {
    /** When it happened, as precise as the source allows. */
    time: string;
    /** What happened, one sentence. */
    what: string;
  }[];
  /** Anything notable the timeline does not capture. */
  notes: string;
}

interface Cause {
  /** The root cause, one or two sentences. */
  cause: string;
  /** Contributing factors. */
  factors: string[];
  /** How confident the analysis is, and why. */
  confidence: string;
}

interface Confirmation {
  /** True when the evidence supports the cause as stated. */
  supported: boolean;
  /** What showed it. */
  evidence: string;
}

interface Draft {
  /** Path of the written postmortem. */
  path: string;
  /** Two or three sentences on the outcome and the main action. */
  summary: string;
}

interface Finding {
  where: string;
  what: string;
  evidence: string;
  status: "verified" | "unconfirmed";
  severity: "low" | "medium" | "high";
}

const incident = String(args.incident ?? "").trim() || "An incident occurred.";

phase("Name the evidence sources");
const scoper = agent("Scoper", {
  system:
    "You scope incident investigations: name the 2 to 5 evidence sources that can show what " +
    "happened — logs, diffs, deploy records, monitoring, reports. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});
const sources = await scoper.ask<SourceList>(
  `Incident: ${incident}\n\nName the 2 to 5 evidence sources worth reading. Return sources with id, name, and where.`
);
log(`Reading ${sources.sources.length} evidence sources in parallel`);

phase("Reconstruct the timeline from each source in parallel");
const timelines = await Promise.all(
  sources.sources.map(async (s) => {
    const investigator = agent(`Investigator for ${s.name}`, {
      system:
        "You reconstruct one slice of an incident timeline from one evidence source. " +
        "Times and events exactly as the source shows them; say plainly when the source is silent. " +
        "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
    });
    return investigator.ask<Timeline>(
      `Incident: ${incident}\nYour source: ${s.name} (${s.where})\n\n` +
        "Read the source. Return source, events in order, and notes."
    );
  })
);

phase("Analyze the cause and confirm it independently");
const analyst = agent("Analyst", {
  system:
    "You find the root cause of an incident from its timelines: the mechanism, not the symptom, " +
    "with contributing factors separated from the cause. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});
const cause = await analyst.ask<Cause>(
  `Incident: ${incident}\n\nTimelines:\n${JSON.stringify(timelines)}\n\nReturn cause, factors, and confidence.`
);
const findings: Finding[] = [];
const confirmer = agent("Confirmer", {
  system:
    "You confirm one incident root cause against the evidence and never edit files. " +
    "Support it or say the evidence does not. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});
const check = await confirmer.ask<Confirmation>(
  `Incident: ${incident}\n\nProposed cause: ${cause.cause}\nFactors: ${JSON.stringify(cause.factors)}\n` +
    `Timelines: ${JSON.stringify(timelines)}\n\nCheck the evidence. Return supported and evidence.`
);
const main: Finding = {
  where: "root cause",
  what: cause.cause,
  evidence: check.supported ? check.evidence : `not supported by the evidence: ${check.evidence}`,
  status: check.supported ? "verified" : "unconfirmed",
  severity: "high",
};
findings.push(main);
report(main);

phase("Write the postmortem");
const writer = agent("Writer", {
  system:
    "You write postmortems: timeline, impact, cause, contributing factors, and concrete " +
    "actions with owners left to name. Blameless and precise. " +
    "Write the postmortem to out/postmortem/deliverable.md. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});
const draft = await writer.ask<Draft>(
  `Incident: ${incident}\n\nTimelines: ${JSON.stringify(timelines)}\nCause: ${JSON.stringify(cause)}\n` +
    `Cause check: ${JSON.stringify(check)}\n\n` +
    "Write the full postmortem to out/postmortem/deliverable.md. Return path and summary."
);

try {
  await artifact.file("deliverable", draft.path, { title: "Postmortem", primary: true });
} catch {
  await writer.ask(`Re-write the postmortem to ${draft.path} — the file is missing.`);
  await artifact.file("deliverable", draft.path, { title: "Postmortem", primary: true });
}

return {
  conclusion: `${draft.summary} Postmortem: ${draft.path}.`,
  findings,
  verified: [
    "the root cause was checked against the evidence by an independent confirmer",
  ],
  notCovered: [
    "sources the scoper did not name",
    "the proposed actions are not implemented by this run",
  ],
};
