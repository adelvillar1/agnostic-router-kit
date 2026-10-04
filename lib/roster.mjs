/**
 * Roster loading, validation, and resolution.
 *
 * The roster is the machine-local source of truth for WHICH plans exist
 * (and which keys resolve). Resolution turns abstract tier names into
 * concrete provider/model pairs, applying per-tier fallbacks and refusing
 * pay-per-token targets unless explicitly allowed — that is how the same
 * roster file installs cleanly on a machine that is missing a plan.
 */
import fs from "node:fs";
import { ROSTER_VERSION } from "./paths.mjs";

export function loadRoster(rosterPath) {
  if (!rosterPath || !fs.existsSync(rosterPath)) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(rosterPath, "utf8"));
  } catch (e) {
    throw new Error(`roster is not valid JSON (${rosterPath}): ${e.message}`);
  }
  const errs = validateRoster(raw);
  if (errs.length) throw new Error(`roster at ${rosterPath} is not usable:\n  - ${errs.join("\n  - ")}`);
  return raw;
}

/** Validate a provider's quota declaration. Empty verdict = usable or absent. */
function quotaProblems(pid, q) {
  if (q === undefined || q === null) return [];
  const errs = [];
  if (typeof q !== "object") return [`providers.${pid}.quota: must be an object`];
  if (!["pool", "calendar", "rolling"].includes(q.kind)) errs.push(`providers.${pid}.quota.kind: "pool" | "calendar" | "rolling"`);
  if (q.kind === "rolling" && (!Number.isFinite(q.windowHours) || q.windowHours < 1)) errs.push(`providers.${pid}.quota.windowHours: required for rolling (hours in the window)`);
  if (q.kind === "pool" && !q.start) errs.push(`providers.${pid}.quota.start: required for pool (the date the plan was provisioned)`);
  const reads = q.calibration?.reads;
  if (reads !== undefined) {
    if (!Array.isArray(reads)) errs.push(`providers.${pid}.quota.calibration.reads: must be an array`);
    else for (const r of reads) {
      if (!r || typeof r.date !== "string" || !r.date) errs.push(`providers.${pid}.quota.calibration.reads: each read needs a date`);
      else if (!Number.isFinite(r.pct) || r.pct < 0 || r.pct > 100) errs.push(`providers.${pid}.quota.calibration.reads: pct must be 0-100`);
    }
  }
  if (q.allowance !== undefined && (!Number.isFinite(q.allowance) || q.allowance <= 0)) errs.push(`providers.${pid}.quota.allowance: must be a positive number`);
  const op = q.offpeak;
  if (op !== undefined && op !== null) {
    if (typeof op !== "object") errs.push(`providers.${pid}.quota.offpeak: must be an object`);
    else {
      if (!/^\d{2}:\d{2}$/.test(op.from ?? "") || !/^\d{2}:\d{2}$/.test(op.to ?? "")) errs.push(`providers.${pid}.quota.offpeak.from/to: "HH:MM" required`);
      if (!Number.isFinite(op.weight) || op.weight < 0 || op.weight > 1) errs.push(`providers.${pid}.quota.offpeak.weight: 0-1 (fraction of a peak unit)`);
    }
  }
  return errs;
}

