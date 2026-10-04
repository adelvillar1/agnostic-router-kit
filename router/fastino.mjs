/**
 * Fastino GLiNER2.5 judge backend — served by sys1.
 *
 * sys1 (the standalone decision-model library) is the one fastino
 * integration. This module POSTs the routing questions to the sys1 service's
 * /v1/classify as an inline task_spec, and sys1's `decide` provider — the
 * hosted Fastino API — answers with fastino/GLiNER2.5-Decide: one fan-out
 * call, full probabilities, confidence = max. TypeSafe stays as the escalation for low
 * confidence (cascade mode) and as the mixture's best-answer judge, where
 * comparing three long answers is reasoning work an encoder should not do.
 *
 * Judge endpoint config (cfg.judge.fastino):
 *   baseUrl   — sys1 service base URL (default http://127.0.0.1:8400)
 *   apiKeyEnv — bearer-token env var read from the router .env (default
 *               SYS1_BEARER_TOKEN; a service without a token set is open).
 *               The sys1 service itself needs FASTINO_API_KEY in its env.
 *   provider  — sys1 provider id (default "decide": the hosted Fastino API;
 *               per the 2026-09-28 policy, fastino + jev are the only active
 *               providers — local is supported by design, not encouraged)
 *   task      — registered task name to use INSTEAD of the inline task_spec
 *               (default unset; see sys1 examples/routing-judge.toml)
 *   timeoutMs — fetch timeout (default 2500)
 *
 * The task_spec is built from this install's own workload/workflow names by
 * default, so the model always sees the labels the router actually routes to
 * (the workflow names are per-install config, not fixed vocabulary).
 *
 * Reason strings keep the judge:fastino:* prefix for log continuity with the
 * previous direct-hosted implementation (which called api.fastino.ai with
 * the multi-v1 model). Operational quirks — HTTP 425 model_warming cold
 * starts, 429/5xx — are absorbed by sys1's http core (retry with backoff).
 * Service-down surfaces as judge:fastino:unreachable and the caller's
 * fail-open path handles it, same as before. The old hosted parser
 * (parseFastinoVerdict) is retained for compatibility with recorded hosted
 * responses but is no longer on the live path.
 */
const EXECUTIONS = ["single", "mixture", "swarm"];

import fs from "node:fs";

/** Read the router .env (same file the TypeSafe key lives in). */
function envFile(file) {
  try {
    const out = {};
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Pull a {value, confidence} pair out of whatever a classification answer
 * looks like. Tolerates: plain string, {answer|value|choice|label},
 * {answer, confidence}, {value, score}, and wrapping objects one level deep.
 * (Legacy — used by parseFastinoVerdict for recorded hosted responses.)
 */
function readAnswer(v) {
  if (v == null) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return { value: String(v), confidence: null };
  }
  if (typeof v !== "object") return null;
  const value = v.answer ?? v.value ?? v.choice ?? v.label ?? v.decision ?? null;
  if (value == null) {
    for (const inner of Object.values(v)) {
      const nested = readAnswer(inner);
      if (nested?.value != null) return nested;
    }
    return null;
  }
  const confidence = [v.confidence, v.score, v.probability, v.prob]
    .find((n) => Number.isFinite(n)) ?? null;
  return { value: String(value), confidence };
}

/**
 * LEGACY: parse a hosted chat-completions classification content string into
 * the judge verdict shape. Not on the live path (the live path reads sys1's
 * structured answers directly in answersToVerdict below); kept so recorded
 * hosted responses and old replay tooling still parse. Returns null (never
 * throws) when nothing usable is found.
 */
export function parseFastinoVerdict(content) {
  if (typeof content !== "string" || !content.trim()) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    const first = content.indexOf("{");
    const last = content.lastIndexOf("}");
    if (first < 0 || last <= first) return null;
    try { parsed = JSON.parse(content.slice(first, last + 1)); } catch { return null; }
  }
  if (!parsed || typeof parsed !== "object") return null;

  const roots = [parsed, parsed.classifications, parsed.answers, parsed.results].filter(
    (r) => r && typeof r === "object"
  );
  const pick = (name) => {
    for (const root of roots) {
      const a = readAnswer(root[name]);
      if (a?.value != null) return a;
    }
    return null;
  };

  const workload = pick("workload");
  const execution = pick("execution");
  const workflow = pick("workflow");
  const followUp = pick("followUp");
  if (!workload && !workflow) return null;

  const overall = readAnswer(parsed.confidence);
  const conf = workload?.confidence
    ?? (Number.isFinite(parsed.confidence) ? parsed.confidence : null)
    ?? (overall?.confidence != null ? overall.confidence : null);
  const execConf = execution?.confidence ?? conf ?? null;
  const wfConf = workflow?.confidence ?? conf ?? null;

  const clean = (v) => (v == null ? null : String(v).trim());
  return {
    workload: clean(workload?.value),
    execution: clean(execution?.value),
    workflow: workflow?.value == null ? null : clean(workflow.value),
    followUp: followUp?.value == null ? null : clean(followUp.value),
    conf: Number.isFinite(conf) ? conf : null,
    execConf: Number.isFinite(execConf) ? execConf : null,
    wfConf: Number.isFinite(wfConf) ? wfConf : null,
    reason: "judge:fastino",
  };
}

