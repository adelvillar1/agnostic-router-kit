# agnostic-router-kit

A local, harness-agnostic model router. Point any OpenAI-compatible client at
`http://127.0.0.1:8300/v1` and it gains one extra model id — `auto` — that
routes each request to the right upstream plan by workload, judged per task,
with quota-aware failover and every token metered.

No harness is required, none is referenced, none is read. The router knows
your roster and nothing else.

## What it does

- **Routes by workload.** One judgment per task (cheap encoder via
  [sys1](https://github.com/adelvillar1/sys1)'s decide provider, or TypeSafe
  Jev, or cascade = sys1 first, Jev escalates on low confidence) picks one of
  your tiers — `quick`, `standard_code`, `hard`, `prose`, `deep_context` —
  each mapped to a provider/model with a fallback chain.
- **Respects plans.** Quota-aware steering walks the tier's candidate chain,
  records every attempt in a usage ledger, and never fails a request: judge
  outages, missing keys, and exhausted quotas degrade to the next candidate.
- **Mixture for the hard stuff.** Named profiles fan out to parallel
  proposers and merge with a best-answer judgment.
- **Dashboard.** The router serves its own dashboard at `/dashboard` — roster
  editing, ledger, tier status, judge behavior, save-and-apply.

## Quickstart

```bash
# 1. run sys1 (decision service on 127.0.0.1:8400) — or set judge.mode=typesafe
#    https://github.com/adelvillar1/sys1
git clone https://github.com/adelvillar1/sys1 && cd sys1 && ...   # see its README

# 2. install this kit
git clone <this repo> && cd agnostic-router-kit
(cd router && npm install --omit=dev)          # @typesafe-ai/sdk, the judge client

# 3. roster + keys
npm run kit -- init --template                 # writes roster.json to edit
vim roster.json                                # your plans, tiers, fallbacks
npm run kit -- env set STEPFUN_API_KEY=… TYPESAFE_API_KEY=… ZAI_CODING_API_KEY=…

# 4. apply
npm run kit -- apply --dry-run
npm run kit -- apply
npm run kit -- doctor                          # sys1, tiers, keys, service — green?

# 5. point a client at the router
curl http://127.0.0.1:8300/v1/chat/completions \
  -H "Authorization: Bearer local-auto-router" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"say hi"}]}'
```

`model` accepts `auto`, any profile name in the roster (`quick`, `code`,
`hard`, `prose`, `long-context`, `vision`, `mixture`, `deep`, `bulk`), or a
literal `providerId/modelId` target.

## Layout

```
roster.json                  the machine: providers (keys by env name), tiers, profiles
templates/roster.defaults.json   starter roster for `kit init --template`
bin/agnostic-router-kit.mjs  the `kit` CLI
lib/                         roster model + resolution, render, .env, service, CLI
router/                      the proxy: server.js, quota, usage, judge (fastino/sys1), dashboard
docs/                        diagrams
```

`kit apply` copies `router/` into the runtime dir (`~/.agnostic-router-kit/router/`)
and renders `config.json` from the roster; a launchd/systemd user service keeps
the runtime copy alive, so `git pull` + `kit upgrade` never moves the service.

## Commands

```
kit status                 what's installed, tiers, health, remaps
kit env set|list|unset     manage the runtime .env (chmod 600)
kit apply [--dry-run]      render + install (--only router|service)
kit doctor [--live]        verify the whole chain, change nothing
kit route "task…"          ask the running router for its verdict
kit upgrade                git pull + apply
```

## Security model

- Router listens on `127.0.0.1` only. All endpoints except `/healthz` and the
  dashboard page require the local token (`router.localToken` in the roster).
- The run API adds app tokens: `router.apps` rows in the roster, each with its
  own token, a grant ceiling its spawns are enforced against, and its own
  workspace root. A token's blast radius is its ceiling.
- Keys live only in the runtime `.env` (chmod 600, gitignored) and env
  variables. `roster.json` holds env-var *names*, never values.

## Roadmap

Shipped 2026-10-05/06: the run API (`POST /v1/runs`, live escalation answers,
artifact retrieval — `docs/features/run-api.md`) and the loop library
(`docs/features/loop-library.md`) — deep-research, remediate, triage,
refine-loop, red-team, watchdog, router-eval — with flat judgments riding the
sys1 judge layer and search credits budgeted in the workflow.
Wave 2: portable workflow library (chat-only workflows + vendored skill trees,
no absolute paths). Wave 3: proxy-internal swarm execution. Wave 4: swarm
gates composed from dev-decisions. Next: an AG-UI rendering of the run event
stream. See `docs/plans/`.
