---
status: draft
created: 2026-10-07
updated: 2026-10-07
slug: semantic-loops
---

# Plan: semantic loops — the kit consumes dev-decisions' third model class

**Repo:** agnostic-router-kit (with one supply-side wave in dev-decisions). **Source:** dev-decisions' semantic embeddings lane (landed 2026-10-07: `semantic-index`, `semantic-dedup`, `semantic-nn`, `docs-gate --via-semantic` — all eval-only, tagged `sem1_raw`, batch-only, over the sem1 library: `llama-server` text at 127.0.0.1:8901 (46–86 ms) and `st-worker` text+images (~2 s per 2048 px render, deterministic re-encode)). **Composition law, extended:** *sys1 reads what the work says, sdm1 scores what the work measures, sem1 indexes what the work looks like* — and the operating rule beneath every loop here: **embeddings propose, sys1/sdm1 dispose.** Similarity never produces a verdict, a label, or a join; every capability in this plan ends in a report, an annotation, or an owner gate. The batch-only rule is inherited verbatim: no embedding call inside the router's 4s judge budget, the swarm gate, or any synchronous path.

**The idea, stated once:** the calibration stores join only on exact `input_sha256`, so a reworded diff or a re-committed change orphans its graded history; the visual-judge gates re-check renders that provably did not change; sweeps re-adjudicate findings they already graded. The semantic layer turns all three from exact-match problems into neighborhood problems. Five capabilities, one new plane surface, all fail-open: dev-decisions or sem1 absent → the loop reports its absence by name and the kit proceeds exactly as today.

## Supply-side prerequisite (W0, in dev-decisions — the plan is honest about this gap)

The lane's commands were built for humans: they print prose, and they cover only the calibration corpus. The kit's `world.*` contract parses JSON lines. Three small extensions, all backward-compatible:

