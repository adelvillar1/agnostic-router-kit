#!/usr/bin/env node
/**
 * agnostic-router — a local OpenAI-compatible proxy that routes each task to
 * the right upstream model. Any OpenAI-compatible client (a coding harness,
 * an editor extension, a script) points its base URL at http://127.0.0.1:<port>/v1
 * and gets one extra model id, "auto", that routes by workload.
 *
 * Routing (see README.md):
 *   1. Capability rules, evaluated per request — any image/video/audio part
 *      or a very large payload goes to the omnimodal 1M-context flagship.
 *   2. Everything else: `auto` runs one judgment per task (keyed on system
 *      prompt + latest user instruction, cached for ttlHours) that picks a
 *      workload — quick / standard_code / hard / prose / deep_context — each
 *      mapped to a model. The judge is TypeSafe Jev, sys1's decide provider,
 *      or cascade (sys1 first, TypeSafe escalates). Named model ids (quick,
 *      code, hard, prose, long-context, vision) pin their workload with no
 *      judgment. Low confidence, missing key, or any judge error degrades to
 *      defaultWorkload — a judge outage never fails a request.
 *
 * Upstreams (baseUrl + key) come from the rendered config: every roster
 * provider arrives as an extraUpstream whose key is an env-var name read
 * from the router's own .env. No harness's config file is ever read.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { TypeSafeClient, choice, noul } from "@typesafe-ai/sdk";
import { createUsage, sseUsageTap } from "./usage.mjs";
import { offpeakWeight, computeQuotaState, pickCandidate } from "./quota.mjs";
import { suggestDelegation } from "./suggest.mjs";
import { judgeViaFastino } from "./fastino.mjs";
import { createSwarm } from "./swarm.mjs";
import { normalizeEvent, isTerminal } from "workflow-plane/events.mjs";
import { buildGraph } from "workflow-plane/graph.mjs";
import { runWorkflow } from "workflow-plane/engine.mjs";
import { resolveGrants } from "workflow-plane/tools.mjs";
import { FACT_KINDS } from "workflow-plane/harness.mjs";
import { slug, freeRunDir, KIT_HOME } from "workflow-plane/runstate.mjs";
import { parseHeader, validateArgs } from "workflow-plane/meta.mjs";
import {
  memoryStorePath, loadGraph, saveGraph, searchGraph, memoryStats,
  createEntities, createRelations, addObservations, addFact, detectConflicts, extractMentions,
} from "workflow-plane/memory.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const expand = (p) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);
const CONFIG_PATH = path.join(__dirname, "config.json");
const LOG_DIR = path.join(__dirname, "logs");

// config.json is generated from the roster — including by the dashboard's own
// save-and-apply endpoint while this process is serving — so it is re-read
// whenever its mtime moves. A failed or half-written read keeps the previous
// config: a proxy never routes on a config it could not fully parse.
let config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
let configMtime = 0;
let R = config.routing;
function refreshConfig() {
  try {
    const mtime = fs.statSync(CONFIG_PATH).mtimeMs;
    if (mtime === configMtime) return;
    const next = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    if (!next?.routing?.workloads) return; // defensive: never adopt a broken config
    config = next;
    R = config.routing;
    configMtime = mtime;
    log({ event: "config-reload", port: config.port });
  } catch {}
}

const usage = createUsage({
  file: path.join(LOG_DIR, "usage.json"),
  weightOf: (pid, ts) => offpeakWeight(cachedRoster()?.providers?.[pid]?.quota, ts),
});
const DASHBOARD_FILE = path.join(__dirname, "dashboard.html");
const SETUP_FILE = path.join(__dirname, "setup.html");
const CHAT_FILE = path.join(__dirname, "chat.html");

// The kit checkout the roster and the apply pipeline live in. The dashboard's
// save-and-apply endpoint shells out to the kit CLI there — the CLI is the
// reference implementation of roster → config/provider/workflows generation,
// and the router must never grow a second, drifting copy of it.
const KIT_ROOT = config.kitRoot ? expand(config.kitRoot) : path.resolve(__dirname, "..", "..");
const ROSTER_PATH = config.rosterPath ? expand(config.rosterPath) : path.join(KIT_ROOT, "roster.json");

// mtime-cached roster for the hot path (off-peak weights per call, quota
// steering per decision) — the API endpoints read it fresh instead.
let rosterCache = null;
let rosterCacheMtime = 0;
function cachedRoster() {
  try {
    const mtime = fs.statSync(ROSTER_PATH).mtimeMs;
    if (!rosterCache || mtime !== rosterCacheMtime) {
      rosterCache = JSON.parse(fs.readFileSync(ROSTER_PATH, "utf8"));
      rosterCacheMtime = mtime;
    }
    return rosterCache;
  } catch {
    return rosterCache;
  }
}

// Quota derivation with a short cache: it walks hourly buckets, and steering
// consults it on every routing decision.
let quotaCache = { at: 0, mtime: -1, state: {} };
function quotaState() {
  const roster = cachedRoster();
  if (!quotaCache.state || Date.now() - quotaCache.at > 30_000 || quotaCache.mtime !== rosterCacheMtime) {
    quotaCache = { at: Date.now(), mtime: rosterCacheMtime, state: computeQuotaState(roster, usage, (pid, ts) => offpeakWeight(roster?.providers?.[pid]?.quota, ts)) };
  }
  return quotaCache.state;
}

/**
 * Quota-aware steering: walk the tier's own candidate chain in roster
 * preference order, skipping providers whose quota headroom is under
 * pressure. Capability routing (omni/wide) and mixture executions are
 * exempt — steering only reorders quality-equivalent candidates the roster
 * already trusts for this tier.
 */
function steerSingle(target) {
  if (!target || target.kind === "mixture" || target.kind === "swarm" || !Array.isArray(target.candidates) || target.candidates.length < 2) return target;
  const qs = quotaState();
  // A provider answering quota/auth failures goes on a runtime cooldown; a
  // cooled-down provider steers as zero headroom so the tier's healthy
  // candidates are preferred while it is benched.
  const view = { ...qs };
  for (const [pid, until] of cooldowns) {
    if (Date.now() < until) view[pid] = { ...(view[pid] ?? {}), headroom: 0 };
  }
  const pick = pickCandidate(target.candidates, view, R.quotaMinHeadroom ?? 0.4);
  if (pick.index <= 0) return target;
  const from = target.providerId;
  log({
    event: "quota-steer",
    workload: target.workload,
    from,
    fromHeadroom: qs[from]?.headroom ?? null,
    to: pick.candidate.providerId,
    headroom: pick.headroom,
    exhausted: pick.exhausted,
  });
  return { ...target, ...pick.candidate, reason: "quota:steered" };
}
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, "router.log");
function log(obj) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n");
  } catch {}
}

// ── upstream registry ─────────────────────────────────────────────────────────
// Every roster provider is rendered into config.extraUpstreams with its key as
// an env-var name; the values are read live from the router's own .env (the
// same file the judge keys live in), cached until the file's mtime moves. A
// provider whose key did not resolve is simply not in the map — the candidate
// chain skips it and the tier falls through to the next target.
function upstream(providerId) {
  const extra = config.extraUpstreams?.[providerId];
  if (!extra) return null;
  const apiKey = envFile()[extra.apiKeyEnv];
  return apiKey ? { baseUrl: extra.baseUrl.replace(/\/+$/, ""), apiKey } : null;
}

