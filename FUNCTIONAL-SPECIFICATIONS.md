# agnostic-router-kit — Functional Specifications

> **For:** Product/UX reference and developer onboarding (user-flow contract)
> **Users:** any developer running any OpenAI-compatible client on a machine this kit configures
> **Edition note:** this kit is the harness-neutral edition of zcode-router-kit. Nothing here reads, requires, or references a coding harness; the only integration surface is an OpenAI-compatible base URL.

This is the user-flow contract — what the system does from the user's perspective. It captures intended behavior, edge cases, and the rules that govern features. This is a local developer tool, not a SaaS app: there are no accounts, subscriptions, or notifications, and sections are shaped accordingly.

This file stays in sync with the implementation as part of finishing a feature (see CLAUDE.md "Housekeeping protocol"). When a feature ships or changes, update both `docs/features/<name>.md` (operational reference) and the matching section here.

---

## Table of Contents

1. [Access Model](#1-access-model)
2. [Plans & Billing Safety](#2-plans--billing-safety)
3. [Core Features](#3-core-features)
4. [User Flows](#4-user-flows)
5. [Admin Tool: the Dashboard](#5-admin-tool-the-dashboard)
6. [The Workflow Runtime](#6-the-workflow-runtime)
7. [Failover & Degraded States](#7-failover--degraded-states)
8. [Edge Cases & Error States](#8-edge-cases--error-states)
9. [UI Consistency Standards](#9-ui-consistency-standards)

---

## 1. Access Model

Single-user, single-machine. The router binds to `127.0.0.1` and every API call beyond `/healthz` carries the local bearer token (roster `router.localToken`, default `local-auto-router`). There is no signup, login, or password reset; "who may use this" equals "who is on this machine". A client integrates by setting a base URL and key — no harness-specific adapter exists or is needed.

## 2. Plans & Billing Safety

The kit's economic contract — what protects the user's prepaid plans:

- Providers are declared with `billing: "plan"` or `"payg"`. **A pay-per-token provider can never be a routing target** unless the roster explicitly opts in with `allowPayg: true`.
- The router never imposes artificial token limits; `routing.wideChars` only diverts oversized payloads to a large-context model.
- Quota: a plan's allowance may be declared and calibrated against console readings through the off-peak-weighted ledger; plans under 5% headroom are never suggested as primaries, and steering prefers plans with headroom. Undeclared providers are left alone.

## 3. Core Features

**Roster-driven upstreams.** Entry point: `roster.json` → `kit apply`. Each provider declares `baseUrl`, `apiKeyEnv` (an env-var *name*, never a value), billing, models, optional `featured` list, and `routerOnly`. Every provider renders into the router's own config as an `extraUpstreams` entry whose key is read live from the router's `.env` — so provider credentials live in exactly one 600-mode file that never leaves the machine.

**Workload tiers with fallbacks.** `quick` / `standard_code` / `hard` / `prose` / `deep_context`, each mapping to a concrete model with an ordered fallback list. A fallback fires only when its target has no key or is disabled — never for quality reasons — and every fire is reported as a remap by `status`/`apply`/`doctor`.

**Auto routing (the judge).** For `auto` requests, one cached judgment per task answers: workload (tier), execution (`single`/`mixture`/`swarm`), first workflow, optional follow-up workflow. Backend is pluggable: `typesafe` (default), `fastino` (a local GLiNER2.5 model served by a sys1 appliance), or `cascade` (fastino first, TypeSafe escalates). Judgment sends only compact signals — never the conversation or files. The sys1 dependency is named explicitly by `kit doctor`: green when the appliance answers, a specific failing check when it does not, and the typesafe-only mode still serves requests with it down.

**Mixture of agents.** One hard, non-decomposable question fans out to `mixture.proposers` (different plan pools/model families) in parallel; a proposal judgment picks the best and decides whether merging adds value — the aggregator runs only when it does. Turns carrying tool definitions skip mixture and fall back to the hard tier.

**Swarm execution.** When the judge sees a decomposable task — several substantial independent parts, or work whose quality depends on critique rounds — the router runs the swarm itself: decompose, build the parts in parallel across an independent worker pool, gate each part, integrate the survivors, cold-read the merged answer, gate the deliverable, reply. The decomposition contract is **atomic parts**: each part must be completable as one standalone completion by one worker that sees only the request and its own instruction — the swarm is many standalone completions, orchestrated in parallel, assembled once. Every model call streams (an idle cap aborts a silent connection; a healthy long generation is never killed for running long) and reassigns down the roster pool on failure, the way a single call walks its tier chain. Every call is metered under the swarm execution bucket with its stage named, so the ledger shows swarm spend per stage. A harness with no runtime of its own gets the same shape of work a full agent harness gets. A swarm that cannot run as a swarm degrades to a single tier call — a tool-carrying turn, an undecomposable task, too few parts built — and never fails the request. The part-acceptance and deliverable gates are not model calls: they run the `dev-decisions` CLI, whose verdicts are calibrated ground truth rather than a threshold set inside the router.

**Thinking levels.** Profiles may force thinking `deep` or `off` per provider dialect (`routing.thinkingStyles`); `auto` strips reasoning params as always.

**Workflow library, registry, and runtime.** Ten saved `.ts` workflows that the router can assign *and* that run on the kit's own runtime (`kit workflows run …`), each producing versioned artifacts and a full journal. The registry is generated from each file's metadata header on every `kit apply` — library and registry cannot drift. Adding a workflow = drop the file in `workflows/` + `kit apply`.

**Usage ledger + dashboard.** Every upstream call is metered (calls, errors, tokens, latency, per model per day, mixture proposers included) and visible at `/dashboard`, which also edits the roster. Workflow and swarm runs are metered by the same ledger, because their model calls go through the same proxy.

## 4. User Flows

**New machine:** clone → `npm install` (the kit) → `kit init --template` → `kit env set …` for each key → `kit apply --dry-run` → `kit apply` → `kit doctor` → point any OpenAI-compatible client at `http://127.0.0.1:8300/v1` with the local token and model `auto` (or a pinned profile).

**Clone a machine's routing:** on a machine that already runs the kit, `kit export --out roster.json` — the roster is derived from the live router config, key-free by construction.

**Everyday:** `kit status` / `kit doctor` to check the chain; `kit route "…"` to preview a verdict; the dashboard to watch usage and tune delegation; `kit upgrade` to pull and re-apply.

**Run a workflow:** `kit workflows list` → `kit workflows run <name> --args '{…}' --workdir <project>` → `kit workflows last` for the outcome.

**Add a workflow:** drop the `.ts` into `workflows/`, `kit apply`, done — its metadata header supplies description, task arg, and routing shape.

## 5. Admin Tool: the Dashboard

The dashboard is the kit's only UI — usage tabs (live via SSE), the registry/library view with install state, and model-strength-aware suggestions. It authenticates with the local token (stamped into the served page). Saves go through `PUT /api/roster`, which writes the roster and re-applies — the dashboard can never produce state the kit wouldn't.

Two tabs watch the kit's own workflow work and are strictly read-only. **Activity** lists every run the kit has written, active or finished, live over the journal tail — an open run with nothing landing for 2+ minutes is marked stalled, ages refresh every 5s, and a click on a row opens its detail (phases, agents, tool counts, gate verdicts, event feed). **Board** turns the same sources into a kanban of work items: four columns — Planned, Executing, Completed, Abandoned — where one card is one work item (a plan with the runs it dispatched, or a run on its own) carrying its deliverables, its agent assignment, and what the agent is doing right now. Clicking a card opens that task's detail, and a run detail carries an "open run in Activity tab" cross-link back to the live feed. Cards move as a run starts, finishes or fails, so an executing run is visible without a refresh. The layered DAG the board replaced sits one toggle away over exactly the same data. Nothing on either surface writes — the kit CLI stays the only writer.

## 6. The Workflow Runtime

A workflow is one TypeScript file that runs on the kit itself, with no harness present. The contract, in full, lives in `docs/features/workflow-runtime.md`; the user-visible rules:

- **Arguments are checked before the first model call.** The file's metadata header declares them (type, description, required, default); `kit workflows run` rejects a missing or unknown argument instead of failing halfway.
- **Everything a workflow does is confined to one workspace** passed as `--workdir`. File tools refuse paths that escape it; commands run with fixed arguments (no shell) from an allowlist.
- **Every model call is routed and metered.** Agents do not choose their model; every call goes through the router, so a run appears in the same usage ledger as every other request.
- **Local browsing is granted, not ambient.** Rendered pages and scrapes run through the operator-installed moli browser behind the `browser` grant (default-off, opted in at spawn like net fetch); page reading rides a scrape ladder — local moli, then the operator's self-hosted Firecrawl, then plain bounded fetch — with the journal's `via` naming the leg that answered; search's `auto` backend is keyless-first (DuckDuckGo) with Firecrawl as the paid quality fallback. moli is never bundled or auto-downloaded: `kit doctor` reports it green with a version when installed and as a dim note (not a failing check) when absent — a configured absence, like a missing key. See `docs/features/browsing.md`.
- **A run is auditable after the fact:** phases, reports, tool calls, commands, and escalations go to `run.jsonl`; the transformed code that ran is kept as `module.mts`; deliverables are versioned under `artifacts/`.
- **Portability is a rule, not a hope:** no machine-absolute paths, no references to trees outside the repo. `grep -rn "/Users/" workflows/` returning nothing is a shipped property of the library, not a lint that runs once.

## 7. Failover & Degraded States

The router's answers to "what if a plan is down":

- **Every failure is classified before it is benched** (`router/failclass.mjs`, pure functions, unit-table tested). Two laws: the usage-limit vocabulary is matched *before* the 429 pattern — a subscription's window is hours away, so its limit is terminal (quota) even when the provider phrases it as a rate limit; and quota/billing/rate-limit bodies are **never** a key rejection — the key is not the thing that is exhausted. Verdicts: `quota` (bench 30 min), `rate` (Retry-After honored, else 5 min), `key` (bench 60 min, remembered per base-url + key fingerprint on `/api/state` as `keyRejections` — fingerprint only, never key material), `model` (walk, bench nothing — another provider may carry the model), `transient` (1 min), `client` (pass through, no walk), `network` (1 min). The roster's `failover.cooldowns` override still wins first.
- A serving upstream answering `402`/`403`/`408`/`429`/`5xx` — or failing to connect — sends the tier walk to the next candidate; the failed provider is benched per its classification above. Client errors (400/404) pass through untouched. A benched provider steers as zero headroom: it is moved out of the target slot while any healthy candidate exists, and the walk skips it in fallback position.
- **Capability parity**: a roster may declare per-model caps (`manualModelRules`: optional `supportsImages`, `supportsTools`, `contextWindow`). A fallback that would silently drop a capability the request carries (an image to a text-only model, tools to a no-tools model) is excluded from the chain *before* steering and recorded as a `parity:<capability>` ledger row — worse than no fallback, and steering never sees it. Undeclared caps gate nothing (the neutrality law).
- Every walk is marked (`x-router-failover`) and both the failed attempt and the winner get separate ledger rows, with the failure kind in the reason (`+upstream-429:rate`, `+upstream-401:key`, `+upstream-402:quota`).
- **Ledger attribution & cost**: every chat-path row carries `trigger` — `operator` or `app:<name>` from the token class (swarm rows are unattributed in v1). Cost is computed only from declared prices (roster `pricing` per provider, `pricingByModel` override), carried as `costUsd` + `costSource: "price-list"`; no price declared, no cost — cost is never estimated, like tokens.
- Judge degradation is fail-open: missing key, error, or low confidence → `defaultWorkload` as a single call, tagged `judge:no-key` / `judge:error:…` / `judge:low-confidence`. A judge outage makes routing slower or lazier; it never fails a request. With sys1 down, `cascade` mode degrades to typesafe-only and still serves.
- Degraded rosters are never silent: fallbacks fire as reported remaps, and `kit doctor` reports skipped workflows and unresolved tiers.
- Provider tool-calling degradation: when an upstream rejects tool definitions with a 400, the workflow runtime retries that call without tools and marks the run's agent calls as not-tool-capable rather than failing the run.

## 8. Edge Cases & Error States

- **Keyless provider**: a provider with no key set never removes a working registration and never silently routes — its tier falls back and the remap is reported.
- **Unreachable declaration**: a provider declared without a `baseUrl` renders no upstream; tiers that name it fall through, and `kit export` keeps it as a declaration so it is not silently lost.
- **Cache bounds**: judgment cache is keyed per session (system-prompt head + latest instruction), capped at 400 sessions, oldest evicted.
- **Thinking budget**: thinking tokens share `max_tokens` — a thinking-on call at a tiny cap returns empty content (the router records when this happens).
- **Unknown usage**: tokens are recorded only when the upstream reports them; models that don't report show unknown counts, never invented ones.
- **Durable files are atomic**: the ledger, the memory store, the runtime `.env`, and the dashboard's roster writes all land through an atomic writer (temp sibling with the final mode applied to the temp inode, fsync, rename) — a crash mid-write leaves the previous file intact, and the memory store never exists world-readable. One twin per vendor boundary (router/, lib/, lib/workflow/), kept identical by the unit probe.
- **A workflow ask that will not settle**: an agent that burns its tool-round budget fails the ask with the rounds used and the last tool it called; the run stops, keeps its journal and artifacts, and reports the run directory.
- **Escalation with no owner**: an agent that escalates is told no owner is available and must proceed on its best judgment and say so in its result; the question and that answer are in the journal.
- **Empty states**: fresh machine (no ledger yet) shows an empty dashboard; `kit status` on an unapplied machine says "run kit init".

## 9. UI Consistency Standards

The dashboard is a single dependency-free HTML file — vanilla JS, no framework, no build step. Conventions: the local token is injected server-side into the page; live data arrives over SSE; every mutating action goes through the kit's apply path so the roster remains the single source of truth.

Theming: a header toggle switches light/dark. The default follows the OS (`prefers-color-scheme`); an explicit choice is remembered per browser and survives reload. Both palettes are pure CSS-variable swaps — no component changes — and native controls adapt via `color-scheme`.
