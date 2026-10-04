/**
 * Delegation-distribution suggestions.
 *
 * Given the roster's models, propose which one should serve each workload
 * tier, which should form the capability chains, and which should be the
 * mixture proposers/aggregator — with a stated reason per decision and a
 * confidence level that says how much data the ranking rests on.
 *
 * Deliberately a deterministic scorer, not a model call: every input is
 * either measured by the ledger (recent latency, error rate), declared in
 * the roster (context window, multimodal support, optional 1–5 `strength`),
 * or derived from quota calibration (headroom). Weights are fixed and
 * published in the rationale. What this cannot know is benchmark quality —
 * that is exactly what `strength` is for, and where it is absent the
 * rationale says the ranking rests on declared fields alone. Suggestions
 * never touch tier names, profiles, or the workflow registry — only which
 * model serves which role.
 */

const norm = (v, max) => (max > 0 ? Math.min(1, Math.max(0, v / max)) : 0);
const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// Published scoring objectives per tier. Low latency beats high context for
// quick; strength and context dominate hard/deep_context.
const OBJECTIVES = {
  quick: { weights: { latency: 0.5, headroom: 0.2, err: 0.2, strength: 0.1 }, why: "lowest recent latency" },
  standard_code: { weights: { latency: 0.3, err: 0.25, strength: 0.25, headroom: 0.2 }, why: "balanced latency, error rate and strength" },
  hard: { weights: { strength: 0.45, ctx: 0.2, err: 0.15, headroom: 0.1, latency: 0.1 }, why: "strongest model available" },
  prose: { weights: { latency: 0.35, strength: 0.25, headroom: 0.2, err: 0.2 }, why: "fast and fluent" },
  deep_context: { weights: { ctx: 0.55, strength: 0.2, headroom: 0.15, err: 0.1 }, why: "largest usable context" },
};

