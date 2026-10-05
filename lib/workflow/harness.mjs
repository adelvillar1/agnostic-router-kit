/**
 * The harnessed agent control plane's assembly module.
 *
 * An agent in a workflow run gets no harness: no CLAUDE.md, no shell history,
 * no installed-tooling knowledge, no notion of what it owns. Everything a real
 * harness would have handed it is assembled here, from measured facts and
 * declared contracts:
 *
 *   - measureEnvironment() probes the workspace through the run's own command
 *     allowlist — versions are measured at dispatch time, never assumed;
 *   - renderBrief() renders the run-level harness block (environment, pinned
 *     stack, layout, verification recipe, completeness clause);
 *   - renderContract() renders the per-part contract (owned files, isolation
 *     rule, acceptance criteria, exposed interface) — the block the engine
 *     appends to every ask an agent with a contract makes.
 *
 * Both consumers route through this module: the engine's
 * `agent(name, { system, contract })` and every workflow's brief blocks. A
 * brief assembled anywhere else is the duplication this module exists to end.
 *
 * The judgment path composes dev-decisions first (`dev-decisions judge` — same
 * heads, same rows in the shared calibration store) with raw sys1 as the
 * recorded fallback; see makeJudgingClassifier.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Probes the plane runs to measure the workspace. Allowlisted argv, like every command a run makes. */
const DEFAULT_ENV_PROBES = [
  ["node", ["--version"]],
  ["python3", ["--version"]],
  ["git", ["--version"]],
  ["npm", ["--version"]],
];

export { DEFAULT_ENV_PROBES };

/**
 * Measure the workspace's runtime facts. `run` is the caller's own effect
 * primitive (world.run: fixed argv, allowlisted) so the measurement is as
 * auditable as every other command the run makes. A probe that fails is
 * recorded as "(unavailable)", never assumed: a brief that guesses a version
 * is worse than one that admits the gap.
 */
export async function measureEnvironment(run, opts = {}) {
  const probes = opts.probes ?? DEFAULT_ENV_PROBES;
  const facts = [];
  const toolchain = {};
  for (const [cmd, args] of probes) {
    let line = null;
    try {
      const r = await run(cmd, args);
      const out = String(r?.stdout ?? "").trim().split("\n")[0];
      if (out) line = out;
    } catch {
      /* the allowlist refused it, the binary is absent, or it timed out — the gap is the fact */
    }
    toolchain[cmd] = line;
    facts.push(`- ${cmd}: ${line ?? "(unavailable)"}`);
  }
  return { facts, toolchain };
}

/**
 * The per-part contract block: what this part owns, what bounds it, what it
 * must expose. The isolation rule states the unbounded paths as an explicit
 * fact, because "you own exactly these files" only binds when it also says
 * what happens to every other path — the cross-part clobber class.
 */
export function renderContract(contract = {}) {
  const lines = [];
  const files = (contract.files ?? []).map((f) => String(f).trim()).filter(Boolean);
  if (files.length) lines.push(`Files you own, exclusively (create or modify exactly these): ${files.join(", ")}`);
  lines.push(
    "You own nothing else. Other parts build in parallel elsewhere and their files are out of bounds — " +
      "never read, write, wait for, or test another part's files."
  );
  const acceptance = (contract.acceptance ?? []).map((a) => String(a).trim()).filter(Boolean);
  lines.push(
    acceptance.length
      ? `Acceptance criteria: ${acceptance.join(" | ")}`
      : "Acceptance criteria: as stated in your part's instruction."
  );
  if (contract.provides) {
    lines.push(`Interface you expose (the exact paths and exported names/signatures): ${String(contract.provides)}`);
  }
  if (contract.verification) lines.push(`Verification: ${String(contract.verification)}`);
  if (contract.extra) lines.push(String(contract.extra));
  return lines.join("\n");
}

