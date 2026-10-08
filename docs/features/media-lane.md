# The media lane — gen1 generates what the work needs heard and seen

*Shipped 2026-10-08. Plan: `docs/plans/2026-10-08-media-loops.md` (supply wave in dev-decisions: `--json` machine mode on the seven media verbs; this repo: `3545712` foundation, `6157891` asr-calibrate, `808feae` media-budget-watch, `917cfa5` narrate, `558bdd7` the workspace-cwd fix, `32e5665` the content-production voice leg). Unit probe: `tools/unit-services-media.mjs`; executed probes: `tools/probe-asr-calibrate.mjs`, `tools/probe-media-budget-watch.mjs`, `tools/probe-narrate.mjs`, `tools/probe-content-production-media.mjs` — all hermetic on fixture stubs, with the lane's four key-less and keyed legs exercised live against the real CLI.*

The kit has three decision lanes: sys1 reads what the work **says** (diffs, plans, findings), sdm1 scores what the work
**measures** (spend series, run outcomes, revert history), and sem1 indexes what the work **looks like**. All three
answer questions about work that already exists. The media lane (dev-decisions' fourth model class, over the `gen1`
library: Qwen TTS and Wan images on DashScope, StepFun audio, a local Kokoro voice) generates what the work needs
**heard and seen** — narration rendered from a script, a render graded against the script that produced it, ASR
calibrated against pinned fixtures, and the audio-seconds spend forecast before it happens.

## The surface

