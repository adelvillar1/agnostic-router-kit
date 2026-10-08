# The diagram lane — archify diagrams kept anchored by a loop

*Shipped 2026-10-08. Plan: `docs/plans/2026-10-08-diagram-refresh.md` (this repo only — the kit edition inherits the plane surface through the `workflow-plane` symlink and gains the loop beside its own candidates). Unit probe: `tools/unit-services-diagram.mjs`; executed probe: `tools/probe-diagram-refresh.mjs` — both hermetic, on fixture candidates and a stub archify CLI.*

The system diagram is the repo's claim about itself; the two workflow diagrams are its claims about its own run. Every node, edge, and boundary carries a `sources` entry — a file, a line range, a label — and every candidate pins `meta.repository.revision`, the commit those refs were true at. Those pins are what make the diagrams auditable, and they are also what makes them go stale: any wave that moves code desyncs the map, and any wave that rewrites anchored code can make node text quietly false.

Until this wave the refresh was a hand-run procedure: grep every ref's anchor in the current file, read the range to check the claim still holds, edit the candidate, run `archify finalize` into a fresh `--out-dir` (the HTML owns its browser-evidence path, so every round needs a new one), move the receipt JSONs back, render the stills, and **read the stills** before committing. The mechanical eighty percent of that is deterministic and re-runnable. This wave gives it a loop and leaves the other twenty percent — what a wave changed, what a claim now means, whether the still looks right — where it always was: with the agent and the reader.

## The surface

`world.diagram` on the workflow plane (`lib/workflow/services.mjs`), three capabilities, each exactly as capable as its grant and no more:

- **`audit({ dir, revision })`** — the drift check. For each `docs/architecture/*.candidate.json`, every source ref is classified against the pinned revision: **intact** (the bytes at `[line..end_line]` are identical to the bytes at that range in `git show <pinnedRevision>:<path>`), **moved** (the whole pinned range is found verbatim elsewhere in the file, with its new lines reported), **changed** (the anchored bytes were edited), **missing** (the file is gone). One `git show` per distinct (revision, path), one `rev-parse` per call. It reads; it writes nothing — so `kit doctor` runs it on every invocation and the number is cheap.
- **`repin(candidateJson, movedRefs, { head })`** — pure. Applies *moved* verdicts only: rewrite `line`/`end_line`, repin the revision, return `{ json, changes }`. Run it twice and the second run changes nothing. A `changed` or `missing` ref is never rewritten by it.
- **`finalize({ type, candidate, outDir, repoRoot })`** — spawns the archify CLI, allowlisted to the one verb this wave speaks (`DIAGRAM_COMMANDS = ["finalize"]`; anything else is refused by name before a process is spawned), runs the gates into `outDir`, then moves the receipt JSONs (`<stem>.finalize.json`, `.finalize-summary.json`, `.delivery.json`, `.browser-check.json`) back beside the candidate. The receipt dance that a human could forget is now code.

The CLI is resolved in a pinned order — `ARCHIFY_BIN`, then `~/.zcode/skills/archify/bin/archify.mjs`, then `~/.agents/skills/archify/bin/archify.mjs` — and absence is the pinned refusal sentence, never a throw: *"archify CLI not found — the diagram grant needs the archify skill (set ARCHIFY_BIN=/path/to/archify.mjs; see docs)"*. The stills leg needs no new surface: `docs/architecture/render-png.mjs` is the repo's own script, driven under the process grant. `DIAGRAM_TIMEOUT_MS` (300s) is a batch budget — a finalize runs a real browser check.

## The laws

- **Identity, not similarity.** The first rule tried was label matching, and it fails on this repo's own data: 15 of 61 refs carry paraphrased labels ("run route", "judge spec") that appear nowhere verbatim in the anchored code, so a token match over-flags and buries the real signal. The audit asks the only question with a deterministic answer: *are the pinned bytes still the same bytes?* A ref that moved reports where its content went; a ref whose content was *edited* is not a move — the claim may now be false.
- **The loop anchors claims; it never makes them.** The re-pin moves refs and repins the revision. It does not author nodes, edges, labels, or whole diagrams, and it does not decide that a `changed` ref is still true — every `changed` verdict lands in the report as the agent's repair list, with the old range and the current file to read.
- **The receipt dance is mechanical law, not folklore.** A fresh `refresh-<n>/` per finalize round (never reused), receipts back beside the candidate, and both the refresh dirs and the receipts stay untracked — `git add` the diagram files, never the round's scratch space.
- **The stills are read.** `render-png.mjs` writes them; the loop's report names them and commands the eye pass; `notCovered` claims the visual acceptance was never made. A label-only edit keeps a still byte-identical — that is the expected outcome, not a render failure, and not something a check can accept for you.

## The consumer

**diagram-refresh** (`workflows/diagram-refresh.ts`, router-assignable, batch-only) runs five phases, each naming its own refusal path:

1. **Audit.** All-intact at HEAD → the honest conclusion is "drift-free": skip to the stills check, change nothing.
2. **Re-pin.** The mechanical moves only, idempotently, every change journalled old→new; `--dry-run` reports without writing. Unresolved refs stay pinned as authored.
3. **Finalize.** Each candidate the re-pin touched (plus any named via `--scope`) through `world.diagram.finalize` into a fresh `refresh-<n>/`. CLI absent → the refusal by name; the loop concludes "re-pinned, finalize awaits the archify CLI" and stops — the re-pin stands on its own.
4. **Stills.** `node docs/architecture/render-png.mjs` (`--check` verifies sizes without Chrome; the write leg reports headless-Chrome failures verbatim).
5. **Report.** A markdown artifact: per-diagram verdicts, every unresolved ref with its label, the receipts, the stills' sizes, and the standing line — *eye-verify the stills before committing*.

## The grant, and absence behavior

`world.diagram` rides the **`diagram`** capability — **default-off**, opted in at spawn: `--grant diagram` (runs also want the process grant for the stills leg). Every failure is fail-open by construction: archify absent, the dir absent, or git unavailable reads as a named refusal and the loop returns what it would have without the lane — reports written, nothing finalized, nothing rebased. `kit doctor` reports the row beside the tabular and semantic ones: the candidates' freshness counts from the audit, and a dim configured-absence note for the archify CLI when nothing resolves it. On this machine the skill is installed at `~/.zcode/skills/archify`, so the row is green; on a machine without it, the loop's third phase declines by name and the kit proceeds exactly as today.
