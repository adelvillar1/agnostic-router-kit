/**
 * export: derive a roster from a live router's rendered config. This is the
 * "clone this machine" path — run it once, commit the key-free roster, and the
 * next machine reproduces the same routing with `kit apply`.
 *
 * The source of truth is the router's OWN config.json: every usable provider is
 * an `extraUpstreams` entry with its key named by env var, and every routing
 * decision (tiers, fallback targets, mixture, workflow registry, judge mode)
 * sits under `routing`. There is no provider config file to read here — that is
 * the whole point of the edition.
 *
 * API keys are never exported: providers come back as apiKeyEnv references and
 * `kit env set` supplies the values per machine.
 */
import fs from "node:fs";
import path from "node:path";
import { ROSTER_VERSION, ROSTER_PATH, ROUTER_DIR } from "./paths.mjs";

function guessBilling(id, baseUrl) {
  if (/(deepseek|openai\.com|anthropic)/i.test(id + baseUrl)) return "payg";
  return "plan";
}

export function exportRoster({ routerConfigPath = path.join(ROUTER_DIR, "config.json") } = {}) {
  let rc = null;
  if (fs.existsSync(routerConfigPath)) rc = JSON.parse(fs.readFileSync(routerConfigPath, "utf8"));
  const R = rc?.routing ?? {};

  // Portability metadata lives in the roster, not in live state: the rendered
  // config records only where each tier RESOLVED to. Preserve the previous
  // roster's chains, notes, and model lists so re-exporting never silently
  // strips them.
  const prev = (() => {
    try {
      return JSON.parse(fs.readFileSync(ROSTER_PATH, "utf8"));
    } catch {
      return null;
    }
  })();
  const keepCandidates = (prevValue, resolvedTarget) => {
    const list = Array.isArray(prevValue) ? prevValue : prevValue ? [prevValue] : [];
    return [resolvedTarget, ...list.filter((t) => t !== resolvedTarget)];
  };

  const providers = {};
  for (const [id, u] of Object.entries(rc?.extraUpstreams ?? {})) {
    const prevP = prev?.providers?.[id] ?? {};
    providers[id] = {
      ...(prevP.providerName ? { providerName: prevP.providerName } : { providerName: id.replace(/-/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()) }),
      baseUrl: u.baseUrl,
      apiKeyEnv: u.apiKeyEnv,
      billing: prevP.billing ?? guessBilling(id, u.baseUrl ?? ""),
      ...(prevP.models?.length ? { models: prevP.models } : { models: [] }),
      ...(prevP.featured?.length ? { featured: prevP.featured } : {}),
      ...(prevP.routerOnly ? { routerOnly: true } : {}),
    };
  }
  // Declared-but-unreachable providers (no baseUrl in the live config) survive
  // as declarations, so re-exporting does not lose plans the operator added but
  // did not route to.
  for (const [id, p] of Object.entries(prev?.providers ?? {})) {
    if (providers[id] || p.routerOnly) continue;
    if (Object.values(rc?.extraUpstreams ?? {}).some((u) => u.apiKeyEnv === p.apiKeyEnv)) continue;
    const { hasKey, ...rest } = p;
    providers[id] = rest;
  }

  const tiers = {};
  for (const [name, w] of Object.entries(R.workloads ?? {})) {
    const target = `${w.providerId}/${w.model}`;
    const prevTier = prev?.tiers?.[name];
    const prevFallbacks = Array.isArray(prevTier?.fallbacks) ? prevTier.fallbacks : [];
    tiers[name] = {
      target,
      fallbacks: [...new Set(prevFallbacks)].filter((t) => t !== target),
      ...(prevTier?.note ? { note: prevTier.note } : {}),
    };
  }

  const mixture = {
    proposers: (R.mixture?.proposers ?? []).map((p) => `${p.providerId}/${p.model}`),
    aggregator: R.mixture?.aggregator
      ? keepCandidates(prev?.mixture?.aggregator, `${R.mixture.aggregator.providerId}/${R.mixture.aggregator.model}`)
      : "",
    proposerTimeoutMs: R.mixture?.proposerTimeoutMs ?? 240000,
  };

  return {
    version: ROSTER_VERSION,
    exportedFrom: { routerConfigPath, at: new Date().toISOString() },
    ...(prev?.kit ? { kit: prev.kit } : { kit: { edition: "agnostic", defaultPort: 8300 } }),
    router: { port: rc?.port ?? 8300, localToken: rc?.localToken ?? "local-auto-router" },
    typesafe: { apiKeyEnv: "TYPESAFE_API_KEY", model: rc?.typesafeModel ?? "jev-1.13.0", ttlHours: rc?.ttlHours ?? 6 },
    ...(rc?.judge ? { judge: rc.judge } : {}),
    allowPayg: false,
    providers,
    omniModel: R.omniModel ? keepCandidates(prev?.omniModel, `${R.omniModel.providerId}/${R.omniModel.model}`) : (prev?.omniModel ?? []),
    wideModel: R.wideModel ? keepCandidates(prev?.wideModel, `${R.wideModel.providerId}/${R.wideModel.model}`) : (prev?.wideModel ?? []),
    tiers,
    profiles: R.profiles ?? {},
    mixture,
    routing: {
      wideChars: R.wideChars ?? 1000000,
      minConfidence: R.minConfidence ?? 0.6,
      workflowMinConfidence: R.workflowMinConfidence ?? 0.4,
      defaultWorkload: R.defaultWorkload,
    },
    workflows: {
      registry: Object.fromEntries(
        (R.workflows ?? []).map((w) => [
          w.name,
          { taskArg: w.taskArg, shape: w.shape, ...(w.defaults ? { defaults: w.defaults } : {}) },
        ])
      ),
    },
    ...(prev?.manualModelRules ? { manualModelRules: prev.manualModelRules } : {}),
  };
}