// ── local .env reader (cached until the file changes) ────────────────────────
let envCache = null;
let envMtime = 0;
function envFile() {
  try {
    const p = expand(config.typesafeEnvFile);
    const mtime = fs.statSync(p).mtimeMs;
    if (!envCache || mtime !== envMtime) {
      envCache = {};
      for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (m) envCache[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
      envMtime = mtime;
    }
    return envCache;
  } catch {
    return envCache ?? {};
  }
}

// ── TypeSafe judge ───────────────────────────────────────────────────────────
let tsClient = null;
function typesafeKey() {
  return envFile().TYPESAFE_API_KEY || null;
}

/**
 * Merge NAME=value pairs into the runtime .env — the write-only half of
 * envFile(). Line-wise on purpose: comment lines and ordering survive, only
 * the named keys are replaced (appended at the end when new). Atomic rename
 * and mode 600, the same contract `kit env set` gives the file. The value
 * lives here and nowhere else — callers respond with configured-booleans,
 * never with what was written.
 */
function writeEnvPairs(pairs) {
  const p = expand(config.typesafeEnvFile);
  let lines = [];
  try {
    lines = fs.readFileSync(p, "utf8").split("\n");
  } catch {}
  const pending = new Map(Object.entries(pairs));
  const out = lines.map((line) => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && pending.has(m[1])) {
      const v = pending.get(m[1]);
      pending.delete(m[1]);
      return `${m[1]}=${v}`;
    }
    return line;
  });
  for (const [k, v] of pending) out.push(`${k}=${v}`);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp-keys`;
    fs.writeFileSync(tmp, out.join("\n"));
    fs.renameSync(tmp, p);
    fs.chmodSync(p, 0o600);
    envCache = null;
    envMtime = 0;
    const fresh = envFile();
    const configured = {};
    for (const k of Object.keys(pairs)) configured[k] = Boolean(fresh[k]);
    return { ok: true, configured };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

async function judgeWorkload(signals) {
  const key = typesafeKey();
  if (!key) return { workload: null, conf: null, reason: "judge:no-key" };
  try {
    tsClient ??= new TypeSafeClient({
      apiKey: key,
      timeout: 4000,
      retry: { maxRetries: 0 },
      logLevel: "warn",
    });
    const state = {
      latest_instruction: signals.lastUser,
      message_count: signals.messages.length,
      approx_input_tokens: Math.round(signals.chars / 4),
      images_attached: signals.images,
      tool_definitions: signals.toolDefs,
    };
    const questions = {
      workload: choice(
        "A coding-agent request is described in state; latest_instruction is the user's current request. Which workload best describes what completing this request well requires?",
        {
          quick: "Small self-contained work: quick answers, tiny edits, formatting, or simple extraction from short text",
          standard_code: "Routine software work: writing or modifying features, normal debugging, running tools",
          hard: "Hard engineering: architecture and design, intricate multi-step reasoning, large refactors, subtle bugs",
          prose: "Writing and synthesis: documentation, prose, summaries, explanations, reports",
          deep_context: "Broad analysis of large material: connecting many files or working through very long documents",
        }
      ),
      execution: choice(
        "State describes one coding-agent request (see latest_instruction). Which execution style best fits completing this request well?",
        {
          single: "One focused model call or one worker suffices — the request is one coherent piece of work",
          mixture: "One hard question where several independent answers compared by a judge would beat one answer — but it does not decompose into separate parts",
          swarm: "The request decomposes into multiple substantial independent parts and/or quality depends on critique rounds — parallel multi-agent workers with review would beat any single answer",
        }
      ),
      workflow: (() => {
        const options = {};
        for (const wf of R.workflows ?? []) options[wf.name] = wf.shape;
        options.none = "One focused call or worker is enough, or no listed workflow fits";
        return choice(
          "State describes one request (see latest_instruction). Some requests name stages in order (first find the cause, then review the fix). Which saved workflow should run FIRST on this request? Choose \"none\" when one focused call or worker is enough or nothing fits.",
          options
        );
      })(),
      followUp: (() => {
        const options = {};
        for (const wf of R.workflows ?? []) options[wf.name] = wf.shape;
        options.none = "The request is complete after one workflow, or needs no workflow at all";
        return choice(
          "State describes one request (see latest_instruction). Some requests complete only after TWO workflows run in order (first one runs, then the second). Which SECOND workflow must run after the first one to complete this request? Choose \"none\" when one workflow completes the request.",
          options
        );
      })(),
    };
    const result = await tsClient.systemOne(
      { state, questions, model: config.typesafeModel ?? "jev-1.13.0" },
      { timeout: 4000 }
    );
    usage.recordJudge("fresh");
    usage.recordJudgeBackend("typesafe");
    const answer = result?.answers?.workload;
    const workload = answer?.choice;
    const conf = (workload && answer?.probabilities?.[workload]) ?? 0;
    const execAns = result?.answers?.execution;
    const execution = ["single", "mixture", "swarm"].includes(execAns?.choice) ? execAns.choice : null;
    const execConf = (execution && execAns?.probabilities?.[execution]) ?? 0;
    const wfAns = result?.answers?.workflow;
    const wfPick = wfAns?.choice;
    const wfConf = (wfPick && wfAns?.probabilities?.[wfPick]) ?? 0;
    const workflow =
      wfPick && wfPick !== "none" && (R.workflows ?? []).some((w) => w.name === wfPick) && wfConf >= (R.workflowMinConfidence ?? 0.4)
        ? wfPick
        : null;
    const fuAns = result?.answers?.followUp;
    const fuPick = fuAns?.choice;
    const fuConf = (fuPick && fuAns?.probabilities?.[fuPick]) ?? 0;
    const followUp =
      fuPick && fuPick !== "none" && fuPick !== wfPick && (R.workflows ?? []).some((w) => w.name === fuPick) && fuConf >= (R.workflowMinConfidence ?? 0.4)
        ? fuPick
        : null;
    // Each question is gated over its own option space: a 5-way workload
    // pick and a 12-way workflow pick have different chance baselines, and a
    // weak pick in one must not wipe a strong pick in the other.
    const workloadOk = workload && workload in R.workloads && conf >= R.minConfidence;
    return {
      workload: workloadOk ? workload : null,
      execution: execConf >= R.minConfidence ? execution : null,
      workflow,
      followUp,
      conf,
      execConf,
      wfConf,
      reason: workloadOk || workflow ? "judge" : "judge:low-confidence",
    };
  } catch (err) {
    usage.recordJudge("error");
    return { workload: null, execution: null, workflow: null, followUp: null, conf: null, reason: "judge:error:" + String(err?.message ?? err).slice(0, 80) };
  }
}

// ── judge backends ───────────────────────────────────────────────────────────
// judge.mode picks who answers the four routing questions:
//   typesafe (default) — TypeSafe Jev, unchanged behavior
//   fastino            — Fastino GLiNER2.5 encoder, always
//   cascade            — Fastino first; TypeSafe escalates when Fastino is
//                        cold, erroring, or below the confidence gates
// Both see the same compact state (latest instruction + counters). The
// mixture's best-answer judge always stays on TypeSafe.
async function runJudge(signals) {
  const mode = config.judge?.mode ?? "typesafe";
  if (mode === "typesafe") return judgeWorkload(signals);
  const fast = await judgeViaFastino({ signals, cfg: config, envMap: envFile(), R });
  const usable = fast.reason === "judge:fastino" && (fast.workload || fast.workflow);
  if (mode === "fastino") {
    usage.recordJudgeBackend(usable ? "fastino" : "failed");
    return fast;
  }
  if (usable) {
    usage.recordJudgeBackend("fastino");
    return { ...fast, reason: "judge:fastino" };
  }
  usage.recordJudgeBackend(fast.cold ? "escalated:cold" : "escalated");
  const judged = await judgeWorkload(signals);
  usage.recordCascadeEscalation({ fast, judged, defaultWorkload: R.defaultWorkload ?? null });
  return judged;
}

// ── routing decision ─────────────────────────────────────────────────────────
const workloadCache = new Map(); // sessionKey -> { workload, at, conf }
const ttlMs = () => (config.ttlHours ?? 6) * 3600_000;

function analyze(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let chars = 0;
  let images = 0;
  let otherParts = 0;
  let toolDefs = Array.isArray(body.tools) ? body.tools.length : 0;
  let lastUser = "";
  for (const m of messages) {
    if (typeof m.content === "string") {
      if (m.role === "user") lastUser = m.content;
      chars += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part?.type === "text") {
          if (m.role === "user") lastUser = part.text ?? "";
          chars += (part.text ?? "").length;
        } else if (part?.type === "image_url") {
          images++;
        } else if (part?.type) {
          otherParts++;
        }
      }
    }
  }
  const sys = messages.find((m) => m.role === "system");
  const sysHead = typeof sys?.content === "string" ? sys.content : JSON.stringify(sys?.content ?? "");
  const sessionKey = crypto
    .createHash("sha256")
    .update(sysHead.slice(0, 1500))
    .update(" ")
    .update(lastUser.slice(0, 300))
    .digest("hex")
    .slice(0, 12);
  return {
    messages,
    chars,
    images,
    otherParts,
    toolDefs,
    hasToolMessages: messages.some((m) => m.role === "tool" || m.role === "function"),
    lastUser,
    sessionKey,
    stream: body.stream === true,
    requestedModel: typeof body.model === "string" ? body.model : "auto",
  };
}

function resolveProfile(profile) {
  if (profile?.use === "omniModel") return R.omniModel;
  if (profile?.use === "wideModel") return R.wideModel;
  return R.workloads?.[profile?.workload] ?? null;
}

// ── the swarm ─────────────────────────────────────────────────────────────────
// A `swarm` verdict used to fall back to a mixture run. It now executes the
// swarm for real: decompose → parallel build → per-part gate → integrate →
// cold read → deliverable gate, every call metered under `execution: "swarm"`.
// The accept/revise decisions are the dev-decisions CLI's, not this process's —
// see router/swarm.mjs for the degradation ladder.
const swarm = createSwarm({
  getConfig: () => config,
  upstream,
  rewriteBody,
  thinkingStyleFor,
  usage,
  log,
});

// MoA needs a pure completion: parallel proposals can't be merged when the
// turn is choosing tool calls mid-loop. Tool-carrying requests fall back to
// the single strong model. A swarm verdict degrades the same way — its parts
// are plain completions too.
function mixtureTarget(signals, baseReason, execution = "mixture", workload = "mixture") {
  if (signals.toolDefs > 0 || signals.hasToolMessages) {
    return {
      ...R.workloads.hard,
      workload: "hard",
      execution: "single",
      conf: null,
      // Name the execution that was actually skipped: a swarm verdict that
      // fell back for tools must not be logged as a skipped mixture.
      reason: `${baseReason}+${execution}-skipped-tools`,
    };
  }
  if (execution === "swarm") return { kind: "swarm", workload, execution, conf: null, reason: baseReason };
  return { kind: "mixture", workload, execution, conf: null, reason: baseReason };
}

async function decide(signals) {
  // Capability rules always win — a text-only target can't take an image, and
  // only the 1M-context models can swallow a wide payload. They also beat a
  // pinned profile for the same reason (the log shows the override).
  if (signals.images + signals.otherParts > 0) {
    return { ...R.omniModel, workload: "omni", conf: null, reason: "capability:multimodal" };
  }
  if (signals.chars > R.wideChars) {
    return { ...R.wideModel, workload: "wide", conf: null, reason: "capability:wide-context" };
  }
  // Explicit picker profile pins the workload — no judgment.
  const profile = R.profiles?.[signals.requestedModel];
  if (profile) {
    if (profile.use === "mixture") {
      return mixtureTarget(signals, "profile:mixture", "mixture");
    }
    const target = resolveProfile(profile);
    if (target) {
      return { ...target, workload: profile.workload ?? profile.use, execution: "single", conf: null, reason: `profile:${signals.requestedModel}` };
    }
  }
  // auto: one judgment per task (cached on system prompt + latest user message,
  // so an agentic tool loop keeps its model until the next user instruction).
  // The judge picks BOTH the workload and the execution style (single /
  // mixture / swarm) — topology is a routing decision.
  const hit = workloadCache.get(signals.sessionKey);
  if (hit && Date.now() - hit.at < ttlMs()) {
    usage.recordJudge("cached");
    const cachedWorkflow = hit.workflow ?? null;
    const cachedFollowUp = hit.followUp ?? null;
    if (hit.execution === "mixture" || hit.execution === "swarm") {
      return { ...mixtureTarget(signals, "cache", hit.execution, hit.workload), workflow: cachedWorkflow, followUp: cachedFollowUp, conf: hit.conf, wfConf: hit.wfConf ?? null };
    }
    return { ...R.workloads[hit.workload], workload: hit.workload, execution: "single", workflow: cachedWorkflow, followUp: cachedFollowUp, conf: hit.conf, wfConf: hit.wfConf ?? null, reason: "cache" };
  }
  const judged = await runJudge(signals);
  const workload = judged.workload ?? R.defaultWorkload;
  // A swarm runs inside this process — the harness gets the merged answer with
  // `x-router-execution: swarm` and must not additionally run a library
  // workflow for it. The judge answers every question in one call, so its
  // workflow pick is free; it is simply not a swarm's plan. Reporting it here
  // would advertise an assignment no one will run.
  const judgedWorkflow = judged.execution === "swarm" ? null : (judged.workflow ?? null);
  const judgedFollowUp = judgedWorkflow ? (judged.followUp ?? null) : null;
  workloadCache.set(signals.sessionKey, {
    workload,
    execution: judged.execution,
    workflow: judged.workflow,
    followUp: judged.followUp,
    at: Date.now(),
    conf: judged.conf,
    execConf: judged.execConf,
    wfConf: judged.wfConf,
  });
  if (workloadCache.size > 400) workloadCache.delete(workloadCache.keys().next().value);
  if (judged.execution === "mixture" || judged.execution === "swarm") {
    return { ...mixtureTarget(signals, judged.reason, judged.execution, workload), workflow: judgedWorkflow, followUp: judgedFollowUp, conf: judged.conf, wfConf: judged.wfConf ?? null };
  }
  return { ...R.workloads[workload], workload, execution: "single", workflow: judgedWorkflow, followUp: judgedFollowUp, conf: judged.conf, wfConf: judged.wfConf ?? null, reason: judged.reason };
}

// ── Mixture of Agents ────────────────────────────────────────────────────────
// Parallel proposers (different plan pools + model families), one TypeSafe
// judgment to pick the best answer AND decide whether merging adds value, and
// an aggregator only when the judge says integration is warranted.

async function chatNonStream(target, body, timeoutMs, onFail, think = { level: "auto", style: null }) {
  const up = upstream(target.providerId);
  if (!up) {
    onFail?.(502, null, "no-upstream");
    return null;
  }
  try {
    // No invented limits: the client's max_tokens passes through verbatim, or
    // is left unset so the upstream model uses its own output default (these
    // models run 1M input contexts and 128K+ outputs).
    const u = await fetch(`${up.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${up.apiKey}` },
      body: rewriteBody({ ...body, stream: false }, target.model, think),
      signal: AbortSignal.timeout(timeoutMs ?? R.mixture?.proposerTimeoutMs ?? 120000),
    });
    if (!u.ok) {
      const detail = await u.text().catch(() => "");
      onFail?.(u.status, null, "http-error");
      log({
        event: "mixture-proposer",
        provider: target.providerId,
        model: target.model,
        status: u.status,
        detail: detail.slice(0, 300),
      });
      return null;
    }
    const d = await u.json();
    const text = d.choices?.[0]?.message?.content;
    if (typeof text !== "string" || text.length === 0) {
      // 200 with no content is still a billed call — thinking models can burn
      // the whole token budget on reasoning and return empty content. Record
      // the spend; a proposal that says nothing is not a proposal.
      onFail?.(u.status, d.usage ?? null, "empty-content");
      log({
        event: "mixture-proposer",
        provider: target.providerId,
        model: target.model,
        status: u.status,
        detail: "empty content (usage " + JSON.stringify(d.usage ?? null) + ")",
      });
      return null;
    }
    return { text, usage: d.usage ?? null, model: target.model };
  } catch (err) {
    onFail?.(null, null, "fetch-error");
    log({
      event: "mixture-proposer",
      provider: target.providerId,
      model: target.model,
      error: String(err?.message ?? err).slice(0, 200),
    });
    return null;
  }
}

async function judgeProposals(labeled, signals) {
  const key = typesafeKey();
  if (!key || labeled.length < 2) {
    return { best: labeled[0]?.label ?? "1", conf: null, worthMerging: false, reason: "judge:skipped" };
  }
  try {
    tsClient ??= new TypeSafeClient({ apiKey: key, timeout: 6000, retry: { maxRetries: 0 }, logLevel: "warn" });
    const criteria = {};
    for (const l of labeled) criteria[l.label] = "candidate answer";
    const state = {
      request: signals.lastUser,
      answers: labeled.map((l) => ({ key: l.label, text: l.text })),
    };
    const questions = {
      best_answer: choice(
        "State contains a request plus several assistants' answers to it, keyed \"1\", \"2\", … matching the options below. Which answer is best overall — most correct, complete, and directly responsive to the request?",
        criteria
      ),
      worth_merging: noul(
        "State contains a request plus several assistants' answers to it. Do the answers contain distinct correct or valuable elements such that merging them would produce a better answer than the single best answer alone?",
        {
          true: "The answers are complementary — merging adds real value",
          false: "One answer is clearly best on its own — merging adds nothing",
        }
      ),
    };
    const result = await tsClient.systemOne(
      { state, questions, model: config.typesafeModel ?? "jev-1.13.0" },
      { timeout: 6000 }
    );
    usage.recordJudge("fresh");
    usage.recordJudgeBackend("typesafe");
    const bestAns = result?.answers?.best_answer;
    const mergeAns = result?.answers?.worth_merging;
    const best = labeled.some((l) => l.label === bestAns?.choice) ? bestAns.choice : labeled[0].label;
    const conf = bestAns?.probabilities?.[best] ?? null;
    const worthMerging = mergeAns?.choice === true;
    return { best, conf, worthMerging, reason: "judge" };
  } catch {
    usage.recordJudge("error");
    return { best: labeled[0].label, conf: null, worthMerging: false, reason: "judge:error" };
  }
}

async function aggregate(labeled, signals, body, think = { level: "auto", style: null }) {
  const agg = R.mixture?.aggregator;
  if (!agg) return null;
  const merged = await chatNonStream(agg, {
    model: agg.model,
    temperature: body.temperature,
    messages: [
      {
        role: "system",
        content:
          "You are an answer integrator. You receive a request and several answers to it. Produce ONE final answer that combines the strongest, most correct elements of the answers — resolving contradictions in favor of what is correct, dropping errors and filler. Return only the final answer in the style the request calls for.",
      },
      {
        role: "user",
        content:
          `REQUEST:\n${signals.lastUser}\n\n` +
          labeled.map((l) => `ANSWER ${l.label}:\n${l.text}`).join("\n\n"),
      },
    ],
    // A merge over full answers is the longest single generation in the proxy —
    // give it the swarm's worker patience, not the proposer timeout.
  }, Math.max(R.mixture?.proposerTimeoutMs ?? 120000, 600000), null, think);
  return merged;
}

async function handleMixture(res, body, signals, execution = "mixture", thinkLevel = "auto") {
  const t0 = Date.now();
  const mix = R.mixture ?? {};
  const think = (p) => ({ level: thinkLevel, style: thinkingStyleFor(p.providerId) });
  const proposers = mix.proposers ?? [];
  const results = await Promise.all(
    proposers.map((p) =>
      chatNonStream(p, body, mix.proposerTimeoutMs, (status, us, why) =>
        usage.record({
          providerId: p.providerId,
          model: p.model,
          workload: "mixture",
          execution,
          requested: signals.requestedModel,
          reason: `proposer-${why ?? "failed"}`,
          status: status ?? 502,
          ms: null,
          promptTokens: us?.prompt_tokens ?? null,
          completionTokens: us?.completion_tokens ?? null,
          stream: false,
        }), think(p))
    )
  );
  const labeled = results
    .map((g, i) => (g ? { label: String(i + 1), providerId: proposers[i]?.providerId ?? null, ...g } : null))
    .filter(Boolean);
  if (labeled.length === 0) {
    usage.record({ workload: "mixture", execution, requested: signals.requestedModel, status: 502, ms: Date.now() - t0, reason: "mixture:all-proposers-failed", stream: signals.stream });
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "mixture: all proposers failed" } }));
    log({ event: "mixture", error: "all-proposers-failed", sessionKey: signals.sessionKey, requested: signals.requestedModel });
    return;
  }
  const verdict = await judgeProposals(labeled, signals);
  const winner = labeled.find((l) => l.label === verdict.best) ?? labeled[0];
  let finalText = winner.text;
  let finalModel = winner.model;
  let finalProviderId = winner.providerId;
  let merged = false;
  if (verdict.worthMerging && labeled.length > 1) {
    const agg = await aggregate(labeled, signals, body, think(R.mixture?.aggregator ?? {}));
    if (agg) {
      finalText = agg.text;
      finalModel = agg.model;
      finalProviderId = R.mixture?.aggregator?.providerId ?? finalProviderId;
      merged = true;
      usage.record({
        providerId: R.mixture?.aggregator?.providerId ?? null,
        model: agg.model,
        workload: "mixture",
        execution,
        requested: signals.requestedModel,
        reason: "aggregator",
        status: 200,
        ms: null,
        promptTokens: agg.usage?.prompt_tokens ?? null,
        completionTokens: agg.usage?.completion_tokens ?? null,
        stream: false,
      });
    }
  }
  log({
    event: "mixture",
    sessionKey: signals.sessionKey,
    requested: signals.requestedModel,
    execution,
    proposers: labeled.map((l) => `${l.label}:${l.model}`),
    best: verdict.best,
    conf: verdict.conf,
    worthMerging: verdict.worthMerging,
    merged,
    finalModel,
    judgeReason: verdict.reason,
    status: 200,
    ms: Date.now() - t0,
  });

  // Every model that did work gets credit for the tokens it spent — the
  // losing proposers too, because a prepaid plan pays for them all the same.
  for (const l of labeled) {
    usage.record({
      providerId: l.providerId,
      model: l.model,
      workload: "mixture",
      execution,
      requested: signals.requestedModel,
      reason: `proposer-${l.label}${verdict.best === l.label ? "+best" : ""}`,
      status: 200,
      ms: null,
      promptTokens: l.usage?.prompt_tokens ?? null,
      completionTokens: l.usage?.completion_tokens ?? null,
      stream: false,
    });
  }
  const totalUsage = {
    prompt_tokens: labeled.reduce((s, l) => s + (l.usage?.prompt_tokens ?? 0), 0),
    completion_tokens: labeled.reduce((s, l) => s + (l.usage?.completion_tokens ?? 0), 0),
    total_tokens: 0,
  };
  totalUsage.total_tokens = totalUsage.prompt_tokens + totalUsage.completion_tokens;

  if (signals.stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "x-router-execution": execution,
      "x-router-workload": "mixture",
    });
    const id = "mixcmpl-" + crypto.randomUUID();
    const created = Math.floor(Date.now() / 1000);
    const base = { id, object: "chat.completion.chunk", created, model: "mixture" };
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}\n\n`);
    for (let i = 0; i < finalText.length; i += 120) {
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: finalText.slice(i, i + 120) }, finish_reason: null }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: totalUsage })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  } else {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "x-router-execution": execution,
      "x-router-workload": "mixture",
    });
    res.end(JSON.stringify({
      id: "mixcmpl-" + crypto.randomUUID(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "mixture",
      choices: [{ index: 0, message: { role: "assistant", content: finalText }, finish_reason: "stop" }],
      usage: totalUsage,
    }));
  }
}

