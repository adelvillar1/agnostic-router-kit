/**
 * The proxy-internal swarm.
 *
 * A `swarm` verdict used to run a mixture as its closest available
 * approximation. It no longer does: this module executes the swarm.
 *
 *   decompose → parallel build → per-part gate (dev-decisions) → integrate
 *              → cold read → deliverable gate (dev-decisions)
 *
 * Every model call is a metered completion with `execution: "swarm"`, so the
 * ledger shows what the swarm spent per stage. The accept/revise decisions are
 * NOT inline model calls: they run the dev-decisions CLI (evidence-gate), which
 * judges the evidence through its own classifier stack and writes the row into
 * the shared calibration store in its own schema — the same store the rest of
 * the machine's decision gates feed. That is what lets the gates be calibrated
 * later instead of being a hand-set threshold in this file.
 *
 * Degradations, all of them metered and logged:
 *   - a tool-carrying turn (mid-loop) → one tier call, `swarm:skipped-tools`
 *   - decomposition yields < 2 parts, or fails → one tier call,
 *     `swarm:no-decomposition` / `swarm:decompose-failed`
 *   - the gate CLI is missing or errors → the deterministic fallback in this
 *     file runs (accept the part, record `gate:unavailable`), never a hang
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { judgeContract, gateNeedsFixup, makeSys1Classifier, makeJudgingClassifier, makeRunMemory } from "workflow-plane/harness.mjs";

const decoder = new TextDecoder();

const PARTS_MIN = 2;
const PARTS_MAX = 8;
// An idle cap, not a total one: a streaming call that emits tokens is healthy
// however long the part runs, and the only thing worth aborting is a
// connection gone silent. Generous because some models think for minutes
// between the request and the first token.
const STREAM_IDLE_TIMEOUT_MS = 300000;
// Total cap for the non-stream fallback path, where nothing arrives until the
// whole completion exists.
const WORKER_TIMEOUT_MS = 600000;
const GATE_TIMEOUT_MS = 45000;
const GATE_BIN = process.env.DEV_DECISIONS_BIN ?? "dev-decisions";
const REVISE_ROUNDS = 1;

/** Pull a JSON object out of prose: a fenced block, or the first balanced object. */
function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fence?.[1], text].filter((t) => typeof t === "string");
  for (const c of candidates) {
    try {
      const v = JSON.parse(c.trim());
      if (v && typeof v === "object") return v;
    } catch {}
  }
  const start = text.indexOf("{");
  while (start !== -1) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            const v = JSON.parse(text.slice(start, i + 1));
            if (v && typeof v === "object") return v;
          } catch {}
          break;
        }
      }
    }
    const next = text.indexOf("{", start + 1);
    if (next === start) break;
    start = next;
  }
  return null;
}

