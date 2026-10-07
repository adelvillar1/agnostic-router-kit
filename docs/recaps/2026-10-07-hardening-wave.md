# Recap: the hardening wave — 2026-10-07

**Plan:** `docs/plans/2026-10-07-hardening-and-mausbot-lessons.md` (status: completed). Source: the morning's deep dive of this repo and OpenMausBot; the defects were verified by reading the code before the plan was written, and every plan line-anchor was checked against production the same day.

## What landed

- **P0 — the defect list**: the duplicated `/route` handler, the duplicated `/api/state` keys (array-honest, with probe assertions), the chat `/run` `Object.keys` bug (every `/run <name>` bounced — a live bug the duplicate keys had been hiding), the swarm docstring, the dashboard's roster round-trip (`hasKey`/`id` stripped at `applyRoster`, tracked roster cleaned), and `docs/TROUBLESHOOTING.md` seeded with the known failure classes. Plus one found on the way: three probes exited 1 on success (`process.exit(failures || …)` — array always truthy).
- **P1 — enforcement**: `tools/fake-upstream.mjs` (a scripted OpenAI-compatible provider whose model names encode failures), `tools/probe-failover.mjs` (34 checks driving `/v1` end to end — walk, benches, parity, classification, metering), `tools/run-probes.mjs` + `npm test` (glob-driven, new suites auto-enroll), one-job CI, README/TECH-DOC verification sections.
- **P2 — classification**: `router/failclass.mjs` — quota vocabulary before the 429 pattern, quota/billing never a key fault, model gaps bench nothing; wired into the walk (`+upstream-<status>:<kind>` ledger reasons), key rejections remembered per base-url + fingerprint on `/api/state`.
- **P3 — atomic writes**: three deliberate twins (`router/`, `lib/`, `lib/workflow/`), adopted at the ledger flush, the memory store (now 0600 — it was world-readable), the runtime `.env` (now atomic), and the dashboard's roster writes. Unit probe keeps the twins identical.
- **P4 — capability parity**: `manualModelRules` gains optional `supportsImages`/`supportsTools`; caps ride every rendered candidate; doomed fallbacks are excluded *before* steering (steering would otherwise pick a parity-doomed candidate into the target slot); dashboard shows per-provider caps. Undeclared stays neutral.
- **P5 — ledger attribution + cost**: declared prices → `costUsd`/`costSource: "price-list"` at the `record()` chokepoint (live across config reloads, never estimated); `trigger` (`operator` / `app:<name>`) threaded through the chat path; dashboard cost + who columns.

## The honest list

- The plan's "steered target is attempted even while benched" was wrong — production steers benched providers away. Production won; the probe asserts the real contract and the plan carries the correction.
- The plane manifest went stale (missing `exports` entry for `atomic.mjs`) and every router-spawning probe failed to boot — caught by `npm test` in one run, in the same session that added the enforcement. The lesson proving itself on first use.
- `kit apply --dry-run` resolves keys against the process env, not the runtime `.env` — recorded in TROUBLESHOOTING.

## Numbers

15 suites, ~250 checks, one command (`npm test`), zero new runtime dependencies, fifteen commits, neutrality grep clean.

## Open seams (deliberately deferred, each with its reason in the plan)

Prompt-cache metering; memory expiry + archive ordering; bounded-MCP doctrine when the MCP surface grows; thread-follows semantics for `/v1` model pinning; month-per-file ledger + spend caps; swarm rows' `trigger` attribution.
