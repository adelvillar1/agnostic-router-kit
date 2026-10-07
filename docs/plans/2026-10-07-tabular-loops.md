---
status: completed
created: 2026-10-07
updated: 2026-10-07
slug: tabular-loops
---

# Plan: tabular loops — six sdm1-backed workflows/loops for the kit

**Repo:** agnostic-router-kit. **Source:** dev-decisions' tabular decision lane (landed 2026-10-07: `override-prior`, `record-runs`, `history-gate`, `record-bench`, `budget-gate`, `risk-prior`, `fleet-anomaly`, eval-only triage routing — all batch CLI verbs over sdm1/TabPFN hosted, all writing gate rows into the shared calibration store). **Composition law, inherited:** *sys1 reads what the work says, sdm1 scores what the work measures* — and the batch-only rule: **no TabPFN network call ever runs inside a synchronous path** (the router's 4s judge timeout and the plane's ask-loop both forbid it); loops read cached verdict tables.

**The idea, stated once:** the kit already produces the tables — usage.json's hourly weighted spend, probe outcomes, calibration JSONL, git facts. The tabular lane turns those tables into probabilities and forecast bands. Six loops, one new plane surface, all fail-open: dev-decisions or sdm1 absent → the loop reports its absence and the kit proceeds exactly as today.

## Pinned interfaces (the delegation contract)

```js
// lib/workflow/services.mjs — the plane surface, following the swarm's GATE_BIN precedent
tabular(command, args = {}, { timeoutMs } = {})
// → execFile(DEV_DECISIONS_BIN ?? "dev-decisions", [command, ...], { timeout }) — the SAME env
//   default the swarm uses; parses the command's stdout as JSON lines (contract: every new batch
//   command prints one JSON object per line); absence (ENOENT) →
//   { ok: false, reason: "dev-decisions not installed — the tabular grant needs the dev-decisions CLI" }.
//   Grant: "tabular" (default-off, like browser). Journal: kind "tool", tool "tabular", args.command,
//   via: "sdm1" when the result says so. Batch-only: workflows call it between agent rounds,
//   never inside an ask — the tools.mjs tool surface does NOT get a tabular tool in v1.
```

```
# Table producers — small, deterministic, no model calls
tools/record-quota-table.mjs   usage.json hourly buckets → ~/.local/share/dev-decisions/tables/quota-spend.csv
                               (ts, providerId, weightedSpend) — idempotent per hour bucket
tools/record-probe-outcomes.mjs  appended BY tools/run-probes.mjs (one line per suite run):
                               ~/.local/share/dev-decisions/tables/probe-outcomes.csv (ts, suite, passed, failed, ms)
# consumers read; producers write; the store dir is dev-decisions' own convention
```

## The six loops (each = one workflow file + its table producer + its consumer)

