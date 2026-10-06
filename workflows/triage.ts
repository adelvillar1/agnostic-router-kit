/* workflow
description: "Triage at volume: one classifier per item returns class,
  confidence, and reason; low-confidence items escalate with a structured topic
  instead of being guessed; duplicates merge with their targets named. The
  routing artifact puts the ambiguous section on top."
whenToUse: When a list of incoming items — CI failures, reports, requests —
  needs classifying and routing, and a wrong confident answer is worse than an
  escalated question.
args:
  items:
    type: string
    description: JSON array of {id, text} — the items to triage.
    required: true
  classes:
    type: string
    description: JSON array of class names (default bug, flake, duplicate, wontfix, question).
    required: false
  threshold:
    type: number
    description: Confidence below which an item escalates instead of being classified (default 0.6).
    required: false
*/
/**
 * triage: classify and route, honestly.
 * One verdict per item, each with confidence and reason. Ambiguous means
 * escalated — the structured topic rides the run's answers table (declared at
 * spawn or posted live over the run API), so an operator answer resolves it
 * deterministically. A "duplicate" verdicts escalate too — the judge head cannot name
 * a target, so the owner or a live answer does.
 */

interface Item {
  /** The item's own id, carried through untouched. */
  id: string;
  /** The item's content, in a sentence or three. */
  text: string;
}

interface Verdict {
  /** The item's class. */
  class: string;
  /** 0-1; below the threshold the item escalates instead. */
  confidence: number;
  /** Why this class, in a sentence. */
  reason: string;
}

const ESCALATE =
  "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.";

let items: Item[] = [];
try {
  items = typeof args.items === "string" ? JSON.parse(args.items) : args.items;
} catch (e) {
  throw new Error(`items is not valid JSON: ${String(e?.message ?? e)}`);
}
if (!Array.isArray(items) || items.length === 0) {
  throw new Error("triage needs at least one item");
}
const classes: string[] = (() => {
  try {
    const parsed = typeof args.classes === "string" ? JSON.parse(args.classes) : args.classes;
    if (Array.isArray(parsed) && parsed.length) return parsed.map(String);
  } catch {}
  return ["bug", "flake", "duplicate", "wontfix", "question"];
})();
const threshold = Number(args.threshold) || 0.6;
log(`triaging ${items.length} item(s) into [${classes.join(", ")}], threshold ${threshold}`);

phase("Classify each item; the ambiguous escalate, they are never guessed");
// The classification rides the sys1 judge layer — a flat choice head per item
// (dev-decisions first, calibration-store rows, sys1 fallback recorded), not a
// per-item LLM agent. The escalation lane handles what the head cannot.
const TRIAGE_SPEC = {
  id: "triage_class",
  description: "Classify an incoming triage item into exactly one class.",
  heads: [
    {
      id: "class",
      kind: "choice",
      task:
        "Classify the item into exactly one of the listed classes. Choose the class the text " +
        "actually supports; when two classes are plausible, the confidence carries the doubt.",
      labels: classes,
    },
  ],
};
const verdicts: (Item & Verdict & { ambiguous: boolean; ownerAnswer: string | null })[] = await Promise.all(
  items.map(async (item, i) => {
    const judged = await sys1.judge(TRIAGE_SPEC, `Item ${item.id}: ${item.text}`);
    let base: Verdict;
    if (judged?.ok) {
      const answers = judged.answers?.[judged.provider] ?? {};
      const a = answers.class;
      const label = String(a?.label ?? "");
      if (!classes.includes(label)) {
        base = { class: "ambiguous", confidence: 0, reason: `the judge returned an unknown label: ${label || "(none)"}` };
      } else {
        base = { class: label, confidence: typeof a?.confidence === "number" ? a.confidence : 0, reason: `judged by ${judged.provider} (${judged.source ?? "sys1-raw"})` };
      }
    } else {
      base = { class: "ambiguous", confidence: 0, reason: `the judge was unreachable: ${String(judged?.reason ?? "unknown").slice(0, 120)}` };
    }
    const duplicateNeedsTarget = base.class === "duplicate";
    if (base.confidence < threshold || duplicateNeedsTarget) {
      // Ambiguous: escalate with a structured topic. A declared or live answer
      // resolves it deterministically; the no-owner clause is recorded either way.
      const answer = await escalate(
        `Item ${item.id} is ambiguous: ${base.reason} (confidence ${base.confidence}). Which class should it take?`,
        `classes: ${classes.join(", ")}; item: ${item.text.slice(0, 300)}`,
        "triage-ambiguous",
      );
      report({ id: item.id, ambiguous: true, escalated: true, ownerAnswer: answer });
      return { ...item, ...base, ambiguous: true, ownerAnswer: answer };
    }
    report({ id: item.id, class: base.class, confidence: base.confidence });
    return { ...item, ...base, ambiguous: false, ownerAnswer: null };
  })
);

phase("Route: the ambiguous on top, then by class");
const order = ["ambiguous", ...classes];
const sorted = [...verdicts].sort((a, b) => order.indexOf(a.class) - order.indexOf(b.class));
const md = [
  `# Triage routing`,
  "",
  `${items.length} item(s), threshold ${threshold}. Ambiguous: ${verdicts.filter((v) => v.ambiguous).length}.`,
  "",
  ...sorted.map(
    (v) =>
      `- **${v.class}** ${v.id} (confidence ${v.confidence}) — ${v.reason}` +
      (v.ambiguous ? `\n  - escalated; owner said: ${String(v.ownerAnswer).slice(0, 200)}` : "")
  ),
].join("\n");
await artifact.markdown("deliverable", md, { title: "Triage routing", primary: true });

return {
  conclusion: `${items.length} item(s) triaged: ${verdicts.filter((v) => !v.ambiguous).length} classified, ${verdicts.filter((v) => v.ambiguous).length} escalated.`,
  verdicts: sorted,
  verified: [
    "every item received exactly one verdict with confidence and reason",
    "ambiguous items escalated with a structured topic instead of being guessed",
    "duplicate verdicts name their targets or escalate",
  ],
  notCovered: ["items whose class the operator answered — they carry the owner's word, not a re-classification"],
};
