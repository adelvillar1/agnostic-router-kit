# Feature: The workflow runtime

> Contract: `FUNCTIONAL-SPECIFICATIONS.md` § Core Features ("Workflow runtime"), § Failover & Degraded States.

## Purpose

A **workflow** is one TypeScript file under `workflows/` that runs on the kit's
own runtime — no harness, no framework, no dependency on any agent tool. A
workflow script gets a small, boring surface (`agent`, `world.run`, `files.*`,
`git.*`, `artifact.*`, `report`), and the kit gives it exactly that: an agent
that can read, write, search and run commands inside one workspace, with every
model call routed through the router like any other request.

The point is portability. A workflow written against this surface runs
unchanged on any machine that has the kit — it cannot reference a
machine-absolute path, a harness binary, or a skill directory outside the repo,
because the surface it sees has no way to express one.

## The file format

A workflow is a `.ts` file with an optional metadata header and a body of
top-level-await TypeScript:

```ts
/* workflow
description: "Reviews changed files with confirmed findings: one reviewer per
  changed file, one independent confirmer per finding, findings sorted by
  severity and published as a review report."
whenToUse: When the request is to review changes — a diff, a PR, or modified
  files — and findings should be confirmed before anyone acts on them.
args:
  base:
    type: string
    description: Diff base ref; empty reviews working-tree changes.
    required: false
    default: ""
  task:
    type: string
    description: What to review for.
    required: true
*/

phase("Find what changed");
const changed = await git.changedFiles(args.base || undefined);
if (!changed.length) return { conclusion: "nothing changed" };

const reviewer = agent("Reviewer", { system: "You review code for defects…" });
const findings = await reviewer.ask<Findings>(`Review ${changed.join(", ")}…`);
report(findings);
await artifact.file("review", "out/review-sweep/review.md", { title: "Review", primary: true });
return { conclusion: findings.headline };
```

The header is a comment — nothing parses the workflow *for* it. The kit parses
it *before* running: the description and `whenToUse` become the routing
registry's problem shape, and `args` becomes the argument contract
(`kit workflows run` rejects unknown or missing arguments before the first
model call). Both are plain YAML-ish text; the convention is documented, not
enforced, so a workflow with no header still runs — it just can't be routed to
or auto-arg-checked.

## The surface

Everything a workflow can touch. Anything not on this list is unavailable, and
that is the feature.

| Surface | What it is |
|---|---|
| `agent(name, persona?)` | Creates a named agent. `persona` is a string or `{ system }`. |
| `agent.ask<T>(instructions)` | One turn of that agent's work. With `T`, the result is parsed and shaped to the interface `T` describes; without, free text/JSON comes back. |
| `args` | The run's arguments, validated against the header. |
| `phase(name)` | Marks a stage; shows in the run's journal and in `kit workflows` output. |
| `log(message)` | A line of narration for the run log. |
| `report(item, artifactId?)` | Publishes a structured finding from the run — a review finding, a diagnosis, a confidence-weighted claim. |
| `artifact.file(id, relPath, opts?)` | Records a workspace file (e.g. `out/review-sweep/review.md`) as a versioned deliverable of the run. |
| `artifact.markdown(id, text, opts?)` | Same, for generated markdown that has no source file. |
| `files.glob(pattern)` | Workspace-relative file list (`src/**/*.ts`). Pattern syntax: `**` crosses directories, `*` stays inside one segment, `?` is one character, everything else is literal — no brace alternation, so `**/*.{ts,js}` matches nothing; glob then filter. |
| `files.read(rel)` | A workspace file's text. |
| `files.grep(pattern, glob?)` | Regex over workspace files: matching lines with paths and line numbers. |
| `git.changedFiles(base?)` | Changed paths (`base` empty/absent → working tree). |
| `git.diff(base?, rel?)` | The diff. |
| `git.status()` / `git.log(n)` | Short status / recent log. |
| `world.run(cmd, args?, opts?)` | Runs a command in the workspace. The workflow's one effect primitive. Returns `{ exitCode, stdout, stderr }`. |
| `world.remember({kind, fact, part?})` | Records a fact about the run in its fact store. The coordination layer's write. |
| `world.facts(opts?)` | Reads the store unscoped — every part's facts, optionally narrowed by `kind` or `part`. The plane's own read. |

`files.*` and `git.*` are synchronous; `world.run` and `agent.ask` return promises.
Writing `await` in front of the sync ones is harmless and matches the examples,
so the whole surface can be read as one style.

### Agents

An agent is a conversation with a model, plus tools. Each `ask` runs a
tool-calling loop: the model reads files, searches, writes files, and runs
commands until it calls `submit_result`. With a type argument, `submit_result`
carries the JSON schema parsed from the workflow's own interface text, so a
`verdict: "supported" | "refuted"` field really is constrained, not just
requested. Without one, the model answers in prose and the workflow decides.

The type argument is recovered from the file text, not from the TypeScript
compiler: the engine rewrites each `ask<T>(…)` call site to carry the schema it
parsed out of the interface `T` names. TypeScript erases type arguments at
runtime, so this is the one place the runtime looks at your code as text. If a
type can't be parsed, the ask degrades to lenient JSON and the run logs a
warning — one unsupported type never fails a workflow.

