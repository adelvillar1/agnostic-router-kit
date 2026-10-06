# Architecture Overview

A harness-neutral model-routing engine and the workflow plane it runs. Node.js ≥ 20, ESM only, zero runtime deps.

The interactive render is the reference; this page is the text you can read without opening it. Every node and edge in
the diagrams carries a `sources` entry pointing at the file and lines that make it true, and the candidates that
generate them live beside the renders.

| Diagram | Candidate | Interactive render |
|---------|-----------|--------------------|
| System overview — components, boundaries, connections | [`system-overview.candidate.json`](system-overview.candidate.json) | [`system-overview.html`](system-overview.html) |
| Run lifecycle — spawn, phases, escalation, settlement | [`run-lifecycle.candidate.json`](run-lifecycle.candidate.json) | [`run-lifecycle.html`](run-lifecycle.html) |
| Deep-research loop — the meter, the judge, the stop reasons | [`deep-research-loop.candidate.json`](deep-research-loop.candidate.json) | [`deep-research-loop.html`](deep-research-loop.html) |

## The one thing that matters

```
roster.json ──kit apply──┬── ~/.agnostic-router-kit/router/config.json   tier table, judge mode, apps and ceilings
                         ├── ~/.agnostic-router-kit/router/              the service copy of router/
                         ├── ~/.agnostic-router-kit/router/.env          env-var NAMES only; values stay local (chmod 600)
                         └── ~/.agnostic-router-kit/workflow-runs/<id>/  run.jsonl, summary.json, artifacts/

POST /v1/chat/completions ──► one bearer gate ──► judge (workload · execution · workflow · followUp)
                                  │                    │
                                  │                    └─► typesafe (default) | fastino | cascade
                                  └─► two token classes: operator localToken (no ceiling) vs an apps row
                                      (own token + grant ceiling + workspace root)
```

Two token classes behind one gate is the whole security model. Everything else is routing.

## Components

| Component | Files | Role |
|-----------|-------|------|
| CLI | `bin/agnostic-router-kit.mjs`, `lib/cli.mjs` | `status/init/export/env/apply/doctor/workflows/apply-runs/route/upgrade` |
| Roster model | `lib/roster.mjs` | load and validate; tiers with ordered fallbacks; `apps` rows with ceilings and roots |
| Renderer | `lib/render.mjs` | roster → router `config.json` (tiers, judge, MoA, app gate, localToken) |
| Env store | `lib/envstore.mjs` | `~/.agnostic-router-kit/.env` (600); references by env-var name |
| Router | `router/server.js` | OpenAI-compatible proxy on `127.0.0.1:8300` (`node:http`, no framework) |
| Run API | `router/server.js` | `POST /v1/runs`, `POST /v1/runs/<id>/answers`, `GET /v1/runs/<id>/artifacts` |
| Judge | `router/fastino.mjs` + `@typesafe-ai/sdk` | one verdict per task; fail-open above the HTTP layer |
| Quota and usage | `router/quota.mjs`, `router/usage.mjs` | allowance calibration, headroom, steering, cooldown benches, usage ledger |
| Suggester | `router/suggest.mjs` | model ranking: measured latency/errors, declared context, quota headroom, `strength` |
| Mixture of agents | `router/swarm.mjs` | parallel proposers, best answer judged by TypeSafe |
| Dashboard | `router/dashboard.html` | usage, app grants, delegation editor; saves through the same kit CLI |
| Service | `lib/service.mjs` | launchd (macOS) / systemd (Linux) user unit with keepalive |
| Workflow plane | `lib/workflow/` (13 modules, resolved as a `file:` package) | the harnessed agent control plane: run state, judging and gates, tool grants and the world, transport, event journal and graph |

## Data flow for the common request

ZCode (or any OpenAI-compatible client) sends `POST /v1/chat/completions` with `model: auto-router/auto`:

1. **Bearer gate**: operator token or an app token; an app token is bound to its grant ceiling and workspace root.
2. **Judgment cache**: hash of system-prompt head + latest instruction; a hit reuses the verdict.
3. **Judge** (one verdict per task, fail-open): workload tier, execution (`single`/`mixture`), first workflow, optional follow-up. Backends: `typesafe` (default), `fastino` (GLiNER2.5 encoder over sys1), `cascade` (fastino first, TypeSafe escalates).
4. **Execution**: a single call; or parallel proposers plus an integration judgment (mixture); or delegate to a workflow in the library.
5. **Tier chain walk**: quota-aware candidate order; upstream `402/403/408/429/5xx` or a connection failure moves to the next candidate and opens a cooldown bench.
6. **Metering**: every attempt (won, diverted, lost) lands in the usage ledger; verdict headers ride the response.

## Data flow for a workflow run

1. **Spawn**: `POST /v1/runs` names a workflow module and its args. The server re-derives the owning app from the journal's `run-start` line, so a restart never loosens the gate.
2. **Spawn gate**: the grant ceiling and the workspace root are checked against the caller; a refusal is a 403 that names which one, then the run never starts.
3. **Plane**: `runWorkflow` resolves grants and facts, transforms the module, and binds the API surface as globals (`args, agent, log, phase, report, escalate, artifact, files, git, world, sys1`).
4. **Loop**: phases call agents, which call back through `127.0.0.1:8300` with the operator token — so steering, failover, and the mixture still apply inside a workflow.
5. **Escalation**: an unknown fact escalates through declared answers → live `answers.jsonl` → question-substring match → `askOwner` → a recorded "no owner" answer; the resolving source is journalled.
6. **Settlement**: `run.jsonl` holds every event; `summary.json` and the artifacts close the run and emit `run-done` / `run-failed`.

## Design invariants

- `roster.json` is the single source of truth; everything under `~/.agnostic-router-kit/` is rendered and never hand-edited.
- The workflow plane is `lib/workflow` in this repo and ships to the runtime as a `file:` package; the ZCode edition resolves it from here rather than copying it.
- Keys live only in `~/.agnostic-router-kit/.env`, referenced from the roster by env-var name; a raw `apiKey` in the roster is a warning and a migration.
- Fail-open everywhere above the HTTP layer: judge outage, missing key, low confidence, sys1 down → default workload, tagged in the log, request still served.
- Degraded state is never silent: remaps, failovers, refused runs, and skipped workflows are reported by `status` / `apply` / `doctor` and in response headers.
- The engine is harness-neutral: no ZCode-specific paths in `lib`, `bin`, `router`, `roster.json`, or `templates`.

Deeper dives: the per-feature files in [`docs/features/`](../features/) and the internals record in
[`TECHNICAL-DOCUMENTATION.md`](../TECHNICAL-DOCUMENTATION.md).
