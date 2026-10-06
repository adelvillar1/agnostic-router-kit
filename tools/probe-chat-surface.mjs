#!/usr/bin/env node
/**
 * The chat/agent-control-plane probe: spawns a scratch router (its own
 * AGNOSTIC_ROUTER_KIT_HOME, rendered by the kit's own `kit apply --only
 * router`) and asserts that what the run API spawns is what the live
 * surfaces see — the watcher/writer agreement the kit-home fix guarantees —
 * plus the escalation round trip a human meets in the Agents rail.
 * Zero model calls: the fixture is workflows/http-probe.ts.
 *
 * Covers:
 *   C1  a run spawned over POST /v1/runs appears in /api/workflow-runs and
 *       on the /api/workflow-events stream, with AGNOSTIC_ROUTER_KIT_HOME
 *       set once for the whole process — the default-path agreement is
 *       asserted separately below, in-process, against both resolvers
 *   C7b an escalation shows up as attention in /api/agents while it is
 *       open, clears after a live POST /v1/runs/<id>/answers, and the
 *       resolved line carries op:"resolved" on the stream (the normalizer
 *       dropped it once, which made every answered escalation look pending)
 *   —   the app's run is attributed to the app in /api/agents
 *
 * Usage: node tools/probe-chat-surface.mjs
 * On failure the scratch home is left behind and printed for diagnosis.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const KIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8396;
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

// ── default-path agreement (the kit-home fix, unit-shaped) ───────────────────
// Both resolvers must land on ~/.agnostic-router-kit when the env var is
// unset — the run watcher used to default to the kit checkout while every
// writer defaulted here, and HTTP-spawned runs were simply invisible.
{
  delete process.env.AGNOSTIC_ROUTER_KIT_HOME;
  const plane = await import("workflow-plane/runstate.mjs");
  const expected = path.join(os.homedir(), ".agnostic-router-kit");
  console.log("\nK — kit-home default agreement (no env var)");
  ok("plane KIT_HOME defaults to ~/.agnostic-router-kit", plane.KIT_HOME() === expected, plane.KIT_HOME());
  ok("runs dir derives from the same home", plane.KIT_WORKFLOW_RUNS() === path.join(expected, "workflow-runs"));
  const envValue = "/tmp/kit-home-override-check";
  process.env.AGNOSTIC_ROUTER_KIT_HOME = envValue;
  ok("env override honoured in one place", plane.KIT_HOME() === path.resolve(envValue));
  delete process.env.AGNOSTIC_ROUTER_KIT_HOME;
}

// ── scratch instance ─────────────────────────────────────────────────────────
const home = fs.mkdtempSync(path.join(os.tmpdir(), "chatsurf-probe-"));
const template = fs.readFileSync(path.join(KIT_DIR, "templates", "roster.defaults.json"), "utf8");
const roster = JSON.parse(template.replace(/^\/\*[\s\S]*?\*\//, ""));
roster.router = { port: PORT, localToken: OP_TOKEN, apps: [] };
roster.judge = { mode: "typesafe" };
const rosterPath = path.join(home, "roster.json");
fs.writeFileSync(rosterPath, JSON.stringify(roster, null, 2));
const envNames = new Set();
for (const p of Object.values(roster.providers ?? {})) if (p.apiKeyEnv) envNames.add(p.apiKeyEnv);
if (roster.typesafe?.apiKeyEnv) envNames.add(roster.typesafe.apiKeyEnv);
fs.mkdirSync(path.join(home, "router"), { recursive: true });
fs.writeFileSync(path.join(home, "router", ".env"), ["SCRATCH PROBE KEYS — dummies.", ...[...envNames].map((n) => `${n}=dummy`)].join("\n") + "\n");

console.log(`scratch home: ${home}`);
console.log("kit apply --only router…");
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

try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) { up = true; break; }
    } catch {}
    await sleep(200);
  }
  if (!up) throw new Error(`scratch server never came up${serverErr ? `: ${serverErr.slice(0, 500)}` : ""}`);

  // SSE first, so the spawn's own events are captured.
  const seen = [];
  const sse = await fetch(`http://127.0.0.1:${PORT}/api/workflow-events?token=${encodeURIComponent(OP_TOKEN)}`, { headers: { accept: "text/event-stream" } });
  ok("SSE connects with the operator token", sse.status === 200);
  const decoder = new TextDecoder();
  const sseDone = (async () => {
    // The stream ends when the probe kills the server in finally; the socket
    // error that follows is shutdown noise, not a failure.
    try {
      let buf = "";
      for await (const chunk of sse.body) {
        buf += decoder.decode(chunk, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          try { seen.push(JSON.parse(line.slice(6))); } catch {}
        }
      }
    } catch {}
  })();

  console.log("\nR — a spawned run is visible everywhere (the kit-home regression)");
  // The warmup escalation is pre-answered (declared) so it resolves at fire
  // time; the live-card escalation opts into the owner wait — that is the
  // channel that makes an in-the-moment answer possible at all.
  const spawned = await call("POST", "/v1/runs", {
    token: OP_TOKEN,
    body: { workflow: "http-probe", args: { topic: "live-card" }, answers: { warmup: "proceed" }, awaitOwnerMs: 60000 },
  });
  ok("spawn accepted with a runId", spawned.status === 200 && Boolean(spawned.json?.runId), spawned.json?.error);
  const runId = spawned.json.runId;

  let listed = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    listed = await call("GET", "/api/workflow-runs", { token: OP_TOKEN });
    if ((listed.json?.runs ?? []).some((r) => r.runId === runId)) break;
    await sleep(300);
  }
  ok("run appears in /api/workflow-runs", (listed.json?.runs ?? []).some((r) => r.runId === runId));

  const gotStart = seen.find((m) => m.type === "event" && m.runId === runId && m.event?.kind === "run-start");
  ok("run-start reached the SSE stream", Boolean(gotStart));

  console.log("\nE — escalation attention and the live answer");
  // The escalation fires ~1.5s in and then HOLDS (owner wait); the attention
  // card must show while it is open.
  let pending = null;
  const tAtt = Date.now();
  while (Date.now() - tAtt < 15000) {
    const agents = await call("GET", "/api/agents", { token: OP_TOKEN });
    const att = (agents.json?.attention ?? []).find((a) => a.runId === runId);
    if (att) { pending = att; break; }
    await sleep(150);
  }
  ok("open escalation surfaces as attention", Boolean(pending), JSON.stringify(pending));
  ok("attention names the question", /What should the probe do/.test(pending?.question ?? ""), pending?.question);

  const answered = await call("POST", `/v1/runs/${encodeURIComponent(runId)}/answers`, {
    token: OP_TOKEN,
    body: { topic: "live-card", answer: "yes — approved from the probe" },
  });
  ok("live answer accepted", answered.status === 200 && answered.json?.ok === true, answered.json?.error);

  // The run finishes on its own (warmup resolves none, real escalation now
  // has its answer); wait for the summary, then the attention must be clear.
  let summaryEvent = null;
  const t1 = Date.now();
  while (Date.now() - t1 < 30000) {
    summaryEvent = seen.find((m) => m.type === "summary" && m.runId === runId) ??
      (await call("GET", `/api/workflow-run/${encodeURIComponent(runId)}`, { token: OP_TOKEN })).json?.summary
      ? seen.find((m) => m.type === "summary" && m.runId === runId)
      : null;
    const done = seen.find((m) => m.type === "event" && m.runId === runId && m.event?.kind === "run-done");
    if (done || summaryEvent) break;
    await sleep(300);
  }
  // The warmup's resolution (source "declared" — it was pre-answered) also
  // rides the stream; the in-the-moment one is the live-card topic's.
  const resolved = seen.find(
    (m) => m.type === "event" && m.runId === runId && m.event?.kind === "escalation" && m.event?.op === "resolved" && m.event?.topic === "live-card",
  );
  ok("resolved escalation carries op on the stream", Boolean(resolved), "no op:resolved escalation event seen");
  ok("resolution source is the live answer (in the moment)", resolved?.event?.source === "live", resolved?.event?.source);
  const agentsAfter = await call("GET", "/api/agents", { token: OP_TOKEN });
  ok("attention clears once answered", !(agentsAfter.json?.attention ?? []).some((a) => a.runId === runId));
  const opRow = (agentsAfter.json?.agents ?? []).find((a) => a.name === "operator");
  ok("run attributed to the operator in /api/agents", (opRow?.runs ?? []).some((r) => r.runId === runId));

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