/**
 * The run-level harness block, rendered once per dispatch context. `facts`
 * comes from measureEnvironment; `stack` is the run's pinned stack; `ns` is the
 * namespace the briefed agent's files live under; `verification` is the recipe
 * that keeps a part from validating itself against parts it does not own. The
 * completeness clause is load-bearing: it converts a missing fact into an
 * escalation before the build, instead of a burned tool round discovering it.
 *
 * A contract (or its ownership/acceptance/provides fields) is inlined at the
 * end when present, so a single render produces a complete builder brief.
 */
export function renderBrief({ stack, ns, ownership, acceptance, provides, verification, facts, extra, contract } = {}) {
  const lines = ["ENVIRONMENT (measured in this workspace at dispatch time — not assumed):"];
  lines.push(...(facts ?? []));
  if (stack) lines.push(`- pinned stack for every part of this competition: ${stack}`);
  if (ns) lines.push(`- workspace layout: your part's files live under ${ns} and nowhere else`);
  if (verification) lines.push(`- verification recipe: ${verification}`);
  lines.push("- no network installs: the stack text's dependency policy is binding");
  lines.push(
    "YOUR BRIEF IS COMPLETE: everything you need is in this message. If a fact you need is missing, escalate BEFORE building."
  );
  const c = contract ?? { files: ownership, acceptance, provides, extra };
  const hasFiles = (c.files ?? []).length > 0;
  const hasAcceptance = (c.acceptance ?? []).length > 0;
  if (hasFiles || hasAcceptance || c.provides || c.extra) {
    lines.push("", renderContract(c));
  }
  return lines.join("\n");
}

// ── deterministic dispatch validation (code, never the model) ───────────────
// The failure classes these catch: two parts claiming one path (a file
// clobbered mid-session), and parts whose instructions lean on another part's
// output while the dispatch is parallel. Ownership rules apply only when the
// dispatch is file-based — a prose dispatch (the swarm's text parts) declares
// no files and is judged on self-containment alone.
const PATH_RE = /[\w./-]+\.(?:js|mjs|cjs|ts|json|md|py)/g;
const DEPENDENCY_PHRASE = /already built|already implemented|do not modify|without modifying|should already exist|has been built/i;
/** Parts write under a run namespace (out/<run>/<champion>/); the prefix is added for them. */
const NAMESPACE_PREFIX_RE = /^out\/[^/]+\//;

const normPath = (p) => String(p ?? "").trim().replace(/^\/+|\/+$/g, "").replace(NAMESPACE_PREFIX_RE, "").toLowerCase();

export function validateContract(parts) {
  const problems = [];
  const list = Array.isArray(parts) ? parts : [];
  const owners = new Map();
  for (const p of list) {
    for (const raw of p.files ?? []) {
      const f = normPath(raw);
      const prev = owners.get(f);
      if (prev && prev !== p.title) problems.push(`file collision: ${f} is claimed by both "${prev}" and "${p.title}"`);
      else owners.set(f, p.title);
    }
  }
  const fileBased = list.some((p) => (p.files ?? []).length > 0);
  for (const p of list) {
    const owned = new Set((p.files ?? []).map(normPath));
    if (fileBased && !owned.size) problems.push(`"${p.title}" declares no files — a part must own its every path`);
    // A part may declare the full namespaced path and reference it relatively
    // in its instruction (or the reverse) — compare as suffixes, so the same
    // file matches both spellings, while a path owned by another part still
    // does not match.
    const ownedList = [...owned];
    const owns = (f) => owned.has(f) || ownedList.some((o) => o.endsWith(`/${f}`));
    for (const m of String(p.instruction).match(PATH_RE) ?? []) {
      const f = normPath(m);
      if (f.includes("/") && !owns(f)) {
        problems.push(`"${p.title}" names ${m} in its instruction but does not own it`);
      }
    }
    if (DEPENDENCY_PHRASE.test(String(p.instruction))) {
      problems.push(
        `"${p.title}" depends on another part's output ("already built"/"do not modify") — every part is standalone; integration is the champion's job`
      );
    }
  }
  return problems;
}

