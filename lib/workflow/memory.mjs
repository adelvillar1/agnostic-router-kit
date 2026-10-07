/**
 * The memory plane: durable, cross-run, cross-agent memory.
 *
 * The run fact store (harness.mjs) dies with its run by design; this module is
 * the tier above it — one JSONL graph every harness and run can read and
 * write. The format is the official MCP memory server's, byte for byte at the
 * base: one `{"type":"entity",...}` or `{"type":"relation",...}` row per line.
 * On top of that base this store carries a mnemosyne-shaped enrichment
 * superset — importance, veracity, scope, validity, supersession, mention
 * annotations, fact confidence — and **unknown fields round-trip untouched**,
 * so an official-server loader still reads a kit file (it ignores what it
 * does not know) and nothing is lost when the kit rewrites the file.
 *
 * The ported machinery (from Hermes's mnemosyne, by rule not by translation):
 *   - veracity: stated/inferred/tool/imported/unknown, mnemosyne's weights,
 *     clamped on write
 *   - facts: an SPO relation carries confidence, mention_count and sources;
 *     a repeated SPO compounds confidence `c + (1-c)·w·0.3` (cap 1.0); the
 *     same S+P with a different O is a conflict — derived at read, resolved
 *     by superseding the loser
 *   - temporal invalidation: `invalidate` sets validUntil; superseded rows
 *     leave the default search
 *   - tiers: scope is "global" or "session:<id>"; session rows carry a
 *     validUntil (the scratch tier's TTL) and consolidate additively into
 *     digest entities — the originals stay (mnemosyne's contract)
 *   - ranked recall: relevance blended with importance, recency decay
 *     (half-week), veracity weight, and a mention boost from the regex
 *     entity extraction (mnemosyne's annotation patterns)
 *
 * Storage lives under the kit home (runstate's KIT_HOME) as runtime state:
 * created lazily on first write, never hand-edited, atomic tmp-rename saves.
 * Concurrency is the official server's own model — read-modify-write of the
 * whole file, last writer wins per write — fine for a machine's worth of
 * local agents; the router serializes its own writes in-process.
 *
 * Zero dependencies. Node's fs and nothing else.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { KIT_HOME } from "./runstate.mjs";

/**
 * The durable memory store. Resolution order: MEMORY_FILE_PATH (the same
 * contract the MCP bin documents — how an edition or a probe pins an
 * alternate store), else the kit home's memory/ directory. Created lazily.
 */
export function memoryStorePath() {
  if (process.env.MEMORY_FILE_PATH) {
    const p = path.resolve(process.env.MEMORY_FILE_PATH);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    return p;
  }
  const dir = path.join(KIT_HOME(), "memory");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "memory.jsonl");
}

/** Mnemosyne's veracity weight table, ported verbatim. */
export const VERACITY_WEIGHTS = { stated: 1.0, inferred: 0.7, tool: 0.5, imported: 0.6, unknown: 0.8 };
export const VERACITY_LABELS = Object.keys(VERACITY_WEIGHTS);
/** The scratch tier's TTL in hours; consolidation eligibility starts at half of it. */
export const WORKING_TTL_HOURS = 24;

export function clampVeracity(v) {
  const s = String(v ?? "").toLowerCase().trim();
  return VERACITY_LABELS.includes(s) ? s : "unknown";
}
const veracityWeight = (v) => VERACITY_WEIGHTS[clampVeracity(v)] ?? 0.8;

const ENTITY_FIELDS = ["type", "name", "entityType", "observations", "importance", "veracity", "validUntil", "supersededBy", "scope", "mentions", "consolidatedOf", "source"];
const RELATION_FIELDS = ["type", "from", "to", "relationType", "id", "confidence", "mentionCount", "sources", "veracity", "validFrom", "validUntil", "supersededBy"];

/**
 * Load the graph. Malformed rows are skipped, not fatal — a hand-edited or
 * half-written line must not take the whole memory down (the journal law:
 * the reader shapes, it never loses the rest). Unknown fields ride along on
 * `extra` so enrichment survives a load→save round trip.
 */
