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

### Handing one concern to a sub-agent

`delegate({task, contract})` is how an agent keeps its own context on the part
it was dispatched for. It spawns a real agent of the run — same grants, same
workspace, its own empty conversation — with `SUBAGENT_SYSTEM` as its system
prompt, and returns the child's answer to the caller. The child's contract,
its agent lines and its tool calls are journalled beneath the parent's label
(`Coordinator → delegate`), and the child's asks and tool calls are added to
the parent's stats, because delegation is a budget transfer rather than a
fresh allowance.

Two facts make it bounded rather than a hierarchy:

- The `sub-agents` capability is off by default. A run that did not ask for it
  refuses the call, and the refusal names the capability — the same journal
  line the fired call would have written.
- The depth cap is one, and it is a property of the surface rather than a rule
  in a prompt. A child receives `childSurface()`, which has no `delegate`
  definition, no implementation and no spawner; a parent descriptor arriving
  with depth already set is refused too. There is no prompt a model can talk
  its way past, because the tool is not there to call.

A `delegate` worth dispatching is one self-contained concern — a lookup, a
single file, one decision — stated fully, because the child sees none of the
parent's context. Handing over the whole task is not delegation, it is a
context split with extra steps.

### Commands that outlive a tool round

`run_command` is synchronous because most commands are, and its five-minute
kill is the right default for those. A ten-minute test suite is the case that
shape cannot serve: the round dies while the work is still running, and the
agent's only evidence is a timeout. `start_command`,
`poll_command` and `stop_command` are the same command with the round handed
back:

- `start_command` returns a handle immediately. It runs the same gate
  `run_command` does — the executable allowlist, the capability the command is
  classified under, and the install policy for a dependency-changing subject —
  because backgrounding one is not a reason to forget why the synchronous path
  would have refused it.
- `poll_command({handle, offset})` reads the output printed since that offset.
  Every call returns the offset to read from next, so polling is a stream
  rather than a re-read: an agent that polls a ten-minute suite reads what is
  new each time instead of re-reading everything. A command held back by the
  one-poll byte cap says so (`truncated`) and the offset moves with the
  truncation, so nothing is skipped. When `running` turns false, `exitCode` is
  how it finished, and a null one with a `signal` means it was killed.
- `stop_command({handle})` ends one early, and is idempotent — stopping a
  command that already exited reports that, with its exit code, rather than
  failing.

Every background command has a lifetime cap (15 minutes, the ceiling for any
process the run starts) and a dev server still defaults to its own tighter
five. Stop is a request, not an event: the exit code belongs to the poll that
follows it, because a SIGTERM'd child has no exit code to report and the
signal is the reason. The journal carries all of it as `service` events —
`start`, `exit`, `stop`, `lifetime-expired` — with the command, the lifetime
and the exit code or signal.

The plane gets the same three as `world.command.{start,poll,stop}`, for a
workflow that needs one long-running command on its own account.

### A part that fails takes its tree with it

Parts write straight into the workspace — there is no per-part git worktree and
no copy-on-write sandbox — so before this, a part that failed mid-build left its
half-written files exactly where the champion was about to integrate them. The
plane now checkpoints a part's own declared paths before it builds and restores
them when the part fails, so a doomed part's tree is indistinguishable from the
workspace that existed before it ran.

- `buildUnderCheckpoint(world, {label, paths}, build)` runs a build under that
  checkpoint: the snapshot is taken first, and a throw from the build rolls the
  snapshot back and rethrows. `build` receives the checkpoint as well, because
  the other failure path is the caller's decision: a report that does not check
  out against the part's contract (the dispatch gate's result check) means the
  plane cannot tell a file the part wrote from one it claimed, so the caller
  rolls the same snapshot back itself and tells the champion what was rolled
  back rather than handing it paths that are no longer there.
- The snapshot covers the part's declared paths and nothing else. The parts of
  one champion build concurrently into one namespace, so a wider snapshot would
  restore over a sibling's work; the exclusive ownership `validateContract`
  enforces is the same ownership a rollback restores to. A path no part declared
  is not the rollback's to delete, so what it cannot clean is reported rather
  than removed.
- A rollback is exact: a captured file is written back byte for byte, a path that
  did not exist and now does is removed, a path the snapshot could not hold (the
  byte cap) is left alone and counted. A second rollback of the same checkpoint
  is a no-op, because a part can be rolled back twice — its own and its parent's
  — and the second must not invent damage.
- An escaping path is refused at both ends: a snapshot is a write waiting to
  happen, so a path outside the workspace never enters one.

