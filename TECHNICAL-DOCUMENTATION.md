# agnostic-router-kit — Technical Documentation

> **For:** Developers working on the kit itself (architecture, data flow, internals)
> **Repo:** the harness-neutral edition of the model router — no coding harness is read, required, or referenced anywhere in `lib/` or `router/`

This document describes how the kit is built. For what it does from a user's perspective, see `FUNCTIONAL-SPECIFICATIONS.md`.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Tech Stack](#2-tech-stack)
3. [Architecture](#3-architecture)
4. [State & Storage](#4-state--storage)
5. [Router API Reference](#5-router-api-reference)
6. [The Workflow Runtime](#6-the-workflow-runtime)
7. [Local Security Model](#7-local-security-model)
8. [Dashboard](#8-dashboard)
9. [Service & Lifecycle](#9-service--lifecycle)
10. [Deployment (new machine)](#10-deployment-new-machine)
11. [Development Workflow](#11-development-workflow)
12. [CLI Reference](#12-cli-reference)
13. [Observability](#13-observability)

---

## 1. Project Overview

One repo owns three things:

1. **the local model router** — an OpenAI-compatible proxy on `127.0.0.1` that routes each request to the right upstream by workload, with a judge, a mixture path, quota-aware failover, and an usage ledger;
2. **the provider roster** — which plans exist on this machine, their keys (by env-var *name*), their models, and the tier table;
3. **the workflow library** — saved workflows plus the runtime that runs them, with the router's assignment registry generated from the library's own metadata.

The edition boundary: this repo shares the router's behavior with the ZCode edition but has **no adapter slot for any harness**. A client integrates by pointing an OpenAI-compatible SDK at the router; a workflow runs on the kit's own runtime. Where the ZCode edition merges into an app's provider config, this edition has nothing to merge into — `kit apply` renders the router's runtime and its keepalive service, and that is all it writes.

## 2. Tech Stack

Node ≥ 20 (developed on 24), zero runtime dependencies for the router except the TypeSafe SDK for the judge, no build step for the dashboard (single vanilla-JS HTML file), plain CommonJS for the router and ESM for the kit's `lib/`. Tests are ad-hoc CLI smoke tests (`kit doctor`, curl, `kit workflows run`), not a suite.

## 3. Architecture

```
roster.json ──kit apply──┬── <kit home>/router/config.json   tier table, MoA, workflow registry, extraUpstreams
                         ├── <kit home>/router/.env          keys (chmod 600, written by kit env set)
                         ├── <kit home>/router/*.{js,html}   the router runtime, copied from this repo
                         └── launchd / systemd service       keeps the router running
```

Two programs, one data flow:

- **`lib/cli.mjs` + `lib/*.mjs`** — the kit. Loads and validates the roster (`roster.mjs`), renders the router config (`render.mjs`), reads workflow metadata into the registry (`workflowlib.mjs`), manages the runtime `.env` (`envstore.mjs`), installs the service (`service.mjs`), exports a live machine back into a roster (`export-live.mjs`), and runs workflows (`lib/workflow/*`).
- **`router/server.js`** — the router. An OpenAI-compatible proxy. For an `auto` request: capability rules first (images → `omniModel`, width → `wideModel`), then the per-session judgment cache, then the judge (workload, execution, workflow, followUp — one cached verdict per task), then execution as `single`, `mixture` (parallel proposers + integration judgment), or `swarm` (decompose → parallel build → per-part gate → integrate → cold read → deliverable gate, see `docs/features/swarm-execution.md`), walking the tier's candidate chain with quota awareness and failover. Every attempt lands in the usage ledger.

Upstream resolution is deliberately tiny: every roster provider with a `baseUrl` renders into `config.extraUpstreams` with its `apiKeyEnv` name, and the router reads the value live from its own `.env`. There is no provider config merge layer in this edition — that was ZCode-specific.

Full request lifecycle: `docs/features/judge-delegation.md` (ported in the ZCode edition); diagrams in `docs/img/`.

## 4. State & Storage

There is no database. Five kinds of state:

| State | Location | Written by | Committed? |
|-------|----------|------------|------------|
| Roster (source of truth) | `roster.json` (repo root) | human, or dashboard `PUT /api/roster` | **yes** — env-var names only, never keys |
| Router config | `<kit home>/router/config.json` | `kit apply` (rendered) | no |
| Router runtime + keys | `<kit home>/router/*`, `.env` (chmod 600) | `kit apply` / `kit env set` | no — never |
| Usage ledger | `<kit home>/router/logs/usage.json` | router (atomic write, debounced ~3s, 30-day retention, 200-entry recent ring) | no |
| Workflow runs | `<kit home>/workflow-runs/<ts>-<name>/` | the workflow runtime (journal, artifacts, summary) | no |

`AGNOSTIC_ROUTER_KIT_HOME` moves the whole runtime root (used by tests and for side-by-side instances); `AGNOSTIC_ROUTER_DIR` moves just the router; `AGNOSTIC_ROUTER_KIT_ROSTER` moves the roster. Defaults live under `~/.agnostic-router-kit`.

## 5. Router API Reference

OpenAI-compatible, loopback-only, on `127.0.0.1:8300` (roster `router.port`). All endpoints except `/healthz` and the dashboard page require `Authorization: Bearer <localToken>` (default `local-auto-router`).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/healthz` | liveness (no auth) |
| GET | `/v1/models` | models the router exposes |
| POST | `/v1/chat/completions` | the routing endpoint (streaming supported; tool calls supported) |
| POST | `/route` (`/v1/route`) | verdict only — workload/execution/workflow assignments, no model call |
| GET | `/dashboard` | dashboard page (local token injected) |
| GET | `/api/state`, `/api/usage`, `/api/suggest`, `/api/roster` | dashboard data: live state, ledger, distribution suggestions, effective roster |
| PUT | `/api/roster` | dashboard saves an edited roster → the kit's apply path |
| POST | `/api/usage/reset` | clear the ledger |

Responses carry `x-router-execution`, `x-router-workload`, `x-router-workflow`; a tier walk adds `x-router-failover`. Versioning: none — this is a personal single-consumer API.

## 6. The Workflow Runtime

A workflow is a TypeScript file under `workflows/` that runs on the kit itself. The engine (`lib/workflow/engine.mjs`) loads it by **text transform**, not by framework:

1. Each `.ask<T>(…)` call site is rewritten to carry the JSON schema parsed from the interface `T` names in the file's own text — TypeScript erases type arguments at runtime, and the runtime refuses to depend on a TS compiler to get them back.
2. The whole file is wrapped in one async function, so a workflow's top-level `return` is simply that function's result.
3. The transformed module is written to the run directory (`module.mts`) and imported, with the API surface bound as globals it resolves to.

The surface: `agent(name, persona).ask<T>()`, `args`, `phase`, `log`, `report`, `artifact.file|markdown`, `files.glob|read|grep`, `git.changedFiles|diff|status|log`, `world.run(cmd, args)`, `world.remember(kind, fact)`, `world.facts()`, `world.command.{start,poll,stop}`, `world.checkpoint|rollback`. Agents get OpenAI-shaped tools (`read_file`, `list_files`, `search_files`, `write_file`, `edit_file`, `run_command`, `start_command`, `poll_command`, `stop_command`, `escalate`, `recall`, `delegate`, plus `submit_result` when a type argument is present) confined to the run's workspace, with a command allowlist and output caps. The three background-command tools are `run_command` with the tool round handed back: they run the same allowlist, the same classified capability and the same install policy, return a handle immediately, read output from an offset so a poll is a stream rather than a re-read, and carry a 15-minute lifetime cap with an idempotent stop; the run journal records each one as `service` events (`start`, `exit`, `stop`, `lifetime-expired`) with the exit code or the signal that killed it. `delegate` is off unless the run grants the `sub-agents` capability; it spawns a real agent of the run with an empty context, and the child's contract, agent lines and tool calls are journalled under `Parent → delegate` with its asks and tool calls added to the parent's stats. The depth cap is one and it is structural: a child's surface has no `delegate` definition, implementation or spawner at all. A part's build also runs under a per-part checkpoint (`lib/workflow/checkpoint.mjs`): the plane snapshots the part's declared paths before it builds and restores them when the part throws or when its report does not check out, so a failed part leaves no debris in the champion's tree. The snapshot covers the declared paths only — the exclusive ownership `validateContract` enforces is what a rollback restores to — is byte-exact, is idempotent, refuses a path outside the workspace at both ends, and is journalled as `checkpoint` (paths, bytes, cap-exceeded, or the refusal) and `rollback` (restored, removed, uncaptured, left) events. The plane also keeps one fact store per run — the declared kinds are `task`, `stack`, `environment`, `decision`, `verdict`, `status`, `phase` — written only by `world.remember`, read by an agent through `recall` (public facts plus its own part's, byte-capped, journaled) and by the plane itself through `world.facts()`. A fact known at dispatch belongs in the brief; `recall` exists for what arises after it. Every ask is also accounted in tokens: the upstream's own usage block (a streamed completion's final chunk) is summed into an `account` journal line per ask, with the plane's four-characters-a-token measure used only where a provider reports nothing — and the run summary counts which calls were measured rather than reported. An agent's `stats` carry its prompt/completion tokens, tool calls and compactions, and a delegated child's land on the parent's the way its asks and tool calls already do. When a prompt crosses the line (`--compact-tokens`, default 120k) the plane compacts the agent's history instead of letting the ask die at the provider's window: the system message and the brief (instructions, the rendered contract, the run's measured facts) survive verbatim by rule, everything else becomes one summary from exactly one deterministic ask at temperature 0 with no tools, and if that ask fails the history is truncated with a marker rather than the ask dying. The journal carries `compact` (before/after, summarized, kept, summarize-or-truncate, too-old-to-summarize) beside the `account` lines. Every model call goes through the router's own `/v1/chat/completions`, so a workflow run is metered in the same ledger as every other request and inherits failover — and is deliberately never routed to `swarm` (the default is the `hard` profile).

Contract and porting rules: `docs/features/workflow-runtime.md`. The generator: `lib/workflowlib.mjs` builds the assignment registry from the shipped files on every `kit apply`, so the router can never assign a workflow that does not exist.

## 7. Local Security Model

- The router binds to `127.0.0.1` only; there are no user accounts, sessions, or roles — the machine boundary plus the bearer local token is the whole model.
- Upstream keys live only in `<kit home>/router/.env` (600). The roster references them by `apiKeyEnv` name; `roster.json` is committed and must never contain a raw key (`kit apply` warns if it does).
- Workflow agents are confined to their run's workspace by path resolution, run commands from an allowlist with fixed argv (no shell, no globs, no substitution), and get capped output — a workflow cannot read the roster, the `.env`, or anything else on the machine.
- A `billing: "payg"` provider is refused as a routing target without explicit `allowPayg: true`.

## 8. Dashboard

Single-file `router/dashboard.html`, served by the router at `/dashboard`, no build step. Tabs: usage per model/day (SSE live view over the ledger's recent-request ring), suggestions (`/api/suggest` ranks models by measured latency, errors, declared context, quota headroom, optional `strength`), and the workflow registry/library view with install state.

Operational reference: `docs/features/dashboard.md`.

## 9. Service & Lifecycle

`kit apply` installs a **launchd user agent** (macOS) or **systemd user unit** (Linux) that keeps the router running and restarts it on failure; `kit apply` restarts it after re-rendering and health-checks `/healthz`. On other platforms the kit prints manual run instructions. Background jobs: none — the router is a single long-lived process; metering, quota windows, and cache eviction all happen in-process.

## 10. Deployment (new machine)

```bash
git clone <repo> agnostic-router-kit && cd agnostic-router-kit
npm install                                   # the kit itself
node bin/agnostic-router-kit.mjs init --template
node bin/agnostic-router-kit.mjs env set XIAOMI_MIMO_API_KEY=… STEPFUN_API_KEY=…
node bin/agnostic-router-kit.mjs apply --dry-run
node bin/agnostic-router-kit.mjs apply
node bin/agnostic-router-kit.mjs doctor [--live]
# then, in any OpenAI-compatible client:
#   base URL http://127.0.0.1:8300/v1   api key <localToken>   model auto (or quick/code/hard/prose/…)
```

On an already-running machine, `kit export --out roster.json` produces a key-free roster from the live router config.

Single-branch topology: `master` is everything; "deploy" = `kit apply` on the machine (idempotent). `kit upgrade` = `git pull && kit apply`.

Side-by-side instances (tests, experiments): `AGNOSTIC_ROUTER_KIT_HOME=/tmp/other node bin/agnostic-router-kit.mjs apply --port 8401 --only router` then `node /tmp/other/router/server.js`. The live instance on its own port is never touched.

## 11. Development Workflow

The plan-build-recap-document cycle: feature plan in `docs/plans/`, implementation on a branch, evidence-gated acceptance criteria, session recap, then the housekeeping protocol in `CLAUDE.md` (update the feature doc and the two spec files in the same change). Commits are conventional-prefixed and made by the developer — never automatically by a tool.

## 12. CLI Reference

| Command | What it does |
|---------|--------------|
| `kit status` | what is installed, where, and whether the service is up |
| `kit init --template` | write a starter roster to edit |
| `kit env set\|unset\|list` | manage the runtime `.env` (keys only, 600) |
| `kit apply [--dry-run] [--only router\|service] [--port N]` | render config, copy the runtime, install the service |
| `kit doctor [--live]` | verify the whole chain, change nothing (names the sys1 dependency) |
| `kit route "task…"` | ask the running router for its verdict |
| `kit export [--out f]` | derive a key-free roster from the live router config |
| `kit workflows list\|run\|last` | the shipped workflow library |
| `kit upgrade` | git pull + apply |

## 13. Observability

- **`kit status`** — install state, port, service, env-file mode.
- **`kit doctor`** — the full chain: roster keys, rendered targets, upstream liveness (`--live`), sys1 reachability, workflow registry cross-check.
- **`kit workflows last`** — the most recent run's outcome: duration, agent/tool counts, conclusion, journal path.
- **`router.log`** — one JSON line per routed request (tier, target, failover, judge reason, latency).
- **`usage.json` + `/dashboard`** — the ledger: calls, errors, tokens, latency per model per day, plus the recent-request ring streamed over SSE.
- **`workflow-runs/<run>/run.jsonl`** — a workflow run's full audit: phases, reports, tool calls (with `grant`/`refused`, and for `recall` the facts, ids and bytes it returned), commands, escalations, contracts, `delegate` spawn/done/failed lines with the child's parent label, and `checkpoint`/`rollback` pairs with each part's path count and what the restore did., and per-ask `account` lines (tokens, rounds) with the `compact` lines of the compactions they needed.
