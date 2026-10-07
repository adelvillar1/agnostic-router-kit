/**
 * agnostic-router-kit CLI.
 *
 *   kit status                     what is installed, and where
 *   kit init --template            write a starter roster to edit
 *   kit env set K=V …              manage the runtime .env (keys only, chmod 600)
 *   kit env list | unset K
 *   kit apply [--dry-run] [--only router|service]
 *   kit doctor [--live]            verify the whole chain, change nothing
 *   kit route "task…"              ask the running router for its verdict
 *   kit export [--out f]           derive a key-free roster from the live router config
 *   kit workflows list|run|last    the shipped workflow library
 *   kit workflows watch|graph      replay a run journal; export the session graph
 *   kit upgrade                    git pull + apply
 *   kit help                       the commands, with their forms
 *   kit quickstart                 guided install: every step in order, with prompts
 *
 * There is deliberately no harness-specific step in `apply`: the kit renders
 * the router's own runtime and the keepalive service, nothing else. Any
 * OpenAI-compatible client points at the router's /v1 — that is the whole
 * integration surface.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  KIT_DIR,
  KIT_VERSION,
  KIT_WORKFLOWS_DIR,
  KIT_ROUTER_DIR,
  KIT_TEMPLATES_DIR,
  ROUTER_DIR,
  ROUTER_LOG,
  ENV_FILE,
  ROSTER_PATH,
  platform,
  tilde,
} from "./paths.mjs";
import { loadRoster, resolveRoster, parseJsonc } from "./roster.mjs";
import { renderRouterConfig, renderEnvHeader } from "./render.mjs";
import { readEnvFile, writeEnvFile } from "./envstore.mjs";
import { installService, serviceStatus, servicePaths } from "./service.mjs";
import { readLibrary, buildRegistry } from "./workflowlib.mjs";
import { KIT_WORKFLOW_RUNS, fmtTokens } from "workflow-plane/engine.mjs";
import { normalizeEvent, isTerminal } from "workflow-plane/events.mjs";
import { buildGraph } from "workflow-plane/graph.mjs";
import {
  memoryStorePath, loadGraph, saveGraph, searchGraph, memoryStats, gcGraph,
  createEntities, createRelations, addFact, resolveConflict, invalidate,
  detectConflicts, addScratch, consolidate, extractMentions, aggregateVeracity, addTriple,
  clampVeracity, VERACITY_WEIGHTS,
} from "workflow-plane/memory.mjs";
import { exportRoster } from "./export-live.mjs";

// ── tiny output helpers ─────────────────────────────────────────────────────
const c = {
  ok: (s) => `✓ ${s}`,
  warn: (s) => `! ${s}`,
  fail: (s) => `✗ ${s}`,
  dim: (s) => `  ${s}`,
  head: (s) => `\n${s}`,
};
function parseFlags(argv) {
  const flags = {};
  const positional = [];
  const camel = (k) => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      if (v !== undefined) flags[camel(k)] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) flags[camel(k)] = argv[++i];
      else flags[camel(k)] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

function loadAndResolve(rosterPath = ROSTER_PATH) {
  const roster = loadRoster(rosterPath);
  if (!roster) {
    return { roster: null, resolved: null, error: `no roster at ${rosterPath} — run \`kit init --template\` (or copy a machine's roster) first` };
  }
  const envFile = readEnvFile(ENV_FILE);
  const resolved = resolveRoster(roster, { envFile });
  return { roster, resolved, error: null };
}

// Atomic: the dashboard re-runs apply while the router is serving, and the
// router re-reads config.json on mtime — a half-written file must never be
// observable, so land the rename only once the bytes are complete on disk.
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-kit`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(tmp, p);
}

function copyRuntime(routerDir, { dry }) {
  const steps = [];
  // Every code + doc file in the kit's router dir ships — an explicit list
  // went stale twice (quota.mjs, fastino.mjs) and crash-looped the deployed
  // router on a missing module. config.json is absent from the kit dir (it is
  // generated), so the glob cannot clobber live state.
  const files = fs.readdirSync(path.join(KIT_DIR, "router")).filter((f) =>
    f.endsWith(".js") || f.endsWith(".mjs") || f === "dashboard.html" || f === "setup.html" || f === "chat.html" || f === "package.json" || f === "README.md"
  );
  for (const f of files) {
    const src = path.join(KIT_DIR, "router", f);
    const dest = path.join(routerDir, f);
    fs.mkdirSync(routerDir, { recursive: true });
    const same = fs.existsSync(dest) && fs.readFileSync(dest, "utf8") === fs.readFileSync(src, "utf8");
    if (!same) {
      if (!dry) fs.copyFileSync(src, dest);
      steps.push(`${dry ? "would copy" : "copied"} ${f}`);
    }
  }
  // The runtime dir is standalone — it must carry its own @typesafe-ai/sdk
  // (232K). Copy the kit's install when the runtime has none so a fresh
  // `kit apply` is immediately runnable without a second manual step.
  const depSrc = path.join(KIT_DIR, "router", "node_modules", "@typesafe-ai");
  const depDest = path.join(routerDir, "node_modules", "@typesafe-ai");
  if (fs.existsSync(depSrc) && !fs.existsSync(depDest)) {
    if (!dry) {
      fs.cpSync(depSrc, depDest, { recursive: true });
      const lockSrc = path.join(KIT_DIR, "router", "package-lock.json");
      if (fs.existsSync(lockSrc)) fs.copyFileSync(lockSrc, path.join(routerDir, "package-lock.json"));
    }
    steps.push(`${dry ? "would copy" : "copied"} node_modules/@typesafe-ai`);
  }
  steps.push(...copyPlaneRuntime(path.join(KIT_DIR, "lib", "workflow"), routerDir, { dry }));
  return steps;
}

/**
 * The plane ships as a package, so the runtime copy follows the package's own
 * declaration of what it is rather than a hand-written file list: one file per
 * exports entry in the manifest, plus a `node_modules` link so the router's
 * specifier imports resolve inside the install instead of reaching back to the
 * checkout. A written list goes stale the moment a module is extracted out of
 * engine.mjs, and a missing one crash-loops the deployed router the same way.
 *
 * Exported so `tools/test-copy-plane.mjs` can drive it against a throwaway
 * install rather than depending on a resolvable roster to reach it.
 */
export function copyPlaneRuntime(planeSrc, routerDir, { dry }) {
  const steps = [];
  const manifest = path.join(planeSrc, "package.json");
  if (!fs.existsSync(manifest)) return steps;
  let modules;
  try {
    ({ exports: modules } = JSON.parse(fs.readFileSync(manifest, "utf8")) ?? {});
  } catch (err) {
    // A manifest that does not parse is a build error, not a runtime one: the
    // operator must see it rather than get a router that silently lost a module.
    throw new Error(`lib/workflow/package.json is not valid JSON: ${err.message}`);
  }
  const dest = path.join(routerDir, "..", "lib", "workflow");
  const listed = Object.values(modules ?? {})
    .map((entry) => String(entry).replace(/^\.\//, ""))
    .filter((entry) => entry.endsWith(".mjs"));
  for (const f of listed) {
    const src = path.join(planeSrc, f);
    const out = path.join(dest, f);
    // A manifest whose file is not on disk is a broken checkout, not a step to
    // skip: the router would boot without a module it imports by name.
    if (!fs.existsSync(src)) {
      throw new Error(`lib/workflow/package.json declares ${f} but it is not on disk`);
    }
    const same = fs.existsSync(out) && fs.readFileSync(out, "utf8") === fs.readFileSync(src, "utf8");
    if (!same) {
      // Only now, with a file about to land: a dry run must not so much as
      // create the directory it reports on.
      if (!dry) {
        fs.mkdirSync(dest, { recursive: true });
        fs.copyFileSync(src, out);
      }
      steps.push(`${dry ? "would copy" : "copied"} lib/workflow/${f}`);
    }
  }
  // The link is what makes `import "workflow-plane/…"` work from the installed
  // router. It is relative and lives inside the install, so the shipped runtime
  // never reaches back to the checkout it came from. Note the lstat check: a
  // dangling link exists but fs.existsSync follows it and reports false, which
  // would re-link a link that is already correct — harmless, but the wrong
  // answer to "is the install already in place".
  const link = path.join(routerDir, "node_modules", "workflow-plane");
  const want = path.relative(path.dirname(link), dest);
  let inPlace = false;
  try {
    inPlace = fs.lstatSync(link).isSymbolicLink() && fs.realpathSync(link) === fs.realpathSync(dest);
  } catch {
    inPlace = false;
  }
  if (!inPlace) {
    if (!dry) {
      fs.mkdirSync(dest, { recursive: true });
      fs.mkdirSync(path.dirname(link), { recursive: true });
      // A link from an earlier apply can be wrong or dangling; symlinkSync
      // refuses to overwrite, so clear it first.
      if (fs.lstatSync(link, { throwIfNoEntry: false })) fs.rmSync(link, { force: true });
      fs.symlinkSync(want, link, "dir");
    }
    steps.push(`${dry ? "would link" : "linked"} node_modules/workflow-plane -> ${want}`);
  }
  return steps;
}

async function health(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? await r.json().catch(() => ({})) : null;
  } catch {
    return null;
  }
}

/** sys1 is a declared dependency of the fastino/cascade judge legs. */
async function sys1Health(roster, envMap) {
  const j = roster.judge ?? {};
  const fast = j.fastino ?? {};
  const baseUrl = (fast.baseUrl ?? "http://127.0.0.1:8400").replace(/\/+$/, "");
  const token = envMap[fast.apiKeyEnv ?? "SYS1_BEARER_TOKEN"] ?? null;
  try {
    const r = await fetch(`${baseUrl}/healthz`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) return { ok: false, baseUrl, detail: `HTTP ${r.status}` };
    return { ok: true, baseUrl };
  } catch (e) {
    return { ok: false, baseUrl, detail: String(e?.message ?? e) };
  }
}

// ── commands ───────────────────────────────────────────────────────────────
export async function cmdStatus() {
  const sp = servicePaths();
  console.log(`agnostic-router-kit ${KIT_VERSION} — ${platform()}`);
  console.log(`  kit repo:     ${KIT_DIR}`);
  console.log(`  roster:       ${fs.existsSync(ROSTER_PATH) ? ROSTER_PATH : `(none — run \`kit init --template\`)`}`);
  console.log(`  router dir:   ${ROUTER_DIR}`);
  console.log(`  router cfg:   ${fs.existsSync(path.join(ROUTER_DIR, "config.json")) ? "present" : "missing"}`);
  console.log(`  env file:     ${fs.existsSync(ENV_FILE) ? (fs.statSync(ENV_FILE).mode & 0o777) === 0o600 ? "present (600)" : "present — WRONG PERMS" : "missing"}`);
  console.log(`  service:      ${sp.kind} ${sp.unit ?? ""} ${serviceStatus().loaded ? "(loaded)" : "(not loaded)"}`);
  const { roster, error } = loadAndResolve();
  if (error) {
    console.log(c.warn(error));
    return 1;
  }
  const resolved = resolveRoster(roster, { envFile: readEnvFile(ENV_FILE) });
  const port = roster.router?.port ?? 8300;
  const installed = fs.existsSync(path.join(ROUTER_DIR, "config.json"));
  // Without an applied runtime the port belongs to whatever else runs there —
  // probing it would report a stranger's health as this kit's own.
  if (!installed) {
    console.log(`  health:       no runtime installed — run \`kit apply\` first`);
  } else {
    const h = await health(port);
    console.log(`  health:       ${h ? `up on 127.0.0.1:${port}` : `DOWN on 127.0.0.1:${port}`}`);
  }
  console.log(c.head("tiers"));
  for (const [name, t] of Object.entries(roster.tiers)) {
    const w = resolved.workloads[name];
    const remap = w && `${w.providerId}/${w.model}` !== t.target ? ` (remapped from ${t.target})` : "";
    console.log(`  ${w ? c.ok(name.padEnd(14)) : c.fail(name.padEnd(14))} ${w ? `${w.providerId}/${w.model}${remap}` : "unusable — no target resolved"}`);
  }
  if (resolved.remaps.length) {
    console.log(c.head("remaps"));
    for (const r of resolved.remaps) {
      if (r.to) console.log(c.warn(`${r.name}: ${r.from} → ${r.to}`));
      else console.log(c.dim(`${r.name}: dropped ${r.from} (${r.skippedReason})`));
    }
  }
  const apps = Array.isArray(roster.router?.apps) ? roster.router.apps : [];
  if (apps.length) {
    console.log(c.head("run-api apps"));
    for (const a of apps) {
      const ceiling = Array.isArray(a.grantCeiling) && a.grantCeiling.length ? a.grantCeiling.join(",") : "no ceiling";
      console.log(`  ${String(a.name).padEnd(14)} ${ceiling}`);
    }
  }
  return 0;
}

