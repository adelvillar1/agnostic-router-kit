# Session recap — 2026-10-08 (media-loops): the gen1 lane gets its consumers, and the kit executes what the gate surfaces

**Plan:** `docs/plans/2026-10-08-media-loops.md` (completed). The engine shipped the gen1 media lane and deliberately
shipped none of its consumers — seven verbs (`media-gate`, `media-transcribe`, `media-speak`, `media-imagine`,
`record-asr`, `record-media-runs`, `media-budget`) with exactly one use case left open: *F, the kit integration,
"deferred to the kit; the trigger is a kit workflow that adopts media."* This wave is that trigger. The law it keeps is
the one the owner stated: **gen1 is the provider, dev-decisions is the gate, the kit executes what dev-decisions
surfaces** — so nothing here calls gen1 directly, and nothing here lets a media output decide anything. Every verdict
the lane emits is advisory until calibration earns floors, which is what the first loop exists to produce.

## What landed

- **W0, the machine mode (dev-decisions `e10fa6f`)** — `--json` on all seven verbs: one JSON row per line on stdout,
  human chatter suppressed, so the kit's bridge parses the same rows the log carries. `ok` is transport ("the command
  completed and logged"); the row's own `verdict` carries the outcome; `ok:false` marks a pre-row refusal with its
  error named, on stdout never stderr. `TestGen1Lane` +11 cases pin every row shape plus two laws — the machine row
  *is* the log row, and every line parses. Suite 86 green.
- **W1, the bridge (`3545712`)** — `world.media(command, args)` in `lib/workflow/services.mjs`, the default-off
  `media` grant, and the doctor row. The tabular surface cloned with two pinned differences, both forced by this
  lane's advisory exit codes: the verbs exit 1 on gaps and 3 when nothing verified *while still printing their
  accountable row*, so a non-zero exit with rows on stdout is transport-success and `res.ok` reports transport while
  each row's own `ok`/`verdict` carries the outcome; and a pre-row refusal's `{ok:false,error}` on stdout is preferred
  over a stderr tail that reads as empty — the diagram finalize's `039172e` lesson, pinned rather than rediscovered.
  `--json` rides first on every call, and the shared `parseJsonLines` helper replaced four inline copies. 18 unit
  cases.
- **W2, the three loops (`6157891`, `808feae`, `917cfa5`)** — **asr-calibrate** round-trips the pinned fixture through
  every live leg into the feedback store under the exact join key `calibration` already reads, grades each leg's
  accuracy and mean token agreement against the caller's floor, and escalates exactly once when a leg clears: *these
  legs are calibrated; the owner decides whether `gen1_raw` lifts.* It writes nothing in the engine — the source
  carries the marker `media-loops: this workflow has no gen1_raw write path` and the probe greps for it — and a leg
  that is short says what it lacks, because "n=2" is not actionable and "needs more fixtures graded" is.
  **media-budget-watch** ingests gen1's telemetry sink into the tabular lane's media-seconds table (occurrence-keyed,
  so a re-run lands nothing twice) and forecasts next-day audio-seconds per provider through sdm1, degrading with the
  engine's own reason rather than fabricating a band. Its escalation law is one line: `over` is a crossing and
  escalates once, `degraded` is information and never escalates. **narrate** speaks a script's lines, assembles the
  seam's `audio_meta.json` from the engine's own accountable rows rather than shelling gen1's hyperframes route (the
  rows are the accountability surface, and one grant is one thing to police), and gates the render — with no branch
  anywhere that converts a `gaps` verdict into a stop. Each probe drives the real workflow body through the plane's
  own transform over stub CLIs answering in the lane's pinned rows: 12, 14, and 17 cases.
