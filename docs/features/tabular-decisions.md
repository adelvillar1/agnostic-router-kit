# Tabular decisions — the dev-decisions lane, and the six loops that read it

*Shipped 2026-10-07. Plan: `docs/plans/2026-10-07-tabular-loops.md`. Unit probe: `tools/unit-services-tabular.mjs` (hermetic — fixture stubs stand in for the CLI, so every path runs on any machine and nothing here talks to a real dev-decisions install or any model).*

The kit already produces the tables: the usage ledger's hourly weighted spend, the probe outcomes `npm test` appends on
every run, the calibration rows the judge and swarm gates write, the git facts dev-decisions reads. The tabular lane
turns those tables into probabilities and forecast bands — sdm1's many-class models over TabPFN-hosted inference — and
six loops read them. Everything about the lane is batch: a loop calls it between rounds, never inside an ask, and a
machine without any of it is a configured absence — the loop says so by name and the kit proceeds exactly as today.

## The surface

`world.tabular(command, args)` on the workflow plane (`lib/workflow/services.mjs`) execs the dev-decisions CLI — the
same external-binary posture as the swarm's evidence gate: `DEV_DECISIONS_BIN` overrides, absence is a refusal sentence
(*"dev-decisions not installed — the tabular grant needs the dev-decisions CLI (see docs)"*), never a throw. `args` is a
plain object flattened to `--flags`; the stdout contract is JSON lines (one object per line, non-JSON chatter skipped),
and the parsed rows come back whole as `{ ok, command, rows }`. The verbs it speaks are the tabular lane's own:
`override-prior`, `record-runs`, `history-gate`, `record-bench`, `budget-gate`, `risk-prior`, `fleet-anomaly`,
`triage-issues` — anything else is refused by name before a process is spawned.

## The store dir

Tables live where dev-decisions already puts them — `~/.local/share/dev-decisions/tables/` is dev-decisions' own
convention, and the kit neither moves nor renames it. Producers write, consumers read:

- **`quota-spend.csv`** — `npm run record:quota` (`tools/record-quota-table.mjs`): the usage ledger's hourly weighted
  spend, idempotent per bucket.
- **`probe-outcomes.csv`** — appended by `tools/run-probes.mjs` on every `npm test`: one line per suite run
  (ts, suite, passed, failed, ms).
- **`risk_prior.csv`** — written by dev-decisions' own `risk-prior` verb: per-directory revert risk scored from git
  history (columns `dir,…,revert_prior,…`).
- `ci_runs.csv` and the fleet tables — written by the lane's `record-runs` and fleet verbs.

## The two laws

- **The composition law:** *sys1 reads what the work says, sdm1 scores what the work measures.* The LLM agents and the
  sys1 judge heads interpret text — findings, diffs, answers; the tabular lane scores tables — spend series, run
  outcomes, revert history, fleet activity. A loop composes the two: the review's findings stay confirmed-by-a-confirmer;
  the risk prior only annotates them.
- **The batch-only law:** no TabPFN network call ever runs inside a synchronous path. The router's 4-second judge budget
  and the plane's ask loop both forbid it, so loops call `world.tabular` between agent rounds, and the swarm gate's one
  tabular read is a cached CSV parse — zero network, zero child process in the gate path. A synchronous path reads only
  what a producer already wrote.

## The six loops

1. **quota-forecast** (`workflows/quota-forecast.ts`) — the quota-spend table through `budget-gate`'s forecast
   semantics: per-plan exhaustion date with a band; a plan whose band crosses "exhausts within 72h" escalates through
   the run's ladder before anything dies.
2. **flake-watch** (`workflows/flake-watch.ts`) — the probe-outcomes table through `history-gate`'s per-suite scoring:
   likely-flaky suites named in the report, and a flagged failure reads "87% — the known load-order flake; quarantine,
   don't chase". v1 is report-only.
3. **calibrate-floors** (`workflows/calibrate-floors.ts`) — `override-prior` over the shared calibration store, rendered
   as *proposed* per-head confidence floors beside the roster's static ones. v1 proposes, never writes; the roster
   thresholds change only through the owner's own apply path.
4. **risk-composed review** (`workflows/review-sweep.ts` + `router/swarm.mjs`) — the cached `risk_prior.csv` read two
   ways. The review sweep annotates each confirmed finding with the risk of the directory it landed in, plus a one-line
   tally in the report. The swarm's part gate requires a second, independent gate pass — both must support — when a
   part's named paths land in a top-decile-risk directory; the elevated pass's plan records why it ran. Table absent →
   exactly today's sweep and today's gate.
5. **triage eval** (`workflows/triage.ts`) — the eval-only routing head. Runs only when the spawn held the `tabular`
   grant: `triage-issues --sdm1-route --dry-run` scores real issue routing, each prediction journalled under the eval
   tag with `applied: false`, applied nowhere — not the run's verdicts, not the tracker. Predictions accrue in the
   calibration store until the floor is met; deciding with them is a later wave.
6. **fleet-watch** (`workflows/watchdog.ts`) — every watchdog run carries a batch fleet section: `fleet-anomaly` scores
   the repos this machine actually runs against fleet peers, and flagged repos escalate through the run's existing
   ladder into the tower inbox.

## The grant, and absence behavior

`world.tabular` rides the **`tabular`** capability — **default-off**, opted in at spawn exactly like `browser`:
`--grant tabular`. A run without the grant gets the usual refusal, by name and journalled. And every loop is fail-open
by construction: CLI absent, sdm1 unconfigured (no `TABPFN_API_KEY`), or the table empty → the loop reports the absence
in its own words and returns exactly what it would have without the lane — findings unannotated, gate single, triage
byte-identical, watchdog proceeding. `kit doctor` reports dev-decisions and sdm1 like it reports moli and sys1: green
with the version when present, a dim note when not.