export function validateRoster(r) {
  const errs = [];
  if (!r || typeof r !== "object") return ["roster must be a JSON object"];
  if (r.version !== ROSTER_VERSION) errs.push(`version must be ${ROSTER_VERSION} (got ${JSON.stringify(r.version)})`);
  const provs = r.providers;
  if (!provs || typeof provs !== "object" || !Object.keys(provs).length) {
    errs.push("providers: needs at least one provider definition");
  } else {
    for (const [id, p] of Object.entries(provs)) {
      if (!p || typeof p !== "object") { errs.push(`providers.${id}: must be an object`); continue; }
      const hasKey = p.apiKey || p.apiKeyEnv;
      const hasEndpoint = p.baseUrl || p.templateId;
      if (p.routerOnly && !(p.baseUrl && p.apiKeyEnv)) errs.push(`providers.${id}: routerOnly providers need baseUrl + apiKeyEnv`);
      else if (!p.routerOnly && !hasKey) errs.push(`providers.${id}: needs apiKey or apiKeyEnv`);
      else if (!p.routerOnly && !hasEndpoint) errs.push(`providers.${id}: needs baseUrl or templateId`);
      if (p.register !== false && !p.routerOnly && !Array.isArray(p.models)) errs.push(`providers.${id}: needs models[] (the picker's model list)`);
      if (p.billing && !["plan", "payg"].includes(p.billing)) errs.push(`providers.${id}: billing must be "plan" or "payg"`);
      errs.push(...quotaProblems(id, p.quota));
    }
  }
  const tiers = r.tiers;
  if (!tiers || typeof tiers !== "object" || !Object.keys(tiers).length) {
    errs.push("tiers: needs at least one workload tier");
  } else {
    for (const [name, t] of Object.entries(tiers)) {
      if (!t || typeof t.target !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(t.target)) {
        errs.push(`tiers.${name}: target must be "providerId/modelId"`);
      }
      for (const fb of t.fallbacks ?? []) {
        if (typeof fb !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(fb)) errs.push(`tiers.${name}.fallbacks: "${fb}" must be "providerId/modelId"`);
      }
    }
    if (r.routing?.defaultWorkload && !(r.routing.defaultWorkload in tiers)) {
      errs.push(`routing.defaultWorkload "${r.routing.defaultWorkload}" is not a tier`);
    }
  }
  // Optional declared model strength (1–5), consumed by the suggester. Keys
  // are "providerId/modelId" targets so a suggestion can rank quality.
  if (r.strength !== undefined) {
    if (!r.strength || typeof r.strength !== "object" || Array.isArray(r.strength)) {
      errs.push('strength: must be an object of "providerId/modelId" → 1..5');
    } else {
      for (const [k, v] of Object.entries(r.strength)) {
        if (k === "note") continue; // documentation key, same as providers
        if (!Number.isFinite(v) || v < 1 || v > 5) errs.push(`strength["${k}"]: must be a number 1..5 (got ${JSON.stringify(v)})`);
        if (!/^[^/\s]+\/[^/\s]+$/.test(k)) errs.push(`strength["${k}"]: key must be "providerId/modelId"`);
      }
    }
  }
  const profiles = r.profiles;
  if (!profiles || typeof profiles !== "object" || !Object.keys(profiles).length) {
    errs.push("profiles: needs at least one picker profile");  } else {
    for (const [id, p] of Object.entries(profiles)) {
      if (!p || typeof p !== "object") { errs.push(`profiles.${id}: must be an object`); continue; }
      if (p.workload && !(p.workload in tiers)) errs.push(`profiles.${id}.workload "${p.workload}" is not a tier`);
      if (!p.workload && !["omniModel", "mixture"].includes(p.use)) errs.push(`profiles.${id}: needs workload: <tier> or use: omniModel|mixture`);
      if (p.thinking !== undefined && !["off", "auto", "deep"].includes(p.thinking)) errs.push(`profiles.${id}.thinking: must be "off" | "auto" | "deep"`);
    }
  }
  if (r.judge !== undefined) {
    const j = r.judge;
    if (!j || typeof j !== "object" || Array.isArray(j)) errs.push("judge: must be an object");
    else {
      if (j.mode !== undefined && !["typesafe", "fastino", "cascade"].includes(j.mode)) errs.push(`judge.mode: must be "typesafe" | "fastino" | "cascade"`);
      if (j.fastino !== undefined && j.fastino !== null) {
        if (typeof j.fastino !== "object" || Array.isArray(j.fastino)) errs.push("judge.fastino: must be an object");
        else {
          if (j.fastino.model !== undefined && typeof j.fastino.model !== "string") errs.push("judge.fastino.model: must be a string");
          if (j.fastino.apiKeyEnv !== undefined && typeof j.fastino.apiKeyEnv !== "string") errs.push("judge.fastino.apiKeyEnv: must be a string");
          if (j.fastino.baseUrl !== undefined && typeof j.fastino.baseUrl !== "string") errs.push("judge.fastino.baseUrl: must be a string");
          if (j.fastino.timeoutMs !== undefined && (!Number.isFinite(j.fastino.timeoutMs) || j.fastino.timeoutMs < 100)) errs.push("judge.fastino.timeoutMs: must be >= 100");
        }
      }
    }
  }
  if (r.routing?.thinkingStyles !== undefined) {
    const tsMap = r.routing.thinkingStyles;
    if (!tsMap || typeof tsMap !== "object" || Array.isArray(tsMap)) errs.push("routing.thinkingStyles: must be an object of providerId → style");
    else for (const [k, v] of Object.entries(tsMap)) {
      if (k === "note") continue; // documentation key, same as providers
      if (!["thinking", "enable_thinking", "reasoning_effort", "none"].includes(v)) errs.push(`routing.thinkingStyles["${k}"]: unknown style "${v}"`);
    }
  }
  // Single-target fields accept an ordered candidate list just like tiers do:
  // a machine missing the preferred plan should degrade, not go dark.
  const targetOk = (v) => typeof v === "string" && /^[^/\s]+\/[^/\s]+$/.test(v);
  const candidatesOk = (v) => {
    const list = Array.isArray(v) ? v : [v];
    return list.length > 0 && list.every(targetOk);
  };
  for (const key of ["omniModel", "wideModel"]) {
    if (!candidatesOk(r[key])) errs.push(`${key} must be "providerId/modelId" or an ordered list of them (first is preferred)`);
  }
  if (!r.mixture || !Array.isArray(r.mixture.proposers) || !r.mixture.proposers.length) errs.push("mixture.proposers: needs at least one target");
  if (!candidatesOk(r.mixture?.aggregator)) errs.push(`mixture.aggregator: must be "providerId/modelId" or an ordered list of them (first is preferred)`);
  if (!r.routing || typeof r.routing !== "object") errs.push("routing: thresholds object required");
  if (!r.typesafe?.apiKeyEnv) errs.push("typesafe.apiKeyEnv: name of the TypeSafe key env var required");
  if (r.workflows && typeof r.workflows !== "object") errs.push("workflows: must be an object");
  return errs;
}