export function cmdInit(flags) {
  if (fs.existsSync(ROSTER_PATH) && !flags.force) {
    console.log(c.warn(`${ROSTER_PATH} already exists — pass --force to overwrite`));
    return 1;
  }
  if (!flags.template) {
    console.log(c.fail("this kit has no harness config to import from — write the roster by hand: `kit init --template`, then edit it and `kit env set` each key"));
    return 1;
  }
  const tpl = path.join(KIT_DIR, "templates", "roster.defaults.json");
  if (!fs.existsSync(tpl)) {
    console.log(c.fail(`no template at ${tpl}`));
    return 1;
  }
  writeJson(ROSTER_PATH, parseJsonc(fs.readFileSync(tpl, "utf8")));
  console.log(c.ok(`template roster written to ${ROSTER_PATH} — edit it, then \`kit env set …\` and \`kit apply\``));
  const setcmds = ["STEPFUN_API_KEY", "ZAI_CODING_API_KEY", "TYPESAFE_API_KEY"].map((v) => `kit env set ${v}=…`);
  console.log(c.dim("keys to set (the router only routes targets whose key resolves):"));
  for (const s of setcmds) console.log(c.dim(`  ${s}`));
  return 0;
}

export function cmdEnv(flags, positional) {
  const sub = positional[0];
  const cur = readEnvFile(ENV_FILE);
  if (sub === "set") {
    const pairs = positional.slice(1);
    if (!pairs.length) {
      console.log(c.fail("usage: kit env set NAME=value …"));
      return 1;
    }
    const next = { ...cur };
    for (const p of pairs) {
      const i = p.indexOf("=");
      if (i < 1) {
        console.log(c.fail(`"${p}" is not NAME=value`));
        return 1;
      }
      next[p.slice(0, i)] = p.slice(i + 1);
    }
    const { roster } = loadAndResolve();
    const header = roster ? renderEnvHeader(roster, { envMissing: [] }) : ["Router runtime secrets — chmod 600."];
    writeEnvFile(ENV_FILE, next, { header });
    console.log(c.ok(`wrote ${Object.keys(next).length} keys to ${ENV_FILE} (600)`));
    return 0;
  }
  if (sub === "unset") {
    const names = positional.slice(1);
    const next = { ...cur };
    for (const n of names) delete next[n];
    writeEnvFile(ENV_FILE, next, { header: ["Router runtime secrets — chmod 600."] });
    console.log(c.ok(`removed ${names.join(", ") || "(nothing)"}`));
    return 0;
  }
  if (sub === "list" || !sub) {
    const { roster } = loadAndResolve();
    const wanted = new Set();
    if (roster) {
      for (const p of Object.values(roster.providers)) if (p.apiKeyEnv) wanted.add(p.apiKeyEnv);
      if (roster.typesafe?.apiKeyEnv) wanted.add(roster.typesafe.apiKeyEnv);
      if (roster.judge?.fastino?.apiKeyEnv) wanted.add(roster.judge.fastino.apiKeyEnv);
    }
    const keys = new Set([...Object.keys(cur), ...wanted]);
    if (!keys.size) console.log(c.dim("(no keys set, nothing expected)"));
    for (const k of [...keys].sort()) {
      const have = Boolean(cur[k]);
      const need = wanted.has(k);
      console.log(`  ${have ? "✓" : need ? "✗" : "·"} ${k}${have ? "" : need ? "  (required by roster)" : "  (set, unused)"}`);
    }
    return 0;
  }
  console.log(c.fail(`unknown env subcommand "${sub}" (set|unset|list)`));
  return 1;
}

/**
 * kit export [--out f] — derive a roster from the running router's rendered
 * config. The only import surface this edition has: the router's own config
 * already carries every provider (as an extraUpstream with its key named by
 * env var), every tier, and the workflow registry. Key-free by construction.
 */
export function cmdExport(flags) {
  const routerConfigPath = path.join(ROUTER_DIR, "config.json");
  if (!fs.existsSync(routerConfigPath)) {
    console.log(c.fail(`no rendered router config at ${routerConfigPath} — run \`kit apply\` first (the export reads what the router is actually running)`));
    return 1;
  }
  const roster = exportRoster({ routerConfigPath });
  const n = Object.keys(roster.providers).length;
  const out = flags.out ? path.resolve(String(flags.out)) : ROSTER_PATH;
  if (out !== null) writeJson(out, roster);
  console.log(c.ok(`roster exported from the live router config (${n} providers) → ${out}`));
  if (out === ROSTER_PATH && fs.existsSync(out)) {
    console.log(c.warn("that is the roster this kit already reads — exporting onto itself keeps only the previous file's portability metadata"));
  }
  return 0;
}

export async function cmdApply(flags) {
  const dry = Boolean(flags.dryRun ?? flags.dry);
  const { roster, error } = loadAndResolve();
  if (error) return void console.log(c.fail(error)), 1;
  const envFile = readEnvFile(ENV_FILE);
  const resolved = resolveRoster(roster, { envFile });
  const only = flags.only ? String(flags.only).split(",") : ["router", "service"];
  const steps = [];
  const problems = [];

  const rawKeys = Object.values(resolved.providers).filter((p) => p.rawKeyWarning).map((p) => p.id);
  if (rawKeys.length) console.log(c.warn(`roster carries RAW apiKey values (${rawKeys.join(", ")}) — use apiKeyEnv + \`kit env set\`, or gitignore roster.json`));

  if (resolved.problems.length) {
    for (const p of resolved.problems) console.log(c.fail(p));
    console.log(c.fail("fix the roster (or set the missing keys) before applying — the router would route with holes"));
    return 1;
  }

  // 1. router runtime + generated config
  if (only.includes("router")) {
    const port = flags.port ? Number(flags.port) : undefined;
    steps.push(...copyRuntime(ROUTER_DIR, { dry }));
    const registry = buildRegistry(readLibrary(KIT_WORKFLOWS_DIR), roster);
    const cfg = renderRouterConfig(roster, resolved, registry, { port });
    const dest = path.join(ROUTER_DIR, "config.json");
    const changed = !fs.existsSync(dest) || fs.readFileSync(dest, "utf8") !== JSON.stringify(cfg, null, 2) + "\n";
    if (changed) {
      if (!dry) {
        if (fs.existsSync(dest)) fs.copyFileSync(dest, `${dest}.bak-kit`);
        writeJson(dest, cfg);
      }
      steps.push(`${dry ? "would write" : "wrote"} config.json (${Object.keys(resolved.workloads).length} tiers)`);
    } else steps.push("config.json already current");
    if (!fs.existsSync(ENV_FILE) && !dry) {
      writeEnvFile(ENV_FILE, {}, { header: renderEnvHeader(roster, resolved) });
      steps.push(`created ${ENV_FILE}`);
    }
    const depsDir = path.join(ROUTER_DIR, "node_modules", "@typesafe-ai");
    if (!fs.existsSync(depsDir)) problems.push(`router dependency @typesafe-ai/sdk missing in ${ROUTER_DIR} — run: (cd ${ROUTER_DIR} && npm install --omit=dev)`);
  }

  // 2. service
  if (only.includes("service")) {
    const st = serviceStatus();
    if (st.kind === "unsupported") problems.push(`service management is not automated for ${process.platform} — run the router by hand: node ${path.join(ROUTER_DIR, "server.js")}`);
    else if (dry) steps.push(`would install ${st.kind} service (${st.unit})`);
    else {
      const r = await installService({ scriptDir: ROUTER_DIR });
      steps.push(`service: ${r.steps.join("; ")}`);
      if (!r.ok) problems.push(`service did not start: ${r.error ?? "unknown"} — start it by hand: node ${path.join(ROUTER_DIR, "server.js")}`);
    }
  }

  for (const s of steps) console.log(c.ok(s));

  if (dry) {
    if (resolved.remaps.length) for (const r of resolved.remaps) console.log(c.warn(`remap: ${r.name}: ${r.from} → ${r.to ?? "dropped"}`));
    console.log(c.warn("dry run — nothing was written"));
    return 0;
  }

  // 3. verify health
  const port = flags.port ? Number(flags.port) : roster.router?.port ?? 8300;
  let h = null;
  for (let i = 0; i < 10 && !h; i++) {
    h = await health(port);
    if (!h) await new Promise((r) => setTimeout(r, 500));
  }
  if (h) console.log(c.ok(`router healthy on http://127.0.0.1:${port}`));
  else problems.push(`router did not answer /healthz on 127.0.0.1:${port} — start it by hand: node ${path.join(ROUTER_DIR, "server.js")}`);

  for (const p of problems) console.log(c.fail(p));
  console.log(c.head("next"));
  console.log(c.dim(`point any OpenAI-compatible client at http://127.0.0.1:${port}/v1 (model "auto", token: router.config.json → localToken)`));
  console.log(c.dim(`watch routing: tail -f ${ROUTER_LOG}`));
  return problems.length ? 1 : 0;
}