Concurrency is ordinary `Promise.all`: five scouts in parallel are five
`ask`s in one `await`, and the journal shows them interleaved under one phase.

### The run's fact store

An agent's knowledge at dispatch is only what the plane pushed: its brief, its
contract, its own tool results. Everything else about the run — the pinned
stack, the verdict on this part, a sibling's status — was unreachable, so a
question the plane could answer in one line cost a tool round, an escalation,
or a guess. The fact store closes that, and two rules make it safe:

- **Coordination facts only.** A fact is something the plane decided or
  measured, never a part's content. A sibling's built work is not a fact an
  agent may ask for — that boundary is code, not a prompt.
- **Declared kinds, not free text.** A fact is a journaled row with one of
  `task`, `stack`, `environment`, `decision`, `verdict`, `status`, `phase`. An
  unknown kind is refused by name rather than absorbed as prose.

Two readers, one difference. `world.facts()` is the plane's own read and sees
every part's facts — the scope hides a sibling's facts from the agents that
build the parts, not from the layer that dispatched them. An agent reads
through the `recall` tool, which sees the run's public facts and its own part's
and nothing else. An agent built with `scope: { part }` gets that view; naming
a sibling part in a call is refused by name and journaled. `remember` is
deliberately not on the agent surface: a model that could write run facts could
rewrite the run's own record of itself.

Both caps record what they held back rather than dropping it silently — 40
facts and 8KB, with a truncation line telling the reader to ask for one kind at
a time. Every recall is journaled with the fact ids it returned and the byte
count, so what an agent was shown is auditable after the fact.

The push rule: a fact known at dispatch belongs in the brief. The store is for
what comes after — the verdict that arrives mid-run, the status that changes,
the phase the run moved into.

### Editing, not rewriting

`write_file` replaces a whole file, so a part that touches one line of a
400-line file regenerates the other 399 from the model's memory — it truncates,
it drifts, and nothing in the workspace says which of the two happened.
`edit_file({path, old_string, new_string})` is the surgical alternative: the
`old_string` must be present exactly once, and a zero match or a second match
fails with the count named rather than rewriting the wrong lines. The
replacement is interpolated literally, so `$&`-shaped text lands as written.
A refused edit journals its own line — a fired line followed by silence would
read as an edit that landed when the file never changed. It rides the same
`workspace-io` grant as every other file tool.

### What agents cannot do

- **Reach outside the workspace.** Every file tool resolves against the run's
  workspace root; an escaping path is refused. Agents cannot read the roster,
  the `.env`, or anything under `$HOME` by accident or on purpose.
- **Run an arbitrary command.** `world.run` takes a fixed argument vector —
  there is no shell, so no `&&`, no globs, no command substitution. The
  executable must be on the run's allowlist
  (`npm`, `npx`, `node`, `git`, `pnpm`, `yarn`, `make`, `python3`, `pytest`,
  `cargo`, `go`, plus whatever `kit workflows run --allowCmd` adds). Output is
  capped per stream and a run is killed after five minutes.
- **Call the network as a first-class tool.** There is no `fetch` tool. A
  workflow that needs a document can still have an agent reach it through an
  allowlisted command (`node -e 'fetch(…)'`), save the result into the
  workspace, and then read it — which is what `research-report` does. The
  distinction matters: the network is a workspace side effect with an audit
  trail in the journal, not an ambient capability the workflow grew by accident.
- **Talk to the router directly.** Agents never pick their model; every call
  goes through the router at the run's `baseUrl`, so a run is metered in the
  same usage ledger as every other request and inherits failover.

### Escalation

An agent that hits a genuine blocker calls `escalate` with a question and what
it already checked. The run answers it from `--answers` (a JSON map matched
against the question) if the caller supplied one; otherwise the agent is told
no owner is available and must proceed on its best judgment and say so in its
result. The question, the evidence, and the answer are all in the journal.

### What a run leaves behind

Every run gets a directory under `~/.agnostic-router-kit/workflow-runs/`
(`$AGNOSTIC_ROUTER_KIT_HOME/workflow-runs` if set):

```
<timestamp>-<name>/
  module.mts        the exact code that ran (transformed, for replay)
  run.jsonl         every phase, report, tool call, command, escalation
  summary.json      duration, phases, agent/tool counts, artifacts, result
  artifacts/<id>/v<n>/<file>    each deliverable, versioned
```

`artifact.file` versions by content: re-writing the same path in a later round
produces `v2`, so the run's history of what the deliverable looked like is
recoverable. A workflow's `return` value becomes `summary.result`, and `report`
items are counted and journaled — that's the signal the swarm's gates consume
(Phase 3).

## Rules for a workflow that runs here

These are the rules that make the portability claim true. Breaking one means
the workflow runs on your machine and nowhere else.

1. **No absolute paths.** Workflow code sees the workspace as its root and
   refers to everything relatively. `kit workflows run --workdir` decides what
   that root is; the workflow never gets a vote.
