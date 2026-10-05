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

/**
 * Does this part's declared file set cover `f`? Compared as suffixes so a part
 * may declare `out/x/a.js` and reference `a.js` (or the reverse), while a path
 * owned by another part still does not match. One definition, used by the
 * dispatch gate on the way out and the result check on the way back.
 */
const ownsPath = (owned) => (f) => owned.has(f) || [...owned].some((o) => o.endsWith(`/${f}`));

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
    const owns = ownsPath(owned);
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

// ── result shaping on the way back ──────────────────────────────────────────
// A part's ask returns built/location/provides. Handed to the champion as
// returned, it integrates whatever the model chose to say — including a part
// reporting work it never wrote, which is the failure a harness exists to
// prevent and "hope" allows. These are the checks validateContract makes on
// the way out, applied to what came back: the same path normalization, the
// same ownership comparison, the same deterministic-only rule. The side effect
// is injected (`exists`, like `run` in measureEnvironment) so the plane owns
// the check and the caller owns the effect; a caller that supplies no probe
// gets the checks that need no disk rather than a silent pass.

/** Below this a `built` is a confirmation the work happened, not a description of it. */
const MIN_BUILT_CHARS = 16;

/** Strip the namespace a builder writes under, so a reported path meets the relative one its contract declared. */
const underNs = (p, ns) => {
  const s = String(p ?? "").trim().replace(/^\/+|\/+$/g, "").toLowerCase();
  const prefix = String(ns ?? "").trim().replace(/^\/+|\/+$/g, "").toLowerCase();
  return prefix && s.startsWith(`${prefix}/`) ? s.slice(prefix.length + 1) : s;
};

/**
 * Check a part's result against the contract it was dispatched with. Returns
 * the problems found, in the same shape as validateContract — an empty array
 * is the only "this result is sound" answer, so the caller decides what a
 * problem costs.
 *
 * `opts.namespace` is the prefix the caller adds to declared paths
 * (out/<champion>/). Without it a reported `out/c/a.js` cannot be told from a
 * foreign `out/other/a.js`, so the path check stays off rather than guessing.
 * `opts.exists(declaredRelPath)` is the disk probe.
 */
export function validatePartResult(result, part, opts = {}) {
  const problems = [];
  const r = result && typeof result === "object" ? result : {};
  const title = String(part?.title ?? "part");
  const text = (v) => (typeof v === "string" ? v.trim() : "");

  for (const field of ["built", "location", "provides"]) {
    if (!text(r[field])) {
      problems.push(`"${title}" returned no ${field} — a result states what was built, where it landed, and the interface it exposed`);
    }
  }
  const built = text(r.built);
  if (built && built.length < MIN_BUILT_CHARS) {
    problems.push(
      `"${title}" described its work as "${built}" (${built.length} characters) — \`built\` is a description of the work, not a confirmation that it happened`
    );
  }

  const owned = new Set((part?.files ?? []).map(normPath));
  const owns = ownsPath(owned);

  // A path the result claims that its contract never authorized: either work
  // done somewhere it was not allowed, or credit for another part's file.
  // `location` is an enumerated field of paths, so every path is checked;
  // `provides` is prose, so only a path-bearing mention counts.
  if (opts.namespace) {
    for (const field of ["location", "provides"]) {
      const bare = field === "location";
      for (const m of text(r[field]).match(PATH_RE) ?? []) {
        const f = normPath(underNs(m, opts.namespace));
        if ((bare || f.includes("/")) && !owns(f)) {
          problems.push(`"${title}" reports ${m} in its ${field} but does not own it — a part integrates only what its contract authorized`);
        }
      }
    }
  }

  // The one check a model cannot fake and code can: every declared path on
  // disk. A missing file means the part wrote it elsewhere or never wrote it,
  // and either way the champion must not be told it was built.
  if (typeof opts.exists === "function" && owned.size) {
    for (const f of owned) {
      if (!opts.exists(f)) {
        problems.push(`"${title}" owns ${f} and the file is not there — a part reporting work it did not write is worse than one reporting failure`);
      }
    }
  }
  return problems;
}

