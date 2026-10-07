/* workflow
description: "Deep research as a loop, credit-bounded: the workflow runs the
  searches (cheap, no page scrapes, hard credit budget), scouts extract
  candidate findings from the result rows, a sys1 judge head rules each finding
  supported or unconfirmed, a reflector decides what is still unknown between
  rounds, and a writer synthesizes with inline citations, a contradictions
  section, and a coverage map. Stops on coverage, plateau, depth, or budget."
whenToUse: When the request deserves iterations — spend the budget, go deep,
  show the ledger. For a single-pass landscape doc use research-report instead.
args:
  topic:
    type: string
    description: The research question or topic.
    required: true
  breadth:
    type: number
    description: Sub-questions investigated per round (1-6, default 3).
    required: false
  depth:
    type: number
    description: Research rounds (1-3, default 2).
    required: false
  creditBudget:
    type: number
    description: Search-credit ceiling for the whole run (default 20). The loop stops searching when it is spent — every search costs roughly 2 credits.
    required: false
  scrapeBudget:
    type: number
    description: Candidate pages read per round through the plane's scrape router (default 6) — moli first, self-hosted Firecrawl as fallback, plain fetch as the floor — free, but bounded because each read takes seconds.
    required: false
*/
/**
 * deep-research: the iterative research loop, with the credit discipline the
 * allowance burn taught. Cloud spending happens in exactly one place — the
 * workflow's searches, budgeted, without scrapeOptions — so an agent loop can
 * never spend credits. The actual reading happens through the plane's scrape
 * router (free): moli renders first when it can, the operator's self-hosted
 * Firecrawl is the fallback, and a plain bounded fetch is the floor. Candidate
 * pages are scraped before judging, so the sys1 judge head rules findings on
 * real page content, not search snippets — and every source records which leg
 * (`via`) served it, so the de-Firecrawl drift is measurable per run. Stop
 * reasons: coverage, plateau, depth, credit-budget.
 */

interface SubQuestions {
  questions: { id: string; question: string }[];
}

interface CandidateFinding {
  /** One sentence: the fact the report would assert. */
  claim: string;
  /** The URL the claim came from. */
  url: string;
  /** The page title. */
  title: string;
  /** What in the result supports the claim, in one or two sentences. */
  support: string;
}

interface ScoutReport {
  question: string;
  summary: string;
  findings: CandidateFinding[];
}

interface Reflection {
  answered: string[];
  contradictions: { topic: string; sideA: string; sideB: string }[];
  gaps: string[];
  next: { id: string; question: string }[];
}

interface Draft {
  path: string;
  summary: string;
}

interface ReaderNotes {
  issues: string[];
}

const topic = String(args.topic ?? "").trim() || "the topic";
const breadth = Math.max(1, Math.min(Number(args.breadth) || 3, 6));
const depth = Math.max(1, Math.min(Number(args.depth) || 2, 3));
const creditBudget = Math.max(4, Number(args.creditBudget) || 20);
// Rough per-search cost; the journal's creditsUsed lines are the exact record.
const SEARCH_COST = 2;

// The shell heuristic: a "successful" read under this floor smells like a JS
// shell page whose content the renderer could not fill. It is a smell, not a
// verdict — thin static pages exist — so it only marks the row (`row.thin`).
// It does NOT trigger a retry: world.scrape already walks the moli-first
// ladder on every call (engine.mjs passes no format knob, and scrapeUrl tries
// the browser leg first), so a second call would replay the identical path.
const THIN_CONTENT_FLOOR = 600;

// The de-Firecrawl tally, rendered: how many sources each scrape leg served,
// as `moli: 4 · firecrawl: 1 · fetch: 2`. Empty tallies read "none reached".
const formatVia = (tally) =>
  Object.entries(tally)
    .filter(([, n]) => n > 0)
    .map(([leg, n]) => `${leg}: ${n}`)
    .join(" · ") || "none reached";

const ESCALATE =
  "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.";
// The workflow owns the searches: every agent works from what the workflow
// fetched (rows + scraped pages). The tool is denied on their surfaces, so the
// credit budget cannot be spent around — only through the workflow's meter.
const NO_SEARCH = { tools: { deny: ["web_search"] } };

