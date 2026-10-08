# Session recap — 2026-10-08 (diagram-refresh): the archify refresh's mechanical four-fifths become a loop

**Plan:** `docs/plans/2026-10-08-diagram-refresh.md` (completed). The repo's architecture diagrams are claims with file
and lines attached; every code wave desyncs them two ways — refs pin line ranges at an old revision, and node text can
quietly become false when the anchored code is rewritten. The refresh was a hand-run procedure (grep every anchor,
re-read the range, edit the candidate, `archify finalize` into a fresh `--out-dir`, move the receipts back, render the
stills, **read the stills**) since 2026-10-06. This wave gives the mechanical 80% a loop and hands the judgment 20%
up by name: the loop anchors claims and never makes one.

## What landed

- **The identity rule, born-verified** — a source ref is intact iff the bytes at its pinned `[line..end_line]` equal
  the bytes at that range in `git show <meta.repository.revision>:<path>`. Run across the three live candidates (61
  refs, pinned at `be3659aa`, HEAD six commits later) it reports 61 intact, 0 moved, 0 changed, zero false positives.
  Label matching was tried first and rejected on the repo's own data: 15 of 61 labels are paraphrases ("run route",
  "judge spec") that appear nowhere verbatim in the anchored code.
- **W1, the foundation (`8e042a8`)** — `diagramAudit` / `diagramRepin` / `diagramFinalize` in
  `lib/workflow/services.mjs` (pure read; pure re-pin; the CLI allowlisted to the one verb `finalize`, resolved
  `ARCHIFY_BIN` → `~/.zcode/skills/archify` → `~/.agents/skills/archify`, absence a refusal sentence never a throw),
  the `diagram` capability (default-off), the grant-checked `world.diagram` binding, the `kit doctor` freshness row,
  and the 26-case unit suite. 25 suites green.
- **W2, the loop (`1ddb223`)** — `workflows/diagram-refresh.ts`: audit → re-pin (moved refs only, idempotent,
  `--dry-run` reports without writing) → finalize what the re-pin touched into a fresh `refresh-<n>/` with the
  receipts moved back beside the candidate → stills (`render-png.mjs`; `--check` verifies sizes without Chrome) → a
  markdown artifact that lists every unresolved ref as the agent's repair list and commands the eye pass. Batch-only
  by construction: no agents, no model calls. The executed probe (`tools/probe-diagram-refresh.mjs`, 13 checks)
  drives the real composition over a real temp git repo and a stub CLI, then proves the no-second-change property,
  the dry run, and the archify-absent fail-open by execution.
- **W3, the docs + the recursion (`61bb7ca`, `49c03a4`)** — the README grants bullet and the loop-library row at 40
  files/sixteen loops, `docs/features/diagram-lane.md` (the laws: identity not similarity, the loop anchors claims
  and never makes them, the receipt dance is mechanical law, the stills are read), TROUBLESHOOTING's four entries,
  both specs, CLAUDE.md. Then the wave's own sweep: the `diagramlane` node authored under the decision stack with
  three anchored refs, all three candidates re-pinned and re-finalized at wave HEAD, stills rewritten and committed.
- **W3b, the refusal-channel fix (`039172e`)** — under `--json` archify writes the failure to *stdout*; the service
  sliced only stderr, so a layout rejection read "archify finalize failed (exit 1): " with an empty reason. The fix
  parses the JSON and names the stage and its first diagnostic; a planted case pins it. By the authoring-order law it
  landed before the sweep's re-pin, so the committed refs and HTML carry the post-fix ranges.
- **W4, the kit port (kit `52c1729`, `ad90ef3`, `fd1df53`)** — `workflows/diagram-refresh.dwf.ts` is the engine's
  loop with line 1 rewritten and the other 417 lines byte-identical; the doctor row in the kit's `lib/cli.mjs`; the
  kit's four candidates audited and refreshed at the port's HEAD (116 refs audited, 56 moved refs settled by the
  loop, one `changed` ref repaired by hand — the loop correctly refused it); the same 27-case suite passing in the
  kit through `node_modules/workflow-plane`; kit docs (feature doc, grants bullet, generated inventory at 38 files /
  21 router-assignable, TROUBLESHOOTING including the kit-only `plane.png` naming wart, both specs, CLAUDE.md, the
  dated snapshot).

## The honest deviations

In the plan's "What landed" section, the load-bearing ones: the `diagramlane` node ships **without an edge** (any
authored via displaces the layout router's plan for the existing `agents-artifacts` edge onto a label rect; node-only
authoring validates clean, and the plan licensed a node, not a re-plan); **check:port is red on the kit** on the same
pre-cause the tabular and semantic ports carry (the installed runtime is 3/16 current — the fix is the operator's
`kit apply` + service restart, named not done); **the stills' eye pass is owed to a human** (this session's model
cannot read a PNG — sizes verified, renders committed, acceptance outstanding); and the kit's registry derives
`scope` as the loop's task argument, so a judge-assigned sentence lands in the scope filter (named in the report and
skipped; the audit and re-pin still run — kit-only, recorded in the snapshot).

## State

Both editions green: engine 25 suites, kit 14 suites. The engine's candidates audit intact at wave HEAD (64 refs,
0 moved / 0 changed / 0 missing, pins `039172e`/`61bb7ca` behind HEAD by the re-pin's batch law); the kit's at kit
HEAD `fd1df53` (116 intact, pin `52c1729`). Outstanding for others: a human reads the stills; the operator runs
`kit apply` + service restart. The refresh procedure stays exactly as it was for anything this loop is not — a
`changed` ref is an author's repair, a rejected layout is an agent's repair, and a new diagram is a different job.
