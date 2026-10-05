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
  /**
   * Set by the plane's result check when the report did not check out against the
   * part's own contract (a declared file missing, a path it does not own, a result
   * that confirms work rather than describing it). The champion reads it before
   * integrating, so a defective part is reconciled rather than silently built on.
   */
  unverified?: string;
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

const task = String(args.task ?? "").trim() || "Solve the problem.";

/**
 * A part's label for a journal line. The part list is model output, and a plan
 * that arrives without a title is a plan the plane must still be able to log —
 * a null title once reached a `.slice` and killed the run mid-gate (journal
 * 2026-10-05_15-44-17: the judge pair lands, then the run dies before that
 * round's first verdict line). An untrusted shape means the label is coerced.
 */
const partLabel = (p: Part): string => String(p?.title ?? "(part with no title)").slice(0, 60);

/**
 * A part's identity in the run's fact store. The same string labels the facts
 * recorded about a part and scopes the builder dispatched to it, so the scope
 * is not a second name to keep in sync: the tool's own check is `asked ===
 * mine`, and this function is the one place both sides get it from.
 */
const partScope = (ns: string, p: Part): string => `${ns}${partLabel(p)}`;

// ── the dispatch gate: the plane's, not this workflow's ─────────────────────
// validateContract (deterministic: file collisions, self-containment,
// dependency phrases) and judgeContract (sys1, two heads) live in
// lib/workflow/harness.mjs and are shared with the swarm — the same gate, one
// implementation. What follows is this workflow's orchestration of it.

const readDeliverable = (): string => {
  try {
    return String(files.read("out/adversarial/deliverable.md") ?? "");
  } catch {
    return "";
  }
};

// ── result shaping on the way back ──────────────────────────────────────────
// The dispatch gate validates a part's contract before it runs; this is the
// same gate turned around, checking what came back against what was sent. It
// is the plane's validatePartResult — deterministic code, no model — with the
// namespace and the disk probe supplied here, because only this workflow knows
// where its builders write and only the workspace knows what is on it.
// The disk probe is ONE allowlisted command for every declared path, so the
// check costs a single journal line rather than a read per file.
const existsUnder = (ns: string, relPaths: string[]): ((rel: string) => boolean) => {
  const declared = relPaths.map((p) => String(p ?? "").trim()).filter(Boolean);
  if (!declared.length) return () => true;
  const script =
    `const fs=require("node:fs");` +
    `process.stdout.write(JSON.stringify(${JSON.stringify(declared.map((p) => `${ns}${p}`))}` +
    `.map(p=>[p,fs.existsSync(p)&&fs.statSync(p).isFile()])))`;
  let present = new Set<string>();
  try {
    const r = world.run("node", ["-e", script]);
    const pairs = JSON.parse(String(r.stdout ?? "[]")) as Array<[string, boolean]>;
    present = new Set(pairs.filter(([, ok]) => ok).map(([p]) => String(p).slice(ns.length)));
  } catch (e) {
    // A failed probe is not a pass: every declared path reads as missing, so the
    // part fails its own check rather than being waved through on an unmeasured
    // disk. The champion hears about it either way.
    log(`existence probe failed for ${declared.length} path(s): ${String((e as Error)?.message ?? e).slice(0, 120)}`);
  }
  return (rel: string) => present.has(String(rel ?? "").trim());
};