The journal carries `checkpoint` (the take: how many paths, how many bytes,
whether the byte cap was exceeded, or the refusal) and `rollback` (the restore:
restored, removed, uncaptured, left). The plane exposes them directly as
`world.checkpoint` and `world.rollback`; `workflows/checkpoint-probe.ts` drives
all three shapes — a part that throws, a part rolled back by its caller, and a
survivor building while its neighbour fails — with no agent dispatched, and
asserts the workspace on disk afterwards.

### What an ask costs, and what survives when it costs too much

Rounds measure how stubborn an agent is; tokens measure what its history costs,
and a provider's context window is a number rather than a count. The runtime
accounts for both, per ask.

- Every model call's prompt and completion tokens come from the upstream's own
  usage block (the final chunk of a streamed completion), not from an estimate —
  a workflow run is already metered in the router's ledger, and the run journal
  now says the same thing. A provider that reports no usage gets the plane's own
  four-characters-a-token measure instead, and the run's summary counts how many
  calls were measured rather than reported, so a budget built on the totals can
  see which part of them is a report and which is an estimate.
- Each ask journals an `account` line: its prompt and completion tokens, its
  tool rounds, and whether it was compacted. The tokens are the sum across the
  ask's calls, because every round resends the whole history — that is what the
  ask cost — while an agent's own `stats.promptTokens` / `completionTokens` /
  `compactions` are readable from the workflow, and a delegated child's land on
  the parent's the way its asks and tool calls already do: delegation is a
  budget transfer.
- When a prompt crosses the line (`--compact-tokens`, default 120k) the plane
  compacts the history instead of letting the ask die at the provider's window.
  What survives is decided by rule rather than by the summary: the system
  message and the brief the plane wrote — instructions, the rendered contract,
  and the run's measured facts — are kept verbatim, because they are the
  plane-owned part of the history and the agent has no way to rebuild them.
  Everything else becomes one summary, from exactly one deterministic ask
  (temperature 0, no tools, no schema) whose own input is capped with the oldest
  turns dropped first. If that ask fails, the history is truncated with a marker
  rather than the ask dying — a rescue must not become a new failure mode.
- The journal carries `compact` (the size that crossed the line, the size after,
  how many messages were summarized, how many were kept, whether the history was
  summarized or truncated, and how many were too old to summarize) alongside the
  `account` lines, and `kit workflows watch` renders both.

`workflows/tokens-probe.ts` drives both halves with real model calls: a
`--compact-tokens 3000` run compacts the agent mid-ask, and both asks must still
answer the calibration token and the acceptance criteria that live only in the
brief and the contract.

### What an ask may spend, and what happens when it runs out

A ceiling is a shape's policy, not the caller's, because the plane knows what
each kind of ask is for. An agent declares `shape: "build"` (the default) or
`shape: "verify"`, and may tighten its own line with `budget: { rounds, tokens }`.

- A build ask keeps the run's `--max-rounds` and a token ceiling of 2M prompt
  tokens. The round cap catches stubbornness; the token ceiling catches cost,
  which the round count cannot see — every round resends the history, so the
  sum grows quadratically and an operator who raises `--max-rounds` raises the
  bill with it.
- A verification or loop-shaped ask draws a smaller line on both axes: 12 rounds
  and one window's worth of tokens. Trouble in a verdict shows in the first few
  rounds, so waiting longer costs tokens and changes nothing. `--max-rounds`
  does not apply to it; a caller that needs a different line tightens it at the
  ask.
- What happens at the line is the difference the shape is for. A build ask throws
  with its round count — that is the error `adversarial-solve`'s cap recovery
  matches, because a part that was merely too big should decompose. A
  verification-shaped ask has nothing to decompose (splitting a verdict in half
  does not produce two verdicts), so the plane escalates with the `stuck` topic
  and ends the ask: an operator's `--answers '{"stuck":…}'` reaches it, and an
  ask that cannot verify never hands back a result that could be mistaken for a
  verdict.
- Both axes are checked before a round rather than after, the same place
  compaction is: an ask that has already spent its ceiling does not get another
  round on top of it. The journal carries `budget` (the axis, what was spent, the
  shape whose line it was), the `escalation` with topic `stuck`, and the
  `account` line now naming the ask's shape and its line.

`workflows/budgets-probe.ts` drives both axes of both shapes with real model
calls, using tightened lines rather than a model's willingness to loop:
`budget: { tokens: 1 }` makes the cap unavoidable at the second round's check
whatever the model does, and one negative control settles inside a tight line to
prove a ceiling is not a trap.

### What happens when one member of a set fails

A parallel set is a failure domain. A champion that runs out of budget, a part
whose builder could not build, a member that throws before it starts — each is
that member's failure, and the plane settles the set rather than letting one
member's ending take the others' with it.