export function loadGraph(file = memoryStorePath()) {
  const graph = { entities: [], relations: [] };
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return graph;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row?.type === "entity" && typeof row.name === "string") {
      const e = {
        name: row.name,
        entityType: row.entityType ?? "memory",
        observations: Array.isArray(row.observations) ? row.observations.filter((o) => typeof o === "string") : [],
        importance: Number.isFinite(row.importance) ? row.importance : undefined,
        veracity: row.veracity !== undefined ? clampVeracity(row.veracity) : undefined,
        validUntil: typeof row.validUntil === "string" ? row.validUntil : undefined,
        supersededBy: typeof row.supersededBy === "string" ? row.supersededBy : undefined,
        scope: typeof row.scope === "string" ? row.scope : "global",
        mentions: Array.isArray(row.mentions) ? row.mentions.filter((m) => typeof m === "string") : [],
        consolidatedOf: Array.isArray(row.consolidatedOf) ? row.consolidatedOf : undefined,
        source: typeof row.source === "string" ? row.source : undefined,
      };
      e.extra = Object.fromEntries(Object.entries(row).filter(([k]) => !ENTITY_FIELDS.includes(k)));
      graph.entities.push(e);
    } else if (row?.type === "relation" && typeof row.from === "string" && typeof row.to === "string" && typeof row.relationType === "string") {
      const r = {
        from: row.from,
        to: row.to,
        relationType: row.relationType,
        id: typeof row.id === "string" ? row.id : undefined,
        confidence: Number.isFinite(row.confidence) ? row.confidence : undefined,
        mentionCount: Number.isFinite(row.mentionCount) ? row.mentionCount : undefined,
        sources: Array.isArray(row.sources) ? row.sources.filter((s) => typeof s === "string") : undefined,
        veracity: row.veracity !== undefined ? clampVeracity(row.veracity) : undefined,
        validUntil: typeof row.validUntil === "string" ? row.validUntil : undefined,
        validFrom: typeof row.validFrom === "string" ? row.validFrom : undefined,
        supersededBy: typeof row.supersededBy === "string" ? row.supersededBy : undefined,
      };
      r.extra = Object.fromEntries(Object.entries(row).filter(([k]) => !RELATION_FIELDS.includes(k)));
      graph.relations.push(r);
    }
  }
  return graph;
}