// ── the judgment gate (one call, two heads) ─────────────────────────────────
// atomicity: one concern, one standalone completion. acceptance-consistency:
// the part's criteria contradict neither each other, the task, nor its own
// instruction (the arithmetic-contradiction class). Fail-open: an unreachable
// gateway dispatches as-is with the reason logged. `classify` is injected — the
// workflow passes the engine's judgment primitive, the swarm passes its own
// transport — the plane owns the head shapes, the caller owns the transport.

export const GATE_SPLIT_CONFIDENCE = 0.6;
export const GATE_CONTRADICTION_P = 0.6;
export const PREFERRED_PROVIDERS = ["decide", "glide", "drex", "jev", "local"];

export const PART_ATOMICITY_SPEC = {
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
};

/**
 * Judge one part's contract. Returns {ok, atomic, consistent, confidence,
 * provider, source} — never throws. `classify` is any classifier-shaped
 * function: the raw sys1 transport, or the composed dev-decisions-first one
 * (makeJudgingClassifier) whose `source` records which path judged.
 */
export async function judgeContract(part, taskText, classify) {
  const r = await classify(
    PART_ATOMICITY_SPEC,
    `Problem: ${taskText}\n\nPart title: ${part.title}\nPart instruction: ${part.instruction}\nAcceptance criteria: ${(part.acceptance ?? []).join(" | ") || "(none stated)"}`
  );
  if (!r?.ok) {
    return { ok: false, atomic: null, consistent: null, confidence: null, provider: null, source: r?.source ?? null, reason: r?.reason ?? "unknown", fallbackReason: r?.fallbackReason ?? null };
  }
  const answers = r.answers ?? {};
  // The answering provider first (dev-decisions may name one outside the
  // preferred order), then the preferred order.
  const order = r.provider ? [r.provider, ...PREFERRED_PROVIDERS] : PREFERRED_PROVIDERS;
  for (const pid of order) {
    const a = answers[pid] ?? {};
    const atomicity = a.atomicity;
    const crit = a.criteria_contradicted;
    if (atomicity && typeof atomicity.label === "string") {
      return {
        ok: true,
        atomic: atomicity.label === "atomic",
        consistent: crit ? !(Number(crit.noul) > GATE_CONTRADICTION_P) : null,
        confidence: typeof atomicity.confidence === "number" ? atomicity.confidence : null,
        provider: pid,
        source: r.source ?? "sys1-raw",
        fallbackReason: r.fallbackReason ?? null,
      };
    }
  }
  return { ok: false, atomic: null, consistent: null, confidence: null, provider: null, source: r.source ?? null, reason: "no-answer", fallbackReason: r.fallbackReason ?? null };
}

/** One-line verdict for the journal: pass, the rejection reason, or the fail-open note. */
export function gateVerdict(g) {
  if (!g?.ok) {
    const via = g?.fallbackReason ? ` (after dev-decisions fallback: ${g.fallbackReason})` : "";
    return `unavailable (${g?.reason ?? "unknown"})${via} — dispatching as-is`;
  }
  const parts = [];
  if (g.atomic === false) parts.push("multi-concern");
  if (g.consistent === false) parts.push("acceptance criteria contradicted");
  const conf = g.confidence != null ? ` conf ${g.confidence.toFixed(2)}` : "";
  const via = g.source ? ` via ${g.source}` : "";
  if (!parts.length) return `pass${conf ? ` (${conf.trim()}, ${g.provider}${via})` : ""}`;
  return `REJECT: ${parts.join(" + ")}${conf ? ` (${conf.trim()})` : ""}${via}`;
}

export function gateNeedsFixup(g) {
  return Boolean(
    g?.ok && (g.atomic === false || g.consistent === false || (g.confidence != null && g.confidence < GATE_SPLIT_CONFIDENCE && g.atomic !== true))
  );
}

/**
 * The sys1 transport the plane's judgments ride: POST /v1/classify with an
 * inline task_spec (the sanctioned Node-consumer pattern), fail-open by
 * contract — an unreachable gateway or missing token degrades to {ok:false}
 * and the caller applies its own fallback, never a hang. Env-gated exactly
 * like the router's own judge path: SYS1_URL, SYS1_BEARER_TOKEN,
 * SYS1_PROVIDER, SYS1_TIMEOUT_MS. Callers log into sys1's own JSONL store
 * (log:true) so per-head floors can be fitted later.
 */