// ── forwarding ───────────────────────────────────────────────────────────────
// ── thinking policy ──────────────────────────────────────────────────────────
// Three levels, selected from the picker via profiles: "auto" (current
// behavior — strip reasoning params, the judge already picks per task),
// "deep" (force thinking on, for the hard problems that deserve it), and
// "off" (force thinking off, for bulk delegation where the reasoning budget
// is pure waste). Providers speak different dialects, so each maps to a
// param style: {thinking:{type}} (zai/mimo), enable_thinking (qwen-style
// token-plan/stepfun), or none (model has no thinking control — strip only).
const THINKING_STYLES = {
  "zai-coding-plan": "thinking",
  "xiaomi-mimo": "thinking",
  "token-plan": "enable_thinking",
  "stepfun": "enable_thinking",
};

function thinkingStyleFor(providerId) {
  return R.thinkingStyles?.[providerId] ?? THINKING_STYLES[providerId] ?? null;
}

function thinkingPolicyFor(requestedModel) {
  const t = R.profiles?.[requestedModel]?.thinking;
  return t === "off" || t === "deep" ? t : "auto";
}

function rewriteBody(body, model, thinking = { level: "auto", style: null }) {
  const next = { ...body, model };
  // Baseline: drop reasoning params some clients attach so conservative
  // upstreams don't 400 on unknown fields.
  delete next.reasoning_effort;
  delete next.thinking;
  delete next.enable_thinking;
  if (thinking.level === "auto" || !thinking.style || thinking.style === "none") {
    return JSON.stringify(next);
  }
  if (thinking.style === "thinking") {
    next.thinking = { type: thinking.level === "deep" ? "enabled" : "disabled" };
  } else if (thinking.style === "enable_thinking") {
    next.enable_thinking = thinking.level === "deep";
  } else if (thinking.style === "reasoning_effort") {
    next.reasoning_effort = thinking.level === "deep" ? "high" : "low";
  }
  return JSON.stringify(next);
}

