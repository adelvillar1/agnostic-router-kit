---
status: completed
created: 2026-10-06
updated: 2026-10-06
slug: install-and-bot-surface
---

# Plan: easier installation, a guided path, and the bot surface

**Repo:** agnostic-router-kit. **Scope:** three new surfaces (a guided terminal install, router-served `/setup` and `/chat`, an Electron shell) on top of four prerequisite fixes, with the power-user path (`roster.json` + `kit apply` + `kit doctor`) untouched. Mid-build the user added three directives that shaped the result: **a friendly UX on every surface**, **the agent control plane must be transparent and seamless** (the user drives ZCode, Hermes and Codex — the surface should manage harnessed agents, not just chat), and **the router does all the thinking** (pages render; the router computes readiness, attention and verdicts).

**Goal:** a new user goes from clone to chatting in one command; a non-technical user never needs a terminal after the first wizard; every connected harness becomes visible and steerable from one screen.

## What landed

### Phase 0 — four prerequisite fixes — ✅ done
- **`kit help` printed `kit undefined` nine times and exited 1** (`for (const { name } of Object.entries(...))` destructured the array entry). Now: `help` is a real command with a friendly header ("New here? run `kit quickstart`"), one-line descriptions per command, a forms block, exit 0; unknown commands print the usage and exit 1. *(lib/cli.mjs)*
- **HTTP-spawned runs were invisible**: the watcher defaulted `AGNOSTIC_ROUTER_KIT_HOME` to the kit checkout while every writer defaulted to `~/.agnostic-router-kit`. Fixed at the root: `KIT_HOME()` exported from the plane, both sides resolve through it. *(lib/workflow/runstate.mjs, router/server.js)*
- **`/api/*` was app-token reachable** — a token with an empty `grantCeiling` could rewrite the roster and shell out to `kit apply`. The whole `/api/` block is now operator-class: app tokens get 403 with a pointer to `/v1`; bad tokens still get 401. *(router/server.js)*
- **`engines.node`** aligned to `>=20` (root said 18; the plane and README said 20).
- **Bonus fix, found by the quickstart probe:** `kit init --template` crashed on its own template — the file carries a JS-style comment header and `JSON.parse` refuses comments. `parseJsonc()` (string-aware, because every `baseUrl` contains `//`) now loads it; `kit init --template` writes again. *(lib/roster.mjs, lib/cli.mjs)*

