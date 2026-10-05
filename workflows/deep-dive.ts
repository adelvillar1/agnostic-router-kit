/* workflow
description: "Explains or assesses a system: explorers cover the subsystems in
  parallel and flag risks, a writer integrates one architecture assessment with
  the highest-impact improvements, and a cold reader closes the gaps before
  handover. Risks are labelled as judged, not reproduced."
whenToUse: When the request is to understand, explain, or assess how a system
  works — architecture questions, onboarding, improvement shortlists.
args:
  scope:
    type: string
    description: The system or question to explain or assess.
    required: true
*/
/**
 * deep-dive: explain or assess a system. Explorers cover the subsystems in
 * parallel, an integrator writes the architecture picture, and a cold
 * reader closes the gaps before handover.
 */

interface Subsystem {
  /** Short id like "1". */
  id: string;
  /** The subsystem name. */
  name: string;
  /** Where it lives: a directory or a set of files. */
  where: string;
}

interface SubsystemList {
  subsystems: Subsystem[];
}

interface Exploration {
  /** The subsystem covered. */
  name: string;
  /** How it works in two or three sentences. */
  summary: string;
  /** Where it touches other parts of the system. */
  seams: string[];
  /** Risks or smells worth the reader knowing. */
  risks: string[];
}

interface Draft {
  /** Path of the written assessment. */
  path: string;
  /** Two or three sentences on what the assessment concludes. */
  summary: string;
}

interface ReaderNotes {
  /** Where the assessment is unclear, unsupported, or incomplete. */
  issues: string[];
}

interface Finding {
  where: string;
  what: string;
  evidence: string;
  status: "verified" | "unconfirmed";
  severity: "low" | "medium" | "high";
}

const scope = String(args.scope ?? "").trim() || "this system";

phase("Name the subsystems to explore");
const mapper = agent("Mapper", {
  system:
    "You scope architecture reviews: look around a codebase and name the 3 to 6 subsystems " +
    "that explain how it works. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});
const subs = await mapper.ask<SubsystemList>(
  `Scope: ${scope}\n\nLook at the repository and name the 3 to 6 subsystems worth exploring. Return subsystems with id, name, and where.`
);
log(`Exploring ${subs.subsystems.length} subsystems in parallel`);

phase("Explore each subsystem in parallel");
const findings: Finding[] = [];
const explorations = await Promise.all(
  subs.subsystems.map(async (s) => {
    const explorer = agent(`Explorer for ${s.name}`, {
      system:
        "You explain one subsystem of a codebase from its code: how it works, where it touches " +
        "the rest of the system, and what risks or smells it carries. " +
        "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
    });
    const e = await explorer.ask<Exploration>(
      `Scope of the whole review: ${scope}\nYour subsystem: ${s.name} (${s.where})\n\n` +
        "Read the code. Return name, summary, seams, and risks."
    );
    for (const risk of e.risks) {
      const f: Finding = {
        where: s.name,
        what: risk,
        evidence: "raised by the explorer reading the subsystem's code (judged, not reproduced)",
        status: "unconfirmed",
        severity: "medium",
      };
      findings.push(f);
      report(f);
    }
    return e;
  })
);

phase("Write the architecture assessment");
const writer = agent("Writer", {
  system:
    "You write architecture assessments: how the pieces fit, where the seams are, and the " +
    "highest-impact improvements — judged as recommendations, not verified facts. " +
    "Write the assessment to out/deep-dive/deliverable.md. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});
const draft = await writer.ask<Draft>(
  `Scope: ${scope}\n\nSubsystem explorations:\n${JSON.stringify(explorations)}\n\n` +
    "Write the full assessment to out/deep-dive/deliverable.md. Return path and summary."
);

phase("Have someone new read the assessment before handing it over");
const reader = agent("Reader", {
  system:
    "You judge a document as a reader would, from the text alone. You never verify it against " +
    "the repository and you never edit files. Say what is unclear, unsupported, or missing.",
});
const notes = await reader.ask<ReaderNotes>(
  `Read ${draft.path} and report what is unclear, unsupported, or missing. Return issues.`
);
if (notes.issues.length > 0) {
  await writer.ask(
    `A reader raised these issues about ${draft.path}. Fix the assessment for each:\n${JSON.stringify(notes.issues)}`
  );
}

try {
  await artifact.file("deliverable", draft.path, { title: "Architecture assessment", primary: true });
} catch {
  await writer.ask(`Re-write the assessment to ${draft.path} — the file is missing.`);
  await artifact.file("deliverable", draft.path, { title: "Architecture assessment", primary: true });
}

return {
  conclusion: `${draft.summary} Assessment: ${draft.path}.`,
  findings,
  verified: [
    "each subsystem was read by its own explorer",
    "the final assessment had an independent read",
  ],
  notCovered: [
    "risks are judged from reading the code — none were reproduced as failures",
  ],
};
