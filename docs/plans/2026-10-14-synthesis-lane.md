# Plan — agnostic-router-kit synthesis lane (blend1 as the fifth model class)

```yaml
---
status: completed
created: 2026-10-14
updated: 2026-10-14
slug: synthesis-lane
---
```

## Context

agnostic-router-kit is the routing + workflow plane: an OpenAI-compatible
proxy that routes `auto` by workload, and a journaled workflow plane where
loops decompose tasks into phases, call agents under declared grants, and
write artifacts. Four model classes have arrived as lanes, each in the same
shape — `world.<lane>` + a default-off batch-only grant + loops + a probe +
a features doc + a CLAUDE.md wave line:

| Class | World capability | Loops / consumers |
|---|---|---|
| sys1 (judging) | the judge layer | every flat judgment in every loop |
| sdm1 (tabular) | `world.tabular` (dev-decisions batch CLI, `--json` injected) | six loops: quota-forecast, flake-watch, calibrate-floors, risk-composed review, triage eval, fleet-watch |
| sem1 (semantic) | `world.semantic` (dev-decisions embeddings, `--json`) | dupe-watch, render-watch, review-sweep dedup head, router-eval neighbors, semroute-shadow |
| gen1 (media) | media generation | asr-calibrate, media-budget-watch, narrate |

**blend1 has zero references in this repo** — the fifth class has not
arrived. The gap is specific and load-bearing: the README states the
division of labor — *flat judgments ride sys1, the LLM agents do generation
only*. Every prose artifact the kit produces is **generated, ungated**:
research-report's Writer phase composes the deliverable from per-angle
claims checked by *agents* (LLM verifying LLM), deep-research's report leg
likewise. Nothing in the kit rates a composed answer against its facts
before it ships.

