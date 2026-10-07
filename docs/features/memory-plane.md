# the memory plane — durable memory in the kit

*From the [memory-plane plan](../plans/2026-10-07-memory-plane.md). `lib/workflow/memory.mjs`, `lib/memory-mcp.mjs`, `bin/agnostic-router-memory.mjs`, `kit memory`, the `/api/memory` + `/v1/memory` routes, the `memory` capability, and `workflows/memory-probe.ts`.*

The plane's fact store dies with its run by design; the memory plane is the tier above it — one durable, cross-run, cross-agent JSONL graph under the kit home (`~/.agnostic-router-kit/memory/memory.jsonl`), readable and writable by every harness and app the kit knows.

## The format is the integration

The store is byte-format-identical to the official MCP memory server: one `{"type":"entity","name","entityType","observations":[...]}` or `{"type":"relation","from","to","relationType"}` row per line. That single decision means:

- any MCP harness points at the file with no adapter — `kit memory config` prints the exact `mcpServers` snippet;
- mnemosyne (or any graph-format store) imports through `kit memory import`;
- the kit can be replaced by anything speaking the same format. No lock-in, no second format.

## The wires

| Wire | Who | Law |
|---|---|---|
| MCP stdio (`bin/agnostic-router-memory.mjs`) | any MCP harness (ZCode, Hermes, Codex…) | nine tools, same names/schemas as the official server; `MEMORY_FILE_PATH` overrides the kit-home default |
| `GET/POST /api/memory` | operator token | search (`?q=`), stats, write; inside the operator-only `/api/` gate |
| `GET/POST /v1/memory` | app token | refused by name unless the app's `grantCeiling` includes `memory`; writes typed `app:<name>` |
| `world.memory.remember/search` + the `memory_search` agent tool | workflows | the `memory` capability — not granted by default, journaled like `net-search` (query/entity and counts, never a content dump) |
| `/chat` `/remember` · `/recall` | the operator, from the input box | through `/api/memory` |
| `kit memory stats | search | config | gc | import` | the terminal | the same store, atomically rewritten |

## Curation on import

`kit memory import --from mnemosyne --file export.json` applies the curation rule: **durable memories and graph triples in; the auto-extracted tiers (consolidated facts, per-session memoria rows) and session-scoped working memory are noise at graph scale — skipped by rule, not by judgment.** `--from official` merges any store already in the format. Imports are additive (existing names are never overwritten) and support `--dry-run`.

## Where the tiers live now

- **Session context** — working memory, dies with the session.
- **The md index (e.g. ZCode's MEMORY.md)** — the push tier: small, recency-weighted, auto-injected. A pointer, not a database.
- **The memory plane** — the durable tier this doc describes: the kit's own store, MCP-served, ceiling-gated for apps.
- **The per-run fact store** (harness.mjs) — unchanged: run-scoped by design.
- **Repo-committed docs** (AGENTS.md, plans, recaps, feature docs) — the cross-harness long term.

## Known limits, stated

Concurrency is the official server's own model — read-modify-write of the whole file under atomic rename, last writer wins per write; fine for a machine's worth of local agents. Search is substring, not semantic — no embeddings here. The store records what agents and operators declare; it does not extract or consolidate on its own.
