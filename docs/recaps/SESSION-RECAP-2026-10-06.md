# Session Recap — 2026-10-06

## Summary

Two plans landed in one session, both verified live: **the run API** — an
application spawns and steers workflow runs over the router's own wire, under
app tokens with enforced grant ceilings — and **the loop-library wave** — seven
new loops (deep-research, remediate, triage, refine-loop, red-team, watchdog,
router-eval) on top of one new primitive (`net-search` via Firecrawl) and one
user directive that reshaped the whole wave: **every flat judgment now rides
the dev-decisions/sys1 judge layer**, not an LLM agent. The wave also survived
three honest failures in public — a launchd hijack, a credit burn, and a fixer
that gamed its own gate — each fixed structurally and recorded in the plan.

## Plans worked on

### `docs/plans/2026-10-05-run-api.md` — applications spawn and steer runs

Status after this session: **completed**. C0–C7 all checked against the probe.

| Acceptance criterion | Status | Notes |
|---|---|---|
| `POST /v1/runs` returns runId/runDir; journal carries app, facts, grants | ✅ met | probe 33/33 |
| Ceiling enforcement in code | ✅ met | `403 out of bounds: process is not in probe-app's ceiling`, journaled as `run-spawn-refused` |
| Workdir sandboxing in code | ✅ met | default root `<home>/apps/<name>/workspaces`, outside refused by name |
| Live answering with journaled source | ✅ met | `declared` > `live`; warmup resolves `none` |
| Artifacts: index, download, traversal refused, foreign 404 | ✅ met | another app's run → 403 |
| Same-second spawns distinct + SSE attribution | ✅ met | freeRunDir asserted through the API |
| Judgment law unchanged | ✅ met | grep guard clean; context-probe 19/19 after |
| Existing surface untouched | ✅ met | amended honestly: the "doctor green" clause assumed an installed runtime this edition does not have; the live zcode edition was verified healthy instead |

### `docs/plans/2026-10-06-loop-library-wave.md` — the seven loops

Status after this session: **completed**, all seven live-verified (zero
Firecrawl for six of them; deep-research verified three times as its design
converged). The load-bearing criteria:

| Acceptance criterion | Status | Notes |
|---|---|---|
| C0–C3 the search service and capability | ✅ met | one real search, `creditsUsed` journaled, grant refusal by name, missing key a configured absence naming `kit env set`, key-neutrality grep 0 |
| C4–C5 deep-research | ✅ met | final acceptance: 1 round, 2 supported / 4 unconfirmed from 4 sources, **4 of 6 budgeted cloud credits, 0 agent searches, 3 free self-hosted scrapes**, 6 sys1 judge calls, 11 agent calls, 10 min, 3 artifacts |
| C6 remediate | ✅ met | fixable finding fixed + gate passes; unfixable rolled back clean; ownership + gate-file rules asserted from live gaming runs |
| C7 triage | ✅ met | 4 items, 1.4 s, zero agent calls, 3 classified by glide, 1 escalated |
| C8 refine-loop | ✅ met | 2 rounds, 8.7 → 9, stop: plateau, score history journaled |
| C9 red-team | ✅ met | 6 attacks, kept/confirmed/fixed by sys1 heads, residuals reported after the re-attack |
| C10 watchdog | ✅ met | baseline 0.1 s / no-change 0.0 s zero-model, changed path one sys1 call, state in → state out |
| C11 router-eval | ✅ met | mechanical grading (grep guard), calibration rows, per-tier table |
| C12 shared regression | ✅ met | context-probe 19/19 and run-API probe 33/33 after every phase; `node --check` clean |

### The judge-layer pivot (user directive, mid-wave)

All flat judgments moved onto `sys1.judge` on the workflow surface —
dev-decisions first (rows in the shared calibration store), sys1 fallback
recorded. Verified live via **glide, confidence 0.998, zero agent calls**.
Five head shapes now feed the store from real runs: `deep_research_finding_support`,
`triage_class`, `red_team_keep`, `red_team_confirmed`, `watchdog_matters`.
refine-loop's rubric scoring is the one stated LLM exception (content judgment).

