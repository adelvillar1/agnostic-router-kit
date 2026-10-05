# Workflow dashboard — live runs, the session graph, and their exports

One read-only pipeline feeds every view of kit workflow runs: the journal
normalizer (`lib/workflow/events.mjs`), the graph builder
(`lib/workflow/graph.mjs`), and the router's tail watcher (`router/server.js`).
The kit CLI is the only writer of journals; every consumer here only reads.

## Event schema (view events)

`normalizeEvent(raw, { runId })` maps one `run.jsonl` line (JSON with offset
`t` ms-since-start and a `kind`) to the flat event all consumers share.
Unknown kinds pass through shaped, never dropped; loud fields (tool args,
prompts, results) truncate to 200 chars (300 for report / message / result /
error).

| kind | fields |
|---|---|
| run-start | model, workdir |
| phase | phase |
| agent | actor, ms, tools |
| tool | actor, tool, args |
| report | artifactId, item |
| escalation | actor, question, evidence |
| artifact | artifactId, version, bytes, path, title, primary |
| command | command, args |
| log / warn | message |
| run-done | ms (duration), result |
| run-failed | error |

`isTerminal(kind)` is true for run-done / run-failed.

## Watcher + routes (router/server.js)

Read-only, 1s poll (`wfTick`) over `<kitHome>/workflow-runs/<run>/run.jsonl`
with offset reads and partial-line buffering; ring buffer capped at 500
events per run. `kitHome` is `AGNOSTIC_ROUTER_KIT_HOME` or the router dir's
parent. `startedAt` parses the runId's embedded clock — which is UTC (the
runId comes from `toISOString`), so the parse carries the `Z` suffix or every
age skews by the machine's UTC offset. `lastEventAt` comes from each event's
own offset clock, so the boot-time replay of a finished journal lands in the
past instead of stamping "silent since the router started".

Routes:

- `GET /api/workflow-events?token=…` — SSE; the query token is the same local
  secret (EventSource cannot send headers). Emits `hello` (runs snapshot),
  `event`, `graph-node`, `graph-edge`, `summary`, and a 5s `heartbeat`
  carrying per-run `lastEventAgeMs` — the stall detector.
- `GET /api/workflow-runs` — snapshot rows: runId, name, active,
  lastEventAgeMs, events, startedAt, summary.
- `GET /api/workflow-run/<runId>` — the 500-event buffer + summary.
- `GET /api/workflow-graph` — full graph snapshot (5s server memo).

The graph's `repoRoot` is `AGNOSTIC_ROUTER_KIT_REPO_ROOT` or the kit repo
itself; plans and recaps read from there, journals and the router log from
`kitHome`.

## Graph model (lib/workflow/graph.mjs)

`buildGraph({ kitHome, repoRoot, plansDir?, recapsDir?, routerLogPath?, decisionsDir?, commitCount? })`
→ `{ generatedAt, kitHome, repoRoot, counts, nodes, edges }` — every edge
endpoint resolvable, nothing written, a missing source is an empty subtree
never an error.

Node kinds: `plan` (frontmatter status), `criterion` (positional C0.. per
plan, done/open), `phase`, `run` (kit runs and swarms), `agent` (per actor,
with ask and tool-call counts), `part`, `artifact`, `gate` (dev-decisions
`evidence-gate` rows), `commit` (git log), `recap`.

Edge kinds: `defines`, `sequences`, `dispatches`, `verifies`, `spawns`,
`produces`, `judged-by`, `recorded-by`, `summarized-in`.

## Views

- **Dashboard Activity tab** — runs table with live status (live / quiet /
  stalled? / done / failed) driven by the heartbeat, and per-run detail:
  phases, agents, artifacts, gate verdicts in the run's time window, and a
  200-line event feed. Completed runs render from summary + replay.
- **Dashboard Graph tab** — layered DAG (longest-path columns, barycenter
  rows, hand-rolled SVG, no framework) with live deltas, click-through
  detail per node kind, wheel zoom and drag pan.
- **`kit workflows watch [runId] [--follow]`** — replays a journal one line
  per event (a finished replay lines up with the journal 1:1); `--follow`
  tails a live run until it settles. The router is never involved.
- **`kit workflows graph [--dot] [--archify <out.json> [--archify-run <name>]]`**
  — counts, a Graphviz DOT export (rankdir LR, one cluster per run), or an
  archify `workflow` candidate. The full session is DOT/dashboard material;
  the archify candidate is one run's story — criteria and phases collapse to
  per-plan summary nodes, agents to one counted node — because archify's
  readable-v2 showcase gates cap a node's fan-out well below a real run's
  agent count. Gate it with:
  `archify validate workflow <out.json> --json` and
  `archify finalize workflow <out.json> <artifact.html> --quality showcase --json`
  (archify stays a skill-side tool; the kit emits typed JSON only).

## Read-only rules

The watcher and the graph builder hold no write path into any watched source
— journals, plans, the decisions store, git and recaps are only ever opened
for reading, and killing the router mid-run leaves every watched file
byte-identical. The kit CLI stays the only writer and the only control
surface; the dashboard starts, stops and cancels nothing.