export async function cmdDoctor(flags) {
  const { roster, error } = loadAndResolve();
  const bad = [];
  const line = (ok, label, detail = "") => {
    console.log(`${ok ? c.ok("") : c.fail("")} ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) bad.push(label);
  };
  console.log(c.head("doctor"));
  if (error) {
    console.log(c.fail(error));
    return 1;
  }
  const envFile = readEnvFile(ENV_FILE);
  const resolved = resolveRoster(roster, { envFile });
  line(true, "roster", ROSTER_PATH);

  const cfgPath = path.join(ROUTER_DIR, "config.json");
  line(fs.existsSync(cfgPath), "router config present", cfgPath);
  line(fs.existsSync(path.join(ROUTER_DIR, "server.js")), "router runtime present");
  line(fs.existsSync(path.join(ROUTER_DIR, "node_modules", "@typesafe-ai")), "router dependency @typesafe-ai/sdk");

  const port = roster.router?.port ?? 8300;
  const h = await health(port);
  line(Boolean(h), "router health", h ? `127.0.0.1:${port}` : `no answer on 127.0.0.1:${port}`);

  if (fs.existsSync(ENV_FILE)) {
    const mode = fs.statSync(ENV_FILE).mode & 0o777;
    line(mode === 0o600, ".env permissions", mode === 0o600 ? "600" : `${mode.toString(8)} — chmod 600 ${ENV_FILE}`);
  } else line(false, ".env file", `${ENV_FILE} missing`);
  line(resolved.envMissing.length === 0, "roster keys resolve", resolved.envMissing.length ? `missing: ${resolved.envMissing.join(", ")}` : "all present");

  for (const [name, t] of Object.entries(roster.tiers)) {
    const w = resolved.workloads[name];
    line(Boolean(w), `tier ${name}`, w ? `${w.providerId}/${w.model}` : "unusable");
  }
  line(Boolean(resolved.aggregator), "mixture aggregator", resolved.aggregator ? `${resolved.aggregator.providerId}/${resolved.aggregator.model}` : "unusable");
  line(resolved.proposers.length >= 2, "mixture proposers", `${resolved.proposers.length} usable`);

  // sys1 dependency: the fastino and cascade judge legs route through the sys1
  // service. When it is down the judge fails open to defaultWorkload (the
  // router never fails a request on a judge outage), but a cascade mode that
  // silently degrades to one leg is worth a hard failing check, not a silent
  // note — typesafe-only mode does not need sys1 at all.
  const judgeMode = roster.judge?.mode ?? "typesafe";
  if (judgeMode === "typesafe") {
    console.log(c.dim(`· sys1 decision service — not required (judge.mode=typesafe)`));
  } else {
    const s1 = await sys1Health(roster, envFile);
    line(s1.ok, `sys1 decision service (judge.mode=${judgeMode})`, s1.ok ? `${s1.baseUrl} reachable` : `${s1.baseUrl} unreachable (${s1.detail}) — the judge fails open to defaultWorkload; set judge.mode=typesafe to drop the dependency`);
  }

  const st = serviceStatus();
  line(st.loaded || flags.noService, "service", st.kind === "unsupported" ? `not automated for ${process.platform}` : st.unit);

  // The durable memory store is optional state — checked only once it exists:
  // a malformed line must not take the memory plane down, but it must be named.
  if (fs.existsSync(memoryStorePath())) {
    try {
      const g = loadGraph(memoryStorePath());
      line(true, "memory store", `${g.entities.length} entities, ${g.relations.length} relations`);
    } catch (e) {
      line(false, "memory store", String(e?.message ?? e).slice(0, 120));
    }
  }

  if (flags.live) {
    console.log(c.head("live probe (each provider's /models)"));
    for (const [id, p] of Object.entries(roster.providers)) {
      const prov = resolved.providers[id];
      if (!prov?.usable) {
        console.log(c.dim(`${id}: skipped (no key)`));
        continue;
      }
      const base = (p.baseUrl ?? "").replace(/\/+$/, "");
      if (!base) {
        console.log(c.dim(`${id}: no baseUrl (not an HTTP upstream)`));
        continue;
      }
      try {
        const r = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${prov.apiKey}` }, signal: AbortSignal.timeout(5000) });
        line(r.ok, `live ${id}`, `HTTP ${r.status}`);
      } catch (e) {
        line(false, `live ${id}`, String(e.message ?? e));
      }
    }
  }

  console.log();
  if (!bad.length) {
    console.log(c.ok("doctor: everything checks out"));
    return 0;
  }
  console.log(c.fail(`doctor: ${bad.length} problem(s): ${bad.join("; ")}`));
  return 1;
}

const fmtDur = (ms) => !Number.isFinite(ms) ? "—"
  : ms < 1000 ? `${Math.round(ms)}ms`
  : ms < 90_000 ? `${(ms / 1000).toFixed(1)}s`
  : ms < 5_400_000 ? `${(ms / 60_000).toFixed(1)}m`
  : `${(ms / 3_600_000).toFixed(2)}h`;

const fmtBytes = (n) => !Number.isFinite(n) ? "0B"
  : n < 1024 ? `${n}B`
  : n < 1_048_576 ? `${(n / 1024).toFixed(1)}KB`
  : `${(n / 1_048_576).toFixed(2)}MB`;

const previewText = (s, cap) => (s.length > cap ? `${s.slice(0, cap)}…` : s);

function watchLine(e) {
  const at = Number.isFinite(e.t) ? `+${fmtDur(e.t)}`.padEnd(9) : " ".repeat(9);
  const who = String(e.actor ?? "").replace(/^Builder for /, "").split(" · ")[0].slice(0, 52);
  switch (e.kind) {
    case "run-start": return `${at} ▶ run · ${e.model ?? ""} ${e.workdir ?? ""}`;
    case "phase": return `${at} ── ${e.phase}`;
    case "agent": return `${at} ● ${who} asked${e.ms != null ? ` (${fmtDur(e.ms)}${e.tools ? ", tools" : ""})` : ""}`;
    case "tool": {
      // Two lines describe a recall, because two lines describe any tool call:
      // the agent loop's action line (with the agent's name, `facts` absent) and
      // the recall impl's own audit line (with what the agent was shown, `facts`
      // present and no tool name of its own). Both belong to the recall, so both
      // read as one.
      if (e.tool === "recall" || e.actor === "recall" || Number.isFinite(e.facts)) {
        // The refusal is written by the recall impl, not the agent loop, so it
        // carries no agent name — it names itself rather than printing an
        // empty one.
        if (e.refused) return `${at}   · recall [refused: ${e.refused.split(" — ")[0]}]`;
        if (Number.isFinite(e.facts)) return `${at}   · recall → ${e.facts} fact(s), ${fmtBytes(e.bytes ?? 0)}`;
        return `${at}   · ${who} → recall`;
      }
      // The capability line names the tool as its own actor, so "edit_file →
      // edit_file [workspace-io]" says the same thing twice. The agent's line
      // keeps the actor, which is the half that tells you who called it.
      const tool = e.tool || e.actor || "tool";
      const tail = e.refused ? ` [refused: ${e.refused.split(" — ")[0]}]` : e.grant ? ` [${e.grant}]` : "";
      return who && who !== tool ? `${at}   · ${who} → ${tool}${tail}` : `${at}   · ${tool}${tail}`;
    }
    case "service": {
      const what = e.event === "start" ? `started ${e.command} (${e.lifetimeMs}ms)` : e.event === "stop" ? "stopped" : e.event;
      // A killed child has no exit code, so its signal carries the reason.
      const end = e.exitCode != null ? ` — exit ${e.exitCode}` : e.signal ? ` — killed by ${e.signal}` : "";
      return `${at}   · ${e.service} ${what}${end}`;
    }
    case "report": return `${at} ≡ ${e.item ?? ""}`;
    case "escalation": return `${at} ⚠ ${who}: ${e.question ?? ""}`;
    // A delegated child is the parent's own spend, so the line names both ends
    // and the calls the child cost the parent.
    case "delegate":
      if (e.op === "spawn") return `${at} ⇢ delegate → ${e.child} · ${String(e.task ?? "").slice(0, 70)}`;
      if (e.op === "failed") return `${at} ⇢ delegate failed — ${e.reason}`;
      return `${at} ⇢ delegate ← ${e.asks} asks, ${e.toolCalls} tools, ${fmtDur(e.ms ?? 0)}`;
    // A part's checkpoint and its rollback: the take is a promise the plane
    // makes before a part builds, the restore is what it kept.
    case "checkpoint":
      if (e.op === "refused") return `${at} ✗ checkpoint refused — ${e.part}: ${String(e.reason ?? "").split(" — ")[0]}`;
      return `${at} ⤓ checkpoint ${e.part} — ${e.paths} path(s), ${fmtBytes(e.bytes ?? 0)}${e.oversized ? " (oversized: existence only)" : ""}`;
    case "rollback":
      return `${at} ↩ rollback ${e.part} — ${e.restored} restored, ${e.removed} removed${e.left ? `, ${e.left} left` : ""}${e.uncaptured ? `, ${e.uncaptured} uncaptured` : ""}`;
    // One ask's cost, and the compaction that kept an ask inside its window.
    // The compression line names what survived: the plane's own poles, so a
    // reader knows the boundary and the facts were not part of what was dropped.
    case "account":
      return (
        `${at} ↳ account ${who} — ask ${e.ask ?? "?"}, ${e.rounds ?? 0} round(s), ` +
        `${fmtTokens(e.promptTokens ?? 0)} in / ${fmtTokens(e.completionTokens ?? 0)} out` +
        `${e.compacted ? `, compacted ×${e.compacted}` : ""}` +
        `${e.shape && e.shape !== "build" ? ` [${e.shape}: ${e.budget?.rounds ?? "?"} rounds / ${fmtTokens(e.budget?.tokens ?? 0)}]` : ""}`
      );
    case "budget":
      return `${at} ⛔ budget ${who} — ${e.shape ?? "build"} ask hit the cap: ${e.reason ?? "?"} spent (${e.rounds ?? 0} round(s), ${fmtTokens(e.spent ?? 0)})`;
    case "compact": {
      const how = e.mode === "truncate" ? "truncated (no summary)" : "summarized";
      return (
        `${at} ↯ compact ${who} — ${fmtTokens(e.before ?? 0)} → ${fmtTokens(e.after ?? 0)} (line ${fmtTokens(e.limit ?? 0)}), ` +
        `${how}: ${e.summarized ?? 0} message(s) → ${e.kept ?? 0} kept` +
        `${e.dropped ? `, ${e.dropped} too old to summarize` : ""}`
      );
    }
    case "artifact": return `${at} ◆ artifact ${e.artifactId}${e.version != null ? ` v${e.version}` : ""} → ${e.path ?? ""}`;
    case "command":
      if (e.refused) return `${at} $ ${e.command} [refused: ${e.refused.split(" — ")[0]}]`;
      return `${at} $ ${e.command}${e.grant ? ` [${e.grant}]` : ""}`;
    case "log": return `${at}   ${e.message ?? ""}`;
    case "fact": {
      // A line the plane wrote about its own run, not an agent action: the
      // arrival of one is the fact becoming part of the run's record.
      const what = e.factKind ? e.factKind : "fact";
      const where = e.part ? ` ${e.part}` : "";
      return `${at}   ✎ ${what}${where} — ${previewText(e.text ?? "", 48)}`;
    }
    case "warn": return `${at} ! ${e.message ?? ""}`;
    case "run-done": return `${at} ✓ done in ${fmtDur(e.ms)} — ${e.result ?? ""}`;
    case "run-failed": return `${at} ✗ ${e.error ?? ""}`;
    default: return `${at} ${e.kind}`;
  }
}