/** The problems in a part's report, or [] when it checks out. */
const resultProblems = (ns: string, p: Part, result: PartResult): string[] => {
  const exists = existsUnder(ns, p.files ?? []);
  return validatePartResult(result, p, { namespace: ns, exists });
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
// The run's fact store, as the coordination layer's record of what it decided
// and measured. The brief still carries all of this by push — a fact known at
// dispatch belongs in the brief, and recall is for what comes after — but the
// journal of `remember` lines is what makes the run's own record auditable.
world.remember({ kind: "task", fact: task });
world.remember({ kind: "stack", fact: String(strategy.stack ?? "") });
world.remember({ kind: "decision", fact: `${strategy.approaches.length} champions competing independently` });

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
world.remember({ kind: "environment", fact: env.facts.join(" · ") });

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
        const problems: string[] = validateContract(current);
        for (const p of current) {
          const g = await judgeContract(p, task, sys1.judge);
          const v = gateVerdict(g);
          log(`gate "${partLabel(p)}" → ${v}`);
          world.remember({ kind: "verdict", part: partScope(ns, p), fact: v });
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
        // This builder's window on the run's fact store: the public facts, plus
        // the facts about this part alone. Naming a sibling part is refused, so
        // the isolation the parts are dispatched under is the isolation they
        // keep while working.
        scope: { part: partScope(ns, p) },
      });
      world.remember({ kind: "status", part: partScope(ns, p), fact: "dispatched" });
      const brief = (part: Part): string =>
        `${harness}\n\n` +
        `Problem: ${task}\n\nChampion's approach: ${a.name} — ${a.rationale}\n` +
        `Stack: ${strategy.stack}\n\n` +
        `YOUR PART (${part.title}):\n${part.instruction}\n\n` +
        `Return built, location, and provides (the interface you actually exposed: paths + exported names).`;

      // Result shaping: check the report against the contract before the champion
      // ever sees it. One re-ask naming what did not check out, because the agent
      // that built the part is the only one that knows whether it mis-reported or
      // never wrote the file. What still fails goes upstream annotated — a champion
      // that integrates a defective part without being told is the failure this
      // check exists to prevent, so "unverified" travels with the result.
      const checked = async (part: Part, result: PartResult, asker: typeof builder): Promise<PartResult> => {
        let problems = resultProblems(ns, part, result);
        if (problems.length) {
          log(`"${partLabel(part)}" did not check out on the way back (${problems.length}) — one re-ask`);
          result = await asker.ask<PartResult>(
            `${brief(part)}\n\nYour report did not check out against your own contract:\n` +
              problems.map((x) => `- ${x}`).join("\n") +
              `\n\nCorrect it. If you described work you did not write, describe what you actually did; if you wrote ` +
              `the files and reported them wrongly, correct the report. Return built, location, and provides again.`
          );
          problems = resultProblems(ns, part, result);
        }
        return problems.length
          ? { ...result, unverified: `${problems.length} problem(s) with this part's own report: ${problems.join("; ")}` }
          : result;
      };

      try {
        return await checked(p, await builder.ask<PartResult>(brief(p)), builder);
      } catch (e) {
        if (!/did not settle after \d+ tool rounds/.test(String(e?.message ?? e))) throw e;
        log(`"${partLabel(p)}" hit the tool-round cap — decomposing the part (one level)`);
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
        // Each sub-agent checks its own report, so the re-ask goes to the agent
        // that did the work rather than to the parent that dispatched it.
        const subs = await Promise.all(
          split.parts.map((sp) => {
            const sub = agent(`Builder for ${a.name} · ${sp.title}`, {
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
              scope: { part: partScope(ns, sp) },
            });
            world.remember({ kind: "status", part: partScope(ns, sp), fact: "dispatched" });
            return { sp, sub };
          })
        );
        const built = await Promise.all(
          subs.map(async ({ sp, sub }) => ({ sp, result: await checked(sp, await sub.ask<PartResult>(brief(sp)), sub) }))
        );
        const unverified = built.filter((b) => b.result.unverified);
        return {
          built: built.map((s) => s.result.built).join(" · "),
          location: [...new Set(built.map((s) => s.result.location))].join(", "),
          provides: built.map((s) => s.result.provides).join("; "),
          ...(unverified.length ? { unverified: unverified.map((u) => u.result.unverified).join(" · ") } : {}),
        };
      }
    };
    const parts = await Promise.all(dispatch.map((p) => buildPart(p)));
    // The store records that each part came back and how — including the parts
    // that did not check out, so the run's own record of itself is not
    // flattering. The champion's brief already carries all of this by push.
    for (const [i, p] of dispatch.entries()) {
      world.remember({
        kind: "status",
        part: partScope(ns, p),
        fact: parts[i].unverified ? "built, but its own report did not check out" : "built",
      });
    }
    return champion.ask<Solution>(
      `Problem: ${task}\n\nYour approach: ${a.name} — ${a.rationale}\n` +
        `Stack: ${strategy.stack}\n\n` +
        `Your parts, built by your builders:\n${dispatch
          .map(
            (p, i) =>
              `PART ${i + 1} (${p.title})\n  built: ${parts[i].built}\n  location: ${parts[i].location}\n  provides: ${parts[i].provides}` +
              // A part that failed its own check is labelled, not hidden: the
              // champion is the only agent that sees the whole approach, so it
              // is the one that must reconcile a defective part.
              (parts[i].unverified ? `\n  UNVERIFIED: ${parts[i].unverified}` : "")
          )
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
world.remember({ kind: "decision", fact: `the head-to-head judge picked: ${String(judgment.winner ?? "")}` });

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