blend1 is the class that owns that shape: one `ask()` — d1 route gate →
parallel fact lanes → LFM2.5-24B synthesis → GLiDE validation gate —
returning prose with a givens contract (facts never invented; "insufficient
facts" is a first-class outcome), each answer rated before it ships. It is
Python; the kit is Node — the integration is the CLI-shell pattern the
tabular/semantic lanes already established (`DEV_DECISIONS_BIN` →
`execFile` → NDJSON), not a library import.

### Verified current-state facts (read this session)

- Lane arrival shape: `lib/workflow/services.mjs` — `world.tabular`
  (services.mjs:251) resolves `process.env.DEV_DECISIONS_BIN ?? "dev-decisions"`,
  `execFile`s the CLI with a timeout + maxBuffer, parses NDJSON stdout, and
  reports a **configured absence** ("dev-decisions not installed — the
  tabular grant needs the dev-decisions CLI") rather than crashing
  (services.mjs:215-218). A shipped-command allowlist guards the verbs.
- Grants are default-off and batch-only per CLAUDE.md's wave lines
  (`tabular` grant default-off, batch-only; `semantic` likewise; the diagram
  lane's CLI resolved via `ARCHIFY_BIN` with a pinned refusal when absent).
- Loop anatomy (workflows/research-report.ts, read in full): a `/* workflow
  */` header (description/whenToUse/args), `phase(...)`, `agent("Name",
  {system})`, `agent.ask<T>(prompt)`, `report(f)`, `artifact.file(...)`,
  and a return of `{conclusion, findings, verified, notCovered}`.
- research-report's structure: Scoper → parallel Scouts + Checkers (top-2
  claims per angle verified by agents) → **Writer composes the deliverable**
  → cold Reader → artifact. The Writer is the unvalidated step.
- Tests: `npm test` = `node tools/run-probes.mjs` (16 suites); probes are
  TS files in workflows/ with granted/refused modes (search-probe.ts,
  memory-probe.ts are the pattern).
- blend1's CLI: `blend1 ask "<prompt>" --json` prints the full BlendResult
  (route nouls, generated text, validation outcome, cost). Auto-path only —
  the kit never needs `--live`.
- Cost: synthesized ask ≈ $0.0018 measured; direct-path ≈ $0. The GLiDE
  gate is inside blend1 — the kit gets validation for free with the ask.

### Documented defaults (resolved at draft; revisit at plan approval)

1. **Arrival shape** — mirror the tabular/semantic lanes exactly:
   `world.synthesis` in services.mjs, a `synthesis` grant (default-off,
   batch-only), the binary resolved as `BLEND1_BIN ?? "blend1"`, an
   allowlist of `["ask"]`, NDJSON parsing, a configured-absence message
   naming the install, and a wall-clock cap per call.
2. **The grant's verbs** — `ask` only (prompt in, BlendResult out). No
   `search`/`refresh`/`seed` in v1: the kit's loops compose, they don't
   curate corpora (that wiring is a separate wave).
3. **Eval-only, the shadow law** — blend1's prose is advisory: the GLiDE
   gate inside blend1 rates it, and no kit loop blocks on a synthesis
   outcome (the media lane's law: a media-gate verdict never blocks).
   `providers_used`-style tagging rides in the run journal.
4. **Loops** — (a) `workflows/composed-report.ts`, the standalone validated
   composer: givens in → blend1 → validated prose artifact, journaling the
   validation outcome + cost; (b) research-report's Writer phase swaps to
   the composer — the per-angle summaries + claims become the givens, the
   cold-reader phase stays. deep-research's report leg is a follow-up (its
   credit-metered shape is more intricate).
5. **Probe** — `workflows/synthesis-probe.ts` mirroring search-probe:
   granted mode fires one real ask and asserts the BlendResult shape;
   refused mode asserts the grant refusal; a no-binary mode asserts the
   configured absence.
6. **Spend visibility** — the probe's granted mode is the only live path in
   CI; loop runs spend per ask and journal the cost (the kit's ledger
   convention).

## Approach

### Phase 1 — the world capability + grant

1. `lib/workflow/services.mjs`: `synthesis(command, args, {timeoutMs})` —
   the tabular pattern verbatim: allowlist `["ask"]`, args→argv mapping,
   `BLEND1_BIN ?? "blend1"`, execFile with timeout + maxBuffer, NDJSON
   parse, configured absence naming the install (`uv sync` in
   `~/Projects/blend1` or its venv's bin on PATH — the pip path cannot
   resolve the siblings). Exported for the plane's world surface.
2. The grant registry (locate it — grep the `tabular` grant's declaration
   across `lib/workflow/`): register `synthesis`, default-off, batch-only,
   with the same doc-comment register as its siblings.

### Phase 2 — the loops

3. `workflows/composed-report.ts` (new): args `question` + `givens`
   (free-form text or a file path); phases — Compose (the grant's `ask`
   with the givens framed as the only permissible facts, mirroring
   blend1's S2 stance) → Check (the validation outcome rides: passed →
   artifact; failed/inconclusive → the report says so plainly and the
   artifact carries the flag) → Handover (artifact.file + the
   `{conclusion, findings, verified, notCovered}` return). The ask prompt
   carries the untrusted-data framing for any caller-supplied text.
4. `workflows/research-report.ts`: the Writer phase becomes the composer —
   `perAngle` (summaries + claims) serialized as the givens; the deliverable
   is blend1's validated text; the Reader phase and the artifact step are
   unchanged.

### Phase 3 — probe + docs

5. `workflows/synthesis-probe.ts` (new): granted (one real ask, assert the
   BlendResult's route/validation/text fields), refused (grant denial),
   no-binary (configured absence) — search-probe's three-mode shape.
6. Docs: `docs/features/synthesis-lane.md` (the lane's contract: the
   capability, the grant, the loops, the eval-only law), README's lane
   inventory + a provider/library row, CLAUDE.md's Today's-state wave line,
   this plan, and the recap at completion.

## Acceptance Criteria

- [x] **AC1** — `world.synthesis` ships with the `synthesis` grant
  default-off and batch-only; an unknown verb is refused by name; a missing
  binary is a configured absence naming the install, never a crash
  (probe). **VERIFIED** — tools.mjs:166, services.mjs:470/510/533; the
  no-binary probe mode fired the install sentence live; the ENOEXEC
  spawn-throw case is a named absence (397b275 + unit-loops case 6).
- [x] **AC2** — the grant is declared-only: grep proves no plane path
  reaches synthesis without the grant (the tabular/semantic law), and the
  probe's refused mode proves the denial (pytest-equivalent: the probe
  suite). **VERIFIED** — `synthesis` in lib/ only at services.mjs
  (definition) and engine.mjs (import + binding); world.synthesis is not in
  buildTools' agent toolset and blend1 is not in
  DEFAULT_ALLOWED_COMMANDS (structural, stronger than the sibling lanes);
  the refused probe mode fired by name live.
- [x] **AC3** — `composed-report` composes via the grant, writes the
  artifact, and journals the validation outcome + cost; a failed gate
  ships the artifact flagged with the reason, never blocked (probe /
  offline loop test). **VERIFIED** — live 2026-10-14: gate PASSED
  (atq 0.989, contra 0.034), $0.00151, 44.8s, deliverable at
  out/composed-report/deliverable.md with the verdict footer; the
  direct-path ask shipped flagged with the reason named ($0 generative
  spend); 7 hermetic engine cases in tools/unit-loops-synthesis.mjs.
- [x] **AC4** — research-report's deliverable is composed by blend1 with
  the angle claims as givens; the scout/checker/reader phases are
  byte-identical (diff review + the loop's existing behavior preserved).
  **VERIFIED offline** — the spec review's diff proof: exactly two hunks,
  both at/after the Writer phase; lines 1-124 and the closing return
  byte-identical to the pre-image. **The all-live leg is BLOCKED by a
  pre-existing agent-model instability, not the swap**: three live
  attempts (2026-10-14, across machine states and workdir shapes) all
  died at the kit's own 24-tool-round cap inside byte-identical phases —
  Scout angle 5 (write_file), Scout angle 3 (search_files), the Scoper
  itself (33 read_files over 166s), then Scout angle 5 again (run_command)
  — with zero `synthesis_ask` rows in every journal: the compose phase
  never ran. Diagnostics: a focused workdir (the lane's own five source
  files) fixes the Scoper — it converges on 6 angles; individual scouts
  still spin when they hit a wall (missing repo, ungranted net), and the
  engine's no-owner escalation degradation ("proceed on your best
  judgment") is correct but the token-plan model does not follow it. The
  first two attempts ran while the machine was loaded by a large local
  model (user-confirmed); the third ran quiet (Ollama idle) and still
  spun, so load is a contributor, not the cause. Re-run when the scout
  models converge, or narrow their instructions.
- [x] **AC5** — `npm test` green. **VERIFIED** — 33 suites (31 baseline +
  unit-services-synthesis + unit-loops-synthesis); the only failure,
  probe-run-api ("default workdir is the app's own root"), fails
  identically on the parent commit with this branch's changes stashed —
  pre-existing and environmental. (The plan's earlier "16 suites" was a
  stale guess; the real baseline is 31. Workflow probes run via the kit
  CLI, not npm test — unit-*.mjs files are the npm-test lane coverage.)
- [x] **AC6** — live runs. **VERIFIED for the lane's core**:
  `composed-report` ran twice live against the real blend1 (the
  generation-shaped ask: gate passed, $0.00151, 44.8s, real composed
  prose; the factual ask: d1 routed direct/decompose, $0 generative
  spend, shipped flagged with the reason named — the router-gates-the-paid-leg
  law observed live), and `synthesis-probe` granted mode fired one real
  ask. research-report's all-live leg is blocked per AC4 (pre-existing
  Scout instability, compose phase never reached).
- [x] **AC7** — docs updated: features doc + README lane row + CLAUDE.md
  wave line (grep `synthesis`/`blend1` across docs/). **VERIFIED** —
  docs/features/synthesis-lane.md, README lane paragraph + grants list +
  counts (45 files / 20 loops / 18 probes), CLAUDE.md wave line
  (write permitted, no gate), TECHNICAL-DOCUMENTATION +
  FUNCTIONAL-SPECIFICATIONS lane entries per the repo's housekeeping rule.

## Files to be Touched

**New**
- `docs/plans/2026-10-14-synthesis-lane.md` (this plan)
- `workflows/composed-report.ts` — the validated composer loop
- `workflows/synthesis-probe.ts` — the three-mode probe
- `docs/features/synthesis-lane.md` — the lane contract

**Modified**
- `lib/workflow/services.mjs` — `world.synthesis`
- the grant registry file (locate; the `tabular` grant's home)
- `workflows/research-report.ts` — the Writer phase
- `README.md` — lane inventory + row
- `CLAUDE.md` — Today's-state wave line (if a protection gate blocks the
  write, report the text and leave it to the parent)
- `docs/recaps/` — the session recap at completion

**Deleted**
- none

## Out of Scope

- The router's "composed" tier (roster.json — blend1 as a named tier `auto`
  can route to; the second step, separate plan).
- TinyFish into deep-research's search leg (free discovery beside the
  metered Firecrawl leg; separate plan).
