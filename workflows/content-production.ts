/* workflow
description: "Produces a document, report, or deck content from a brief: an
  outliner shapes the thesis and sections, section writers draft in parallel,
  and a fresh reviewer with a fix pass polishes the assembled draft before it is
  written to its final file."
whenToUse: When the request is to produce written content — a report, article,
  deck content, or long-form document — from a brief.
args:
  brief:
    type: string
    description: "What to produce: the content, audience, format, and purpose."
    required: true
*/
/**
 * content-production: produce a document, report, or deck content from a
 * brief. Outliner shapes it, section writers work in parallel, and a fresh
 * reviewer with a fix pass polishes the assembled draft.
 */

interface Outline {
  /** What the piece argues or delivers, one sentence. */
  thesis: string;
  sections: {
    /** Short id like "1". */
    id: string;
    /** The section title. */
    title: string;
    /** What this section must accomplish, one or two sentences. */
    angle: string;
  }[];
}

interface Draft {
  /** The section covered. */
  sectionId: string;
  /** The finished section text in the requested format. */
  text: string;
}

interface Review {
  /** What is unclear, unsupported, or missing — ask for failures, not approval. */
  issues: string[];
}

interface Final {
  /** Path of the finished piece. */
  path: string;
  /** Two or three sentences on what the piece delivers. */
  summary: string;
}

interface Finding {
  where: string;
  what: string;
  evidence: string;
  status: "verified" | "unconfirmed";
  severity: "low" | "medium" | "high";
}

const brief = String(args.brief ?? "").trim() || "Write something.";

phase("Shape the outline");
const outliner = agent("Outliner", {
  system:
    "You shape briefs into outlines: a clear thesis and 3 to 7 sections, each with a job. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});
const outline = await outliner.ask<Outline>(
  `Brief: ${brief}\n\nReturn a thesis and 3 to 7 sections with id, title, and angle.`
);
log(`Drafting ${outline.sections.length} sections in parallel`);

phase("Draft each section in parallel");
const drafts = await Promise.all(
  outline.sections.map(async (s) => {
    const writer = agent(`Writer for ${s.title}`, {
      system:
        "You write one section of a larger piece: finished prose in the format the brief asks " +
        "for, hitting your section's angle exactly. " +
        "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
    });
    return writer.ask<Draft>(
      `Brief: ${brief}\nThesis: ${outline.thesis}\nYour section: ${s.title} — ${s.angle}\n\n` +
        "Write the finished section text. Return sectionId and text."
    );
  })
);

phase("Review the assembled draft with fresh eyes and fix what it finds");
const assembled = drafts.map((d) => d.text).join("\n\n");
const reviewer = agent("Reviewer", {
  system:
    "You review an assembled draft with fresh eyes and never edit files. " +
    "Ask for failures, not approval: what is unclear, unsupported, inconsistent between " +
    "sections, or missing for the audience. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});
const polisher = agent("Polisher", {
  system:
    "You revise a draft to address review comments, keeping the author's voice and structure. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});
let current = assembled;
let openIssues: string[] = [];
const findings: Finding[] = [];
for (let round = 1; round <= 2; round++) {
  const review = await reviewer.ask<Review>(
    `Review this assembled draft for the brief "${brief}":\n\n${current}\n\nReturn issues.`
  );
  if (review.issues.length === 0) break;
  openIssues = review.issues;
  current = await polisher.ask<string>(
    `Revise the draft to address each issue:\n${JSON.stringify(review.issues)}\n\nDraft:\n${current}\n\nReturn the revised full text only.`
  );
}
for (const issue of openIssues) {
  const f: Finding = {
    where: "the piece",
    what: issue,
    evidence: "raised by the fresh-eyes reviewer of the assembled draft",
    status: "unconfirmed",
    severity: "low",
  };
  findings.push(f);
  report(f);
}

phase("Write the finished piece to its file");
const finisher = agent("Finisher", {
  system:
    "You write the finished version of a piece to its final file, exactly as revised. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});
const final = await finisher.ask<Final>(
  `Brief: ${brief}\n\nWrite the finished piece to out/content/deliverable.md exactly as follows, then return path and summary:\n\n${current}`
);

try {
  await artifact.file("deliverable", final.path, { title: "The finished piece", primary: true });
} catch {
  await finisher.ask(`Re-write the piece to ${final.path} — the file is missing.`);
  await artifact.file("deliverable", final.path, { title: "The finished piece", primary: true });
}

return {
  conclusion: `${final.summary} Piece: ${final.path}.`,
  findings,
  verified: ["the assembled draft had a fresh-eyes review with a fix pass"],
  notCovered: [
    "factual claims in the prose are written to the brief, not independently verified",
    ...(openIssues.length > 0 ? ["the last review's issues may remain partially addressed"] : []),
  ],
};
