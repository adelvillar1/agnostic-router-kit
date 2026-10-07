/* workflow
description: "Calibration-store hygiene as a batch loop: dev-decisions'
  semantic lane indexes what each graded row still references (plan files,
  claims, notes — the stores are redacted, so the index is over surrogate
  text) and reports near-dupe pairs joined against the feedback store. Pairs
  whose two sides carry divergent grades escalate — that is an ambivalence in
  the calibration moat an owner must see; pairs with agreeing grades render a
  merge proposal; ungraded pairs are leads. Report-only by law: nothing
  merges, nothing annotates, rows stay eval-only (embeddings propose,
  sys1/sdm1 dispose). Fails open by name: no dev-decisions, no sem1, or no
  index ends the loop with the refusal verbatim and calibration unchanged."
whenToUse: On a schedule or after calibration-heavy sessions, when the
  question is which graded inputs are near-duplicates of each other and
  whether their grades agree. Run with `--grant semantic`. The loop only
  reads and rebuilds the eval-only index — it never writes the stores.
args:
  corpus:
    type: string
    description: Which corpus to dedup (default "calibration" — the graded stores' index).
    required: false
  limit:
    type: number
    description: Max near-dupe pairs to render (default 20).
    required: false
*/
/**
 * dupe-watch: the exact-input_sha256 moat, given a neighborhood join.
 *
 * Batch-only by the semantic lane's law — every call here runs between agent
 * rounds, and this loop spawns no agents at all. Report-only by the lane's
 * own rule: a similarity score is a lead to confirm, never a verdict, so the
 * loop's outputs are an escalation (owner judgment), a proposal artifact, and
 * nothing else. The near-dupe signal is over SURROGATE text — what each
 * redacted row still references — so every pair here is a lead, and the
 * report says so. Fail-open law: every not-ok branch ends the loop with the
 * refusal's own words and "calibration unchanged".
 */

const corpus = String(args.corpus ?? "calibration").trim() || "calibration";
const limit = Math.max(1, Number(args.limit) || 20);
const FAIL_OPEN = "dupe watch unavailable, calibration unchanged";

// A pair's grade reading: the dedup rows carry each side's graded rows
// (label/task/note) already joined by the CLI. Divergence is over the set of
// labels per side — notes and tasks are context, not the grade itself.
const labelsOf = (graded) =>
  Array.from(new Set((Array.isArray(graded) ? graded : []).map((g) => String(g?.label ?? "")).filter(Boolean))).sort();
const divergence = (aLabels, bLabels) => {
  if (!aLabels.length && !bLabels.length) return "ungraded";
  if (!aLabels.length || !bLabels.length) return "half-graded";
  const same = aLabels.length === bLabels.length && aLabels.every((l, i) => l === bLabels[i]);
  return same ? "agreeing" : "divergent";
};

phase("Index the calibration store");

// The index rebuild is idempotent (embeddings are cached by content sha
// upstream), and its freshness is the loop's first output, not an assumption.
const idx = await world.semantic("semantic-index", { corpus });
if (!idx.ok) {
  log(`${FAIL_OPEN} — semantic-index refused: ${idx.reason}`);
  report({ failOpen: true, command: "semantic-index", refused: idx.reason });
  return {
    conclusion: `${FAIL_OPEN} — ${idx.reason}`,
    failOpen: true,
    command: "semantic-index",
    refused: idx.reason,
    pairs: [],
    verified: ["an unavailable lane ends the loop before any similarity is spent"],
    notCovered: ["dupe analysis — the index could not be built"],
  };
}
const summary = idx.rows.find((r) => r && r.op === "semantic-index") ?? {};
const indexed = Number(summary.indexed ?? summary.rows_indexed ?? 0);
log(`index: ${indexed} vector(s) over corpus '${summary.corpus ?? corpus}'` +
  (summary.rows_skipped != null ? ` — ${summary.rows_skipped} redacted-only row(s) skipped (no recoverable text, never guessed)` : ""));
if (!indexed) {
  log(`${FAIL_OPEN} — the index is empty; run \`dev-decisions semantic-index\` on a machine with graded history first.`);
  return {
    conclusion: `${FAIL_OPEN} — nothing indexed to dedup.`,
    failOpen: true,
    indexed: 0,
    pairs: [],
    verified: ["an empty index ends the loop rather than deduping from nothing"],
    notCovered: ["dupe analysis — the corpus has no recoverable text yet"],
  };
}

phase("Report near-dupe pairs; escalate the divergent ones");

