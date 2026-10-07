#!/usr/bin/env node
/**
 * The memory MCP server's probe: spawns bin/agnostic-router-memory.mjs over
 * stdio against a seeded scratch store and drives the full protocol — the
 * same wire a harness speaks. Zero model calls, zero network.
 *
 * Covers C1: initialize handshake, nine tools, search_nodes over seeded
 * content, a write/search/delete roundtrip, and the error shape for an
 * unknown entity.
 *
 * Usage: node tools/probe-memory-mcp.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const KIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "memory-mcp-probe-"));
const store = path.join(home, "memory", "memory.jsonl");
fs.mkdirSync(path.dirname(store), { recursive: true });
fs.writeFileSync(store, [
  JSON.stringify({ type: "entity", name: "seed entity one", entityType: "fact", observations: ["the probe's seeded durable fact", "recorded: 2026-10-06"] }),
  JSON.stringify({ type: "entity", name: "seed entity two", entityType: "lesson", observations: ["a second seeded row"] }),
  JSON.stringify({ type: "relation", from: "seed entity one", to: "seed entity two", relationType: "precedes" }),
].join("\n") + "\n");

let passed = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const proc = spawn(process.execPath, [path.join(KIT_DIR, "bin", "agnostic-router-memory.mjs")], {
  env: { ...process.env, MEMORY_FILE_PATH: store },
  stdio: ["pipe", "pipe", "pipe"],
});
let buf = "";
const pending = new Map();
let nextId = 1;
proc.stdout.on("data", (c) => {
  buf += c.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    } catch {}
  }
});
proc.stderr.on("data", () => {});
const call = (method, params) => new Promise((res) => {
  const id = nextId++;
  pending.set(id, res);
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const tool = async (name, args) => {
  const r = await Promise.race([
    call("tools/call", { name, arguments: args ?? {} }),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${name} timeout`)), 15000)),
  ]);
  return { text: r.result?.content?.[0]?.text ?? "", isError: Boolean(r.result?.isError) };
};
const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };

try {
  const init = await Promise.race([
    call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe", version: "0" } }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("initialize timeout")), 15000)),
  ]);
  ok("initialize handshake", Boolean(init.result?.serverInfo?.name), JSON.stringify(init).slice(0, 120));
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const tools = await call("tools/list", {});
  const names = (tools.result?.tools ?? []).map((t) => t.name);
  ok("nine tools listed", ["create_entities", "create_relations", "add_observations", "delete_entities", "delete_observations", "delete_relations", "read_graph", "search_nodes", "open_nodes"].every((t) => names.includes(t)), names.join(","));

  const graph = parse((await tool("read_graph")).text);
  ok("read_graph returns the seed", graph?.entities?.length === 2 && graph.relations.length === 1);

  const hits = parse((await tool("search_nodes", { query: "SEEDED DURABLE" })).text);
  ok("search is case-insensitive over observations", hits?.entities?.length === 1, JSON.stringify(hits).slice(0, 120));

  await tool("create_entities", { entities: [{ name: "probe write", entityType: "test", observations: ["written over MCP"] }] });
  const roundtrip = parse((await tool("search_nodes", { query: "probe write" })).text);
  ok("write/search roundtrip over MCP", roundtrip?.entities?.length === 1);

  const persisted = fs.readFileSync(store, "utf8").split("\n").filter((l) => l.includes("probe write"));
  ok("write landed in the store file", persisted.length === 1);

  await tool("delete_entities", { entityNames: ["probe write"] });
  const afterDelete = parse((await tool("search_nodes", { query: "probe write" })).text);
  ok("delete roundtrip", afterDelete?.entities?.length === 0);

  const err = await tool("add_observations", { observations: [{ entityName: "no such entity", contents: ["x"] }] });
  ok("unknown entity is a named isError", err.isError && err.text.includes("no such entity"), err.text.slice(0, 120));

  const open = parse((await tool("open_nodes", { names: ["seed entity one"] })).text);
  ok("open_nodes returns node + immediate relations", open?.entities?.length === 1 && open.relations.length === 1);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  proc.kill();
  if (!failures.length && !process.env.KEEP_SCRATCH) {
    fs.rmSync(home, { recursive: true, force: true });
    console.log("scratch home cleaned up");
  } else {
    console.log(`scratch home: ${home}`);
  }
  process.exit(failures || process.exitCode ? 1 : 0);
}
