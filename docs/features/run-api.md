# The run API

*Shipped 2026-10-05. Plan: `docs/plans/2026-10-05-run-api.md`. Probe: `tools/probe-run-api.mjs` (33 assertions, zero model calls), fixture: `workflows/http-probe.ts`.*

The router's wire used to be model-shaped or operator-shaped: any OpenAI-compatible client could route model traffic, and an operator could spawn runs from a shell and watch them on the dashboard. The run API closes the gap between those — an **application** spawns a workflow run over the same local wire, watches its events on the stream that already exists, answers its escalations while it is live, and collects its deliverable.

A spawn is a capability like any other on this machine: declared, validated against the caller's ceiling, journaled.

## Token classes

One bearer gate, two classes:

- **The operator token** (`router.localToken`) — the CLI and dashboard's class. No ceiling: it may spawn in any workspace, request any grants, answer any run, read any run's artifacts.
- **An app token** — a `router.apps` row in the roster, rendered into the runtime config:

```json
"router": {
  "port": 8300,
  "localToken": "local-auto-router",
  "apps": [
    { "name": "probe-app", "token": "…", "grantCeiling": ["workspace-io"], "workdir": "~/somewhere" }
  ]
}
```

Apps are explicit roster rows — no dynamic registration. A leaked app token's blast radius is its ceiling, which is the point of ceilings. The SSE event stream accepts either class via `?token=`.

## Routes

### `POST /v1/runs`

Body:

```json
{
  "workflow": "adversarial-solve",
  "args": { "task": "…" },
  "facts": [ { "kind": "task", "fact": "the caller's declared context" } ],
  "grants": "workspace-io,net-fetch",
  "allowDomains": ["example.com"],
  "allowCommands": [],
  "answers": { "stack": "JavaScript on Node 24" },
  "awaitOwnerMs": 300000,
  "model": "hard",
  "workdir": "sub/path"
}
```

`awaitOwnerMs` (default 0, capped at 24h) opts the spawn into the **owner
wait**: an escalation that no recorded answer resolves holds the run open and
polls the live answers file until the deadline, so a human can answer in the
moment through the answers route. At the deadline it degrades to the recorded
no-owner clause, exactly as an immediate spawn would have. Default 0 keeps
today's degrade-fast behavior for existing callers; the chat surface spawns
with five minutes.

Response: `{ ok, runId, runDir }` — handed back before the run exists; the run id is the run directory's name, and `freeRunDir` still guards the same-second collision.

Validation, all reused from the plane, all failing the request before a run directory exists:

- the workflow exists in the library, and `args` validate against the workflow's own header (`parseHeader`/`validateArgs`);
- facts carry a declared kind (`task`, `stack`, `environment`, `decision`, `verdict`, `status`, `phase`) and non-empty text — the engine re-validates and seeds them through `world.remember`, so they journal as facts an agent can recall;
- grants resolve (`resolveGrants`) — an unknown capability is a 400 naming it;
- **the ceiling**: every requested grant must be in the app's `grantCeiling`, else `403 out of bounds: <grant> is not in <app>'s ceiling — an app spawns under its declared grants, never beyond them`;
- **the sandbox**: an app runs inside its own root (its roster `workdir`, or `<kit home>/apps/<name>/workspaces`), and a body `workdir` is a subpath of that root — outside is refused by name, the same closure as recall's sibling refusal. The operator may name any directory, like the CLI.

The spawn is journaled twice: the router log records `run-spawned` (app, workflow, grants) and refused spawns record `run-spawn-refused` with the rule that refused them; the run's own journal records `run-start` carrying `app`, `grants`, and `facts`. `summary.json` carries `app` too — "who asked" is a journal question, not an inference.

The run executes in-process through the same `runWorkflow` the CLI uses. Every existing surface picks it up unchanged: the SSE stream, the run list, the run detail, the graph, the kanban board.

### `POST /v1/runs/<id>/answers`

Body `{ topic, answer }`. Appends to `<runDir>/answers.jsonl` — the live half of the answers table, read by the engine at escalation fire time. No socket in the engine, the same file discipline as the journal itself.

Precedence in `answerEscalation`: declared topic match, then live topic match, then declared substring, then live substring, then — when the spawn opted into `awaitOwnerMs` — a bounded hold on the live answers file (the in-the-moment answer), then `askOwner`, then the no-owner clause. Every resolution journals its source (`declared` | `live` | `owner` | `none`) — the journal says who answered, not just what was answered.

Scoped like recall: an app answers only the runs it spawned; the operator answers any. Ownership survives a server restart because the journal, not process memory, is the record (`readRunOwner` re-derives it from the run-start line).

### `GET /v1/runs/<id>/artifacts`

The run's versioned artifact index (id, version, file, bytes) from the run's `artifacts/` directory. `?file=probe-answer/v1/probe-answer.md` downloads one file — inside this run's artifacts directory or it does not exist; `..` and foreign paths resolve to the same refusal. An app reads only its own runs' artifacts; the operator reads any.

The read routes the operator already had (`/api/workflow-runs`, `/api/workflow-run/<id>`, `/api/workflow-graph`, `/api/workflow-events` SSE) are unchanged and are the run-read surface.

## Provenance and the escalation path, end to end

- `runWorkflow` accepts `opts.app` (`cli` by default); the run-start line and `summary.json` carry it.
- One escalation path: the agent's `escalate` tool, the stuck policy, and the workflow surface's `escalate(question, evidence, topic)` all land in the same `answerEscalation`, journaled the same way — a workflow escalates directly, without spending a model call to phrase the question.

## Judgment law unchanged

The run API is a caller layer, not a judgment layer: an app-spawned run's gate verdicts route dev-decisions first, sys1 behind it, exactly as operator runs do, into the same calibration store with the same `input_sha256`. The wire adds no inline model call and no route around the gates (grep guard: the only judge sites in `router/server.js` are the routing judge's).

## Roadmap note — AG-UI

The event stream's journal kinds (`run-start`, `agent`, `tool`, `escalation`, `fact`, `artifact`, `run-done`, `run-failed`) map onto AG-UI's typed events: `RunStarted`, `SubagentStarted` (with `parentSubagentRunId` for delegated children), `ToolCallStart/Args/End`, `StateDelta` for the fact store, `RunFinished` with the interrupt outcome for escalations, `Custom` for verdicts and refusals. That mapping is a second render target beside the CLI's, not a new pipeline — its own plan when it comes.

## Probing

```
node tools/probe-run-api.mjs
```

Renders a scratch runtime with the kit's own pipeline (`kit apply --only router` — never a full apply: that re-registers the launchd service, and the service label belongs to the live edition), launches the scratch server on 8399 with its own `AGNOSTIC_ROUTER_KIT_HOME`, and asserts the whole contract above in 33 checks with zero model calls. On success the scratch home is removed; on failure it is left behind and printed.