export function suggestDelegation({ roster, envMap = {}, snapshot, quota, routedModels = {}, now = Date.now() } = {}) {
  const notes = [];
  const allowPayg = Boolean(roster?.allowPayg);
  const strength = roster?.strength && typeof roster.strength === "object" ? roster.strength : {};

  // Declared model properties from the roster's manual model rules.
  const props = {};
  for (const rule of roster?.manualModelRules ?? []) {
    const pr = rule?.config?.properties ?? {};
    props[`${rule.providerId ?? ""}/${rule.modelId ?? ""}`] = {
      ctx: Number.isFinite(pr.contextWindow) ? pr.contextWindow : null,
      image: Boolean(pr.inputFormat?.supportsImage),
      video: Boolean(pr.inputFormat?.supportsVideo),
    };
  }

  // Usable pool: enabled, non-payg (unless allowed), key resolved.
  const pool = [];
  for (const [pid, p] of Object.entries(roster?.providers ?? {})) {
    if (p?.enabled === false) continue;
    if ((p.billing ?? "plan") === "payg" && !allowPayg) continue;
    const hasKey = p.apiKey ? true : p.apiKeyEnv ? Boolean(envMap[p.apiKeyEnv]) : false;
    if (!hasKey) {
      notes.push(`${pid}: key "${p.apiKeyEnv ?? "?"}" unresolved — excluded from suggestions`);
      continue;
    }
    // Router-only providers route via tiers, not via a client's model picker,
    // so their models[] may be empty — the routed pairs from config name what they serve.
    const models = (p.models?.length ? p.models : routedModels[pid]) ?? [];
    for (const m of models) {
      const key = `${pid}/${m}`;
      const pr = props[key] ?? {};
      const q = quota?.[pid];
      pool.push({
        key,
        providerId: pid,
        model: m,
        ctx: Number.isFinite(pr.ctx) ? pr.ctx : null,
        image: pr.image ?? false,
        video: pr.video ?? false,
        strength: Number.isFinite(strength[key]) ? strength[key] : 3,
        headroom: q && Number.isFinite(q.headroom) ? q.headroom : null,
        exhausted: Boolean(q && Number.isFinite(q.headroom) && q.headroom <= 0.05),
        latencyMs: null,
        errRate: null,
        calls: 0,
      });
    }
  }
  if (!pool.length) {
    return { ok: false, notes: ["no usable models in the roster — nothing to suggest"], basis: { recentRequests: 0, modelsScored: 0 } };
  }

  // Measured latency + error rate from the recent-request ring (last ~100).
  const agg = {};
  for (const r of snapshot?.recent ?? []) {
    const key = `${r.providerId}/${r.model}`;
    const a = (agg[key] ??= { mss: [], err: 0, calls: 0 });
    if (Number.isFinite(r.ms)) a.mss.push(r.ms);
    a.calls += 1;
    if (r.status == null || r.status >= 400) a.err += 1;
  }
  for (const c of pool) {
    const a = agg[c.key];
    if (!a) continue;
    c.latencyMs = median(a.mss);
    c.errRate = a.calls ? a.err / a.calls : 0;
    c.calls = a.calls;
  }

  const maxCtx = Math.max(...pool.map((c) => c.ctx ?? 0), 1);
  const latencies = pool.map((c) => c.latencyMs).filter(Number.isFinite);
  const maxLat = latencies.length ? Math.max(...latencies) : null;

  const score = (c, weights) => {
    let sum = 0;
    let total = 0;
    for (const [k, weight] of Object.entries(weights)) {
      let part = 0.5; // unknown sub-scores sit at neutral
      if (k === "latency") part = c.latencyMs == null || maxLat == null ? 0.5 : 1 - norm(c.latencyMs, maxLat);
      else if (k === "ctx") part = c.ctx == null ? 0.4 : norm(c.ctx, maxCtx);
      else if (k === "headroom") part = c.headroom == null ? 0.5 : c.headroom;
      else if (k === "strength") part = (c.strength - 1) / 4;
      else if (k === "err") part = c.errRate == null ? 1 : 1 - Math.min(1, c.errRate);
      sum += weight * part;
      total += weight;
    }
    return total ? sum / total : 0;
  };

  const describe = (c) => {
    const bits = [
      c.strength !== 3 ? `strength ${c.strength}/5` : null,
      c.ctx ? `${Math.round(c.ctx / 1000)}k ctx` : null,
      c.latencyMs != null ? `${(c.latencyMs / 1000).toFixed(1)}s p50` : null,
      c.headroom != null ? `${Math.round(c.headroom * 100)}% headroom` : null,
    ].filter(Boolean);
    return `${c.key}${bits.length ? ` (${bits.join(", ")})` : ""}`;
  };

  // ── tiers ────────────────────────────────────────────────────────────────
  const suggestedTiers = {};
  let suggestedOmni = null;
  let suggestedWide = null;
  let suggestedMixture = null;
  const rationale = {};
  const confidence = {};

  for (const tierName of Object.keys(roster?.tiers ?? {})) {
    const obj = OBJECTIVES[tierName] ?? OBJECTIVES.standard_code;
    let candidates = pool;
    if (tierName === "deep_context") {
      const floor = Math.round(maxCtx * 0.5);
      const passing = pool.filter((c) => c.ctx != null && c.ctx >= floor);
      if (passing.length) candidates = passing;
      else notes.push("deep_context: no model declares a context window — ranked without a floor");
    }
    const ranked = [...candidates].sort((a, b) => score(b, obj.weights) - score(a, obj.weights) || b.calls - a.calls);
    const best = ranked[0];
    if (!best) {
      notes.push(`${tierName}: no candidate passed the capability floor — tier left as-is`);
      continue;
    }
    // Fallbacks: best score first, but a plan that is effectively exhausted
    // drops to the end — quality order is pointless if the first hop 429s.
    const fallbacks = ranked
      .slice(1)
      .sort((a, b) => (a.exhausted ? 1 : 0) - (b.exhausted ? 1 : 0) || score(b, obj.weights) - score(a, obj.weights))
      .map((c) => c.key);
    suggestedTiers[tierName] = { target: best.key, fallbacks };
    const measured = ranked.filter((c) => c.calls >= 10).length;
    confidence[`tiers.${tierName}`] = measured >= 3 ? "high" : measured >= 1 ? "medium" : "low";
    rationale[`tiers.${tierName}`] =
      `→ ${describe(best)}: ${obj.why}` +
      (ranked[1] ? ` · next: ${describe(ranked[1])}` : "") +
      ` · ${candidates.length} candidate(s) scored by ${Object.entries(obj.weights).map(([k, w]) => `${k}×${w}`).join(", ")}` +
      (measured === 0 ? " · no recent call data — ranking rests on declared fields only" : "");
  }

  // ── capability chains ────────────────────────────────────────────────────
  const omniChain = pool
    .filter((c) => c.image || c.video)
    .sort((a, b) => b.strength - a.strength || (b.ctx ?? 0) - (a.ctx ?? 0))
    .map((c) => c.key);
  if (omniChain.length) {
    suggestedOmni = omniChain;
    rationale.omniModel = `image/video-capable models ordered by strength: ${omniChain.map(describe).join("; ")}`;
    confidence.omniModel = omniChain.length >= 2 ? "high" : "low";
  } else {
    notes.push("no model declares multimodal input — omniModel left as-is");
  }

  const wideChain = pool
    .filter((c) => c.ctx != null)
    .sort((a, b) => (b.ctx ?? 0) - (a.ctx ?? 0) || b.strength - a.strength)
    .slice(0, 3)
    .map((c) => c.key);
  if (wideChain.length) {
    suggestedWide = wideChain;
    rationale.wideModel = `largest declared context windows: ${wideChain.map((k) => `${k} (${Math.round((props[k]?.ctx ?? 0) / 1000)}k)`).join(", ")}`;
    confidence.wideModel = "high";
  } else {
    notes.push("no model declares a context window — wideModel left as-is");
  }

  // ── mixture: distinct plans so errors don't correlate ────────────────────
  const proposerPool = pool.filter((c) => !c.exhausted && (c.ctx == null || c.ctx >= 32_000));
  const byProvider = new Map();
  const proposerWeights = { strength: 0.4, err: 0.25, ctx: 0.15, headroom: 0.2 };
  for (const c of [...proposerPool].sort((a, b) => score(b, proposerWeights) - score(a, proposerWeights))) {
    if (!byProvider.has(c.providerId)) byProvider.set(c.providerId, c);
  }
  const proposers = [...byProvider.values()].slice(0, 3);
  if (proposers.length >= 2) {
    suggestedMixture = { proposers: proposers.map((c) => c.key), aggregator: proposers[0].key };
    rationale.mixture =
      `proposers from distinct providers (independent failure modes): ${proposers.map(describe).join("; ")}` +
      ` · aggregator: the strongest scorer of the pool (${describe(proposers[0])})`;
    confidence.mixture = proposerPool.some((c) => c.calls >= 10) ? "medium" : "low";
  } else {
    notes.push("fewer than two usable providers — mixture left as-is");
  }

  // ── current, for the diff ────────────────────────────────────────────────
  const asChain = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const current = {
    tiers: Object.fromEntries(
      Object.entries(roster?.tiers ?? {}).map(([name, t]) => [name, { target: t?.target ?? null, fallbacks: t?.fallbacks ?? [] }]),
    ),
    omniModel: asChain(roster?.omniModel),
    wideModel: asChain(roster?.wideModel),
    mixture: roster?.mixture ? { proposers: roster.mixture.proposers ?? [], aggregator: asChain(roster.mixture.aggregator)[0] ?? null } : { proposers: [], aggregator: null },
  };

  const perModel = Object.fromEntries(
    pool.map((c) => [
      c.key,
      {
        calls: c.calls,
        latencyMs: c.latencyMs,
        errRate: c.errRate == null ? null : Math.round(c.errRate * 100) / 100,
        strength: c.strength,
        ctx: c.ctx,
        headroom: c.headroom == null ? null : Math.round(c.headroom * 100) / 100,
      },
    ]),
  );

  return {
    ok: true,
    generatedAt: now,
    suggested: { tiers: suggestedTiers, omniModel: suggestedOmni, wideModel: suggestedWide, mixture: suggestedMixture },
    current,
    rationale,
    confidence,
    notes,
    basis: {
      recentRequests: snapshot?.recent?.length ?? 0,
      modelsScored: pool.length,
      perModel,
      objectives: Object.fromEntries(Object.entries(OBJECTIVES).map(([k, o]) => [k, { weights: o.weights, why: o.why }])),
    },
  };
}
