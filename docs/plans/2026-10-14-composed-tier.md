# Plan — the composed tier: blend1 as a provider the router can route to

```yaml
---
status: completed
created: 2026-10-14
updated: 2026-10-14
slug: composed-tier
---
```

## Context

The synthesis lane shipped at the kit today (plan
`2026-10-14-synthesis-lane.md`, completed): `world.synthesis` + the
`synthesis` grant, `composed-report`, and research-report's composer swap.
What the kit does not yet have is the blend reachable the way every other
capability is reachable: **as a tier the router can route to**. Today
blend1 is a Python CLI + a local FastAPI service speaking `/v1/ask`; the
router's providers are OpenAI-compatible model endpoints. This plan
closes that gap at the lowest debt the architecture allows — and the
design directive is explicit: **reliability over minimal diff**. Latency
is irrelevant (a composed ask runs 11–60s against a 120s chat-path
default — verified, `router/server.js:554`; the 4s timeouts are the sys1
judge path). Adjusting or merging routers is pre-authorized where
reliability demands it. The unit of cost is the redo cycle, not the call.

### Verified current-state facts (read this session)

- **Provider shape** (roster.json + lib/roster.mjs:107-112): a provider is
  `{baseUrl, apiKeyEnv?, billing: "plan"|"payg", models}` — token-plan,
  stepfun, and zai-coding-plan all use exactly this plain shape; a
  `templateId` is the alternative, not a requirement.
- **Tier shape**: `{target: "provider/model", fallbacks: [...]}` with
  quota-aware failover already implemented (roster.mjs:266+,
  `resolveTier`). `kit apply` renders the runtime from the roster.
- **Timeout**: the chat path is `AbortSignal.timeout(timeoutMs ??
  R.mixture?.proposerTimeoutMs ?? 120000)` (router/server.js:554) — 120s
  default covers a composed ask; the 4s values (server.js:254/305) are
  the sys1 judge client, not the chat path.
- **blend1's service** (blend1/service/main.py): FastAPI, `/v1/ask`
  (`{prompt, table, target, task_type, voice, retrieve, live}`),
  `/v1/search` (`{project, query, k}`), `/v1/health`; an optional bearer
  token via `BLEND1_BEARER_TOKEN`; **no `/v1/chat/completions`** — the one
  dialect gap.
- **blend1's BlendResult** (the fields the adapter must carry): `path`
  (direct/decompose/synthesized), `route` (d1's nouls), `validation`
  (GLiDE outcome, passed, the two nouls, the number check),
  `escalated_answer` (the larger-model arbiter answered after the gate
  could not clear), `generated.cost_usd` (null when unmeasured),
  `total_latency_ms`, `final_answer`.
- **The escalation leg** (blend1, shipped): when the gate cannot clear
  (inconclusive, or the bounded retry uncleared) the ask escalates to the
  larger configured model with the same givens; the answer ships flagged;
  worst case ≈ 4× generate cost, failure paths only.

### Documented defaults (resolved at draft; revisit at plan approval)

1. **The router changes by configuration, not code.** One provider entry
   (`baseUrl: http://127.0.0.1:8420/v1`, `billing: "plan"`, `models:
   ["blend1"]`) and one tier (`composed`, target `blend1/blend1`,
   fallbacks = the standard tier's chain so a down blend degrades to a
   plain model). `kit apply` re-renders. No roster-schema change, no
   server.js change.
2. **The adapter lives in blend1, where the contract lives.** One new
   endpoint on the existing service: `/v1/chat/completions` — messages →
   prompt → `blend1.ask()` → the OpenAI envelope, with blend1's truth in
   a non-standard `blend1` field: `{path, route, validation,
   escalated_answer, cost_usd, latency_ms}`. Clients that read only
   `choices[0].message.content` lose nothing they had before; clients
   that want the verdict get all of it.
3. **The verdict and the escalation flag are first-class.** An answer
   that did not pass the gate, or that came from the escalation arbiter,
   arrives at the client visibly flagged — never silently downgraded to
   plain text. The adapter does not fail, retry, or reroute on a
   non-passing gate: a flag is information, an outage is an outage.
4. **Failover semantics**: the tier's fallbacks fire when blend1 is DOWN
   (connection refused / non-200 at the transport level). A gate that did
   not pass is a completed ask, not a failure — it ships with its flag.
5. **Cost pass-through**: blend1's own `cost_usd` (or the honest
   "unmeasured") rides in the response; the router's ledger keeps
   recording usage as it does for every provider. Guessed costs are a
   kind of miss.