/** providerId/modelId → { providerId, model } or null. */
export function parseTarget(t) {
  if (typeof t !== "string") return null;
  const i = t.indexOf("/");
  if (i < 1 || i === t.length - 1 || t.includes(" ", i)) return null;
  return { providerId: t.slice(0, i), model: t.slice(i + 1) };
}

/**
 * Resolve providers against available keys. A provider is usable only when
 * it is enabled AND its key resolves (roster apiKey, or the apiKeyEnv var
 * from the process env or the runtime .env).
 */
export function resolveProviders(roster, { env = process.env, envFile = {} } = {}) {
  const out = {};
  for (const [id, p] of Object.entries(roster.providers)) {
    const apiKey = p.apiKey ?? (p.apiKeyEnv ? (env[p.apiKeyEnv] ?? envFile[p.apiKeyEnv]) : null) ?? null;
    out[id] = {
      id,
      def: p,
      enabled: p.enabled !== false,
      hasKey: Boolean(apiKey),
      apiKey: apiKey || null,
      billing: p.billing ?? "plan",
      routerOnly: Boolean(p.routerOnly),
      usable: p.enabled !== false && Boolean(apiKey),
      rawKeyWarning: Boolean(p.apiKey),
    };
  }
  return out;
}

/** Can this specific target be used as a routing target? */
export function resolveTarget(target, providers, { allowPayg = false } = {}) {
  const p = parseTarget(target);
  if (!p) return { ok: false, reason: `malformed target "${target}" (want providerId/modelId)` };
  const prov = providers[p.providerId];
  if (!prov) return { ok: false, reason: `provider "${p.providerId}" is not in the roster` };
  if (!prov.enabled) return { ok: false, reason: `provider "${p.providerId}" is disabled` };
  if (!prov.hasKey) return { ok: false, reason: `provider "${p.providerId}" has no key (${prov.def.apiKeyEnv ?? "none"} unresolved)` };
  if (prov.billing === "payg" && !allowPayg) return { ok: false, reason: `provider "${p.providerId}" bills per token (set tiers.${"…"}.allowPayg to use it anyway)` };
  return { ok: true, providerId: p.providerId, model: p.model };
}

/**
 * Resolve one tier through its fallback chain; report every remap. Returns
 * the resolved winner AND the full usable chain in preference order — the
 * router needs the whole chain at runtime for quota-aware steering, which is
 * a decision the apply-time resolver cannot make (headroom moves hourly).
 */