// One upstream attempt. Sends the response on success — and on client-caused
// failures (400/404 …), which pass through as-is because every other candidate
// would fail the same way. Returns sent=false for failover-able failures
// (quota/auth/server) so the caller can walk the tier's chain.
async function attemptUpstream(res, body, signals, target, up, t0, attemptIndex, thinkLevel) {
  const failover = attemptIndex > 0;
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });
  try {
    const bodyText = rewriteBody(body, target.model, { level: thinkLevel ?? "auto", style: thinkingStyleFor(target.providerId) });
    const u = await fetch(`${up.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${up.apiKey}` },
      body: bodyText,
      signal: ac.signal,
    });
    log({
      event: "route",
      sessionKey: signals.sessionKey,
      requested: signals.requestedModel,
      workload: target.workload,
      provider: target.providerId,
      model: target.model,
      reason: target.reason,
      conf: target.conf,
      chars: signals.chars,
      images: signals.images,
      tools: signals.toolDefs,
      stream: signals.stream,
      attempt: attemptIndex,
      thinking: thinkLevel ?? "auto",
      status: u.status,
      ms: Date.now() - t0,
    });
    if (FAILOVER_STATUS.has(u.status)) {
      await u.text().catch(() => ""); // drain the error body
      markCooldown(target.providerId, cooldownFor(u.status, u.headers.get("retry-after")), u.status);
      usage.record({
        providerId: target.providerId,
        model: target.model,
        workload: target.workload,
        execution: target.execution ?? "single",
        requested: signals.requestedModel,
        reason: `${failover ? `failover:${attemptIndex}` : target.reason ?? "route"}+upstream-${u.status}`,
        status: u.status,
        ms: Date.now() - t0,
        stream: signals.stream,
      });
      return { sent: false, status: u.status };
    }
    const routerHeaders = {
      "x-router-execution": target.execution ?? "single",
      "x-router-workload": target.workload ?? "unknown",
      "x-router-workflow": target.workflow ?? "none",
      ...(failover ? { "x-router-failover": String(attemptIndex) } : {}),
      ...(thinkLevel && thinkLevel !== "auto" ? { "x-router-thinking": thinkLevel } : {}),
    };
    const reason = failover ? `failover:${attemptIndex}` : target.reason;
    if (signals.stream) {
      res.writeHead(u.status, {
        "Content-Type": u.headers.get("content-type") ?? "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...routerHeaders,
      });
      const stream = Readable.fromWeb(u.body);
      // Client disconnects mid-stream abort the upstream fetch; the reader
      // then errors. Swallow it — the response is already (half) sent.
      stream.on("error", () => {
        try { res.end(); } catch {}
      });
      // Meter the stream without altering a byte: the tap scans complete SSE
      // data lines for the usage object upstreams put in their final chunk.
      // The call is recorded once when the response settles, with whatever
      // tokens the upstream reported — null when it reported none.
      const meter = { promptTokens: null, completionTokens: null };
      const tap = sseUsageTap((us) => {
        if (Number.isFinite(us.prompt_tokens)) meter.promptTokens = (meter.promptTokens ?? 0) + us.prompt_tokens;
        if (Number.isFinite(us.completion_tokens)) meter.completionTokens = (meter.completionTokens ?? 0) + us.completion_tokens;
      });
      let recorded = false;
      const settle = () => {
        if (recorded) return;
        recorded = true;
        usage.record({
          providerId: target.providerId,
          model: target.model,
          workload: target.workload,
          execution: target.execution ?? "single",
          requested: signals.requestedModel,
          reason,
          thinking: thinkLevel ?? "auto",
          status: u.status,
          ms: Date.now() - t0,
          promptTokens: meter.promptTokens,
          completionTokens: meter.completionTokens,
          stream: true,
        });
      };
      res.on("finish", settle);
      res.on("close", settle);
      stream.pipe(tap).pipe(res);
      return { sent: true };
    }
    const text = await u.text();
    let pt = null;
    let ct = null;
    try {
      const us = JSON.parse(text)?.usage;
      if (us && typeof us === "object") {
        pt = Number.isFinite(us.prompt_tokens) ? us.prompt_tokens : null;
        ct = Number.isFinite(us.completion_tokens) ? us.completion_tokens : null;
      }
    } catch {}
    usage.record({
      providerId: target.providerId,
      model: target.model,
      workload: target.workload,
      execution: target.execution ?? "single",
      requested: signals.requestedModel,
      reason,
      status: u.status,
      ms: Date.now() - t0,
      promptTokens: pt,
      completionTokens: ct,
      stream: false,
    });
    res.writeHead(u.status, {
      "Content-Type": u.headers.get("content-type") ?? "application/json",
      ...routerHeaders,
    });
    res.end(text);
    return { sent: true };
  } catch (err) {
    if (ac.signal.aborted) return { sent: true }; // client went away; nothing to answer
    markCooldown(target.providerId, FAIL_COOLDOWNS_MS[502], 502); // network-level: bench like a 5xx
    usage.record({
      providerId: target.providerId,
      model: target.model,
      workload: target.workload,
      execution: target.execution ?? "single",
      requested: signals.requestedModel,
      reason: `${failover ? `failover:${attemptIndex}` : target.reason ?? "route"}+upstream-error`,
      status: 502,
      ms: Date.now() - t0,
      stream: signals.stream,
    });
    log({ event: "route", error: "upstream-failed", provider: target.providerId, model: target.model, attempt: attemptIndex, ms: Date.now() - t0, detail: String(err?.message ?? err).slice(0, 160) });
    return { sent: false, status: null };
  }
}

async function forward(res, body, signals) {
  const t0 = Date.now();
  let target = await decide(signals);
  target = steerSingle(target);
  const thinkLevel = thinkingPolicyFor(signals.requestedModel);
  if (target.kind === "mixture") {
    await handleMixture(res, body, signals, target.execution ?? "mixture", thinkLevel);
    return;
  }
  if (target.kind === "swarm") {
    // The swarm either writes the response itself or degrades to a single tier
    // call and returns that target, which falls through to the walk below.
    const degraded = await swarm.handle(res, body, signals, target, thinkLevel);
    if (degraded) target = degraded;
    else return;
  }

  // The tier's candidate chain is the roster's capability-proximity order:
  // steered target first, then the rest. Quota/auth/server failures walk it;
  // client-caused failures surface as-is. A provider that just failed is
  // benched, so later requests skip it proactively.
  const seen = new Set();
  const attempts = [{ providerId: target.providerId, model: target.model }, ...(target.candidates ?? [])].filter((c) => {
    const key = `${c.providerId}/${c.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let lastStatus = null;
  for (let i = 0; i < attempts.length; i++) {
    if (res.writableEnded || res.destroyed) return; // client gone mid-failover
    const cand = attempts[i];
    if (i > 0 && isCoolingDown(cand.providerId)) continue; // benched upstream
    const up = upstream(cand.providerId);
    if (!up) {
      usage.record({
        providerId: cand.providerId, model: cand.model, workload: target.workload,
        execution: target.execution ?? "single", requested: signals.requestedModel,
        reason: `failover:${i}:unknown-upstream`, status: 502, ms: Date.now() - t0, stream: signals.stream,
      });
      continue;
    }
    const out = await attemptUpstream(res, body, signals, { ...target, ...cand }, up, t0, i, thinkLevel);
    if (out.sent) return;
    lastStatus = out.status;
  }
  log({ event: "route", error: "all-candidates-failed", workload: target.workload, attempts: attempts.length, lastStatus });
  if (!res.writableEnded && !res.destroyed) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `router: all ${attempts.length} candidate(s) for workload "${target.workload}" failed (last status ${lastStatus ?? "network error"})` } }));
  }
}

// ── dashboard: roster access + save-and-apply ────────────────────────────────
function readRoster() {
  try {
    return { ok: true, roster: JSON.parse(fs.readFileSync(ROSTER_PATH, "utf8")) };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// The kit CLI is the reference implementation of roster → config/provider
// generation. Running it keeps the dashboard's writes on exactly the path
// `kit apply` uses — validation, payg guard, backup-before-write and all —
// instead of a second, drifting copy inside the router.
function runKitApply(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(KIT_ROOT, "bin", "agnostic-router-kit.mjs"), ...args], {
      cwd: KIT_ROOT,
      env: { ...process.env, AGNOSTIC_ROUTER_KIT_ROSTER: ROSTER_PATH },
    });
    let out = "";
    const timer = setTimeout(() => {
      out += "\n(apply killed after 180s)";
      child.kill("SIGKILL");
    }, 180_000);
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output: out.trim() });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, output: (out + "\n" + String(e?.message ?? e)).trim() });
    });
  });
}

async function applyRoster(candidate) {
  // Strip render-derived artifacts the dashboard merges into provider rows:
  // hasKey is runtime state (the runtime .env decides), id duplicates the
  // object key. The tracked roster is the curated source — it never carries
  // the dashboard's derived columns.
  if (candidate && typeof candidate === "object" && candidate.providers) {
    for (const key of Object.keys(candidate.providers)) {
      const p = candidate.providers[key];
      if (p && typeof p === "object") { delete p.hasKey; delete p.id; }
    }
  }
  const current = readRoster();
  const backup = current.ok ? JSON.stringify(current.roster, null, 2) + "\n" : null;
  const tmp = `${ROSTER_PATH}.tmp-dashboard`;
  fs.writeFileSync(tmp, JSON.stringify(candidate, null, 2) + "\n");
  fs.renameSync(tmp, ROSTER_PATH);
  const first = await runKitApply(["apply", "--only", "router"]);
  if (first.code === 0) {
    return { ok: true, output: first.output, restartRecommended: /copied /.test(first.output) };
  }
  let output = first.output;
  if (backup !== null) {
    fs.writeFileSync(tmp, backup);
    fs.renameSync(tmp, ROSTER_PATH);
    const rollback = await runKitApply(["apply", "--only", "router,provider"]);
    output += `\n— apply failed; roster restored and resynced (exit ${rollback.code}) —\n${rollback.output}`;
  } else {
    output += "\n(rollback skipped: no previous roster on disk)";
  }
  return { ok: false, output, restartRecommended: false };
}

// ── runtime failover: quota/auth/server failures walk the tier's chain ──────
// Quota steering reacts to *declared* headroom before a call; this is the
// other half — when a provider actually answers "quota exhausted" (429/402),
// refuses auth, or 5xx's, the router walks the tier's remaining candidates in
// roster order (the capability-proximity order the roster already encodes)
// and puts the failed provider on a cooldown so later requests skip it
// proactively instead of paying the failed attempt again.
const FAIL_COOLDOWNS_MS = {
  401: 600_000, 402: 900_000, 403: 1_800_000,
  429: 300_000, 408: 60_000, 500: 60_000, 502: 60_000, 503: 60_000, 504: 60_000,
};
const FAILOVER_STATUS = new Set(Object.keys(FAIL_COOLDOWNS_MS).map(Number));
const cooldowns = new Map(); // providerId -> until (epoch ms)
const isCoolingDown = (pid) => Date.now() < (cooldowns.get(pid) ?? 0);

function parseRetryAfter(v) {
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return secs * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function cooldownFor(status, retryAfterHeader) {
  const declared = R.failover?.cooldowns?.[status] ?? FAIL_COOLDOWNS_MS[status] ?? 60_000;
  // Honor Retry-After when the provider sent one (429/503 are the honest
  // cases); cap it so a nonsense header can't bench a provider for a day.
  const ra = status === 429 || status === 503 ? parseRetryAfter(retryAfterHeader) : null;
  return ra != null ? Math.min(Math.max(ra, 1000), 3600_000) : declared;
}

function markCooldown(pid, ms, status) {
  const until = Date.now() + ms;
  if (until > (cooldowns.get(pid) ?? 0)) {
    cooldowns.set(pid, until);
    log({ event: "cooldown", provider: pid, status: status ?? null, ms });
  }
}

// ── server ───────────────────────────────────────────────────────────────────
async function handleRoute(res, raw) {
  let body = {};
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    body = {};
  }
  const msgs = Array.isArray(body.messages) && body.messages.length > 0
    ? body.messages
    : [{ role: "user", content: String(body.task ?? "") }];
  const signals = analyze({ messages: msgs, model: body.model });
  let target = await decide(signals);
  target = steerSingle(target);
  const defs = config.routing.workflows ?? [];
  const plan = [target.workflow, target.followUp]
    .map((n) => defs.find((w) => w.name === n))
    .filter(Boolean)
    .map((w, i) => ({
      name: w.name,
      args: {
        [w.taskArg]:
          i === 0
            ? signals.lastUser
            : `This is the SECOND stage of a two-stage request. Focus only on your stage's job; ` +
              `the \`${target.workflow}\` stage is done and its deliverable is your starting point. ` +
              `The original request was: ${signals.lastUser}`,
        ...(w.defaults ?? {}),
      },
    }));
  // A fan-out verdict (mixture or swarm) has no single serving provider until it
  // picks one — reporting a target there would name a model that never serves.
  const fan = target.kind === "mixture" || target.kind === "swarm";
  const execution = target.execution ?? (fan ? target.kind : "single");
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    workload: target.workload,
    execution,
    target: fan ? null : { providerId: target.providerId, model: target.model },
    assignments: plan,
    assignment: plan[0] ?? null,
    conf: target.conf ?? null,
    wfConf: target.wfConf ?? null,
    reason: target.reason,
  }));
  log({
    event: "route-verdict",
    sessionKey: signals.sessionKey,
    workload: target.workload,
    execution,
    workflow: plan.map((x) => x.name).join(" -> ") || null,
    reason: target.reason,
  });
  usage.recordDelegation({
    workload: target.workload,
    execution,
    workflows: plan.map((x) => x.name),
  });
  plan.forEach((p, i) =>
    usage.recordWorkflowAssignment({
      name: p.name,
      stage: i === 0 ? "assigned" : "followUp",
      conf: i === 0 ? target.wfConf ?? null : null,
    })
  );
}


// ── workflow run watcher (strictly read-only) ────────────────────────────────
// Tails <kitHome>/workflow-runs/<run>/run.jsonl so the dashboard can watch
// runs live. The kit CLI is the only writer; this side only reads. Polling
// (1s tick) rather than fs.watch: tmpfs/rename semantics make watch events
// unreliable, and the 2s freshness budget only needs a 1s tick.
//
// KIT_HOME comes from the plane — the same resolution every writer uses — so
// the watcher tails the directory runs actually land in. It used to default
// to the kit checkout here while writers defaulted to ~/.agnostic-router-kit,
// and HTTP-spawned runs were invisible until the env var was set by hand.
const KIT_HOME_DIR = KIT_HOME();
const WORKFLOW_RUNS_DIR = path.join(KIT_HOME_DIR, "workflow-runs");
const RUN_BUFFER_CAP = 500;
const wfRuns = new Map(); // runId -> { name, offset, partial, buffer, count, startedAt, lastEventAt, terminal, summary, gnodes }
const wfSseClients = new Set();

