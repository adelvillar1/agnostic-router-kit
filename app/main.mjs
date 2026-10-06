#!/usr/bin/env node
/**
 * The desktop shell — a thin window over the router the kit already ships.
 *
 * This app holds no logic of its own on purpose. It does four things, in
 * order, and everything user-facing it opens is a page the ROUTER serves
 * (same origin, same token stamping, same gate as the browser):
 *
 *   1. preflight — the kit checkout is found, node ≥ 20 and the two npm
 *      installs exist, the runtime renders (`kit quickstart --yes
 *      --skip-install --skip-service` does the resumable, idempotent rest);
 *   2. the router process — attached to when a service already runs it
 *      (launchd/systemd, the power-user path), owned as a child process when
 *      nothing else does (Windows, or `--own`): the platforms service
 *      management never automated;
 *   3. the window — http://127.0.0.1:<port>/chat, with /setup one click away
 *      in the page header;
 *   4. cleanup — an owned router dies with the app; an attached service
 *      outlives it, exactly as before.
 *
 * When preflight cannot finish (usually: no provider keys yet — the one step
 * a wizard cannot do for you), the app says so in a dialog and points at
 * `kit quickstart` in a terminal. That is the honest boundary: the terminal
 * owns the machine-level half, this app owns the every-day half.
 *
 * `--preflight-check` runs steps 1–2 without opening any window and prints
 * the result as JSON — the CI-testable half of the app.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── locating the kit ─────────────────────────────────────────────────────────
// Env first (development), then the conventional checkout, then the packaged
// copy electron-builder ships as an unpacked resource.
function kitDir() {
  const candidates = [
    process.env.ARK_KIT_DIR,
    path.join(os.homedir(), "Projects", "agnostic-router-kit"),
    path.join(process.resourcesPath ?? "/nonexistent", "agnostic-router-kit"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "bin", "agnostic-router-kit.mjs"))) return path.resolve(c);
  }
  return null;
}

function kitHome() {
  return process.env.AGNOSTIC_ROUTER_KIT_HOME ?? path.join(os.homedir(), ".agnostic-router-kit");
}

function readRendered(kit) {
  // The rendered runtime carries the port and the local token; both come from
  // config.json — the same file the router itself reads, so the shell cannot
  // disagree with the process it starts.
  try {
    // The rendered config flattens the roster's router block: port and
    // localToken sit at the top level, next to the server's own names for
    // them (config.port, config.localToken).
    const cfg = JSON.parse(fs.readFileSync(path.join(kitHome(), "router", "config.json"), "utf8"));
    return { port: cfg.port ?? 8300, token: cfg.localToken ?? "local-auto-router", ok: true };
  } catch {
    return { ok: false };
  }
}

async function healthy(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1200) });
    return r.ok;
  } catch {
    return false;
  }
}

// Electron's own binary runs as plain node with ELECTRON_RUN_AS_NODE — the
// packaged app needs no system node for the ROUTER, only for npm (which only
// ever runs during preflight installs).
function nodeEnv() {
  return process.env.ELECTRON_RUN_AS_NODE
    ? process.env
    : { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
}

function nodeBin() {
  return process.env.ARK_NODE ?? process.execPath;
}

async function preflight({ log = console.log } = {}) {
  const result = { kit: null, installed: false, rendered: false, serviceHealthy: false, owned: false, problems: [] };

  const kit = kitDir();
  if (!kit) {
    result.problems.push("the agnostic-router-kit checkout was not found — set ARK_KIT_DIR or clone it to ~/Projects/agnostic-router-kit");
    return result;
  }
  result.kit = kit;

  const cli = path.join(kit, "bin", "agnostic-router-kit.mjs");
  const v = spawnSync(nodeBin(), ["--version"], { env: nodeEnv(), encoding: "utf8" });
  const nodeOk = v.status === 0 && Number.parseInt(v.stdout.replace(/^v/, ""), 10) >= 20;
  if (!nodeOk) {
    result.problems.push(`node 20+ is required (found: ${(v.stdout ?? "none").trim() || "none"}) — install an LTS from https://nodejs.org`);
    return result;
  }

  const depsOk =
    fs.existsSync(path.join(kit, "node_modules", "workflow-plane")) &&
    fs.existsSync(path.join(kit, "router", "node_modules", "@typesafe-ai"));
  if (!depsOk) {
    log("first run: installing dependencies (a few minutes, once)…");
    for (const [args, cwd] of [
      [["install"], kit],
      [["install", "--omit=dev"], path.join(kit, "router")],
    ]) {
      const r = spawnSync("npm", args, { cwd, encoding: "utf8" });
      if (r.status !== 0) {
        result.problems.push(`npm ${args.join(" ")} failed — ${(r.stderr ?? r.stdout ?? "").split("\n").slice(-3).join(" ").slice(0, 300)}`);
        return result;
      }
    }
  }
  result.installed = true;

  // The resumable rest of the installer: roster if missing, then dry run +
  // render. Exits non-zero when keys are missing — the one thing no wizard
  // can do for the user; the dialog says exactly that.
  const qs = spawnSync(nodeBin(), [cli, "quickstart", "--yes", "--skip-install", "--skip-service"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
  });
  result.rendered = fs.existsSync(path.join(kitHome(), "router", "config.json"));
  if (!result.rendered) {
    result.problems.push(
      "the router runtime did not render — most likely a provider key is missing: run `kit quickstart` in a terminal, paste the keys, then reopen this app",
    );
    return result;
  }

  const rendered = readRendered(kit);
  result.port = rendered.port;
  if (await healthy(rendered.port)) {
    result.serviceHealthy = true;
  } else {
    // Nothing else runs the router — the app owns it.
    const child = spawn(nodeBin(), [path.join(kitHome(), "router", "server.js")], {
      env: nodeEnv(),
      stdio: "ignore",
    });
    result.owned = true;
    result.child = child;
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      up = await healthy(rendered.port);
      if (!up) await new Promise((r) => setTimeout(r, 300));
    }
    if (!up) {
      result.problems.push("the router process started but never answered /healthz — check the router logs");
      return result;
    }
  }
  return result;
}

// ── electron glue (imported lazily so --preflight-check runs without it) ─────
async function run() {
  if (process.argv.includes("--preflight-check")) {
    const r = await preflight();
    console.log(JSON.stringify({ ...r, child: r.child ? { pid: r.child.pid } : null }, null, 2));
    if (r.child) {
      // The kill is a signal, not a state change — exiting before the child
      // is down can orphan it still bound to the port (seen live: an
      // electron-owned router survived its parent and squatted on 8394).
      await new Promise((done) => {
        const t = setTimeout(done, 2500);
        r.child.once("exit", () => { clearTimeout(t); done(); });
        r.child.kill();
      });
    }
    process.exit(r.problems.length ? 1 : 0);
  }

  const { app, BrowserWindow, dialog, shell } = await import("electron");
  const state = await preflight({ log: (s) => console.log(s) });

  if (state.problems.length) {
    dialog.showMessageBoxSync({
      type: "warning",
      title: "agnostic-router",
      message: "Setup is not finished yet",
      detail: state.problems.join("\n\n"),
      buttons: ["OK"],
    });
    app.exit(1);
    return;
  }

  const win = new BrowserWindow({
    width: 1220,
    height: 820,
    title: "auto-router",
    backgroundColor: "#0d1117",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  // External links (the packaged app has no address bar) go to the real
  // browser; the window itself only ever shows the router's own origin.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  await win.loadURL(`http://127.0.0.1:${state.port}/chat`);

  app.on("window-all-closed", () => {
    // An owned router dies with the app; an installed service outlives it.
    if (state.owned) state.child?.kill();
    app.quit();
  });
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