export function makeSys1Classifier() {
  return async (spec, text) => {
    const headers = { "Content-Type": "application/json" };
    if (process.env.SYS1_BEARER_TOKEN) headers.Authorization = `Bearer ${process.env.SYS1_BEARER_TOKEN}`;
    const base = (process.env.SYS1_URL ?? "http://127.0.0.1:8400").replace(/\/+$/, "");
    try {
      const res = await fetch(`${base}/v1/classify`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          provider: process.env.SYS1_PROVIDER ?? "core",
          text: String(text ?? ""),
          log: true,
          task_spec: spec,
        }),
        signal: AbortSignal.timeout(Number(process.env.SYS1_TIMEOUT_MS) || 30000),
      });
      if (!res.ok) return { ok: false, reason: `http-${res.status}` };
      const d = await res.json();
      return { ok: true, answers: d?.answers ?? {}, verdict: d?.verdict ?? null, inputSha256: d?.input_sha256 ?? null };
    } catch (e) {
      return { ok: false, reason: String(e?.message ?? e).slice(0, 140) };
    }
  };
}

/**
 * The dev-decisions judging path: `dev-decisions judge` over the same head
 * specs. Rows land in the shared calibration store (input_sha256, per-head
 * answers, dispositions) instead of sys1's private log, so a dispatch gate
 * and this repo's other gates calibrate from the same floor-fitting data.
 * `run` is the caller's own command primitive (world.run in a workflow) —
 * the plane never spawns on its own; the judged text goes through a temp file
 * so the command line stays bounded. Fails soft: a missing CLI, an exit code,
 * or unparseable output returns {ok:false, reason} and the caller falls back.
 */
export function makeDevDecisionsJudge(run) {
  return async (spec, text) => {
    const file = path.join(os.tmpdir(), `dd-judge-${randomUUID()}.txt`);
    try {
      fs.writeFileSync(file, String(text ?? ""), "utf8");
      const r = await run("dev-decisions", [
        "judge", JSON.stringify(spec?.heads ?? []), "--task-id", String(spec?.id ?? "judge"), "--text-file", file,
      ]);
      if (!r || r.exitCode !== 0) {
        return { ok: false, reason: `dev-decisions exit ${r?.exitCode ?? "?"}` };
      }
      const line = String(r.stdout ?? "").trim().split("\n").filter(Boolean).pop();
      const d = JSON.parse(line);
      if (!d?.ok || !d?.answers) return { ok: false, reason: "dev-decisions answered !ok" };
      // Same provider-keyed envelope raw sys1 returns, so one normalize path
      // serves both sources.
      return { ok: true, answers: { [d.provider]: d.answers }, provider: d.provider, source: "dev-decisions", inputSha256: d?.input_sha256 ?? null };
    } catch (e) {
      return { ok: false, reason: `dev-decisions unavailable: ${String(e?.message ?? e).slice(0, 120)}` };
    } finally {
      try {
        fs.unlinkSync(file);
      } catch {
        /* best-effort cleanup */
      }
    }
  };
}

/**
 * The plane's judging classifier: dev-decisions first, raw sys1 as the
 * recorded fallback. Every judgment the plane makes rides this, so
 * (a) fallbacks are visible in the verdict's `source` rather than silent, and
 * (b) a head dev-decisions does not yet carry still judges — via sys1 — with
 * the fallback recorded as a candidate to promote.
 */
export function makeJudgingClassifier(run, fallbackClassify) {
  const dd = makeDevDecisionsJudge(run);
  return async (spec, text) => {
    const ddR = await dd(spec, text);
    if (ddR?.ok) return ddR;
    const raw = await fallbackClassify(spec, text);
    return {
      ...(raw?.ok ? raw : { ok: false, reason: raw?.reason ?? "unknown" }),
      source: "sys1-raw",
      fallbackReason: ddR?.reason ?? "dev-decisions unavailable",
    };
  };
}