// ── the run API: applications spawn and steer workflow runs ─────────────────
// Runs this process spawned, remembered for ownership ("who may answer this
// run"). The journal is the durable record — readRunOwner re-derives the same
// fact from a run-start line, so ownership survives a server restart.
const spawnOwners = new Map(); // runId -> app name (or "operator")

function findWorkflowFile(name) {
  const dir = path.join(expand(String(config.kitRoot ?? "")), "workflows");
  for (const ext of [".ts", ".mts", ".js", ".mjs"]) {
    const candidate = path.join(dir, name + ext);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

function readRunOwner(runDir) {
  try {
    for (const line of fs.readFileSync(path.join(runDir, "run.jsonl"), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row.kind === "run-start") return typeof row.app === "string" ? row.app : null;
      } catch {}
    }
  } catch {}
  return null;
}

function wfBroadcast(obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of [...wfSseClients]) {
    try {
      res.write(line);
    } catch {
      wfSseClients.delete(res);
    }
  }
}

function wfGraphEmit(runId, st, node) {
  if (st.gnodes.has(node.id)) return;
  st.gnodes.add(node.id);
  wfBroadcast({ type: "graph-node", node });
}

function wfTick() {
  let dirs = [];
  try {
    dirs = fs.readdirSync(WORKFLOW_RUNS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return;
  }
  for (const runId of dirs) {
    let st = wfRuns.get(runId);
    const jp = path.join(WORKFLOW_RUNS_DIR, runId, "run.jsonl");
    let size = 0;
    try {
      size = fs.statSync(jp).size;
    } catch {
      continue;
    }
    if (!st) {
      // lastEventAt starts from the journal's own mtime, not first-sight time:
      // a run that finished hours ago must show hours of silence, not the age
      // of the watcher. startedAt parses the runId's embedded clock, which is
      // UTC (the runId comes from toISOString) — without the Z suffix every
      // age would be off by the machine's UTC offset.
      let lastEventAt = Date.now();
      try {
        lastEventAt = fs.statSync(jp).mtimeMs;
      } catch {}
      const startMatch = /^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})-/.exec(runId);
      const startedAt = startMatch ? Date.parse(`${startMatch[1]}T${startMatch[2]}:${startMatch[3]}:${startMatch[4]}Z`) : Date.now();
      st = {
        name: runId.replace(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-/, ""),
        offset: 0,
        partial: "",
        buffer: [],
        count: 0,
        startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
        lastEventAt,
        terminal: false,
        summary: null,
        gnodes: new Set(),
      };
      wfRuns.set(runId, st);
    }
    if (size < st.offset) {
      st.offset = 0; // truncated or recreated
      st.partial = "";
    }
    if (size === st.offset) {
      wfMaybeSummary(runId, st);
      continue;
    }
    let text = "";
    try {
      const fd = fs.openSync(jp, "r");
      const buf = Buffer.alloc(size - st.offset);
      fs.readSync(fd, buf, 0, buf.length, st.offset);
      fs.closeSync(fd);
      st.offset = size;
      text = buf.toString("utf8");
    } catch {
      continue;
    }
    const lines = (st.partial + text).split("\n");
    st.partial = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const ev = normalizeEvent(line, { runId });
      if (!ev) continue;
      if (ev.kind === "run-start" && ev.name) st.name = ev.name;
      st.buffer.push(ev);
      if (st.buffer.length > RUN_BUFFER_CAP) st.buffer.shift();
      st.count++;
      // The event's own offset clock, not wall-clock: replaying a finished
      // journal at boot must land lastEventAt hours ago, not at boot time —
      // otherwise every finished run reads as "silent since the router
      // started" and the stall detector lies.
      st.lastEventAt = Number.isFinite(ev.t) && Number.isFinite(st.startedAt)
        ? st.startedAt + ev.t
        : Date.now();
      if (isTerminal(ev.kind)) st.terminal = true;
      wfBroadcast({ type: "event", runId, name: st.name, event: ev });
      // Live graph deltas: run → agents → artifacts, the journal-derivable spine.
      if (ev.kind === "run-start") {
        wfGraphEmit(runId, st, { id: `run:${runId}`, kind: "run", label: st.name, workflow: st.name, active: true });
      } else if (ev.kind === "agent" && ev.actor) {
        wfGraphEmit(runId, st, { id: `agent:${runId}:${ev.actor}`, kind: "agent", label: ev.actor, asks: 1, toolCalls: 0 });
        wfBroadcast({ type: "graph-edge", edge: { from: `run:${runId}`, to: `agent:${runId}:${ev.actor}`, kind: "spawns" } });
      } else if (ev.kind === "artifact" && ev.artifactId) {
        wfGraphEmit(runId, st, { id: `artifact:${runId}:${ev.artifactId}`, kind: "artifact", label: ev.artifactId, bytes: ev.bytes, path: ev.path });
        wfBroadcast({ type: "graph-edge", edge: { from: `run:${runId}`, to: `artifact:${runId}:${ev.artifactId}`, kind: "produces" } });
      }
    }
    wfMaybeSummary(runId, st);
  }
}

function wfMaybeSummary(runId, st) {
  if (st.summary || !st.terminal) return;
  try {
    st.summary = JSON.parse(fs.readFileSync(path.join(WORKFLOW_RUNS_DIR, runId, "summary.json"), "utf8"));
    wfBroadcast({ type: "summary", runId, summary: st.summary });
  } catch {}
}

function wfRunsSnapshot() {
  const now = Date.now();
  const out = [];
  for (const [runId, st] of wfRuns) {
    out.push({
      runId,
      name: st.name,
      active: !st.terminal || !st.summary,
      lastEventAgeMs: now - st.lastEventAt,
      events: st.count,
      startedAt: st.startedAt,
      summary: st.summary,
    });
  }
  out.sort((a, b) => b.startedAt - a.startedAt);
  return out.slice(0, 50);
}

let wfGraphMemo = null;
function wfGraphCached() {
  const now = Date.now();
  if (wfGraphMemo && now - wfGraphMemo.at < 5000) return wfGraphMemo.graph;
  const graph = buildGraph({
    kitHome: KIT_HOME_DIR,
    repoRoot: process.env.AGNOSTIC_ROUTER_KIT_REPO_ROOT ?? path.resolve(__dirname, ".."),
  });
  wfGraphMemo = { at: now, graph };
  return graph;
}

// ── computed surfaces for the guided setup and the agent control plane ──────
// The pages derive nothing: the router decides what is done, what is missing
// and who needs attention, the same way it already decides workloads. A page
// that recomputed readiness would drift from the router's own truth the first
// time a rule moved.

// The journal row's app field does not survive normalization, so per-run
// attribution re-reads the run-start line once per run and caches it — the
// journal, not memory, is the record (same law as run ownership).
const ownerMemo = new Map();
function runApp(runId) {
  if (ownerMemo.has(runId)) return ownerMemo.get(runId);
  let app = null;
  try {
    for (const line of fs.readFileSync(path.join(WORKFLOW_RUNS_DIR, runId, "run.jsonl"), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row.kind === "run-start") {
          app = typeof row.app === "string" ? row.app : "operator";
          break;
        }
      } catch {}
    }
  } catch {}
  ownerMemo.set(runId, app);
  return app;
}

// Live answers ride answers.jsonl next to the journal — an escalation whose
// topic is answered there is resolved even before its resolved line lands.
function readLiveAnswersFile(runDir) {
  try {
    return fs
      .readFileSync(path.join(runDir, "answers.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((r) => r && typeof r.topic === "string");
  } catch {
    return [];
  }
}

// One outstanding escalation at a time (the engine blocks inside escalate),
// so the pending one is the last unanswered escalation in the visible tail.
function pendingEscalation(runId, st) {
  let lastOpen = null;
  for (const ev of st.buffer) {
    if (ev.kind !== "escalation") continue;
    if (ev.op === "resolved") lastOpen = null;
    else lastOpen = ev;
  }
  if (!lastOpen) return null;
  const answered = readLiveAnswersFile(path.join(WORKFLOW_RUNS_DIR, runId)).some(
    (a) => a.topic && lastOpen.topic && a.topic === lastOpen.topic
  );
  return answered ? null : { question: lastOpen.question, topic: lastOpen.topic, evidence: lastOpen.evidence };
}

function setupState() {
  const r = readRoster();
  const roster = r.ok ? r.roster : null;
  const env = envFile();
  const steps = [];

  steps.push({
    id: "roster",
    label: "A roster naming your providers",
    done: r.ok,
    detail: r.ok ? ROSTER_PATH : String(r.error ?? "no roster"),
    hint: r.ok ? null : "run `kit quickstart` in a terminal (or `kit init --template`), then refresh",
  });

  const wanted = [];
  if (roster) {
    for (const [, p] of Object.entries(roster.providers ?? {})) {
      if (p.apiKeyEnv) wanted.push({ name: p.apiKeyEnv, what: p.providerName ?? "provider" });
    }
    if (roster.typesafe?.apiKeyEnv) wanted.push({ name: roster.typesafe.apiKeyEnv, what: "the judge (Jev)" });
    if (roster.judge?.fastino?.apiKeyEnv) wanted.push({ name: roster.judge.fastino.apiKeyEnv, what: "the sys1 judge" });
  }
  const missing = wanted.filter((w) => !env[w.name]);
  steps.push({
    id: "keys",
    label: "Provider keys in the runtime .env",
    done: Boolean(roster) && missing.length === 0,
    detail: missing.length ? `waiting on ${missing.map((m) => m.name).join(", ")}` : roster ? `all ${wanted.length} resolve` : "waiting on the roster",
    hint: missing.length ? "paste them below — they stay in the local .env (chmod 600) and are never sent anywhere but the provider" : null,
  });

  const tierNames = roster ? Object.keys(roster.tiers ?? {}) : [];
  const usable = Object.keys(R.workloads ?? {}).length;
  steps.push({
    id: "tiers",
    label: "At least one tier routes end to end",
    done: usable > 0,
    detail: `${usable}/${tierNames.length} tiers usable`,
    hint: usable === 0 ? "a tier needs a provider whose key resolves — add the key above, or edit the roster" : null,
  });

  const judgeMode = roster?.judge?.mode ?? "typesafe";
  const judge = { id: "judge", label: "The judge can decide", done: false, detail: "", hint: null };
  if (judgeMode === "typesafe") {
    judge.done = Boolean(typesafeKey());
    judge.detail = judge.done ? `Jev (${config.typesafeModel ?? "default"}) — key present` : "TYPESAFE_API_KEY missing";
    judge.hint = judge.done ? null : "without it every request degrades to the default workload — paste the key below";
  } else {
    const base = (roster?.judge?.fastino?.baseUrl ?? "http://127.0.0.1:8400").replace(/\/+$/, "");
    judge.detail = `${judgeMode} via ${base}`;
    judge.hint = `the judge fails open to the default workload while ${base} is down`;
  }
  steps.push(judge);

  const calls = usage.snapshot().totals.calls;
  steps.push({
    id: "first-request",
    label: "First request routed",
    done: calls > 0,
    detail: calls ? `${calls} request${calls === 1 ? "" : "s"} served so far` : "no requests yet",
    hint: calls ? null : "open the chat and say hello — that is the whole test",
  });

  // Durable memory is optional state: wired when the store exists and parses.
  const memGraph = loadGraph(memoryStorePath());
  steps.push({
    id: "memory",
    label: "Durable memory wired",
    done: memGraph.entities.length > 0,
    detail: memGraph.entities.length ? `${memGraph.entities.length} memories, ${memGraph.relations.length} relations` : "empty — nothing remembered yet",
    hint: memGraph.entities.length ? null : "say `remember …` in the chat, or run `kit memory import --from mnemosyne --file export.json`",
  });

  if (judgeMode !== "typesafe") {
    // Checked last and asynchronously: a slow decision service must slow the
    // checklist, not block it.
    const base = (roster?.judge?.fastino?.baseUrl ?? "http://127.0.0.1:8400").replace(/\/+$/, "");
    return fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1500) })
      .then((resp) => {
        judge.done = resp.ok;
        judge.detail += resp.ok ? " — reachable" : ` — answering HTTP ${resp.status}`;
      })
      .catch(() => {
        judge.done = false;
        judge.detail += " — unreachable";
      })
      .then(() => ({ ok: true, ready: steps.every((s) => s.done), steps, port: config.port }));
  }
  return Promise.resolve({ ok: true, ready: steps.every((s) => s.done), steps, port: config.port });
}

