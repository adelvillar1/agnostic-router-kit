/* workflow
description: "Reviews changed files with confirmed findings: one reviewer per
  changed file, one independent confirmer per finding chained as reviews land,
  findings sorted by severity and published as a review report. Every finding is
  either reproduced by a confirmer who did not produce the review or labelled
  unconfirmed."
whenToUse: When the request is to review changes — a diff, a PR, or modified
  files — and findings should be confirmed before anyone acts on them.
args:
  base:
    type: string
    description: Diff base ref; empty reviews working-tree changes.
    required: false
    default: ""
  task:
    type: string
    description: "What to review for: the review's focus or the change's purpose."
    required: true
*/
/**
 * review-sweep: review changed files with confirmed findings.
 * One reviewer per changed file, one confirmer per finding chained as the
 * review lands, findings sorted by severity and published as a report.
 */

interface ReviewFinding {
  /** What is wrong in one sentence — not how to fix it. */
  problem: string;
  /** "high" only for data loss, a crash, or a wrong result. */
  severity: "low" | "medium" | "high";
}

interface FileReview {
  /** Workspace-relative path reviewed. */
  file: string;
  findings: ReviewFinding[];
}

interface Confirmation {
  /** True when the confirmer reproduced the problem from the evidence alone. */
  reproducible: boolean;
  /** What showed it: the lines read, or the command and its output. */
  evidence: string;
}

interface Finding {
  /** Workspace-relative path the problem is in. */
  where: string;
  /** One sentence: what is wrong. */
  what: string;
  /** What showed it. */
  evidence: string;
  /** "verified" when an independent confirmer reproduced it; "unconfirmed" otherwise. */
  status: "verified" | "unconfirmed";
  /** How much it matters. */
  severity: "low" | "medium" | "high";
}

const task = String(args.task ?? "").trim() || "Review the changed files.";
const base = String(args.base ?? "").trim();

let changed: string[] = [];
try {
  changed = base ? await git.changedFiles(base) : await git.changedFiles();
} catch {
  changed = await files.glob("**/*");
}
if (changed.length > 40) {
  log(`Limiting the sweep to the first 40 of ${changed.length} changed files`);
  changed = changed.slice(0, 40);
}
log(`Reviewing ${changed.length} changed files`);

phase("Review each changed file and confirm its findings as they land");
const perFile: Finding[][] = await Promise.all(
  changed.map(async (file) => {
    const reviewer = agent(`Reviewer for ${file}`, {
      system:
        "You review one changed file with fresh eyes and never edit files. " +
        "Ask for failures, not approval: say what is wrong, what would break, and what the author assumed. " +
        "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
    });
    const review = await reviewer.ask<FileReview>(
      `Review the changes in ${file} for this request: ${task}\n\n` +
        "Read the file (and its diff with git tools when that helps) before judging. " +
        "Return only real problems, or an empty findings list. Return file and findings."
    );
    if (review.findings.length === 0) return [];
    return Promise.all(
      review.findings.map(async (f, i) => {
        const confirmer = agent(`Confirmer for ${file} finding ${i + 1}`, {
          system:
            "You confirm one reported problem from the evidence alone: read the code, run a " +
            "check when one decides it, and never edit files. Reproduce it or say you could not. " +
            "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
        });
        const c = await confirmer.ask<Confirmation>(
          `A reviewer reported this problem in ${file}:\n${JSON.stringify(f)}\n\n` +
            "Independently reproduce it. Return reproducible and evidence."
        );
        const finding: Finding = {
          where: file,
          what: f.problem,
          evidence: c.reproducible ? c.evidence : `not reproduced: ${c.evidence}`,
          status: c.reproducible ? "verified" : "unconfirmed",
          severity: f.severity,
        };
        report(finding);
        return finding;
      })
    );
  })
);
const findings = perFile.flat().sort((a, b) => {
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return rank[a.severity] - rank[b.severity];
});
log(`${findings.length} findings after confirmation`);

const md = [
  `# Review: ${task}`,
  "",
  `Changed files reviewed: ${changed.length}. Findings: ${findings.length} ` +
    `(${findings.filter((f) => f.status === "verified").length} reproduced independently).`,
  "",
  ...findings.map((f) => `- **${f.severity}** \`${f.where}\` — ${f.what}\n  - evidence: ${f.evidence}\n  - ${f.status}`),
].join("\n");
await artifact.markdown("deliverable", md, { title: "Review report", primary: true });

return {
  conclusion: `${changed.length} changed files reviewed; ${findings.length} findings, ${findings.filter((f) => f.status === "verified").length} reproduced by an independent confirmer.`,
  findings,
  verified: [
    "every finding was checked by a confirmer who did not produce the review",
    ...(changed.length >= 40 ? [`the first 40 of the changed files`] : [`${changed.length} changed files`]),
  ],
  notCovered: [
    "files outside the change set",
    "runtime behavior — reviews are from reading the code and running checks where one decides",
  ],
};
