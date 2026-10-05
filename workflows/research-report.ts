/* workflow
description: "Researches a topic and writes it up with sources: parallel scouts
  cover 4-6 angles, checkers verify each angle's load-bearing claims against
  their cited sources, a writer synthesizes with citations, and a cold reader
  closes the gaps before handover."
whenToUse: When the request is to research a topic and produce a written report
  or state-of-the-landscape.
args:
  topic:
    type: string
    description: The research question or topic.
    required: true
*/
/**
 * research-report: research a topic and write it up with sources.
 * Parallel scouts cover the angles, confirmers check the load-bearing
 * claims, a writer synthesizes with citations, and a cold reader closes.
 */

interface Angle {
  /** Short id like "1". */
  id: string;
  /** One sentence: what this angle investigates. */
  question: string;
}

interface AngleList {
  angles: Angle[];
}

interface Claim {
  /** One sentence: the fact the report would assert. */
  claim: string;
  /** Where it came from: a URL, a document, or a file path. */
  source: string;
}

interface ScoutReport {
  /** The angle covered. */
  angle: string;
  /** What the scout learned in two or three sentences. */
  summary: string;
  /** The load-bearing claims this angle produced, most important first. */
  claims: Claim[];
}

interface ClaimCheck {
  /** True when the source backs the claim as stated. */
  supported: boolean;
  /** What the source actually says. */
  note: string;
}

interface Draft {
  /** Path of the written report. */
  path: string;
  /** Two or three sentences on what the report concludes. */
  summary: string;
}

interface ReaderNotes {
  /** Where the report is unclear, unsupported, or incomplete. */
  issues: string[];
}

interface Finding {
  where: string;
  what: string;
  evidence: string;
  status: "verified" | "unconfirmed";
  severity: "low" | "medium" | "high";
}

const topic = String(args.topic ?? "").trim() || "the topic";

phase("Break the topic into angles");
const scoper = agent("Scoper", {
  system:
    "You scope research questions: split a topic into 4 to 6 distinct angles that together " +
    "cover it. Each angle is investigable from sources. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});
const angles = await scoper.ask<AngleList>(
  `Topic: ${topic}\n\nSplit it into 4 to 6 distinct research angles. Return angles with id and question.`
);
log(`Scouting ${angles.angles.length} angles in parallel`);

phase("Scout each angle and check its load-bearing claims as they land");
const findings: Finding[] = [];
const perAngle: { angle: string; summary: string; claims: Claim[] }[] = await Promise.all(
  angles.angles.map(async (a, ai) => {
    const scout = agent(`Scout for angle ${ai + 1}`, {
      system:
        "You research one angle of a topic and cite where every claim comes from. " +
        "Say plainly when you could not find a source. " +
        "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
    });
    const scoutReport = await scout.ask<ScoutReport>(
      `Topic: ${topic}\nYour angle: ${a.question}\n\n` +
        "Research it. Return angle, summary, and up to 3 load-bearing claims with sources."
    );
    await Promise.all(
      scoutReport.claims.slice(0, 2).map(async (claim, i) => {
        const checker = agent(`Checker for angle ${ai + 1} claim ${i + 1}`, {
          system:
            "You verify one factual claim against its cited source and never edit files. " +
            "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
        });
        const check = await checker.ask<ClaimCheck>(
          `Claim: ${claim.claim}\nSource: ${claim.source}\n\nCheck the source. Return supported and note.`
        );
        const f: Finding = {
          where: claim.source,
          what: claim.claim,
          evidence: check.note,
          status: check.supported ? "verified" : "unconfirmed",
          severity: "medium",
        };
        report(f);
        if (!check.supported) findings.push(f);
        return f;
      })
    );
    return { angle: scoutReport.angle, summary: scoutReport.summary, claims: scoutReport.claims };
  })
);

phase("Write the report with sources");
const writer = agent("Writer", {
  system:
    "You write research reports: clear structure, claims with citations, and a plain " +
    "statement of what remains uncertain. Write the report to out/research-report/deliverable.md. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});
const draft = await writer.ask<Draft>(
  `Topic: ${topic}\n\nResearch by angle:\n${JSON.stringify(perAngle)}\n\n` +
    "Write the full report to out/research-report/deliverable.md with sources cited inline. " +
    "Return path and summary."
);

phase("Have someone new read the report before handing it over");
const reader = agent("Reader", {
  system:
    "You judge a report as a reader would, from the text alone. You never verify it against " +
    "sources and you never edit files. Say what is unclear, unsupported, or missing.",
});
const notes = await reader.ask<ReaderNotes>(
  `Read ${draft.path} and report what is unclear, unsupported, or missing. Return issues.`
);
if (notes.issues.length > 0) {
  await writer.ask(
    `A reader raised these issues about ${draft.path}. Fix the report for each:\n${JSON.stringify(notes.issues)}`
  );
}

try {
  await artifact.file("deliverable", draft.path, { title: "Research report", primary: true });
} catch {
  await writer.ask(`Re-write the report to ${draft.path} — the file is missing.`);
  await artifact.file("deliverable", draft.path, { title: "Research report", primary: true });
}

return {
  conclusion: `${draft.summary} Report: ${draft.path}.`,
  findings,
  verified: [
    "the top claims of each angle were checked against their cited sources",
    "the final report had an independent read",
  ],
  notCovered: [
    "claims beyond the top two per angle are cited but not independently verified",
  ],
};
