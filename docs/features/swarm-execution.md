# Feature: The swarm

> Contract: `FUNCTIONAL-SPECIFICATIONS.md` § Core Features ("Swarm execution"),
> § Failover & Degraded States. Implementation: `router/swarm.mjs`, wired into
> `router/server.js`'s forward path.

## Purpose

A **swarm** is the router executing a decomposable task itself: the judge sees
that the request splits into several substantial independent parts, and instead
of one call or one parallel comparison, the router decomposes the request,
builds the parts in parallel across an independent worker pool, gates each part
before integration, merges the survivors, and cold-reads the merged answer
before delivering it.

The design rule underneath it: **every part is an atomic unit** — small enough
to be completed as one standalone completion by one worker that sees nothing
but the original request and its own instruction — and the swarm is just many
such units orchestrated in parallel and assembled once, at the end. The
decomposer is contractually responsible for the atomicity: a part that needs
more than one completion's worth of output gets split further, never handed to
a worker whole.

It exists because a harness with no runtime of its own still deserves parallel
execution. Without it, "several independent workers" is something only a host
process can do, and a minimal client gets one call and an apology. With it, the
same request handled by a full agent harness and by a bare HTTP client gets the
same shape of work.

The accept/revise decisions are the interesting part. A naive swarm asks the
model "is this part good enough?" — which means the gate is only as good as a
prompt, and nothing learns. Here the gates are **not** model calls at all: they
run the `dev-decisions` CLI, which judges each acceptance criterion against
tagged evidence through its own classifier stack and appends the row to the
shared calibration store in its own schema. The router makes no quality
judgment of its own.

## Triggering it

Nothing to configure beyond the roster. The judge's execution question offers
`single` / `mixture` / `swarm`, and a swarm verdict routes `forward()` into
`swarm.handle()` instead of a tier call. A request that genuinely decomposes —
"design the API, the concurrency model, the persistence strategy, and the test
plan" — routes swarm; a single hard question routes single, because decomposing
it would only produce four descriptions of the same confusion.

## The pipeline

```
decompose ──► build (parallel) ──► gate each part ──► integrate ──► cold read ──► deliverable gate ──► response
                     │                    │
                     └── too few parts    └── part still fails → dropped
                              │
                              └── fewer than 60% build → one tier call
```

| Stage | Model | Notes |
|---|---|---|
| `swarm:decompose` | the judged tier's target, reassigned down the pool on failure | 2–8 parts, each with a stable id, a title, a self-contained instruction, and 1–4 acceptance criteria |
| `swarm:build:<id>` | the worker pool, one part each | round-robin start; a failed or timed-out worker's part is reassigned to the next comparable model in the pool (`swarm:build:<id>:failover2` in the ledger) |
| `swarm:part:<id>` gate | `dev-decisions evidence-gate` | ONE holistic criterion per part — "the part fully satisfies its instruction and acceptance criteria" — with the part text as its evidence; granular criteria steer the worker prompt, the gate decides accept/revise/drop |
| `swarm:integrate` | `routing.swarm.integrator` → `mixture.aggregator` → worker 1 | merges survivors, drops cross-part duplication |
| `swarm:cold-read` | worker 1 | blind to how the answer was built; returns gaps as JSON |
| `swarm:deliverable` gate | `dev-decisions evidence-gate` | the cold read's gaps become the criteria; one bounded repair round |

Every model call is requested as a **stream**. That is not a presentation
choice: with `stream: false` an upstream sends nothing until the whole
completion exists, and a thinking-heavy worker can sit silent for minutes —
straight into the fetch stack's ~5-minute headers timeout, which kills the
connection and masquerades as provider instability. With SSE the first bytes
arrive immediately and a long generation holds the connection open. The same
reassignment logic covers whatever genuinely does fail.

Every one of those calls is metered with `execution: "swarm"` and a
`swarm:<stage>` reason, so the ledger shows swarm spend per stage. The response
reports the merged answer's own usage and invents nothing on top of it.

## Reading the ledger and the journal

`router/logs/router.log` carries one JSON line per stage:

```json
{"event":"swarm","stage":"decompose","parts":4,"titles":["Public API and error types","…"]}
{"event":"swarm","stage":"build","built":3,"of":4}
{"event":"swarm-gate","label":"part-p3","verdict":"not-supported","output":"Evidence gate: plan-part-p3.md vs evidence-part-p3.md (provider=drex, 839 ms, 4 judged, 0 without evidence)\n    C0: SUPPORTED (sufficiency=0.99, consistency=0.97) …"}
{"event":"swarm","stage":"gate","accepted":3,"report":[{"id":"p1","state":"dropped","reason":"…"}]}
{"event":"swarm","stage":"done","parts":4,"accepted":3,"dropped":1,"repairs":0,"ms":412000}
```

The gate rows also land in the shared dev-decisions store with
`op: "evidence-gate"`, a verdict, and an `input_sha256` — the same store the
machine's other gates feed, which is what lets a `disposition` later grade
these gates like any other.

### The swarm's fact store

Each request gets one fact store — the same one the workflow runtime uses
(`lib/workflow/harness.mjs`) — and it records what the swarm decided: the
request, the decomposition, each part's atomicity verdict, each part's status
(dispatched, accepted, dropped), and the deliverable verdict. It lands in the
router log as `run-fact` lines alongside the `swarm` ones:

```json
{"event":"run-fact","op":"remember","factId":"f3","kind":"verdict","part":"p2","chars":31,"text":"atomicity: atomic (0.91)"}
{"event":"run-fact","op":"remember","factId":"f8","kind":"status","part":"p2","chars":9,"text":"dispatched"}
```

The swarm's workers are bare completions with no tool loop, so they cannot
*recall* — what a worker knows is what the swarm pushes into its prompt. Each
worker receives the facts about its own part (its atomicity verdict, its
dispatch status) appended to its build brief. No worker sees another's. That is
the same push rule the workflows follow, applied where the pull half does not
exist: one store decides what a worker is told, rather than each call site
assembling its own context.

## Degradations

All metered, all logged, none silent. A swarm that cannot run as a swarm falls
back to a single tier call rather than failing the request:

| Condition | Outcome | Reason |
|---|---|---|
| tool definitions or tool messages in the turn | one tier call | `swarm:skipped-tools` |
| fewer than 2 parts, or decomposition fails | one tier call | `swarm:no-decomposition` / `swarm:decompose-failed` |
| fewer than 60% of parts build | one tier call | `swarm:build-degraded` |
| every part dropped by its gate | one tier call | `swarm:all-parts-dropped` |
| integration or cold read fails | one tier call | `swarm:integrate-failed` |

The partial-build rule is deliberate. Integrating one of four parts produces an
answer that covers a quarter of the question and says nothing about it — which
is worse than one strong call that covers all of it.

A missing or erroring gate CLI is a different case: the part is accepted with
the failure recorded in the journal. An unavailable gate must not hang a
request, and it must not silently pass everything either — the journal says
which happened.

## What the swarm is not

Not a task queue, not a durable job, and not resumable — one request in, one
response out, in the same process that routed it. If the router restarts, the
swarm restarts from the next request. There is no per-part retry policy beyond
the one bounded revise round; a part that still fails its gate is dropped and
reported, and the deliverable is what survived.
