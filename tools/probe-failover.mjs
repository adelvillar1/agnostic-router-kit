#!/usr/bin/env node
/**
 * The failover probe: drives POST /v1/chat/completions end to end against a
 * scratch router whose providers are two fake-upstream instances, asserting
 * the walk/metering wire contract with zero real providers. This is the
 * suite's only full /v1 exercise — everything else probes /api surfaces or
 * the plane offline.
 *
 * The bench contract, as the router actually implements it: a benched
 * provider steers as zero headroom (steerSingle), so it is moved out of the
 * target slot while any healthy candidate exists, and the walk skips it in
 * fallback position (i > 0). A steered single-model tier is never reordered
 * (steering needs a chain of 2+). The check order below is chosen so no
 * check's bench poisons a later one: the long-60s benches land only on the
 * last upstream checks.
 *
 * Checks:
 *   E   a client-caused 400 passes through untouched (no walk, no bench)
 *   A   a 429 with Retry-After walks; the client sees the fallback's answer
 *       and x-router-failover names the attempt index
 *   B   the Retry-After bench holds: the immediate retry skips the benched
 *       provider (its /hits count does not move)
 *   C   a 401 walks and benches the provider long (600s floor)
 *   B2  the bench skips the provider in FALLBACK position: a walk that would
 *       reach it 502s instead of touching it
 *   Q   a quota-exhaustion body is a long bench but never a key rejection —
 *       /api/state remembers the 401 as a key fault and the 402 not at all
 *   D   an all-failing chain yields the 502 envelope naming the chain length
 *       and last status, with exactly one upstream attempt (benched providers
 *       are steered away / skipped, not retried)
 *   F   the ledger rows carry the walk: +upstream-429:rate / +upstream-401:key
 *       / +upstream-402:quota reasons, the failover:1 success with the
 *       upstream-reported tokens
 *   G   POST /route answers (the deduped handler, live on its real path)
 *   H   streaming relays untouched and is metered via the SSE tap
 *
 * Usage: node tools/probe-failover.mjs
 * On failure the scratch home is left behind and printed for diagnosis.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const KIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROUTER_PORT = 8510;
const FA_PORT = 8511;
const FB_PORT = 8512;
const OP_TOKEN = "probe-operator-token";

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (method, p, { token, body } = {}) => {
  const res = await fetch(`http://127.0.0.1:${ROUTER_PORT}${p}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res;
};

const chat = async (model, { stream = false, n = 0 } = {}) => {
  const res = await api("POST", "/v1/chat/completions", {
    token: OP_TOKEN,
    body: {
      model,
      stream,
      messages: [{ role: "user", content: `probe call ${model} ${n}` }],
    },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json, headers: res.headers };
};

const hits = async (port) => {
  const res = await fetch(`http://127.0.0.1:${port}/hits`);
  return res.json();
};

const waitForHealth = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${ROUTER_PORT}/healthz`)).ok) return true;
    } catch {}
    await sleep(200);
  }
  return false;
};

// ── scratch instance ─────────────────────────────────────────────────────────
const home = fs.mkdtempSync(path.join(os.tmpdir(), "failover-probe-"));
const template = fs.readFileSync(path.join(KIT_DIR, "templates", "roster.defaults.json"), "utf8");
const roster = JSON.parse(template.replace(/^\/\*[\s\S]*?\*\//, ""));
roster.router = { port: ROUTER_PORT, localToken: OP_TOKEN, apps: [] };
roster.judge = { mode: "typesafe" };
roster.providers = {
  fa: {
    providerName: "Fake A",
    baseUrl: `http://127.0.0.1:${FA_PORT}/v1`,
    apiKeyEnv: "FAKE_A_KEY",
    billing: "plan",
    models: ["fake-ok", "fake-429ra5", "fake-401", "fake-500", "fake-400", "fake-stream"],
  },
  fb: {
    providerName: "Fake B",
    baseUrl: `http://127.0.0.1:${FB_PORT}/v1`,
    apiKeyEnv: "FAKE_B_KEY",
    billing: "plan",
    models: ["fake-ok", "fake-500", "fake-stream"],
  },
};
roster.tiers = {
  quick: { target: "fb/fake-ok", fallbacks: [] },
  standard_code: { target: "fb/fake-ok", fallbacks: [] },
  hard: { target: "fb/fake-ok", fallbacks: [] },
  prose: { target: "fb/fake-ok", fallbacks: [] },
  deep_context: { target: "fb/fake-ok", fallbacks: [] },
  passthrough: { target: "fa/fake-400", fallbacks: [] },
  walk: { target: "fa/fake-429ra5", fallbacks: ["fb/fake-ok"] },
  allfail: { target: "fa/fake-500", fallbacks: ["fb/fake-500"] },
  auth: { target: "fa/fake-401", fallbacks: ["fb/fake-ok"] },
  benchskip: { target: "fb/fake-500", fallbacks: ["fa/fake-ok"] },
  quota: { target: "fa/fake-402", fallbacks: [] },
  streamy: { target: "fb/fake-stream", fallbacks: [] },
};
roster.profiles = {
  pt: { workload: "passthrough" },
  wl: { workload: "walk" },
  af: { workload: "allfail" },
  au: { workload: "auth" },
  bs: { workload: "benchskip" },
  q2: { workload: "quota" },
  st: { workload: "streamy" },
};
roster.omniModel = ["fb/fake-ok"];
roster.wideModel = ["fb/fake-ok"];
roster.mixture = { proposers: ["fb/fake-ok"], aggregator: ["fb/fake-ok"], proposerTimeoutMs: 240000 };
roster.routing = { wideChars: 1000000, minConfidence: 0.6, workflowMinConfidence: 0.4, defaultWorkload: "standard_code" };
roster.workflows = { registry: {} };

const rosterPath = path.join(home, "roster.json");
fs.writeFileSync(rosterPath, JSON.stringify(roster, null, 2));
fs.mkdirSync(path.join(home, "router"), { recursive: true });
fs.writeFileSync(
  path.join(home, "router", ".env"),
  ["SCRATCH PROBE KEYS — dummies.", "FAKE_A_KEY=dummy-a", "FAKE_B_KEY=dummy-b", "TYPESAFE_API_KEY=dummy"].join("\n") + "\n"
);

console.log(`scratch home: ${home}`);
console.log("spawning fake upstreams…");
const fakeA = spawn(process.execPath, [path.join(KIT_DIR, "tools", "fake-upstream.mjs"), "--port", String(FA_PORT), "--tag", "fa"], { stdio: ["ignore", "ignore", "pipe"] });
const fakeB = spawn(process.execPath, [path.join(KIT_DIR, "tools", "fake-upstream.mjs"), "--port", String(FB_PORT), "--tag", "fb"], { stdio: ["ignore", "ignore", "pipe"] });

console.log("kit apply --only router…");
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
  const up = await waitForHealth();
  if (!up) throw new Error(`scratch server never came up${serverErr ? `: ${serverErr.slice(0, 500)}` : ""}`);

  console.log("\nE — a client-caused 400 passes through (no walk, no bench)");
  const pt = await chat("pt", { n: 1 });
  ok("400 relayed as-is", pt.status === 400 && /bad request shape/.test(pt.text ?? ""), `status ${pt.status}`);
  ok("no failover header on a passthrough", !pt.headers.get("x-router-failover"));
  ok("fa served exactly one call", (await hits(FA_PORT)).count === 1, JSON.stringify(await hits(FA_PORT)));

  console.log("\nA — a 429 with Retry-After walks the chain");
  const wl = await chat("wl", { n: 1 });
  ok("client got the fallback's answer", wl.status === 200 && /answer from fb/.test(wl.text ?? ""), `status ${wl.status}`);
  ok("x-router-failover names the attempt", wl.headers.get("x-router-failover") === "1", wl.headers.get("x-router-failover"));
  ok("fa attempted once for the 429", (await hits(FA_PORT)).count === 2);

  console.log("\nB — the Retry-After bench holds on the immediate retry");
  const wl2 = await chat("wl", { n: 2 });
  ok("retry also served by fb", wl2.status === 200 && /answer from fb/.test(wl2.text ?? ""));
  ok("benched fa was skipped (hits unchanged)", (await hits(FA_PORT)).count === 2, JSON.stringify(await hits(FA_PORT)));

  console.log("  (sleeping out the 5s Retry-After…)");
  await sleep(6000);

  console.log("\nC — a 401 walks and benches the provider long");
  const au = await chat("au", { n: 1 });
  ok("401 walked to the fallback", au.status === 200 && /answer from fb/.test(au.text ?? ""), `status ${au.status} ${au.json?.error?.message ?? ""}`);
  ok("fa attempted once for the 401", (await hits(FA_PORT)).count === 3);

  console.log("\nB2 — the bench skips the provider in fallback position");
  const bs = await chat("bs", { n: 1 });
  ok("a walk whose fallback is benched 502s", bs.status === 502, `status ${bs.status}`);
  ok("the benched fallback was never touched", (await hits(FA_PORT)).count === 3, JSON.stringify(await hits(FA_PORT)));

  console.log("\nQ — a quota-exhaustion body is not a key fault (single-model tier never steers)");
  const q2 = await chat("q2", { n: 1 });
  ok("the quota-benched provider still serves its pinned single-model tier", q2.status === 502 && /all 1 candidate\(s\).*last status 402/.test(q2.json?.error?.message ?? ""), q2.json?.error?.message);
  ok("fa attempted once for the 402", (await hits(FA_PORT)).count === 4);
  const state = await (await api("GET", "/api/state", { token: OP_TOKEN })).json().catch(() => null);
  const rejections = state?.resolved?.keyRejections ?? [];
  ok("the 401 is remembered as a key rejection", rejections.some((e) => e.providerId === "fa" && e.status === 401 && e.count === 1), JSON.stringify(rejections));
  ok("the 402 is NOT remembered as a key rejection", !rejections.some((e) => e.status === 402), JSON.stringify(rejections));

  console.log("\nD — an all-failing chain yields the 502 envelope");
  const faBefore = (await hits(FA_PORT)).count;
  const fbBefore = (await hits(FB_PORT)).count;
  const af = await chat("af", { n: 1 });
  ok("502 envelope names the count and last status", af.status === 502 && /all 2 candidate\(s\).*last status 500/.test(af.json?.error?.message ?? ""), af.json?.error?.message);
  const faAfter = (await hits(FA_PORT)).count;
  const fbAfter = (await hits(FB_PORT)).count;
  ok("exactly one upstream attempt happened (benched providers steered away)", faAfter + fbAfter - faBefore - fbBefore === 1, `fa ${faBefore}→${faAfter}, fb ${fbBefore}→${fbAfter}`);

  console.log("\nF — the ledger carries the walk");
  const usageRes = await api("GET", "/api/usage", { token: OP_TOKEN });
  const usageJson = await usageRes.json().catch(() => null);
  const rows = usageJson?.recent ?? [];
  ok("the 429 is on the ledger, classified as rate", rows.some((r) => r.status === 429 && /\+upstream-429:rate$/.test(r.reason ?? "")), JSON.stringify(rows.slice(0, 3)));
  ok("the 401 is on the ledger, classified as key", rows.some((r) => r.status === 401 && /\+upstream-401:key$/.test(r.reason ?? "")));
  ok("the 402 is on the ledger, classified as quota", rows.some((r) => r.status === 402 && /\+upstream-402:quota$/.test(r.reason ?? "")));
  ok("the walked success records failover:1 with the reported tokens", rows.some((r) => r.status === 200 && r.reason === "failover:1" && r.promptTokens === 11 && r.completionTokens === 7));

  console.log("\nG — POST /route answers (the deduped handler, live)");
  const route = await api("POST", "/route", { token: OP_TOKEN, body: { task: "probe the topology verdict" } });
  const routeJson = await route.json().catch(() => null);
  ok("/route answers 200 with a verdict", route.status === 200 && Boolean(routeJson), `status ${route.status} ${JSON.stringify(routeJson)?.slice(0, 200)}`);

  console.log("\nH — streaming relays untouched and is metered (single-model tier never steers)");
  const st = await chat("st", { stream: true, n: 1 });
  const stText = st.text ?? "";
  ok("SSE reached the client with the fallback's words", st.status === 200 && stText.includes("answer from fb") && stText.includes("[DONE]"), `status ${st.status}`);
  const rowsAfter = (await (await api("GET", "/api/usage", { token: OP_TOKEN })).json().catch(() => null))?.recent ?? [];
  ok("the stream is metered via the tap", rowsAfter.some((r) => r.stream === true && r.promptTokens === 11 && r.completionTokens === 7));

} catch (e) {
  failures.push(`probe crashed: ${e.message}`);
  console.error(String(e?.stack ?? e));
} finally {
  server.kill("SIGTERM");
  fakeA.kill("SIGTERM");
  fakeB.kill("SIGTERM");
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failed: ${failures.join("; ")}`);
  console.log(`scratch home left for diagnosis: ${home}`);
  process.exit(1);
}
fs.rmSync(home, { recursive: true, force: true });
console.log("scratch home cleaned up");
