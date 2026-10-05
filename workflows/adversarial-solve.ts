/* workflow
description: "Solves a problem with several plausible solutions by competition:
  champions build competing solutions independently (no peeking), a judge
  compares them head to head and names the winner's weaknesses and the elements
  worth adopting from the rest, and the winner is finalized with those elements
  folded in."
whenToUse: When a problem has several plausible solutions or approaches and the
  best answer should emerge from competing independent attempts rather than one
  opinion.
args:
  task:
    type: string
    description: The problem to solve, including any constraints the solutions must respect.
    required: true
*/
/**
 * adversarial-solve: solve a problem that has several plausible solutions by
 * competition. Champions build competing solutions independently — no
 * peeking at each other — then a judge compares them head to head, picks
 * the best, and names the elements worth taking from the rest.
 *
 * Dispatch is a CONTRACT, not a hope — every part declares what it builds,
 * owns, and exposes, and the dispatch is validated in code before any builder
 * runs. The failure classes this encodes (all four seen in run
 * 2026-10-05_12-08-04): hidden producer→consumer dependencies between
 * "parallel" parts; two parts claiming the same file path; acceptance
 * criteria whose math contradicts the task; an unpinned stack. What each
 * check runs as:
 *   - file ownership (disjoint paths per part) and self-containment (a part
 *     names only paths it owns): CODE, deterministic.
 *   - one-concern + acceptance-criteria consistency: sys1.classify, inline
 *     `part_atomicity` task_spec (choice + noul heads).
 *   - deliverable acceptance: dev-decisions evidence-gate (the sys1 library
 *     in-process → drex/jev), one holistic criterion, one repair round.
 *   - head-to-head Judgment and the champion's integration: SYSTEM-2 agent
 *     asks, deliberately not sys1 — long-context generations with rich
 *     structured output, outside a bounded classifier's shape.
 *   - deterministic, no judgment: round caps, the cap trigger, gate
 *     unavailable fallbacks, path/name collisions.
 */

interface Approach {
  /** Short id like "1". */
  id: string;
  /** The solution approach's name. */
  name: string;
  /** Why this approach could win, one sentence. */
  rationale: string;
}

interface StrategyList {
  /** The one stack every champion builds in, e.g. "JavaScript on Node 24, node:test, zero npm deps". */
  stack: string;
  approaches: Approach[];
}

interface Part {
  /** Short title of the atomic part. */
  title: string;
  /** One self-contained instruction: what this part builds, complete on its own. */
  instruction: string;
  /** Every workspace path this part creates or modifies. Exclusive — no other part may list these. */
  files: string[];
  /** Acceptance criteria, restated from the task's stated constraints or mechanically checkable. Never new math. */
  acceptance: string[];
  /** The exact interface this part exposes: file paths + exported names/signatures. */
  provides: string;
}

interface PartList {
  parts: Part[];
}

interface PartResult {
  /** What was built, concretely. */
  built: string;
  /** Where the output lives (file paths or "answer"). */
  location: string;
  /** The interface actually exposed: paths + exported names. */
  provides: string;
}

interface Solution {
  /** The approach this solution implements. */
  approach: string;
  /** The solution itself: the design, the fix, or the implementation summary. */
  solution: string;
  /** What was actually produced: file paths, or "answer" for a design-only solution. */
  location: string;
  /** The strongest reason this solution should win. */
  whyBest: string;
}

interface Judgment {
  /** The approach whose solution wins. */
  winner: string;
  /** Why it wins over the others, one or two sentences. */
  why: string;
  /** What would break the winning solution — the judge's own objections. */
  weaknesses: string[];
  /** Concrete elements from other solutions worth taking into the winner. */
  adopt: string[];
}

interface Final {
  /** Path of the finished solution write-up. */
  path: string;
  /** Two or three sentences on what the solution is. */
  summary: string;
}

interface Finding {
  where: string;
  what: string;
  evidence: string;
  status: "verified" | "unconfirmed";
  severity: "low" | "medium" | "high";
}

