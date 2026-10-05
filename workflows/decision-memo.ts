/* workflow
description: "Decides between options with a written memo: independent advocates
  make each option's strongest honest case in parallel, a judge picks (and says
  if a merged recommendation would beat the single best), and the memo gets an
  independent read before handover."
whenToUse: When the request is a decision between plausible options —
  architecture choices, build-vs-buy, strategy calls — and the user wants a
  reasoned recommendation.
args:
  question:
    type: string
    description: The decision to make, including the context and any options already
      on the table.
    required: true
*/
/**
 * decision-memo: decide between options. Each option gets an independent
 * advocate, a judge picks (and says if a merged recommendation helps),
 * and the memo is written and cold-read before handover.
 */

interface Options {
  options: {
    /** Short id like "1". */
    id: string;
    /** The option's name. */
    name: string;
  }[];
}

interface Analysis {
  /** The option analyzed. */
  option: string;
  /** The strongest case for this option, in two or three sentences. */
  case: string;
  /** What could go wrong with this option. */
  risks: string;
  /** When this option is the right choice. */
  bestWhen: string;
}

interface Judgment {
  /** The option that should be chosen. */
  best: string;
  /** True when a recommendation merging the options' strongest elements would beat the single best. */
  worthMerging: boolean;
  /** Why, in one or two sentences. */
  why: string;
}

interface Memo {
  /** Path of the written memo. */
  path: string;
  /** Two or three sentences on the recommendation. */
  summary: string;
}

interface ReaderNotes {
  /** Where the memo is unclear, unsupported, or incomplete. */
  issues: string[];
}

const question = String(args.question ?? "").trim() || "Which option is best?";

phase("Name the options");
const scoper = agent("Scoper", {
  system:
    "You scope decisions: from a question, name the 2 to 4 real options on the table — " +
    "mutually exclusive choices, not variations. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});
const options = await scoper.ask<Options>(
  `Decision: ${question}\n\nName the 2 to 4 real options. Return options with id and name.`
);
log(`Making the independent case for ${options.options.length} options`);

phase("Make the independent case for each option in parallel");
const analyses = await Promise.all(
  options.options.map(async (o) => {
    const advocate = agent(`Advocate for ${o.name}`, {
      system:
        "You make the strongest honest case for one option: its real strengths, its real risks, " +
        "and when it is the right choice. You argue for your option only. " +
        "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
    });
    return advocate.ask<Analysis>(
      `Decision: ${question}\nYour option: ${o.name}\n\nMake its strongest honest case. Return option, case, risks, and bestWhen.`
    );
  })
);

phase("Judge the options");
const judge = agent("Judge", {
  system:
    "You decide between options after reading independent analyses. Pick one, and judge " +
    "plainly whether a recommendation that merges the options' strongest elements would beat " +
    "the single best. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});
const judgment = await judge.ask<Judgment>(
  `Decision: ${question}\n\nAnalyses:\n${JSON.stringify(analyses)}\n\nReturn best, worthMerging, and why.`
);

phase("Write the decision memo");
const writer = agent("Writer", {
  system:
    "You write decision memos: the recommendation first, then the cases, risks, and the " +
    "conditions under which a different option wins. Write the memo to out/decision/deliverable.md. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});
const memo = await writer.ask<Memo>(
  `Decision: ${question}\n\nJudgment: ${JSON.stringify(judgment)}\nAnalyses: ${JSON.stringify(analyses)}\n\n` +
    "Write the full memo to out/decision/deliverable.md. Return path and summary."
);

phase("Have someone new read the memo before handing it over");
const reader = agent("Reader", {
  system:
    "You judge a memo as a reader would, from the text alone. You never verify it against the " +
    "repository and you never edit files. Say what is unclear, unsupported, or missing — " +
    "especially where the recommendation does not follow from the analysis.",
});
const notes = await reader.ask<ReaderNotes>(
  `Read ${memo.path} and report what is unclear, unsupported, or missing. Return issues.`
);
if (notes.issues.length > 0) {
  await writer.ask(
    `A reader raised these issues about ${memo.path}. Fix the memo for each:\n${JSON.stringify(notes.issues)}`
  );
}

try {
  await artifact.file("deliverable", memo.path, { title: "Decision memo", primary: true });
} catch {
  await writer.ask(`Re-write the memo to ${memo.path} — the file is missing.`);
  await artifact.file("deliverable", memo.path, { title: "Decision memo", primary: true });
}

return {
  conclusion: `${judgment.why} Recommendation: ${judgment.best}. Memo: ${memo.path}.`,
  findings: [],
  verified: [
    "each option's case was written independently of the others",
    "the final memo had an independent read",
  ],
  notCovered: [
    "the analyses are argued positions, not verified facts",
  ],
};