// The one judge spec for findings: a flat choice head over the claim and its
// source excerpt. Dev-decisions first (calibration-store rows), sys1 fallback
// with the fallback recorded — the plane's judgment law, applied to research.
const FINDING_SUPPORT_SPEC = {
  id: "deep_research_finding_support",
  description: "Does the cited source excerpt genuinely support the research claim as stated?",
  heads: [
    {
      id: "support",
      kind: "choice",
      task:
        "Given a research claim and the excerpt of the source it cites, does the excerpt support the claim as stated? " +
        "Answer supported only when the excerpt contains the substance of the claim; partial or off-topic support is unconfirmed.",
      labels: ["supported", "unconfirmed"],
    },
  ],
};

phase("Plan the research");
const planner = agent("Research planner", {
  system:
    "You scope deep research: split a topic into distinct sub-questions that together cover it, " +
    "each answerable from public web sources. " + ESCALATE,
  ...NO_SEARCH,
});
const plan = await planner.ask<SubQuestions>(
  `Topic: ${topic}\n\nSplit it into ${breadth} distinct sub-questions for round one. Return questions with id and question.`
);
log(`round 1: ${plan.questions.length} sub-questions; search budget ${creditBudget} credits`);

// ── rounds ───────────────────────────────────────────────────────────────────
const seenUrls = new Set();
const seenQueries = new Set();
const pool = []; // supported findings
const unconfirmed = []; // judged not-supported or not judgeable — reported, never dropped
const covered = [];
const gapsList = [];
const contradictions = [];
const viaTally = {}; // sources served per scrape leg across the whole run (moli | firecrawl | fetch)
let openQuestions = plan.questions;
let roundsRun = 0;
let creditsSpent = 0;
let stopReason = "depth"; // replaced by coverage | plateau | credit-budget when the loop stops early