- Per-project corpora × the plane's context (the blend1 feature exists; the
  wiring is separate).
- blend1's `search`/`refresh`/`seed` verbs through the grant (v1 is `ask`
  only).
- Any blocking behavior on synthesis output — eval-only is the law.

## Verification

```bash
# offline gate
npm test                                                # 33 suites (31 baseline + 2 unit files)
node tools/unit-loops-synthesis.mjs                     # the hermetic loop suite (stub CLI, real engine)
node tools/unit-services-synthesis.mjs                  # the service suite
grep -rn "synthesis" lib/workflow/ | grep -v services.mjs   # the grant declaration (tools.mjs)
# live (parent) — blend1 is NOT on PATH; point BLEND1_BIN at its venv
export BLEND1_BIN=/Users/alejandrodelvillar/Projects/blend1/.venv/bin/blend1
node bin/agnostic-router-kit.mjs workflows run composed-report --workdir <dir> --grant synthesis \
  --args '{"question":"...","givens":"..."}'
node bin/agnostic-router-kit.mjs workflows run synthesis-probe --grant synthesis --args '{"mode":"granted"}'
node bin/agnostic-router-kit.mjs workflows run research-report --workdir <dir> --grant synthesis \
  --args '{"topic":"..."}'
```

Expected: the probe's granted mode returns a BlendResult with a validation
outcome; refused/no-binary modes fail with named reasons; the live runs
write artifacts whose journal rows carry the validation outcome and cost;
research-report's non-Writer phases behave exactly as before.