// ── the run's fact store (the pull half of the context services) ────────────
// An agent's knowledge at dispatch is only what the plane pushed: its brief,
// its contract, its own tool results. Everything else about the run — the
// pinned stack, the verdict on this part, a sibling's status — was unreachable,
// so a question the plane could answer in one line cost a tool round, an
// escalation, or a guess. The store closes that, and two rules make it safe:
//
//   1. Coordination facts only. A fact is something the plane decided or
//      measured, never a part's content. The swarm's isolation ("nothing but
//      the request and its own part") is what makes parts independent and
//      their atomicity measurable, so a sibling's built work is not a fact an
//      agent may ask for — that boundary is code here, not a prompt.
//   2. Declared kinds, not free text. A fact is a journaled row with a kind, so
//      what an agent was told is auditable after the fact, and an unknown kind
//      is refused by name rather than absorbed as prose.
//
// The coordination layer writes (world.remember) and reads everything
// (world.facts); an agent reads through a scoped view (the recall tool), the
// only half an agent ever touches. `remember` is deliberately not on the agent
// surface: a model that could write run facts could rewrite the run's own
// record of itself.

/** The kinds a run fact may be. An unknown kind is refused, never absorbed. */
export const FACT_KINDS = ["task", "stack", "environment", "decision", "verdict", "status", "phase"];

/** Facts per recall result, and the byte cap — the discipline fetchUrl applies on its way to a model. */
const RECALL_MAX_FACTS = 40;
const RECALL_CAP = 8 * 1024;