// One normalized line per journal event — a finished replay must line up with
// the journal 1:1 (that is the C7 diff). The journal is only ever read.
function watchRun(runDir, follow) {
  const runId = path.basename(runDir);
  const jp = path.join(runDir, "run.jsonl");
  let offset = 0;
  let partial = "";
  let terminal = false;
  const emit = (text) => {
    const lines = (partial + text).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const ev = normalizeEvent(line, { runId });
      if (!ev) continue;
      if (isTerminal(ev.kind)) terminal = true;
      console.log(watchLine(ev));
    }
  };
  try {
    const buf = fs.readFileSync(jp);
    offset = buf.length;
    emit(buf.toString("utf8"));
  } catch {}
  if (!follow) {
    if (!terminal) console.log(c.dim("(run still going — `--follow` tails it; the router is never involved either way)"));
    return 0;
  }
  console.log(c.dim("(following — Ctrl-C stops)"));
  return new Promise((resolve) => {
    const tick = setInterval(() => {
      let size = 0;
      try { size = fs.statSync(jp).size; } catch { return; }
      if (size !== offset) {
        if (size < offset) { offset = 0; console.log(c.dim("(journal truncated — replaying)")); }
        try {
          const fd = fs.openSync(jp, "r");
          const buf = Buffer.alloc(size - offset);
          fs.readSync(fd, buf, 0, buf.length, offset);
          fs.closeSync(fd);
          offset = size;
          emit(buf.toString("utf8"));
        } catch {}
      }
      if (terminal && fs.existsSync(path.join(runDir, "summary.json"))) {
        clearInterval(tick);
        console.log(c.dim("(run settled)"));
        resolve(0);
      }
    }, 1000);
  });
}

function toDot(graph) {
  const q = (s) => `"${String(s ?? "").replace(/[\\"]/g, " ").replace(/\n/g, " ").slice(0, 80)}"`;
  const color = { plan: "#4f8cc9", criterion: "#3fb950", phase: "#8b949e", run: "#d29922", agent: "#a371f7", part: "#bc8cff", artifact: "#db61a2", gate: "#f85149", commit: "#7a828e", recap: "#39c5cf" };
  const out = [
    "digraph session {",
    "  rankdir=LR;",
    '  node [shape=box style="filled,rounded" fontname="Helvetica" fontsize=10 fontcolor="white"];',
    '  edge [color="#9aa4ae" arrowsize=0.6 fontname="Helvetica" fontsize=8];',
  ];
  // Agents and artifacts cluster under their run; plans, criteria, commits,
  // recaps and the run nodes themselves stay top-level so clusters don't nest.
  const clusters = new Map();
  const loose = [];
  for (const n of graph.nodes) {
    if (n.kind !== "run" && n.run) (clusters.get(`run:${n.run}`) ?? clusters.set(`run:${n.run}`, []).get(`run:${n.run}`)).push(n);
    else loose.push(n);
  }
  for (const n of loose) out.push(`  ${q(n.id)} [label=${q(n.kind === "run" ? (n.workflow ?? n.label) : n.label)} fillcolor="${color[n.kind] ?? "#999"}"];`);
  let i = 0;
  for (const [runId, members] of clusters) {
    out.push(`  subgraph cluster_${i++} {`, `    label=${q(runId)}; style=rounded; color="#9aa4ae";`);
    for (const n of members) out.push(`    ${q(n.id)} [label=${q(n.label)} fillcolor="${color[n.kind] ?? "#999"}"];`);
    out.push("  }");
  }
  for (const e of graph.edges) out.push(`  ${q(e.from)} -> ${q(e.to)} [label=${q(e.kind)}];`);
  out.push("}");
  return out.join("\n");
}

