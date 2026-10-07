---
status: completed
created: 2026-10-07
updated: 2026-10-07
slug: memory-plane
---

# Plan: the memory plane — durable memory as part of the kit

**Repo:** agnostic-router-kit. **Scope:** one JSONL graph store under the kit home, a native zero-dependency MCP server for it, operator + app HTTP routes, a `memory` capability on the plane, an import bridge from mnemosyne/official stores, and the cutover that makes the kit store the one durable tier ZCode points at. The plane's own comment used to say "one store per run — it dies with the run"; this is the tier above it.

**Goal:** every connected agent — ZCode, Hermes, any MCP harness, any app holding a roster token — reads and writes one durable memory graph, under the same bearer gate and ceilings as everything else in the kit.

## What landed

### Phase 0 — the store and the CLI — ✅ done
`lib/workflow/memory.mjs` (in the plane — the manifest-driven runtime copy ships it to the deployed router automatically): load (malformed rows skipped, the journal law), atomic tmp-rename save, create/delete entities and relations, add observations (unknown entity is a named error, duplicates deduped), case-insensitive substring search, `open_nodes` (immediate relations = either endpoint), conservative gc (dedupe observations, merge duplicate names), stats. The store lives at `~/.agnostic-router-kit/memory/memory.jsonl`, created lazily on first write. `kit memory stats | search | config | gc | import`; `kit doctor` names the store once it exists and fails on an unparseable one.

### Phase 1 — the native MCP server — ✅ done
`bin/agnostic-router-memory.mjs` + `lib/memory-mcp.mjs` (~230 lines, zero deps): JSONRPC lines over stdio, `initialize` (echoes the client's protocol version), `tools/list`, `tools/call`, ping; the nine tools the official knowledge-graph server exposes, same names, same schemas, same JSON responses and `isError` shape. `MEMORY_FILE_PATH` wins over the kit-home default — the harness-facing contract. `kit memory config` prints the wiring snippet.

### Phase 2 — the router routes and surfaces — ✅ done
- `GET/POST /api/memory` — operator scope (inside the `/api/` gate): search, stats, write (entities/relations/observations), router-log attribution.
- `GET/POST /v1/memory` — the app wire: refused with `403 out of bounds: memory is not in <app>'s ceiling` unless the roster app's `grantCeiling` includes `memory`; writes typed `app:<name>`; every write and refusal attributed in the router log.
- `/api/setup` gains the "Durable memory wired" step (router-computed: store exists and holds memories); `/chat` gains `/remember <fact>` and `/recall <what>` in the input box.

### Phase 3 — the plane capability — ✅ done
`memory` in `CAPABILITIES` (not granted by default, the net-search law): `world.memory.remember(entity, observation)` and `world.memory.search(query)` on the workflow surface; the agent tool `memory_search`. Journaled like `web_search` — query/entity and counts, content capped. The per-run fact store is untouched: run-scoped by design, this is the tier above it. `workflows/memory-probe.ts` asserts both modes with zero model calls.

### Phase 4 — import, cutover, docs — ✅ done
`kit memory import --from mnemosyne --file export.json` productizes the curation rule (durable memories + graph triples in; the auto-extracted tiers and session-scoped working rows are noise by rule, not judgment); `--from official` merges any store already in the graph format. **Cutover executed:** the kit store now holds 459 entities / 10 relations (tonight's ZCode store merged in), ZCode's `mcpServers.memory` points at `bin/agnostic-router-memory.mjs` with the kit store path, and a fresh search through the kit's own server finds the seeded content.

## Acceptance criteria

- [x] **C0** store ops + format compatibility: 21-check probe; the kit's file loads through the official server's loader and vice versa (round-tripped, not asserted). *(probe-memory A/B)*
- [x] **C1** MCP: full stdio handshake, nine tools, seeded search, write/search/delete roundtrip, named `isError` for unknown entities. *(probe-memory-mcp 9/9)*
- [x] **C2** gate law: app without the capability refused by name; with it, write+read; `/api/memory` operator-only with app tokens 403; bad token 401. *(probe-memory-api A/B, 14/14)*
- [x] **C3** attribution: `memory-write`/`memory-refused` carry the app name in the router log; the store lands under the kit home the server runs from. *(probe-memory-api C)*
- [x] **C4** CLI: stats/search/config/gc/import on a scratch home; the mnemosyne import on a checked fixture imports the durable tiers and skips working/consolidated by rule. *(probe-memory C/D)*
- [x] **C5** plane: ungranted run refused by name and journaled; granted run remembers and searches with the observation intact; journal carries counts, not dumps. *(memory-probe, both modes live)*
- [x] **C6** `/chat` `/remember` + `/recall` against `/api/memory`; `/setup` shows the memory step and flips after writes. *(probe-memory-api D; chat script parse-checked)*
- [x] **C7** cutover: kit store seeded, ZCode repointed, fresh kit-server search finds the seeded content. *(live, this session)*
- [x] **C8** invariants: neutrality grep clean, `node --check` clean on every touched file, existing probes still green (run-API 33, keys 30, chat-surface 14).
- [x] **C9** diagrams refreshed in-wave: both archify candidates carry the memory plane and re-finalized through the showcase gates; stills re-rendered.

## Incident records (recorded honestly)
- **The env-var contract split**: `memoryStorePath()` resolves the kit home, but the MCP server's documented contract is `MEMORY_FILE_PATH` — the first probe run silently read the default store (4 of 9 checks failed on the wrong file). Fixed: the server resolves `MEMORY_FILE_PATH` first, kit home second.
- **`open_nodes` semantics**: shipped with AND-semantics (both endpoints open) before the probe caught the official OR-semantics (either endpoint = the node's immediate relations).
- **A stale router on the probe's port**: the first API-probe run was interrupted in a way that left its scratch server bound to 8393 with pre-fix code; every later run's healthz answered instantly (the stranger) and tested the wrong server, reproducing a bug that no longer existed. Same lesson as the visual probe — the probe should refuse a port that already answers — now noted for all three HTTP probes.

## Out of scope
Embeddings/vector search; LLM-based extraction or auto-consolidation (mnemosyne's game); a sync daemon (Hermes keeps mnemosyne canonical; `kit memory import` is the bridge); per-app namespaces (one shared graph with source typing in v1); hosted mode.

## Notes
The format decision is the whole integration story: byte-compatible with the official MCP memory server means no second format anywhere — ZCode, Hermes (should it switch later), and any MCP harness read the same file, and the kit's `import` is the one-way bridge from everything else.
