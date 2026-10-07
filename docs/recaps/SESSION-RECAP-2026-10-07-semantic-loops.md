# Session recap — 2026-10-07 (semantic loops): sem1 indexes what the work looks like

**Plan:** `docs/plans/2026-10-07-semantic-loops.md` (completed). The third model class lands in the kit: sys1 reads
what the work says, sdm1 scores what the work measures, sem1 indexes what the work looks like — and the operating rule
under everything: **embeddings propose, sys1/sdm1 dispose.** Fourth outing for the tabular wave's shape (supply wave →
surface → loops → docs/diagrams); the new part is the shadow law — anything that would change a decision starts by
logging what it would have done.

## What landed

- **W0, dev-decisions (`3c61126`)** — the kit bridge, honest about being a prerequisite: the three semantic commands
  print human prose, so they gained `--json` (one JSON object per line, human default byte-identical); `--corpus <name>`
  scoping (default stays at the store root — byte-identical; named corpora under `vectors/<name>/`, model
  auto-resolving when the corpus holds one store); `--inputs <dir>` file indexing (extension-routed text → llama-server,
  images → st-worker; idempotent per content sha, accumulating); plus the dims-guard the evaluation's P3 list had
  named (`_cos` raises on a dim mismatch instead of silently truncating). Selftest 49 → 57, all green; live-proven on
  both providers: calibration index 26/6509 rows (the redacted sparsity, predicted), an image corpus self-matching at
  1.0.
- **W1, kit foundation (`3bfbd2c`)** — `world.semantic` in `services.mjs`, the tabular surface cloned with two pinned
  differences: `--json` injected on every call, and an allowlist of exactly the three batch verbs (gate verbs refused by
  name). The `semantic` capability (default-off), the engine binding (grant-checked, journaled with corpus), the doctor
  row, and a hermetic 14-case unit probe.
- **W2, the loops (`be3659a`)** — dupe-watch (near-dupe pairs over the calibration store: divergent grades escalate,
  agreeing pairs render merge proposals, nothing writes; the surrogate-text caveat stated in the file), router-eval's
  neighbor pre-pass (EVAL-ONLY grading context the grep-grade never sees), review-sweep's dedup head (restructured
  review → dedup → confirm; repeats carry prior dispositions, annotated never dropped), render-watch (shadow: 1.0000
  cosine counts as would-skip, the file contains no agent spawn and no dispatch, the baseline promotion is the one
  owner-held escalation), and `router/semroute-shadow.mjs` (the roster's 10 shape sentences embedded at startup and
  re-warmed on config reload; after each fresh judge verdict a fire-and-forget tap logs what the geometry would have
  picked — nothing reads its return). Producers: `record-findings-index.mjs`, `record-render-index.mjs`.
- **Executed probes, the C6-precedent standard** — `probe-sweep-semantic-dedup` (8: surface, rule, producer,
  structure), `probe-render-watch-shadow` (5), `probe-semroute-shadow` (6, against a stub embedding server), 
  `probe-semantic-loops` (5, C4/C5), plus the 14-case unit probe. Kit suite: 22 → 23 entries, all green. Live shadow
  router over the real roster: review-shaped request agrees at 0.88; a research-shaped request would have picked
  `research-report` — the disagreement data, collected.
- **Docs + diagrams** — `docs/features/semantic-lane.md`; README loop library; TROUBLESHOOTING (four absences, the
  expected shadow disagreement, the surrogate-text lead); FUNC-SPEC and TECH-DOC touchpoints; CLAUDE.md; the
  system-overview diagram gains the sem1 node beside the decision stack, all three diagrams re-finalized and their
  stills verified by eye.

## The honest deviations

In the plan's "What landed" section, the load-bearing ones: C6's live-workflow execution recorded as out of the probe
yard's reach (structure-proven instead); semroute-shadow's rows in the router's own log, not the calibration store (the
migration is the promotion wave's business); a mixed `--inputs` corpus yields per-model stores (auto-resolved or
refused by name); and the first render-watch structure grep was replaced by precise assertions — assert what must be
true, not a list of phrases that must not.

## State

Plan closed with evidence blocks per criterion. The port to zcode-router-kit follows this recap; the promotion triggers
(render-watch flip, shadow-router shortlist, dupe-merge application, memory-plane recall) each name their own evidence
and stay out of scope until met.