function agentsState() {
  const now = Date.now();
  const apps = new Map();
  apps.set("operator", { name: "operator", kind: "operator", label: "You (the operator token)", grants: null, workdir: null, runs: [] });
  for (const a of Array.isArray(config.apps) ? config.apps : []) {
    apps.set(a.name, {
      name: a.name,
      kind: "app",
      label: `Connected via app token`,
      grants: Array.isArray(a.grantCeiling) ? a.grantCeiling : [],
      workdir: a.workdir ? expand(String(a.workdir)) : null,
      runs: [],
    });
  }
  const attention = [];
  for (const snap of wfRunsSnapshot()) {
    const st = wfRuns.get(snap.runId);
    if (!st) continue;
    const app = runApp(snap.runId) ?? "unknown";
    if (!apps.has(app)) {
      apps.set(app, { name: app, kind: "app", label: "Seen in run journals (app not in the current roster)", grants: [], workdir: null, runs: [] });
    }
    const pending = pendingEscalation(snap.runId, st);
    const row = {
      runId: snap.runId,
      workflow: snap.name,
      active: snap.active,
      lastEventAgeMs: snap.lastEventAgeMs,
      events: snap.events,
      summary: snap.summary,
      pending,
    };
    apps.get(app).runs.push(row);
    if (pending) attention.push({ app, ...pending, runId: snap.runId, workflow: snap.name });
  }
  for (const a of apps.values()) {
    a.liveRuns = a.runs.filter((r) => r.active).length;
    a.lastActivityMs = a.runs.length ? Math.min(...a.runs.map((r) => r.lastEventAgeMs)) : null;
  }
  return {
    ok: true,
    generatedAt: now,
    agents: [...apps.values()].sort((x, y) => (x.kind === y.kind ? x.name.localeCompare(y.name) : x.kind === "operator" ? -1 : 1)),
    attention: attention.sort((x, y) => x.lastEventAgeMs - y.lastEventAgeMs),
  };
}

function wfStart() {
  wfTick();
  setInterval(wfTick, 1000).unref();
  // The heartbeat is what makes a stall visible: every client hears per-run
  // last-event age every 5s whether or not anything happened.
  setInterval(() => {
    const line = `data: ${JSON.stringify({
      type: "heartbeat",
      runs: wfRunsSnapshot().map((r) => ({ runId: r.runId, lastEventAgeMs: r.lastEventAgeMs, active: r.active })),
    })}\n\n`;
    for (const res of [...wfSseClients]) {
      try {
        res.write(line);
      } catch {
        wfSseClients.delete(res);
      }
    }
  }, 5000).unref();
}

wfStart();