6. **Project pinning**: the chat endpoint accepts an optional
   `blend1_project` field (and honors the service's existing
   BLEND1_PROJECT/cwd resolution as the default), so the same prompt does
   not answer differently by accident of which directory the service
   started in.
7. **The two routers stay nested.** The kit routes by workload, cost,
   and quota; d1 routes by answer shape per ask. Merging is sanctioned
   when evidence shows the kit's classifier mispredicting what blend1
   should handle — nothing today shows that, so nothing merges now.

## Approach

### Phase 1 — the adapter (blend1, `service/main.py`)

1. `POST /v1/chat/completions`: accept the OpenAI envelope
   (`{model, messages, blend1_project?}`), extract the prompt (system
   messages as the system context, the last user message as the ask),
   call `blend1.ask(prompt, retrieve=True)` with the service's existing
   fail-open discipline (never raises; a lane error rides in the
   BlendResult), and answer with `{id, object: "chat.completion",
   choices: [{index: 0, message: {role: "assistant", content:
   final_answer}, finish_reason: "stop"}], usage: {...}}` plus the
   `blend1` truth field. Follow the service's existing bearer-token
   pattern. A blend1 that answers nothing (empty `final_answer`) is a
   200 with the reason in the `blend1` field — the fail-open law, not a
   500.
2. One live smoke of the endpoint directly (no router): a real ask, the
   envelope inspected field by field.

### Phase 2 — the tier (agnostic-router-kit, `roster.json`)

3. `providers.blend1` + `tiers.composed` (fallbacks = the standard
   chain), then `kit apply` and confirm the rendered config carries the
   tier.
4. Docs: the roster's provider table / README row in the kit, the
   service's endpoint list in blend1 (service docstring + README), both
   repos' CLAUDE.md wave lines.

## Acceptance Criteria

- [x] **AC1** — `POST /v1/chat/completions` on blend1's service answers a
  real ask in the OpenAI envelope with the `blend1` truth field
  (path/route/validation/escalated_answer/cost/latency) — verified
  directly, field by field. **VERIFIED 2026-10-14** — live: a real ask
  returned the full envelope (path/route nouls/escalation flag/cost/
  latency all present); 12 offline tests in tests/test_service.py.
- [x] **AC2** — the roster renders `providers.blend1` + `tiers.composed`
  (`kit apply`, rendered config inspected); the tier's fallbacks are the
  standard chain. **VERIFIED** — the live-home render
  (`kit apply --port 8301 --only router`) produced
  `routing.workloads.composed` = blend1/blend1 with candidates
  [blend1, token-plan/qwen3.8-flash, zai/GLM-5.3-Flash,
  stepfun/step-3.7-flash] and `routing.profiles.composed`; the review's
  blocker (the tier unreachable without a profile) fixed in `db1d0d1`.
- [x] **AC3** — a real request through the router (`model: "composed"`)
  returns the blend's answer with the verdict and the escalation flag
  visible in the response — the client loses none of blend1's truth.
  **VERIFIED 2026-10-14, live** — `x-router-workload: composed`; the
  `blend1` field rode through the router untouched; the full pipeline ran
  (24B composed a real onboarding brief, GLiDE rated it — atq 0.703,
  contra 0.440 — $0.00197). A second live ask routed direct
  (needs_generation 0.0014, $0 generative spend) and the corpus-shaped
  answer proved provenance.
- [x] **AC4** — a non-passing gate arrives flagged and complete (the
  answer ships; the flag rides) — not an error, not a retry, not a
  silent downgrade. **VERIFIED** — offline (test: failed gate → 200
  flagged) and by construction live (the AC3 ask's marginal verdict rode
  in the response; the flag is the field, not a status).