/** Apply the same gates the TypeSafe judge applies, for identical behavior. */
export function gateFastinoVerdict(verdict, R) {
  if (!verdict) return null;
  const out = { ...verdict, workload: null, execution: null, workflow: null, followUp: null };
  const workloadOk = verdict.workload && verdict.workload in (R.workloads ?? {}) && (verdict.conf ?? 0) >= (R.minConfidence ?? 0.6);
  if (workloadOk) out.workload = verdict.workload;
  if (verdict.execution && EXECUTIONS.includes(verdict.execution) && (verdict.execConf ?? verdict.conf ?? 0) >= (R.minConfidence ?? 0.6)) {
    out.execution = verdict.execution;
  }
  const wfNames = new Set((R.workflows ?? []).map((w) => w.name));
  if (verdict.workflow && wfNames.has(verdict.workflow) && (verdict.wfConf ?? 0) >= (R.workflowMinConfidence ?? 0.4)) {
    out.workflow = verdict.workflow;
  }
  if (verdict.followUp && verdict.followUp !== out.workflow && wfNames.has(verdict.followUp)) {
    out.followUp = verdict.followUp;
  }
  out.reason = (out.workload || out.workflow) ? "judge:fastino" : "judge:fastino:low-confidence";
  return out;
}

/**
 * Map sys1's per-head answers ({head: {label, confidence, probabilities}})
 * to the judge verdict shape. Same rules as the legacy parser: null when
 * neither workload nor workflow produced an answer (never throws).
 */
function answersToVerdict(answers) {
  const pick = (head) => {
    const a = answers[head];
    if (!a || typeof a !== "object") return null;
    const label = a.label ?? null;
    if (label == null) return null;
    return { value: String(label), confidence: Number.isFinite(a.confidence) ? a.confidence : null };
  };
  const workload = pick("workload");
  const execution = pick("execution");
  const workflow = pick("workflow");
  const followUp = pick("followUp");
  if (!workload && !workflow) return null;
  const conf = workload?.confidence ?? null;
  const execConf = execution?.confidence ?? conf ?? null;
  const wfConf = workflow?.confidence ?? conf ?? null;
  return {
    workload: workload?.value ?? null,
    execution: execution?.value ?? null,
    workflow: workflow?.value ?? null,
    followUp: followUp?.value ?? null,
    conf,
    execConf,
    wfConf,
    reason: "judge:fastino",
  };
}

/**
 * Judge via sys1's local fastino Decide provider. Same return contract as
 * judgeWorkload, plus raw for debug logs. Never throws on HTTP/transport
 * failure — returns a blank low-confidence verdict with a judge:fastino:*
 * reason so the caller's fail-open path handles it, same as before.
 */
export async function judgeViaFastino({ signals, cfg, envMap, R }) {
  const judgeCfg = cfg.judge?.fastino ?? {};
  const blank = { workload: null, execution: null, workflow: null, followUp: null, conf: null };
  const apiKey = envMap[judgeCfg.apiKeyEnv ?? "SYS1_BEARER_TOKEN"] ?? null;
  const baseUrl = (judgeCfg.baseUrl ?? "http://127.0.0.1:8400").replace(/\/+$/, "");
  const provider = judgeCfg.provider ?? "decide"; // hosted Fastino API — the active fastino provider

  const content =
    `${signals.lastUser}\n\n` +
    `[context] messages=${signals.messages.length}, ~${Math.round(signals.chars / 4)} input tokens, ` +
    `${signals.images} image(s), ${signals.toolDefs} tool definitions`;

  const wfNames = (R.workflows ?? []).map((w) => w.name);
  let task = judgeCfg.task ?? null;
  let taskSpec = null;
  if (!task) {
    const heads = [
      { id: "workload", kind: "choice", task: "Which workload does this user turn belong to?", labels: Object.keys(R.workloads ?? {}) },
      { id: "execution", kind: "choice", task: "How should this turn execute?", labels: [...EXECUTIONS] },
      { id: "workflow", kind: "choice", task: "Which named workflow fits this turn, if any? Answer none when no workflow applies.", labels: [...wfNames, "none"] },
      { id: "followUp", kind: "choice", task: "Which workflow should the NEXT turn run, if any? Answer none when nothing should follow up.", labels: [...wfNames, "none"] },
    ].filter((h) => h.labels.length >= 2);
    if (!heads.length) {
      return { ...blank, reason: "judge:fastino:no-heads", raw: null, ms: 0 };
    }
    taskSpec = {
      id: "routing_judge",
      description: "Route a user turn: workload, execution mode, workflow, follow-up.",
      heads,
    };
  }

  const body = { provider, text: content, log: false };
  if (task) body.task = task;
  else body.task_spec = taskSpec;

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${baseUrl}/v1/classify`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(judgeCfg.timeoutMs ?? 2500),
    });
  } catch (err) {
    return { ...blank, reason: "judge:fastino:unreachable:" + String(err?.message ?? err).slice(0, 80), raw: null, ms: Date.now() - t0 };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { ...blank, reason: `judge:fastino:error:http-${res.status}`, raw: detail.slice(0, 200), ms: Date.now() - t0 };
  }

  let d = null;
  try {
    d = await res.json();
  } catch (err) {
    return { ...blank, reason: "judge:fastino:error:unparseable-response", raw: null, ms: Date.now() - t0 };
  }
  const answers = d?.answers?.[provider] ?? {};
  const verdict = answersToVerdict(answers);
  if (!verdict) {
    return { ...blank, reason: "judge:fastino:error:no-answers", raw: JSON.stringify(answers ?? {}).slice(0, 200), ms: Date.now() - t0 };
  }
  const gated = gateFastinoVerdict(verdict, R);
  return {
    ...gated,
    rawVerdict: { workload: verdict.workload, execution: verdict.execution, workflow: verdict.workflow, followUp: verdict.followUp, conf: verdict.conf },
    raw: JSON.stringify(answers).slice(0, 300),
    ms: Date.now() - t0,
  };
}