- `settleMembers(members, { minimum })` runs every member, however the others
  end, and then reports the set three ways over the same runs: `survivors` and
  `failures` split it by outcome, `outcomes` keeps the declaration order so a
  caller can label each member in its place, and `enough` is the only judgment
  the plane makes — whether what survived meets the minimum. A member with no
  `run()`, and one whose `run` throws before returning a promise, are that
  member's recorded failure like any other; neither reaches a caller's catch.
- The minimum is the bar for the *next* step, and it is declared by whoever
  dispatched the set. A competition needs two entries to be a comparison, which
  is why `COMPETITION_MINIMUM` is 2: crowning a lone survivor by default is a
  different claim from having won. A parallel build needs one part for the
  champion to carry on integrating, so the same settlement settles parts at
  `{ minimum: 1 }`. The number is the plane's, so a workflow that fans out to a
  single champion is saying the comparison it cannot make.
- Below the bar, the caller degrades honestly. With one survivor there is no
  head-to-head to make, so no judge is asked and the delivered entry says it was
  the only one that survived — "still standing" rather than "winner". With none
  there is no winner to name, and the run reports that rather than crowning an
  empty set.
- The run's own record is not flattering about any of it: each failed member is
  remembered as a status fact with its reason, and a failed champion becomes a
  high-severity finding, because the operator needs to know the competition they
  asked for did not fully happen.

`adversarial-solve` settles its champions at the competition minimum and its
parts at one, and reads `compared` off the settlement rather than recounting
survivors — the threshold for a head-to-head lives in exactly one place.
`workflows/competition-probe.ts` runs a competition in which one champion dies
before it spends a model call and asserts the two survivors are still judged, a
lone survivor is delivered without a comparison being asked of it, a set with
nothing surviving names no winner, and a member that cannot even run is recorded
as its own failure.

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

The runtime is one npm package, `workflow-plane`, living in `lib/workflow/` —
its own `package.json` with `type: module`, one `exports` entry per module, and
zero runtime dependencies. Nothing outside the package reaches into it by a
relative path: every consumer imports it by the package specifier. In the engine
edition those are `lib/cli.mjs`, `lib/workflowlib.mjs`, `router/server.js` and
`router/swarm.mjs`; in the kit they are `lib/cli.mjs` and `router/server.js`.
The package's internal layout is therefore a detail only the plane knows, and a
consumer's import never changes when the plane grows a module.

Two consumers, one copy. The engine edition resolves `workflow-plane` through
its own `node_modules` symlink onto `lib/workflow/`, which is the authoritative
source. The kit resolves it as a `file:` dependency on that same checkout — the
second hand-maintained copy is gone — and `kit apply` ships it beside the router
as a set of files derived from the package's own exports rather than a written
list. A run served by the installed runtime therefore reads the same modules a
run in the development checkout does, and `tools/check-plane.mjs` is the check
that this stays true: it fails the moment the kit's resolved package and the
engine checkout diverge.

### The module map

| Module | What it owns |
|---|---|
| `engine.mjs` | The orchestration surface: `runWorkflow`, the agent factory, the ask loop, `answerEscalation`. |
| `harness.mjs` | The harnessed agent control plane's assembly: the harness block, the dispatch gate, the run's fact store. |
| `tools.mjs` | The workspace tools a workflow's agents may use, and the journal that records them. |
| `transport.mjs` | The plane's only external protocol: one chat completion over the router, streamed, behind an idle cap. |
| `context.mjs` | What a run may spend, and what happens when it has spent it: budget resolution, token accounting, context compaction. |
| `runstate.mjs` | The state a run owns: its name, where it writes, its artifacts, and the error type it fails with. |
| `services.mjs` | The harness services a real runtime gives its agents, as pure capped functions: install policy, bounded fetch, dev servers, format hooks. |
| `schema.mjs` | TypeScript type text → JSON schema, for the workflow runtime's typed asks. |
| `coerce.mjs` | Model answers → the shape the workflow declared. |
| `meta.mjs` | The workflow file's metadata header and the argument contract. |
| `events.mjs` | The shared journal-event normalizer both editions' CLIs and servers read. |
| `graph.mjs` | The orchestration graph builder: plan → criteria → phases → runs → recap. |
| `checkpoint.mjs` | Per-part checkpoints: the workspace isolation the swarm never had. |
| `gitworld.mjs` | The workflow's view of a repository: status, diff, log, changed files. |

`lib/workflowlib.mjs` reads `workflows/` and builds the routing registry from
what it finds. `lib/cli.mjs` is `kit workflows list|run|last|watch|graph`.

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
