#!/usr/bin/env node
/**
 * The run API's probe: spawns a scratch router instance (its own
 * AGNOSTIC_ROUTER_KIT_HOME, rendered from a scratch roster by the kit's own
 * `kit apply` pipeline) and asserts the run API's wire contract end to end,
 * zero model calls — the workflow fixture (workflows/http-probe.ts) escalates
 * and publishes without touching a provider.
 *
 * Covers the plan's criteria:
 *   C0  spawn → runId/runDir; journal provenance (app, facts, grants)
 *   C1  ceiling: an app grant outside its ceiling is refused by name
 *   C2  sandbox: a workdir outside the app root is refused; the default root
 *       is created per app
 *   C3  live answering: warmup resolves "none"; a live POST resolves with
 *       source "live"; a declared answer beats a live one on the same topic
 *   C4  artifacts: index, download, traversal refused, foreign run 404,
 *       another app's run 403
 *   C5  same-second spawns: distinct run dirs, both attributed on the stream
 *   C7  regression: healthz, models, workflow-runs, bad token 401, unknown
 *       workflow 400
 * C6 (the judgment law unchanged) is structural here: the fixture fires no
 * gates, and the plane's judge path is untouched — the plan file carries the
 * grep guard.
 *
 * Usage: node tools/probe-run-api.mjs
 * On failure the scratch home is left behind and printed for diagnosis.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const KIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8399;
const OP_TOKEN = "probe-operator-token";
const APP = "probe-app";
const APP_TOKEN = "probe-app-token";
const APP2 = "probe-app2";
const APP2_TOKEN = "probe-app2-token";

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

const api = async (method, p, { token, body } = {}) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForRun(runId, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const { json } = await api("GET", `/api/workflow-run/${encodeURIComponent(runId)}`, { token: OP_TOKEN });
    if (json?.summary) return json;
    await sleep(300);
  }
  return null;
}

function journalRows(runDir) {
  return fs
    .readFileSync(path.join(runDir, "run.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ── scratch instance ───────────────────────────────────────────────────────────

const home = fs.mkdtempSync(path.join(os.tmpdir(), "runapi-probe-"));
const template = fs.readFileSync(path.join(KIT_DIR, "templates", "roster.defaults.json"), "utf8");
const roster = JSON.parse(template.replace(/^\/\*[\s\S]*?\*\//, ""));
roster.router = {
  port: PORT,
  localToken: OP_TOKEN,
  apps: [
    { name: APP, token: APP_TOKEN, grantCeiling: ["workspace-io"] },
    { name: APP2, token: APP2_TOKEN, grantCeiling: ["workspace-io"] },
  ],
};
roster.judge = { mode: "typesafe" };
const rosterPath = path.join(home, "roster.json");
fs.writeFileSync(rosterPath, JSON.stringify(roster, null, 2));

// The scratch roster's provider keys are referenced by env name; the probe
// makes zero model calls, so dummy values satisfy resolution and nothing else.
const envNames = new Set([roster.typesafe?.apiKeyEnv].filter(Boolean));
for (const p of Object.values(roster.providers ?? {})) if (p.apiKeyEnv) envNames.add(p.apiKeyEnv);
const judgeEnv = roster.judge?.fastino?.apiKeyEnv;
if (judgeEnv) envNames.add(judgeEnv);
fs.mkdirSync(path.join(home, "router"), { recursive: true });
fs.writeFileSync(
  path.join(home, "router", ".env"),
  ["SCRATCH PROBE KEYS — dummies, never real, zero model calls in this probe.", ...[...envNames].map((n) => `${n}=dummy`)].join("\n") + "\n",
);

console.log(`scratch home: ${home}`);
// --only router: render + copy the runtime, never the service. The first
// probe run learned this the expensive way — a full apply re-registered the
// launchd label (com.agnostic-router.model-router, the live zcode-router-kit
// edition's service on 8300) against the scratch home. The probe never
// touches launchd.
// apply's final step waits for a running server; the probe starts its own
// server afterward, so apply's exit code is not the success criterion — the
// rendered runtime files are.
console.log("kit apply --only router (scratch roster, kit's own pipeline)…");
const applied = spawnSync(process.execPath, [path.join(KIT_DIR, "bin", "agnostic-router-kit.mjs"), "apply", "--only", "router"], {
  env: { ...process.env, AGNOSTIC_ROUTER_KIT_HOME: home, AGNOSTIC_ROUTER_KIT_ROSTER: rosterPath },
  encoding: "utf8",
});
const runtimeOk =
  fs.existsSync(path.join(home, "router", "config.json")) && fs.existsSync(path.join(home, "router", "server.js"));
if (!runtimeOk) {
  console.error(applied.stdout ?? "");
  console.error(applied.stderr ?? "");
  throw new Error("kit apply --only router did not render a runtime (config.json + server.js missing)");
}

const server = spawn(process.execPath, [path.join(home, "router", "server.js")], {
  env: { ...process.env, AGNOSTIC_ROUTER_KIT_HOME: home },
  stdio: ["ignore", "ignore", "pipe"],
});
let serverErr = "";
server.stderr.on("data", (d) => {
  serverErr += String(d);
});

try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) {
        up = true;
        break;
      }
    } catch {}
    await sleep(200);
  }
  if (!up) throw new Error(`scratch server never came up${serverErr ? `: ${serverErr.slice(0, 500)}` : ""}`);

  // ── C7: the existing surface is untouched ───────────────────────────────────
  console.log("\nC7 — regression on the existing surface");
  ok("healthz responds", (await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok);
  const models = await api("GET", "/v1/models", { token: OP_TOKEN });
  ok("/v1/models with operator token", models.status === 200);
  const bad = await api("POST", "/v1/runs", { token: "wrong-token", body: { workflow: "http-probe", args: { topic: "x" } } });
  ok("bad token refused on the run API", bad.status === 401, `status ${bad.status}`);
  const runs0 = await api("GET", "/api/workflow-runs", { token: OP_TOKEN });
  ok("workflow-runs still serves", runs0.status === 200 && runs0.json?.ok === true);
  const unknownWf = await api("POST", "/v1/runs", { token: OP_TOKEN, body: { workflow: "no-such-workflow", args: {} } });
  ok("unknown workflow refused by name", unknownWf.status === 400 && /no workflow named/.test(unknownWf.json?.error ?? ""), unknownWf.json?.error);

  // ── C1: ceiling enforcement ─────────────────────────────────────────────────
  console.log("\nC1 — ceiling enforcement");
  const over = await api("POST", "/v1/runs", {
    token: APP_TOKEN,
    body: { workflow: "http-probe", args: { topic: "x" }, grants: "process" },
  });
  ok(
    "grant outside the ceiling refused by name",
    over.status === 403 && /out of bounds: process is not in probe-app's ceiling/.test(over.json?.error ?? ""),
    over.json?.error,
  );

  // ── C2: workspace sandboxing ────────────────────────────────────────────────
  console.log("\nC2 — workspace sandboxing");
  const escape = await api("POST", "/v1/runs", {
    token: APP_TOKEN,
    body: { workflow: "http-probe", args: { topic: "x" }, workdir: "../escape" },
  });
  ok(
    "workdir outside the app root refused by name",
    escape.status === 403 && /is outside probe-app's workspace root/.test(escape.json?.error ?? ""),
    escape.json?.error,
  );

  // ── C0 + C3: operator spawn, journal provenance, live answering ────────────
  console.log("\nC0/C3 — operator spawn, provenance, live answer");
  const spawn1 = await api("POST", "/v1/runs", {
    token: OP_TOKEN,
    body: {
      workflow: "http-probe",
      args: { topic: "probe-live" },
      facts: [{ kind: "task", fact: "answer the escalation from the wire" }],
    },
  });
  ok("spawn returns runId + runDir", spawn1.status === 200 && !!spawn1.json?.runId && !!spawn1.json?.runDir, JSON.stringify(spawn1.json));
  const run1 = spawn1.json.runId;
  const run1Dir = spawn1.json.runDir;
  const answerPost = await api("POST", `/v1/runs/${encodeURIComponent(run1)}/answers`, {
    token: OP_TOKEN,
    body: { topic: "probe-live", answer: "the wire says hello" },
  });
  ok("live answer accepted", answerPost.status === 200 && answerPost.json?.ok === true, JSON.stringify(answerPost.json));
  const done1 = await waitForRun(run1);
  ok("run completes", !!done1?.summary);
  const rows1 = done1 ? journalRows(run1Dir) : [];
  const start1 = rows1.find((r) => r.kind === "run-start");
  ok(
    "run-start carries app, grants and facts",
    start1?.app === "operator" && Array.isArray(start1?.grants) && Array.isArray(start1?.facts) && start1.facts.length === 1,
    JSON.stringify(start1)?.slice(0, 200),
  );
  ok("summary carries the caller", !!run1Dir && fs.existsSync(path.join(run1Dir, "summary.json")) && JSON.parse(fs.readFileSync(path.join(run1Dir, "summary.json"), "utf8")).app === "operator");
  ok(
    "spawn fact seeded into the run's store",
    rows1.some((r) => r.kind === "fact" && r.factKind === "task" && /wire/.test(r.text ?? "")),
  );
  const resolved1 = rows1.filter((r) => r.kind === "escalation" && r.op === "resolved");
  ok(
    "warmup escalation resolved with no owner",
    resolved1.some((r) => r.topic === "warmup" && r.source === "none"),
    JSON.stringify(resolved1),
  );
  ok(
    "real escalation resolved from the live channel",
    resolved1.some((r) => r.topic === "probe-live" && r.source === "live"),
    JSON.stringify(resolved1),
  );
  ok("run result carries the live answer", done1?.summary?.result?.answer === "the wire says hello", JSON.stringify(done1?.summary?.result)?.slice(0, 200));

  // ── C4: artifacts ───────────────────────────────────────────────────────────
  console.log("\nC4 — artifacts");
  const index = await api("GET", `/v1/runs/${encodeURIComponent(run1)}/artifacts`, { token: OP_TOKEN });
  ok(
    "artifact index lists the published artifact",
    index.status === 200 && index.json?.artifacts?.some((a) => a.id === "probe-answer" && a.version === 1),
    JSON.stringify(index.json)?.slice(0, 200),
  );
  const dl = await fetch(`http://127.0.0.1:${PORT}/v1/runs/${encodeURIComponent(run1)}/artifacts?file=probe-answer/v1/probe-answer.md`, {
    headers: { authorization: `Bearer ${OP_TOKEN}` },
  });
  const dlText = await dl.text();
  ok("artifact downloads", dl.status === 200 && /probe answer/.test(dlText), `status ${dl.status}`);
  const traversal = await api("GET", `/v1/runs/${encodeURIComponent(run1)}/artifacts?file=${encodeURIComponent("../../roster.json")}`, { token: OP_TOKEN });
  ok("traversal refused", traversal.status === 403, `status ${traversal.status} ${JSON.stringify(traversal.json)}`);
  const missing = await api("GET", `/v1/runs/${encodeURIComponent(run1)}/artifacts?file=nope.md`, { token: OP_TOKEN });
  ok("missing artifact 404", missing.status === 404);
  const foreign = await api("GET", `/v1/runs/${encodeURIComponent("1999-01-01_00-00-00-nowhere")}/artifacts`, { token: OP_TOKEN });
  ok("foreign run 404", foreign.status === 404);

  // ── C3 (declared beats live) + app ownership + default workdir ──────────────
  console.log("\nC3/ownership — declared beats live, app answers its own runs");
  const spawn2 = await api("POST", "/v1/runs", {
    token: APP_TOKEN,
    body: {
      workflow: "http-probe",
      args: { topic: "who-wins" },
      answers: { "who-wins": "the declared table wins" },
    },
  });
  ok("app spawn accepted", spawn2.status === 200 && !!spawn2.json?.runId, JSON.stringify(spawn2.json));
  const run2 = spawn2.json.runId;
  await sleep(400); // the engine journals run-start within the first tick
  const start2 =
    spawn2.json?.runDir && fs.existsSync(path.join(spawn2.json.runDir, "run.jsonl"))
      ? journalRows(spawn2.json.runDir).find((r) => r.kind === "run-start")
      : null;
  ok(
    "default workdir is the app's own root",
    typeof start2?.workdir === "string" && start2.workdir.startsWith(path.join(home, "apps", APP, "workspaces")),
    start2?.workdir,
  );
  const crossAnswer = await api("POST", `/v1/runs/${encodeURIComponent(run2)}/answers`, {
    token: APP2_TOKEN,
    body: { topic: "who-wins", answer: "the wrong app answered" },
  });
  ok(
    "another app's answer refused by name",
    crossAnswer.status === 403 && /an app answers its own runs/.test(crossAnswer.json?.error ?? ""),
    crossAnswer.json?.error,
  );
  await api("POST", `/v1/runs/${encodeURIComponent(run2)}/answers`, {
    token: APP_TOKEN,
    body: { topic: "who-wins", answer: "the live post tried" },
  });
  const done2 = await waitForRun(run2);
  ok("declared answer wins over the live post", done2?.summary?.result?.answer === "the declared table wins", JSON.stringify(done2?.summary?.result)?.slice(0, 200));
  const rows2 = spawn2.json?.runDir ? journalRows(spawn2.json.runDir) : [];
  const resolved2 = rows2.filter((r) => r.kind === "escalation" && r.op === "resolved");
  ok(
    "declared source recorded in the journal",
    resolved2.some((r) => r.topic === "who-wins" && r.source === "declared"),
    JSON.stringify(resolved2),
  );

  // ── C5: same-second spawns, SSE attribution ────────────────────────────────
  console.log("\nC5 — same-second spawns, streamed with attribution");
  const sseEvents = [];
  const sseController = new AbortController();
  const sseDone = (async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/workflow-events?token=${encodeURIComponent(APP2_TOKEN)}`, {
      signal: sseController.signal,
      headers: { accept: "text/event-stream" },
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (line) {
          try {
            sseEvents.push(JSON.parse(line.slice(6)));
          } catch {}
        }
      }
    }
  })().catch(() => {});
  const sseBad = await fetch(`http://127.0.0.1:${PORT}/api/workflow-events?token=wrong`, { headers: { accept: "text/event-stream" } });
  ok("SSE with a bad token refused", sseBad.status === 401);
  const spawnA = await api("POST", "/v1/runs", { token: APP2_TOKEN, body: { workflow: "http-probe", args: { topic: "t-a" }, grants: "workspace-io" } });
  const spawnB = await api("POST", "/v1/runs", { token: APP2_TOKEN, body: { workflow: "http-probe", args: { topic: "t-b" }, grants: "workspace-io" } });
  ok("same-second spawns accepted", spawnA.status === 200 && spawnB.status === 200);
  ok("same-second spawns get distinct run dirs", spawnA.json?.runDir !== spawnB.json?.runDir);
  ok("in-ceiling grant accepted", spawnA.status === 200 && spawnB.status === 200);
  await sleep(4000); // two-plus watcher ticks past both runs' full lifecycle
  sseController.abort();
  await sseDone;
  ok(
    "both runs streamed on SSE with attribution",
    sseEvents.some((e) => JSON.stringify(e).includes(spawnA.json.runId)) && sseEvents.some((e) => JSON.stringify(e).includes(spawnB.json.runId)),
    `${sseEvents.length} frames`,
  );
  const doneA = await waitForRun(spawnA.json.runId);
  const doneB = await waitForRun(spawnB.json.runId);
  const startA = spawnA.json?.runDir ? journalRows(spawnA.json.runDir).find((r) => r.kind === "run-start") : null;
  const startB = spawnB.json?.runDir ? journalRows(spawnB.json.runDir).find((r) => r.kind === "run-start") : null;
  ok(
    "both journals attribute the app and pass the ceiling",
    startA?.app === APP2 && startB?.app === APP2 && Array.isArray(startA?.grants) && startA.grants.includes("workspace-io"),
  );
  ok("both runs complete", !!doneA?.summary && !!doneB?.summary);

  // ── C6 note ─────────────────────────────────────────────────────────────────
  console.log("\nC6 — judgment law: structural (the fixture fires no gates; the judge path is untouched; grep guard in the plan file).");
} catch (e) {
  failures.push(`probe crashed: ${e.message}`);
  console.error(String(e?.stack ?? e));
} finally {
  server.kill("SIGTERM");
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failed: ${failures.join("; ")}`);
  console.log(`scratch home left for diagnosis: ${home}`);
  process.exit(1);
}
fs.rmSync(home, { recursive: true, force: true });
console.log("scratch home cleaned up");
