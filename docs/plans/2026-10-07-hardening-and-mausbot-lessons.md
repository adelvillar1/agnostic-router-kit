---
status: completed
created: 2026-10-07
updated: 2026-10-07
slug: hardening-and-mausbot-lessons
---

# Plan: hardening wave — defect cleanup + the OpenMausBot lessons

**Repo:** agnostic-router-kit. **Scope:** the five verified defects from the 2026-10-07 deep dive, then the transferable lessons from OpenMausBot (v0.1.98), in the endorsed order: enforcement of the existing probe suite, failure classification, atomic writes, capability-parity fallback, ledger attribution/cost. Each phase lands green under `npm test` before the next starts — that is the point of P1 existing at all.

**Source analysis:** deep dive of 2026-10-07 (both codebases surveyed; every defect verified by reading the code; OpenMausBot lessons mined from `server/key-rejections.ts`, `server/drivers/retry.ts`, `server/atomic.ts`, `server/automatic-recovery.ts`, `server/usage-ledger.ts`, `docs/verification/`, CI workflows). Ported by rule, not by translation — same discipline as the mnemosyne port.

**The deepest lesson, stated once:** OpenMausBot ships at breakneck AI-driven cadence because of its fixture/verification layer, not its feature code. This repo already has the hard part (145 zero-model-call checks against scratch routers); what it lacks is *enforcement* — nothing runs them before commit — and a scripted fake upstream, so the `/v1` failover/mixture/metering paths are never exercised end to end. P1 fixes both. Everything after P1 is written test-first against that harness.

## What the deep dive verified (the defect list)

1. **Duplicated `/route` handler** — identical block at `router/server.js:1732` and `:1744`; the second is unreachable.
2. **Duplicate JSON keys in `/api/state`** — `workflows` and `workflowLibrary` written twice (`router/server.js:2137-2138`, `:2144-2145`); later keys silently win; fallback shapes disagree (`{}` vs `[]`, `[]` vs `null`). Tracing the consumers found a **live bug**: `config.workflows` is an *array* (`buildRegistry` in `lib/workflowlib.mjs:40` returns an array; `lib/render.mjs:58` mounts it at `routing.workflows`), but `router/chat.html:608` does `Object.keys()` over it — the `/run` workflow list is array indices, so `workflows.includes(name)` never matches and every `/run <name>` bounces.
3. **Duplicated docstring** — `router/swarm.mjs:386` and `:392` (the second is the correct, extended one).
4. **`docs/TROUBLESHOOTING.md` missing** though CLAUDE.md housekeeping requires a remediation line there per runtime failure.
5. **Dashboard round-trip artifacts in the tracked `roster.json`** — `hasKey: true` and redundant `id` fields on providers (roster.json:26 et al.); the dashboard's save path (`applyRoster`, `router/server.js:1077`) writes back render-derived state, blurring "tracked roster = curated source."
6. **Bonus, found while verifying:** `memory.jsonl` is world-readable (`-rw-r--r--`, confirmed live) — the plane's tmp-rename save (`lib/workflow/memory.mjs:141`) never sets a mode; and `lib/envstore.mjs:33` writes the 600 `.env` non-atomically. Both fixed by P3.

## Phase P0 — defect cleanup (no behavior change beyond the fixes)

### Task P0.1: dedupe the `/route` handler

**Files:** Modify `router/server.js:1744-1757` (delete the second block).

Step 1 — delete lines 1744–1757 (the second `if (req.method === "POST" && (req.url === "/route" || req.url === "/v1/route")) { ... }` block, verbatim twin of 1732–1743).

Step 2 — verify:
```bash
node --check router/server.js
grep -c 'req.url === "/route"' router/server.js   # expect: 1
```
Step 3 — commit: `fix: drop the duplicated /route handler (second copy unreachable)`.

### Task P0.2: dedupe the `/api/state` keys — keep the array-honest pair

**Files:** Modify `router/server.js:2137-2138,2144-2145`.

`R.workflows` is the registry **array**. Keep the commented first pair, fix its fallback type, delete the second pair entirely:

```js
            workflows: R.workflows ?? [],
            workflowLibrary: Array.isArray(config.workflowLibrary) ? config.workflowLibrary : [],
            thresholds: {
              wideChars: R.wideChars ?? null,
              minConfidence: R.minConfidence ?? null,
              workflowMinConfidence: R.workflowMinConfidence ?? null,
            },
          },
```
(the `workflows:`/`workflowLibrary:` lines that followed `thresholds` are deleted).