- **W3a, the consumer leg and the live smokes (`32e5665`, `558bdd7`)** — `content-production` gains an optional voice
  track behind the grant, and `probe-content-production-media` proves the grant-absent result is byte-identical to the
  committed pre-leg workflow, so today's behavior is proven rather than asserted. The bridge fix: media paths are
  workspace-relative, so the CLI is spawned with the run's workdir as cwd — a leg that stages a file and then calls a
  verb on it now works, and a hand-rolled `execFile` is the thing to suspect when it does not.
- **W3b, the docs (`399f346`)** — `docs/features/media-lane.md` (the four laws, the surface, the three workflows with
  their refusal paths, the daily cadence, the promotion path), the README grants bullet and inventory at 43 files /
  nineteen loops, TROUBLESHOOTING's media section, both specs, CLAUDE.md.
- **W3c, the sweep (`0328658`)** — the `medialane` node authored under the decision stack with three anchored refs and
  the gate-to-provider edge, all three engine candidates re-pinned and re-finalized at wave HEAD, stills rewritten.
- **W4, the kit port (`41f4792`, `07c6679`, `2593f28`)** — the three `.dwf.ts` loops (line 1 rewritten, every other
  line byte-identical, asserted by the probe before it drives a leg), the doctor row, the `npm run record:media`
  producer, and three suites. The plane needed no port at all: it rides the `workflow-plane` `file:` dependency, so
  the kit carries no copy of it and `npm run check:port` is the drift guard. Then the kit's own recursion — the two
  hand-maintained counts in its architecture diagram corrected (37 saved `.dwf.ts` → 41, 35 installed → 32), all four
  pins brought to the port HEAD with the audit as the evidence (116 refs intact, 0 moved, 0 changed, 0 missing), four
  finalize rounds with every gate passing, and the stills re-rendered.

## The honest deviations

In the plan's "What landed" section, the load-bearing ones: **the kit's ported loops refuse every argument an
operator passes them** — the plane's `parseHeader` matches the engine's `/* workflow` marker while every kit file
carries `/* zcode-workflow`, so the plane sees an empty declaration and rejects the first key with *"unknown argument
"task" — asr-calibrate.dwf declares: (none)"*. Kit-wide and pre-existing (the tabular, semantic and diagram loops
refuse identically), but the media loops are the first consumers whose whole point is a caller-supplied arg, so the
loops ship their defaults pinned rather than a documented override and the probes drive the bodies directly.
Recorded rather than fixed, because the marker word is the port mechanism by design and the tolerance belongs in the
plane; named in the kit's TROUBLESHOOTING. **`check:port` is red on the kit** on the same pre-cause three earlier
ports carry (installed runtime 3/16 current — the operator's `kit apply` + restart, named not done). **The stills'
eye pass is owed to a human** — this session's model cannot read a PNG; sizes, `--check` and the gate runs are the
accountable substitute, not a replacement. **`diagramFinalize` derives its output path from the candidate stem
rather than the candidate's `meta.output`**, so the kit's `plane` candidate writes `plane.html` every round while the
repo tracks `zcode-router-plane.html` — a manual rename the previous port wave also made. **The diagram-refresh loop
promises one refresh dir per finalize and uses one for the whole run** (`round` is never incremented) — harmless,
because receipts are stem-prefixed, recorded anyway. And **one of four engine suite runs showed a transient failure
in `probe-keys-endpoint`**, a scratch-router probe unrelated to this wave, which followed a run this session truncated
with `head` and the orphaned scratch router it left on the probe's fixed port.

## State

Both editions green: engine 30 suites, kit 17 suites. `kit doctor` reads the media row green on this machine and the
diagram row at pin `41f4792` with 0 moved / 0 changed; `npm run workflows:inventory -- --check` green at 41 `.dwf.ts`
/ 23 router-assignable / 18 hand-launched; dev-decisions at `e10fa6f`, suite 86. Outstanding for others: a human
reads the four kit stills, the operator runs `kit apply` + service restart, and the owner decides whether
asr-calibrate's evidence lifts the `gen1_raw` tag. Nothing in this wave changed a routing decision, wrote to the
engine's config, or let a media verdict block anything — which was the point.
