# Session recap — 2026-10-07 (tabular loops): sdm1 scores what the work measures

**Plan:** `docs/plans/2026-10-07-tabular-loops.md` (completed). Method: delegated waves against pinned interfaces — foundation agent, three-way parallel batch, integration mine. Third outing for the shape; it keeps working.

## What landed

- **`world.tabular`** (`d471ffb`): the dev-decisions batch CLI behind the `tabular` grant (default-off, resolveGrants-proven), allowlisted verbs, JSON-lines parsing, hermetic 13-check unit probe (DEV_DECISIONS_BIN stubbed per case), doctor row. Wired into the engine's world surface grant-checked and journaled (`353874d`).
- **Producers** (`def11aa`): `npm run record:quota` — the ledger's hourly buckets weighted by quota steering's own math (off-peak visible in the fixture: 1000×0.5=500), idempotent per bucket; every `npm test` appends probe outcomes to the store.
- **The three build-first loops** (`5ba3704`): **quota-forecast** (bands + exhaustion estimate, escalates on a 72h crossing, stat-gates table freshness), **flake-watch** (per-suite probability, chase/quarantine verdicts, report-only by declared policy), **calibrate-floors** (override-prior proposal + escalation; grep-provable no-roster-write).
- **The consumers** (`49dae47`): the swarm's gate composes the cached `risk_prior.csv` — top-decile parts double-gate (both passes must support), zero network in the gate path, degrades to exactly today's single gate on an empty prior (and caught the writer's root-row bug on the way); review-sweep annotates findings with the prior; triage's eval-only head journals under `applied:false` with `--dry-run` in the argv itself; watchdog's fleet section escalates flagged repos in one ladder call.
- **Docs + diagrams** (`4-tabular` docs commit + `9f49193`-style sweep): `docs/features/tabular-decisions.md` (new), README loop library + plane paragraph, TROUBLESHOOTING, both specs, CLAUDE state; **system-overview carries the decision stack** — `dev-decisions · sdm1` beside sys1, dashed "calibration rows" from the judge — and all three diagrams re-finalized at the wave's HEAD (65→6 refs needed moving this time; the resync discipline compounds).

## The honest list

- C6's planted-positive swarm run wasn't executed — the composition is review-verified plus the empty-prior live case; the residue is named in the plan.
- W2-C found three dev-decisions CLI shapes that differed from the plan's sketches (table name/columns, no `--elevated`, different flags) — each adaptation recorded at its landing site.
- `world.tabular` can't express positional CLI args yet; `triage-issues` runs on its current-repo default.
- The kit's installed runtime lags until `kit apply` (named by check-plane, operator's call as always).

## Numbers

17 engine suites + 6 kit suites, zero failed · 10 commits · zero new runtime dependencies · one loop escalates before a plan dies instead of after.