Step 2 — extend `tools/probe-chat-surface.mjs` with one assertion (find its `/api/state` fetch; add):
```js
ok("state.resolved.workflows is an array", Array.isArray(json?.resolved?.workflows));
ok("state.resolved.workflowLibrary is an array", Array.isArray(json?.resolved?.workflowLibrary));
```
Step 3 — `node tools/probe-chat-surface.mjs` → all green, count up by 2. Commit: `fix: one workflows/workflowLibrary pair in /api/state, array-honest`.

### Task P0.3: fix the chat `/run` workflow list

**Files:** Modify `router/chat.html:608`.

```js
  let workflows = (state?.resolved?.workflows ?? []).map((w) => w?.name).filter(Boolean);
```
Verify: `node --check` is not applicable to inline HTML script; the check is `grep -n "Object.keys(state?.resolved?.workflows" router/chat.html` → no matches, plus probe-chat-surface green. The behavioral proof (`/run triage` lists real names) rides the Playwright visual pass next time it runs — noted in TROUBLESHOOTING (P0.6). Commit: `fix: chat /run lists workflow names, not Object.keys indices`.

### Task P0.4: dedupe the swarm docstring

**Files:** Modify `router/swarm.mjs:385-391` (delete the first, short copy — keep the extended one at 392+ which carries the gate rationale).

Verify: `grep -c "Per-part accept/revise" router/swarm.mjs` → 1; `node --check router/swarm.mjs`. Commit: `fix: drop the duplicated gate docstring in swarm`.

### Task P0.5: sanitize dashboard roster writes; clean the tracked roster

**Files:** Modify `router/server.js:1077` (`applyRoster`); clean `roster.json` once.

