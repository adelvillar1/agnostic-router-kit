/**
 * agnostic-router-memory — the kit's native MCP server for the memory plane.
 *
 * Speaks the MCP stdio wire (JSONRPC lines: initialize, tools/list, tools/call)
 * with zero dependencies, exposing the same nine tools as the official
 * knowledge-graph server over the same JSONL format. A harness registers this
 * bin once and its durable memory is the kit's own store:
 *
 *   { "mcpServers": { "memory": {
 *       "command": "node",
 *       "args": ["<kit>/bin/agnostic-router-memory.mjs"],
 *       "env": { "MEMORY_FILE_PATH": "~/.agnostic-router-kit/memory/memory.jsonl" } } } }
 *
 * MEMORY_FILE_PATH is honoured for scratch homes and probes; without it the
 * store lives under the kit home (workflow-plane/memory.mjs). `kit memory
 * config` prints this snippet with real paths.
 */
import path from "node:path";
import { createInterface } from "node:readline";
import {
  loadGraph, saveGraph, createEntities, createRelations, addObservations,
  deleteEntities, deleteObservations, deleteRelations, searchGraph, openNodes,
  memoryStorePath,
} from "workflow-plane/memory.mjs";
import { KIT_VERSION } from "./paths.mjs";

const TOOLS = [
  { name: "create_entities", description: "Create entities in the durable memory graph. Names already present are skipped.", inputSchema: { type: "object", properties: { entities: { type: "array", items: { type: "object", properties: { name: { type: "string" }, entityType: { type: "string" }, observations: { type: "array", items: { type: "string" } } }, required: ["name"] } } }, required: ["entities"] } },
  { name: "create_relations", description: "Create from/to/relationType relations between entities. Identical relations are skipped.", inputSchema: { type: "object", properties: { relations: { type: "array", items: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, relationType: { type: "string" } }, required: ["from", "to", "relationType"] } } }, required: ["relations"] } },
  { name: "add_observations", description: "Add observations to existing entities. Unknown entity is a named error; duplicates are deduped.", inputSchema: { type: "object", properties: { observations: { type: "array", items: { type: "object", properties: { entityName: { type: "string" }, contents: { type: "array", items: { type: "string" } } }, required: ["entityName", "contents"] } } }, required: ["observations"] } },
  { name: "delete_entities", description: "Delete entities and every relation touching them.", inputSchema: { type: "object", properties: { entityNames: { type: "array", items: { type: "string" } } }, required: ["entityNames"] } },
  { name: "delete_observations", description: "Delete specific observations from entities.", inputSchema: { type: "object", properties: { deletions: { type: "array", items: { type: "object", properties: { entityName: { type: "string" }, observations: { type: "array", items: { type: "string" } } }, required: ["entityName", "observations"] } } }, required: ["deletions"] } },
  { name: "delete_relations", description: "Delete specific from/to/relationType relations.", inputSchema: { type: "object", properties: { relations: { type: "array", items: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, relationType: { type: "string" } }, required: ["from", "to", "relationType"] } } }, required: ["relations"] } },
  { name: "read_graph", description: "Read the whole durable memory graph.", inputSchema: { type: "object", properties: {} } },
  { name: "search_nodes", description: "Search the graph: case-insensitive substring over entity names and observations.", inputSchema: { type: "object", properties: { query: { type: "string", description: "Natural language or keyword search" } }, required: ["query"] } },
  { name: "open_nodes", description: "Open named entities with their immediate relations.", inputSchema: { type: "object", properties: { names: { type: "array", items: { type: "string" } } }, required: ["names"] } },
];

// The harness-facing contract: MEMORY_FILE_PATH (absolute) wins — that is how
// a scratch home or an alternate store is wired — otherwise the kit's own
// store under the kit home.
const STORE = process.env.MEMORY_FILE_PATH
  ? path.resolve(process.env.MEMORY_FILE_PATH)
  : memoryStorePath();

function call(name, args) {
  const file = STORE;
  const graph = loadGraph(file);
  let result;
  switch (name) {
    case "create_entities": result = createEntities(graph, args?.entities); break;
    case "create_relations": result = createRelations(graph, args?.relations); break;
    case "add_observations": result = addObservations(graph, args?.observations); break;
    case "delete_entities": result = deleteEntities(graph, args?.entityNames); break;
    case "delete_observations": result = deleteObservations(graph, args?.deletions); break;
    case "delete_relations": result = deleteRelations(graph, args?.relations); break;
    case "read_graph": result = graph; break;
    case "search_nodes": result = { entities: searchGraph(graph, args?.query) }; break;
    case "open_nodes": result = openNodes(graph, args?.names); break;
    default: throw new Error(`Unknown tool: ${name}`);
  }
  if (name !== "read_graph" && name !== "search_nodes" && name !== "open_nodes") saveGraph(result.graph, file);
  return result;
}

function textOf(result) {
  return [{ type: "text", text: JSON.stringify(result?.graph ?? result, null, 2) }];
}

const SERVER_INFO = { name: "agnostic-router-memory", version: KIT_VERSION };

export async function serveStdio({ stdin = process.stdin, stdout = process.stdout, onError = console.error } = {}) {
  const rl = createInterface({ input: stdin, terminal: false });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.method === "initialize") {
      send(stdout, { id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: SERVER_INFO } });
    } else if (msg.method?.startsWith("notifications/")) {
      // notifications carry no reply
    } else if (msg.method === "ping") {
      send(stdout, { id: msg.id, result: {} });
    } else if (msg.method === "tools/list") {
      send(stdout, { id: msg.id, result: { tools: TOOLS } });
    } else if (msg.method === "tools/call") {
      try {
        send(stdout, { id: msg.id, result: { content: textOf(call(msg.params?.name, msg.params?.arguments)) } });
      } catch (e) {
        send(stdout, { id: msg.id, result: { content: [{ type: "text", text: String(e?.message ?? e) }], isError: true } });
      }
    } else if (msg.id !== undefined) {
      send(stdout, { id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    }
  }
}

function send(stdout, msg) {
  stdout.write(JSON.stringify(msg) + "\n");
}

if (process.argv[1] && process.argv[1].endsWith("memory-mcp.mjs")) {
  serveStdio().catch((e) => {
    onError(e);
    process.exit(1);
  });
}
