/* workflow
description: "The calibration feeder: golden tasks with mechanically checkable
  outcomes, replayed across router profiles or pinned models. Grading is
  deterministic string/exit checks — no model judges a grade — and the result
  is a per-candidate accuracy/spend/latency table plus JSONL calibration rows."
whenToUse: When a routing decision needs evidence — which tier actually
  performs on this workload shape — or when the calibration store is hungry.
args:
  golden:
    type: string
    description: JSON array of {id, task, expect, negate?} — expect is a substring the answer must (or must not) contain.
    required: true
  candidates:
    type: string
    description: JSON array of router profiles or provider/model targets ("quick", "hard", "stepfun/step-5-preview").
    required: true
  rounds:
    type: number
    description: Attempts per task per candidate, for flake visibility (default 1).
    required: false
*/
/**
 * router-eval: measure the router's own routing decisions.
 * Grading is mechanical by construction — the grep guard is the grep: no ask
 * in this file grades anything. Every graded attempt lands as a
 * calibration-ready row (candidate, task, verdict, latency); token spend is
 * the run journal's account lines, and this result carries the table.
 */

interface GoldenTask {
  id: string;
  task: string;
  /** Substring the answer must contain (negate: must not contain). */
  expect: string;
  negate?: boolean;
}

interface Attempt {
  answer: string;
}

const ESCALATE =
  "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.";

let golden: GoldenTask[] = [];
try {
  golden = typeof args.golden === "string" ? JSON.parse(args.golden) : args.golden;
} catch (e) {
  throw new Error(`golden is not valid JSON: ${String(e?.message ?? e)}`);
}
let candidates: string[] = [];
try {
  candidates = typeof args.candidates === "string" ? JSON.parse(args.candidates) : args.candidates;
} catch (e) {
  throw new Error(`candidates is not valid JSON: ${String(e?.message ?? e)}`);
}
if (!Array.isArray(golden) || !golden.length || !Array.isArray(candidates) || !candidates.length) {
  throw new Error("router-eval needs at least one golden task and one candidate");
}
const rounds = Math.max(1, Math.min(Number(args.rounds) || 1, 3));

// ── semantic neighbor pre-pass (eval-only, batch — the semantic lane's law) ──
// Each golden task reports its nearest graded neighbors from the calibration
// index — their labels and dispositions are grading CONTEXT, printed beside
// the mechanical verdict. The lane's rule holds: embeddings propose, the
// grep-grade still disposes. Ungranted run, absent CLI, or no index → the
// pre-pass is skipped by name and the eval is byte-for-byte what it was.
const neighborsK = Math.max(0, Number(args.neighborK) ?? 3);
const neighborNotes: Record<string, string> = {};
if (neighborsK > 0) {
  try {
    for (const task of golden) {
      const r = await world.semantic("semantic-nn", { corpus: "calibration", text: task.task, k: String(neighborsK) });
      if (!r?.ok) {
        log(`semantic neighbors unavailable: ${String(r?.reason ?? "no rows").slice(0, 140)} — pre-pass skipped, eval unchanged`);
        break;
      }
      const hits = r.rows.filter((row) => row && row.key && row.score !== undefined);
      if (hits.length) {
        neighborNotes[task.id] = hits
          .map((h) => {
            const graded = Array.isArray(h.graded) ? h.graded : [];
            const labels = graded.map((g) => `${g?.label ?? "?"}@${g?.task ?? "?"}`).join(", ") || "ungraded";
            return `${Number(h.score).toFixed(3)} ${String(h.op ?? "?")} [${labels}]`;
          })
          .join(" · ");
        report({ task: task.id, neighborContext: neighborNotes[task.id], evalOnly: true, applied: false });
      }
    }
  } catch (e) {
    log(`semantic neighbors unavailable (${String(e?.message ?? e).slice(0, 140)}) — pre-pass skipped, eval unchanged`);
  }
}

phase("Replay the golden tasks per candidate");
const rows: { candidate: string; taskId: string; attempt: number; verdict: "pass" | "fail"; latencyMs: number }[] = [];
for (const candidate of candidates) {
  for (const task of golden) {
    for (let attempt = 1; attempt <= rounds; attempt++) {
      const answerer = agent(`Eval ${candidate} · ${task.id} · #${attempt}`, {
        system:
          "You answer the task you are handed, plainly and completely. No tools are available and " +
          "none are needed. " + ESCALATE,
        shape: "verify",
        budget: { rounds: 4, tokens: 40000 },
        model: candidate,
      });
      const t0 = Date.now();
      let answer = "";
      try {
        const out = await answerer.ask<Attempt>(task.task);
        answer = String(out?.answer ?? "");
      } catch (e) {
        answer = `__error__: ${String(e?.message ?? e).slice(0, 200)}`;
      }
      const latencyMs = Date.now() - t0;
      const hit = answer.includes(task.expect);
      const verdict: "pass" | "fail" = task.negate ? (hit ? "fail" : "pass") : hit ? "pass" : "fail";
      rows.push({ candidate, taskId: task.id, attempt, verdict, latencyMs });
      report({ candidate, task: task.id, attempt, verdict, latencyMs });
    }
  }
}

phase("Tabulate");
const table = candidates.map((candidate) => {
  const own = rows.filter((r) => r.candidate === candidate);
  const passes = own.filter((r) => r.verdict === "pass").length;
  const avgMs = Math.round(own.reduce((s, r) => s + r.latencyMs, 0) / Math.max(1, own.length));
  return { candidate, attempts: own.length, accuracy: Number((passes / Math.max(1, own.length)).toFixed(2)), avgLatencyMs: avgMs };
});

const md = [
  `# Router eval`,
  "",
  `Golden tasks: ${golden.length}. Candidates: ${candidates.length}. Attempts per cell: ${rounds}.`,
  "",
  `| candidate | attempts | accuracy | avg latency |`,
  `|---|---|---|---|`,
  ...table.map((t) => `| ${t.candidate} | ${t.attempts} | ${(t.accuracy * 100).toFixed(0)}% | ${t.avgMs}ms |`),
  "",
  `Calibration rows (JSONL):`,
  "```jsonl",
  ...rows.map((r) => JSON.stringify({ kind: "router-eval", candidate: r.candidate, taskId: r.taskId, attempt: r.attempt, verdict: r.verdict, latencyMs: r.latencyMs })),
  "```",
  ...(Object.keys(neighborNotes).length
    ? [
        "",
        `Nearest graded neighbors (EVAL-ONLY context — embeddings propose, the grep-grade disposes; applied: false):`,
        "",
        ...Object.entries(neighborNotes).map(([id, note]) => `- **${id}** — ${note}`),
      ]
    : []),
].join("\n");
await artifact.markdown("deliverable", md, { title: "Router eval table", primary: true });

return {
  conclusion: `router-eval: ${rows.length} graded attempt(s) across ${candidates.length} candidate(s) — ${table.map((t) => `${t.candidate}: ${(t.accuracy * 100).toFixed(0)}%`).join(", ")}.`,
  table,
  rows,
  neighborContext: neighborNotes,
  verified: [
    "grading was mechanical — a substring check, never a model verdict",
    "every graded attempt is a calibration-ready row",
    "latency was measured per attempt",
    ...(Object.keys(neighborNotes).length
      ? ["neighbor context is EVAL-ONLY annotation — the grades themselves never saw it"]
      : []),
  ],
  notCovered: [
    "token spend per candidate lives in the run journal's account lines, not in this table",
  ],
};