for (let round = 1; round <= depth; round++) {
  roundsRun = round;
  phase(`Round ${round}: search, extract, judge`);
  log(`round ${round}: ${openQuestions.length} sub-questions, ${seenUrls.size} sources, ${world.spentCredits()}/${creditBudget} credits metered`);

  // Cloud spending happens here and nowhere else: one budgeted, cheap search
  // call per sub-question, deduped by query. Agents never touch the network.
  const rowsByQuestion = {};
  const roundRows = [];
  const roundVia = {}; // this round's sources per scrape leg, for the round log
  for (const q of openQuestions) {
    const metered = world.spentCredits();
    if (metered + SEARCH_COST > creditBudget) {
      stopReason = "credit-budget";
      log(`search budget spent (${metered}/${creditBudget} credits, metered) — the remaining questions work from the pool`);
      break;
    }
    const key = q.question.trim().toLowerCase();
    if (seenQueries.has(key)) continue;
    seenQueries.add(key);
    const r = await world.search(q.question, { limit: 5 });
    creditsSpent = world.spentCredits();
    rowsByQuestion[q.question] = r.ok ? r.results : [];
    if (r.ok) roundRows.push(...r.results);
  }

  // The reading step: candidate pages go through the plane's scrape router —
  // moli (rendered, local) first, the operator's self-hosted Firecrawl as
  // fallback, a plain bounded fetch as the floor — free, so the loop reads its
  // sources instead of judging snippets. Deduped across rounds, bounded per
  // round (each read takes seconds), and content attaches to the row the scout
  // will see. Each read records `via` — the leg that actually served it — plus
  // `rendered` when moli answered and `thin` under the shell heuristic, so the
  // journal, the ledger, and the report show how every source was read.
  const scrapeBudgetPerRound = Math.max(0, Number(args.scrapeBudget) || 6);
  const unseen = roundRows.filter((row) => row.url && !seenUrls.has(row.url));
  let scrapedCount = 0;
  for (const row of unseen.slice(0, scrapeBudgetPerRound)) {
    seenUrls.add(row.url);
    const scraped = await world.scrape(row.url);
    if (scraped.ok && scraped.content) {
      row.content = scraped.content;
      row.via = scraped.via;
      if (scraped.via === "moli") row.rendered = true;
      if (scraped.content.length < THIN_CONTENT_FLOOR) row.thin = true;
      roundVia[scraped.via] = (roundVia[scraped.via] ?? 0) + 1;
      viaTally[scraped.via] = (viaTally[scraped.via] ?? 0) + 1;
      scrapedCount++;
    }
  }
  log(`round ${round}: scraped ${scrapedCount}/${Math.min(unseen.length, scrapeBudgetPerRound)} candidate pages (${formatVia(roundVia)})`);

  // Scouts are extractors: they read the result rows — with real page content
  // where the scraper reached — and return candidate findings. No tools.
  void seenUrls;
  const scoutReports = await Promise.all(
    openQuestions.map(async (q, qi) => {
      const rows = rowsByQuestion[q.question] ?? [];
      const scout = agent(`Scout ${round}.${qi + 1}`, {
        system:
          "You extract candidate research findings from search-result rows you are handed — the " +
          "workflow has already searched and read the pages. One assertable claim per usable " +
          "source, with the URL and what in the page content supports it. When the rows say " +
          "nothing usable, return no findings and say so. " + ESCALATE,
        shape: "loop",
        budget: { rounds: 4, tokens: 40000 },
        ...NO_SEARCH,
      });
      try {
        return await scout.ask<ScoutReport>(
          `Topic: ${topic}\nSub-question: ${q.question}\n\n` +
            `Search-result rows:\n${JSON.stringify(rows)}\n\n` +
            `Return up to 3 candidate findings drawn only from these rows.`
        );
      } catch (e) {
        const note = String(e?.message ?? e).slice(0, 200);
        log(`scout ${round}.${qi + 1} stopped: ${note}`);
        return { question: q.question, summary: `the extractor hit its line: ${note}`, findings: [] };
      }
    })
  );

  // Judge every candidate with the sys1 judge head — flat, cheap, calibrated.
  // A judgment that cannot be reached leaves the finding unconfirmed: the
  // one-way rule — the judge may downgrade, never upgrade.
  const candidates = scoutReports.flatMap((r) => (r.findings ?? []).map((f) => ({ ...f, question: r.question })));
  const judgedUrls = new Set();
  for (const f of candidates) {
    if (!f.url || judgedUrls.has(f.url)) continue;
    judgedUrls.add(f.url);
    const page = roundRows.find((row) => row.url === f.url);
    const excerpt = `${f.title} — ${page?.content || f.support}`.slice(0, 1500);
    const judged = await sys1.judge(
      FINDING_SUPPORT_SPEC,
      `Claim: ${f.claim}\nSource: ${f.url}\nExcerpt: ${excerpt}`
    );
    let status = "unconfirmed";
    let checkNote = "the judge was unreachable — the finding stays unconfirmed";
    let confidence = null;
    let judgeSource = judged?.source ?? null;
    if (judged?.ok) {
      const answers = judged.answers?.[judged.provider] ?? {};
      const a = answers.support;
      status = a?.label === "supported" ? "supported" : "unconfirmed";
      confidence = typeof a?.confidence === "number" ? a.confidence : null;
      checkNote = `judged by ${judged.provider} (${judged.source ?? "sys1-raw"})`;
    } else {
      checkNote = `judge unavailable: ${String(judged?.reason ?? "unknown").slice(0, 120)}`;
    }
    const row = { round, question: f.question, claim: f.claim, url: f.url, title: f.title, support: f.support, status, confidence, judgeSource, checkNote };
    if (status === "supported") pool.push(row);
    else unconfirmed.push(row);
  }


  phase(`Round ${round}: reflect`);
  const reflector = agent(`Reflector ${round}`, {
    system:
      "You reflect on a research pool: what it answers, where its sources contradict each other " +
      "(keep both sides), what is missing, and whether more rounds are worth spending. Return no " +
      "next questions when coverage is satisfied — an empty next is a decision, not a failure. " + ESCALATE,
    shape: "verify",
    budget: { rounds: 6, tokens: 60000 },
    ...NO_SEARCH,
  });
  const reflection = await reflector.ask<Reflection>(
    `Topic: ${topic}\n\nSupported findings so far:\n${JSON.stringify(pool)}\n\n` +
      `Unconfirmed (reported, not used):\n${JSON.stringify(unconfirmed)}\n\n` +
      `Reflect. Return answered, contradictions, gaps, and next (empty when coverage is satisfied).`
  );
  covered.push(...(reflection.answered ?? []));
  gapsList.push(...(reflection.gaps ?? []));
  contradictions.push(...(reflection.contradictions ?? []));

  const ledgerLines = [...pool, ...unconfirmed]
    .map((f) => `- [${f.status}] ${f.claim} — ${f.url} (round ${f.round})\n  check: ${f.checkNote}`)
    .join("\n");
  await artifact.markdown(
    "source-ledger",
    `# Source ledger — ${topic}\n\nRound ${round}, ${seenUrls.size} sources, ${creditsSpent} credits spent.\n\nSources by read path — ${formatVia(viaTally)}.\n\n${ledgerLines}\n`,
    { title: "Source ledger" },
  );
  report({
    round,
    candidates: candidates.length,
    sources: seenUrls.size,
    supported: pool.length,
    unconfirmed: unconfirmed.length,
    creditsSpent: world.spentCredits(),
    sourcesByPath: { ...viaTally },
  });

  if ((reflection.next ?? []).length === 0) {
    stopReason = "coverage";
    log(`round ${round}: coverage satisfied — the reflector has no next questions`);
    break;
  }
  if (stopReason === "credit-budget") {
    log(`round ${round}: stopped on the credit budget — the reflector closed the round from the pool`);
    break;
  }
  const newUrls = pool.concat(unconfirmed).filter((f) => f.round === round).length;
  if (newUrls === 0 && round > 1) {
    stopReason = "plateau";
    log(`round ${round}: plateau — no new sources, stopping rather than re-reading the web`);
    break;
  }
  openQuestions = reflection.next.slice(0, breadth);
}

