#!/usr/bin/env node
/**
 * The visual probe: spawns a scratch router (the same discipline as
 * probe-keys-endpoint — its own AGNOSTIC_ROUTER_KIT_HOME, rendered by
 * `kit apply --only router`, zero model calls) and captures the new
 * surfaces' real states with Playwright:
 *
 *   chat welcome, dark + light        (the real empty state)
 *   chat demo conversation, dark      (?demo=1 — synthetic, badged, no network)
 *   chat with a live run + the real
 *   escalation attention card         (http-probe spawned with awaitOwnerMs)
 *   setup pending (with key entry)
 *
 * Screenshots land in docs/screens/ (the committed evidence) — pass
 * --out <dir> to redirect. Exit code is 0 when every state rendered.
 *
 * Usage: node tools/visual/probe-visual.mjs [--out dir] [--keep]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const KIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 8394;
const OP_TOKEN = "visual-probe-token";

const argOf = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
};
const OUT = path.resolve(argOf("--out", path.join(KIT_DIR, "docs", "screens")));
const KEEP = process.argv.includes("--keep");
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── scratch instance ─────────────────────────────────────────────────────────
const home = fs.mkdtempSync(path.join(os.tmpdir(), "visual-probe-"));
const template = fs.readFileSync(path.join(KIT_DIR, "templates", "roster.defaults.json"), "utf8");
const roster = JSON.parse(template.replace(/^\/\*[\s\S]*?\*\//, ""));
roster.router = { port: PORT, localToken: OP_TOKEN, apps: [{ name: "codex", token: "app-visual-token", grantCeiling: ["workspace-io"] }] };
roster.judge = { mode: "typesafe" };
const rosterPath = path.join(home, "roster.json");
fs.writeFileSync(rosterPath, JSON.stringify(roster, null, 2));
const envNames = new Set();
for (const p of Object.values(roster.providers ?? {})) if (p.apiKeyEnv) envNames.add(p.apiKeyEnv);
if (roster.typesafe?.apiKeyEnv) envNames.add(roster.typesafe.apiKeyEnv);
fs.mkdirSync(path.join(home, "router"), { recursive: true });
fs.writeFileSync(path.join(home, "router", ".env"), [...[...envNames].map((n) => `${n}=dummy`)].join("\n") + "\n");

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

const call = async (method, p, body) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${OP_TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

let failures = 0;
const shot = async (page, name) => {
  await page.waitForTimeout(450); // let entry animations settle
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`  ✓ ${name}.png`);
};

try {
  // Refuse a stranger's server: if the port answers before this probe
  // spawns anything, the captures would document someone else's runtime
  // (seen live — an orphaned router from a preflight test held the port).
  try {
    if ((await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(800) })).ok) {
      throw new Error(`port ${PORT} already has a router on it — pick another PORT, do not capture a stranger`);
    }
  } catch (e) {
    if (!(e instanceof TypeError)) throw e; // connection refused is fine
  }
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { up = (await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok; } catch {}
    if (!up) await sleep(200);
  }
  if (!up) throw new Error(`scratch server never came up${serverErr ? `: ${serverErr.slice(0, 400)}` : ""}`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1320, height: 860 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  const setTheme = (t) => page.evaluate((theme) => localStorage.setItem("agnostic-router-theme", theme), t);

  // 1. chat welcome, dark then light
  await page.goto(`http://127.0.0.1:${PORT}/chat`, { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => localStorage.setItem("agnostic-router-token", t), OP_TOKEN);
  await setTheme("dark");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".welcome");
  await shot(page, "chat-welcome-dark");
  await setTheme("light");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".welcome");
  await shot(page, "chat-welcome-light");

  // 2. the demo conversation (synthetic, badged)
  await setTheme("dark");
  await page.goto(`http://127.0.0.1:${PORT}/chat?demo=1`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".runcard");
  await shot(page, "chat-demo-dark");
  await setTheme("light");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".runcard");
  await shot(page, "chat-demo-light");

  // 3. a real live run with a real open escalation: spawn http-probe with an
  //    owner wait, then catch the attention card while it is actually open.
  await setTheme("dark");
  await page.goto(`http://127.0.0.1:${PORT}/chat`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".welcome");
  const spawned = await call("POST", "/v1/runs", {
    workflow: "http-probe",
    args: { topic: "paywall-scraper" },
    answers: { warmup: "proceed" },
    awaitOwnerMs: 60000,
  });
  if (spawned.status !== 200) throw new Error(`spawn failed: ${JSON.stringify(spawned.json)}`);
  try {
    await page.waitForSelector(".atten", { timeout: 20000 });
    await page.waitForFunction(() => document.querySelector(".atten .q")?.textContent.length > 5);
    await shot(page, "chat-live-escalation");
  } catch {
    failures++;
    console.log("  ✗ the live escalation never surfaced as attention");
  }

  // 4. setup pending — the checklist with the key entry open
  await page.goto(`http://127.0.0.1:${PORT}/setup`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".step");
  // the dummy .env satisfies every key; the pending step is first-request.
  // The chat page just routed a run's spawn (no model call), so wait for the
  // poll to settle and capture whatever the honest state is.
  await page.waitForTimeout(1200);
  await shot(page, "setup-pending-dark");

  // 5. setup in light
  await setTheme("light");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".step");
  await page.waitForTimeout(1200);
  await shot(page, "setup-pending-light");

  await browser.close();

  const realErrors = errors.filter((e) => !/favicon/.test(e));
  if (realErrors.length) {
    failures++;
    console.log(`  ✗ page errors: ${realErrors.slice(0, 3).join(" | ")}`);
  } else {
    console.log("  ✓ no page errors on any state");
  }

  console.log(`${failures ? `${failures} FAILED` : "all states rendered"}`);
  if (failures) process.exitCode = 1;
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  server.kill();
  if (!KEEP && !failures) {
    fs.rmSync(home, { recursive: true, force: true });
    console.log("scratch home cleaned up");
  } else {
    console.log(`scratch home: ${home}`);
  }
  // Chromium's children inherit the stdio pipes and outlive the work; an
  // explicit exit is the only reliable end when this runs piped. A thrown
  // failure sets process.exitCode in the catch — honour it here too.
  process.exit(failures || process.exitCode ? 1 : 0);
}