const server = http.createServer((req, res) => {
  const auth = req.headers.authorization ?? "";
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    refreshConfig();
    const raw = Buffer.concat(chunks).toString("utf8");
    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    // The page shells carry no secrets in their static form, but the served
    // page is stamped with the current local token: same-origin operator
    // convenience (web pages cannot read the cross-origin response; local
    // processes can read config.json anyway), while the proxy routes keep
    // their token gate. The pages prefer the injected token over stale
    // localStorage, so a wrong saved value self-heals on reload.
    const servePage = (file, missing) => {
      try {
        const html = fs.readFileSync(file, "utf8");
        const stamped = html.replace(
          'const INJECTED_TOKEN = "";',
          `const INJECTED_TOKEN = ${JSON.stringify(config.localToken)};`
        );
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(stamped);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end(missing);
      }
    };
    // Pages match on the pathname, not the whole url: /chat?demo=1 is the
    // chat page, and a query string must never route a shell into the
    // bearer gate below.
    const pagePath = req.url.split("?")[0];
    if (req.method === "GET" && (pagePath === "/dashboard" || pagePath === "/dashboard/")) {
      servePage(DASHBOARD_FILE, "dashboard.html missing — run `kit apply` to install the router runtime");
      return;
    }
    if (req.method === "GET" && (pagePath === "/setup" || pagePath === "/setup/")) {
      servePage(SETUP_FILE, "setup.html missing — run `kit apply` to install the router runtime");
      return;
    }
    if (req.method === "GET" && (pagePath === "/chat" || pagePath === "/chat/" || pagePath === "/")) {
      servePage(CHAT_FILE, "chat.html missing — run `kit apply` to install the router runtime");
      return;
    }
    // Workflow run stream. EventSource cannot set an Authorization header, so
    // a token may arrive as ?token= — the operator's local token or an app
    // token, same gate either way, and the surface is 127.0.0.1-only.
    if (req.method === "GET" && req.url.startsWith("/api/workflow-events")) {
      const u = new URL(req.url, "http://localhost");
      const presented = u.searchParams.get("token");
      const known =
        presented === config.localToken ||
        (Array.isArray(config.apps) ? config.apps : []).some((a) => a.token && presented === a.token);
      if (!known) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "router: bad local token" } }));
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ type: "hello", runs: wfRunsSnapshot() })}\n\n`);
      wfSseClients.add(res);
      // The response's close, not the request's: a request stream closes as
      // soon as its (empty) body is consumed, which would drop the client one
      // frame in — the connection is what an SSE subscription lives on.
      res.on("close", () => wfSseClients.delete(res));
      return;
    }
    // One token gate, two token classes: the operator's localToken (no
    // ceiling — the CLI and dashboard's class) and an app token from the
    // roster's router.apps (its spawns are enforced against its grant
    // ceiling and workspace root at the run API below). Unknown → 401, as
    // it has always been.
    let caller = null;
    if (auth === `Bearer ${config.localToken}`) {
      caller = { operator: true };
    } else {
      const hit = (Array.isArray(config.apps) ? config.apps : []).find((a) => a.token && auth === `Bearer ${a.token}`);
      if (hit) caller = { operator: false, app: hit };
    }
    if (!caller) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "router: bad local token" } }));
      return;
    }
    if (req.method === "GET" && (req.url === "/v1/models" || req.url === "/models")) {
      const ids = ["auto", ...Object.keys(config.routing.profiles ?? {})];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        object: "list",
        data: ids.map((id) => ({ id, object: "model", owned_by: "auto-router" })),
      }));
      return;
    }
    // Topology verdict for delegation: the SAME brain that routes chat
    // requests decides whether a task deserves normal delegation (single),
    // MoA (mixture), or a multi-agent swarm. Body: {task} or {messages}.
    if (req.method === "POST" && (req.url === "/route" || req.url === "/v1/route")) {
      try {
        return await handleRoute(res, raw);
      } catch (err) {
        log({ event: "route-verdict", error: "handler:" + String(err?.stack ?? err).slice(0, 300) });
        if (!res.writableEnded && !res.destroyed) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "router: /route internal error" } }));
        }
        return;
      }
    }
    if (req.method === "POST" && (req.url === "/v1/chat/completions" || req.url === "/chat/completions")) {
      let body;
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "router: invalid JSON body" } }));
        return;
      }
      const signals = analyze(body);
      try {
        await forward(res, body, signals);
      } catch (err) {
        log({ event: "route", error: "handler:" + String(err?.message ?? err).slice(0, 120) });
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "router: internal error" } }));
        } else {
          try { res.end(); } catch {}
        }
      }
      return;
    }
    // ── run API — applications spawn and steer workflow runs ────────────────
    // A spawn is a capability like any other on this machine: declared,
    // validated against the caller's ceiling, journaled — refused spawns land
    // in the router log with the rule that refused them, since no run
    // directory exists to carry a journal of its own.
    const jsonOut = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(obj));
    };
    // The durable memory plane over the app wire: read/search/write, gated by
    // the `memory` capability in the caller's ceiling — an app without it is
    // refused by name, the same blast-radius rule as a spawn grant.
    if (req.url === "/v1/memory" || req.url.startsWith("/v1/memory?")) {
      const u = new URL(req.url, "http://localhost");
      const memApp = caller.operator ? null : caller.app;
      const memRefuse = (code, error) => {
        log({ event: "memory-refused", app: memApp ? memApp.name : "operator", detail: String(error).slice(0, 300) });
        jsonOut(code, { ok: false, error });
      };
      const ceilingOk = caller.operator || (Array.isArray(memApp?.grantCeiling) && memApp.grantCeiling.includes("memory"));
      if (!ceilingOk) {
        memRefuse(
          403,
          caller.operator
            ? "the operator token holds every capability — this refusal is a wiring bug"
            : `out of bounds: memory is not in ${memApp.name}'s ceiling — an app reads and writes durable memory only with the memory capability`,
        );
        return;
      }
      try {
        if (req.method === "GET") {
          const q = u.searchParams.get("q");
          const graph = loadGraph(memoryStorePath());
          if (q) return jsonOut(200, { ok: true, entities: searchGraph(graph, q, { limit: Number(u.searchParams.get("limit")) || 25 }) });
          return jsonOut(200, { ok: true, stats: memoryStats(graph) });
        }
        if (req.method === "POST") {
          let body;
          try { body = JSON.parse(raw || ""); } catch { return jsonOut(400, { ok: false, error: "body is not valid JSON" }); }
          const graph = loadGraph(memoryStorePath());
          const result = {};
          if (typeof body.entity === "string") {
            const r = createEntities(graph, [{
              name: String(body.entity).slice(0, 200),
              entityType: caller.operator ? "operator" : `app:${caller.app.name}`,
              observations: [String(body.observation ?? body.text ?? "")].filter(Boolean),
              ...(body.importance !== undefined ? { importance: body.importance } : {}),
              ...(body.veracity !== undefined ? { veracity: body.veracity } : {}),
              ...(body.validUntil !== undefined ? { validUntil: body.validUntil } : {}),
              ...(body.scope !== undefined ? { scope: body.scope } : {}),
              ...(body.extract ? { mentions: extractMentions(String(body.entity)) } : {}),
            }]);
            result.added = r.added;
          } else if (Array.isArray(body.entities)) result.added = createEntities(graph, body.entities).added;
          else if (Array.isArray(body.observations)) {
            try { result.observations = addObservations(graph, body.observations).added; }
            catch (e) { return jsonOut(400, { ok: false, error: String(e?.message ?? e) }); }
          } else if (Array.isArray(body.relations)) result.relations = createRelations(graph, body.relations).added;
          else if (body.fact) {
            result.fact = addFact(graph, { ...body.fact, source: caller.operator ? "operator" : `app:${caller.app.name}` });
            result.conflicts = detectConflicts(graph);
          }
          else return jsonOut(400, { ok: false, error: "send entity+observation, entities, relations, observations, or fact" });
          saveGraph(graph, memoryStorePath());
          log({ event: "memory-write", app: caller.operator ? "operator" : caller.app.name, added: result.added?.length ?? 0 });
          return jsonOut(200, { ok: true, ...result });
        }
        return jsonOut(405, { ok: false, error: "method not allowed" });
      } catch (e) {
        return jsonOut(500, { ok: false, error: String(e?.message ?? e).slice(0, 200) });
      }
    }
    if (req.method === "POST" && req.url === "/v1/runs") {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        jsonOut(400, { ok: false, error: "body is not valid JSON" });
        return;
      }
      const app = caller.operator ? null : caller.app;
      const appName = app ? app.name : "operator";
      const refuse = (code, error) => {
        log({ event: "run-spawn-refused", app: appName, detail: String(error).slice(0, 300) });
        jsonOut(code, { ok: false, error });
      };
      const wfName = String(body?.workflow ?? "").replace(/\.(m?ts|js)$/, "");
      const wfFile = wfName ? findWorkflowFile(wfName) : null;
      if (!wfFile) {
        refuse(400, `no workflow named "${wfName}" — the library lives under the kit root's workflows/`);
        return;
      }
      // Args validate against the workflow's own header here — the same
      // validation the engine applies, pulled forward so a bad spawn is a 400
      // rather than a runId whose run never came to exist.
      try {
        const problems = validateArgs(parseHeader(fs.readFileSync(wfFile, "utf8"), wfName), body?.args ?? {});
        if (problems.length) {
          refuse(400, `${wfName}: ${problems.join("; ")}`);
          return;
        }
      } catch (e) {
        refuse(400, String(e?.message ?? e));
        return;
      }
      // Facts validate here and again in the engine (the engine's check is
      // the authoritative one); this one fails the request before a run
      // directory exists to carry a failure.
      const facts = Array.isArray(body?.facts) ? body.facts : [];
      for (const f of facts) {
        if (!f || !FACT_KINDS.includes(String(f.kind)) || !String(f.fact ?? "").trim()) {
          refuse(
            400,
            `bad fact ${JSON.stringify(f).slice(0, 120)} — needs a declared kind (${FACT_KINDS.join(", ")}) and non-empty text`,
          );
          return;
        }
      }
      if (
        body?.answers !== undefined &&
        (typeof body.answers !== "object" ||
          body.answers === null ||
          Array.isArray(body.answers) ||
          !Object.values(body.answers).every((v) => typeof v === "string"))
      ) {
        refuse(400, "answers must be an object of topic → string answer");
        return;
      }
      // Grants resolve before anything runs, so an unknown capability fails
      // at the request rather than mid-run — the same law the engine applies.
      try {
        resolveGrants({ grants: body.grants, allowCommands: body.allowCommands });
      } catch (e) {
        refuse(400, String(e?.message ?? e));
        return;
      }
      // The ceiling: an app's spawns are enforced against its declared grant
      // list; the operator token has none. Naming the overreach is the point.
      if (app && Array.isArray(app.grantCeiling)) {
        const ceiling = new Set(app.grantCeiling);
        const requested = String(body?.grants ?? "")
          .split(",")
          .map((g) => g.trim())
          .filter(Boolean);
        const over = requested.filter((g) => !ceiling.has(g));
        if (over.length) {
          refuse(
            403,
            `out of bounds: ${over.join(", ")} ${over.length > 1 ? "are" : "is"} not in ${app.name}'s ceiling — an app spawns under its declared grants, never beyond them`,
          );
          return;
        }
      }
      // The workspace: an app runs inside its own root (its roster workdir or
      // the runtime default), and a body workdir is a subpath of that root —
      // outside is refused by name, the same closure as recall's sibling
      // refusal. The operator may name any directory, like the CLI.
      let workdir;
      if (caller.operator) {
        workdir = body?.workdir ? path.resolve(String(body.workdir)) : process.cwd();
      } else {
        const root = path.resolve(
          app.workdir ? expand(String(app.workdir)) : path.join(KIT_HOME_DIR, "apps", app.name, "workspaces"),
        );
        const requested = path.resolve(root, String(body?.workdir ?? "."));
        if (requested !== root && !requested.startsWith(root + path.sep)) {
          refuse(
            403,
            `out of bounds: ${String(body?.workdir)} is outside ${app.name}'s workspace root — an app runs in its own root, never outside it`,
          );
          return;
        }
        workdir = requested;
      }
      // The run id is the run directory's name — computed here so the
      // response hands it back before the run exists, and freeRunDir still
      // guards the same-second collision the plane fixed.
      const outDir = freeRunDir(`${slug(Date.now())}-${wfName}`);
      const runId = path.basename(outDir);
      spawnOwners.set(runId, appName);
      log({ event: "run-spawned", runId, app: appName, workflow: wfName, grants: String(body?.grants ?? "") });
      runWorkflow(wfFile, {
        args: body?.args ?? {},
        workdir,
        outDir,
        model: body?.model ?? "hard",
        grants: body?.grants,
        allowCommands: body?.allowCommands,
        netDomains: body?.allowDomains,
        // The owner-wait channel: opt in per spawn with awaitOwnerMs (capped
        // at a day) and an unanswered escalation holds the run open while the
        // human answers through /v1/runs/<id>/answers. Default stays 0 —
        // today's degrade-fast behavior — so existing callers change nothing.
        awaitOwnerMs: Math.min(Math.max(Number(body?.awaitOwnerMs) || 0, 0), 86_400_000),
        // The search backend's key resolves from this server's env file at the
        // boundary; the plane sees only the declared name's value.
        search: {
          backend: "firecrawl",
          apiKeyEnv: "FIRECRAWL_API_KEY",
          envMap: { FIRECRAWL_API_KEY: envFile().FIRECRAWL_API_KEY },
          scrapeBaseUrl: envFile().FIRECRAWL_SCRAPE_URL,
          scrapeApiVersion: envFile().FIRECRAWL_SCRAPE_VERSION,
        },
        answers: body?.answers ?? {},
        facts,
        app: appName,
      })
        .then(({ summary }) => {
          log({ event: "run-api-run-done", runId, ok: summary.ok, durationMs: summary.durationMs });
        })
        .catch((e) => {
          // The engine already journals the failure as a real run (summary +
          // run-failed line); this catch is the router log only.
          log({ event: "run-api-run-failed", runId, detail: String(e?.message ?? e).slice(0, 300) });
        });
      jsonOut(200, { ok: true, runId, runDir: outDir });
      return;
    }
    const runApiMatch = /^\/v1\/runs\/([^/]+)(\/answers|\/artifacts)$/.exec(req.url.split("?")[0]);
    if (req.method === "POST" && runApiMatch && runApiMatch[2] === "/answers") {
      const runId = decodeURIComponent(runApiMatch[1]);
      const runDir = path.join(WORKFLOW_RUNS_DIR, runId);
      if (!fs.existsSync(path.join(runDir, "run.jsonl"))) {
        jsonOut(404, { ok: false, error: `unknown run: ${runId}` });
        return;
      }
      // Scoped like recall: an app answers only the runs it spawned; the
      // operator answers any. Ownership survives a restart because the
      // journal, not this process's memory, is the record.
      const owner = spawnOwners.get(runId) ?? readRunOwner(runDir);
      if (!caller.operator && owner !== caller.app.name) {
        log({ event: "run-answer-refused", runId, app: caller.app.name, owner });
        jsonOut(403, {
          ok: false,
          error: `out of bounds: ${runId} was spawned by ${owner ?? "another caller"} — an app answers its own runs`,
        });
        return;
      }
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        jsonOut(400, { ok: false, error: "body is not valid JSON" });
        return;
      }
      const topic = String(body?.topic ?? "").trim();
      const answer = body?.answer;
      if (!topic || typeof answer !== "string" || !answer.trim()) {
        jsonOut(400, { ok: false, error: "an answer needs a non-empty topic and a non-empty string answer" });
        return;
      }
      fs.appendFileSync(
        path.join(runDir, "answers.jsonl"),
        JSON.stringify({ topic, answer, app: caller.operator ? "operator" : caller.app.name, t: Date.now() }) + "\n",
      );
      jsonOut(200, { ok: true, runId, topic });
      return;
    }
    if (req.method === "GET" && runApiMatch && runApiMatch[2] === "/artifacts") {
      const runId = decodeURIComponent(runApiMatch[1]);
      const runDir = path.join(WORKFLOW_RUNS_DIR, runId);
      const artifactsDir = path.join(runDir, "artifacts");
      if (!fs.existsSync(path.join(runDir, "run.jsonl"))) {
        jsonOut(404, { ok: false, error: `unknown run: ${runId}` });
        return;
      }
      // Scoped like the answers route: an app reads only its own runs'
      // artifacts; the operator reads any. Two apps spawning side by side is
      // the run-scoped analogue of part isolation.
      const owner = spawnOwners.get(runId) ?? readRunOwner(runDir);
      if (!caller.operator && owner !== caller.app.name) {
        log({ event: "run-artifacts-refused", runId, app: caller.app.name, owner });
        jsonOut(403, {
          ok: false,
          error: `out of bounds: ${runId} was spawned by ${owner ?? "another caller"} — an app reads its own runs' artifacts`,
        });
        return;
      }
      const u = new URL(req.url, "http://localhost");
      const wanted = u.searchParams.get("file");
      if (wanted) {
        // A download lives inside this run's artifacts directory or it does
        // not exist: `..` and foreign paths resolve to the same refusal.
        const full = path.resolve(artifactsDir, wanted);
        if (full !== artifactsDir && !full.startsWith(artifactsDir + path.sep)) {
          jsonOut(403, { ok: false, error: "out of bounds: artifacts are inside this run's directory, never outside it" });
          return;
        }
        let st = null;
        try {
          st = fs.statSync(full);
        } catch {}
        if (!st || !st.isFile()) {
          jsonOut(404, { ok: false, error: `no artifact file: ${wanted}` });
          return;
        }
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": st.size });
        fs.createReadStream(full).pipe(res);
        return;
      }
      const index = [];
      try {
        for (const idDir of fs.readdirSync(artifactsDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
          for (const vDir of fs.readdirSync(path.join(artifactsDir, idDir.name), { withFileTypes: true }).filter((d) => d.isDirectory())) {
            for (const f of fs.readdirSync(path.join(artifactsDir, idDir.name, vDir.name), { withFileTypes: true }).filter((d) => d.isFile())) {
              const rel = path.join(idDir.name, vDir.name, f.name);
              index.push({
                id: idDir.name,
                version: Number(vDir.name.replace(/^v/, "")) || null,
                file: rel,
                bytes: fs.statSync(path.join(artifactsDir, rel)).size,
              });
            }
          }
        }
      } catch {}
      jsonOut(200, { ok: true, runId, artifacts: index });
      return;
    }
    // ── dashboard API — same token gate as the proxy routes ─────────────────
    if (req.url.startsWith("/api/")) {
      const jsonOut = (code, obj) => {
        res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(obj));
      };
      // The control plane is operator-class, full stop: these routes rewrite
      // the roster (and re-run apply), read the ledger, and answer runs. An
      // app token used to pass on validity alone — one with an empty
      // grantCeiling could have rewritten the roster from the browser.
      // Everything an app legitimately needs lives under /v1, scoped there.
      if (!caller.operator) {
        jsonOut(403, { ok: false, error: "this surface needs the operator token — apps act through /v1" });
        return;
      }
      if (req.method === "GET" && req.url === "/api/state") {
        const r = readRoster();
        const roster = r.ok ? r.roster : null;
        jsonOut(200, {
          ok: true,
          port: config.port,
          kitRoot: KIT_ROOT,
          rosterPath: ROSTER_PATH,
          typesafe: { model: config.typesafeModel ?? null, envFile: config.typesafeEnvFile ?? null, keyPresent: Boolean(typesafeKey()) },
          judge: { mode: config.judge?.mode ?? "typesafe", model: config.judge?.fastino?.model ?? null },
          guard: {
            allowPayg: Boolean(roster?.allowPayg),
            paygProviders: roster ? Object.entries(roster.providers ?? {}).filter(([, p]) => (p.billing ?? "plan") === "payg").map(([id]) => id) : [],
          },
          resolved: {
            defaultWorkload: R.defaultWorkload ?? null,
            workloads: R.workloads ?? {},
            omniModel: R.omniModel ?? null,
            wideModel: R.wideModel ?? null,
            mixture: R.mixture ?? null,
            profiles: R.profiles ?? {},
            // The workflow registry the judge routes into, plus the full
            // catalog — the surfaces that start runs list what can be started
            // rather than making the user guess names.
            workflows: R.workflows ?? [],
            workflowLibrary: Array.isArray(config.workflowLibrary) ? config.workflowLibrary : [],
            thresholds: {
              wideChars: R.wideChars ?? null,
              minConfidence: R.minConfidence ?? null,
              workflowMinConfidence: R.workflowMinConfidence ?? null,
            },
          },
          quota: {
            minHeadroom: R.quotaMinHeadroom ?? 0.4,
            declared: Object.values(quotaState()),
            neutral: (() => {
              const declared = new Set(Object.keys(quotaState()));
              const routed = new Set();
              for (const w of Object.values(R.workloads ?? {})) for (const c of w.candidates ?? []) routed.add(c.providerId);
              for (const p of [R.omniModel, R.wideModel, R.mixture?.aggregator].flat().filter(Boolean)) {
                routed.add(p.providerId);
                for (const c of p.candidates ?? []) routed.add(c.providerId);
              }
              for (const p of R.mixture?.proposers ?? []) routed.add(p.providerId);
              return [...routed].filter((pid) => !declared.has(pid));
            })(),
          },
          // The FULL roster, not a projection: the dashboard edits this object
          // and PUTs it back verbatim, so it must carry every section
          // (typesafe, workflows, manualModelRules, judge, quota, baseUrl…).
          // A projected copy once reached the PUT path and validation + the
          // rollback caught it — but only after the operator hit a wall.
          // id/hasKey/enabled are attached per provider for the UI.
          roster: roster
            ? (() => {
                const full = JSON.parse(JSON.stringify(roster));
                for (const [id, p] of Object.entries(full.providers ?? {})) {
                  p.id = id;
                  p.enabled = p.enabled !== false;
                  p.hasKey = p.apiKeyEnv ? Boolean(envFile()[p.apiKeyEnv]) : Boolean(p.apiKey);
                }
                return full;
              })()
            : { error: r.error },
        });
        return;
      }
      if (req.method === "GET" && req.url === "/api/usage") {
        jsonOut(200, { ok: true, ...usage.snapshot() });
        return;
      }
      if (req.method === "POST" && req.url === "/api/usage/reset") {
        usage.reset();
        jsonOut(200, { ok: true, ...usage.snapshot() });
        return;
      }
      // Suggest a delegation distribution from the roster + measured ledger.
      // Deterministic and read-only — nothing is applied until the operator
      // sends the edited roster back through PUT /api/roster.
      if (req.method === "GET" && req.url === "/api/suggest") {
        const r = readRoster();
        if (!r.ok) {
          jsonOut(500, { ok: false, error: r.error });
          return;
        }
        try {
          // Router-only providers keep models[] empty (they route via tiers,
          // not the picker) — collect every routed pair from the live config
          // so the suggester can consider them too.
          const routedModels = {};
          for (const w of Object.values(R.workloads ?? {})) {
            for (const c of w.candidates ?? []) (routedModels[c.providerId] ??= new Set()).add(c.model);
          }
          for (const p of [R.omniModel, R.wideModel, R.mixture?.aggregator].flat().filter(Boolean)) {
            (routedModels[p.providerId] ??= new Set()).add(p.model);
            for (const c of p.candidates ?? []) (routedModels[c.providerId] ??= new Set()).add(c.model);
          }
          for (const p of R.mixture?.proposers ?? []) (routedModels[p.providerId] ??= new Set()).add(p.model);
          jsonOut(200, suggestDelegation({
            roster: r.roster,
            envMap: envFile(),
            snapshot: usage.snapshot(),
            quota: quotaState(),
            routedModels: Object.fromEntries(Object.entries(routedModels).map(([k, v]) => [k, [...v]])),
          }));
        } catch (err) {
          jsonOut(500, { ok: false, error: `suggester failed: ${String(err?.message ?? err)}` });
        }
        return;
      }
      if (req.method === "GET" && req.url === "/api/roster") {
        const r = readRoster();
        jsonOut(r.ok ? 200 : 500, r.ok ? { ok: true, path: ROSTER_PATH, roster: r.roster } : { ok: false, error: r.error });
        return;
      }
      if (req.method === "PUT" && req.url === "/api/roster") {
        let candidate;
        try {
          candidate = JSON.parse(raw || "");
        } catch {
          jsonOut(400, { ok: false, error: "body is not valid JSON" });
          return;
        }
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
          jsonOut(400, { ok: false, error: "roster must be a JSON object" });
          return;
        }
        for (const section of ["providers", "tiers", "profiles", "mixture", "routing"]) {
          if (!candidate[section] || typeof candidate[section] !== "object") {
            jsonOut(400, { ok: false, error: `roster.${section} is required (send the whole roster back, edited)` });
            return;
          }
        }
        // Server-owned fields: the router identity and schema version are not
        // dashboard-editable — changing the port here would desync the running
        // service definition, and both belong to `kit apply` / the CLI.
        candidate.version = 1;
        const cur = readRoster();
        if (cur.ok) {
          if (cur.roster.router) candidate.router = cur.roster.router;
          if (cur.roster.exportedFrom) candidate.exportedFrom = cur.roster.exportedFrom;
        }
        // Calibration reads entered today are stamped with the cumulative
        // weighted spend at this instant — that stamp is what makes the
        // allowance derivation exact. Reads back-dated beyond yesterday can't
        // be stamped honestly and stay unstamped (excluded from pair
        // calibration until they age into the ledger's own derivable range).
        const today = new Date().toISOString().slice(0, 10);
        const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
        for (const [pid, p] of Object.entries(candidate.providers ?? {})) {
          for (const read of p.quota?.calibration?.reads ?? []) {
            if (!Number.isFinite(read.cum) && (read.date === today || read.date === yesterday)) {
              read.cum = usage.cumulativeWeighted(pid);
            }
          }
        }
        const result = await applyRoster(candidate);
        jsonOut(result.ok ? 200 : 409, { ok: result.ok, output: result.output, restartRecommended: result.restartRecommended });
        return;
      }
      // Key entry from the browser: write-only by contract. The request may
      // carry secrets; the response never reflects them — only whether each
      // name resolves after the write. Same file, mode and merge rules as
      // `kit env set` (writeEnvPairs above).
      if (req.method === "POST" && req.url === "/api/keys") {
        let body;
        try {
          body = JSON.parse(raw || "");
        } catch {
          jsonOut(400, { ok: false, error: "body is not valid JSON" });
          return;
        }
        const pairs = body?.keys;
        if (!pairs || typeof pairs !== "object" || Array.isArray(pairs)) {
          jsonOut(400, { ok: false, error: 'send {"keys": {"NAME": "value"}} — names are env-var names from the roster' });
          return;
        }
        const clean = {};
        for (const [k, v] of Object.entries(pairs)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
            jsonOut(400, { ok: false, error: `not a valid env name: ${k}` });
            return;
          }
          if (typeof v !== "string" || !v.trim()) {
            jsonOut(400, { ok: false, error: `empty value for ${k}` });
            return;
          }
          clean[k] = v.trim();
        }
        const r = writeEnvPairs(clean);
        jsonOut(r.ok ? 200 : 500, r.ok ? { ok: true, configured: r.configured } : { ok: false, error: r.error });
        return;
      }
      // The guided-setup checklist, computed here so the page cannot drift
      // from the router's own truth. Order is the order a new user meets the
      // problems; `next` names the first thing to fix.
      if (req.method === "GET" && req.url === "/api/setup") {
        setupState().then((s) => jsonOut(200, s));
        return;
      }
      // The durable memory plane, operator scope: search, stats, write.
      // The store is the kit's own JSONL graph (workflow-plane/memory.mjs);
      // writes are atomic and attributed in the router log.
      if (req.url.startsWith("/api/memory")) {
        const u = new URL(req.url, "http://localhost");
        try {
          if (req.method === "GET") {
            const q = u.searchParams.get("q");
            const graph = loadGraph(memoryStorePath());
            if (q) return jsonOut(200, { ok: true, entities: searchGraph(graph, q, { limit: Number(u.searchParams.get("limit")) || 25 }) });
            return jsonOut(200, { ok: true, stats: memoryStats(graph) });
          }
          if (req.method === "POST") {
            let body;
            try { body = JSON.parse(raw || ""); } catch { return jsonOut(400, { ok: false, error: "body is not valid JSON" }); }
            const graph = loadGraph(memoryStorePath());
            let result = { added: [] };
            if (Array.isArray(body.entities)) result = createEntities(graph, body.entities);
            if (Array.isArray(body.relations)) result.relations = createRelations(graph, body.relations).added;
            if (Array.isArray(body.observations)) {
              try { result.observations = addObservations(graph, body.observations).added; }
              catch (e) { return jsonOut(400, { ok: false, error: String(e?.message ?? e) }); }
            }
            if (body.fact) {
              result.fact = addFact(graph, { ...body.fact, source: "operator" });
              result.conflicts = detectConflicts(graph);
            }
            saveGraph(graph, memoryStorePath());
            log({ event: "memory-write", caller: "operator", entities: result.added?.length ?? 0 });
            return jsonOut(200, { ok: true, ...result });
          }
        } catch (e) {
          return jsonOut(500, { ok: false, error: String(e?.message ?? e).slice(0, 200) });
        }
      }
      // The agent control plane: every token holder the router knows about,
      // what each is running right now, and which runs are waiting on a human.
      if (req.method === "GET" && req.url === "/api/agents") {
        jsonOut(200, agentsState());
        return;
      }
      if (req.method === "GET" && req.url === "/api/workflow-runs") {
        jsonOut(200, { ok: true, runs: wfRunsSnapshot() });
        return;
      }
      if (req.method === "GET" && req.url.startsWith("/api/workflow-run/")) {
        const runId = decodeURIComponent(req.url.slice("/api/workflow-run/".length).split("?")[0]);
        const st = wfRuns.get(runId);
        if (!st) {
          jsonOut(404, { ok: false, error: `unknown run: ${runId}` });
          return;
        }
        jsonOut(200, { ok: true, runId, name: st.name, active: !st.terminal || !st.summary, events: st.buffer, summary: st.summary });
        return;
      }
      if (req.method === "GET" && req.url === "/api/workflow-graph") {
        try {
          jsonOut(200, wfGraphCached());
        } catch (e) {
          jsonOut(500, { ok: false, error: String(e?.message ?? e).slice(0, 200) });
        }
        return;
      }
      jsonOut(404, { ok: false, error: "router: unknown api path" });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "router: not found" } }));
  });
  req.on("error", () => {});
});