- [x] **AC5** — blend1 down (service stopped) → the request lands on the
  tier's fallback (a plain model answers) — failover proven, and the
  ledger shows the fallback. **VERIFIED 2026-10-14, live** — service
  stopped, the same composed request returned `x-router-failover: 1` and
  a plain model's answer with the `blend1` field absent.
- [x] **AC6** — cost honesty: a synthesized ask's `cost_usd` rides in the
  response; an unmeasured cost says "unmeasured", never `$0`. **VERIFIED
  live** — the AC3 ask carried `cost_usd: 0.00197`; the direct-path ask
  carried `null` (the wire keeps null; the display word is "unmeasured").
- [x] **AC7** — project pinning: the same prompt with different
  `blend1_project` values resolves against the named project's corpus.
  **VERIFIED offline** — the passthrough test asserts the kwarg reaches
  ask() and the default is the service's own resolution chain.
- [x] **AC8** — docs updated in both repos (roster/README in the kit;
  service + README + CLAUDE.md wave line in blend1). **VERIFIED except
  the two CLAUDE.md wave lines** — the protection gate blocked the
  subagent's writes; the parent lands them with the user present
  (blend1 `17eb340` + kit `db1d0d1` carry the code and README docs).

## Files to be Touched

**blend1** (`~/Projects/blend1`, branch main)
- `service/main.py` — the `/v1/chat/completions` endpoint (the only new
  code in this plan, ~60 lines)
- `README.md` (+ its service section), `CLAUDE.md` — the wave line

**agnostic-router-kit** (`~/Projects/agnostic-router-kit`, branch master)
- `roster.json` — the provider + tier
- `README.md` (+ its provider/tier table), `CLAUDE.md` — the wave line

**Deleted**
- none

## Out of Scope

- `auto` learning "composed" as a workload (the classifier change — d1
  already answers answer-shape per ask; the kit's classifier predicting
  it would be duplication, and no evidence yet says it should).
- Mixture profiles including blend1 as a proposer (a natural next step
  once the tier is proven; the merge judgment picking between plain text
  and validated composition).
- Router merging (sanctioned by the directive, earned by evidence —
  nothing today earns it).
- The deep-research composer swap (parked; its plan stands as written).
- Any change to blend1's lanes, gate, or escalation internals.

## Verification

```bash
# blend1's service (from the blend1 checkout)
service/.venv/bin/uvicorn service.main:app --port 8420 &
curl -s localhost:8420/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"blend1","messages":[{"role":"user","content":"What runs the blend1 offline suite?"}]}'
# the kit
kit apply && kit doctor            # the rendered config carries the tier
curl -s localhost:8300/v1/chat/completions -H "authorization: Bearer $(…localToken…)" \
  -H 'content-type: application/json' \
  -d '{"model":"composed","messages":[{"role":"user","content":"…"}]}'
# failover: stop the service, repeat the kit call — the fallback model answers
```

Expected: the envelope's `choices[0].message.content` is the blend's
answer; the `blend1` field carries the verdict; a down service lands on
the fallback; a non-passing gate ships flagged.

## Linked Artifacts

- `docs/plans/2026-10-14-synthesis-lane.md` — the lane (completed)
- blend1's escalation-leg work (2026-10-14, in blend1's CLAUDE.md
  "Today's state") — the arbiter this plan surfaces
- `router/server.js:554` — the chat-path timeout this plan relies on

## Risks

| Risk | Mitigation |
|---|---|
| The router's transport sends auth the service rejects | The service's bearer pattern is optional (unset = localhost-open); the roster entry carries `apiKeyEnv` only if the operator sets a token — verified in AC3 before docs |
| The 120s chat timeout vs a slow blend | Default already covers 11–60s measured; the mixture `proposerTimeoutMs` knob exists if a future lane needs more |
| A client treats a flagged answer as an error | The flag rides in a non-standard field; the HTTP status is 200 with the answer — the fail-open law, documented in both repos |
| Project context resolving by cwd accident | The endpoint's explicit `blend1_project` field (AC7), the service's existing resolution as default |
| Cost double-counting (blend1's telemetry + the router's ledger) | The ledger records usage as for any provider; blend1's own `cost_usd` is the pass-through truth — the plan does not invent a second accounting |