export function resolveTier(name, tier, providers, allowPayg) {
  const remaps = [];
  const attempts = [tier.target, ...(tier.fallbacks ?? [])];
  const usable = [];
  let winner = null;
  for (const t of attempts) {
    const r = resolveTarget(t, providers, { allowPayg });
    if (!r.ok) continue;
    usable.push(r);
    if (!winner) {
      winner = r;
      if (t !== tier.target) remaps.push({ kind: "tier", name, from: tier.target, to: t, skippedReason: null });
    }
  }
  if (!winner) {
    const first = resolveTarget(tier.target, providers, { allowPayg });
    return { target: null, usable: [], remaps, ok: false, reason: first.reason };
  }
  return { target: winner, usable, remaps, ok: true };
}

/** Full resolution pass: what maps where on THIS machine, right now. */
export function resolveRoster(roster, { env = process.env, envFile = {} } = {}) {
  const allowPayg = Boolean(roster.allowPayg);
  const providers = resolveProviders(roster, { env, envFile });
  const workloads = {};
  const chains = {};
  const remaps = [];
  const problems = [];
  for (const [name, tier] of Object.entries(roster.tiers)) {
    const r = resolveTier(name, tier, providers, allowPayg);
    if (r.ok) {
      workloads[name] = { providerId: r.target.providerId, model: r.target.model };
      chains[name] = r.usable.map((t) => ({ providerId: t.providerId, model: t.model }));
    } else problems.push(`tier "${name}" has no usable target: ${r.reason}`);
    remaps.push(...r.remaps);
  }
  // Ordered candidates for the single-target fields; the first usable wins and
  // any move off the preferred one is reported as a remap.
  const resolveChain = (v, label) => {
    const list = Array.isArray(v) ? v : [v];
    const usable = [];
    let firstIdx = -1;
    for (let i = 0; i < list.length; i++) {
      const r = resolveTarget(list[i], providers, { allowPayg });
      if (!r.ok) continue;
      if (firstIdx < 0) {
        firstIdx = i;
        if (i > 0) remaps.push({ kind: "target", name: label, from: list[0], to: list[i], skippedReason: null });
      }
      usable.push({ providerId: r.providerId, model: r.model });
    }
    if (firstIdx < 0) {
      const why = resolveTarget(list[0], providers, { allowPayg }).reason;
      problems.push(
        list.length > 1
          ? `${label}: no usable target (preferred "${list[0]}": ${why})`
          : `${label} "${list[0]}" is unusable: ${why}`,
      );
      return null;
    }
    return { first: usable[0], chain: usable };
  };
  const omni = resolveChain(roster.omniModel, "omniModel");
  const wide = resolveChain(roster.wideModel, "wideModel");
  const omniModel = omni?.first ?? null;
  const wideModel = wide?.first ?? null;
  const proposers = [];
  for (const p of roster.mixture.proposers) {
    const r = resolveTarget(p, providers, { allowPayg });
    if (r.ok) proposers.push({ providerId: r.providerId, model: r.model });
    else remaps.push({ kind: "mixture-proposer", name: "mixture", from: p, to: null, skippedReason: r.reason });
  }
  const aggregator = resolveChain(roster.mixture.aggregator, "mixture.aggregator")?.first ?? null;
  if (!proposers.length) problems.push("mixture: no usable proposers — mixture routing degrades to single answers");

  const defaultWorkload =
    roster.routing?.defaultWorkload && workloads[roster.routing.defaultWorkload]
      ? roster.routing.defaultWorkload
      : Object.keys(workloads)[0] ?? null;
  if (!defaultWorkload) problems.push("no resolvable tier exists at all — the router cannot route anything");

  const envMissing = [];
  for (const p of Object.values(providers)) {
    if ((p.routerOnly || p.enabled) && p.def.apiKeyEnv && !p.hasKey) envMissing.push(p.def.apiKeyEnv);
  }

  return { providers, workloads, chains, omniModel, wideModel, omniChain: omni?.chain ?? null, wideChain: wide?.chain ?? null, proposers, aggregator, defaultWorkload, remaps, problems, envMissing };
}
