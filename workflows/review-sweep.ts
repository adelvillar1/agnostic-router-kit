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
  /** "verified" when an independent confirmer reproduced it; "unconfirmed"
   * otherwise; "repeat" when the semantic dedup head matched it to an
   * already-dispositioned finding (annotated, never dropped — the match is
   * EVAL-ONLY). */
  status: "verified" | "unconfirmed" | "repeat";
  /** Present on repeats: the matched finding's id, the EVAL-ONLY score, and
   * the prior disposition the repeat carries. */
  repeatOf?: { id: string; score: number; disposition: string };
  /** How much it matters. */
  severity: "low" | "medium" | "high";
  /** Per-directory revert risk from the cached risk-prior table, when the
   * tabular lane scored the repo; absent when it did not (fail-open). */
  risk?: number;
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

phase("Review each changed file");
const reviews: { file: string; findings: ReviewFinding[] }[] = await Promise.all(
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
    return { file, findings: review?.findings ?? [] };
  })
);
const raw: { file: string; f: ReviewFinding }[] = reviews.flatMap((r) => r.findings.map((f) => ({ file: r.file, f })));
log(`${raw.length} raw finding(s) from review`);

// ── the semantic dedup head (batch, between rounds — the semantic lane's law) ──
// A finding whose text nearly matches an already-dispositioned finding in the
// `findings` corpus carries that disposition as an annotation and does NOT
// re-enter the confirm gate — the gate exists to reproduce new claims; a
// repeat's evidence is its prior disposition. The score is EVAL-ONLY (the
// threshold is journaled below), the near-dupe is over the indexed text, and
// the repeat stays in the report for a human to see — annotated, never
// dropped. Fail-open: no corpus, no index, or no grant turns the head off and
// every finding goes to the gate exactly as before this head existed.
const REPEAT_SCORE = 0.9;
interface Repeat {
  id: string;
  score: number;
  disposition: string;
}
const repeatOf = new Map<number, Repeat>();
try {
  const idx = await world.semantic("semantic-index", { corpus: "findings" });
  if (!idx?.ok) throw new Error(String(idx?.reason ?? "no semantic surface"));
  const summary = (idx.rows ?? []).find((r) => r && r.op === "semantic-index");
  if (!summary || !Number(summary.indexed ?? 0)) {
    throw new Error("findings corpus is empty — record some first (tools/record-findings-index.mjs)");
  }
  // Bounded reader for the matched corpus file's disposition line — the same
  // fixed-argv `node -e` runner the quota loop stats its table with, no shell.
  const READ_TEXT = [
    'const fs=require("fs");',
    'const p=process.argv[process.argv.length-1];',
    'try{process.stdout.write(JSON.stringify({ok:true,text:fs.readFileSync(p,"utf8").slice(0,4000)}))}',
    'catch(e){process.stdout.write(JSON.stringify({ok:false,reason:String(e.code||e.message)}))}',
  ].join("");
  for (let i = 0; i < raw.length; i++) {
    const nn = await world.semantic("semantic-nn", { corpus: "findings", text: raw[i].f.problem, k: "1" });
    if (!nn?.ok) throw new Error(String(nn?.reason ?? "no rows"));
    const hit = repeatFromRows(nn.rows, { threshold: REPEAT_SCORE });
    if (!hit) continue;
    const read = await world.run("node", ["-e", READ_TEXT, hit.path]);
    let text = "";
    try {
      text = String(JSON.parse(String(read?.stdout ?? "{}")).text ?? "");
    } catch {
      text = "";
    }
    const m = text.match(/disposition=([a-z]+)/i);
    repeatOf.set(i, {
      id: String(hit.path).split("/").pop()?.replace(/\.txt$/, "") ?? hit.key.slice(0, 12),
      score: hit.score,
      disposition: m ? m[1].toLowerCase() : "open",
    });
  }
} catch (e) {
  log(`findings corpus unavailable (${String(e?.message ?? e).slice(0, 140)}) — the dedup head is off, every finding goes to the gate`);
}
const annotated = raw.map((entry, i) => ({ ...entry, repeat: repeatOf.get(i) ?? null }));
const toConfirm = annotated.filter((a) => !a.repeat);
log(
  `${toConfirm.length} finding(s) to the confirm gate, ${annotated.length - toConfirm.length} repeat(s) annotated ` +
    `(EVAL-ONLY match, threshold ${REPEAT_SCORE} — annotated, never dropped)`,
);