function toArchify(graph, opts = {}) {
  // A publication diagram is one run's story plus the plan spine — the full
  // session dump (380+ nodes) is for the dashboard's DAG, not archify's gated
  // renderer, whose layout solver assumes diagram-sized inputs. --archify-run
  // scopes the candidate to the matching run; without it the full graph goes
  // out and validate is the caller's experiment.
  let nodesSrc = graph.nodes;
  let edgesSrc = graph.edges;
  if (opts.run) {
    const f = String(opts.run).toLowerCase();
    const runNode = graph.nodes.filter((n) => n.kind === "run" && ((n.workflow ?? "").toLowerCase() === f || n.id.toLowerCase().includes(f))).at(-1);
    if (!runNode) throw new Error(`no run matches "${opts.run}" — \`kit workflows graph\` lists what the session holds`);
    // A workflow diagram tells one run's story: plans (with criteria/phases
    // collapsed to one summary node each — a 12-way checkbox fan-out is
    // dashboard/DOT material, not a publication diagram), the run, its agents
    // and artifacts, and the recaps that recorded them.
    const plans = graph.nodes.filter((n) => n.kind === "plan");
    const synth = [];
    const home = new Map(); // collapsed node id -> summary node id
    for (const p of plans) {
      const crits = graph.nodes.filter((n) => n.kind === "criterion" && n.plan === p.label);
      const phases = graph.nodes.filter((n) => n.kind === "phase" && n.plan === p.label);
      if (crits.length) {
        synth.push({ id: `critsum:${p.label}`, kind: "criterion", label: `${p.label} criteria ${crits.filter((c) => c.done).length}/${crits.length} done` });
        for (const c of crits) home.set(c.id, `critsum:${p.label}`);
      }
      if (phases.length) {
        synth.push({ id: `phasesum:${p.label}`, kind: "phase", label: `${p.label} · ${phases.length} phases` });
        for (const ph of phases) home.set(ph.id, `phasesum:${p.label}`);
      }
    }
    const arts = graph.nodes.filter((n) => n.kind === "artifact" && n.run === runNode.label);
    const agents = graph.nodes.filter((n) => n.kind === "agent" && n.run === runNode.label);
    // readable-v2's endpoint stubs cap any node's fan-out well below a real
    // run's agent count — the candidate carries the builders as one counted
    // summary node; per-agent detail stays in the dashboard and the DOT.
    const agentSummaryId = agents.length ? `agents:${runNode.label}` : null;
    const agentSummary = agentSummaryId
      ? [{
          id: agentSummaryId,
          kind: "agent",
          label: `${agents.length} agents · ${agents.reduce((s, a) => s + (a.asks ?? 0), 0)} asks · ${agents.reduce((s, a) => s + (a.toolCalls ?? 0), 0)} tool calls`,
        }]
      : [];
    const recaps = graph.nodes.filter((n) => n.kind === "recap");
    nodesSrc = [...plans, ...synth, runNode, ...agentSummary, ...arts, ...recaps];
    const keep = new Set(nodesSrc.map((n) => n.id));
    const seen = new Set();
    edgesSrc = [];
    for (const e of graph.edges) {
      let from = home.get(e.from) ?? e.from;
      let to = home.get(e.to) ?? e.to;
      if (agentSummaryId && e.kind === "spawns" && String(e.to).startsWith(`agent:${runNode.label}:`)) to = agentSummaryId;
      if (agentSummaryId && e.kind === "produces" && from === runNode.id) from = agentSummaryId;
      if (!keep.has(from) || !keep.has(to) || from === to) continue;
      const key = `${from}|${to}|${e.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edgesSrc.push({ ...e, from, to });
    }
  }
  const LANES = [
    { kinds: ["plan", "criterion", "phase"], lane: { id: "plans", label: "Plans & criteria" } },
    { kinds: ["run"], lane: { id: "runs", label: "Workflow runs" } },
    { kinds: ["agent", "part"], lane: { id: "agents", label: "Agents & parts" } },
    { kinds: ["artifact", "gate"], lane: { id: "deliveries", label: "Artifacts & gates" } },
    { kinds: ["commit", "recap"], lane: { id: "record", label: "Commits & recaps" } },
  ];
  const laneOf = Object.fromEntries(LANES.flatMap((l) => l.kinds.map((k) => [k, l.lane.id])));
  const TYPE = { plan: "cloud", criterion: "security", phase: "messagebus", run: "backend", agent: "frontend", part: "frontend", artifact: "database", gate: "security", commit: "database", recap: "external" };

  // archify ids are [a-zA-Z][a-zA-Z0-9_-]* — graph ids carry colons; sanitize
  // and de-collide. Columns come from a longest-path layering capped at 5.
  const used = new Map();
  const aid = (raw) => {
    let s = String(raw).replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+/, "").slice(0, 60) || "node";
    if (!/^[a-zA-Z]/.test(s)) s = `n${s}`;
    const n = used.get(s) ?? 0;
    used.set(s, n + 1);
    return n ? `${s}-${n}` : s;
  };
  const indeg = new Map(nodesSrc.map((n) => [n.id, 0]));
  const outs = new Map(nodesSrc.map((n) => [n.id, []]));
  for (const e of edgesSrc) {
    if (outs.has(e.from) && indeg.has(e.to)) { outs.get(e.from).push(e.to); indeg.set(e.to, indeg.get(e.to) + 1); }
  }
  const col = new Map();
  let frontier = nodesSrc.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  for (const id of frontier) col.set(id, 0);
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      for (const to of outs.get(id)) {
        col.set(to, Math.min(5, Math.max(col.get(to) ?? 0, (col.get(id) ?? 0) + 1)));
        indeg.set(to, indeg.get(to) - 1);
        if (indeg.get(to) === 0) next.push(to);
      }
    }
    frontier = next;
  }
  const idMap = new Map();
  const nodes = nodesSrc.map((n) => {
    const id = aid(n.id);
    idMap.set(n.id, id);
    return {
      id,
      lane: laneOf[n.kind] ?? "record",
      col: col.get(n.id) ?? 0,
      type: TYPE[n.kind] ?? "backend",
      label: String(n.label ?? n.id).slice(0, 40) || String(n.id),
      sublabel: n.kind,
    };
  });
  // archify stacks by lane+column; without an explicit yOffset co-located
  // nodes overlap and the layout gate rejects the candidate. Width follows
  // the label (archify measures ~7px per character at its default font).
  const stack = new Map();
  for (const nd of nodes) {
    const k = `${nd.lane}|${nd.col}`;
    const i = stack.get(k) ?? 0;
    stack.set(k, i + 1);
    nd.yOffset = i * 90;
    nd.width = Math.min(360, Math.max(96, nd.label.length * 7.5 + 30));
    stack.set(nd.id, i); // per-node stack row, for edge-corridor ordering
  }
  // The showcase gate rejects same-source edges that cross: give each source's
  // fan-out monotonic corridors ordered by its targets' visual rows.
  const bySource = new Map();
  for (const [i, e] of edgesSrc.entries()) {
    const from = idMap.get(e.from);
    const to = idMap.get(e.to);
    if (!from || !to || from === to) continue;
    (bySource.get(from) ?? bySource.set(from, []).get(from)).push({ i, to, row: stack.get(to) ?? 0, col: col.get(e.to) ?? 0 });
  }
  const biasOf = new Map();
  for (const group of bySource.values()) {
    group.sort((a, b) => (a.col - b.col) || (a.row - b.row));
    group.forEach((g, rank) => biasOf.set(g.i, group.length > 1 ? 0.15 + (0.7 * rank) / (group.length - 1) : 0.5));
  }
  const edges = [];
  for (const [i, e] of edgesSrc.entries()) {
    const from = idMap.get(e.from);
    const to = idMap.get(e.to);
    if (!from || !to || from === to) continue;
    const edge = { id: `e${i}`, from, to, label: String(e.kind ?? "") };
    if (biasOf.has(i)) edge.bias = Math.round(biasOf.get(i) * 100) / 100;
    edges.push(edge);
  }
  return {
    schema_version: 2,
    diagram_type: "workflow",
    meta: { title: "Workflow session graph", output: "out/workflow-session.html", quality_profile: "showcase" },
    lanes: LANES.map((l) => l.lane),
    nodes,
    edges,
  };
}

/**
 * kit workflows — the shipped library.
 *   kit workflows list                      what ships, and what each one takes
 *   kit workflows run <name> --args '{...}' run one; agents route through the router
 *   kit workflows last                      the most recent run's outcome
 *   kit workflows watch [runId] [--follow]  replay a journal — one line per event, no router
 *   kit workflows graph [--dot] [--archify f [--archify-run name]]  session graph: counts, DOT, archify candidate
 */
export async function cmdWorkflows(flags, positional) {
  const sub = positional[0] ?? "list";
  const { runWorkflow } = await import("workflow-plane/engine.mjs");
  const library = readLibrary(KIT_WORKFLOWS_DIR);
  const { roster } = loadAndResolve();

  if (sub === "list") {
    if (!library.length) {
      console.log(c.warn(`no workflows in ${KIT_WORKFLOWS_DIR}`));
      return 1;
    }
    console.log(`${"workflow".padEnd(24)}${"arg".padEnd(12)}description`);
    for (const wf of library) {
      const specs = Object.entries(wf.meta.args ?? {});
      const firstArg = specs.find(([, s]) => s.required)?.[0] ?? specs[0]?.[0] ?? "—";
      console.log(`${wf.name.padEnd(24)}${firstArg.padEnd(12)}${(wf.meta.description || wf.meta.whenToUse || "(no header)").slice(0, 90)}`);
    }
    console.log(c.dim(`run one: \`kit workflows run <name> --args '{"<arg>":"..."}'\``));
    return 0;
  }

  if (sub === "last") {
    const dir = KIT_WORKFLOW_RUNS();
    const runs = fs.existsSync(dir) ? fs.readdirSync(dir).sort().reverse() : [];
    if (!runs.length) {
      console.log(c.dim("no runs yet"));
      return 0;
    }
    const summaryPath = path.join(dir, runs[0], "summary.json");
    if (!fs.existsSync(summaryPath)) {
      console.log(c.dim(`${runs[0]}: no summary (the run may still be going)`));
      return 0;
    }
    const s = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    console.log(`${s.ok ? c.ok("") : c.fail("")} ${s.name} — ${s.durationMs}ms, ${s.agentCalls} agent calls, ${s.reports} reports`);
    console.log(`  ${s.result?.conclusion ?? s.error ?? "(no conclusion)"}`);
    console.log(`  journal: ${s.journal}`);
    return s.ok ? 0 : 1;
  }

  if (sub === "run") {
    const name = positional[1];
    if (!name) {
      console.log(c.fail(`usage: kit workflows run <name> --args '{"<arg>":"..."}' [--answers '{"<topic>":"<answer>"}'] [--grant package,net-fetch] [--allow-domain example.com] [--max-rounds N] [--compact-tokens N]`));
      return 1;
    }
    const wf = library.find((w) => w.name === name);
    const file = wf?.file ?? (fs.existsSync(name) ? name : null);
    if (!file) {
      console.log(c.fail(`no workflow named "${name}" — \`kit workflows list\` shows what ships`));
      return 1;
    }
    let args = {};
    if (flags.args) {
      try {
        args = JSON.parse(flags.args);
      } catch (e) {
        console.log(c.fail(`--args is not valid JSON: ${e.message}`));
        return 1;
      }
    }
    // The owner-answer table: escalation topics (the structured ones builders
    // send) match a key here deterministically before any no-owner default.
    let answers = {};
    if (flags.answers) {
      try {
        answers = JSON.parse(String(flags.answers));
      } catch (e) {
        console.log(c.fail(`--answers is not valid JSON: ${e.message}`));
        return 1;
      }
    }
    const port = roster?.router?.port ?? 8300;
    const token = roster?.router?.localToken ?? "local-auto-router";
    const workdir = flags.workdir ? path.resolve(String(flags.workdir)) : process.cwd();
    const t0 = Date.now();
    console.log(c.dim(`${name} — ${workdir}`));
    try {
      const { summary, result } = await runWorkflow(file, {
        args,
        workdir,
        baseUrl: `http://127.0.0.1:${port}`,
        token,
        model: flags.model ? String(flags.model) : undefined,
        allowCommands: flags.allowCmd ? [String(flags.allowCmd)] : [],
        grants: flags.grant ? String(flags.grant) : "",
        netDomains: flags.allowDomain
          ? String(flags.allowDomain).split(",").map((s) => s.trim()).filter(Boolean)
          : [],
        // The search backend's key resolves from the runtime .env here, at the
        // boundary; the plane sees only the declared name's value.
        search: {
          backend: "firecrawl",
          apiKeyEnv: "FIRECRAWL_API_KEY",
          envMap: { FIRECRAWL_API_KEY: readEnvFile(ENV_FILE).FIRECRAWL_API_KEY },
          scrapeBaseUrl: readEnvFile(ENV_FILE).FIRECRAWL_SCRAPE_URL,
          scrapeApiVersion: readEnvFile(ENV_FILE).FIRECRAWL_SCRAPE_VERSION,
        },
        answers,
        agentMaxRounds: flags.maxRounds ? Number(flags.maxRounds) : undefined,
        // The prompt size at which the plane compacts an agent's history. A
        // provider with a small window needs a tighter line than the default,
        // and a run that wants compaction off says 0.
        compactTokens: flags.compactTokens ? Number(flags.compactTokens) : undefined,
        onEvent: (e) => {
          if (e.kind === "phase") console.log(c.dim(`── ${e.phase}`));
          else if (e.kind === "log") console.log(c.dim(`   ${e.message}`));
          else if (e.kind === "report") console.log(c.dim(`   · ${summarize(e.item)}`));
          else if (e.kind === "warn") console.log(c.warn(e.message));
          else if (e.kind === "escalation")
            console.log(
              e.op === "resolved"
                ? c.dim(`   escalation resolved from ${e.source}${e.matched ? ` (matched: ${e.matched})` : ""}`)
                : c.warn(`escalated: ${e.question}`)
            );
        },
      });
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      const tk = summary.tokens ?? { promptTokens: 0, completionTokens: 0 };
      console.log(
        c.ok(
          `${name} finished in ${secs}s — ${summary.agentCalls} agent calls, ${summary.phases.length} phases` +
            ` — ${fmtTokens(tk.promptTokens)} in / ${fmtTokens(tk.completionTokens)} out`,
        ),
      );
      if (result?.conclusion) console.log(`  ${result.conclusion}`);
      for (const a of summary.artifacts) {
        const v = a.versions.length;
        console.log(`  artifact: ${a.id} (v${v}) → ${path.join(summary.runDir, "artifacts", a.id, `v${v}`)}`);
      }
      console.log(c.dim(`journal: ${summary.journal}`));
      return 0;
    } catch (e) {
      console.log(c.fail(`${name} failed: ${e.message}`));
      const dir = e?.runDir ?? path.join(KIT_WORKFLOW_RUNS(), name);
      const journal = path.join(dir, "run.jsonl");
      console.log(
        fs.existsSync(journal)
          ? c.dim(`journal: ${journal}`)
          : c.dim(`no journal — this run never started (${path.basename(dir)} was never created)`),
      );
      return 1;
    }
  }

  if (sub === "watch") {
    const dir = KIT_WORKFLOW_RUNS();
    const runs = fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, "run.jsonl"))).sort() : [];
    let runId = positional[1];
    if (!runId) {
      if (!runs.length) {
        console.log(c.warn("no workflow runs to watch yet"));
        return 0;
      }
      runId = runs.at(-1);
      console.log(c.dim(`no run given — watching the latest: ${runId}`));
    } else if (!runs.includes(runId)) {
      console.log(c.fail(`no journal for "${runId}" under ${dir}`));
      return 1;
    }
    return watchRun(path.join(dir, runId), Boolean(flags.follow));
  }

  if (sub === "graph") {
    const graph = buildGraph({
      kitHome: path.dirname(KIT_WORKFLOW_RUNS()),
      repoRoot: process.env.AGNOSTIC_ROUTER_KIT_REPO_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    });
    if (flags.dot) {
      console.log(toDot(graph));
      return 0;
    }
    if (flags.archify) {
      const out = path.resolve(String(flags.archify));
      const candidate = toArchify(graph, { run: flags.archifyRun });
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify(candidate, null, 2) + "\n");
      console.log(c.ok(`archify workflow candidate → ${out} (${candidate.nodes.length} nodes, ${candidate.edges.length} edges)${flags.archifyRun ? ` · run: ${flags.archifyRun}` : " · full session"}`));
      console.log(c.dim(`gate it: archify validate workflow ${out} --json`));
      return 0;
    }
    console.log(`session graph — ${graph.counts.nodes} nodes, ${graph.counts.edges} edges`);
    console.log(c.dim(`kit  ${graph.kitHome}`));
    console.log(c.dim(`repo ${graph.repoRoot}`));
    for (const [kind, n] of Object.entries(graph.counts.byKind)) console.log(c.dim(`${kind.padEnd(10)} ${n}`));
    console.log(c.dim("export: --dot (stdout) · --archify <file.json> (archify workflow candidate)"));
    return 0;
  }

  console.log(c.fail(`unknown workflows subcommand "${sub}" (list|run|last|watch|graph)`));
  return 1;
}