const res = await world.semantic("semantic-dedup", { corpus, limit: String(limit) });
if (!res.ok) {
  log(`${FAIL_OPEN} — semantic-dedup refused: ${res.reason}`);
  report({ failOpen: true, command: "semantic-dedup", refused: res.reason });
  return {
    conclusion: `${FAIL_OPEN} — ${res.reason}`,
    failOpen: true,
    command: "semantic-dedup",
    refused: res.reason,
    pairs: [],
    verified: ["the refusal is reported verbatim, and the loop does not retry it"],
    notCovered: ["dupe analysis — the scorer refused"],
  };
}
const rows = Array.isArray(res.rows) ? res.rows : [];
const pairs = rows
  .filter((r) => r && Array.isArray(r.pair))
  .map((r) => {
    const aLabels = labelsOf(r.gradedA);
    const bLabels = labelsOf(r.gradedB);
    return {
      keys: r.pair.map(String),
      score: Number(r.score),
      ops: Array.isArray(r.ops) ? r.ops.map(String) : [],
      aLabels,
      bLabels,
      reading: divergence(aLabels, bLabels),
      raw: r,
    };
  });
const divergent = pairs.filter((p) => p.reading === "divergent");
const agreeing = pairs.filter((p) => p.reading === "agreeing");
const ungraded = pairs.filter((p) => p.reading === "ungraded" || p.reading === "half-graded");

const col = (s, n) => (String(s).length >= n ? String(s).slice(0, n) : String(s) + " ".repeat(n - String(s).length));
log(
  `score   reading     pair\n` +
    pairs
      .map((p) => `${col(p.score.toFixed(4), 8)}${col(p.reading, 12)}${p.keys[0].slice(0, 16)} <-> ${p.keys[1].slice(0, 16)}`)
      .join("\n"),
);
for (const p of pairs) report({ keys: p.keys, score: p.score, reading: p.reading, aLabels: p.aLabels, bLabels: p.bLabels });

// Divergent grades over near-identical inputs are the calibration moat
// disagreeing with itself — the one thing an owner must adjudicate. One
// escalation per pair, the row verbatim as evidence; the answer is recorded,
// never applied.
for (const p of divergent) {
  const answer = await escalate(
    `near-dupe pair with DIVERGENT grades (score ${p.score.toFixed(4)}): ${p.aLabels.join("/")} vs ${p.bLabels.join("/")} — adjudicate?`,
    JSON.stringify(p.raw),
    "calibration-divergence",
  );
  p.ownerAnswer = String(answer ?? "").slice(0, 300) || null;
  report({ keys: p.keys, escalated: true, reading: "divergent", ownerAnswer: p.ownerAnswer });
}

const md = [
  `# Calibration near-dupes — corpus \`${summary.corpus ?? corpus}\``,
  "",
  `Index: ${indexed} vector(s)${summary.rows_skipped != null ? ` (${summary.rows_skipped} redacted-only rows skipped)` : ""}.`,
  `Pairs: ${pairs.length} — ${divergent.length} divergent (escalated), ${agreeing.length} agreeing (merge proposals), ${ungraded.length} ungraded/half-graded (leads).`,
  "",
  `Reading: **near-dupe is over surrogate text** — what each redacted row still references — so every pair is a lead to confirm, not a fact. Threshold and scores are EVAL-ONLY; nothing merged, nothing annotated.`,
  "",
  "| score | reading | A | B |",
  "|---|---|---|---|",
  ...pairs.map(
    (p) =>
      `| ${p.score.toFixed(4)} | ${p.reading}${p.ownerAnswer != null ? ` — owner: ${p.ownerAnswer}` : ""} | ` +
      `${p.aLabels.join("/") || "ungraded"} | ${p.bLabels.join("/") || "ungraded"} |`,
  ),
  "",
  ...(agreeing.length
    ? [
        "## Merge proposals (owner-apply only)",
        "",
        ...agreeing.map((p) => `- \`${p.keys[0].slice(0, 16)}\` ↔ \`${p.keys[1].slice(0, 16)}\` — both sides: ${p.aLabels.join("/")}`),
      ]
    : []),
  "",
  "Raw dedup rows, verbatim:",
  "```json",
  ...rows.map((r) => JSON.stringify(r)),
  "```",
].join("\n");
await artifact.markdown("dupe-watch", md, { title: `Calibration near-dupes (${corpus})`, primary: true });

return {
  conclusion:
    `dupe-watch: ${pairs.length} near-dupe pair(s) over ${indexed} indexed vector(s) — ` +
    `${divergent.length} divergent escalated, ${agreeing.length} merge proposal(s), ${ungraded.length} leads.`,
  corpus,
  indexed,
  pairs: pairs.map(({ raw, ...p }) => p),
  escalated: divergent.map((p) => p.keys),
  mergeProposals: agreeing.map((p) => p.keys),
  verified: [
    "the index was rebuilt (idempotently) before any similarity was spent; its size and skips are reported",
    "divergent-grade pairs escalated with the row verbatim; the owner's answer is recorded, never applied",
    "the loop writes nothing — merge proposals are artifacts, and the stores leave this run untouched",
  ],
  notCovered: [
    "merges or annotations — the eval-only lane's law: embeddings propose, sys1/sdm1 dispose",
    "pairs whose nearness the surrogate text hides (a redacted row with no recoverable text is invisible here)",
  ],
};
