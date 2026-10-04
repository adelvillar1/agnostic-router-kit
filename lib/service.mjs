/**
 * Keep the router running: launchd (macOS) or a systemd --user unit (Linux).
 * The service runs the runtime copy under ~/.agnostic-router-kit/router/, so
 * the kit repo can be updated with `git pull` without moving the service.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SERVICE_LABEL, ROUTER_DIR, platform } from "./paths.mjs";

/** Run launchctl/systemctl, never swallowing why it failed. */
function run(cmd, args) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim(), status: e.status };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function servicePaths() {
  if (platform() === "macos") {
    return { kind: "launchd", unit: path.join(os.homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`), domain: `gui/${os.userInfo().uid}` };
  }
  if (platform() === "linux") {
    return { kind: "systemd", unit: path.join(os.homedir(), ".config", "systemd", "user", `${SERVICE_LABEL}.service`), domain: null };
  }
  return { kind: "unsupported", unit: null, domain: null };
}

export function launchdPlist({ node, scriptDir, label = SERVICE_LABEL }) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${esc(label)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${esc(node)}</string>
        <string>${esc(path.join(scriptDir, "server.js"))}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${esc(scriptDir)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${esc(path.join(scriptDir, "logs", "launchd-stdout.log"))}</string>
    <key>StandardErrorPath</key>
    <string>${esc(path.join(scriptDir, "logs", "launchd-stderr.log"))}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
`;
}

export function systemdUnit({ scriptDir }) {
  return `[Unit]
Description=agnostic-router — local OpenAI-compatible model router
After=network.target

[Service]
Type=simple
WorkingDirectory=${scriptDir}
ExecStart=${process.execPath} ${path.join(scriptDir, "server.js")}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

/**
 * Which node runs the service. A fragile choice here silently kills the
 * router later (e.g. inside another tool's bundled node), so the order is:
 * explicit flag > ROUTER_KIT_NODE > the user's stable ~/.local/bin/node >
 * whatever node is running this process. Always printed so the operator
 * can see it.
 */
export function resolveNodeBin(flag) {
  if (flag) return { bin: flag, source: "flag" };
  if (process.env.ROUTER_KIT_NODE) return { bin: process.env.ROUTER_KIT_NODE, source: "ROUTER_KIT_NODE" };
  const preferred = path.join(os.homedir(), ".local", "bin", "node");
  try {
    if (fs.existsSync(preferred)) return { bin: preferred, source: "~/.local/bin/node" };
  } catch {}
  return { bin: process.execPath, source: "process.execPath" };
}

/**
 * launchctl truth-telling helpers. Every subcommand that takes a service
 * target wants "domain/label" as ONE argument — two arguments exit 0 while
 * doing nothing, or fail with launchd's opaque errno 5. Line matching is by
 * substring on purpose: column indexing breaks on the shape of each row.
 */
function isLoaded(domain) {
  const r = run("launchctl", ["list"]);
  if (!r.ok) return { loaded: false, trouble: `launchctl list failed: ${r.out}` };
  return { loaded: r.out.split("\n").some((l) => l.includes(SERVICE_LABEL)), trouble: null };
}

function labelRunning(domain) {
  const r = run("launchctl", ["print", `${domain}/${SERVICE_LABEL}`]);
  return r.ok && /\bstate\s*=\s*running\b/.test(r.out);
}

async function waitUntil(predicate, { ms = 10000, every = 300 } = {}) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await sleep(every);
  }
}

export function serviceStatus() {
  const p = servicePaths();
  if (p.kind === "launchd") {
    const { loaded, trouble } = isLoaded(p.domain);
    return { kind: "launchd", loaded, unit: p.unit, domain: p.domain, running: loaded && labelRunning(p.domain), trouble };
  }
  if (p.kind === "systemd") {
    const r = run("systemctl", ["--user", "is-active", SERVICE_LABEL]);
    return { kind: "systemd", loaded: r.out === "active", unit: p.unit, running: r.out === "active", active: r.out };
  }
  return { kind: "unsupported", loaded: false, unit: null, running: false, trouble: `not automated for ${process.platform}` };
}

/** Write the unit and (re)start it. Returns steps taken for the report. */
export async function installService({ node = null, scriptDir = ROUTER_DIR } = {}) {
  const p = servicePaths();
  const steps = [];
  if (p.kind === "unsupported") return { ok: false, steps, error: `unsupported platform: ${process.platform}` };
  const nodeBin = resolveNodeBin(node);
  steps.push(`node: ${nodeBin.bin} (${nodeBin.source})`);
  if (p.kind === "launchd") {
    const { loaded, trouble } = isLoaded(p.domain);
    if (trouble) steps.push(`warn: ${trouble}`);
    const prevPlist = fs.existsSync(p.unit) ? fs.readFileSync(p.unit, "utf8") : null;
    const nextPlist = launchdPlist({ node: nodeBin.bin, scriptDir });
    const plistChanged = prevPlist !== nextPlist;

    // Fast path: same definition, already loaded — a restart is all we need.
    // Reloading a live service races launchd's exit and fails with errno 5.
    if (loaded && !plistChanged) {
      const ks = run("launchctl", ["kickstart", "-k", `${p.domain}/${SERVICE_LABEL}`]);
      if (!ks.ok) steps.push(`kickstart -k: ${ks.out || "failed"}`);
      else {
        const up = await waitUntil(() => labelRunning(p.domain), { ms: 8000 });
        steps.push(up ? "service already loaded — kicked and verified running" : "kickstart ok but service did not come back within 8s");
        if (up) return { ok: true, steps, unit: p.unit };
      }
      // fall through to the reload path when the fast path could not confirm
    }

    for (const label of new Set(loaded ? [SERVICE_LABEL] : [])) {
      const bo = run("launchctl", ["bootout", `${p.domain}/${label}`]);
      steps.push(bo.ok ? `bootout ${label}` : `bootout ${label} FAILED (exit ${bo.status ?? "?"}: ${bo.out || "no output"})`);
    }
    const gone = await waitUntil(() => !isLoaded(p.domain).loaded, { ms: 15000, every: 250 });
    if (!gone) steps.push("warn: label still registered 15s after bootout — reload may race");
    fs.mkdirSync(path.dirname(p.unit), { recursive: true });
    fs.writeFileSync(p.unit, nextPlist);
    steps.push(`wrote ${p.unit}`);
    // A previously failed bootstrap can leave the label in launchd's disabled
    // list, after which every bootstrap fails with the opaque errno 5.
    run("launchctl", ["enable", `${p.domain}/${SERVICE_LABEL}`]);
    let boot = run("launchctl", ["bootstrap", p.domain, p.unit]);
    for (let attempt = 0; !boot.ok && attempt < 3; attempt++) {
      steps.push(`bootstrap attempt ${attempt + 1}: ${boot.out || "failed"}`);
      await sleep(1000);
      boot = run("launchctl", ["bootstrap", p.domain, p.unit]);
    }
    steps.push(boot.ok ? "bootstrap ok" : `bootstrap: ${boot.out || "failed"}`);
    if (!boot.ok) {
      const legacy = run("launchctl", ["load", "-w", p.unit]);
      steps.push(legacy.ok ? "launchctl load -w ok" : `launchctl load -w: ${legacy.out || "failed"}`);
    }
    run("launchctl", ["kickstart", "-k", `${p.domain}/${SERVICE_LABEL}`]);
    // The truth is the running service, not any intermediate exit code.
    const up = await waitUntil(() => labelRunning(p.domain), { ms: 10000 });
    steps.push(up ? `verified: ${SERVICE_LABEL} is running` : `verified: ${SERVICE_LABEL} is NOT running`);
    return { ok: up, steps, unit: p.unit, error: up ? null : boot.out };
  }
  fs.mkdirSync(path.dirname(p.unit), { recursive: true });
  fs.writeFileSync(p.unit, systemdUnit({ scriptDir }));
  const r1 = run("systemctl", ["--user", "daemon-reload"]);
  const r2 = run("systemctl", ["--user", "enable", "--now", SERVICE_LABEL]);
  steps.push(`wrote ${p.unit}`, `daemon-reload ${r1.ok ? "ok" : r1.out}`, `enable --now ${r2.ok ? "ok" : r2.out}`);
  return { ok: r2.ok, steps, unit: p.unit, error: r2.ok ? null : r2.out };
}
