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
 *   kit upgrade                    git pull + apply
 *
 * There is deliberately no harness-specific step in `apply`: the kit renders
 * the router's own runtime and the keepalive service, nothing else. Any
 * OpenAI-compatible client points at the router's /v1 — that is the whole
 * integration surface.
 */
import fs from "node:fs";
import path from "node:path";
import {
  KIT_DIR,
  KIT_VERSION,
  ROUTER_DIR,
  ROUTER_LOG,
  ENV_FILE,
  ROSTER_PATH,
  platform,
} from "./paths.mjs";
import { loadRoster, resolveRoster } from "./roster.mjs";
import { renderRouterConfig, renderEnvHeader } from "./render.mjs";
import { readEnvFile, writeEnvFile } from "./envstore.mjs";
import { installService, serviceStatus, servicePaths } from "./service.mjs";

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
    f.endsWith(".js") || f.endsWith(".mjs") || f === "dashboard.html" || f === "package.json" || f === "README.md"
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
  const h = await health(port);
  console.log(`  health:       ${h ? `up on 127.0.0.1:${port}` : `DOWN on 127.0.0.1:${port}`}`);
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
  writeJson(ROSTER_PATH, JSON.parse(fs.readFileSync(tpl, "utf8")));
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
    const cfg = renderRouterConfig(roster, resolved, [], { port });
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

const COMMANDS = {
  status: cmdStatus,
  init: cmdInit,
  env: cmdEnv,
  apply: cmdApply,
  doctor: cmdDoctor,
  route: cmdRoute,
  upgrade: cmdUpgrade,
};

export async function main(argv) {
  const { flags, positional } = parseFlags(argv);
  const cmd = positional.shift() ?? "status";
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.log(`agnostic-router-kit ${KIT_VERSION}\n`);
    console.log("commands:");
    for (const { name } of Object.entries(COMMANDS)) console.log(`  kit ${name}`);
    console.log(`  kit help`);
    return 1;
  }
  return (await fn(flags, positional)) ?? 0;
}