`world.media(command, args)` on the workflow plane (`lib/workflow/services.mjs`) is the tabular and semantic surfaces
cloned a third lane over: same external-binary posture (`DEV_DECISIONS_BIN` override), same flag flattener, same
JSON-lines contract, absence is the refusal sentence (*"dev-decisions not installed — the media grant needs the
dev-decisions CLI with gen1 (see docs)"*), never a throw. The verbs it speaks are exactly the media lane's seven:

| verb | what it does |
|---|---|
| `media-speak` | renders text to audio — `--text`/`--text-file`, `--out`, plus voice/language/format/speed |
| `media-gate` | transcribes a render and grades it against its script — `--script`+`--audio` (single) or `--request`/`--meta`/`--project` (an existing seam) |
| `media-transcribe` | audio in, transcript out |
| `media-imagine` | prompt in, image files out |
| `record-asr` | grades pinned `.mp3`/`.txt` fixture pairs per provider leg — the lane's only gradeable verb |
| `record-media-runs` | ingests a gen1 telemetry JSONL into `media_runs.csv`, idempotent per occurrence |
| `media-budget` | forecasts audio-seconds per provider against a named budget |

Anything else is refused by name before a process is spawned. Two things are this lane's own.

**The bridge reports transport; every row reports its own outcome.** The media verbs' exit codes are advisory — `1`
when a gate found gaps, `3` when nothing could be verified — and both still print the accountable row. So a non-zero
exit *with rows on stdout* is a success here, and a pre-row refusal prints `{ok: false, error}` on stdout rather than
stderr, which the bridge prefers over a stderr tail that would read as empty. A workflow therefore reads `res.ok` for
"the CLI ran and answered", `res.refused` for a refusal the CLI named, and each row's own `verdict` for the outcome it
should render. **`!res.ok` alone would read a refusal row as a rendered leg** — the narrate probe pins that
distinction, and the content-production leg carries the comment.

**The CLI runs in the run's workspace.** The lane's paths are workspace-relative by the engine's own verb docs
(`--project .` means the workspace root), so the bridge spawns the child with the run's workdir as its cwd. Without
that, a file a workflow staged reads back as unreadable even though it is on disk — the defect `558bdd7` fixed, found
by a live run whose stub-based probe could not see it, because a stub that ignores its inputs proves the wire and not
the resolution.

## The four laws

- **The composition law, extended:** *sys1 reads what the work says, sdm1 scores what the work measures, sem1 indexes
  what the work looks like, gen1 generates what the work needs heard and seen.*
- **dev-decisions is the gate.** This surface speaks only dev-decisions verbs and journals `via "gen1"`; it never calls
  a provider's API directly. The kit executes what dev-decisions surfaces — one grant is one thing to police, and the
  rows are the accountability surface.
- **Every render is eval-only.** Nothing here ships, and **a media-gate verdict is advisory and never a block.** Its
  agreement score rides an uncalibrated ASR until `record-asr` earns floors, so a loop that gates a render reports the
  verdict and lets the deliverable stand exactly as its author wrote it.
- **The batch-only law,** inherited: no provider call inside the router's 4-second judge budget, the swarm gate, or any
  synchronous path. Loops call `world.media` between agent rounds.

One more, mechanical: **every gen1 provider serves its own container and ignores the requested one** — qwen answers
mp3, StepFun and Kokoro answer wav. A row's `format` is the container truth, so a render that lands in a `.mp3`
filename while being a wav is *named* as a disagreement rather than hidden, and the gate reads it by content either
way.

## The consumers

1. **asr-calibrate** (`workflows/asr-calibrate.ts`) — the lane's promotion evidence. `record-asr` grades the pinned
   fixture per provider leg; the loop renders the per-leg accuracy table as an artifact and escalates exactly once,
   naming the cleared legs. It writes nothing to the engine's config or the eval-only tag.
2. **media-budget-watch** (`workflows/media-budget-watch.ts`) — the daily cadence. It ingests the gen1 telemetry
   (`record-media-runs`, idempotent — a second pass lands 0 new rows) and forecasts audio-seconds per provider
   (`media-budget`). Fewer than four recorded days reads as a *named* degraded reason and never escalates; a crossing
   of the named budget escalates exactly once.
3. **narrate** (`workflows/narrate.ts`) — a render leg, a gate leg, and a loop that blocks nothing either way. Verify
   mode gates a planted script/audio pair; render mode speaks each line of a request file, assembles the hyperframes
   seam's `audio_meta.json` **from the speak rows themselves** rather than shelling gen1's route under the process
   grant, and gates the seam it just built. A `--project` path-escape is the engine's refusal, passed through verbatim.
4. **content-production's voice leg** (`workflows/content-production.ts`) — the producing consumer. With the grant,
   the finished piece gains a voice track: the deliverable is read back off disk, its markdown scaffolding stripped (a
   heading marker is not a spoken word), the prose spoken through `media-speak`, and that exact script gated against
   the render. The verdict rides the conclusion as an advisory line and the track rides beside the deliverable as a
   second artifact. **Grant absent, or any refusal, and the result object is byte-identical to the workflow that
   always was** — proven by driving the committed pre-leg body through the same stub surface and deep-equal-ing the
   two results.

## The grant, and absence behavior

`world.media` rides the **`media`** capability — **default-off**, opted in at spawn: `--grant media`. Every consumer is
fail-open by construction: CLI absent, gen1 not importable, a key missing (the refusal names the variable), or a table
with too little history → the loop reports the absence in its own words and returns exactly what it would have without
the lane. `kit doctor` reports the lane beside the tabular and semantic ones: green when the CLI speaks the media
verbs, a dim configured-absence note when not — and never a key value in its output.

## The daily producer cadence

`npm run record:media` (`tools/record-media-telemetry.mjs`) runs `record-media-runs` over the machine's gen1
telemetry (`~/.config/gen1/telemetry.jsonl` by default, overridable with `--telemetry` or `GEN1_TELEMETRY_FILE`) into
dev-decisions' own store (`~/.local/share/dev-decisions/tables/media_runs.csv`). It is the lane's only producer: the
forecast degrades by name until four days of history exist, so the cadence is what buys the forecast its floors.
Rows carry agreement, token counts, durations and sha256s — never transcript content, never key material.

## The promotion path

`record-asr` is the **only gradeable verb in the lane** and the exit from `gen1_raw`: it is the one place a render is
scored against ground truth rather than against itself. Until its floors land, every media-gate verdict rides an
uncalibrated ASR — which is exactly why the gate's verdict is advisory and every loop above reports rather than
blocks. The path out is the same shape as the other lanes' shadow laws: the loop logs what it would have done, and
those counts are the promotion evidence.