2. **No vendoring-by-reference.** If a workflow depends on a skill tree, a
   rubric, or a checklist, that content lives inside the repo (under
   `workflows/`), and the workflow refers to it by a path relative to itself or
   by an argument. There is no `~/.agents/skills` in this edition.
3. **Don't shadow the surface.** `agent`, `files`, `git`, `world`, `artifact`,
   `args`, `phase`, `log`, `report` are globals. `const files = await
   files.glob(...)` is a runtime error; name the local `allFiles`.
4. **Return something.** The `return` value is the run's result. A workflow
   that ends without one returns `null` and `kit workflows last` says so.
5. **Keep asks narrow.** An ask is a delegation with a result shape, not a
   chat. Long agent personas and small typed asks compose; one giant "do
   everything" ask cannot be reviewed by anyone, including the workflow.

## Running one

```
kit workflows list                              # what ships, and what it takes
kit workflows run review-sweep \
  --args '{"task":"review the auth refactor for correctness"}' \
  --workdir ~/code/myapp                        # where the workspace is
kit workflows last                              # the most recent run
```

Optional flags: `--model` (a router profile or `provider/model`; default
`hard`), `--allowCmd <exe>` (repeatable, extends the allowlist), and
`--workdir` (the workspace; defaults to the current directory). The router base
URL and token come from the roster, so a run targets the same router the rest
of the kit talks to — set `router.port` in the roster to point elsewhere.

`auto` is the wrong model for a workflow run: it can route a worker's call to a
swarm verdict, and a swarm inside an agent call inside a workflow is not a
shape anything can review. `hard` (the default) keeps every call a single
completion with tools.

## Where the code lives

- `lib/workflow/engine.mjs` — loading, the surface, the agent tool loop, the journal.
- `lib/workflow/tools.mjs` — the workspace tool definitions and the caps.
- `lib/workflow/harness.mjs` — the harness block, the dispatch gate, and the run's fact store.
- `lib/workflow/schema.mjs` — interface text → JSON schema; ask-site annotation.
- `lib/workflow/meta.mjs` — the metadata header, the argument contract.
- `lib/workflowlib.mjs` — reads `workflows/`, builds the routing registry.
- `lib/cli.mjs` — `kit workflows list|run|last|watch|graph`.

## Judgment events

Every judgment event a workflow makes routes through sys1 — the same rule the
router's judge and the swarm's gates follow. The shapes:

- **Bounded classifications** call `sys1.classify(taskSpec, text)` — an inline
  task_spec POSTed to the local gateway (`SYS1_URL`, default
  `127.0.0.1:8400`; bearer from `SYS1_BEARER_TOKEN` when the service demands
  one; `provider` from `SYS1_PROVIDER`, default `core`). Fail-open by
  contract: `{ok:false}` on transport trouble and the workflow applies its own
  fallback — a gate outage never stops a run. Calls log into sys1's own JSONL
  store (`log: true`) so per-head floors can be fitted from real rows.
  **dev-decisions first**: a judgment the dev-decisions CLI can carry (rows in
  the shared calibration store, dispositions, fitted floors) composes
  dev-decisions rather than raw sys1 — evidence verification already does,
  and new classification heads should grow dev-decisions ops over time, with
  raw sys1 classify as the recorded fallback.
  First user: adversarial-solve's `part_atomicity` head, which gates every
  part before a builder spends rounds on it — a multi-concern verdict (or a
  low-confidence atomic one) splits once via the part's own author; sub-parts
  are gated and dispatched (depth one).
- **Evidence verification** — a claim over produced work — runs the
  `dev-decisions evidence-gate` CLI through `world.run` (launch with
  `--allow-cmd dev-decisions`). One holistic criterion per gate; exit 0 and 1
  are verdicts, anything else is fail-open. dev-decisions imports the sys1
  library in-process and posts to the provider APIs directly with per-provider
  keys from `~/.config/dev-decisions/env` — it never touches the HTTP gateway,
  and its routing lives in `~/.config/sys1/config.toml` `by_task`.
- **Long-context generations** — compare these solutions head to head,
  integrate these parts — are agent asks, deliberately not sys1: a bounded
  classifier is the wrong shape for them. When a judgment point skips sys1,
  state the exception rather than leaving it unasked.
- **Deterministic checks** (round caps, journal heuristics, counting) are
  code, never the model.

A builder ask that exhausts its tool rounds is treated as a decomposition
signal, not a failure: the same builder — the only agent that knows its own
progress — splits the remaining work into gated atomic sub-parts, or reports
itself stuck (zero parts) and the run escalates. Depth is one; a sub-part
that caps again fails the run loudly.

## Known limits (and the roadmap)

- **No resume.** A failed run leaves its journal and artifacts; it does not
  restart from the last phase.
- **Ten workflows ship.** The other workflows in the wider library port by the
  same rules — vendor the skill tree they read, relocate their references, add
  them under `workflows/`; the registry rebuilds itself on the next
  `kit apply`. That is wave two, tracked separately.
- **The runtime is deliberately not a general task queue.** It runs workflows,
  one at a time, on one machine, against one workspace. Anything that needs
  more than that belongs in a harness, not here.