function unique(list) {
  const out = [];
  const seen = new Set();
  for (const t of list) {
    const key = `${t.providerId}/${t.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

export function createSwarm(deps) {
  const { getConfig, upstream, rewriteBody, thinkingStyleFor, usage, log } = deps;

  const R = () => getConfig().routing ?? {};

  /**
   * The swarm's own record of the request it is answering — the same store the
   * workflows use (lib/workflow/harness.mjs), one per request, journalled
   * through the router's own log rather than run-start/run-done JSONL. A swarm
   * worker is a bare completion with no tool loop, so the pull half (an agent's
   * recall) does not apply to it: what a worker knows is what the swarm pushes
   * into its prompt. The store decides what that is — one place, so a fact is
   * either in every worker's context of its own part or in none of them.
   */
  const memoryFor = (requested) =>
    makeRunMemory((row) => log({ event: "run-fact", requested, op: row.op, factId: row.factId, kind: row.factKind, part: row.part, chars: row.chars, text: row.text }));

  /**
   * One metered completion, always requested as a stream. The stream is not a
   * nicety: with `stream: false` the upstream sends nothing until the whole
   * completion exists, and a thinking-heavy worker can easily run past 5
   * minutes of silence — right into the fetch stack's headers timeout, which
   * kills the connection and reads as "provider instability". With SSE the
   * bytes start flowing immediately and a long generation holds the
   * connection open.
   *
   * The deadline follows the same logic: an IDLE cap, not a total one. A
   * stream that is emitting tokens is healthy no matter how long the part
   * runs; what gets aborted is a connection with nothing arriving for
   * STREAM_IDLE_TIMEOUT_MS. The non-stream fallback keeps the total cap.
   * Returns { text, usage, providerId, model } or null (already metered).
   */
  async function complete(target, messages, { purpose, attempt = 1, requested, workload = "swarm", timeoutMs = WORKER_TIMEOUT_MS, think }) {
    const t0 = Date.now();
    const stage = attempt > 1 ? `${purpose}:failover${attempt}` : purpose;
    // Callers hand over either a resolved policy or a per-worker function; the
    // upstream body needs the resolved one, and passing the function straight
    // through would silently drop a deep-thinking policy.
    const thinkPolicy = typeof think === "function" ? (think(target) ?? { level: "auto", style: null }) : (think ?? { level: "auto", style: null });
    const up = upstream(target.providerId);
    if (!up) {
      usage.record({
        providerId: target.providerId, model: target.model, workload, execution: "swarm",
        requested, reason: `swarm:${stage}:no-upstream`, status: 502, ms: Date.now() - t0, stream: false,
      });
      return null;
    }
    const ac = new AbortController();
    let idleTimer = setTimeout(() => ac.abort(new Error(`no bytes for ${STREAM_IDLE_TIMEOUT_MS}ms`)), STREAM_IDLE_TIMEOUT_MS);
    const bump = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => ac.abort(new Error(`no bytes for ${STREAM_IDLE_TIMEOUT_MS}ms`)), STREAM_IDLE_TIMEOUT_MS);
    };
    try {
      const u = await fetch(`${up.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${up.apiKey}` },
        body: rewriteBody({ model: target.model, messages, stream: true }, target.model, thinkPolicy),
        signal: ac.signal,
      });
      bump();
      if (!u.ok) {
        const raw = await u.text();
        usage.record({
          providerId: target.providerId, model: target.model, workload, execution: "swarm",
          requested, reason: `swarm:${stage}:http-${u.status}`, status: u.status, ms: Date.now() - t0, stream: false,
        });
        log({ event: "swarm", purpose: stage, provider: target.providerId, model: target.model, status: u.status, detail: raw.slice(0, 300) });
        return null;
      }
      const ctype = u.headers.get("content-type") ?? "";
      let text = null;
      let us = null;
      if (ctype.includes("text/event-stream") && u.body) {
        // Consume the SSE: accumulate deltas, keep the usage chunk. Every
        // chunk bumps the idle deadline — a stream that is emitting is
        // healthy, whatever its total length.
        let content = "";
        let buffer = "";
        for await (const chunk of u.body) {
          bump();
          buffer += decoder.decode(chunk, { stream: true });
          let nl;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") continue;
            try {
              const j = JSON.parse(data);
              content += j?.choices?.[0]?.delta?.content ?? "";
              if (j?.usage) us = j.usage;
            } catch {}
          }
        }
        text = content;
      } else {
        // Upstream ignored stream:true and answered one JSON body — the total
        // cap applies, because nothing arrives until the completion exists.
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => ac.abort(new Error(`non-stream body over ${timeoutMs}ms`)), timeoutMs);
        const raw = await u.text();
        let d = null;
        try {
          d = JSON.parse(raw);
        } catch {}
        text = d?.choices?.[0]?.message?.content ?? null;
        us = d?.usage ?? null;
      }
      clearTimeout(idleTimer);
      usage.record({
        providerId: target.providerId, model: target.model, workload, execution: "swarm",
        requested, reason: `swarm:${stage}`, status: u.status, ms: Date.now() - t0,
        promptTokens: us?.prompt_tokens ?? null, completionTokens: us?.completion_tokens ?? null, stream: true,
      });
      if (typeof text !== "string" || !text.length) {
        log({ event: "swarm", purpose: stage, provider: target.providerId, model: target.model, status: u.status, detail: "empty content" });
        return null;
      }
      return { text, usage: us, providerId: target.providerId, model: target.model };
    } catch (err) {
      usage.record({
        providerId: target.providerId, model: target.model, workload, execution: "swarm",
        requested, reason: `swarm:${stage}:fetch-error`, status: 502, ms: Date.now() - t0, stream: true,
      });
      log({ event: "swarm", purpose: stage, provider: target.providerId, model: target.model, error: String(err?.message ?? err).slice(0, 200) });
      return null;
    }
  }

  /**
   * The same completion with reassignment: walk the chain of comparable
   * targets from the roster until one answers. A worker that times out or
   * drops does not kill its part — the part moves to the next model in the
   * pool, the same way a single call walks its tier's candidate chain. Every
   * attempt is its own metered row.
   */
  async function completeChain(targets, messages, opts) {
    const chain = unique(targets.filter(Boolean));
    for (let i = 0; i < chain.length; i++) {
      const out = await complete(chain[i], messages, { ...opts, attempt: i + 1 });
      if (out) return out;
    }
    return null;
  }

  // ── the worker pool ───────────────────────────────────────────────────────
  // The judged tier's target first, then the mixture proposers (different plan
  // pools and model families), deduped. A roster `swarm.workers` block
  // overrides both when present.
  function workerPool(target) {
    const cfg = R();
    const own = Array.isArray(cfg.swarm?.workers) ? cfg.swarm.workers : [];
    const tier = cfg.workloads?.[target.workload];
    const pool = own.length
      ? own.map((w) => ({ providerId: w.providerId, model: w.model }))
      : [tier ? { providerId: tier.providerId, model: tier.model } : null, ...(cfg.mixture?.proposers ?? [])].filter(Boolean);
    return unique(pool).slice(0, PARTS_MAX);
  }

  function integrator(target) {
    const cfg = R();
    return cfg.swarm?.integrator ?? cfg.mixture?.aggregator ?? workerPool(target)[0];
  }

  // ── decompose ─────────────────────────────────────────────────────────────
  async function decompose(signals, target, requested, think) {
    const pool = workerPool(target);
    const out = await completeChain(pool, [
      {
        role: "system",
        content:
          "You decompose one request into independent ATOMIC UNITS: each part must be completable as one standalone " +
          "completion by one worker — a screenful or two of output — seeing nothing but the request and its own part's " +
          "instruction. Split further rather than handing a worker more than one completion's worth. Each part gets a " +
          "stable id, a short title, one self-contained instruction, and 1-4 acceptance criteria phrased as observable " +
          "outcomes. Split ONLY when the work genuinely separates: 2 parts if that is the honest number, never padding. " +
          "If the request cannot be split, return no parts at all.",
      },
      {
        role: "user",
        content:
          `REQUEST:\n${signals.lastUser}\n\n` +
          "Return JSON only: {\"parts\":[{\"id\":\"p1\",\"title\":\"…\",\"instruction\":\"…\",\"acceptance\":[\"…\"]}]}",
      },
    ], { purpose: "decompose", requested, think });
    if (!out) return { parts: [], degraded: "swarm:decompose-failed" };
    const parsed = extractJson(out.text);
    const parts = Array.isArray(parsed?.parts) ? parsed.parts : [];
    const clean = parts
      .filter((p) => p && typeof p.instruction === "string" && p.instruction.trim())
      .slice(0, PARTS_MAX)
      .map((p, i) => ({
        id: String(p.id || `p${i + 1}`),
        title: String(p.title || p.id || `part ${i + 1}`).slice(0, 120),
        instruction: String(p.instruction).trim(),
        acceptance: Array.isArray(p.acceptance) ? p.acceptance.map((a) => String(a)).filter(Boolean).slice(0, 4) : [],
      }));
    if (clean.length < PARTS_MIN) return { parts: [], degraded: "swarm:no-decomposition" };
    return { parts: clean, degraded: null };
  }

  // ── build ─────────────────────────────────────────────────────────────────
  // Each part starts on its round-robin worker but carries the whole pool as
  // its reassignment chain — a worker that times out or drops moves the part
  // to the next comparable model instead of costing the swarm a part.
  async function build(signals, parts, pool, requested, think, memory = null) {
    return Promise.all(
      parts.map((part, i) => {
        const worker = pool[i % pool.length];
        // What the swarm already knows about THIS part, pushed rather than
        // recalled: a swarm worker is a bare completion with no tool loop, so
        // it cannot pull, and the facts are the plane's decision to make — not
        // something the worker should have to ask for.
        const mine = memory ? memory.facts({ part: part.id }).text : "";
        return completeChain([worker, ...pool], [
          {
            role: "system",
            content:
              `You are one worker on a parallel team. You own exactly one part of a larger request and you see no other ` +
              `worker's output. Produce your part in full, in the final voice the request calls for — no preamble, no ` +
              `meta-commentary, no promises about what other parts will cover.`,
          },
          {
            role: "user",
            content:
              `FULL REQUEST (for context):\n${signals.lastUser}\n\n` +
              `YOUR PART (${part.title}):\n${part.instruction}\n\n` +
              `Acceptance criteria for your part:\n${(part.acceptance.length ? part.acceptance : ["the part is complete and directly usable"]).map((a) => `- ${a}`).join("\n")}` +
              (mine ? `\n\nWhat the swarm already decided about your part:\n${mine}` : ""),
          },
        ], { purpose: `build:${part.id}`, requested, think });
      })
    );
  }

  // ── gates (dev-decisions CLI, never an inline model call) ──────────────────
  let gateDir = null;
  function gateWorkspace() {
    if (!gateDir) {
      gateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agnostic-swarm-gate-"));
    }
    return gateDir;
  }

  /**
   * Run the part/deliverable gate through the dev-decisions CLI. Returns
   * { verdict: "supported"|"not-supported", detail, ok: boolean }. `ok:false`
   * means the gate could not run (binary missing, CLI error) — the caller
   * applies its deterministic fallback and records that fact. `planNote`
   * prepends a non-checkbox line to the plan markdown, so a composed pass can
   * say why it ran without disturbing the checkbox order that defines C<i>.
   */
  function runGate(criteria, evidence, { label, requested, planNote = null }) {
    return new Promise((resolve) => {
      if (!criteria.length) {
        resolve({ ok: false, verdict: "not-supported", detail: "no criteria" });
        return;
      }
      const dir = gateWorkspace();
      const planPath = path.join(dir, `plan-${label}.md`);
      const evidencePath = path.join(dir, `evidence-${label}.md`);
      try {
        fs.writeFileSync(planPath, (planNote ? `${planNote}\n` : "") + criteria.map((c, i) => `- [ ] ${c}`).join("\n") + "\n");
        fs.writeFileSync(evidencePath, criteria.map((c, i) => `== C${i} ==\n${evidence[i] ?? "(no evidence produced)"}`).join("\n\n") + "\n");
      } catch (e) {
        resolve({ ok: false, verdict: "not-supported", detail: `gate files unwritable: ${String(e?.message ?? e)}` });
        return;
      }
      execFile(GATE_BIN, ["evidence-gate", planPath, evidencePath], { timeout: GATE_TIMEOUT_MS, encoding: "utf8", maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        // Exit 1 (EXIT_WARN) is a real gate answer: criteria not supported.
        if (err && err.code !== null && err.code !== 0 && typeof stdout === "string" && stdout.includes("verdict:")) {
          log({ event: "swarm-gate", label, requested, verdict: "not-supported", output: stdout.slice(0, 2000) });
          resolve({ ok: true, verdict: "not-supported", detail: stdout.trim().split("\n").slice(0, 6).join(" | ") });
          return;
        }
        if (err) {
          log({ event: "swarm-gate", label, requested, error: String(err?.message ?? err).slice(0, 200), stderr: String(stderr ?? "").slice(0, 400) });
          resolve({ ok: false, verdict: "not-supported", detail: String(err?.message ?? err).slice(0, 160) });
          return;
        }
        const supported = /verdict:\s*SUPPORTED/i.test(stdout);
        log({ event: "swarm-gate", label, requested, verdict: supported ? "supported" : "not-supported", output: stdout.slice(0, 2000) });
        resolve({
          ok: true,
          verdict: supported ? "supported" : "not-supported",
          detail: stdout.trim().split("\n").slice(0, 6).join(" | "),
        });
      });
    });
  }

  // ── the cached risk prior (the tabular lane's read side) ───────────────────
  // dev-decisions' own `risk-prior` verb scores per-directory revert risk from
  // git history into a cached CSV under its store dir. The gate reads that
  // FILE — zero network, zero CLI spawn in the gate path; the batch-only law
  // forbids a TabPFN call inside a synchronous path, and the gate is as
  // synchronous as the router gets. The header is read, not assumed (current
  // writer says `dir,…,revert_prior,…`; the parser accepts the
  // `directory,risk,sampleCount` spelling too). Table absent or unreadable →
  // an empty prior, which is exactly today's behavior.
  let riskRows = null;
  function riskPrior() {
    if (riskRows) return riskRows;
    riskRows = [];
    try {
      const csv = fs.readFileSync(
        path.join(os.homedir(), ".local", "share", "dev-decisions", "tables", "risk_prior.csv"),
        "utf8"
      );
      const lines = csv.split("\n").map((l) => l.trim()).filter(Boolean);
      const head = (lines[0] ?? "").split(",").map((h) => h.trim());
      const dirAt = head.findIndex((h) => h === "dir" || h === "directory");
      const riskAt = head.findIndex((h) => h === "revert_prior" || h === "risk");
      if (dirAt !== -1 && riskAt !== -1) {
        for (const line of lines.slice(1)) {
          const cells = line.split(",");
          const directory = cells[dirAt] ? cells[dirAt].replace(/^\.\/?/, "") : "";
          const risk = Number(cells[riskAt]);
          // A row needs a real directory and a real score: the writer's own
          // root row (`.`) carries an empty prior and scores the repo, not a
          // directory — it must never elevate a part.
          if (!directory || !cells[riskAt] || !Number.isFinite(risk)) continue;
          riskRows.push({ directory, risk });
        }
      }
    } catch {
      /* absent table = no prior = today's behavior */
    }
    return riskRows;
  }

  /** Directories whose risk sits in the top decile of the table — the ones
   * that earn a part a second gate. Empty table → empty set. */
  function topDecileDirs() {
    const rows = riskPrior().slice().sort((a, b) => b.risk - a.risk);
    if (!rows.length) return new Set();
    return new Set(rows.slice(0, Math.max(1, Math.ceil(rows.length * 0.1))).map((r) => r.directory));
  }

  /** Path-like tokens in free text — the decomposer names files and directories
   * in a part's title and instruction, and that text is what the gate sees. */
  function touchedPaths(text) {
    return [...String(text).matchAll(/[\w.@-]+(?:\/[\w.@-]+)+/g)].map((m) => m[0]);
  }

  /** A touched path hits a risky directory when the directory is a
   * path-boundary prefix of it (`lib` matches `lib/workflow/x.mjs`, never
   * `liberal/x.mjs`). */
  const pathTouches = (p, dir) => p === dir || p.startsWith(`${dir}/`) || p.includes(`/${dir}/`);

  /** Whether any of a part's named paths lands in a top-decile-risk directory. */
  function touchesTopRisk(paths, risky) {
    for (const p of paths) for (const dir of risky) if (pathTouches(p, dir)) return true;
    return false;
  }

  /**
   * Per-part accept/revise. Gate first, revise once, then accept or drop.
   * A missing gate is not a hang and not a blank check: the part is accepted
   * with the failure recorded, because dropping good work on an unavailable
   * gate is the worse error.
   *
   * The gate asks ONE holistic question per part — does the part satisfy its
   * instruction and acceptance criteria — not one check per criterion. The
   * first cut mapped the whole part text as the evidence for every criterion,
   * and strict criteria ("have exact names for…") read INSUFFICIENT against a
   * shared blob, failing good parts on technicalities. The granular criteria
   * steer the worker's prompt; the gate decides accept/revise/drop.
   */
  function partCriterion(part) {
    const brief = [
      `The part "${part.title}" fully satisfies its instruction: ${part.instruction}`,
      ...(part.acceptance.length ? [`Acceptance criteria it must meet: ${part.acceptance.join("; ")}`] : []),
    ].join(" — ");
    return brief.replace(/\s+/g, " ").trim();
  }

  async function gateParts(signals, parts, built, requested, think) {
    const accepted = [];
    const report = [];
    const risky = topDecileDirs();
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      let text = built[i]?.text ?? null;
      if (!text) {
        report.push({ id: part.id, state: "build-failed" });
        continue;
      }
      const criterion = partCriterion(part);
      // Risk composition: a part whose title or instruction names a path inside
      // a top-decile-risk directory is gated twice before it is accepted (the
      // elevated pass below). Reading the prior was a cached file parse — no
      // network, no child process here either.
      const elevated = touchesTopRisk(touchedPaths(`${part.title} ${part.instruction}`), risky);
      if (elevated) log({ event: "swarm-risk", part: part.id, requested, outcome: "elevated" });
      let gate = await runGate([criterion], [text], { label: `part-${part.id}`, requested });
      if (!gate.ok) {
        report.push({ id: part.id, state: "accepted", note: `gate unavailable: ${gate.detail}` });
        accepted.push({ ...part, text, providerId: built[i].providerId, model: built[i].model });
        continue;
      }
      let revise = 0;
      while (gate.verdict !== "supported" && revise < REVISE_ROUNDS) {
        revise++;
        const pool = workerPool({ workload: "swarm" });
        const worker = pool[i % pool.length];
        const retry = await completeChain([worker, ...pool], [
          { role: "system", content: "You repair one part of a parallel build so it meets the criteria it missed. Return only the corrected part." },
          {
            role: "user",
            content:
              `FULL REQUEST:\n${signals.lastUser}\n\nYOUR PART (${part.title}):\n${part.instruction}\n\n` +
              `CRITERIA:\n${part.acceptance.map((a) => `- ${a}`).join("\n")}\n\nGATE FINDING:\n${gate.detail}\n\n` +
              `YOUR CURRENT TEXT:\n${text}`,
          },
        ], { purpose: `revise:${part.id}:${revise}`, requested, think });
        if (!retry?.text) break;
        text = retry.text;
        gate = await runGate([criterion], [text], { label: `part-${part.id}-r${revise}`, requested });
        if (!gate.ok) break;
      }
      if (gate.verdict === "supported") {
        if (elevated) {
          // The elevated pass: evidence-gate takes no --elevated flag (its
          // --help offers only --provider), so elevation is expressed as a
          // SECOND, independent invocation of the same gate whose plan records
          // the risk note — and both passes must support. A second classifier
          // read of the same evidence is the honest v1 of "more scrutiny" for
          // top-decile-risk directories; a flag would have to mean the same
          // thing with nothing behind it.
          const eGate = await runGate([criterion], [text], {
            label: `part-${part.id}-elevated`,
            requested,
            planNote: "> elevated pass — this part touches a top-decile revert-risk directory (risk-prior table); both gate passes must support.",
          });
          if (!eGate.ok) {
            // Same fail-open law as the primary gate: an unavailable elevated
            // gate is recorded, not a reason to drop good work.
            report.push({ id: part.id, state: "accepted", elevated: true, note: `elevated gate unavailable: ${eGate.detail}` });
            accepted.push({ ...part, text, providerId: built[i].providerId, model: built[i].model });
            continue;
          }
          if (eGate.verdict !== "supported") {
            report.push({ id: part.id, state: "dropped", elevated: true, reason: `elevated gate: ${eGate.detail}` });
            continue;
          }
        }
        report.push({ id: part.id, state: "accepted", ...(revise ? { revise } : {}), ...(elevated ? { elevated: true } : {}) });
        accepted.push({ ...part, text, providerId: built[i].providerId, model: built[i].model });
      } else if (!gate.ok) {
        report.push({ id: part.id, state: "accepted", note: "gate unavailable after revise" });
        accepted.push({ ...part, text, providerId: built[i].providerId, model: built[i].model });
      } else {
        report.push({ id: part.id, state: "dropped", reason: gate.detail });
      }
    }
    return { accepted, report };
  }

  // ── integrate + cold read ─────────────────────────────────────────────────
  async function integrate(signals, parts, requested, target, think, extra = "") {
    const agg = integrator(target);
    const pool = workerPool(target);
    const rest = pool.filter((w) => !(w.providerId === agg.providerId && w.model === agg.model));
    const out = await completeChain([agg, ...rest], [
      {
        role: "system",
        content:
          "You merge the parts of a parallel build into ONE answer for the original request. Keep every part's content, " +
          "resolve contradictions in favor of what is correct, drop duplication and cross-part chatter, and output only " +
          "the merged answer in the voice the request asks for.",
      },
      {
        role: "user",
        content:
          `REQUEST:\n${signals.lastUser}\n\n` +
          parts.map((p, i) => `PART ${i + 1} (${p.title}):\n${p.text}`).join("\n\n") +
          (extra ? `\n\nINTEGRATION FIXES REQUIRED:\n${extra}` : ""),
      },
    ], { purpose: extra ? "integrate:repair" : "integrate", requested, think });
    return out;
  }

  async function coldRead(signals, text, requested, target, think) {
    return completeChain(workerPool(target), [
      {
        role: "system",
        content:
          "You read one assembled answer with no knowledge of how it was built. Judge it only against the original " +
          "request: what is missing, wrong, or contradictory. Be concrete and brief.",
      },
      { role: "user", content: `REQUEST:\n${signals.lastUser}\n\nANSWER:\n${text}\n\nReturn JSON: {"ok":true|false,"gaps":["…"]}` },
    ], { purpose: "cold-read", requested, think });
  }

  function degrade(singleTarget, reason, requested, workload = "hard") {
    // The verdict was still a swarm, so it counts as a swarm delegation — but no
    // swarm call was made, so no metered completion row here: forward() records
    // the single call that actually serves. Double counting one request as two
    // would make the ledger lie about spend. The workload name travels with the
    // target because a degraded swarm still answers that workload's request.
    usage.recordDelegation?.({ workload, execution: "swarm" });
    log({ event: "swarm", degraded: reason, requested, to: singleTarget ? `${singleTarget.providerId}/${singleTarget.model}` : null });
    return { kind: "single", ...singleTarget, workload, execution: "single", reason };
  }

  /**
   * Serve a swarm verdict. Returns either a target to forward as a single call
   * (degradation), or nothing after it has written the response itself.
   */
  async function handle(res, body, signals, target, thinkLevel) {
    const requested = signals.requestedModel;
    const workload = target.workload ?? "hard";
    const think = (p) => ({ level: thinkLevel, style: thinkingStyleFor(p.providerId) });

    if (signals.toolDefs > 0 || signals.hasToolMessages) {
      return degrade(R().workloads?.[workload] ?? R().workloads?.hard ?? target, "swarm:skipped-tools", requested, workload);
    }

    const t0 = Date.now();
    const memory = memoryFor(requested);
    memory.remember({ kind: "task", fact: String(signals.lastUser ?? "").slice(0, 2000) });
    log({ event: "swarm", stage: "start", sessionKey: signals.sessionKey, requested, workload });

    const pool = workerPool(target);
    let { parts, degraded } = await decompose(signals, target, requested, think);
    if (degraded) {
      log({ event: "swarm", stage: "decompose", degraded, requested });
      memory.remember({ kind: "status", fact: `decomposition degraded: ${degraded}` });
      return degrade(R().workloads?.[workload] ?? pool[0], degraded, requested, workload);
    }
    log({ event: "swarm", stage: "decompose", parts: parts.length, titles: parts.map((p) => p.title), requested });
    memory.remember({ kind: "decision", fact: `decomposed into ${parts.length} parts: ${parts.map((p) => p.title).join("; ")}` });

    // ── atomicity gate: the plane's (lib/workflow/harness.mjs), shared with the
    // workflows' dispatch gate — same head shapes, same thresholds, one
    // transport. Judging composes dev-decisions first (rows in the shared
    // calibration store) with raw sys1 as the recorded fallback; multi-concern
    // → ONE re-decomposition round for that part; sub-parts are gated and
    // dispatched regardless (depth spent). Gate unavailable → fail-open with
    // the outcome recorded, never a hang.
    const runFixed = (cmd, args) =>
      new Promise((resolve) => {
        execFile(cmd, args, { timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
          resolve({ exitCode: err ? (err.code ?? 1) : 0, stdout: String(stdout ?? "") });
        });
      });
    const classify = makeJudgingClassifier(runFixed, makeSys1Classifier());
    const atomicityVerdict = async (part) => {
      if (!process.env.SYS1_BEARER_TOKEN) return { ok: false, reason: "no-sys1-token" };
      const g = await judgeContract(part, signals.lastUser, classify);
      if (!g.ok) return { ok: false, reason: g.reason };
      return g;
    };
    const atomicDispatch = [];
    for (const part of parts) {
      const v = await atomicityVerdict(part);
      if (!v.ok) {
        log({ event: "swarm-atomicity", label: String(part.title ?? "").slice(0, 80), outcome: "unavailable", reason: v.reason, requested });
        memory.remember({ kind: "verdict", part: part.id, fact: `atomicity: unavailable (${v.reason}) — dispatched as written` });
        atomicDispatch.push(part);
        continue;
      }
      log({ event: "swarm-atomicity", label: String(part.title ?? "").slice(0, 80), verdict: v.atomic ? "atomic" : "multi-concern", conf: v.confidence, provider: v.provider, source: v.source, requested });
      memory.remember({ kind: "verdict", part: part.id, fact: `atomicity: ${v.atomic ? "atomic" : "multi-concern"} (${v.confidence ?? "?"})` });
      if (!gateNeedsFixup(v)) {
        atomicDispatch.push(part);
        continue;
      }
      const sub = await decompose(signals, `${part.title}: ${part.instruction}`, requested, think);
      if (sub.parts.length >= PARTS_MIN) {
        for (const sp of sub.parts) {
          const v2 = await atomicityVerdict(sp);
          log({ event: "swarm-atomicity", label: String(sp.title ?? "").slice(0, 80), verdict: v2.ok ? (v2.atomic ? "atomic" : "multi-concern") : "unavailable", depth: 2, requested });
          memory.remember({ kind: "verdict", part: sp.id, fact: `atomicity: ${v2.ok ? (v2.atomic ? "atomic" : "multi-concern") : "unavailable"} at depth 2 (split from "${part.title}")` });
          atomicDispatch.push(sp);
        }
      } else {
        log({ event: "swarm-atomicity", label: String(part.title ?? "").slice(0, 80), outcome: "split-failed", degraded: sub.degraded, requested });
        memory.remember({ kind: "status", part: part.id, fact: `multi-concern and its split failed (${sub.degraded ?? "no fallback"}) — dispatched as written` });
        atomicDispatch.push(part);
      }
    }
    parts = atomicDispatch;

    // Each part's own facts are recorded before it builds, so the worker reads
    // the verdict about its atomicity rather than the plane deciding in
    // silence.
    for (const p of parts) memory.remember({ kind: "status", part: p.id, fact: "dispatched" });
    const built = await build(signals, parts, pool, requested, think, memory);
    const builtOk = built.filter(Boolean).length;
    // A partial swarm is worse than no swarm: integrating 1 of 4 parts answers
    // a quarter of the question and says nothing about it. Fewer than 60% of
    // the parts building means the whole request goes to one strong call.
    const minBuilt = Math.max(2, Math.ceil(parts.length * 0.6));
    if (builtOk < Math.min(minBuilt, parts.length)) {
      log({ event: "swarm", stage: "build", error: "too-few-parts", built: builtOk, of: parts.length, need: minBuilt });
      return degrade(R().workloads?.[workload] ?? pool[0], "swarm:build-degraded", requested, workload);
    }
    log({ event: "swarm", stage: "build", built: builtOk, of: parts.length });

    const { accepted, report } = await gateParts(signals, parts, built, requested, think);
    for (const r of report) {
      memory.remember({ kind: "status", part: r.id, fact: r.state === "dropped" ? `dropped: ${r.reason ?? "gate finding"}` : `accepted${r.revise ? ` after ${r.revise} repair round(s)` : ""}` });
    }
    log({ event: "swarm", stage: "gate", accepted: accepted.length, report, ms: Date.now() - t0 });
    if (!accepted.length) {
      return degrade(R().workloads?.[workload] ?? pool[0], "swarm:all-parts-dropped", requested, workload);
    }

    let merged = await integrate(signals, accepted, requested, target, think);
    if (!merged) {
      return degrade(R().workloads?.[workload] ?? pool[0], "swarm:integrate-failed", requested, workload);
    }

    // Cold read + deliverable gate: one bounded repair round, then deliver with
    // any remaining gap recorded rather than withholding an answer the client
    // is waiting for.
    let read = await coldRead(signals, merged.text, requested, target, think);
    let readParsed = read ? extractJson(read.text) : null;
    let gaps = Array.isArray(readParsed?.gaps) ? readParsed.gaps.map(String).filter(Boolean) : [];
    let criterion = gaps.length ? `Address every gap the cold read found: ${gaps.join("; ")}` : "The answer fully satisfies the original request";
    let deliverable = await runGate([criterion], [merged.text], { label: "deliverable", requested });
    memory.remember({ kind: "verdict", fact: `deliverable: ${deliverable.ok ? deliverable.verdict : `unavailable (${deliverable.detail})`}` });
    let repair = 0;
    while (deliverable.ok && deliverable.verdict !== "supported" && gaps.length && repair < REVISE_ROUNDS) {
      repair++;
      const retry = await integrate(signals, accepted, requested, target, think, gaps.map((g) => `- ${g}`).join("\n"));
      if (!retry) break;
      merged = retry;
      read = await coldRead(signals, merged.text, requested, target, think);
      readParsed = read ? extractJson(read.text) : null;
      gaps = Array.isArray(readParsed?.gaps) ? readParsed.gaps.map(String).filter(Boolean) : [];
      criterion = gaps.length ? `Address every gap the cold read found: ${gaps.join("; ")}` : "The answer fully satisfies the original request";
      deliverable = await runGate([criterion], [merged.text], { label: `deliverable-r${repair}`, requested });
    }

    // The swarm's spend lives in the ledger, one row per stage. The response
    // reports the merged answer's own usage and invents nothing on top.
    const pt = merged.usage?.prompt_tokens ?? 0;
    const ct = merged.usage?.completion_tokens ?? 0;
    const totalUsage = { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct };

    log({
      event: "swarm",
      stage: "done",
      requested,
      parts: parts.length,
      accepted: accepted.length,
      dropped: report.filter((r) => r.state === "dropped").length,
      gateVerdict: deliverable.verdict,
      gateOk: deliverable.ok,
      repairs: repair,
      finalModel: merged.model,
      finalProviderId: merged.providerId,
      ms: Date.now() - t0,
      facts: memory.size(),
    });
    memory.remember({ kind: "status", fact: `delivered: ${accepted.length} of ${parts.length} parts, ${repair} repair round(s)` });

    if (res.writableEnded || res.destroyed) return;
    if (signals.stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "x-router-execution": "swarm",
        "x-router-workload": "swarm",
      });
      const id = "swarmcmpl-" + randomUUID();
      const created = Math.floor(Date.now() / 1000);
      const base = { id, object: "chat.completion.chunk", created, model: "swarm" };
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}\n\n`);
      for (let i = 0; i < merged.text.length; i += 120) {
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: merged.text.slice(i, i + 120) }, finish_reason: null }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: totalUsage })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/json",
      "x-router-execution": "swarm",
      "x-router-workload": "swarm",
    });
    res.end(JSON.stringify({
      id: "swarmcmpl-" + randomUUID(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "swarm",
      choices: [{ index: 0, message: { role: "assistant", content: merged.text }, finish_reason: "stop" }],
      usage: totalUsage,
    }));
  }

  return { handle, decompose, workerPool };
}