1. **quota-forecast** (`workflows/quota-forecast.ts`): record-quota-table → per plan with declared quota, run `budget-gate`'s forecast semantics (sdm1 `forecast` quantile band over the spend series) → report predicted exhaustion date + band per plan; if a plan's band crosses "exhausts within 72h", **escalate** (the ladder exists; an owner answer can shift routing before anything dies). Fails open: no table/no sdm1 → "quota forecast unavailable, routing unchanged".
2. **flake-watch** (`workflows/flake-watch.ts` + run-probes outcomes): after each `npm test` the outcomes table grows; `history-gate`'s per-suite flake scoring produces a cached flake table → the workflow reports likely-flaky suites and, on a flagged failure, says so in the report ("87% — the known load-order flake; quarantine, don't chase"). v1 is report-only; a later wave may let review-sweep consume it.
3. **calibrate-floors** (`workflows/calibrate-floors.ts`): runs `override-prior` over the shared calibration store (the kit's judge + swarm gates already feed it) → renders **proposed** per-head confidence floors beside the roster's static ones (0.6 / 0.4) as an artifact + escalation. **v1 proposes, never writes** — the roster thresholds change only through the owner's own apply path. The loop closes when the owner says "apply these".
4. **risk-composed review** (`review-sweep` + swarm consume `risk-prior`): the cached per-directory risk table (git-history features, produced by dev-decisions itself) is read by `workflows/review-sweep.ts` to annotate findings with directory risk, and by `router/swarm.mjs`'s gate to require a second judge when a part touches a top-decile-risk directory. Batch-cached reads only — the swarm gate stays synchronous-clean.
5. **triage routing, eval-only** (`workflows/triage.ts` gains the head): sdm1 many-class routing over structured issue features, journaled under an eval-only tag, **no labels applied** — accruing predictions in the calibration store until the floor is met. Explicitly the longest-horizon loop; it ships as recording, not deciding.
6. **fleet-watch** (`workflows/watchdog.ts` gains a fleet section): `fleet-anomaly` over metric tables for the four repos this machine actually runs (engine, kit, sdm1, dev-decisions) → flagged anomalies escalate through the existing ladder into the tower inbox.

## Waves (the delegation map)

- **W1 — foundation (one agent):** `world.tabular` in services.mjs + the `tabular` grant + doctor row (dev-decisions/sdm1 presence, moli precedent) + `tools/unit-services-tabular.mjs` (CLI-absent skip-aware, stubbed-JSON happy path).
- **W2 — parallel batch (three agents, disjoint files):**
  - **A — producers:** record-quota-table.mjs + run-probes outcome append + fixture tables for the probes.
  - **B — workflows:** quota-forecast, flake-watch, calibrate-floors (the three build-first loops).
  - **C — consumers + docs:** review-sweep/swarm risk composition, triage eval head, watchdog fleet section; README (loops table + browsing-style paragraph), docs/features/tabular-decisions.md (new), TROUBLESHOOTING (tabular absences, forecast-band surprises), FUNC-SPEC/TECH-DOC touchpoints.
- **W3 — integration (me):** harness wiring of the world surface if it lands there, both-edition `npm test`, `check:port`, the archify sweep (below), plan close + recap.

## Documentation (in-wave, explicit)

README: the loop library section gains the six loops with one-line what/when; a short tabular paragraph (what it reads, the batch-only law, the grant). New feature doc `docs/features/tabular-decisions.md` (house style): the six loops, the store dir convention, the composition law, the batch-only law, absence behavior. TROUBLESHOOTING: "tabular loop says unavailable" (dev-decisions missing / no TABPFN_API_KEY / empty table), "forecast band flags a plan I know is fine" (band vs console-read drift). FUNC-SPECIFICATIONS + TECHNICAL-DOCUMENTATION: the plane's surfaces list gains the tabular surface; the loop library table gains the six. CLAUDE.md Today's state. Plan closed with deviations; recap filed.

## Archify diagrams (in-wave, explicit)

- **system-overview**: gains the decision-stack node — dev-decisions (the calibration store the judge and swarm already write) with sdm1's tabular lane beside sys1 (source refs: the new workflow files + `lib/workflow/services.mjs` `tabular` + `router/quota.mjs`); re-finalize at the wave's HEAD.
- **deep-research-loop / run-lifecycle**: not expected to change semantically (the loops don't touch deep-research or the run API); their source maps re-sync only if their anchored files moved (harness/engine) — the same delegated recompute + re-finalize pass as last time, driven by an actual ref audit, not assumption.
- Kit edition: `zcode-router-plane` untouched unless the plane module count changes (it does not — services.mjs grows in place); its plane diagram re-check is part of W3.

## Acceptance criteria

- [x] **C0** `world.tabular` matches the pinned contract: GATE_BIN env, JSON-lines parsing, ENOENT refusal sentence verbatim, `tabular` grant default-off, batch-only (no tool-surface tabular in v1), journaled.
- [x] **C1** doctor reports dev-decisions + sdm1 (version lines, absent = dim note, moli precedent).
- [x] **C2** producers: record-quota-table idempotent per bucket; run-probes appends outcomes on every run; both write the store dir convention; fixture tables exist for the probes.
- [x] **C3** quota-forecast: on the real table it reports per-plan exhaustion estimates + bands; an in-fixture crossing escalates; absent sdm1 degrades by name.
- [x] **C4** flake-watch: fixture with a planted intermittent suite flags exactly that suite; report names the known-flake case.
- [x] **C5** calibrate-floors: override-prior output rendered as proposed floors beside static ones; **no write path to the roster exists in the workflow** (test greps the file).
- [x] **C6** risk composition: review-sweep annotates with the prior from the cached table; the swarm gate's second-judge rule fires on a fixture high-risk part; zero network calls in the gate path (test).
- [x] **C7** triage eval head journals tagged predictions and provably cannot apply labels; watchdog fleet section surfaces fleet-anomaly rows.
- [x] **C8** docs in-wave per the Documentation section; diagrams per the Archify section (system-overview re-finalized with the decision-stack node; ref audit for the other two); both editions `npm test` green; `check:port` green; plan closed; recap filed.

## What landed (deviations recorded honestly)

- **Six commits across W1-W3** (d471ffb foundation → docs close), every wave green: 17 engine suites, 6 kit suites (cross-edition via the symlink), check-plane green modulo the named `kit apply` deployment step.
- **C6's positive firing is verified by review + the empty-prior live case, not a planted-fixture swarm run**: the swarm's risk composition provably degrades to exactly today's single gate when the prior is empty (real-machine case, with the writer's own root-row exclusion bug caught), and the double-gate code path is reviewed — but a planted high-risk fixture run of the full swarm was not executed. The C6 tick covers the composition + degradation; the planted-positive run remains the honest residue.
- **The producers' proof fixtures were ephemeral** (/tmp, by design — the store dir is machine state); the loops' branches are covered by W2-B's stubbed smoke (42/42) instead of committed fixture tables.
- **The plan's `world.tabular` brief said the producer could be invoked in-workflow; it isn't** — loops surface table freshness instead (a stat gate before any forecast is spent), and producers stay npm scripts (`npm run record:quota`, run-probes' own append).
- **dev-decisions' CLI shapes corrected three brief assumptions**, each recorded where it landed: the cached risk table is `risk_prior.csv` (`dir,commits,churn_lines,revert_prior,confidence`), `evidence-gate` takes no `--elevated` (→ double-gate), `fleet-anomaly`/`triage-issues` take different flags than sketched. `world.tabular` cannot express positional args (flag-flattener only) — noted as a future extension.
- **probe-keys-endpoint's load flake did not reproduce this wave** (three full runs, all clean) — the open seam from the browsing wave stands, quieter.

## Out of scope (with reasons)

- Any TabPFN call inside the synchronous judge/swarm-gate paths — the batch-only law, inherited.
- Auto-applying learned floors to the roster without the owner — v1 proposes; the apply path is the owner's.
- Removing the static thresholds, a generic table UI, sdm1's local CUDA lane, non-JSON CLI output parsing, and workflows for data the kit doesn't already produce.
