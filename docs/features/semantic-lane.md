# The semantic lane — embeddings over the graded history, and the loops that read it

*Shipped 2026-10-07. Plan: `docs/plans/2026-10-07-semantic-loops.md` (supply wave in dev-decisions: `3c61126`; this repo: `3bfbd2c` foundation, `be3659a` loops). Unit probe: `tools/unit-services-semantic.mjs`; executed probes: `tools/probe-sweep-semantic-dedup.mjs`, `tools/probe-render-watch-shadow.mjs`, `tools/probe-semroute-shadow.mjs` — all hermetic on fixture stubs and a local stub embedding server.*

The kit already has the two decision lanes: sys1 reads what the work **says** (diffs, plans, findings) and sdm1 scores
what the work **measures** (spend series, run outcomes, revert history). Both join the calibration store only on exact
`input_sha256` — so a reworded diff orphans its graded history, sweeps re-adjudicate findings they already dispositioned,
and the visual judge re-checks renders that provably did not change. The semantic lane (dev-decisions' third model
class, over the `sem1` library: a local llama-server for text, a sentence-transformers worker for text and images)
indexes what the work **looks like** — and turns all three exact-match problems into neighborhood problems.

## The surface

`world.semantic(command, args)` on the workflow plane (`lib/workflow/services.mjs`) is the tabular surface cloned one
lane over: same external-binary posture (`DEV_DECISIONS_BIN` override), same flag flattener, same JSON-lines contract,
absence is the refusal sentence (*"dev-decisions not installed — the semantic grant needs the dev-decisions CLI with
sem1"*), never a throw. Two things are the lane's own. First, **`--json` is injected on every call** — the machine
contract; the CLI's human prose default is never parsed here. Second, the verbs it speaks are exactly the semantic
lane's batch three: `semantic-index`, `semantic-dedup`, `semantic-nn` — anything else (including the gate verbs) is
refused by name before a process is spawned. The pure dedup rule rides the surface as `world.repeatFromRows` —
exported from `services.mjs`, probe-executed, one source of truth.

Corpora are named: the default calibration corpus is the store root as it has always been; a named corpus lives under
`~/.local/share/dev-decisions/vectors/<name>/` and is model-keyed like everything else. Producers write inputs, the
lane indexes them:

- **`inputs/findings/`** — `tools/record-findings-index.mjs`: a findings JSONL in, one text file per finding id out
  (the second line carries `disposition=…` for the sweep to read back).
- **render directories** — `tools/record-render-index.mjs`: a wave's PNGs into the baseline corpus, idempotent per
  content sha and accumulating across runs.

## The three laws

- **The composition law, extended:** *sys1 reads what the work says, sdm1 scores what the work measures, sem1 indexes
  what the work looks like.* And the operating rule beneath every consumer here: **embeddings propose, sys1/sdm1
  dispose.** A similarity score is a lead to confirm, never a verdict, a label, or a join — nothing downstream of this
  lane gates or blocks on a score.
- **The batch-only law,** inherited verbatim: no embedding call inside the router's 4-second judge budget, the swarm
  gate, or any synchronous path. Loops call `world.semantic` between agent rounds.
- **The shadow law,** new with this wave: a loop that *would* change a decision starts by logging what it would have
  done, and its shadow counts are the promotion evidence. Nothing in this wave skips a judge, drops a finding's gate,
  or steers the router — render-watch's skip is unwritable in its file, review-sweep's repeats stay visible in the
  report, and the shadow router's tap is fire-and-forget with nothing reading its return.

## The consumers

1. **dupe-watch** (`workflows/dupe-watch.ts`) — the calibration moat gets a neighborhood join. The loop rebuilds the
   index (idempotently), reports near-dupe pairs joined against the feedback store, escalates pairs whose two sides
   carry **divergent** grades, renders merge proposals for agreeing pairs, and writes nothing. Near-dupes are over
   *surrogate* text — what each redacted row still references — so every pair is a lead, and the report says so.
2. **router-eval neighbor annotations** (`workflows/router-eval.ts`) — each golden task prints its nearest graded
   neighbors with their labels and dispositions as EVAL-ONLY grading context. The grep-grade never sees them; an
   ungranted run is byte-for-byte today's eval.
3. **review-sweep finding dedup** (`workflows/review-sweep.ts`) — the dedup head sits between review and confirmation:
   a finding whose text nearly matches an already-dispositioned finding carries that disposition as an annotation and
   does not re-enter the confirm gate (the gate exists to reproduce new claims). Repeats stay in the report, marked —
   annotated, never dropped. No corpus → the head is off and the sweep is exactly today's.
4. **render-watch** (`workflows/render-watch.ts`) — the watchdog law extended to pixels, in shadow. A wave's renders
   are embedded (the re-encode is deterministic, so an unchanged render re-embeds at exactly 1.0000 cosine) and
   compared against the last-accepted baseline: 1.0000 counts as *would-skip*, everything else as *dispatch-needed*.
   The loop's only flip is the baseline itself — owner-held, via the escalation or `promote:true`. Skipping visual-judge
   dispatches is a later wave's decision, earned by these counts.
5. **the shadow router** (`router/semroute-shadow.mjs`) — the roster's shape sentences embedded once at startup
   (re-warmed on config reload); after each fresh judge decision it logs which workflow the geometry *would* have
   picked beside the judge's actual pick, tagged `evalOnly: true, applied: false`, into the router's own log. The
   influence guarantee is structural: the tap sits after the verdict, is fire-and-forget, nothing reads its return,
   and every failure disables the logger by name.

## The grant, and absence behavior

`world.semantic` rides the **`semantic`** capability — **default-off**, opted in at spawn: `--grant semantic`. Every
consumer is fail-open by construction: CLI absent, sem1 not importable, the embedding server down, or the corpus empty
→ the loop reports the absence in its own words and returns exactly what it would have without the lane — the sweep
unchanged, the eval unchanged, the router unchanged. `kit doctor` reports the lane beside the tabular one: green when
the CLI speaks the semantic verbs, a dim configured-absence note when not.