1. `--json` on `semantic-index` / `semantic-dedup` / `semantic-nn` — one JSON object per line on stdout (the tabular CLI's output contract); human text stays the default.
2. Corpus scoping — `--corpus <name>` (default `calibration`, existing behavior byte-identical): per-corpus vector stores under `~/.local/share/dev-decisions/vectors/<name>/`, model-keyed as today.
3. File-input indexing — `semantic-index --corpus <name> --inputs <dir>` embeds files from a directory instead of parsing the calibration stores (text files via `llama-server`, images via `st-worker`), idempotent per content sha; rows with recoverable-text semantics do not apply to this mode.

Each extension lands with selftests in dev-decisions' suite, same eval-only tagging (`sem1_raw`), same batch-only law.

## Pinned interfaces (the delegation contract)

```js
// lib/workflow/services.mjs — cloned from world.tabular, line for line
semantic(command, args = {}, { timeoutMs } = {})
// → execFile(DEV_DECISIONS_BIN ?? "dev-decisions", [command, "--json", ...], { timeout }) —
//   allowlist SEMANTIC_COMMANDS = ["semantic-index", "semantic-dedup", "semantic-nn"];
//   anything else refused before spawn. Parses stdout as JSON lines → { ok, command, rows }.
//   Absence (ENOENT) → { ok: false, reason: "dev-decisions not installed — the semantic grant
//   needs the dev-decisions CLI with sem1" } — the pinned refusal sentence, verbatim.
//   Grant: "semantic" (default-off, like browser/tabular). Journal: kind "tool", tool "semantic",
//   args.command, corpus when the args say so. SEMANTIC_TIMEOUT_MS ?? 120_000 (a batch budget).
//   Batch-only: workflows call it between agent rounds, never inside an ask — the tools.mjs
//   tool surface does NOT get a semantic tool in v1.
```

## Approach

Clone the tabular wave's shape one lane over: a default-off grant and a `world.*` surface in `services.mjs` (the only new plane surface), then loops that are workflow files + small producers + consumers, reading batch JSON between agent rounds. Two postures do the safety work: everything in Tier "report-only" changes no decision (reports, annotations, proposals), and everything that *would* change a decision ships as a shadow (log what you would have done; flipping is a later wave earned by shadow counts and fitted floors). The upstream dependency is explicit rather than assumed — W0 lands the JSON-lines output and corpus scoping in dev-decisions first, because the kit's `world.*` contract cannot parse prose and the loops need corpora the lane doesn't index yet.

## The five capabilities (each = one workflow or a surgical edit + its producer + its consumer)

1. **dupe-watch** (`workflows/dupe-watch.ts`, new): phase 1 runs `semantic-index` over the calibration corpus (idempotent rebuild; freshness surfaced, not assumed — the quota-forecast stat-gate pattern); phase 2 runs `semantic-dedup --json` → near-dupe pairs joined against the feedback store. Pairs with **divergent** grades (same neighborhood, different labels/dispositions) **escalate** — that is an ambivalence in the calibration moat the owner must see. Pairs with agreeing grades render a merge-proposal artifact. v1 is report-only: nothing merges, nothing annotates, rows journaled eval-only.
2. **router-eval neighbor annotations** (`workflows/router-eval.ts` gains a pre-pass): per golden task, `semantic-nn --json --text <task>` → the nearest graded neighbors with their labels and dispositions printed as grading context beside the substring-graded verdict. Journaled under the eval tag with `applied: false`. The cheapest calibration generator on this list.
3. **review-sweep finding dedup** (`workflows/review-sweep.ts` gains a dedup head): a small exporter (`tools/record-findings-index.mjs`) writes each journaled finding as a text file keyed by finding id (idempotent); `semantic-index --corpus findings --inputs <dir>` keeps the corpus current; before the confirm gate, each new finding is matched against the corpus — a repeat carries its prior disposition (fixed/waived/overridden) as an annotation and does **not** re-enter the gate; a genuinely new finding passes through unchanged. The near-dupe signal is advisory here: the annotation says "prior disposition attached," the sweep human still sees both.
4. **render-watch** (`workflows/render-watch.ts`, new + `tools/record-render-index.mjs`): the producer embeds a visual wave's rendered PNGs into the `renders` corpus (st-worker; deterministic re-encode proven at 1.0000 cosine). The consumer compares the current render against the last-accepted render's vector: 1.0000 → log "would have skipped this visual-judge dispatch — render unchanged"; below band → dispatch recorded as needed. **Shadow mode in v1: nothing is skipped.** The skip path must be unreachable in code (the C7 grep), and the shadow counts are the promotion evidence for a later wave.
5. **shadow shape-routing** (`router/semroute-shadow.mjs`, new, + a journal writer): embeds the roster registry's shape sentences once at startup (cached, offline-tolerant) and, per judged request, logs which workflow the geometry *would* have delegated to beside the judge's actual pick. Pure agreement data — tagged eval-only, journaled with `applied: false`, and **structurally incapable of steering** (the logger reads the judge's decision, never writes it; the C8 test proves delegation output is identical with the logger on or off). Promotion to a shortlist-in-front-of-the-judge is a later wave's decision, earned by fitted agreement floors.

## Waves (the delegation map)

- **W0 — dev-decisions supply (one agent, other repo):** the three extensions above + selftests; `docs-gate --via-semantic` untouched.
- **W1 — foundation (one agent):** `world.semantic` in services.mjs + the `semantic` grant + doctor row (sem1 presence via the CLI, moli precedent) + `tools/unit-services-semantic.mjs` (CLI-absent skip-aware, stubbed-JSON happy path, refusal-sentence and allowlist-refusal checks).
- **W2 — parallel batch (three agents, disjoint files):**
  - **A:** dupe-watch + router-eval annotations (the two calibration-corpus loops).
  - **B:** review-sweep dedup + its exporter.
  - **C:** render-watch (producer + consumer) + semroute-shadow + its journal surface.
- **W3 — integration (me):** both-edition `npm test`, `check:port`, the archify sweep (below), plan close + recap.

## Documentation (in-wave, explicit)

README: the loop library section gains dupe-watch and render-watch with one-line what/when; a short semantic paragraph (what it indexes, the propose/dispose rule, the grant, the shadow posture of capabilities 4–5). New feature doc `docs/features/semantic-lane.md` (house style): the five capabilities, the corpus convention, the composition law extension, the batch-only law, absence behavior, and the surrogate-text caveat — near-dupe means near-dup *of the indexed text*, and calibration rows are redacted by design, so dupe reports are leads to confirm, not facts. TROUBLESHOOTING: "semantic loop says unavailable" (dev-decisions missing / sem1 not importable / llama-server down / no index — run semantic-index first) and "the shadow router disagrees with the judge" (expected — that is the data it exists to collect). FUNC-SPEC + TECH-DOC: the plane's surfaces list gains the semantic surface; the loop library table gains the two new loops. CLAUDE.md Today's state. Plan closed with deviations; recap filed.

## Archify diagrams (in-wave, explicit)

- **system-overview**: the decision stack gains sem1 — "dev-decisions · sdm1 · calibration store" grows the semantic lane beside the tabular one (source refs: `lib/workflow/services.mjs` `semantic` + `workflows/dupe-watch.ts` + `router/semroute-shadow.mjs`); re-finalize at the wave's HEAD (the delegated re-sync + finalize + render-png procedure).
- **deep-research-loop / run-lifecycle**: not expected to change semantically; source maps re-sync only if their anchored files moved (router-eval.ts and review-sweep.ts are anchored surfaces — an actual ref audit decides, not assumption).
- Kit edition: `zcode-router-plane` untouched unless the plane module count changes (services.mjs grows in place); its plane diagram re-check is part of W3.

## Verification

Evidence per criterion lands in the close-out bundle as it is produced, not reconstructed: C0/C1 via `tools/unit-services-semantic.mjs` output plus `kit doctor` output; C2/C3 via dev-decisions selftest runs (both repos' suites green) plus a fixture round-trip through `world.semantic`; C4–C8 via executed probes in the `tools/probe-*` tradition (drive the real composition, count invocations, prove absence-paths and unreachable write/skip/steer paths by execution and grep, per the tabular wave's C6-precedent standard); C9 via the both-edition `npm test` + `check:port` runs and the archify render-png review. Each criterion's evidence block lands under this section's criterion tags at close-out so evidence-gate can grade the bundle.

## Acceptance criteria

- [ ] **C0** `world.semantic` matches the pinned contract: allowlist (three commands, everything else refused before spawn), `--json` injection, JSON-lines parsing, refusal sentence verbatim, `semantic` grant default-off, batch-only (no tool-surface semantic in v1), journaled with corpus, batch timeout honored.
- [ ] **C1** doctor reports the semantic lane (sem1 + llama-server reachability when dev-decisions is present; absent = dim configured-absence note, moli precedent).
- [ ] **C2** dev-decisions `--json`: each semantic command emits one JSON object per line; the human default is byte-identical to today; `world.semantic` parses the flag's output on a fixture.
- [ ] **C3** corpus scoping: the calibration corpus's stores and behavior are unchanged by the flag's presence; a named corpus is isolated (its own manifest, model-keyed); `--inputs` indexing is idempotent per content sha (double run = same manifest count) and routes images to st-worker, text to llama-server, by extension.
- [ ] **C4** dupe-watch: a fixture with a planted near-dupe pair carrying divergent grades escalates exactly that pair (and only it); an agreeing pair renders a merge proposal; no index → degrades by name with the FAIL-OPEN sentence; nothing merges in v1 (test greps the workflow for write paths).
- [ ] **C5** router-eval annotations: every golden task's report line carries its nearest-neighbor context when the index exists; rows journaled eval-only with `applied: false`; no index → the pre-pass is skipped by name and eval output is unchanged.
- [ ] **C6** review-sweep dedup: a planted repeat finding is annotated with its prior disposition and does not re-enter the confirm gate (executed probe, the C6-precedent standard: drive the real composition, count gate invocations); a new finding's path is invocation-identical to today.
- [ ] **C7** render-watch shadow: same-render re-embed logs "would skip" at 1.0000; a different render below band logs "dispatch needed"; **no skip is reachable** — the probe proves the visual-judge dispatch count is unchanged with the consumer enabled (shadow means shadow).
- [ ] **C8** semroute-shadow: agreement rows journal `would-pick` vs the judge's actual pick with the eval tag; a with/without test proves delegation output is byte-identical; startup shape-embedding is cached and offline-tolerant (server down → logger disabled by name, router unchanged).
- [ ] **C9** docs in-wave per the Documentation section; diagrams per the Archify section; both editions `npm test` green; `check:port` green; plan closed; recap filed.

## Out of scope (with reasons, each naming its trigger)

- **Memory-plane semantic recall** — "no embeddings here" is a recorded deliberate stance (`docs/features/memory-plane.md:69`, the mnemosyne non-port). Trigger: a superseding plan that says so explicitly. Not this wave.
- **Flipping render-watch's skip** — needs the shadow record (zero missed drifts over real waves). Trigger: the C7 counts, owner-reviewed.
- **Promoting semroute-shadow to a real shortlist** — needs fitted agreement floors. Trigger: calibrate-floors qualifying the head (≥ 20 graded rows spanning ≥ 0.4, the calibration report's own bar).
- **Promoting dupe-watch merges from proposal to applied** — needs accumulated owner dispositions on its reports. Trigger: a disposition pattern the owner chooses to automate.
- **Any embedding call in a synchronous path** (judge budget, swarm gate, hooks, tool surface) — the batch-only law, inherited from both upstream lanes.
- **Verdicts, labels, or joins from similarity scores** — the composition law; also the practical reason the 0.90 dedup threshold stays internal and untrusted.
- **st-worker in any request path** — ~2 s per image is producer-tier latency; images ride the batch corpus only.

## Linked artifacts

- Source lane: dev-decisions' semantic embeddings lane — plan `~/Projects/dev-decisions/docs/plans/2026-10-07-semantic-embeddings-lane.md`, recap `docs/recaps/SESSION-RECAP-2026-10-07-semantic-lane.md`, SKILL.md §"Semantic embeddings lane (sem1)"; library `adelvillar1/sem1` (TECHNICAL-DOCUMENTATION.md §1–§7 there).
- Structural template: `docs/plans/2026-10-07-tabular-loops.md` (this plan mirrors its surface → loops → waves → docs → diagrams shape; its C6 executed-probe standard is reused by C6/C7/C8 here).
- Recorded stance this plan must not quietly reverse: `docs/features/memory-plane.md:69` and `docs/plans/2026-10-07-mnemosyne-port.md` (embeddings out of the memory plane — superseding it is an explicit future plan, not a side effect).