export function makeRunMemory(journal) {
  const facts = [];
  let seq = 0;

  const remember = ({ kind, fact, part = null } = {}) => {
    if (!FACT_KINDS.includes(String(kind))) {
      return { ok: false, reason: `unknown fact kind: ${String(kind)} (declared: ${FACT_KINDS.join(", ")})` };
    }
    const text = String(fact ?? "").trim();
    if (!text) return { ok: false, reason: "a fact with no text is not a fact" };
    const row = { id: `f${++seq}`, kind: String(kind), text, part: part ? String(part) : null };
    facts.push(row);
    journal?.({ kind: "fact", op: "remember", factId: row.id, factKind: row.kind, part: row.part, chars: row.text.length, text: row.text });
    return { ok: true, id: row.id };
  };

  // The render both readers share: a visible-set rule, a kind filter, a count
  // and a byte cap. A truncation is recorded rather than silent — a fact the
  // agent did not get to read is a fact it will ask about again.
  //
  // `visible` answers "may this reader see this fact", and the two readers
  // differ in exactly one answer: a part's own facts. The plane dispatched
  // them, so it sees every part; an agent sees the public facts and its own,
  // never a sibling's. `plane` is that distinction, and it is why the plane's
  // read cannot be expressed as "scope: null" — a null scope is an agent
  // without a part, not an unscoped reader.
  const render = ({ kind = null, plane = false, mine = null, part = null } = {}) => {
    const want = kind ? String(kind) : null;
    if (want && !FACT_KINDS.includes(want)) {
      return { ok: false, reason: `unknown fact kind: ${want} (declared: ${FACT_KINDS.join(", ")})` };
    }
    const only = part ? String(part) : null;
    const own = mine ? String(mine) : null;
    const rows = facts.filter((f) => {
      if (want && f.kind !== want) return false;
      if (plane) return only ? f.part === only : true;
      return f.part === null || (own !== null && f.part === own);
    });
    const out = [];
    const shown = [];
    let bytes = 0;
    let held = 0;
    let why = null;
    for (const f of rows) {
      if (shown.length >= RECALL_MAX_FACTS) {
        why = `the ${RECALL_MAX_FACTS}-fact cap`;
        held = rows.length - shown.length;
        break;
      }
      const line = `${f.id} [${f.kind}] ${f.text}`;
      if (bytes + line.length + 1 > RECALL_CAP) {
        why = `the ${RECALL_CAP}-byte cap`;
        held = rows.length - shown.length;
        break;
      }
      out.push(line);
      shown.push(f.id);
      bytes += line.length + 1;
    }
    // The truncation rides in the rendered text: a reader that got 40 of 200
    // facts and is told nothing will ask again, and the gap is what tells it to
    // ask for one kind at a time instead.
    if (why) out.push(`… ${held} more fact(s) over ${why} — ask for one kind at a time`);
    // `ids` is what the reader actually got, one per rendered line — not a slice
    // of the matching rows, which would name a fact the reader never saw.
    return { ok: true, text: out.join("\n"), ids: shown, facts: rows.length, bytes };
  };

  /**
   * An agent's read, built per agent because the scope is baked into the
   * closure: one agent's part cannot reach another's facts, and no agent can
   * widen its own view by argument. A scope-free agent (a champion, a bare
   * persona) reads the run's public facts only. `toolJournal` is the caller's
   * own audit line, so a recall is journaled like every other tool call.
   */
  const recallTool = (scope, toolJournal) => (args = {}) => {
    const asked = args.part ? String(args.part) : null;
    const mine = scope?.part ? String(scope.part) : null;
    if (asked && asked !== mine) {
      const refusal = `out of bounds: ${asked} is another part — an agent reads the run's public facts and its own part's, never a sibling's`;
      toolJournal?.({ kind: "tool", tool: "recall", args, grant: null, refused: refusal });
      throw new Error(refusal);
    }
    const r = render({ kind: args.kind ?? null, mine });
    toolJournal?.({
      kind: "tool",
      tool: "recall",
      args: { kind: args.kind ?? null, part: mine },
      grant: null,
      facts: r.ok ? r.facts : null,
      ids: r.ok ? r.ids : null,
      bytes: r.ok ? r.bytes : null,
    });
    return r.ok ? r.text || "no facts recorded for that" : r.reason;
  };

  return {
    remember,
    /**
     * The coordination layer's read. `part` narrows it to one part's facts; it
     * is the plane looking at a part, not an agent being granted one — the
     * scope hides a sibling's facts from the agents that build the parts, not
     * from the layer that dispatched them.
     */
    facts: (opts) => render({ ...opts, plane: true }),
    recallTool,
    size: () => facts.length,
  };
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

// ── settling a competition ───────────────────────────────────────────────────

/**
 * The fewest members that must survive for a competition to be a comparison.
 * Two entries can be judged against each other; one entry has nothing to be
 * judged against, and crowning it by default is a different claim from having
 * won. The number is the plane's, not the caller's: a workflow that feels like
 * lowering it is asking for a comparison it does not have.
 */
export const COMPETITION_MINIMUM = 2;

/**
 * Settle a set of members: every member runs, whatever happens to the others,
 * and the caller learns which came back, which failed and why, and whether what
 * survived is enough. A member that fails is recorded with its reason rather
 * than discarding its siblings — a parallel set is a failure domain, and the
 * plane's job is to keep one member's failure from being the run's.
 *
 * `members` is `[{ name, run }]`, where `run` returns the member's result. The
 * result is never shaped here: what a survivor is belongs to whoever declared
 * the set. `minimum` is how many survivors make the set usable — 2 for a
 * competition, which needs something to compare, 1 for a parallel build, where
 * one part is all a champion needs to carry on integrating.
 *
 * The verdict arrives three ways over the same runs: `survivors` and `failures`
 * split it by outcome, `outcomes` keeps the declaration order so a caller can
 * label each member in its place, and `enough` is the only judgment made.
 */
export async function settleMembers(members = [], opts = {}) {
  const requested = Number(opts.minimum ?? COMPETITION_MINIMUM);
  const minimum = Number.isFinite(requested) && requested > 0 ? Math.trunc(requested) : COMPETITION_MINIMUM;
  const settled = await Promise.allSettled(
    members.map((m) => {
      // A member that throws before it can return a promise — a bad declaration,
      // an agent that would not construct — is that member's failure, exactly
      // like one that rejects. Catching it inside the map is what keeps a
      // synchronous throw from ending the whole set: the settlement's promise is
      // the only one the caller is waiting on.
      try {
        return typeof m?.run === "function" ? Promise.resolve(m.run()) : Promise.reject(new Error("member has no run"));
      } catch (e) {
        return Promise.reject(e);
      }
    })
  );
  const survivors = [];
  const failures = [];
  // The same verdicts in declaration order, because a parallel set's caller
  // usually needs the label in the member's place — a build whose second part
  // failed has a second entry that says so, not a shorter list to re-zip.
  const outcomes = [];
  settled.forEach((r, i) => {
    const name = String(members[i]?.name ?? `member ${i + 1}`);
    if (r.status === "fulfilled") {
      survivors.push({ name, value: r.value });
      outcomes.push({ name, status: "fulfilled", value: r.value });
    } else {
      const reason = String(r.reason?.message ?? r.reason ?? "unknown");
      failures.push({ name, reason });
      outcomes.push({ name, status: "rejected", reason });
    }
  });
  return { survivors, failures, outcomes, enough: survivors.length >= minimum };
}
