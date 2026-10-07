#!/usr/bin/env node
/**
 * The memory plane's probe: store semantics, CLI, and format compatibility —
 * zero model calls, zero network (the official-server round-trip uses the
 * npx-cached package only when RUN_OFFICIAL=1 is set).
 *
 * Covers:
 *   C0  create/read/search/delete with atomic writes; the file the kit writes
 *       is the file the official MCP server reads, and vice versa
 *   C4  the mnemosyne import reproduces the curation policy on a checked
 *       fixture: durable memories + triples in, everything else skipped
 *
 * Usage: node tools/probe-memory.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const KIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "memory-probe-"));

let passed = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const env = { ...process.env, AGNOSTIC_ROUTER_KIT_HOME: home };
const store = path.join(home, "memory", "memory.jsonl");
const cli = (args) => spawnSync(process.execPath, [path.join(KIT_DIR, "bin", "agnostic-router-kit.mjs"), ...args], { env, encoding: "utf8" });

const { loadGraph, saveGraph, createEntities, createRelations, addObservations, deleteEntities, searchGraph, gcGraph, memoryStats } = await import("workflow-plane/memory.mjs");

// ── C0: store semantics ──────────────────────────────────────────────────────
console.log("\nA — store semantics");
let graph = loadGraph(store);
ok("empty store loads", graph.entities.length === 0 && graph.relations.length === 0);
createEntities(graph, [
  { name: "agnostic-router-kit", entityType: "project", observations: ["the engine edition", "owns the memory plane"] },
  { name: "memory plane", entityType: "feature", observations: ["durable cross-run memory"] },
]);
createRelations(graph, [{ from: "agnostic-router-kit", to: "memory plane", relationType: "ships" }]);
addObservations(graph, [{ entityName: "memory plane", contents: ["JSONL graph format"] }]);
saveGraph(graph, store);
ok("store file exists after save", fs.existsSync(store));

const reread = loadGraph(store);
ok("roundtrip: entities survive", reread.entities.length === 2);
ok("roundtrip: relations survive", reread.relations.length === 1);
ok("roundtrip: observations survive", reread.entities[0].observations.length === 2);

const dup = createEntities(reread, [{ name: "agnostic-router-kit", entityType: "x", observations: [] }]);
ok("duplicate create skipped", dup.added.length === 0);
const unknown = (() => { try { addObservations(reread, [{ entityName: "nope", contents: ["x"] }]); return null; } catch (e) { return e; } })();
ok("unknown entity add errors by name", unknown?.message.includes("nope"));
const del = deleteEntities(reread, ["memory plane"]);
ok("delete removes touching relations too", del.graph.relations.length === 0 && del.graph.entities.length === 1);
saveGraph(del.graph, store);

const searched = searchGraph(loadGraph(store), "ROUTER");
ok("search is case-insensitive over names+observations", searched.length === 1);

// malformed line must not take the store down
fs.appendFileSync(store, "{broken json line\n");
const resilient = loadGraph(store);
ok("malformed row skipped, rest survives", resilient.entities.length === 1);

// ── C0: official-server format round-trip ───────────────────────────────────
console.log("\nB — official MCP server compatibility");
{
  // The official server's loader: one typed row per line.
  const officialRead = (file) =>
    fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).reduce(
      (g, line) => {
        const item = JSON.parse(line);
        if (item.type === "entity") g.entities.push({ name: item.name, entityType: item.entityType, observations: item.observations });
        if (item.type === "relation") g.relations.push({ from: item.from, to: item.to, relationType: item.relationType });
        return g;
      }, { entities: [], relations: [] });

  const kitFile = path.join(home, "kit-format.jsonl");
  const g2 = loadGraph(store);
  createEntities(g2, [{ name: "format probe", entityType: "test", observations: ["written by the kit"] }]);
  createRelations(g2, [{ from: "agnostic-router-kit", to: "format probe", relationType: "wrote" }]);
  saveGraph(g2, kitFile);
  const asOfficial = officialRead(kitFile);
  ok("official loader reads the kit's file", asOfficial.entities.length === 2 && asOfficial.relations.length === 1);

  // And the reverse: a graph in the official shape loads through the kit.
  const officialFile = path.join(home, "official.jsonl");
  fs.writeFileSync(officialFile, [
    JSON.stringify({ type: "entity", name: "from-official", entityType: "test", observations: ["hello"] }),
    JSON.stringify({ type: "relation", from: "from-official", to: "agnostic-router-kit", relationType: "reads" }),
  ].join("\n") + "\n");
  const viaKit = loadGraph(officialFile);
  ok("kit loader reads the official server's file", viaKit.entities.length === 1 && viaKit.relations.length === 1);
}

// ── C4: mnemosyne import curation policy ────────────────────────────────────
console.log("\nC — mnemosyne import (the curation rule)");
{
  const fixture = path.join(home, "mnemosyne-export.json");
  fs.writeFileSync(fixture, JSON.stringify({
    legacy_memories: [
      { id: "aabbccdd1122", content: "the durable fact worth keeping", source: "fact", timestamp: "2026-10-06T10:00:00", importance: 0.8 },
      { id: "eeff00112233", content: "a second durable memory", source: "lesson", timestamp: "2026-10-06T11:00:00", importance: 0.6 },
    ],
    triples: [{ id: 1, subject: "graphify", predicate: "is-installed-on", object: "hermes-agent", valid_from: "2026-07-13" }],
    working_memory: Array.from({ length: 50 }, (_, i) => ({ id: `w${i}`, content: `transient session row ${i}`, timestamp: "2026-10-06" })),
    consolidated_facts: [{ id: "cf1", subject: "The problem", predicate: "is", object: "the" }],
  }));
  const r = cli(["memory", "import", "--from", "mnemosyne", "--file", fixture]);
  ok("import exits 0", r.status === 0, r.stderr.slice(0, 150));
  const g = loadGraph(store);
  const has = (name) => g.entities.some((e) => e.name.includes(name));
  ok("durable memories imported", has("the durable fact") && has("a second durable memory"), `${g.entities.length} entities`);
  ok("triple became a relation with endpoints", g.relations.some((x) => x.relationType === "is-installed-on") && g.entities.some((e) => e.name === "graphify"));
  ok("working memory NOT imported (noise by rule)", !g.entities.some((e) => (e.observations ?? [])[0]?.includes("transient session row")));
  ok("consolidated facts NOT imported", !g.entities.some((e) => e.name === "The problem"));
  const stats = memoryStats(g);
  ok("stats coherent", stats.entities === g.entities.length && stats.byType.fact === 1);
}

// ── CLI: gc + doctor ─────────────────────────────────────────────────────────
console.log("\nD — CLI gc and doctor");
{
  fs.appendFileSync(store, JSON.stringify({ type: "entity", name: "agnostic-router-kit", entityType: "project", observations: ["the engine edition"] }) + "\n");
  const gDry = cli(["memory", "gc", "--dry-run"]);
  ok("gc --dry-run reports without writing", gDry.status === 0 && /dry run/.test(gDry.stdout));
  const before = loadGraph(store).entities.length;
  const g = cli(["memory", "gc"]);
  const after = loadGraph(store).entities.length;
  ok("gc merges duplicate entities", g.status === 0 && after < before, `${before} → ${after}`);
  const doc = cli(["doctor", "--no-service"]);
  ok("doctor names the memory store", /memory store/.test(doc.stdout));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
else {
  fs.rmSync(home, { recursive: true, force: true });
  console.log("scratch home cleaned up");
}