### Phase 1 — `kit quickstart`, the guided install — ✅ done
The CLI's first interactive surface: seven steps in the README's documented order (node check → both installs → roster → keys → dry run → apply → doctor), then a "try it" block with the one-line curl and the `/chat` + `/setup` links. Rules kept: every step IS the existing command or performs the identical write (`writeJson`/`writeEnvFile`), so artifacts are byte-equivalent to the manual path; every step checks before acting, so re-runs resume. `lib/prompt.mjs` (zero-dep): `ask`/`askSecret` (masked, never in shell history)/`confirm`/`choose`, with piped stdin served from a slurped queue so prompts answer strictly in order. Flags: `--yes` (non-interactive, key prompts skipped with a pointer to `/setup`), `--force` (re-run over a healthy install), `--skip-install`, `--skip-service` (scratch-home probes, Windows, and the desktop app's owned process). A healthy install re-running the command is asked before anything is touched, and refused politely when nobody can answer.

### Phase 2 — `/setup` and `/chat`, served by the router — ✅ done
New endpoints, all inside the operator gate, all computed server-side (the pages derive nothing):
- **`POST /api/keys`** — write-only by contract: `{"keys": {NAME: value}}` merges into the runtime `.env` line-wise (comments and untouched keys survive), atomic rename, mode 600, env cache invalidated; the response carries `configured` booleans and never a value.
- **`GET /api/setup`** — the readiness checklist (roster present, keys resolve, tiers route, judge can decide — including a live sys1 health probe in non-typesafe modes, first request routed from the usage ledger), each step shaped `{id, label, done, detail, hint}` plus a `ready` flag.
- **`GET /api/agents`** — the control plane: the operator plus every roster app with its ceiling and workspace, their runs attributed from the journals (`runApp`, memoized), and `attention` — runs with an escalation open right now.
- **`GET /api/state`** additionally exposes the workflow registry and catalog so run-starting surfaces list what can be started.

Two hand-written, self-contained pages (the dashboard's stated convention: no CDN, no build step, no framework), token-stamped at serve time like `/dashboard`:
- **`/chat`** — the bot interface and the agent control plane in one screen. Left: a streaming chat with `model: "auto"` (`/v1/chat/completions`), the verdict shown under each reply from the `x-router-*` headers, and `/run <workflow>` starting a run from the same input box. Right: the Agents rail — every connected harness (ZCode, Codex, Hermes, anything holding an app token), live and idle, runs expandable to their journal tails, and escalation cards with an answer box + Approve/Skip answered through `POST /v1/runs/<id>/answers`. A welcoming empty state with three example prompts.
- **`/setup`** — the guided half in the browser: the checklist rendered from `/api/setup` (polling until ready), inline key entry for exactly the missing names, a "connect an agent" flow that mints an app token, writes it through `PUT /api/roster`, and hands the user three copyable lines (base URL, token, `model: auto`).

### Phase 2x — the owner wait (found by the probe, the wave's real discovery) — ✅ done
`answerEscalation` was synchronous at fire time and the run API never supplied `askOwner` — so over HTTP every escalation resolved in ~1ms from recorded answers or fell to "no owner available". **An in-the-moment answer was impossible; the escalation card could never exist.** The plane gained `awaitOwnerMs`: when the spawner opts in, an unanswered escalation holds the run open, polls `answers.jsonl` (400ms), and resolves `source: "live"` when the human answers — bounded, degrading to the recorded no-owner answer at the deadline. The run API passes it through (capped at 24h, default 0 — existing callers unchanged); the chat page opts in at 5 minutes. The normalizer now also carries `op`/`source`/`matched` on escalation events — it dropped them once, which made every answered escalation look pending.

### Phase 3 — the Electron shell — ✅ done
`app/main.mjs`: preflight (kit found via `ARK_KIT_DIR` → `~/Projects/agnostic-router-kit` → packaged resource; node ≥ 20; both installs; then `kit quickstart --yes --skip-install --skip-service` does the resumable rest) → attach or own the router (healthy service is attached and outlives the app; nothing running means the app spawns `server.js` as a child that dies with the app) → a `BrowserWindow` on `http://127.0.0.1:<port>/chat`, external links handed to the real browser. Unfinished preflight (usually: no keys yet — the one step no wizard can do for you) shows a dialog pointing at `kit quickstart`, honestly. `--preflight-check` runs the whole non-GUI half and prints JSON. electron-builder config for dmg (arm64+x64) / nsis / deb; codesigning deliberately out of scope.

## Acceptance criteria

- [x] **C0:** `kit help` lists the commands with descriptions and exits 0; an unknown command prints usage and exits 1. *(live: both verified)*
- [x] **C1:** a run spawned over `POST /v1/runs` appears in `/api/workflow-runs` and on the SSE stream with one env var set for the whole process; the default-path agreement is asserted in-process against the plane's resolver. *(probe-chat-surface K + R)*
- [x] **C2:** an app token gets 403 from `PUT /api/roster`, `GET /api/roster`, `POST /api/keys`, unknown `/api` paths; bad token 401; operator 200. *(probe-keys-endpoint C)*
- [x] **C3:** `POST /api/keys` writes to the runtime `.env` at mode 600, preserves comments and untouched keys, invalidates the env cache, and no response body ever contains the value. *(probe-keys-endpoint B)*
- [x] **C4:** quickstart on a scratch home produces a roster key-for-key identical to `kit init --template`'s (C4a) and a fully green `kit doctor` against the running router (C4b, live with real keys on 8300; the scratch probe asserts artifacts + doctor parity). *(live run + probe)*
- [x] **C5:** a healthy install re-running quickstart is refused politely without a TTY (exit 0, "nothing to do") and asks interactively; interrupted runs resume because every step checks before acting. *(live)*
- [x] **C6:** `/setup`'s checklist reports ready only when every step passes, with the next step named; the keys step flips after a browser write. *(probe-keys-endpoint D + B; live screenshot: "4 of 5 done" with step 5 pending and its hint shown)*
- [x] **C7:** the chat page streams from `model: auto` with the verdict shown (C7a, wire verified by probe; headers asserted server-side), and a run's phases, escalation and answer appear in the same surface (C7b, probe-chat-surface E: attention shows the open question, clears after the answer, resolution `source: "live"`).
- [x] **C8:** the power-user path is unchanged: `kit init --template` (fixed, bonus) + hand-edited `roster.json` + `kit apply` + `kit doctor` — no new steps. *(live)*
- [x] **C9:** the shell's owned path: no healthy router → the app spawns one, health passes, the child dies with the app, the machine's real router untouched; the attached path attaches. *(live via --preflight-check, both paths; GUI launch itself not exercised headlessly)*
- [x] **C10:** `node --check` clean on every touched file; the neutrality grep over `lib bin router roster.json templates` still empty; run-API probe 33/33 re-run after the engine change.
- [x] **C11:** the architecture diagrams refreshed for the new surfaces. `system-overview` gains the Chat + setup node (write-only keys, readiness checklist — `router/server.js:2202/2234`), the Desktop shell node (`app/main.mjs` preflight + owned process), and the operator-only control plane in its token-class card; `run-lifecycle`'s escalation lane and its card carry the owner wait (`answerEscalation` now `lib/workflow/engine.mjs:953-1002`); `deep-research-loop` verified untouched by the wave (all its sources predate it) and left as-is. Every provenance line re-pinned to the post-wave code, both re-finalized through archify showcase gates with repo evidence (`update` receipt: current), stills re-rendered by `render-png.mjs` at exact viewBox size.

## Incident records (recorded honestly)
- **The prompt race:** piped stdin lines can arrive in one write; per-prompt `line` listeners attached too late, waited on a closed stream, and the drained event loop exited the wizard mid-run with code 0. Fixed by slurping piped stdin into a queue answered strictly in call order. Found because the scratch probe refused to finish.
- **A stray quickstart ran against the real machine** (no scratch env on the first manual try). It hit the apply guard rails — unresolvable keys abort before any write — and changed nothing, which is the guard working as designed; the deployment it could have disturbed (`~/.zcode/router`, a different edition) was never touched. Scratch discipline enforced from then on.
- **The `.hidden` bug:** neither new page defined a `.hidden` CSS rule, so the token gate rendered over the loaded page forever. The DOM dump "proved" the gate hidden — class present, rule absent. The headless screenshot caught it; the DOM check was the naive one.
- **The escalation discovery:** the "answer in the moment" card the whole control plane was designed around could not have worked — `answerEscalation` never waited over the run API. The probe's 2 failures were the feature gap announcing itself; the owner wait is the fix, and it is why the chat page's spawn passes `awaitOwnerMs`.
- **Guard drift, pre-existing:** `tools/guard.sh` failed on arrival — the journal baseline predated 86f12e9's run-start attribution, and the pinned hash of the *other edition's* deployed config (`~/.zcode/router/config.json`) has drifted machine-side. Neither caused by this work (proven with a clean-HEAD worktree comparison: identical journals); the baseline was recaptured from clean HEAD at `/tmp/plane-baseline-20261006` and all three probes compare identical. **The pinned hash was left alone** — re-pinning someone else's deployment state silently is not this wave's call.
- **Two `rm -rf` invocations were blocked by the operator's own zcode-gate** mid-verification (old baseline dir, Chrome profile). Correct blocks; both worked around without deletion (fresh directories instead).

## Out of scope
Codesigning/notarization; auto-update; a GUI for roster editing beyond the setup page; diagram re-authoring (C11); embedding the kit inside packaged builds beyond the extraResources declaration (untested until a real `electron-builder` run); Windows testing (the owned-process path is written for it, unverified on hardware).

## Notes
The design's load-bearing rule held throughout: the desktop app and both pages ship no logic of their own. The router computes readiness, attention, verdicts and the checklist; the shell opens a window; the pages render what `/api/setup` and `/api/agents` already decided. That is why the control plane could be built almost entirely out of endpoints that already existed — the run API, the journal stream, the answers route — plus one small write-only key endpoint.