phase("Confirm every non-repeat finding independently");
const confirmed: Finding[] = await Promise.all(
  toConfirm.map(async (entry, j) => {
    const { file, f } = entry;
    const confirmer = agent(`Confirmer for ${file} finding ${j + 1}`, {
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
const repeats: Finding[] = annotated
  .filter((a) => a.repeat)
  .map((a) => ({
    where: a.file,
    what: a.f.problem,
    evidence:
      `repeat of ${a.repeat!.id} (score ${a.repeat!.score.toFixed(4)}, EVAL-ONLY) — prior disposition: ${a.repeat!.disposition}; confirm gate skipped`,
    status: "repeat",
    severity: a.f.severity,
    repeatOf: { id: a.repeat!.id, score: a.repeat!.score, disposition: a.repeat!.disposition },
  }));
repeats.forEach((f) => report(f));
const findings = [...confirmed, ...repeats].sort((a, b) => {
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return rank[a.severity] - rank[b.severity];
});
log(`${findings.length} findings after the gate (${repeats.length} repeat(s) carried their prior disposition, not re-confirmed)`);

// ── the risk prior (batch, between rounds — the batch-only law) ────────────
// sdm1 reads what the work measures: dev-decisions' risk-prior scores
// per-directory revert risk from git history into its cached table, and the
// sweep annotates each finding with the risk of the directory it landed in.
// This runs between agent rounds, never inside an ask. Fail-open: the tabular
// lane not ok (CLI absent, sdm1 unconfigured, empty table) means findings pass
// through unannotated and the refusal is logged — the review is not gated on
// the prior.
let riskRows: { directory: string; risk: number }[] = [];
try {
  const root = await world.run("git", ["rev-parse", "--show-toplevel"]);
  const repo = String(root?.stdout ?? "").trim().split("\n")[0];
  const r = await world.tabular("risk-prior", repo ? { repo } : {});
  if (r?.ok) {
    riskRows = r.rows
      .map((row) => ({ directory: String(row.directory ?? row.dir ?? "").replace(/^\.\/?/, ""), risk: Number(row.risk ?? row.revert_prior) }))
      .filter((row) => row.directory && Number.isFinite(row.risk));
    log(`risk prior: ${riskRows.length} director(y/ies) scored`);
  } else {
    log(`risk prior unavailable: ${String(r?.reason ?? "no tabular surface").slice(0, 160)} — findings pass through unannotated`);
  }
} catch (e) {
  log(`risk prior unavailable: ${String(e?.message ?? e).slice(0, 160)} — findings pass through unannotated`);
}
// A finding's directory risk is the risk of the tightest table row that is a
// path-boundary prefix of the finding's path (`lib` matches `lib/x.mjs`, never
// `liberal/x.mjs`); no matching row leaves the finding unannotated.
const riskFor = (p: string): number | null => {
  let best: number | null = null;
  for (const r of riskRows) {
    const hit = p === r.directory || p.startsWith(`${r.directory}/`) || p.includes(`/${r.directory}/`);
    if (hit && (best === null || r.risk > best)) best = r.risk;
  }
  return best;
};
for (const f of findings) {
  const risk = riskFor(f.where);
  if (risk !== null) f.risk = risk;
}
const scored = findings.filter((f) => f.risk !== undefined);
const riskiest = scored.slice().sort((a, b) => (b.risk ?? 0) - (a.risk ?? 0))[0];

const md = [
  `# Review: ${task}`,
  "",
  `Changed files reviewed: ${changed.length}. Findings: ${findings.length} ` +
    `(${findings.filter((f) => f.status === "verified").length} reproduced independently` +
    `${findings.some((f) => f.status === "repeat") ? `, ${findings.filter((f) => f.status === "repeat").length} repeats carrying prior dispositions — the match is EVAL-ONLY, confirm the reading` : ""}).`,
  scored.length
    ? `Risk prior: ${scored.length} of ${findings.length} finding(s) carry a directory risk` +
      (riskiest ? `; riskiest: \`${riskiest.where}\` at ${riskiest.risk}` : "") +
      "."
    : "Risk prior: unavailable or no scored row for the changed paths — findings unannotated.",
  "",
  ...findings.map(
    (f) =>
      `- **${f.severity}** \`${f.where}\` — ${f.what}\n  - evidence: ${f.evidence}\n  - ${f.status}` +
      (f.risk !== undefined ? `\n  - directory risk: ${f.risk}` : "")
  ),
].join("\n");
await artifact.markdown("deliverable", md, { title: "Review report", primary: true });

return {
  conclusion: `${changed.length} changed files reviewed; ${findings.length} findings, ${findings.filter((f) => f.status === "verified").length} reproduced by an independent confirmer` +
    `${repeats.length ? `; ${repeats.length} repeat(s) annotated with prior dispositions (EVAL-ONLY match — not re-confirmed)` : ""}.`,
  findings,
  verified: [
    ...(repeats.length
      ? ["every NEW finding was checked by a confirmer who did not produce the review; repeats carried their prior disposition instead, visible in the report"]
      : ["every finding was checked by a confirmer who did not produce the review"]),
    ...(changed.length >= 40 ? [`the first 40 of the changed files`] : [`${changed.length} changed files`]),
  ],
  notCovered: [
    "files outside the change set",
    "runtime behavior — reviews are from reading the code and running checks where one decides",
    ...(repeats.length
      ? ["repeat matches are EVAL-ONLY geometry over indexed text — a wrong match is visible as a repeat line to dispute, never a suppressed finding"]
      : []),
  ],
};