function summarize(item) {
  if (item === null || item === undefined) return String(item);
  if (typeof item === "string") return item.slice(0, 120);
  const parts = [];
  for (const k of ["what", "where", "problem", "winner", "hypothesis", "cause"]) {
    if (item[k]) parts.push(String(item[k]).slice(0, 100));
  }
  return (parts.length ? parts.join(" — ") : JSON.stringify(item)).slice(0, 140);
}

export async function cmdRoute(flags, positional) {
  const task = positional.join(" ").trim();
  if (!task) {
    console.log(c.fail('usage: kit route "the task you want a verdict for"'));
    return 1;
  }
  const { roster, error } = loadAndResolve();
  if (error) return void console.log(c.fail(error)), 1;
  const port = roster.router?.port ?? 8300;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/route`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${roster.router?.localToken ?? "local-auto-router"}` },
      body: JSON.stringify({ task }),
      signal: AbortSignal.timeout(30000),
    });
    const v = await r.json();
    console.log(`workload:   ${v.workload}`);
    console.log(`execution:  ${v.execution}`);
    console.log(`target:     ${v.target ? `${v.target.providerId}/${v.target.model}` : "(none)"}`);
    for (const a of v.assignments ?? []) console.log(`assignment: ${a.name} (arg ${JSON.stringify(Object.keys(a.args ?? {}))})`);
    if (!(v.assignments ?? []).length) console.log("assignment: none");
    console.log(`conf:       ${v.conf ?? "—"}`);
    console.log(`reason:     ${v.reason ?? "—"}`);
    return 0;
  } catch (e) {
    console.log(c.fail(`router unreachable on 127.0.0.1:${port}: ${e.message}`));
    return 1;
  }
}

export async function cmdUpgrade() {
  const { execFileSync } = await import("node:child_process");
  console.log(c.dim("git pull…"));
  try {
    console.log(execFileSync("git", ["pull", "--ff-only"], { cwd: KIT_DIR, encoding: "utf8" }).trim());
  } catch (e) {
    console.log(c.fail(`git pull failed: ${e.stderr ?? e.message}`));
    return 1;
  }
  return cmdApply({});
}

/**
 * kit quickstart — the guided install.
 *
 * Seven small steps in the exact order the README documents the manual path:
 * node check, both installs, roster, keys, dry run, apply, doctor. Two rules
 * keep it honest. Every step IS the existing command or the same write the
 * existing command performs (same writeJson/writeEnvFile calls), so the
 * artifacts are byte-identical to the manual path and the terminal tells a
 * power user exactly what ran. And every step checks before it acts, so an
 * interrupted run resumes: re-running skips what is already done.
 *
 * Non-interactive (`--yes`, or no TTY): defaults everywhere, key prompts
 * skipped with a pointer to /setup — a wizard that cannot run scripted
 * cannot be probed, so it never got shipped.
 */
export async function cmdQuickstart(flags) {
  const { execFileSync } = await import("node:child_process");
  const { ask, askSecret, confirm, isInteractive } = await import("./prompt.mjs");
  const yes = Boolean(flags.yes ?? flags.nonInteractive);
  const force = Boolean(flags.force);
  const skipInstall = Boolean(flags.skipInstall);
  // Scratch-home probes, Windows, and (later) the desktop app all need a
  // service-less pass: the desktop app owns the router process itself, and a
  // probe must never touch a real machine's launchd/systemd unit.
  const skipService = Boolean(flags.skipService);
  const applyFlags = skipService ? { only: "router" } : {};
  const doctorFlags = skipService ? { noService: true } : {};
  const step = (i, title) => console.log(c.head(`${i}/7 · ${title}`));
  const note = (s) => console.log(c.dim(`  ${s}`));

  console.log(`\nagnostic-router-kit ${KIT_VERSION} — quickstart\n`);
  console.log("I'll set everything up: dependencies, your roster and keys, the router");
  console.log("itself, and a health check. Each step is a command you could also run");
  console.log("by hand (it prints as it goes). Ctrl-C any time — run this again and");
  console.log("it picks up where it left off.\n");
  if (yes) note("non-interactive: defaults everywhere, prompts skipped\n");

  // 0. already set up? A healthy install re-running this command is more
  // likely a stray second invocation than an intent to redo the work.
  const existingRoster = fs.existsSync(ROSTER_PATH) ? loadRoster(ROSTER_PATH) : null;
  const cfgPath = path.join(ROUTER_DIR, "config.json");
  if (!force && existingRoster && fs.existsSync(cfgPath)) {
    const p0 = existingRoster.router?.port ?? 8300;
    if (await health(p0)) {
      if (yes || !isInteractive()) {
        console.log(c.ok(`your router is already up and healthy on http://127.0.0.1:${p0} — nothing to do`));
        console.log(c.dim(`chat with it at http://127.0.0.1:${p0}/chat · re-run anyway: kit quickstart --force`));
        return 0;
      }
      const again = await confirm(`your router is already up and healthy on 127.0.0.1:${p0} — re-run the setup steps anyway?`, { def: false });
      if (!again) {
        console.log(c.ok("nothing touched — see you at the dashboard"));
        return 0;
      }
    }
  }

  // 1. node
  step(1, "checking node");
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) {
    console.log(c.fail(`node ${process.versions.node} is too old — the kit needs 20 or newer`));
    console.log(c.dim("install a current LTS from https://nodejs.org (or via nvm/brew) and run kit quickstart again"));
    return 1;
  }
  console.log(c.ok(`node ${process.versions.node}`));

  // 2. dependencies — npm output is noise for a new user; the command line
  // prints so a power user can see exactly what ran.
  step(2, "installing dependencies");
  if (skipInstall) {
    note("skipped (--skip-install)");
  } else {
    const install = async (args, cwd, done, skip) => {
      if (fs.existsSync(skip)) {
        console.log(c.ok(done));
        return true;
      }
      note(`running: (cd ${tilde(cwd)} && npm ${args.join(" ")})`);
      try {
        execFileSync("npm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        console.log(c.ok("installed"));
        return true;
      } catch (e) {
        const tail = String(e.stderr ?? e.stdout ?? e.message).trim().split("\n").slice(-4).join("\n  ");
        console.log(c.fail(`npm ${args[0]} failed — ${tail}`));
        return false;
      }
    };
    const okRoot = await install(["install"], KIT_DIR, "kit dependencies already installed", path.join(KIT_DIR, "node_modules", "workflow-plane"));
    const okRouter = await install(["install", "--omit=dev"], KIT_ROUTER_DIR, "router dependencies already installed", path.join(KIT_ROUTER_DIR, "node_modules", "@typesafe-ai"));
    if (!okRoot || !okRouter) {
      console.log(c.fail("fix the install error above and run kit quickstart again"));
      return 1;
    }
  }

  // 3. roster — keep what is there; a machine has one roster and overwriting
  // an edited one from a wizard would be data loss dressed as convenience.
  step(3, "your roster");
  let roster;
  if (fs.existsSync(ROSTER_PATH)) {
    roster = loadRoster(ROSTER_PATH);
    console.log(c.ok(`keeping your roster at ${tilde(ROSTER_PATH)}`));
  } else {
    roster = parseJsonc(fs.readFileSync(path.join(KIT_TEMPLATES_DIR, "roster.defaults.json"), "utf8"));
    writeJson(ROSTER_PATH, roster);
    console.log(c.ok(`wrote the starter roster to ${tilde(ROSTER_PATH)}`));
  }
  note("it is plain JSON — edit it any time, then kit apply");

  // 4. keys — only the ones the roster names that do not resolve yet. Enter
  // skips; nothing is echoed; values land in the runtime .env (chmod 600)
  // through the same writeEnvFile `kit env set` uses.
  step(4, "your keys");
  const cur = readEnvFile(ENV_FILE);
  const wanted = [];
  for (const [id, p] of Object.entries(roster.providers ?? {})) {
    if (p.apiKeyEnv) wanted.push({ name: p.apiKeyEnv, why: `${p.providerName ?? id} — routes this provider's models` });
  }
  if (roster.typesafe?.apiKeyEnv) wanted.push({ name: roster.typesafe.apiKeyEnv, why: "the judge (Jev) — picks the right workload for each request" });
  if (roster.judge?.fastino?.apiKeyEnv) wanted.push({ name: roster.judge.fastino.apiKeyEnv, why: "the sys1 judge leg (cascade mode)" });
  const missing = wanted.filter((w) => !cur[w.name]);
  if (!missing.length) {
    console.log(c.ok("every key the roster names is already set"));
  } else {
    note("the router only routes targets whose key resolves — skipping is fine, keys can be added later");
    const added = { ...cur };
    let n = 0;
    for (const w of missing) {
      if (yes) {
        note(`skipped ${w.name} (non-interactive) — add it later: kit env set ${w.name}=…`);
        continue;
      }
      const v = await askSecret(`  ${w.name} — ${w.why}\n  paste it (Enter to skip)`);
      if (v) {
        added[w.name] = v;
        n++;
      } else {
        note(`skipped ${w.name}`);
      }
    }
    if (n) {
      writeEnvFile(ENV_FILE, added, { header: renderEnvHeader(roster, { envMissing: [] }) });
      console.log(c.ok(`saved ${n} key${n === 1 ? "" : "s"} to ${tilde(ENV_FILE)} (chmod 600) — they never leave this machine`));
    }
  }

  // 5. dry run — the house rule: nothing renders before a dry run says it can.
  step(5, skipService ? "dry run (renders the runtime, writes nothing — no service)" : "dry run (renders the runtime, writes nothing)");
  if ((await cmdApply({ dryRun: true, ...applyFlags })) !== 0) {
    console.log(c.fail("the dry run found problems (above). Nothing was written — fix them and run kit quickstart again."));
    return 1;
  }

  // 6. apply — the real thing: runtime + service + health check.
  step(6, skipService ? "installing the router runtime (you or the desktop app start the process)" : "installing and starting the router");
  const applyRc = await cmdApply(applyFlags);
  if (applyRc !== 0 && skipService) {
    note(`start it when ready: node ${tilde(path.join(ROUTER_DIR, "server.js"))}`);
  }

  // 7. doctor — green or it didn't happen; even after a rough apply it shows
  // exactly which check to fix.
  step(7, "checking your setup (kit doctor)");
  const doctorRc = await cmdDoctor(doctorFlags);

  const port = roster.router?.port ?? 8300;
  let token = roster.router?.localToken ?? "local-auto-router";
  try {
    token = JSON.parse(fs.readFileSync(cfgPath, "utf8")).router?.localToken ?? token;
  } catch {}
  console.log(c.head("try it"));
  if (skipService) console.log(c.dim(`  once the router is running (node ${tilde(path.join(ROUTER_DIR, "server.js"))}):`));
  console.log(c.dim(`  curl -s http://127.0.0.1:${port}/v1/models -H "Authorization: Bearer ${token}"`));
  console.log("");
  console.log(c.ok(`chat with your router:   http://127.0.0.1:${port}/chat`));
  console.log(c.ok(`finish setup in browser: http://127.0.0.1:${port}/setup`));
  console.log(c.dim(`dashboard:               http://127.0.0.1:${port}/dashboard`));
  console.log(c.dim(`any OpenAI-compatible client: base URL http://127.0.0.1:${port}/v1 — model "auto" routes by task`));
  return applyRc === 0 && doctorRc === 0 ? 0 : 1;
}

