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

## The mnemosyne port (2026-10-07)

The store carries mnemosyne's deterministic machinery as a **format superset** —
every enriched row still loads in the official MCP server's loader, and unknown
fields round-trip untouched:

- **Veracity**: `stated | inferred | tool | imported | unknown`, mnemosyne's
  weight table (1.0 / 0.7 / 0.5 / 0.6 / 0.8), clamped on write.
- **Facts**: an SPO relation with `confidence` + `mentionCount` + `sources`.
  A repeated fact compounds `c + (1-c)·w·0.3` (cap 1.0). The same subject+
  predicate with a different object is a **conflict** — derived at read, never
  buried; `kit memory resolve <loser> <winner>` supersedes the loser.
- **Temporal triples**: `addTriple`/`--triple` closes any open S+P when a new
  value arrives (knowledge that was true until it changed) — mnemosyne's
  TripleStore law, deliberately separate from the fact law.
- **Tiers**: `scope` is `global` or `session:<id>`. `kit memory scratch` is the
  short tier (24h TTL, mnemosyne's default); `kit memory consolidate` is the
  sleep port — eligible rows (past half-TTL, unconsolidated) promote
  **additively** into digest entities (originals stay, `consolidatedOf` names
  them), summaries deterministic-first with one fail-open `model: auto` call
  when the router is healthy.
- **Ranked recall**: relevance blended with importance, recency decay
  (half-week), veracity weight, and a mention boost from regex entity
  extraction (mnemosyne's annotation patterns) on `--extract` writes.

Not ported, on purpose: embeddings/vector search, passive conversation capture,
LLM prose extraction, episodic degradation tiers — mnemosyne keeps those; the
kit's durable tier is explicit-first, and its format stays dependency-free.

## Known limits, stated

Concurrency is the official server's own model — read-modify-write of the whole file under atomic rename, last writer wins per write; fine for a machine's worth of local agents. Search is substring, not semantic — no embeddings here. The store records what agents and operators declare; it does not extract or consolidate on its own.