/** Save atomically: complete bytes on disk before the rename lands. */
export function saveGraph(graph, file = memoryStorePath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-memory`;
  const rows = [
    ...graph.entities.map((e) => ({ type: "entity", ...pickKnown(e, ENTITY_FIELDS, ["type"]) })),
    ...graph.relations.map((r) => ({ type: "relation", ...pickKnown(r, RELATION_FIELDS, ["type"]) })),
  ].map((r) => JSON.stringify(stripUndefined(r)));
  fs.writeFileSync(tmp, (rows.length ? rows.join("\n") + "\n" : ""));
  fs.renameSync(tmp, file);
  return graph;
}

function pickKnown(row, fields, omit) {
  const out = {};
  for (const k of fields) {
    if (k === omit) continue;
    if (row[k] !== undefined) out[k] = row[k];
  }
  return { ...out, ...(row.extra ?? {}) };
}

function stripUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

const findEntity = (graph, name) => graph.entities.find((e) => e.name === name);

/** Create entities; names already present are skipped (the official server's rule). */
export function createEntities(graph, entities) {
  const added = [];
  for (const e of entities ?? []) {
    if (!e?.name || findEntity(graph, e.name)) continue;
    const entity = {
      name: e.name,
      entityType: e.entityType ?? "memory",
      observations: (e.observations ?? []).filter((o) => typeof o === "string"),
      scope: e.scope !== undefined ? String(e.scope) : "global",
      mentions: Array.isArray(e.mentions) ? e.mentions.filter((m) => typeof m === "string") : [],
      ...(e.importance !== undefined ? { importance: clamp01(e.importance) } : {}),
      ...(e.veracity !== undefined ? { veracity: clampVeracity(e.veracity) } : {}),
      ...(e.validUntil !== undefined ? { validUntil: String(e.validUntil) } : {}),
      ...(e.source !== undefined ? { source: String(e.source) } : {}),
    };
    graph.entities.push(entity);
    added.push(entity.name);
  }
  return { added, graph };
}

function clamp01(n) {
  return Math.min(1, Math.max(0, Number(n)));
}

/** Add observations; unknown entity is a named error, duplicates deduped. */
export function addObservations(graph, observations) {
  const added = [];
  for (const o of observations ?? []) {
    const entity = findEntity(graph, o?.entityName);
    if (!entity) throw new Error(`Entity with name ${o?.entityName} not found`);
    const fresh = (o.contents ?? []).filter((c) => typeof c === "string" && !entity.observations.includes(c));
    entity.observations.push(...fresh);
    added.push({ entityName: entity.name, added: fresh.length });
  }
  return { added, graph };
}

/** Create relations; an identical from/to/relationType already present is skipped. */
export function createRelations(graph, relations) {
  const key = (r) => `${r.from}\u0000${r.to}\u0000${r.relationType}`;
  const existing = new Set(graph.relations.map(key));
  const added = [];
  for (const r of relations ?? []) {
    if (!r?.from || !r?.to || !r?.relationType || existing.has(key(r))) continue;
    graph.relations.push({
      from: r.from,
      to: r.to,
      relationType: r.relationType,
      ...(r.confidence !== undefined ? { confidence: clamp01(r.confidence) } : {}),
      ...(r.veracity !== undefined ? { veracity: clampVeracity(r.veracity) } : {}),
    });
    existing.add(key(r));
    added.push(r);
  }
  return { added, graph };
}

/** Delete entities by name; relations touching them go with them. */
export function deleteEntities(graph, names) {
  const dead = new Set(names ?? []);
  const kept = graph.entities.filter((e) => !dead.has(e.name));
  const removed = graph.entities.length - kept.length;
  graph.relations = graph.relations.filter((r) => !dead.has(r.from) && !dead.has(r.to));
  graph.entities = kept;
  return { removed, graph };
}

export function deleteObservations(graph, deletions) {
  let removed = 0;
  for (const d of deletions ?? []) {
    const entity = findEntity(graph, d?.entityName);
    if (!entity) continue;
    const dead = new Set(d.observations ?? []);
    const before = entity.observations.length;
    entity.observations = entity.observations.filter((o) => !dead.has(o));
    removed += before - entity.observations.length;
  }
  return { removed, graph };
}

export function deleteRelations(graph, relations) {
  const dead = new Set((relations ?? []).map((r) => `${r?.from}\u0000${r?.to}\u0000${r?.relationType}`));
  const kept = graph.relations.filter((r) => !dead.has(`${r.from}\u0000${r.to}\u0000${r.relationType}`));
  const removed = graph.relations.length - kept.length;
  graph.relations = kept;
  return { removed, graph };
}

// ── the fact layer (mnemosyne's consolidated_facts + triples, on relations) ─

const factKey = (spo) => `${spo.subject}\u0000${spo.predicate}\u0000${spo.object}`;
const factId = (spo) => "f_" + crypto.createHash("sha256").update(factKey(spo)).digest("hex").slice(0, 24);

/**
 * Add or compound an SPO fact. First mention: confidence = veracity weight ×
 * 0.5 (mnemosyne's base). A repeat: `c + (1-c)·w·0.3`, mention_count++, the
 * source appended. The same S+P with a DIFFERENT object is a conflict —
 * returned, not hidden: the store derives conflicts, it does not bury them.
 */
export function addFact(graph, { subject, predicate, object, veracity = "unknown", source }) {
  const v = clampVeracity(veracity);
  const w = veracityWeight(v);
  const existing = graph.relations.find(
    (r) => r.from === subject && r.relationType === predicate && r.to === object && !r.supersededBy
  );
  if (existing) {
    const c = existing.confidence ?? 0.5;
    existing.confidence = Math.min(1, c + (1 - c) * w * 0.3);
    existing.mentionCount = (existing.mentionCount ?? 1) + 1;
    existing.lastMention = new Date().toISOString();
    existing.veracity = v;
    existing.extra = { ...existing.extra, ...(!existing.extra?.lastMention ? {} : {}) };
    if (source && !(existing.sources ?? []).includes(source)) existing.sources = [...(existing.sources ?? []), source];
    return { fact: existing, conflicts: [], graph };
  }
  const fact = {
    id: factId({ subject, predicate, object }),
    from: subject,
    to: object,
    relationType: predicate,
    confidence: w * 0.5,
    mentionCount: 1,
    sources: source ? [source] : [],
    veracity: v,
  };
  graph.relations.push(fact);
  const conflicts = graph.relations.filter(
    (r) => r !== fact && r.from === subject && r.relationType === predicate && r.to !== object && !r.supersededBy
  );
  return { fact, conflicts, graph };
}

/**
 * Add a TEMPORAL triple (mnemosyne's TripleStore.add law): a new S+P with a
 * different object closes every open triple of the same pair — knowledge that
 * was true until it changed. Distinct from addFact, which compounds and
 * records conflicts; use addTriple when the statement is time-scoped by nature.
 */
export function addTriple(graph, { subject, predicate, object, validFrom, source }) {
  const now = new Date().toISOString();
  for (const r of graph.relations) {
    if (r.from === subject && r.relationType === predicate && r.to !== object && !r.validUntil && !r.supersededBy) {
      r.validUntil = validFrom ?? now;
    }
  }
  const triple = {
    id: "t_" + crypto.createHash("sha256").update(factKey({ subject, predicate, object })).digest("hex").slice(0, 24),
    from: subject,
    to: object,
    relationType: predicate,
    validFrom: validFrom ?? now,
    sources: source ? [source] : [],
    veracity: "stated",
  };
  graph.relations.push(triple);
  return { triple, graph };
}

/**
 * Resolve a conflict the way mnemosyne's dormant pass would have: the higher
 * confidence wins, the loser is superseded (hidden from default search, kept
 * in the file).
 */
export function resolveConflict(graph, loserId, winnerId) {
  const loser = graph.relations.find((r) => r.id === loserId);
  const winner = graph.relations.find((r) => r.id === winnerId);
  if (!loser || !winner) throw new Error(`unknown fact id: ${!loser ? loserId : winnerId}`);
  loser.supersededBy = winner.id;
  return { winner: winner.id, graph };
}

/** Invalidate an entity or fact: validUntil = now, optional supersession. */
export function invalidate(graph, name, { supersededBy } = {}) {
  const entity = findEntity(graph, name);
  if (entity) {
    entity.validUntil = new Date().toISOString();
    if (supersededBy) entity.supersededBy = String(supersededBy);
    return { ok: true, graph };
  }
  const fact = graph.relations.find((r) => r.id === name || factKey(r) === name);
  if (fact) {
    fact.validUntil = new Date().toISOString();
    if (supersededBy) fact.supersededBy = String(supersededBy);
    return { ok: true, graph };
  }
  throw new Error(`nothing named ${name} to invalidate`);
}

const isLive = (row, now = Date.now()) =>
  !row.supersededBy && (!row.validUntil || Date.parse(row.validUntil) > now);

/** Live rows only: not superseded, not expired (the default read's filter). */
export function liveFilter(rows, now = Date.now()) {
  return rows.filter((r) => isLive(r, now));
}

// ── the scratch tier (mnemosyne's working memory, shaped for the kit) ───────

/** A session-scoped scratch row: expires at the TTL, consolidates, then stays. */
export function addScratch(graph, { session, text, source, importance = 0.4, now = Date.now() }) {
  const validUntil = new Date(now + WORKING_TTL_HOURS * 3600_000).toISOString();
  const entity = {
    name: `${text.trim().slice(0, 56)} [${crypto.randomBytes(4).toString("hex")}]`,
    entityType: "working",
    observations: [text.trim()],
    importance: clamp01(importance),
    scope: `session:${session}`,
    validUntil,
    source: source ?? "scratch",
    extra: { ts: new Date(now).toISOString() },
  };
  graph.entities.push(entity);
  return { entity, graph };
}

/** Consolidation eligibility: session rows past half the TTL, not yet consolidated. */
export function consolidationEligible(graph, { session, now = Date.now() }) {
  const cutoff = now - (WORKING_TTL_HOURS / 2) * 3600_000;
  return graph.entities.filter(
    (e) =>
      e.scope === `session:${session}` &&
      e.entityType === "working" &&
      !e.consolidatedOf &&
      !e.extra?.consolidatedAt &&
      !e.supersededBy &&
      now - Date.parse(e.extra?.ts ?? e.validUntil ?? 0) > (WORKING_TTL_HOURS / 2) * 3600_000
  );
}

/**
 * The sleep port: group eligible rows by source, promote additively into one
 * digest entity per group — originals stay (mnemosyne's contract), the digest
 * carries `consolidatedOf` so recall can dedupe clusters later. `summaries`
 * maps source → summary text; groups without one get the deterministic
 * extractive digest (their observations, key lines first).
 */
export function consolidate(graph, { session, now = Date.now(), summaries = {} } = {}) {
  const eligible = consolidationEligible(graph, { session, now });
  const bySource = new Map();
  for (const e of eligible) {
    const k = e.source ?? "scratch";
    if (!bySource.has(k)) bySource.set(k, []);
    bySource.get(k).push(e);
  }
  const digests = [];
  for (const [source, rows] of bySource) {
    const summary = summaries[source] ?? signalDigest(rows);
    const digest = {
      name: `consolidated ${source} ${new Date(now).toISOString().slice(0, 16)}`,
      entityType: "digest",
      observations: [summary, `consolidated ${rows.length} scratch rows from ${source}`],
      importance: 0.6,
      veracity: aggregateVeracity(rows),
      scope: `session:${session}`,
      consolidatedOf: rows.map((r) => r.name),
      source: "consolidation",
    };
    graph.entities.push(digest);
    for (const r of rows) r.extra = { ...r.extra, consolidatedAt: new Date(now).toISOString() };
    digests.push(digest);
  }
  return { digests, count: eligible.length, graph };
}

/** mnemosyne's aggregate_veracity: non-unknown labels vote, mode wins. */
export function aggregateVeracity(rows) {
  const votes = rows.map((r) => clampVeracity(r.veracity)).filter((v) => v !== "unknown");
  if (!votes.length) return "unknown";
  const tally = new Map();
  for (const v of votes) tally.set(v, (tally.get(v) ?? 0) + 1);
  let best = "unknown";
  let bestN = 0;
  for (const [v, n] of tally) {
    if (n > bestN || (n === bestN && veracityWeight(v) < veracityWeight(best))) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

/** The deterministic digest: first lines, key-signal sentences first. */
function signalDigest(rows) {
  const scored = rows
    .map((r) => ({ r, signal: keySignal(r.observations.join(" ")) }))
    .sort((a, b) => b.signal - a.signal);
  return (
    scored
      .slice(0, 8)
      .map(({ r }) => r.observations[0]?.slice(0, 200))
      .filter(Boolean)
      .join(" | ") || "(empty scratch rows)"
  );
}

/** mnemosyne's key-signal idea, ported: proper nouns, tech words, preferences. */
function keySignal(text) {
  const caps = (text.match(/\b[A-Z][a-zA-Z0-9.-]{2,}\b/g) ?? []).length;
  const tech = (text.match(/\b(api|json|sql|git|http|node|python|ssh|dns|url|cli)\b/gi) ?? []).length;
  const pref = /\b(prefers|likes|wants|always|never|hates|uses)\b/i.test(text) ? 3 : 0;
  return caps * 2 + tech + pref;
}

// ── ranked recall (mnemosyne's deterministic scorer, on substring hits) ─────

/**
 * Regex entity extraction — mnemosyne's annotation patterns: @mentions,
 * #hashtags, quoted phrases, capitalized 1–5-word sequences.
 */
export function extractMentions(text) {
  const out = new Set();
  const t = String(text ?? "");
  for (const m of t.matchAll(/@([A-Za-z0-9_]{2,30})/g)) out.add(m[1]);
  for (const m of t.matchAll(/#([A-Za-z0-9_-]{2,30})/g)) out.add(m[1]);
  for (const m of t.matchAll(/"([^"]{2,60})"/g)) out.add(m[1]);
  for (const m of t.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,4})\b/g)) {
    if (m[1].length > 3) out.add(m[1]);
  }
  return [...out].slice(0, 12);
}

/**
 * Search, then rank: relevance (substring over name + observations) blended
 * with importance, recency decay over a half-week, the veracity weight, and a
 * ×1.25 boost when a query word appears in the entity's mentions. Expired and
 * superseded rows leave the default read; scope filters per the tier rule.
 */
export function searchGraph(graph, query, { limit = 25, scope = "global", allScopes = false, now = Date.now(), includeDead = false } = {}) {
  const q = String(query ?? "").toLowerCase().trim();
  if (!q) return [];
  const words = q.split(/\s+/);
  const hits = [];
  for (const e of graph.entities) {
    if (!includeDead && !isLive(e, now)) continue;
    if (!allScopes && e.scope !== "global" && e.scope !== scope) continue;
    const hay = (e.name + "\n" + e.observations.join("\n")).toLowerCase();
    const allWords = words.length > 1 && words.every((w) => w.length > 2 && hay.includes(w));
    if (!hay.includes(q) && !allWords) continue;
    const relevance = e.name.toLowerCase().includes(q) ? 1 : 0.6;
    const recency = Math.exp(-((now - (e.extra?.ts ? Date.parse(e.extra.ts) : now)) / 3600_000) / 168);
    let score = 0.45 * relevance + 0.25 * (e.importance ?? 0.5) + 0.2 * recency + 0.1 * veracityWeight(e.veracity);
    if ((e.mentions ?? []).some((m) => words.some((w) => m.toLowerCase().includes(w)))) score *= 1.25;
    hits.push({ ...e, score: Math.round(score * 1000) / 1000 });
    if (hits.length > 400) break;
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Open named nodes with their immediate relations (the official server's open_nodes). */
export function openNodes(graph, names) {
  const wanted = new Set(names ?? []);
  return {
    entities: graph.entities.filter((e) => wanted.has(e.name)),
    relations: graph.relations.filter((r) => wanted.has(r.from) || wanted.has(r.to)),
  };
}

/** Conservative gc: dedupe observations, merge exact-duplicate names, drop duplicate relations. */
export function gcGraph(graph) {
  const before = { entities: graph.entities.length, relations: graph.relations.length, observations: graph.entities.reduce((n, e) => n + e.observations.length, 0) };
  const byName = new Map();
  const entities = [];
  for (const e of graph.entities) {
    if (!byName.has(e.name)) {
      byName.set(e.name, e);
      e.observations = [...new Set(e.observations)];
      entities.push(e);
    } else {
      const keep = byName.get(e.name);
      const merged = e.observations.filter((o) => !keep.observations.includes(o));
      keep.observations.push(...merged);
    }
  }
  const relKey = (r) => `${r.from}\u0000${r.to}\u0000${r.relationType}`;
  const relations = [];
  const seen = new Set();
  for (const r of graph.relations) {
    if (seen.has(relKey(r))) continue;
    seen.add(relKey(r));
    relations.push(r);
  }
  graph.entities = entities;
  graph.relations = relations;
  const after = { entities: graph.entities.length, relations: graph.relations.length, observations: graph.entities.reduce((n, e) => n + e.observations.length, 0) };
  return { before, after, graph };
}

export function memoryStats(graph) {
  return {
    entities: graph.entities.length,
    relations: graph.relations.length,
    observations: graph.entities.reduce((n, e) => n + e.observations.length, 0),
    byType: graph.entities.reduce((acc, e) => ((acc[e.entityType] = (acc[e.entityType] ?? 0) + 1), acc), {}),
    conflicts: detectConflicts(graph).length,
    expired: graph.entities.filter((e) => !isLive(e)).length,
  };
}

/** Derived conflicts: live facts sharing S+P with a different O. */
export function detectConflicts(graph) {
  const byPair = new Map();
  for (const r of graph.relations) {
    if (r.supersededBy || (r.validUntil && Date.parse(r.validUntil) <= Date.now())) continue;
    const k = `${r.from}\u0000${r.relationType}`;
    if (!byPair.has(k)) byPair.set(k, []);
    byPair.get(k).push(r);
  }
  const conflicts = [];
  for (const [, group] of byPair) {
    if (group.length < 2) continue;
    const [winner, ...losers] = [...group].sort((a, b) => (b.confidence ?? 0.5) - (a.confidence ?? 0.5));
    conflicts.push({ winner: winner.id, losers: losers.map((l) => l.id), subject: winner.from, predicate: winner.relationType });
  }
  return conflicts;
}
