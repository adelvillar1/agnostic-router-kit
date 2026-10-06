# the chat surface and the agent control plane

*From the [install-and-bot-surface plan](../plans/2026-10-06-install-and-bot-surface.md). `router/chat.html`, `router/setup.html`, the `/api/keys` · `/api/setup` · `/api/agents` endpoints, and the plane's `awaitOwnerMs`.*

Two pages the router serves itself, both hand-written and self-contained (the dashboard's stated convention: no CDN,
no build step, no framework), both token-stamped at serve time and gated like every other route. The design rule that
shaped all of it: **the pages derive nothing.** The router computes readiness, attention and verdicts; the pages render.

## /chat — the bot interface and the control plane in one screen

Left: a conversation with the router itself — `model: "auto"`, streamed over `/v1/chat/completions`, the routing
verdict shown under each reply from the `x-router-workload` / `x-router-execution` / `x-router-failover` headers.
Typing `/run <workflow>` starts a plane run from the same input box; the run's phases, tool calls and reports stream
into a live card in the thread over the same SSE endpoint the dashboard uses.

Right: the **Agents rail** — every token holder the router knows about (the operator, and each roster app with its
grant ceiling and workspace), live or idle, runs expandable to their journal tails. When a run has an escalation open,
the question surfaces at the top of the rail with an answer box and Approve / Skip; the answer goes through the run
API's answers route and the run resumes mid-flight.

## The owner wait — what makes an in-the-moment answer possible

Escalations resolve at fire time through a ranked ladder (declared answer → live `answers.jsonl` → substring matches →
`askOwner` → "no owner available"). Over the run API, `askOwner` never existed — so every escalation resolved in about
a millisecond and **no human could ever answer in the moment**; the control plane's approval card would have been
undefinable. The plane gained `awaitOwnerMs`: a spawner that opts in holds an unanswered escalation open, polling the
live answers file until the deadline, then degrades to the recorded no-owner answer. The run API passes it through
(capped at 24h, default 0 so existing callers change nothing); the chat page opts in at five minutes. Resolution
reports `source: "live"` into the journal, so the record says the human answered, not that nobody did.

The escalation normalizer now carries `op` / `source` / `matched` too — it dropped them once, which made every
answered escalation look pending to the live surfaces.

## /setup — the guided half in the browser

`kit quickstart` owns the machine-level steps; this page owns the judgment half:

- **The checklist** (`GET /api/setup`) — roster present, keys resolve, at least one tier routes, the judge can decide
  (with a live sys1 health probe in non-typesafe modes), first request routed (read from the usage ledger). Each step
  carries `{done, detail, hint}` and the page polls until `ready`.
- **Key entry** (`POST /api/keys`) — write-only by contract: `{"keys": {NAME: value}}` merges into the runtime `.env`
  line-wise (comments and untouched keys survive), atomic rename, mode 600, env cache invalidated. The response carries
  `configured` booleans and never a value.
- **Connect an agent** — mints an app token (`crypto.randomUUID`), writes the roster through `PUT /api/roster`, and
  hands the user the three lines a harness needs: base URL, token, `model: auto`. The new agent appears in the chat's
  rail immediately, with its ceiling doing exactly what ceilings do.

## Security shape

The whole `/api/` block is operator-class: an app token gets 403 from the roster, the keys endpoint, and everything
else behind the gate (before this wave, a token with an empty `grantCeiling` could rewrite the roster and shell out to
`kit apply`). Apps act through `/v1`, scoped by ceiling, workspace root and run ownership. The page shells are
token-stamped at serve time — the same trade the dashboard documents: same-origin operator convenience, local-only
listener, the proxy routes keep their gate.

## The look

Both pages share one design language ("precision instrument"): near-black light-adjacent themes with hairline borders, a
single electric-cyan accent, amber for anything needing a human, mono for data, serif for the greeting voice — no CDN,
no build step, no webfonts; the platform's own type families carry it. Replies render as markdown (escape-first, the
only tags on the page are the ones the renderer writes), with the verdict as a quiet mono footer under each reply —
workload, execution, tokens, latency. Agents read as identities (a stable hue per name) rather than rows. Both themes
are first-class; `prefers-reduced-motion` is honored.

Captured states live in `docs/screens/` — the welcome (dark/light), a demo conversation, the live escalation card,
and setup pending (dark/light). `tools/visual/probe-visual.mjs` (Playwright) reproduces all of them against a scratch
runtime, including a **real** escalation: it spawns `http-probe` with an owner wait and catches the attention card
while it is genuinely open. `chat.html?demo=1` renders a fully synthetic, badged conversation — the visual fixture,
touching no endpoint. (The probe also refuses a port that already answers: it once found an orphaned router from a
preflight test squatting there, and would have photographed a stranger.)

## Verification

`tools/probe-keys-endpoint.mjs` (30 checks) and `tools/probe-chat-surface.mjs` (14 checks) drive a scratch runtime
rendered by the kit's own `kit apply --only router`, zero model calls — the gate matrix, the write-only contract, the
checklist shape, the watcher/writer visibility agreement, and the full escalation round trip: attention shows the open
question, the live answer resolves it `source: "live"`, attention clears.
