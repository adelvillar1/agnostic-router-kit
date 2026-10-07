/**
 * Roster → router config.json. The router's own config is fully generated:
 * everything in it is a consequence of the roster, so hand-edits would be
 * overwritten and live only in the roster.
 *
 * One contract with server.js: every provider the roster declares arrives as
 * an extraUpstream with its key as an env-var NAME (never a value) — the
 * router resolves the values from its own .env at request time. That is what
 * keeps the agnostic edition harness-neutral: no harness's config file is
 * read at any point, and the roster never carries a raw key.
 */
import { ENV_FILE, KIT_DIR, ROSTER_PATH, tilde } from "./paths.mjs";

export function renderRouterConfig(roster, resolved, registry, { port, localToken, library } = {}) {
  const routing = roster.routing ?? {};
  // Capability facts from the roster's manualModelRules (optional properties:
  // supportsImages, supportsTools, contextWindow). Undeclared stays null —
  // the neutrality law: a model that declares nothing is never gated, the
  // same way a quota-less provider is never steered against.
  const capsByModel = {};
  for (const rule of Array.isArray(roster.manualModelRules) ? roster.manualModelRules : []) {
    const id = rule?.modelId;
    const p = rule?.config?.properties ?? {};
    if (!id) continue;
    const caps = {};
    if (typeof p.supportsImages === "boolean") caps.images = p.supportsImages;
    if (typeof p.supportsTools === "boolean") caps.tools = p.supportsTools;
    if (Number.isFinite(p.contextWindow)) caps.ctxWindow = p.contextWindow;
    if (Object.keys(caps).length) capsByModel[id] = caps;
  }
  const withCaps = (c) => (capsByModel[c.model] ? { ...c, caps: capsByModel[c.model] } : c);
  // Declared prices → a flat model-keyed table the router's ledger reads live
  // at record time. Per-provider `pricing` covers its models; per-provider
  // `pricingByModel` overrides per model. No price declared → no cost on the
  // row (cost is never estimated, like tokens).
  const pricing = {};
  for (const [id, p] of Object.entries(roster.providers ?? {})) {
    const base = p.pricing && Number.isFinite(p.pricing.inputPerM) && Number.isFinite(p.pricing.outputPerM) ? p.pricing : null;
    for (const m of p.models ?? []) {
      const v = p.pricingByModel?.[m] ?? base;
      if (v && Number.isFinite(v.inputPerM) && Number.isFinite(v.outputPerM)) pricing[m] = v;
    }
  }
  const cfg = {
    port: port ?? roster.router?.port ?? 8300,
    localToken: localToken ?? roster.router?.localToken ?? "local-auto-router",
    typesafeEnvFile: tilde(ENV_FILE),
    // Where the roster and the kit CLI live, so the router's dashboard can
    // read the roster and run save-and-apply through the kit's own pipeline.
    kitRoot: tilde(KIT_DIR),
    rosterPath: tilde(ROSTER_PATH),
    typesafeModel: roster.typesafe?.model ?? "jev-1.13.0",
    judge: {
      mode: roster.judge?.mode ?? "typesafe",
      fastino: roster.judge?.fastino ?? null,
    },
    ttlHours: roster.typesafe?.ttlHours ?? routing.ttlHours ?? 6,
    routing: {
      wideChars: routing.wideChars ?? 1000000,
      minConfidence: routing.minConfidence ?? 0.6,
      workflowMinConfidence: routing.workflowMinConfidence ?? 0.4,
      omniModel: resolved.omniModel && { ...resolved.omniModel, candidates: (resolved.omniChain ?? [resolved.omniModel]).map(withCaps) },
      wideModel: resolved.wideModel && { ...resolved.wideModel, candidates: (resolved.wideChain ?? [resolved.wideModel]).map(withCaps) },
      workloads: Object.fromEntries(
        Object.entries(resolved.workloads).map(([name, t]) => [
          name,
          // candidates: the tier's whole usable chain, in roster preference
          // order — the raw material for the router's quota-aware steering.
          // Each candidate carries its declared caps so the walk can refuse
          // a fallback that would silently drop a capability the request
          // carries.
          { ...t, candidates: (resolved.chains?.[name] ?? [t]).map(withCaps) },
        ])
      ),
      defaultWorkload: resolved.defaultWorkload,
      // providerId → param dialect for the thinking policy ("thinking" |
      // "enable_thinking" | "reasoning_effort" | "none")
      thinkingStyles: roster.routing?.thinkingStyles ?? {},
      profiles: roster.profiles,
      mixture: {
        proposers: resolved.proposers,
        aggregator: resolved.aggregator,
        proposerTimeoutMs: roster.mixture.proposerTimeoutMs ?? 240000,
      },
      // The swarm's worker/integrator override, when the roster declares one.
      // Absent → the router's swarm builds its pool from the judged tier and
      // the mixture proposers.
      ...(resolved.swarm ? { swarm: resolved.swarm } : {}),
      workflows: registry,
      ...(Object.keys(capsByModel).length ? { capsByModel } : {}),
    },
    ...(Object.keys(pricing).length ? { pricing } : {}),
  };
  // Every provider is an extraUpstream: baseUrl from the roster, key by env-var
  // name from the roster, value from the router .env at request time.
  const extraUpstreams = {};
  for (const [id, p] of Object.entries(roster.providers)) {
    if (!p.baseUrl || !p.apiKeyEnv) continue; // declared but not usable as an upstream
    extraUpstreams[id] = { baseUrl: p.baseUrl.replace(/\/+$/, ""), apiKeyEnv: p.apiKeyEnv };
  }
  if (Object.keys(extraUpstreams).length) cfg.extraUpstreams = extraUpstreams;
  // Applications that may spawn workflow runs over the run API. Each app is an
  // explicit roster row — name, its own bearer token, the grant ceiling its
  // spawns are enforced against, and an optional workspace root. The plane
  // enforces the ceiling and the sandbox at spawn time; a token's blast
  // radius is its ceiling, which is the point of ceilings.
  const apps = (Array.isArray(roster.router?.apps) ? roster.router.apps : [])
    .map((a) => ({
      name: String(a?.name ?? ""),
      token: String(a?.token ?? ""),
      grantCeiling: Array.isArray(a?.grantCeiling) ? a.grantCeiling.map(String) : null,
      ...(a?.workdir ? { workdir: String(a.workdir) } : {}),
    }))
    .filter((a) => a.name && a.token);
  if (apps.length) cfg.apps = apps;
  // The full delegation library for the dashboard's registry editor — catalog
  // metadata only. The judge reads routing.workflows; this key is inert for
  // routing and exists so the UI can see every workflow, registered or not.
  if (library?.length) cfg.workflowLibrary = library;
  return cfg;
}

export function renderEnvHeader(roster, resolved) {
  const names = new Set();
  if (roster.typesafe?.apiKeyEnv) names.add(roster.typesafe.apiKeyEnv);
  for (const p of Object.values(roster.providers)) if (p.apiKeyEnv) names.add(p.apiKeyEnv);
  const judgeEnv = roster.judge?.fastino?.apiKeyEnv;
  if (judgeEnv) names.add(judgeEnv);
  return [
    "Router runtime secrets — chmod 600, never committed, never in the roster.",
    "One KEY=value per line; values with spaces get quoted.",
    `Generated by agnostic-router-kit from the roster (${resolved.envMissing.length ? `still missing: ${resolved.envMissing.join(", ")}` : "all referenced keys present"}).`,
  ];
}