/**
 * kit memory — the durable memory plane's CLI.
 *
 * The store is one JSONL graph in the official MCP memory server's format;
 * every command here reads or atomically rewrites that file. import is the
 * bridge from other stores: mnemosyne's export (curated tiers only — the
 * auto-extracted rows are noise by rule, not by judgment) and any graph file
 * already in the official format.
 */
export async function cmdMemory(flags, positional) {
  const sub = positional[0] ?? "stats";
  const file = memoryStorePath();

  if (sub === "config") {
    console.log("Point any MCP harness at the kit's durable memory:");
    console.log(JSON.stringify({
      mcpServers: {
        memory: {
          type: "stdio",
          command: "node",
          args: [path.join(KIT_DIR, "bin", "agnostic-router-memory.mjs")],
          env: { MEMORY_FILE_PATH: file },
        },
      },
    }, null, 2));
    console.log(c.dim("the store: " + file + " — created lazily on first write"));
    return 0;
  }

  if (sub === "stats") {
    const g = loadGraph(file);
    const s = memoryStats(g);
    console.log(`memory store: ${file}`);
    console.log(`  entities:    ${s.entities}`);
    console.log(`  relations:   ${s.relations}`);
    console.log(`  observations:${s.observations}`);
    for (const [t, n] of Object.entries(s.byType).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      console.log(c.dim(`    ${t}: ${n}`));
    }
    return 0;
  }

  if (sub === "search") {
    const q = positional.slice(1).join(" ");
    if (!q) {
      console.log(c.fail("usage: kit memory search <query>"));
      return 1;
    }
    const hits = searchGraph(loadGraph(file), q, { limit: Number(flags.limit) || 10 });
    if (!hits.length) {
      console.log(c.dim(`nothing remembered for "${q}"`));
      return 0;
    }
    for (const e of hits) {
      console.log(`${e.entityType === "memory" ? "·" : c.ok(e.entityType)} ${e.name}`);
      for (const o of e.observations.slice(0, 2)) console.log(c.dim(`    ${o.slice(0, 140)}`));
    }
    return 0;
  }

  if (sub === "gc") {
    const dry = Boolean(flags.dryRun ?? flags.dry);
    const g = loadGraph(file);
    const { before, after } = gcGraph(g);
    const delta = (k) => (before[k] === after[k] ? `${before[k]}` : `${before[k]} → ${after[k]}`);
    console.log(`entities: ${delta("entities")} · relations: ${delta("relations")} · observations: ${delta("observations")}`);
    if (dry) console.log(c.warn("dry run — nothing written"));
    else {
      saveGraph(g, file);
      console.log(c.ok("gc done"));
    }
    return 0;
  }

  if (sub === "import") {
    const from = flags.from;
    const src = flags.file;
    const dry = Boolean(flags.dryRun ?? flags.dry);
    if (!from || !src) {
      console.log(c.fail("usage: kit memory import --from mnemosyne|official --file <path> [--dry-run]"));
      return 1;
    }
    if (!fs.existsSync(src)) {
      console.log(c.fail(`no such file: ${src}`));
      return 1;
    }
    const graph = loadGraph(file);
    let added = { entities: 0, relations: 0 };
    if (from === "official") {
      const incoming = loadGraph(src);
      const r = createEntities(graph, incoming.entities);
      added.entities = r.added.length;
      added.relations = createRelations(graph, incoming.relations).added.length;
    } else if (from === "mnemosyne") {
      // The curation rule: durable memories and graph triples only. The
      // auto-extracted tiers (consolidated_facts, memoria_facts) and the
      // session-scoped working memory are noise at graph scale — skipped by
      // rule so the durable store stays clean.
      const d = JSON.parse(fs.readFileSync(src, "utf8"));
      const entities = (d.legacy_memories ?? []).map((m) => ({
        name: `${m.content.trim().slice(0, 56)} [${String(m.id).slice(0, 8)}]`,
        entityType: m.source || "memory",
        observations: [m.content.trim(), `recorded: ${String(m.timestamp).slice(0, 10)}`],
      }));
      const known = new Set(entities.map((e) => e.name));
      const relations = (d.triples ?? []).map((t) => ({ from: t.subject, to: t.object, relationType: t.predicate }));
      const r = createEntities(graph, entities);
      added.entities = r.added.length;
      for (const rel of relations) {
        if (!known.has(rel.from)) graph.entities.push({ name: rel.from, entityType: "concept", observations: [] });
        if (!known.has(rel.to)) graph.entities.push({ name: rel.to, entityType: "concept", observations: [] });
      }
      added.relations = createRelations(graph, relations).added.length;
    } else {
      console.log(c.fail(`unknown source "${from}" (mnemosyne | official)`));
      return 1;
    }
    console.log(`would add ${added.entities} entities, ${added.relations} relations`);
    if (dry) {
      console.log(c.warn("dry run — nothing written"));
    } else {
      saveGraph(graph, file);
      console.log(c.ok(`imported into ${file} — now ${graph.entities.length} entities, ${graph.relations.length} relations`));
    }
    return 0;
  }

  if (sub === "remember") {
    const text = positional.slice(1).join(" ");
    if (flags.triple) {
      const parts = String(flags.triple).trim().split(/\s+/);
      const [subject, predicate] = parts;
      const object = parts.slice(2).join(" ");
      if (!subject || !predicate || !object) { console.log(c.fail('--triple needs: --triple "subject predicate object"')); return 1; }
      const graph = loadGraph(file);
      const r = addTriple(graph, { subject, predicate, object, source: "cli" });
      saveGraph(graph, file);
      console.log(c.ok(`temporal triple ${r.triple.id.slice(0, 14)} — any earlier open ${subject} ${predicate} is now closed`));
      return 0;
    }
    if (flags.fact) {
      const parts = String(flags.fact).trim().split(/\s+/);
      const [subject, predicate] = parts;
      const object = parts.slice(2).join(" ");
      if (!subject || !predicate || !object) { console.log(c.fail("--fact needs: --fact \"subject predicate object\" (quoted)")); return 1; }
      const graph = loadGraph(file);
      const r = addFact(graph, { subject, predicate, object, veracity: flags.veracity, source: "cli" });
      saveGraph(graph, file);
      console.log(c.ok(`fact ${r.fact.id.slice(0, 14)} — confidence ${Math.round((r.fact.confidence ?? 0.5) * 100)}%, mentioned ${r.fact.mentionCount}×`));
      for (const cf of r.conflicts) console.log(c.warn(`conflict: ${cf.id?.slice(0, 14)} disagrees on "${subject} ${predicate}" → kit memory facts --conflicts`));
      return 0;
    }
    if (!text) { console.log(c.fail("usage: kit memory remember <text> [--importance 0.8] [--veracity stated] [--extract] [--scope session:x]")); return 1; }
    const graph = loadGraph(file);
    const entity = {
      name: text.slice(0, 56),
      entityType: "memory",
      observations: [text],
      ...(flags.importance !== undefined ? { importance: Number(flags.importance) } : {}),
      ...(flags.veracity !== undefined ? { veracity: String(flags.veracity) } : {}),
      ...(flags.scope !== undefined ? { scope: String(flags.scope) } : {}),
      source: "cli",
    };
    if (flags.extract) entity.mentions = extractMentions(text);
    const r = createEntities(graph, [entity]);
    saveGraph(graph, file);
    console.log(c.ok(r.added.length ? `remembered: ${text.slice(0, 60)}` : "already remembered (name exists — /recall or kit memory search it)"));
    return 0;
  }

  if (sub === "scratch") {
    const op = positional[1];
    const session = flags.session ?? "default";
    if (op === "add") {
      const text = positional.slice(2).join(" ");
      if (!text) { console.log(c.fail("usage: kit memory scratch add <text>")); return 1; }
      const graph = loadGraph(file);
      addScratch(graph, { session, text, source: "cli", importance: flags.importance ? Number(flags.importance) : 0.4 });
      saveGraph(graph, file);
      console.log(c.ok(`scratched (session ${session}, expires in 24h — consolidate to keep) `));
      return 0;
    }
    if (op === "list" || !op) {
      const graph = loadGraph(file);
      const rows = graph.entities.filter((e) => e.scope === `session:${session}` && !e.supersededBy);
      if (!rows.length) { console.log(c.dim(`(nothing scratched in session ${session})`)); return 0; }
      for (const r of rows) console.log(`  ${r.observations[0]?.slice(0, 110)}${r.validUntil ? c.dim(`  · expires ${r.validUntil.slice(0, 16).replace("T", " ")}`) : ""}`);
      return 0;
    }
    if (op === "clear") {
      const graph = loadGraph(file);
      const dead = graph.entities.filter((e) => e.scope === `session:${session}` && e.entityType === "working").map((e) => e.name);
      const { removed } = deleteEntities(graph, dead);
      saveGraph(graph, file);
      console.log(c.ok(`cleared ${removed} scratch rows (session ${session})`));
      return 0;
    }
    console.log(c.fail("usage: kit memory scratch add <text> | list | clear"));
    return 1;
  }

  if (sub === "facts") {
    const graph = loadGraph(file);
    const facts = graph.relations.filter((r) => r.id);
    if (flags.conflicts) {
      const conflicts = detectConflicts(graph);
      if (!conflicts.length) { console.log(c.ok("no conflicts — every subject+predicate agrees")); return 0; }
      for (const cf of conflicts) {
        console.log(c.warn(`conflict on "${cf.subject} ${cf.predicate}" — winner ${cf.winner.slice(0, 14)}`));
        for (const l of cf.losers) console.log(c.dim(`    loser: ${l} → resolve: kit memory resolve ${l} ${cf.winner}`));
      }
      return conflicts.length ? 1 : 0;
    }
    if (!facts.length) { console.log(c.dim("(no facts yet — kit memory remember --fact s p o, or an agent with the memory grant)")); return 0; }
    for (const f of facts) {
      const dead = f.supersededBy ? c.dim(" (superseded)") : f.validUntil && Date.parse(f.validUntil) <= Date.now() ? c.dim(" (expired)") : "";
      console.log(`  ${f.from} —${f.relationType}→ ${f.to}${dead}`);
      console.log(c.dim(`    confidence ${Math.round((f.confidence ?? 0.5) * 100)}% · mentioned ${f.mentionCount ?? 1}× · veracity ${f.veracity ?? "unknown"} · ${f.id}`));
    }
    return 0;
  }

  if (sub === "consolidate") {
    const dry = Boolean(flags.dryRun ?? flags.dry);
    const session = flags.session ?? "default";
    const graph = loadGraph(file);
    const { summarize } = await import("./memory-summarize.mjs");
    const eligible = graph.entities.filter((e) => e.scope === `session:${session}` && e.entityType === "working" && !e.consolidatedOf);
    if (!eligible.length) { console.log(c.dim(`(nothing to consolidate in session ${session})`)); return 0; }
    const summaries = {};
    if (!dry) {
      const bySource = new Map();
      for (const e of eligible) {
        const k = e.source ?? "scratch";
        if (!bySource.has(k)) bySource.set(k, []);
        bySource.get(k).push(e.observations[0] ?? "");
      }
      for (const [source, lines] of bySource) {
        summaries[source] = await summarize(lines, { port: 8300 });
      }
    }
    const r = consolidate(graph, { session, summaries });
    const shown = r.digests.map((d) => d.observations[0].slice(0, 90)).join("\n  ");
    console.log(`${r.count} scratch rows → ${r.digests.length} digest(s):\n  ${shown}`);
    if (dry) console.log(c.warn("dry run — nothing written"));
    else {
      saveGraph(graph, file);
      console.log(c.ok(`consolidated — the originals stay, the digests carry consolidatedOf`));
    }
    return 0;
  }

  if (sub === "resolve") {
    const [loser, winner] = positional.slice(1);
    if (!loser || !winner) { console.log(c.fail("usage: kit memory resolve <loserId> <winnerId>")); return 1; }
    const graph = loadGraph(file);
    resolveConflict(graph, loser, winner);
    saveGraph(graph, file);
    console.log(c.ok(`superseded ${loser.slice(0, 14)} → ${winner.slice(0, 14)}`));
    return 0;
  }

  if (sub === "invalidate") {
    const name = positional.slice(1).join(" ");
    if (!name) { console.log(c.fail("usage: kit memory invalidate <entity or fact id>")); return 1; }
    const graph = loadGraph(file);
    try {
      invalidate(graph, name, { supersededBy: flags.supersededBy ? String(flags.supersededBy) : undefined });
    } catch (e) {
      console.log(c.fail(e.message));
      return 1;
    }
    saveGraph(graph, file);
    console.log(c.ok(`invalidated ${name.slice(0, 40)}`));
    return 0;
  }

  console.log(c.fail(`unknown memory subcommand "${sub}" (stats | search | remember | scratch | facts | consolidate | resolve | invalidate | config | gc | import)`));
  return 1;
}

