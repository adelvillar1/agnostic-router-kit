#!/usr/bin/env node
/**
 * The memory HTTP wire's probe: spawns a scratch router (its own
 * AGNOSTIC_ROUTER_KIT_HOME, rendered by `kit apply --only router`, zero model
 * calls) and asserts the memory routes' token/ceiling law:
 *
 *   C2  /api/memory is operator-only; /v1/memory needs `memory` in the app's
 *       grantCeiling — refused by name without it, allowed with it; bad
 *       token 401
 *   C3  app memory writes are attributed in the router log; the store lands
 *       under the kit home the server was started with
 *
 * Usage: node tools/probe-memory-api.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const KIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8393;
const OP_TOKEN = "mem-probe-op";
const APP_NO = "app-no-memory";
const APP_NO_TOKEN = "mem-probe-app-no";
const APP_OK = "app-with-memory";
const APP_OK_TOKEN = "mem-probe-app-ok";

let passed = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const call = async (method, p, { token, body } = {}) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── scratch instance ─────────────────────────────────────────────────────────
const home = fs.mkdtempSync(path.join(os.tmpdir(), "memory-api-probe-"));
const template = fs.readFileSync(path.join(KIT_DIR, "templates", "roster.defaults.json"), "utf8");
const roster = JSON.parse(template.replace(/^\/\*[\s\S]*?\*\//, ""));
roster.router = {
  port: PORT,
  localToken: OP_TOKEN,
  apps: [
    { name: APP_NO, token: APP_NO_TOKEN, grantCeiling: ["workspace-io"] },
    { name: APP_OK, token: APP_OK_TOKEN, grantCeiling: ["workspace-io", "memory"] },
  ],
};
roster.judge = { mode: "typesafe" };
const rosterPath = path.join(home, "roster.json");
fs.writeFileSync(rosterPath, JSON.stringify(roster, null, 2));
const envNames = new Set();
for (const p of Object.values(roster.providers ?? {})) if (p.apiKeyEnv) envNames.add(p.apiKeyEnv);
if (roster.typesafe?.apiKeyEnv) envNames.add(roster.typesafe.apiKeyEnv);
fs.mkdirSync(path.join(home, "router"), { recursive: true });
fs.writeFileSync(path.join(home, "router", ".env"), [...envNames].map((n) => `${n}=dummy`).join("\n") + "\n");

const applied = spawnSync(process.execPath, [path.join(KIT_DIR, "bin", "agnostic-router-kit.mjs"), "apply", "--only", "router"], {
  env: { ...process.env, AGNOSTIC_ROUTER_KIT_HOME: home, AGNOSTIC_ROUTER_KIT_ROSTER: rosterPath },
  encoding: "utf8",
});
if (!fs.existsSync(path.join(home, "router", "config.json"))) {
  console.error(applied.stdout ?? "");
  throw new Error("kit apply --only router did not render a runtime");
}

const server = spawn(process.execPath, [path.join(home, "router", "server.js")], {
  env: { ...process.env, AGNOSTIC_ROUTER_KIT_HOME: home },
  stdio: ["ignore", "ignore", "pipe"],
});
let serverErr = "";
server.stderr.on("data", (d) => { serverErr += String(d); });

const store = path.join(home, "memory", "memory.jsonl");

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { up = (await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok; } catch {}
    if (!up) await sleep(200);
  }
  if (!up) throw new Error(`scratch server never came up${serverErr ? `: ${serverErr.slice(0, 400)}` : ""}`);

  console.log("\nA — the ceiling law on /v1/memory");
  const noWrite = await call("POST", "/v1/memory", { token: APP_NO_TOKEN, body: { entity: "should not land", observation: "x" } });
  ok("app without the memory capability refused by name", noWrite.status === 403 && new RegExp(`memory is not in ${APP_NO}'s ceiling`).test(noWrite.json?.error ?? ""), noWrite.json?.error);
  const noRead = await call("GET", "/v1/memory?q=anything", { token: APP_NO_TOKEN });
  ok("read is gated by the same capability", noRead.status === 403);

  const okWrite = await call("POST", "/v1/memory", { token: APP_OK_TOKEN, body: { entity: "memory probe fact", observation: "written by the app with the memory capability" } });
  ok("app with the capability writes", okWrite.status === 200 && okWrite.json?.ok === true, okWrite.json?.error);
  const okRead = await call("GET", "/v1/memory?q=MEMORY PROBE", { token: APP_OK_TOKEN });
  ok("app reads back by case-insensitive search", (okRead.json?.entities ?? []).length === 1, JSON.stringify(okRead.json).slice(0, 120));
  ok("write attributed to the app", okRead.json?.entities?.[0]?.entityType === `app:${APP_OK}`, okRead.json?.entities?.[0]?.entityType);

  console.log("\nB — the operator scope on /api/memory");
  const opSearch = await call("GET", "/api/memory?q=memory%20probe", { token: OP_TOKEN });
  ok("operator searches the same store", (opSearch.json?.entities ?? []).length === 1);
  const opStats = await call("GET", "/api/memory", { token: OP_TOKEN });
  ok("operator stats", opStats.json?.stats?.entities === 1);
  const opWrite = await call("POST", "/api/memory", { token: OP_TOKEN, body: { entities: [{ name: "operator fact", entityType: "memory", observations: ["via /api"] }] } });
  ok("operator write", opWrite.status === 200 && opWrite.json?.ok === true);
  const appOnApi = await call("GET", "/api/memory", { token: APP_OK_TOKEN });
  ok("app token gets 403 on the operator surface", appOnApi.status === 403);
  const unauth = await call("GET", "/v1/memory", { token: "wrong" });
  ok("bad token 401", unauth.status === 401);

  console.log("\nC — attribution and the store under the kit home");
  ok("store landed under the kit home", fs.existsSync(store), store);
  const logPath = path.join(home, "router", "logs", "router.log");
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
  ok("router log attributes the app write", log.includes("memory-write") && log.includes(APP_OK));
  ok("router log records the refusal", log.includes("memory-refused") && log.includes(APP_NO));

  console.log("\nD — setup sees the memory step");
  const setup = await call("GET", "/api/setup", { token: OP_TOKEN });
  const step = (setup.json?.steps ?? []).find((s) => s.id === "memory");
  ok("setup carries a memory step, done after writes", Boolean(step) && step.done === true && /memories/.test(step.detail ?? ""), JSON.stringify(step));

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  server.kill();
  if (!failures.length && !process.env.KEEP_SCRATCH) {
    fs.rmSync(home, { recursive: true, force: true });
    console.log("scratch home cleaned up");
  } else {
    console.log(`scratch home: ${home}`);
  }
  process.exit(failures.length || process.exitCode ? 1 : 0);
}
