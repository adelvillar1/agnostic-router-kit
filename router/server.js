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
  if (!target || target.kind === "mixture" || !Array.isArray(target.candidates) || target.candidates.length < 2) return target;
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

// MoA needs a pure completion: parallel proposals can't be merged when the
// turn is choosing tool calls mid-loop. Tool-carrying requests fall back to
// the single strong model.
function mixtureTarget(signals, baseReason, execution = "mixture", workload = "mixture") {
  if (signals.toolDefs > 0 || signals.hasToolMessages) {
    return {
      ...R.workloads.hard,
      workload: "hard",
      execution: "single",
      conf: null,
      reason: `${baseReason}+mixture-skipped-tools`,
    };
  }
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
  const judgedWorkflow = judged.workflow ?? null;
  const judgedFollowUp = judged.followUp ?? null;
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
  }, (R.mixture?.proposerTimeoutMs ?? 120000), null, think);
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
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    workload: target.workload,
    execution: target.kind === "mixture" ? (target.execution ?? "mixture") : (target.execution ?? "single"),
    target: target.kind === "mixture" ? null : { providerId: target.providerId, model: target.model },
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
    execution: target.execution ?? "single",
    workflow: plan.map((x) => x.name).join(" -> ") || null,
    reason: target.reason,
  });
  usage.recordDelegation({
    workload: target.workload,
    execution: target.kind === "mixture" ? (target.execution ?? "mixture") : (target.execution ?? "single"),
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
    // The dashboard shell carries no secrets in its static form, but the
    // served page is stamped with the current local token: same-origin
    // operator convenience (web pages cannot read the cross-origin response;
    // local processes can read config.json anyway), while the proxy routes
    // keep their token gate. The page prefers the injected token over stale
    // localStorage, so a wrong saved value self-heals on reload.
    if (req.method === "GET" && (req.url === "/dashboard" || req.url === "/dashboard/")) {
      try {
        const html = fs.readFileSync(DASHBOARD_FILE, "utf8");
        const stamped = html.replace(
          'const INJECTED_TOKEN = "";',
          `const INJECTED_TOKEN = ${JSON.stringify(config.localToken)};`
        );
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(stamped);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("dashboard.html missing — run `kit apply` to install the router runtime");
      }
      return;
    }
    if (auth !== `Bearer ${config.localToken}`) {
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
    // ── dashboard API — same token gate as the proxy routes ─────────────────
    if (req.url.startsWith("/api/")) {
      const jsonOut = (code, obj) => {
        res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(obj));
      };
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
            thresholds: {
              wideChars: R.wideChars ?? null,
              minConfidence: R.minConfidence ?? null,
              workflowMinConfidence: R.workflowMinConfidence ?? null,
            },
            workflows: R.workflows ?? [],
            workflowLibrary: config.workflowLibrary ?? null,
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