`enabled` on providers is a legitimate roster field (the dashboard's enable checkbox writes it deliberately). `hasKey` and `id` are render-derived artifacts. In `applyRoster`, before the backup/write:

```js
  // Strip render-derived artifacts the dashboard merges into provider rows:
  // hasKey is runtime state (the .env decides), id duplicates the object key.
  if (candidate && typeof candidate === "object" && candidate.providers) {
    for (const key of Object.keys(candidate.providers)) {
      const p = candidate.providers[key];
      if (p && typeof p === "object") { delete p.hasKey; delete p.id; }
    }
  }
```
One-time cleanup of the tracked roster (values already in git history are fine — these are not secrets):
```bash
node -e '
const fs = require("fs"); const p = "roster.json";
const r = JSON.parse(fs.readFileSync(p, "utf8"));
for (const k of Object.keys(r.providers ?? {})) { delete r.providers[k].hasKey; delete r.providers[k].id; }
fs.writeFileSync(p, JSON.stringify(r, null, 2) + "\n");
'
node bin/agnostic-router-kit.mjs apply --dry-run   # expect: plan renders, no problems introduced
```
Verify: `grep -c hasKey roster.json` → 0. Commit: `fix: dashboard roster writes strip hasKey/id; tracked roster cleaned`.

### Task P0.6: seed docs/TROUBLESHOOTING.md

**Files:** Create `docs/TROUBLESHOOTING.md`.

Seed with the known runtime failures (from recaps + this dive), one remediation line each: the env-var shadowing bug class (`AGNOSTIC_ROUTER_KIT_HOME` leaks between shells → probes read the wrong store); probe port collisions (each probe owns a fixed port — run sequentially, which P1's runner enforces); memory-store hand-edit loss (rule 11; atomic write clobbers); GLiNER HTTP 425 cold start (the 150s keep-warm ping exists — check it before blaming the judge); launchctl lies (`lib/service.mjs` kickstart fast path — "verified running" is the only truth); the chat `/run` index bug (P0.3) as the first historical entry. Housekeeping rule is satisfied going forward: every new runtime failure gets a line here in-wave. Commit: `docs: seed TROUBLESHOOTING with the known failure classes`.

## Phase P1 — enforcement: `npm test`, the fake upstream, CI

### Task P1.1: tools/fake-upstream.mjs — the scripted provider

**Files:** Create `tools/fake-upstream.mjs`. Zero-dep `node:http`. One instance per provider: `--port`, `--tag`. Model name encodes behavior; the roster stays static and each check is deterministic:

| model contains | behavior |
|---|---|
| `-ok` | 200, OpenAI-shaped JSON with `usage` |
| `-stream` | SSE, `[DONE]`, usage in the final `data:` line |
| `-429ra<N>` | 429 + `Retry-After: <N>` |
| `-429` | 429, no header |
| `-401` | 401, body with key-rejection vocabulary |
| `-402` | 402, body `insufficient credits` |
| `-500` | 500 |
| `-400` | 400 (client error — must NOT walk) |

Also `GET /v1/models` (list the behavior models) and `GET /hits` → `{count, lastModel}` — the probe's ground truth for "which upstream actually served." Keep the implementation ~120 lines, no dependencies, `node --check` clean. Commit: `test: fake-upstream — a scripted OpenAI-compatible provider for the probes`.

### Task P1.2: tools/probe-failover.mjs — the end-to-end `/v1` probe

**Files:** Create `tools/probe-failover.mjs`. Scaffold exactly like `tools/probe-run-api.mjs` (scratch `AGNOSTIC_ROUTER_KIT_HOME`, rendered through the kit's own `kit apply` pipeline, `ok()` counter, exit 1 prints the leftover home). Ports: fake A on 8511, fake B on 8512, router on 8510 (no collision with existing probes). Scratch roster: two providers (`fa`, `fb`) with `baseUrl: http://127.0.0.1:851{1,2}/v1`, `apiKeyEnv: FAKE_A_KEY`/`FAKE_B_KEY` (values in the scratch `.env`), one tier whose chain is `[fa/fake-429ra5, fb/fake-ok]` (and other tiers per check).

Checks (each names its wire contract):
- C-a 429+Retry-After walks: tier chain `fa/fake-429ra5 → fb/fake-ok`; client gets fb's answer; A's `/hits.count` is 1.
- C-b Retry-After honored: A benched ~5s — a second request skips A (`fa` hits stays 1), served by fb.
- C-c 401 walks and benches long: chain `fa/fake-401 → fb/fake-ok` → answer from fb; third request never touches fa.
- C-d all-fail envelope: chain of two `-500` models → 502 with the `all N candidate(s)` message naming last status 500.
- C-e 400 passes through unwalked: single-model chain `-400` → status 400 relayed, fb hits 0.
- C-f usage rows carry failover reasons: `GET /api/usage` recent rows show `reason: "failover:0:..."`-style entries for the walked requests.
- C-g `/route` verdict answers for a plain task (covers the P0.1 dedupe on the live path).
- C-h streaming metered: `-stream` chain → client receives untouched SSE; ledger row shows tokens from the tap.

Commit: `test: probe-failover — the /v1 failover/metering wire contract, zero real providers`.

### Task P1.3: tools/run-probes.mjs + `npm test`

**Files:** Create `tools/run-probes.mjs`; Modify `package.json` (scripts).

The runner is glob-driven, never a hand list (new probes auto-enroll): run every `tools/test-*.mjs`, `tools/unit-*.mjs`, `tools/probe-*.mjs` sequentially (ports are per-probe; sequential is the collision guard), `stdio: "inherit"`, aggregate, print `N suites, M failed`, exit 1 on any failure. `tools/visual/` is excluded (own package, Playwright, manual — documented in its README line).

```json
  "scripts": {
    "kit": "node bin/agnostic-router-kit.mjs",
    "test": "node tools/run-probes.mjs"
  }
```
Verify: `npm test` → all existing suites green (5 test/unit + 7 probe files as of today) plus the two new ones; introduce a deliberate `ok(false)` in a scratch copy to watch the runner fail, then revert. Commit: `test: run-probes runner + npm test — the probes are enforced, not ornamental`.

### Task P1.4: CI

**Files:** Create `.github/workflows/ci.yml`.

Single job: `ubuntu-latest`, `actions/checkout@v4`, `actions/setup-node@v4` (node 20), `npm test`. A comment in the file states why it's enough: probes bind 127.0.0.1 only, spawn scratch homes, make zero real network calls; the guard scripts need the other edition and stay local-only. No merge-queue/sharding machinery — that lesson is explicitly NOT copied at this scale. Commit: `ci: single-job npm test on node 20 — green or it doesn't merge`.

### Task P1.5: docs state the new contract

README (verification section: `npm test`, what it runs, the fake upstream), TECHNICAL-DOCUMENTATION.md module inventory (fake-upstream, probe-failover, run-probes). Commit: `docs: the verification layer is now enforced`.

## Phase P2 — failure classification (the key-rejections/retry lesson)

**Decision-shape note (recorded deliberately):** classifying a failure is a per-item decision, which is sys1's shape — but it is rejected here on purpose: the classification must be deterministic, zero-latency, and runnable offline in CI on scripted bodies. Pure-function pattern matching is the right tool; sys1's lane stays routing and judging.

### Task P2.1: router/failclass.mjs — pure classifier, unit-tested first

**Files:** Create `tools/unit-failclass.mjs` (failing first), then `router/failclass.mjs`.

The ordering law, ported from OpenMausBot's `retry.ts`: **the usage-limit pattern is checked before the 429 pattern** ("a subscription's window is hours away, so its limit is terminal even when the provider phrases it as a rate limit"), and **quota/billing/rate-limit bodies are never key rejections** (`key-rejections.ts`).

```js
/**
 * Failure classification for the failover walk. Pure: status + a bounded
 * body snippet in, one verdict out. The verdict decides (a) does the walk
 * continue, (b) how long the provider is benched, (c) what the ledger row
 * and the dashboard say. Order is load-bearing: usage-limit vocabulary is
 * matched BEFORE the 429 pattern, and quota/billing/rate-limit bodies are
 * never a key fault — the key is not the thing that is exhausted.
 */
const QUOTA = /usage limit|weekly limit|monthly limit|quota exceeded|insufficient (credits?|funds)|billing|payment required/i;
const RATE = /rate limit|too many requests|overloaded/i;
const KEY = /invalid[- ]?api[- ]?key|incorrect api key|unauthorized|authentication/i;
const MODEL = /model (does not exist|not found)|unknown model|does not exist or is not accessible|no access to model/i;

export function classifyFailure({ status, body = "" } = {}) {
  const s = Number(status) || 0;
  const text = String(body).slice(0, 400);
  if (s === 402 || QUOTA.test(text))
    return { kind: "quota", isKeyFault: false, walk: true, benchMs: 1_800_000, label: "quota window (hours away — not the key's fault)" };
  if (s === 429 || RATE.test(text))
    return { kind: "rate", isKeyFault: false, walk: true, benchMs: 300_000, label: "rate limited" };
  if (s === 401 || (s === 403 && KEY.test(text)))
    return { kind: "key", isKeyFault: true, walk: true, benchMs: 3_600_000, label: "key rejected by provider" };
  if (s === 403 || MODEL.test(text))
    return { kind: "model", isKeyFault: false, walk: true, benchMs: 0, label: "model not available to this key — walk, don't bench the provider" };
  if (s === 408 || (s >= 500 && s <= 599))
    return { kind: "transient", isKeyFault: false, walk: true, benchMs: 60_000, label: "transient upstream failure" };
  if (s >= 400 && s < 500)
    return { kind: "client", isKeyFault: false, walk: false, benchMs: 0, label: "client-caused — surfaced as-is" };
  return { kind: "network", isKeyFault: false, walk: true, benchMs: 60_000, label: "no answer / connection failure" };
}
```

`tools/unit-failclass.mjs` (the `unit-coerce.mjs` idiom — direct import, no server): asserts the ordering law (`429` + `usage limit weekly` body → `quota`, never `rate`), the exemption law (`402`, `quota exceeded` body → `isKeyFault: false`; `401` → `key`; `403` + `invalid api key` body → `key`; `403` + model-vocabulary → `model`, bench 0), walk gating (`400` → `walk: false`), and the network default. Run: red → implement → green. Commit: `feat: failclass — the failure vocabulary, quota-before-ratelimit, keys not blamed for quotas`.

### Task P2.2: wire it into the walk

**Files:** Modify `router/server.js:868` (the `FAILOVER_STATUS` gate in `attemptUpstream`), `:1104-1140` (cooldowns).

- `attemptUpstream` captures the first 400 bytes of an error body when it doesn't relay (streaming responses that already started have no body — classify on status alone, which the table handles).
- The walk gate becomes `classifyFailure(...).walk || FAILOVER_STATUS.has(u.status)` (belt and braces during the transition; the status set stays the floor).
- `cooldownFor(status, retryAfter)` gains the classified bench: **roster `failover.cooldowns` override wins first** (unchanged contract), then Retry-After for `rate` (the honest case, cap 1h unchanged), then `cls.benchMs`, then the `FAIL_COOLDOWNS_MS` floor.
- Ledger `reason` strings carry the label: `failover:0:rate limited`, so the dashboard and P5's attribution read human sentences.
- Key-fault memory: a module-level `Map` keyed `` `${baseUrl}:${sha256(key).slice(0,12)}` `` → `{at, status, label}`; `/api/state` exposes `keyRejections` (bounded to 20). In-memory only, like OpenMausBot's — a router restart re-trusts keys, which is the fail-open posture. `kit doctor` deliberately does NOT read it (separate process; the dashboard is the running router's surface) — stated in the plan so nobody "fixes" it later.

Verify: extend `tools/probe-failover.mjs` — C-i: after C-c's 401, `/api/state.keyRejections` names fa; C-j: after C-a's quota-body request (add a `-402` model to fake A), fa is benched 30min but `keyRejections` does **not** name fa. `npm test` green. Commit: `feat: the walk classifies — quota is not a key fault, model gaps don't bench providers`.

## Phase P3 — atomic writes (the writeFileAtomic lesson)

### Task P3.1: the atomic writer, one copy per vendor boundary

**Files:** Create `router/atomic.mjs`, `lib/atomic.mjs`, and `lib/workflow/atomic.mjs` (identical twins).

Three copies is the deliberate shape, not DRY debt: the router runtime is copied by extension into `~/.agnostic-router-kit/router/` (it must be self-contained), the plane ships as the vendored `workflow-plane` package, and `lib/` is the kit CLI's own code — a shared file would cross one of those boundaries. A header comment in each says exactly that, so nobody "deduplicates" them later.

```js
/**
 * Atomic file writes: temp sibling (mode applied to the temp inode, so the
 * renamed file never briefly exists world-readable) + fsync + rename.
 * durable:false skips fsync for derived caches. Windows EPERM/EBUSY gets a
 * short rename retry; a real permission problem must not be papered over.
 */
import fs from "node:fs";
import path from "node:path";

export function writeFileAtomic(file, data, { mode = 0o644, durable = true } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}`);
  try {
    fs.writeFileSync(tmp, data, { mode });
    if (durable) {
      const fd = fs.openSync(tmp, "r");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, file); break; }
      catch (e) {
        if (i < 4 && ["EPERM", "EBUSY", "EACCES"].includes(e?.code)) {
          const until = Date.now() + 50;
          while (Date.now() < until) {} /* 50ms, bounded */
          continue;
        }
        throw e;
      }
    }
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

export function writeFileAtomicIfChanged(file, data, opts = {}) {
  try { if (fs.readFileSync(file, "utf8") === data) return false; } catch {}
  writeFileAtomic(file, data, opts);
  return true;
}
```

### Task P3.2: adopt at the four flush sites

- `router/usage.mjs:326-334` — flush via `writeFileAtomic(file, json)` (durable — it is state).
- `lib/workflow/memory.mjs:133-143` — save via the plane twin, **`mode: 0o600`** — this is the fix for the world-readable `memory.jsonl` verified in the dive.
- `lib/envstore.mjs:33` — `writeEnvFile` via `lib/atomic.mjs` (same package boundary) with explicit `mode: 0o600`.
- `router/server.js` `applyRoster` (the tmp write at ~:1092 and the rollback write) — via `router/atomic.mjs` (roster is key-free; 0644 default).

Verify: new `tools/unit-atomic.mjs` — mode lands (`statSync().mode & 0o777 === 0o600` for a 600 write), tmp cleaned on throw, `IfChanged` skips an identical write, incomplete-write simulation (throw inside) leaves the old file intact. Extend `tools/probe-memory.mjs` with one assertion: after any write, `memory.jsonl` mode is 600. Existing installs self-heal on the next write (mode rides the temp inode). Commit: `feat: atomic writes at every flush — fsync, mode-on-temp, no more world-readable memory`.

## Phase P4 — capability parity on the walk (v1, deliberately narrow)

### Task P4.1: caps onto every resolved candidate

**Files:** Modify `lib/roster.mjs` (resolve), `lib/render.mjs` (mount), and the `manualModelRules` vocabulary.

Today's rules vocabulary is `contextWindow, inputFormat, supportsJsonSchemaOutput, supportsMidConversationSystem, supportsNativeWebSearch` (verified — there is no images/tools property yet). Add two **optional** properties: `supportsImages`, `supportsTools`. Render each candidate in `routing.workloads[*].candidates[*]` and the omni/wide chains with `caps: { images, tools, ctxWindow }`. The neutrality law copied from the quota module: **undeclared = null = never gates** — a provider that says nothing is neutral, exactly like quota-less providers in `pickCandidate`.

### Task P4.2: the parity gate in the walk

**Files:** Modify `router/server.js` failover loop (~:1026, the `for` over `attempts`).

Before attempting candidate `i>0`: if the request carries `signals.images?.length` and `cand.caps?.images === false`, skip with ledger reason `failover:<i>:parity:images` (same for `toolDefs` vs `caps.tools === false`). A candidate that would silently drop a capability the request needs is *worse* than no fallback — that is the `automatic-recovery.ts` lesson. The steering target (i=0) is the judge's pick and is not second-guessed. When everything is skipped, the 502 envelope names the parity reasons.

### Task P4.3: prove it + show it

Extend `tools/probe-failover.mjs`: scratch roster declares `supportsImages: false` on fa's rule; an image-carrying request walks fa (hits 0) and lands on fb; a tools-carrying request to a `supportsTools: false` chain 502s naming parity. Dashboard: the providers table (dashboard.html:807 region) renders ✓/✗/– for images/tools from the same caps object — the "never show a control the driver cannot honour" doctrine, one column each. Commit: `feat: capability parity — the walk refuses to silently drop images/tools`.

## Phase P5 — ledger attribution + cost (v1, deliberately narrow)

### Task P5.1: prices in, costs computed at the chokepoint

**Files:** Modify `roster.json` schema (optional `pricing: { inputPerM, outputPerM }` per provider, optional `pricingByModel` override map), `lib/render.mjs` (mount as `pricing`), `router/usage.mjs` (`createUsage` gains the price table; `record()` computes `costUsd = pt/1e6*inP + ct/1e6*outP` when the model's price is known, else `null`), rows/snapshot expose `costUsd` + `costSource: "price-list" | null`. Tokens stay reported-only — cost is simply never estimated, consistent with the existing metering law.

### Task P5.2: trigger attribution on the chat path

**Files:** Modify `router/server.js` — the auth gate knows the token class; thread `trigger` (`"operator"` or `"app:<name>"`) through the chat path into `usage.record` (new optional entry field, `null` default). Scope line, stated honestly: mixture rows get it (same request context); **swarm rows stay `null` in v1** — threading origin through swarm's worker pool is churn without a consumer yet; the field exists so P5+ can light it up.

### Task P5.3: prove it + show it

Extend `tools/probe-failover.mjs`: scratch roster declares pricing on fb; after C-a, the ledger row for fb shows `costUsd > 0`, `costSource: "price-list"`, `trigger: "operator"`. Dashboard usage table (dashboard.html usage section) gains a cost column and a trigger badge. Commit: `feat: the ledger prices and attributes — costUsd from declared prices, trigger from the token class`.

## Explicitly deferred (each with its reason — nothing silently dropped)

- **Prompt-cache metering** (stable/volatile split): the proxy *could* see cache behavior per tier — real signal, real design work. Backlog; needs a first measurement of what upstreams even report.
- **Memory expiry + archive-before-evict + recall-into-message**: the plane's shape supports it; the consumers (harnesses) decide injection today. Backlog until a kit-owned consumer exists.
- **Bounded-MCP control-plane doctrine**: the memory MCP server is stdio-local and read-write by design; the doctrine applies when the MCP surface grows beyond memory.
- **Thread-follows-bot model semantics for `/v1`**: needed when apps pin models per conversation — not before that surface exists.
- **Month-per-file ledger + spend caps**: churn without a consumer; single `usage.json` + dashboard covers the machine's worth of traffic.
- **Persisting the judgment cache / cooldowns across restarts**: rejected — fail-open, cold-start re-learn is seconds, and durable cooldowns risk a stale bench outliving its evidence.
- **workflow-runs GC**: rejected — journals are the durable record by design (the graph reads them); disk is the honest cost.
- **Automatic memory capture**: rejected — explicit-first memory is a stated design choice (`kit memory`), not a gap.
- **guard.sh's other-edition path**: deliberately left, per its own comment — stays.

## Acceptance criteria

- [x] **C0** dedupe: single `/route` block; single `workflows`/`workflowLibrary` pair (array-honest); single gate docstring; chat `/run` maps names; `roster.json` free of `hasKey`/`id`; `docs/TROUBLESHOOTING.md` exists and is seeded; all pre-existing suites green.
- [x] **C1** `npm test` runs every `tools/{test,unit,probe}-*.mjs` by glob (visual excluded, documented), exits non-zero on any failure; a new probe file auto-enrolls. (Proven with a deliberate failing suite: red exit 1, removed → green.)
- [x] **C2** fake-upstream + probe-failover green (34 checks — more than the ~12 planned, the parity and quota sections grew it): walk-on-429, Retry-After honored, 401 bench, all-fail 502, 400 passthrough, `/route` live, classified failover reasons in the ledger, streaming metered untouched.
- [x] **C3** classification: unit table proves quota-before-ratelimit ordering and the key-fault exemptions; walk + cooldowns wired with roster override precedence; `/api/state.keyRejections` names key faults and never quota faults.
- [x] **C4** atomic: unit-atomic proves mode/fsync/tmp-hygiene/IfChanged across all three twins; `memory.jsonl` lands 0600 (probe assertion); usage, envstore, roster backup/restore all ride atomic writes.
- [x] **C5** caps: candidates carry caps from the extended rules vocabulary; undeclared stays neutral (no gating); parity probe proves image-doomed and tools-doomed candidates are excluded, never tried.
- [x] **C6** ledger: declared pricing → `costUsd`/`costSource` on rows + dashboard; `trigger` on the chat path; tokens still reported-only.
- [x] **C7** CI workflow committed (single job, node 20, `npm test`) and the suite is green locally; an actual green run on the remote appears after the next push, which this machine cannot observe.
- [x] **C8** zero new runtime npm dependencies; the neutrality grep stays empty; `node --check` clean on every touched file.
- [x] **C9** contract docs updated in-wave (TECH-DOC inventory: failclass, atomic, fake-upstream, run-probes; FUNCTIONAL-SPEC §7 rewritten to the classification/parity/pricing contracts; README: `npm test`, CI, router module line).

## What landed (deviations recorded honestly)

- **Parity excludes before steering, not inside the walk.** The plan put the gate on walk fallbacks; implementing it exposed that `steerSingle` would otherwise happily move a parity-doomed candidate into the *target* slot — quota-healthy is not request-capable. The filter now runs between `decide` and `steerSingle`, so doomed candidates never steer and never walk. One chokepoint, same contract, ledger rows `parity:<capability>`.
- **The plan's C-d wording was wrong about production.** "The steered target is attempted even while benched" is false: a benched provider steers as zero headroom and is moved out of the target slot. The probe asserts the real contract (benched providers steered away, fallback positions skipped, envelope names the full chain with exactly one upstream attempt). Production won; the plan text above is left as written and this section is the correction.
- **Ledger reasons gained a `:kind` suffix** (`+upstream-429:rate`) — the classification belongs in the ledger sentence; the probe regexes were updated with the wiring.
- **Pricing lookup is live**: the router passes a `priceOf` closure reading the refreshed config, so a roster edit + apply reprices without a router restart.

## Incident records (recorded honestly)

- **Three probes exited 1 on success** — `process.exit(failures || process.exitCode ? 1 : 0)` where `failures` is an array, always truthy (memory-api, memory-mcp, visual). Found the moment the P0 boundary ran the whole suite; every earlier "green" for those probes was eyeballed output, not an exit code. Fixed with `failures.length`.
- **The plane's package manifest went stale, exactly the rule-9 class.** Adding `lib/workflow/atomic.mjs` without an `exports` entry made every router-spawning probe fail to boot (`ERR_MODULE_NOT_FOUND` in the *copied* runtime) — caught by `npm test` within one run of P3's first adoption, which is the enforcement layer doing precisely the job it was added for.
- **`kit apply --dry-run` resolves keys against the process env, not the runtime `.env`** — discovered while verifying the roster cleanup; the before/after comparison is the honest verification method for roster edits (recorded in TROUBLESHOOTING).
- **The chat `/run` bug and the world-readable memory store were found by tracing the defect list**, not by the plan — both fixed in P0/P3 with their own evidence.

## Build order and session shape

P0 → P1 → P2 → P3 → P4 → P5. P0+P1 are one comfortable session (cleanup + enforcement); P2+P3 the next (both are pure-function/module work guarded by the new harness); P4+P5 the last (both touch the roster schema and the dashboard). Each phase commits per task and ends `npm test`-green — after P1, that sentence is enforced, not aspirational.
