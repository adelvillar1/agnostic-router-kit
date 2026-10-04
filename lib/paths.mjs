/**
 * agnostic-router-kit — one repo, two things:
 *
 *   1. the local model router (an OpenAI-compatible proxy that routes each
 *      task to the right upstream model by workload, judging with sys1's
 *      decide provider and/or TypeSafe Jev),
 *   2. the provider roster — which plans exist on this machine, their keys
 *      (by env-var reference only), their models, and the workload tier
 *      table mapping router profiles onto them.
 *
 * `kit apply` renders everything the router needs from the roster:
 *   ~/.agnostic-router-kit/router/config.json   (the router's tier table)
 *   ~/.agnostic-router-kit/router/.env          (keys, chmod 600)
 *   ~/Library/LaunchAgents/…plist               (or systemd user unit)
 *
 * Every path below is env-overridable so the repo can be tested against a
 * scratch home: AGNOSTIC_ROUTER_KIT_HOME moves the whole runtime root.
 *
 * The harness-agnostic contract: no path in here references any harness's
 * home directory. A client routes through the router by pointing its
 * OpenAI-compatible base URL at http://127.0.0.1:<port>/v1 — nothing else.
 */
export const KIT_VERSION = "1.0.0";
export const ROSTER_VERSION = 1;

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOME = os.homedir();

/** The kit repo itself (…/agnostic-router-kit). */
export const KIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The kit's runtime home — where the router lives and runs from. */
export const KIT_HOME = process.env.AGNOSTIC_ROUTER_KIT_HOME ?? path.join(HOME, ".agnostic-router-kit");

/** The router runtime directory (config, keys, logs, node_modules). */
export const ROUTER_DIR = process.env.AGNOSTIC_ROUTER_DIR ?? path.join(KIT_HOME, "router");

export const KIT_WORKFLOWS_DIR = path.join(KIT_DIR, "workflows");
export const KIT_ROUTER_DIR = path.join(KIT_DIR, "router");
export const KIT_TEMPLATES_DIR = path.join(KIT_DIR, "templates");

/** One roster per machine; never contains raw keys (env-var refs only). */
export const ROSTER_PATH = process.env.AGNOSTIC_ROUTER_KIT_ROSTER ?? path.join(KIT_DIR, "roster.json");

export const ENV_FILE = path.join(ROUTER_DIR, ".env");
export const ROUTER_LOG = path.join(ROUTER_DIR, "logs", "router.log");

/** launchd/systemd label for the keepalive service. */
export const SERVICE_LABEL = "com.agnostic-router.model-router";

/** Render a path the way server.js's own `expand()` understands it. */
export function tilde(p) {
  return p.startsWith(HOME + path.sep) ? "~" + p.slice(HOME.length) : p;
}

export function platform() {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") return "linux";
  return "unsupported";
}
