# Session Recap — 2026-10-14

## Summary

Shipped the **synthesis lane** (plan
`docs/plans/2026-10-14-synthesis-lane.md`, completed): **blend1 arrives as
the fifth model class** — the validated composer. The kit's prose used to
be generated, ungated (claims checked by agents, an LLM verifying an LLM);
the lane brings a givens contract, composition, and an independent GLiDE
gate rating every answer before it ships. Eval-only by lane law: a verdict
that does not pass ships the artifact flagged, never blocked.

## Plans worked on

- **`docs/plans/2026-10-14-synthesis-lane.md`** — status: **completed**.
  All 7 ACs met (AC4's all-live leg blocked by a pre-existing Scout
  instability — named below).

## Commits

| Hash | Message |
|------|---------|
| `76d3595` | feat: synthesis lane — blend1 as the fifth model class (world.synthesis + composed-report + research-report's composer swap) |
| `397b275` | fix: the quality review's six findings (reachable givens_file, nonce'd markers, named truncations, shipped-artifact verdict tracking, no-crash spawn, hermetic loop tests) |
| `2b800d8` | fix: synthesis-probe's granted mode asserts the shape it can rely on (path-aware; the gate rides the synthesized path only) |

## What was added

- **`world.synthesis`** (lib/workflow/services.mjs) — the tabular shell
  cloned with blend1's own dialect pinned: positional prompt, `--json`
  injected, one pretty-printed object parsed whole-document-first,
  `BLEND1_BIN ?? "blend1"`, 180s cap, allowlist `["ask"]`, configured
  absence naming the install.
- **The `synthesis` grant** (tools.mjs:166) — default-off, batch-only,
  eval-only; structurally enforced (not in buildTools' agent toolset;
  blend1 not in DEFAULT_ALLOWED_COMMANDS).
- **`workflows/composed-report.ts`** — the standalone validated composer:
  question + givens (inline or file) → blend1 → validated prose artifact
  with the verdict, route, cost, and latency riding in the journal, the
  report, and a footer on the deliverable.
- **`workflows/research-report.ts`** — the Writer phase swapped to the
  composer; per-angle research rides as the givens. Scoper/Scouts/Checkers/
  Reader/artifact/return byte-identical (spec review's diff proof: two
  hunks, both at/after the Writer phase).
- **`workflows/synthesis-probe.ts`** — three modes (granted/refused/
  no-binary).
- **Tests** — `tools/unit-services-synthesis.mjs` (20 checks, the service
  against stub CLIs) and `tools/unit-loops-synthesis.mjs` (7 checks, the
  real kit CLI + real engine against a stub blend1: givens_file
  reachability, marker-escape containment, truncation naming, flagged-ship,
  ENOEXEC no-crash, ungranted, missing binary).
- **Docs** — features doc, README lane paragraph + grants list + counts,
  CLAUDE.md wave line, TECHNICAL-DOCUMENTATION + FUNCTIONAL-SPECIFICATIONS
  entries.

## Live verification (parent-run, real blend1)

- `composed-report`, generation-shaped ask: **GLiDE gate passed** (atq
  0.989, contra 0.034), $0.00151, 44.8s — a real onboarding brief composed
  from the givens, verdict footer on the deliverable.
- `composed-report`, factual ask: d1 routed direct/decompose, **$0
  generative spend** — the router-gates-the-paid-leg law observed live; the
  loop shipped flagged with the reason named.
- `synthesis-probe` granted: one real ask fired (path direct, 32.4s); the
  probe now asserts the shape it can rely on and the gate's outcome only
  when the router chose synthesis.

## Review cycle

Spec review: SPEC-COMPLIANT (7/7). Quality review: CHANGES REQUIRED — six
important findings, all fixed in `397b275`: (1) `givens` required:true made
`givens_file` unreachable through the shipped CLI; (2) execFile's
synchronous ENOEXEC throw rejected the promise, crashed the engine, and
wrote no journal row — the lane's no-crash law now holds at spawn time;
(3) fixed givens markers were escapable by content carrying the literal
string — per-run nonce markers now; (4) after a reader fix-up re-compose,
the run record described the first pass while the disk carried the retry —
the record tracks the composition that ships and a gate demotion is named;
(5) the 8000-char givens slice was silent — per-angle budget with dropped
angles named in the ask, the report row, and the footer; (6) text-pinning
tests let 1/3/5 ship — the hermetic loop suite drives the real engine
against a stub CLI.

## Open questions / next steps

1. **research-report's all-live leg** — blocked by a pre-existing Scout
   instability: two live runs died at the kit's own 24-tool-round cap
   (angles 5 then 3; zero `synthesis_ask` rows — the compose phase never
   ran). The failing phase is byte-identical to the pre-image and the
   failure reproduces with and without source material; it is model
   behavior in the agent phases, not the swap. Re-run when the Scouts
   settle, or narrow their instructions.
2. **`kit doctor` has no synthesis row** — every prior lane has one
   (lib/cli.mjs:530-596); the plan's file list omitted it. Follow-up.
3. **The parked rungs** (separate plans): the router's "composed" tier
   (blend1 as a named tier `auto` can route to), TinyFish into
   deep-research's credit-metered search leg (free discovery beside the
   metered Firecrawl leg), per-project corpora × the plane's context.
4. **probe-run-api** fails on this box ("default workdir is the app's own
   root") — reproduced identically on the parent commit with this branch's
   changes stashed; pre-existing and environmental.