const COMMANDS = {
  quickstart: cmdQuickstart,
  memory: cmdMemory,
  status: cmdStatus,
  init: cmdInit,
  env: cmdEnv,
  apply: cmdApply,
  doctor: cmdDoctor,
  route: cmdRoute,
  export: cmdExport,
  workflows: cmdWorkflows,
  upgrade: cmdUpgrade,
  help: cmdHelp,
};

// One line per command, in the order `kit help` prints them. The header block
// above is the long form; this is what a new user actually reads first, so it
// is keyed separately rather than parsed out of a doc comment.
const USAGE = {
  quickstart: "guided install — asks a few questions, runs every step (try this first)",
  memory: "the durable memory plane — stats, search, config, gc, import",
  status: "what is installed, and where",
  init: "write a starter roster to edit (--template)",
  env: "manage the runtime .env — set, list, unset (chmod 600)",
  apply: "render the runtime and (re)start the service (--dry-run, --only router|service)",
  doctor: "verify the whole chain, change nothing (--live)",
  route: "ask the running router for its verdict on a task",
  export: "derive a key-free roster from the live router config",
  workflows: "the shipped workflow library — list, run, last, watch, graph",
  upgrade: "git pull + apply",
  help: "this",
};

function usageBody() {
  console.log("commands:");
  for (const [name, fn] of Object.entries(COMMANDS)) {
    if (!(name in USAGE)) continue;
    console.log(`  kit ${name.padEnd(11)} ${USAGE[name]}`);
  }
  console.log("\nforms:");
  console.log("  kit quickstart [--yes] [--force] [--skip-install] [--skip-service]");
  console.log("  kit memory stats | search <q> | remember <text> [--fact \"s p o\"] [--extract]");
  console.log("  kit memory scratch add|list|clear · facts [--conflicts] · consolidate [--dry-run] · resolve · invalidate");
  console.log("  kit memory config | gc [--dry-run] | import --from mnemosyne|official --file f");
  console.log("  kit status [--json]");
  console.log("  kit init --template [--out roster.json]");
  console.log("  kit env set K=V … | kit env list | kit env unset K");
  console.log("  kit apply [--dry-run] [--only router|service]");
  console.log("  kit doctor [--live] [--no-service]");
  console.log("  kit route \"task…\"");
  console.log("  kit export [--out roster.json]");
  console.log("  kit workflows list | run <name> [--arg k=v] | last | watch <dir> | graph <dir>");
  console.log("  kit upgrade");
}

function cmdHelp() {
  console.log(`agnostic-router-kit ${KIT_VERSION}\n`);
  console.log("One local endpoint for every model provider, with a judge that picks");
  console.log("the right model for each request.\n");
  console.log(c.ok("New here?    run `kit quickstart` — it asks a few questions and does the rest."));
  console.log(c.dim("In a hurry?  `kit status` shows what is installed and what is missing.\n"));
  usageBody();
  return 0;
}

export async function main(argv) {
  const { flags, positional } = parseFlags(argv);
  const cmd = positional.shift() ?? "status";
  const fn = COMMANDS[cmd];
  if (!fn) {
    // Unknown command: show the usage so the typo is answerable from the
    // terminal, but exit non-zero — a script that mistyped must not read
    // success. `help` itself is a real command above and exits 0.
    console.log(`agnostic-router-kit ${KIT_VERSION}`);
    console.log(`\nHmm, "${cmd}" is not a command. Here is what is available:\n`);
    usageBody();
    return 1;
  }
  return (await fn(flags, positional)) ?? 0;
}
