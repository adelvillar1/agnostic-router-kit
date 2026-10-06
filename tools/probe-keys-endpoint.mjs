#!/usr/bin/env node
/**
 * The browser control plane's probe: spawns a scratch router (its own
 * AGNOSTIC_ROUTER_KIT_HOME, rendered by the kit's own `kit apply --only
 * router`) and asserts the operator/app token boundary plus the new
 * key/setup/agents surfaces. Zero model calls.
 *
 * Covers:
 *   C2  the /api gate is operator-class: an app token gets 403 on roster
 *       reads and writes, on key entry, and on unknown /api paths; a bad
 *       token still gets 401; the operator gets 200s
 *   C3  POST /api/keys is write-only by contract: the value lands in the
 *       runtime .env (mode 600, comments preserved), the response never
 *       contains it, and the env cache invalidates (a follow-up /api/setup
 *       sees the key)
 *   C6  /api/setup is the router's own computed checklist — steps shaped,
 *       keys step flips only after the write
 *   —   /chat, /setup and / serve the stamped shells
 *   —   /api/agents lists the operator and every roster app with its ceiling
 *
 * Usage: node tools/probe-keys-endpoint.mjs
 * On failure the scratch home is left behind and printed for diagnosis.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const KIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8397;
const OP_TOKEN = "probe-operator-token";
const APP = "probe-app";
const APP_TOKEN = "probe-app-token";
// A value the response must never echo back.
const SECRET = "sk-probe-secret-do-not-echo-9f2c";

let passed = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
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

// ── scratch instance (same discipline as probe-run-api) ──────────────────────
const home = fs.mkdtempSync(path.join(os.tmpdir(), "keys-probe-"));
const template = fs.readFileSync(path.join(KIT_DIR, "templates", "roster.defaults.json"), "utf8");
const roster = JSON.parse(template.replace(/^\/\*[\s\S]*?\*\//, ""));
roster.router = {
  port: PORT,
  localToken: OP_TOKEN,
  apps: [{ name: APP, token: APP_TOKEN, grantCeiling: ["workspace-io"] }],
};
roster.judge = { mode: "typesafe" };
const rosterPath = path.join(home, "roster.json");
fs.writeFileSync(rosterPath, JSON.stringify(roster, null, 2));

// Dummy values for every wanted key EXCEPT ZAI_CODING_API_KEY — the setup
// checklist must start with that one missing, so the key write can flip it.
const envNames = new Set();
for (const p of Object.values(roster.providers ?? {})) if (p.apiKeyEnv && p.apiKeyEnv !== "ZAI_CODING_API_KEY") envNames.add(p.apiKeyEnv);
if (roster.typesafe?.apiKeyEnv) envNames.add(roster.typesafe.apiKeyEnv);
const envPath = path.join(home, "router", ".env");
fs.mkdirSync(path.join(home, "router"), { recursive: true });
fs.writeFileSync(
  envPath,
  ["SCRATCH PROBE KEYS — dummies, never real, zero model calls in this probe.", "# a comment that must survive the browser write", ...[...envNames].map((n) => `${n}=dummy`)].join("\n") + "\n",
);
fs.chmodSync(envPath, 0o600);

console.log(`scratch home: ${home}`);
console.log("kit apply --only router (scratch roster, kit's own pipeline)…");
const applied = spawnSync(process.execPath, [path.join(KIT_DIR, "bin", "agnostic-router-kit.mjs"), "apply", "--only", "router"], {
  env: { ...process.env, AGNOSTIC_ROUTER_KIT_HOME: home, AGNOSTIC_ROUTER_KIT_ROSTER: rosterPath },
  encoding: "utf8",
});
if (!fs.existsSync(path.join(home, "router", "config.json"))) {
  console.error(applied.stdout ?? "");
  console.error(applied.stderr ?? "");
  throw new Error("kit apply --only router did not render a runtime");
}

const server = spawn(process.execPath, [path.join(home, "router", "server.js")], {
  env: { ...process.env, AGNOSTIC_ROUTER_KIT_HOME: home },
  stdio: ["ignore", "ignore", "pipe"],
});
let serverErr = "";
server.stderr.on("data", (d) => { serverErr += String(d); });

try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) { up = true; break; }
    } catch {}
    await sleep(200);
  }
  if (!up) throw new Error(`scratch server never came up${serverErr ? `: ${serverErr.slice(0, 500)}` : ""}`);

  console.log("\nA — the page shells");
  for (const p of ["/chat", "/setup", "/"]) {
    const res = await fetch(`http://127.0.0.1:${PORT}${p}`);
    const html = await res.text();
    ok(`GET ${p} serves html`, res.status === 200 && (res.headers.get("content-type") ?? "").includes("text/html"), `status ${res.status}`);
    ok(`GET ${p} is token-stamped`, html.includes(`const INJECTED_TOKEN = ${JSON.stringify(OP_TOKEN)}`) && !html.includes('const INJECTED_TOKEN = ""'));
  }

  console.log("\nB — POST /api/keys: write-only, comment-preserving, cache-invalidating");
  const before = fs.readFileSync(envPath, "utf8");
  const w1 = await call("POST", "/api/keys", { token: OP_TOKEN, body: { keys: { ZAI_CODING_API_KEY: SECRET } } });
  ok("operator write accepted", w1.status === 200 && w1.json?.ok === true && w1.json?.configured?.ZAI_CODING_API_KEY === true, JSON.stringify(w1.json));
  ok("response never echoes the secret", !w1.text.includes(SECRET));
  const after = fs.readFileSync(envPath, "utf8");
  ok("value landed in the runtime .env", after.includes(`ZAI_CODING_API_KEY=${SECRET}`));
  ok("mode 600 kept", (fs.statSync(envPath).mode & 0o777) === 0o600);
  ok("existing comments survive the merge", after.includes("# a comment that must survive the browser write"));
  ok("untouched keys survive", after.includes("STEPFUN_API_KEY=dummy"));
  const setup1 = await call("GET", "/api/setup", { token: OP_TOKEN });
  const keysStep = (setup1.json?.steps ?? []).find((s) => s.id === "keys");
  ok("setup sees the new key (cache invalidated)", keysStep?.done === true, JSON.stringify(keysStep?.detail));
  const badName = await call("POST", "/api/keys", { token: OP_TOKEN, body: { keys: { "not a name": "x" } } });
  ok("invalid env name refused", badName.status === 400);
  const emptyVal = await call("POST", "/api/keys", { token: OP_TOKEN, body: { keys: { FOO: "  " } } });
  ok("empty value refused", emptyVal.status === 400);

  console.log("\nC — the /api gate is operator-class");
  for (const [method, p] of [["GET", "/api/roster"], ["PUT", "/api/roster"], ["POST", "/api/keys"], ["GET", "/api/nope"], ["GET", "/api/agents"]]) {
    const app = await call(method, p, { token: APP_TOKEN, body: method === "PUT" ? {} : method === "POST" ? { keys: { FOO: "bar" } } : undefined });
    ok(`app token ${method} ${p} → 403`, app.status === 403, `status ${app.status}`);
  }
  const unauth = await call("GET", "/api/agents", { token: "wrong" });
  ok("bad token still 401", unauth.status === 401);
  const op = await call("GET", "/api/agents", { token: OP_TOKEN });
  ok("operator still 200", op.status === 200);

  console.log("\nD — /api/setup: the router computes the checklist");
  const steps = setup1.json?.steps ?? [];
  ok("all five steps present", ["roster", "keys", "tiers", "judge", "first-request"].every((id) => steps.some((s) => s.id === id)), steps.map((s) => s.id).join(","));
  ok("steps carry label + done + detail", steps.every((s) => typeof s.label === "string" && typeof s.done === "boolean"));
  ok("first-request honest before any request", steps.find((s) => s.id === "first-request")?.done === false);
  ok("judge step green under typesafe with a key", steps.find((s) => s.id === "judge")?.done === true);
  ok("ready flag equals all-done", setup1.json?.ready === steps.every((s) => s.done));

  console.log("\nE — /api/agents: every token holder, with its ceiling");
  const agents = op.json?.agents ?? [];
  ok("operator listed", agents.some((a) => a.name === "operator" && a.kind === "operator"));
  const appRow = agents.find((a) => a.name === APP);
  ok("roster app listed with its ceiling", Boolean(appRow) && appRow.kind === "app" && appRow.grants.includes("workspace-io"), JSON.stringify(appRow));
  ok("no tokens in the payload", !op.text.includes(APP_TOKEN) && !op.text.includes(OP_TOKEN));

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  server.kill();
  if (failures.length === 0 && !process.env.KEEP_SCRATCH) {
    fs.rmSync(home, { recursive: true, force: true });
    console.log("scratch home cleaned up");
  } else {
    console.log(`scratch home kept: ${home}`);
  }
}