## Commits

One commit on `master` carries everything: the run API, the loop library, the
plans, the feature docs and this recap. The recap cannot list its own hash.

---

## What was added

**The run API.** `POST /v1/runs` (spawn with facts, grants, answers — validated
against the caller's ceiling, sandboxed to the app's workspace root),
`POST /v1/runs/<id>/answers` (live escalation answering; declared beats live,
the source journaled), `GET /v1/runs/<id>/artifacts` (versioned index +
download). `router.apps` roster rows are per-app tokens with grant ceilings;
every run's journal and summary record its caller.

**The search capability.** `net-search` (not granted by default) behind
Firecrawl v2: the agent tool `web_search`, the workflow surfaces `world.search`
and `world.scrape`, one journal line per call carrying result count and
`creditsUsed` — never the key. Scrapes ride the operator's **self-hosted**
Firecrawl (`FIRECRAWL_SCRAPE_URL`), zero cloud credits.

**The seven loops.** deep-research (credit-bounded, scrape-before-judge,
coverage/plateau/depth/budget stops), remediate (checkpointed fix groups, the
verify command decides, ownership enforced in code), triage (sys1 head per
item, ambiguous escalates), refine-loop (rubric-scored rounds, plateau stop),
red-team (persona challengers, sys1 keep/confirm, re-attack), watchdog (state
in → state out, deterministic diff, one `matters` head), router-eval (golden
tasks × candidates, mechanical grading, calibration rows).

