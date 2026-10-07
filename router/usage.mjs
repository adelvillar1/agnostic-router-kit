/**
 * Usage accounting for the router — what was actually sent to each model.
 *
 * The router is the only vantage point that sees every upstream call,
 * including the fan-out a mixture execution makes, so this module keeps the
 * per-model ledger the dashboard renders: calls, errors, prompt and
 * completion tokens, per-day, plus a small ring buffer of recent requests
 * for the live view. Tokens are recorded only when the upstream reported
 * them — nothing is estimated, and a model whose responses carry no usage
 * shows calls with unknown tokens rather than invented numbers.
 *
 * State is held in memory and persisted atomically to a single JSON file a
 * few seconds after the last change, so the ledger survives deploys and
 * service restarts without a write on every request.
 */
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { writeFileAtomic } from "./atomic.mjs";

const DAY_MS = 86400000;
const KEEP_DAYS = 30;
const MAX_RECENT = 200;
const FLUSH_DEBOUNCE_MS = 3000;

function dayOf(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

const cascadeQuestions = () => ({
  workload: zq(), execution: zq(), workflow: zq(), followUp: zq(),
});
const zq = () => ({ agree: 0, disagree: 0, abstain: 0, gateRejected: 0 });

function emptyState() {
  return {
    startedAt: null, // first boot that began this ledger
    bootAt: null, // current process start
    byModel: {}, // key -> { calls, ok, errors, promptTokens, completionTokens, tokensKnown, lastUsedAt }
    byDay: {}, // day -> key -> { calls, promptTokens, completionTokens }
    hourly: {}, // providerId -> "YYYY-MM-DDTHH" (UTC) -> { calls, tokens } — the raw material for rolling windows and off-peak weighting
    cumWeighted: {}, // providerId -> weighted tokens since the ledger began (off-peak discounts applied at record time)
    executions: { single: 0, mixture: 0, swarm: 0 },
    workloads: {}, // workload name -> call count
    workflowStats: {}, // workflow name -> { assigned, followUp, lastAt, lastConf }
    delegations: { single: 0, mixture: 0, swarm: 0, withWorkflow: 0 }, // /route verdicts
    judge: { fresh: 0, cached: 0, errors: 0, backends: {} },
    cascade: { escalations: 0, cold: 0, failed: 0, compared: 0, questions: cascadeQuestions(), disagreements: [] },
    failedRequests: 0,
    recent: [], // newest first, capped
  };
}

export function createUsage({ file, weightOf, priceOf } = {}) {
  const weight = (providerId, ts) => {
    try { return weightOf?.(providerId, ts) ?? 1; } catch { return 1; }
  };
  const state = emptyState();
  let dirty = false;
  let flushTimer = null;

  function touch() {
    dirty = true;
    if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; flush(); }, FLUSH_DEBOUNCE_MS);
    flushTimer.unref?.();
  }

  function modelSlot(key) {
    let m = state.byModel[key];
    if (!m) m = state.byModel[key] = { calls: 0, ok: 0, errors: 0, promptTokens: 0, completionTokens: 0, tokensKnown: 0, lastUsedAt: null };
    return m;
  }

  function daySlot(ts) {
    const day = dayOf(ts);
    let d = state.byDay[day];
    if (!d) d = state.byDay[day] = {};
    return { day, d };
  }

  function prune() {
    const cutoff = Date.now() - KEEP_DAYS * DAY_MS;
    for (const day of Object.keys(state.byDay)) {
      if (new Date(day + "T00:00:00Z").getTime() < cutoff) delete state.byDay[day];
    }
    for (const [pid, hours] of Object.entries(state.hourly)) {
      for (const hourKey of Object.keys(hours)) {
        if (Date.parse(hourKey + ":00:00Z") < cutoff) delete hours[hourKey];
      }
      if (!Object.keys(hours).length) delete state.hourly[pid];
    }
    while (state.recent.length > MAX_RECENT) state.recent.pop();
  }

  /**
   * Record one upstream attempt. `entry`:
   *   { providerId, model, workload, execution, requested, reason, status,
   *     ms, promptTokens, completionTokens, stream, sessionKey, trigger }
   * Tokens may be null when the upstream did not report usage — the call is
   * still counted, with tokensKnown left unincremented. `trigger` is the
   * token class that brought the request ("operator" | "app:<name>") — who
   * spent this. Cost is computed at this single chokepoint from the live
   * price table (declared per provider/model in the roster); it is never
   * estimated — no price declared, no costUsd on the row.
   */
  function record(entry) {
    const ts = Date.now();
    state.bootAt ??= ts;
    state.startedAt ??= ts;

    const providerId = entry.providerId ?? null;
    const model = entry.model ?? null;
    const status = Number.isFinite(entry.status) ? entry.status : null;
    const ok = status !== null && status < 400;
    const hasTokens = Number.isFinite(entry.promptTokens) || Number.isFinite(entry.completionTokens);
    const price = priceOf?.(providerId, model) ?? null;
    const costUsd = price
      ? ((Number.isFinite(entry.promptTokens) ? entry.promptTokens : 0) / 1e6) * price.inputPerM +
        ((Number.isFinite(entry.completionTokens) ? entry.completionTokens : 0) / 1e6) * price.outputPerM
      : null;

    const recent = {
      at: ts,
      requested: entry.requested ?? null,
      workload: entry.workload ?? null,
      execution: entry.execution ?? "single",
      thinking: entry.thinking ?? "auto",
      providerId,
      model,
      status,
      ms: Number.isFinite(entry.ms) ? Math.round(entry.ms) : null,
      promptTokens: Number.isFinite(entry.promptTokens) ? entry.promptTokens : null,
      completionTokens: Number.isFinite(entry.completionTokens) ? entry.completionTokens : null,
      stream: Boolean(entry.stream),
      reason: entry.reason ?? null,
      trigger: entry.trigger ?? null,
      costUsd: costUsd === null ? null : Math.round(costUsd * 1e9) / 1e9,
      costSource: costUsd === null ? null : "price-list",
    };
    state.recent.unshift(recent);

    if (entry.execution && entry.execution in state.executions) state.executions[entry.execution] += 1;
    if (entry.workload) state.workloads[entry.workload] = (state.workloads[entry.workload] ?? 0) + 1;

    if (!providerId || !model) {
      // A request that never reached a concrete model (all mixture proposers
      // failed, unknown upstream) — counted, but with no model row to land on.
      state.failedRequests += 1;
    } else {
      const key = `${providerId}/${model}`;
      const m = modelSlot(key);
      m.calls += 1;
      if (ok) m.ok += 1; else m.errors += 1;
      if (hasTokens) {
        m.tokensKnown += 1;
        m.promptTokens += entry.promptTokens ?? 0;
        m.completionTokens += entry.completionTokens ?? 0;
      }
      m.lastUsedAt = ts;

      const { day, d } = daySlot(ts);
      const slot = d[key] ?? (d[key] = { calls: 0, promptTokens: 0, completionTokens: 0 });
      slot.calls += 1;
      if (hasTokens) {
        slot.promptTokens += entry.promptTokens ?? 0;
        slot.completionTokens += entry.completionTokens ?? 0;
      }
    }

    // Time-series layer: hourly buckets per provider plus a cumulative
    // weighted counter — the numerators for rolling windows, calendar
    // windows, pools, and off-peak-aware quota accounting.
    if (providerId) {
      const hourKey = new Date(ts).toISOString().slice(0, 13);
      const h = (state.hourly[providerId] ??= {});
      const hb = h[hourKey] ?? (h[hourKey] = { calls: 0, tokens: 0 });
      hb.calls += 1;
      const spent = hasTokens ? (entry.promptTokens ?? 0) + (entry.completionTokens ?? 0) : 0;
      hb.tokens += spent;
      state.cumWeighted[providerId] = (state.cumWeighted[providerId] ?? 0) + spent * weight(providerId, ts);
    }

    prune();
    touch();
  }

  /** Delegation verdicts from /route — what the brain decided, per request. */
  function recordDelegation({ workload, execution, workflows }) {
    state.bootAt ??= Date.now();
    const exec = ["single", "mixture", "swarm"].includes(execution) ? execution : "single";
    state.delegations[exec] += 1;
    if (Array.isArray(workflows) && workflows.length > 0) state.delegations.withWorkflow += 1;
    if (workload) state.workloads[workload] = (state.workloads[workload] ?? 0) + 1;
    touch();
  }

  /**
   * Per-workflow assignment outcomes — how often the judge actually handed
   * this workflow a stage. The only place these numbers exist: nothing else
   * can show that a workflow is defined, and the router can show it was picked.
   */
  function recordWorkflowAssignment({ name, stage, conf }) {
    state.bootAt ??= Date.now();
    if (!name) return;
    let s = state.workflowStats[name];
    if (!s) s = state.workflowStats[name] = { assigned: 0, followUp: 0, lastAt: null, lastConf: null };
    if (stage === "followUp") s.followUp += 1;
    else s.assigned += 1;
    s.lastAt = Date.now();
    if (Number.isFinite(conf)) s.lastConf = conf;
    touch();
  }

  /** Judge activity: fresh judgments vs session-cache hits. */
  function recordJudge(kind) {
    state.bootAt ??= Date.now();
    if (kind === "fresh") state.judge.fresh += 1;
    else if (kind === "cached") state.judge.cached += 1;
    else state.judge.errors += 1;
    touch();
  }

  /** Which backend produced the judgment: typesafe / fastino / escalated. */
  function recordJudgeBackend(backend) {
    state.bootAt ??= Date.now();
    state.judge.backends ??= {};
    state.judge.backends[backend] = (state.judge.backends[backend] ?? 0) + 1;
    touch();
  }

  /**
   * Cascade reconciliation: on every escalation TypeSafe answers too, so the
   * two opinions can be compared per question. Measured only on escalations —
   * a biased sample by construction, since escalations are where GLiNER was
   * least confident — and labeled that way wherever it is shown.
   */
  function recordCascadeEscalation({ fast, judged, defaultWorkload }) {
    state.bootAt ??= Date.now();
    state.cascade.escalations += 1;
    if (fast.cold) state.cascade.cold += 1;
    else if (String(fast.reason ?? "").includes("error")) state.cascade.failed += 1;
    const raw = fast.rawVerdict ?? null;
    if (!raw) { touch(); return; }   // cold/failed: no GLiNER opinion to compare
    state.cascade.compared += 1;
    const effWorkload = judged?.workload ?? defaultWorkload ?? null;
    const pairs = [
      ["workload", raw.workload ?? null, fast.workload ?? null, effWorkload],
      ["execution", raw.execution ?? null, fast.execution ?? null, judged?.execution ?? null],
      ["workflow", raw.workflow ?? null, fast.workflow ?? null, judged?.workflow ?? null],
      ["followUp", raw.followUp ?? null, fast.followUp ?? null, judged?.followUp ?? null],
    ];
    for (const [question, fastValue, gateValue, tsValue] of pairs) {
      const slot = state.cascade.questions[question] ?? zq();
      state.cascade.questions[question] = slot;
      if (fastValue == null || tsValue == null) { slot.abstain += 1; continue; }
      if (gateValue == null) { slot.gateRejected += 1; continue; }
      if (String(gateValue) === String(tsValue)) { slot.agree += 1; continue; }
      slot.disagree += 1;
      state.cascade.disagreements.unshift({
        at: Date.now(), question,
        fastino: String(fastValue), typesafe: String(tsValue),
        conf: Number.isFinite(fast.conf) ? fast.conf : null,
      });
    }
    while (state.cascade.disagreements.length > 50) state.cascade.disagreements.pop();
    touch();
  }

  /** Hourly buckets for one provider, oldest first: [{ hourTs, calls, tokens }]. */
  function hourly(providerId) {
    return Object.entries(state.hourly[providerId] ?? {})
      .map(([hourKey, b]) => ({ hourTs: Date.parse(hourKey + ":00:00Z"), calls: b.calls, tokens: b.tokens }))
      .sort((a, b) => a.hourTs - b.hourTs);
  }

  /** Cumulative weighted tokens since the ledger began, for one provider. */
  function cumulativeWeighted(providerId) {
    return state.cumWeighted[providerId] ?? 0;
  }

  function snapshot() {
    const models = Object.entries(state.byModel)
      .map(([key, m]) => ({
        key,
        providerId: key.slice(0, key.indexOf("/")),
        model: key.slice(key.indexOf("/") + 1),
        ...m,
        totalTokens: m.promptTokens + m.completionTokens,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens || b.calls - a.calls);
    const totals = models.reduce(
      (acc, m) => ({
        calls: acc.calls + m.calls,
        ok: acc.ok + m.ok,
        errors: acc.errors + m.errors,
        promptTokens: acc.promptTokens + m.promptTokens,
        completionTokens: acc.completionTokens + m.completionTokens,
        tokensKnown: acc.tokensKnown + m.tokensKnown,
      }),
      { calls: 0, ok: 0, errors: 0, promptTokens: 0, completionTokens: 0, tokensKnown: 0 },
    );
    const days = Object.entries(state.byDay)
      .map(([day, byModel]) => {
        const agg = { calls: 0, promptTokens: 0, completionTokens: 0, models: {} };
        for (const [key, s] of Object.entries(byModel)) {
          agg.calls += s.calls;
          agg.promptTokens += s.promptTokens;
          agg.completionTokens += s.completionTokens;
          agg.models[key] = s;
        }
        return { day, ...agg };
      })
      .sort((a, b) => (a.day < b.day ? 1 : -1))
      .slice(0, 14);
    return {
      startedAt: state.startedAt,
      bootAt: state.bootAt,
      generatedAt: Date.now(),
      totals: { ...totals, failedRequests: state.failedRequests, totalTokens: totals.promptTokens + totals.completionTokens },
      models,
      days,
      executions: { ...state.executions },
      workloads: { ...state.workloads },
      workflowStats: { ...state.workflowStats },
      delegations: { ...state.delegations },
      judge: { ...state.judge },
      cascade: { ...state.cascade, disagreements: state.cascade.disagreements.slice(0, 20) },
      recent: state.recent.slice(0, 100),
    };
  }

  function reset() {
    const kept = { startedAt: state.startedAt };
    Object.assign(state, emptyState(), kept);
    touch();
    flush();
  }

  function flush() {
    if (!dirty && state.bootAt) return;
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeFileAtomic(file, JSON.stringify(state, null, 1) + "\n");
      dirty = false;
    } catch {}
  }

  function load() {
    if (!file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!raw || typeof raw !== "object") return;
      for (const k of ["startedAt", "byModel", "byDay", "hourly", "cumWeighted", "executions", "workloads", "workflowStats", "delegations", "judge", "cascade", "failedRequests", "recent"]) {
        if (raw[k] === undefined) continue;
        // judge gained fields over time (backends) — merge so a ledger written
        // by an older router does not wipe new counters.
        if (k === "judge") state.judge = { ...state.judge, ...raw.judge };
        else if (k === "cascade") {
          const def = emptyState().cascade;
          state.cascade = { ...def, ...raw.cascade, questions: { ...def.questions, ...(raw.cascade.questions ?? {}) }, disagreements: raw.cascade.disagreements ?? [] };
        }
        else state[k] = raw[k];
      }
      state.judge.backends ??= {};
      state.cascade.questions ??= cascadeQuestions();
      state.bootAt = Date.now();
      prune();
    } catch {}
  }

  load();

  return { record, recordDelegation, recordWorkflowAssignment, recordJudge, recordJudgeBackend, recordCascadeEscalation, snapshot, reset, flush, hourly, cumulativeWeighted };
}

/**
 * Pass-through SSE tap: forwards every byte untouched while scanning
 * complete `data:` lines for a usage object, so a streaming response can be
 * metered without altering what the client receives. Lines split across
 * chunk boundaries are buffered until they complete.
 */
export function sseUsageTap(onUsage) {
  let buf = "";
  const scan = (line) => {
    const t = line.trim();
    if (!t.startsWith("data:")) return;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]" || !payload.includes('"usage"')) return;
    try {
      const obj = JSON.parse(payload);
      if (obj && typeof obj.usage === "object" && obj.usage) onUsage(obj.usage, obj.model ?? null);
    } catch {}
  };
  return new Transform({
    transform(chunk, _enc, cb) {
      buf += chunk.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        scan(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
      if (buf.length > 1 << 20) buf = ""; // pathological: no newline in 1MiB
      cb(null, chunk);
    },
    flush(cb) {
      if (buf) scan(buf);
      cb();
    },
  });
}
