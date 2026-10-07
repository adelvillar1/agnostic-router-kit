/**
 * The memory plane: durable, cross-run, cross-agent memory.
 *
 * The run fact store (harness.mjs) dies with its run by design; this module is
 * the tier above it — one JSONL graph every harness and run can read and
 * write. The format is the official MCP memory server's, byte for byte: one
 * `{"type":"entity","name","entityType","observations":[...]}` or
 * `{"type":"relation","from","to","relationType"}` row per line. Matching that
 * format is the whole integration story — any MCP harness can point at this
 * file with no adapter, and mnemosyne exports into it.
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
import { KIT_HOME } from "./runstate.mjs";

/** The durable memory store: <kit home>/memory/memory.jsonl, created lazily. */
export function memoryStorePath() {
  const dir = path.join(KIT_HOME(), "memory");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "memory.jsonl");
}

/**
 * Load the graph. Malformed rows are skipped, not fatal — a hand-edited or
 * half-written line must not take the whole memory down (the journal law:
 * the reader shapes, it never loses the rest).
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
      graph.entities.push({ name: row.name, entityType: row.entityType ?? "memory", observations: Array.isArray(row.observations) ? row.observations.filter((o) => typeof o === "string") : [] });
    } else if (row?.type === "relation" && typeof row.from === "string" && typeof row.to === "string" && typeof row.relationType === "string") {
      graph.relations.push({ from: row.from, to: row.to, relationType: row.relationType });
    }
  }
  return graph;
}

/** Save atomically: complete bytes on disk before the rename lands. */
export function saveGraph(graph, file = memoryStorePath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-memory`;
  const body = [
    ...graph.entities.map((e) => ({ type: "entity", name: e.name, entityType: e.entityType, observations: e.observations })),
    ...graph.relations.map((r) => ({ type: "relation", from: r.from, to: r.to, relationType: r.relationType })),
  ]
    .map((r) => JSON.stringify(r))
    .join("\n");
  fs.writeFileSync(tmp, (body ? body + "\n" : ""));
  fs.renameSync(tmp, file);
  return graph;
}

const findEntity = (graph, name) => graph.entities.find((e) => e.name === name);

/** Create entities; names already present are skipped (the official server's rule). */
export function createEntities(graph, entities) {
  const added = [];
  for (const e of entities ?? []) {
    if (!e?.name || findEntity(graph, e.name)) continue;
    const entity = { name: e.name, entityType: e.entityType ?? "memory", observations: (e.observations ?? []).filter((o) => typeof o === "string") };
    graph.entities.push(entity);
    added.push(entity.name);
  }
  return { added, graph };
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
    graph.relations.push({ from: r.from, to: r.to, relationType: r.relationType });
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

/** Search: case-insensitive substring over names and observations. */
export function searchGraph(graph, query, { limit = 25 } = {}) {
  const q = String(query ?? "").toLowerCase().trim();
  if (!q) return [];
  const hits = [];
  for (const e of graph.entities) {
    if (e.name.toLowerCase().includes(q) || e.observations.some((o) => o.toLowerCase().includes(q))) {
      hits.push(e);
      if (hits.length >= limit) break;
    }
  }
  return hits;
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
  };
}