interface Sys1Gate {
  ok: boolean;
  atomic: boolean | null;
  consistent: boolean | null;
  confidence: number | null;
  provider: string | null;
  reason?: string;
}

const task = String(args.task ?? "").trim() || "Solve the problem.";

// ── deterministic dispatch validation (code, never the model) ───────────────
// The failure classes these catch, from run 2026-10-05_12-08-04: two parts
// claiming one path (clobbered mid-session), and parts whose instructions
// lean on another part's output ("already built (do not modify)") while the
// dispatch is parallel.
const normPath = (p: string): string => String(p ?? "").trim().replace(/^\/+|\/+$/g, "").replace(/^out\/adversarial\//, "").toLowerCase();
const PATH_RE = /[\w./-]+\.(?:js|mjs|cjs|ts|json|md|py)/g;
const DEPENDENCY_PHRASE = /already built|already implemented|do not modify|without modifying|should already exist|has been built/i;

const validateParts = (parts: Part[]): string[] => {
  const problems: string[] = [];
  const owners = new Map<string, string>();
  for (const p of parts) {
    for (const raw of p.files ?? []) {
      const f = normPath(raw);
      const prev = owners.get(f);
      if (prev && prev !== p.title) problems.push(`file collision: ${f} is claimed by both "${prev}" and "${p.title}"`);
      else owners.set(f, p.title);
    }
  }
  for (const p of parts) {
    const owned = new Set((p.files ?? []).map(normPath));
    if (!owned.size) problems.push(`"${p.title}" declares no files — a part must own its every path`);
    for (const m of String(p.instruction).match(PATH_RE) ?? []) {
      const f = normPath(m);
      if (f.includes("/") && !owned.has(f)) {
        problems.push(`"${p.title}" names ${m} in its instruction but does not own it`);
      }
    }
    if (DEPENDENCY_PHRASE.test(String(p.instruction))) {
      problems.push(`"${p.title}" depends on another part's output ("already built"/"do not modify") — every part is standalone; integration is the champion's job`);
    }
  }
  return problems;
};

// ── the sys1 gate (one call, two heads) ─────────────────────────────────────
// atomicity: one concern, one standalone completion. acceptance-consistency:
// the part's criteria contradict neither each other, the task, nor its own
// instruction (the arithmetic-contradiction class from the same run).
// Fail-open: an unreachable gateway dispatches as-is with the reason logged.
const PREFERRED_PROVIDERS = ["decide", "glide", "drex", "jev", "local"];
const GATE_SPLIT_CONFIDENCE = 0.6;
const GATE_CONTRADICTION_P = 0.6;

const sys1Gate = async (p: Part, taskText: string): Promise<Sys1Gate> => {
  const r = await sys1.classify(
    {
      id: "part_atomicity",
      description: "Classify a workflow part: is it atomic, and is its acceptance criteria set self-consistent?",
      heads: [
        {
          id: "atomicity",
          kind: "choice",
          task: "Does this part describe exactly one concern, completable as one standalone completion (ideally one file)?",
          labels: ["atomic", "multi-concern"],
        },
        {
          id: "criteria_contradicted",
          kind: "noul",
          task: "Do this part's acceptance criteria contradict each other, the problem's stated constraints, or the part's own instruction?",
        },
      ],
    },
    `Problem: ${taskText}\n\nPart title: ${p.title}\nPart instruction: ${p.instruction}\nAcceptance criteria: ${(p.acceptance ?? []).join(" | ") || "(none stated)"}`
  );
  if (!r.ok) return { ok: false, atomic: null, consistent: null, confidence: null, provider: null, reason: r.reason };
  for (const pid of PREFERRED_PROVIDERS) {
    const a = r.answers?.[pid] ?? {};
    const atomicity = a.atomicity;
    const crit = a.criteria_contradicted;
    if (atomicity && typeof atomicity.label === "string") {
      return {
        ok: true,
        atomic: atomicity.label === "atomic",
        consistent: crit ? !(Number(crit.noul) > GATE_CONTRADICTION_P) : null,
        confidence: typeof atomicity.confidence === "number" ? atomicity.confidence : null,
        provider: pid,
      };
    }
  }
  return { ok: false, atomic: null, consistent: null, confidence: null, provider: null, reason: "no-answer" };
};

const gateVerdict = (g: Sys1Gate): string => {
  if (!g.ok) return `unavailable (${g.reason}) — dispatching as-is`;
  const parts: string[] = [];
  if (g.atomic === false) parts.push("multi-concern");
  if (g.consistent === false) parts.push("acceptance criteria contradicted");
  if (!parts.length) return `pass${g.confidence != null ? ` (conf ${g.confidence.toFixed(2)}, ${g.provider})` : ""}`;
  return `REJECT: ${parts.join(" + ")}`;
};

const gateNeedsFixup = (g: Sys1Gate): boolean =>
  g.ok && (g.atomic === false || g.consistent === false || (g.confidence != null && g.confidence < GATE_SPLIT_CONFIDENCE && g.atomic !== true));

const readDeliverable = (): string => {
  try {
    return String(files.read("out/adversarial/deliverable.md") ?? "");
  } catch {
    return "";
  }
};

// ── the deliverable gate (dev-decisions evidence-gate) ──────────────────────
// One holistic criterion (the swarm's lesson). Exit 0/1 are real answers;
// anything else is fail-open with the failure recorded.
interface DeliverableGate {
  ran: boolean;
  verdict: "supported" | "not-supported" | "unavailable";
  detail: string;
}

const deliverableGate = async (evidence: string): Promise<DeliverableGate> => {
  const planMd = "- [ ] The finished deliverable solves the stated problem completely, folds in the judge's adopted elements, and addresses the judge's stated weaknesses where possible.\n";
  const evMd = `== C0 ==\n${evidence.slice(0, 19000)}\n`;
  const writer =
    `const fs=require("fs");` +
    `fs.writeFileSync("gate-deliverable-plan.md",${JSON.stringify(planMd)});` +
    `fs.writeFileSync("gate-deliverable-evidence.md",${JSON.stringify(evMd)});`;
  try {
    await world.run("node", ["-e", writer]);
    const g = await world.run("dev-decisions", ["evidence-gate", "gate-deliverable-plan.md", "gate-deliverable-evidence.md"]);
    const out = String(g.stdout ?? "");
    if (g.exitCode !== 0 && g.exitCode !== 1) {
      return { ran: false, verdict: "unavailable", detail: out.slice(0, 160) || `exit ${g.exitCode}` };
    }
    const supported = /verdict:\s*SUPPORTED/i.test(out);
    return { ran: true, verdict: supported ? "supported" : "not-supported", detail: out.trim().split("\n").slice(0, 4).join(" | ") };
  } catch (e) {
    return { ran: false, verdict: "unavailable", detail: String(e?.message ?? e).slice(0, 160) };
  }
};

phase("Name the competing approaches and pin the stack");
const strategist = agent("Strategist", {
  system:
    "You frame problems as solution competitions: pin one implementation stack, then name 2 to 4 genuinely " +
    "different approaches to the same problem — different mechanisms, not variations of one. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});
const strategy = await strategist.ask<StrategyList>(
  `Problem: ${task}\n\n` +
    "Pin ONE stack for the whole competition (language, runtime, test runner, dependency policy — " +
    "state it concretely, e.g. 'JavaScript on Node 24, node:test, zero npm deps'), then name 2 to 4 genuinely " +
    "different solution approaches. Return stack and approaches (id, name, rationale)."
);
log(`stack pinned: ${strategy.stack}`);
log(`${strategy.approaches.length} champions are competing independently`);

phase("Build each solution in parallel, competing independently");
// ── the harness block: measured and rendered by the plane ───────────────────
// Builders get no harness — no CLAUDE.md, no installed-tooling knowledge, no
// shell history. The dispatch IS the harness: runtime facts measured in this
// workspace (never assumed), the pinned stack, the layout, the verification
// recipe. A builder that has to discover these burns rounds it does not have.
// measureEnvironment + renderBrief are the plane's (lib/workflow/harness.mjs);
// nothing here assembles a brief by hand.
const env = await measureEnvironment((cmd: string, args: string[]) => world.run(cmd, args));
log(`harness contract measured: ${env.facts.join(" · ")}`);

const solutions = await Promise.all(
  strategy.approaches.map(async (a) => {
    // Each champion owns a namespace: out/adversarial/<approach-id>/ — builders
    // of different champions can never collide by construction, and the
    // cross-champion file clobbers seen in run 2026-10-05_12-08-04 become
    // impossible.
    const ns = `out/adversarial/${String(a.id).replace(/[^\w-]/g, "")}/`;
    const harness = renderBrief({
      stack: strategy.stack,
      ns,
      verification: `run ONLY the tests your own files define (e.g. node --test ${ns}<file>.test.js); whole-suite or other parts' tests are out of bounds`,
      facts: env.facts,
    });
    const champion = agent(`Champion for ${a.name}`, {
      system:
        "You are one champion in a solution competition. Solve the problem YOUR way, completely " +
        "and to the best of your ability — you never see the other entries. " +
        "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
    });
    // Atomic decomposition with a full dispatch contract: every part declares
    // the files it exclusively owns, acceptance criteria restated from the
    // task's constraints (no new arithmetic), and the interface it exposes.
    // No part may depend on another part's output — integration is the
    // champion's job alone.
    const plan = await champion.ask<PartList>(
      `Problem: ${task}\n\nYour assigned approach: ${a.name} — ${a.rationale}\n` +
        `Stack (pinned for the whole competition): ${strategy.stack}\n` +
        `Every file you name is created under ${ns} (this prefix is added for you; write relative paths).\n\n` +
        `${harness}\n\n` +
        "Decompose YOUR approach into 2 to 5 atomic parts. Each part must be completable as ONE " +
        "standalone completion by a builder who sees nothing but the problem and that part's entry. " +
        "For each part return: title; instruction (what to build); files (every workspace path the part " +
        "creates or modifies — EXCLUSIVE, no other part may list the same path); acceptance (criteria " +
        "restated from the problem's stated constraints or mechanically checkable — never new arithmetic " +
        "or new scenarios); provides (the exact interface the part exposes: paths + exported names/signatures). " +
        "No part may reference, wait for, or modify another part's work — if two things share a file or an " +
        "interface, they are one part. If the approach cannot be split that way, escalate and say so plainly."
    );

    // Dispatch validation: deterministic checks first (code), then the sys1
    // gate. One fix-up round for everything rejected; what still fails at
    // depth's end dispatches with the conflict recorded — the champion's
    // integration brief receives it explicitly.
    const fixup = async (parts: Part[]): Promise<{ parts: Part[]; notes: string[] }> => {
      const notes: string[] = [];
      let current = parts;
      for (let round = 0; round < 2; round++) {
        const problems: string[] = validateParts(current);
        for (const p of current) {
          const g = await sys1Gate(p, task);
          const v = gateVerdict(g);
          log(`gate "${p.title.slice(0, 60)}" → ${v}`);
          if (gateNeedsFixup(g)) problems.push(`"${p.title}": ${v}`);
        }
        if (!problems.length) return { parts: current, notes };
        if (round === 1) {
          notes.push(...problems);
          return { parts: current, notes };
        }
        log(`dispatch rejected ${problems.length} part problem(s) — one fix-up round`);
        const fixed = await champion.ask<PartList>(
          `The dispatch validator rejected parts of your plan:\n${problems.map((s) => `- ${s}`).join("\n")}\n\n` +
            `Return the CORRECTED full part list (same fields: title, instruction, files, acceptance, provides). ` +
            `Every part standalone: its files disjoint from every other part's, its instruction naming only paths ` +
            `it owns, its acceptance criteria consistent with the problem's constraints. Split parts that bundle ` +
            `concerns; restate criteria that introduced new arithmetic.`
        );
        current = fixed.parts;
      }
      return { parts: current, notes };
    };

    const { parts: validated, notes } = await fixup(plan.parts);
    if (notes.length) log(`"${a.name}" dispatched with recorded conflicts: ${notes.length} (the champion's integration brief carries them)`);
    const dispatch: Part[] = validated;

    // One level of recovery when a builder exhausts its tool rounds: the ask
    // was too big, not the builder broken. The SAME builder (it alone knows
    // its own progress) either splits the remaining work into atomic
    // sub-parts or reports itself stuck; sub-parts are dispatched and merged.
    // Depth is one — a sub-part that caps again fails the run loudly.
    const buildPart = async (p: Part): Promise<PartResult> => {
      const builder = agent(`Builder for ${a.name} · ${p.title}`, {
        system:
          "You build one atomic part of one champion's approach in a solution competition. " +
          "You see the problem, your part, and nothing else: no other parts, no other champions, no other files. " +
          "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
        // The plane's contract: owned files, the isolation rule, acceptance
        // criteria, and the interface this part must expose. The engine renders
        // it into every ask and journals it once, so the dispatch is auditable
        // after the fact — the same contract shape the dispatch gate validates.
        contract: {
          files: p.files,
          acceptance: p.acceptance,
          provides: p.provides ? `as declared for this part: ${p.provides}` : undefined,
        },
      });
      const brief = (part: Part): string =>
        `${harness}\n\n` +
        `Problem: ${task}\n\nChampion's approach: ${a.name} — ${a.rationale}\n` +
        `Stack: ${strategy.stack}\n\n` +
        `YOUR PART (${part.title}):\n${part.instruction}\n\n` +
        `Return built, location, and provides (the interface you actually exposed: paths + exported names).`;
      try {
        return await builder.ask<PartResult>(brief(p));
      } catch (e) {
        if (!/did not settle after \d+ tool rounds/.test(String(e?.message ?? e))) throw e;
        log(`"${p.title.slice(0, 60)}" hit the tool-round cap — decomposing the part (one level)`);
        const split = await builder.ask<PartList>(
          `Your attempt at this part hit the tool-round cap before completing. If you were stuck in a loop on one ` +
            `problem rather than steadily building, return {"parts":[]} — the run will escalate. Otherwise return ` +
            `2 to 3 ATOMIC sub-parts that complete the remaining work: each with title, instruction, files (subsets ` +
            `of the paths you already own), acceptance, and provides; each instruction states exactly what already ` +
            `exists from your attempt and what to add.`
        );
        if (!split.parts.length) {
          throw new Error(`part "${p.title}" is stuck, not big — escalating per the builder's own report`);
        }
        const subs = await Promise.all(
          split.parts.map((sp) =>
            agent(`Builder for ${a.name} · ${sp.title}`, {
              system:
                "You build one atomic part of one champion's approach in a solution competition. " +
                "You see the problem, your part, and nothing else: no other parts, no other champions, no other files. " +
                "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
              contract: {
                files: sp.files,
                acceptance: sp.acceptance,
                provides: sp.provides ? `as declared for this part: ${sp.provides}` : undefined,
                extra:
                  "A previous builder attempt on the parent part hit the tool-round cap; its partial work may already exist in the owned paths.",
              },
            }).ask<PartResult>(brief(sp))
          )
        );
        return {
          built: subs.map((s) => s.built).join(" · "),
          location: [...new Set(subs.map((s) => s.location))].join(", "),
          provides: subs.map((s) => s.provides).join("; "),
        };
      }
    };
    const parts = await Promise.all(dispatch.map((p) => buildPart(p)));
    return champion.ask<Solution>(
      `Problem: ${task}\n\nYour approach: ${a.name} — ${a.rationale}\n` +
        `Stack: ${strategy.stack}\n\n` +
        `Your parts, built by your builders:\n${dispatch
          .map((p, i) => `PART ${i + 1} (${p.title})\n  built: ${parts[i].built}\n  location: ${parts[i].location}\n  provides: ${parts[i].provides}`)
          .join("\n\n")}\n\n` +
        (notes.length ? `Dispatch conflicts you must reconcile during integration:\n${notes.map((s) => `- ${s}`).join("\n")}\n\n` : "") +
        "Integrate your parts into ONE complete solution for the problem under " +
        `${ns}. If anything is missing or contradictory between parts, fix it in the integration — you own the ` +
        "whole approach. Return approach, solution, location, and whyBest."
    );
  })
);

phase("Judge the solutions head to head");
const judge = agent("Judge", {
  system:
    "You judge a solution competition head to head: pick the winner, say what would break it, " +
    "and name any concrete elements from the losing entries worth adopting. " +
    "Judge from the solutions as written — ask for failures, not approval. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});
const judgment = await judge.ask<Judgment>(
  `Problem: ${task}\n\nCompeting solutions:\n${JSON.stringify(solutions)}\n\n` +
    "Return winner, why, weaknesses, and adopt."
);

const findings: Finding[] = [];
for (const w of judgment.weaknesses) {
  const f: Finding = {
    where: `winning solution (${judgment.winner})`,
    what: w,
    evidence: "raised by the head-to-head judge reading the solutions as written",
    status: "unconfirmed",
    severity: "medium",
  };
  findings.push(f);
  report(f);
}
report({ winner: judgment.winner, why: judgment.why, adopted: judgment.adopt.length });

phase("Produce the winning solution");
const finisher = agent("Finisher", {
  system:
    "You finalize a winning solution: fold in the adopted elements from the other entries, " +
    "address the judge's stated weaknesses where they can be addressed, and write the finished " +
    "solution to out/adversarial/deliverable.md. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});
const final = await finisher.ask<Final>(
  `Problem: ${task}\n\nWinning solution: ${JSON.stringify(solutions.find((s) => s.approach === judgment.winner) ?? solutions[0])}\n` +
    `Judge's verdict: ${JSON.stringify(judgment)}\nAll entries: ${JSON.stringify(solutions)}\n\n` +
    "Write the finished solution to out/adversarial/deliverable.md, folding in the adopted elements " +
    "and addressing the weaknesses where possible. Return path and summary."
);

try {
  await artifact.file("deliverable", final.path, { title: "Winning solution", primary: true });
} catch {
  await finisher.ask(`Re-write the solution to ${final.path} — the file is missing.`);
  await artifact.file("deliverable", final.path, { title: "Winning solution", primary: true });
}

// ── deliverable gate: one holistic criterion, one bounded repair round ──────
const deliverableEvidence = () =>
  `Problem: ${task}\nWinning approach: ${judgment.winner}\n` +
  `Judge's adopted elements: ${JSON.stringify(judgment.adopt)}\n\n` +
  `Deliverable content:\n${readDeliverable()}`;
let dg = await deliverableGate(deliverableEvidence());
if (dg.ran && dg.verdict === "not-supported") {
  log(`deliverable gate rejected — one repair round`);
  await finisher.ask(
    `The deliverable gate rejected out/adversarial/deliverable.md: ${dg.detail}. Re-write it to address ` +
      `that detail, folding in the judge's adopted elements and the stated weaknesses. Return path and summary.`
  );
  try {
    await artifact.file("deliverable", final.path, { title: "Winning solution (repaired)", primary: true });
  } catch {}
  dg = await deliverableGate(deliverableEvidence());
}
if (!dg.ran) log(`deliverable gate unavailable (${dg.detail}) — proceeding with the failure recorded`);
else if (dg.verdict === "not-supported") log(`deliverable gate still rejects after the repair round — proceeding with the verdict recorded`);

return {
  conclusion: `Winner: ${judgment.winner} — ${judgment.why} ${final.summary} Solution: ${final.path}.`,
  findings,
  verified: [
    `${solutions.length} independent solutions were built and compared head to head`,
    "the winner's weaknesses were named by the judge rather than hidden",
    "every dispatched part passed the deterministic dispatch contract and the sys1 gate",
  ],
  notCovered: [
    "the losing entries are kept as analysis, not implemented",
    "judge weaknesses that the finisher could not address remain open — see the findings",
  ],
};