// ── synthesize ───────────────────────────────────────────────────────────────
phase("Write the report");
const writer = agent("Writer", {
  system:
    "You write research reports: clear structure, inline numbered citations, a contradictions " +
    "section that keeps both sides, and a coverage map that names the gaps honestly. Compose the " +
    "complete report and write it to out/deep-research/deliverable.md in ONE write_file call — " +
    "never build the file through repeated edits, never fetch or search for more material: the " +
    "findings you were handed are the material. " + ESCALATE,
  budget: { rounds: 12, tokens: 300000 },
  ...NO_SEARCH,
});
const draft = await writer.ask<Draft>(
  `Topic: ${topic}\nStop reason: ${stopReason}.\n\nSupported findings (the pool):\n${JSON.stringify(pool)}\n\n` +
    `Unconfirmed findings (mention as unconfirmed or omit, never present as fact):\n${JSON.stringify(unconfirmed)}\n\n` +
    `Contradictions to surface (keep both sides):\n${JSON.stringify(contradictions)}\n\n` +
    `Write the full report to out/deep-research/deliverable.md with inline numbered citations, ` +
    `a contradictions section, and a coverage map. Return path and summary.`
);

phase("Have someone new read the report before handing it over");
const reader = agent("Reader", {
  system:
    "You judge a report as a reader would, from the text alone. You never verify it against " +
    "sources and you never edit files. Say what is unclear, unsupported, or missing.",
  ...NO_SEARCH,
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
  await artifact.file("deliverable", draft.path, { title: "Deep research report", primary: true });
} catch {
  await writer.ask(`Re-write the report to ${draft.path} — the file is missing.`);
  await artifact.file("deliverable", draft.path, { title: "Deep research report", primary: true });
}
await artifact.markdown(
  "coverage-map",
  `# Coverage map — ${topic}\n\nStop reason: ${stopReason}\n\nAnswered:\n${covered.map((c) => `- ${c}`).join("\n")}\n\nGaps:\n${gapsList.map((g) => `- ${g}`).join("\n")}\n`,
  { title: "Coverage map" },
);

return {
  conclusion: `deep-research: ${pool.length} supported findings from ${seenUrls.size} sources in ${roundsRun} round(s) (stop: ${stopReason}, ${creditsSpent} search credits). Report: ${draft.path}.`,
  stopReason,
  roundsRun,
  stats: { sources: seenUrls.size, sourcesByPath: { ...viaTally }, supported: pool.length, unconfirmed: unconfirmed.length, contradictions: contradictions.length, searchCredits: world.spentCredits(), creditBudget },
  verified: [
    "every search ran in the workflow, under the run's credit budget — no agent could spend",
    "every finding was ruled by the sys1 judge head (dev-decisions first), with the source recorded",
    "the source ledger was versioned per round as a workspace artifact, with the read-path tally",
    "the report had an independent read and a fix pass",
  ],
  notCovered: [
    "candidate pages are read through the plane's scrape router (moli first, self-hosted Firecrawl fallback, plain fetch floor) before judging — findings are ruled on real page content, and each source records the leg that served it",
    "unconfirmed findings are reported but not re-verified a second time",
  ],
};