// A proxy should survive anything short of a disk fault; log and keep serving
// (launchd KeepAlive restarts the process if it ever does exit).
process.on("unhandledRejection", (err) => log({ event: "unhandledRejection", detail: String(err?.stack ?? err).slice(0, 600) }));
process.on("uncaughtException", (err) => log({ event: "uncaughtException", detail: String(err).slice(0, 200) }));
// The usage ledger is the dashboard's whole history — never drop it on shutdown.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    usage.flush();
    process.exit(0);
  });
}
process.on("exit", () => usage.flush());

// GLiNER models cold-start behind Fastino with HTTP 425s that can last
// minutes — unacceptable for the judge's fast path. When a non-typesafe
// judge mode is on, ping periodically so the model stays warm; the ping is
// a tiny schema and failures stay silent (the judge escalates anyway).
const warmOnce = () => {
  const mode = config.judge?.mode ?? "typesafe";
  if (mode === "typesafe" || config.judge?.fastino?.keepWarm === false) return;
  judgeViaFastino({
    signals: { lastUser: "warm", messages: [{ role: "user", content: "warm" }], chars: 4, images: 0, toolDefs: 0 },
    cfg: config, envMap: envFile(), R,
  }).then((r) => {
    log({ event: "judge-warm", status: r.cold ? "cold" : "warm", ms: r.ms ?? null });
  }).catch(() => {});
};
const warmTimer = setInterval(warmOnce, 150_000);
warmTimer.unref?.();

server.listen(config.port, "127.0.0.1", () => {
  log({ event: "start", port: config.port });
  console.log(`agnostic-router listening on 127.0.0.1:${config.port}`);
  console.log(`dashboard: http://127.0.0.1:${config.port}/dashboard`);
  warmOnce();
});