## Linked Artifacts

- `docs/plans/2026-10-07-tabular-loops.md`, `2026-10-07-semantic-loops.md`,
  `2026-10-08-diagram-refresh.md` — the arrival pattern this mirrors
- `docs/features/tabular-decisions.md`, `semantic-lane.md` — the features-doc
  shape
- blend1 repo (`~/Projects/blend1`) — the lane; its web-lane and
  project-corpora plans of 2026-10-14
- dev-decisions' `2026-10-14-blend1-synthesis-lane.md` — the same fifth
  class arriving at the calibration layer the same day

## Risks

| Risk | Mitigation |
|---|---|
| A Python dependency inside a Node kit | The CLI-shell pattern is already proven twice (tabular, semantic shell dev-decisions); `BLEND1_BIN` resolution + configured absence, no import entanglement |
| Synthesis spend per ask (~$0.0018) | Eval-only; the probe is the only CI live path; every run journals the cost; direct-path asks cost $0 when d1 routes low |
| Grant reachable from a synchronous plane path | Default-off + batch-only, declared like its siblings; AC2's grep + the refused-mode probe prove the law |
| Untrusted caller text steering the synthesizer | The ask prompt frames givens as data between markers (blend1's S2 stance, extended at the kit's call site) |
| research-report regression (the Writer swap) | Only the Writer phase changes; scouts/checkers/reader/artifact untouched; the loop's existing behavior is the diff baseline |
| blend1's own router fires the web lane unexpectedly | The grant ships `ask` only and never `--live`; d1's `needs_live_facts` decides per ask (observed live at 0.037 on a gate-explanation ask) |