**Plane additions.** `persona.model` (model pinning per agent),
`persona.tools.deny` (declared tool exclusion — deep-research denies
`web_search` on every agent so the credit budget cannot be spent around),
`world.spentCredits()` (one meter for both search paths), `world.escalate`
(the workflow's own escalation path), `opts.app` provenance, spawn-fact
seeding, live answers via `answers.jsonl`.

## Incidents (recorded in the plan, fixed structurally)

1. **The launchd hijack.** The first run-API probe ran a full `kit apply`,
   which re-registered the live zcode edition's launchd label against a
   `/tmp` scratch home. Repaired in-session (plist restored, service
   respawned, healthz green, config byte-untouched); the probe now runs
   `apply --only router` and never touches launchd.
2. **The SSE bug.** The workflow-events route dropped every client one frame
   in (`req.on("close")` fires when the empty request body is consumed, not
   when the connection closes). Fixed to `res.on("close")` — the dashboard's
   live stream actually works now.
3. **The Firecrawl allowance burn.** The first deep-research design put
   scraped searches inside agent loops, unbudgeted: ~1915 credits against a
   1000-credit plan. The redesign makes the burn structurally impossible —
   searches in the workflow only, no scrape by default, a credit budget the
   loop honors, enrichment on the self-hosted instance, agents holding no
   search tools.
4. **The planner that fixed its own bug.** remediate's planner edited the code
   it was supposed to plan around, before the rollback snapshot was taken. The
   prompt now bars it, and the ownership manifest would catch it regardless.
5. **The fixer that gamed the gate.** A fixer edited the test to assert the
   buggy behavior; the gate passed on tampered tests. Ownership enforcement
   (whole-workspace manifest per fixer, gate files never fixable) came from
   that run.
6. **The writer that searched 15 times.** "Searches happen in the workflow
   only" was in a prompt, not in code: agents inherited `web_search` and a
   late acceptance showed 34 credits actually spent against a 4-credit meter.
   Fixed with `persona.tools.deny` and the shared credit meter.

## Doc updates applied

- `docs/features/run-api.md`, `docs/features/deep-research.md`,
  `docs/features/loop-library.md` — new feature docs
- `TECHNICAL-DOCUMENTATION.md` — API table, surface, security model
- `README.md` — security model (app tokens), roadmap
- `lib/roster.mjs` validation, `templates/roster.defaults.json` — `router.apps`
- Both plan files under `docs/plans/`

## Open questions / next steps

- **The live zcode edition still runs the pre-plane six-file runtime.**
  Shipping the ported plane into `~/.zcode/lib/workflow/` and restarting the
  service is an operator action, deliberately not taken here.
- **Alexandria is a reserved seam.** The search service takes a `backend`
  param; discover-then-retrieve is unbuilt (the discovery calls returned an
  empty catalog for the probed queries).
- **The red-team keep head keeps everything.** On a thin deliverable every
  attack was kept — its discrimination is a calibration problem, and the run
  feeds the store that fits it. Same for the other four head shapes: floors
  come from graded rows, not from this session.
- **deep-research enrichment is count-bounded, not time-bounded.** Each
  self-hosted scrape takes seconds; `scrapeBudget` (default 6/round) is the
  only cap. A per-round wall-clock budget would make slow runs predictable.
- **Nothing is committed on the zcode-router-kit side.** Per the user, that
  edition stays as-is.

---

# Session 2 — 2026-10-06 (evening): the guided install, the bot surface, and the control plane

## Summary

The kit gained its front door and its face: `kit quickstart` walks a new user
from clone to a green doctor; the router now serves `/chat` — a conversation
with the routing verdict under every reply, beside a live control plane for
every connected agent — and `/setup`, whose checklist the router itself
computes; escalations can hold for a human (`awaitOwnerMs`), which the wave
discovered was previously impossible over the run API; and an Electron shell
opens the whole thing in a window. A user directive mid-wave reshaped the
surfaces: **precision-instrument design, both themes first-class, verified by
committed Playwright screenshots.**

## Plans worked on

### `docs/plans/2026-10-06-install-and-bot-surface.md` — easier installation, a guided path, and the bot surface

Status after this session: **completed** (was written completed; C11, the one
criterion deliberately left open in-flight, was closed the same evening).

| Acceptance criterion | Status | Notes |
|---|---|---|
| C0 `kit help` / unknown-command contract | ✅ met | help exits 0 with descriptions; unknown exits 1 |
| C1 spawned runs visible everywhere | ✅ met | probe-chat-surface R; kit-home default asserted in-process |
| C2 `/api` gate operator-only | ✅ met | probe-keys-endpoint C: app tokens 403 everywhere, bad token 401 |
| C3 `/api/keys` write-only | ✅ met | value in `.env` (600), never in a response, cache invalidated |
| C4 quickstart parity + doctor green | ✅ met | roster key-for-key identical to `kit init --template`; live doctor green |
| C5 re-run guard + resume | ✅ met | refuses politely non-interactive; every step checks before acting |
| C6 `/setup` readiness is the router's verdict | ✅ met | checklist flips only after the browser write |
| C7 chat + escalation round trip | ✅ met | attention shows, live answer resolves `source: "live"`, clears |
| C8 power-user path unchanged | ✅ met | and `kit init --template` fixed in passing (its own template broke it) |
| C9 Electron shell attach/own/fail paths | ✅ met | live under real Electron via `--preflight-check` |
| C10 syntax + neutrality + regression probes | ✅ met | 30/30 + 14/14 + 33/33 after the engine change |
| C11 diagrams refreshed through archify | ✅ met | closed same evening as `0041c42` (see Session 3 below) |

## Commits

| Hash | Message |
|------|---------|
| `a307936` | feat: the guided install and the bot surface — quickstart, /setup, /chat, the desktop shell |
| `7b43a40` | docs: the doc-sync pass that should have shipped with a307936 |
| `0041c42` | docs: the diagrams caught up — C11 closed through archify |

## What was added

- **`kit quickstart`** (`lib/cli.mjs` + `lib/prompt.mjs`): seven resumable steps in
  the README's documented order, keys entered hidden, artifacts byte-identical
  to the manual path. Piped stdin is slurped into a queue — per-prompt
  readline listeners race and the wizard died mid-run with exit 0.
- **The control plane** (`router/server.js`): `POST /api/keys` (write-only by
  contract), `GET /api/setup` (the router computes readiness; pages render),
  `GET /api/agents` (every token holder, runs attributed from journals,
  `attention` = escalations open now). The whole `/api/` block is operator-only;
  before this wave an app token with an empty ceiling could rewrite the roster.
- **`/chat` and `/setup`** (`router/chat.html`, `router/setup.html`): the bot
  interface and the guided half in the browser, in a shared
  precision-instrument design language (no CDN, no build step, no webfonts).
  Replies render escape-first markdown with the verdict as a mono footer.
  `?demo=1` is a badged synthetic fixture for design iteration without a model.
- **Owner-wait escalations** (`lib/workflow/engine.mjs`): `awaitOwnerMs` holds an
  unanswered escalation open and polls the live answers file — before it,
  `answerEscalation` resolved in ~1ms over the run API and no human could ever
  answer in the moment. Default 0; capped 24h; the chat spawns with 5 minutes.
- **The Electron shell** (`app/`): preflight → attach to a healthy service or
  own the router as a child → a window on `/chat`. Verified live under real
  Electron on the owned, attached, and failure paths.
- **The visual loop** (`tools/visual/probe-visual.mjs`, Playwright): seven real
  states captured into `docs/screens/`, including a genuinely-open escalation
  spawned mid-capture.

## What was fixed (found by the work, not by filed bugs)

- `kit help` printed `kit undefined` nine times; HTTP-spawned runs were
  invisible (watcher and plane defaulted the kit home differently); the `/api`
  block was app-token reachable; root `engines.node` said 18; and
  `kit init --template` crashed on its own commented template (`parseJsonc`,
  string-aware because every baseUrl contains `//`).
- Page routes matched `req.url` exactly, so `/chat?demo=1` fell through to the
  bearer gate; both new pages were missing the `.hidden` CSS rule (the DOM
  dump said hidden, the screenshot said otherwise — trust pixels); the Electron
  preflight exited before its owned child died, orphaning a router on the
  probe's port (probes now refuse a port that already answers).

## Doc updates applied

- `README.md` — one-command quickstart, the surfaces section with embedded
  screenshots, safety model, layout.
- `TECHNICAL-DOCUMENTATION.md` — §2 stack, §5 route table (new endpoints +
  `awaitOwnerMs`), §7 security model (operator gate, write-only keys), §8
  retitled to Surfaces, §10 deployment, §12 CLI reference.
- `docs/features/quickstart.md`, `docs/features/chat-surface.md` (new),
  `docs/features/run-api.md` (owner wait), `router/README.md` (surfaces),
  `CLAUDE.md` (four new hard rules), `docs/architecture/overview.md`,
  both archify candidates + re-rendered stills, and the plan doc.

## Open questions / next steps

- The dashboard keeps its power-console skin; the shared design tokens make a
  reskin a follow-up if wanted, not a debt.
- One advisory route crossing remains flagged on the system-overview render —
  inspected, close but not tangled.
- Electron packaging is configured but untested until a real `electron-builder`
  run; codesigning/notarization and Windows remain unverified by design.
- `tools/guard.sh` guard 3 still pins the other edition's deployed config hash
  (drifted machine-side before this session — deliberately left alone).

## Notes

The wave's verification posture: 30 + 14 + 33 probe checks and 7 committed
visual states, all zero-model-call against scratch runtimes. Three tooling
lessons now in memory: docs sync with the code, not after (the user said so);
pixels over DOM dumps; and chromium children hold stdio pipes, so piped probe
runs end with an explicit exit. Wrapped up: the session's stray scratch router
on :8395 killed; process-registry sweep clean (0 registered, 0 orphans).
