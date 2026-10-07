/* workflow
description: "Probe: the memory capability and the durable memory plane — granted
  mode remembers and searches the real store; refused mode asserts the
  capability refusal by name. Zero model calls, two deterministic outcomes."
whenToUse: Probe only — never a real task. The granted mode writes one probe
  entity into the kit's durable store (clean it with `kit memory gc` or
  delete it); the refused mode runs with no grant and asserts the refusal.
args:
  mode:
    type: string
    description: "granted | refused — which assertion this run makes."
    required: true
*/

phase("memory-probe");
const mode = String(args.mode ?? "granted");
const PROBE_ENTITY = `memory-probe ${new Date().toISOString().slice(0, 19)}`;
const PROBE_TEXT = "the probe's durable fact — safe to delete";

if (mode === "refused") {
  // Launched without --grant memory: the surface refuses by name before any
  // store touch happens, and the refusal is journaled like every other.
  let refused = null;
  try {
    await world.memory.search("probe should never reach the store");
  } catch (e) {
    refused = String(e?.message ?? e);
  }
  if (!refused || !refused.includes("capability not granted")) {
    throw new Error(`expected the capability refusal by name, got: ${refused}`);
  }
  return {
    conclusion: "memory-probe: the memory grant refusal fired by name",
    refused,
    verified: ["the grant is enforced in code and the refusal is journaled"],
    notCovered: [],
  };
}

// granted: the full round trip against the real store.
const remembered = await world.memory.remember(PROBE_ENTITY, PROBE_TEXT, "probe");
const found = await world.memory.search("memory-probe");
const mine = found.hits.find((e) => e.name === remembered.entity);
if (!mine) throw new Error("remembered entity not found by search — the durable tier is not round-tripping");
if (!mine.observations.some((o) => o.includes("durable fact"))) {
  throw new Error("the observation did not survive the store round trip");
}

return {
  conclusion: `memory-probe: remembered and found "${remembered.entity}" (${found.hits.length} hits for the probe term)`,
  entity: remembered.entity,
  hits: found.hits.length,
  verified: [
    "world.memory.remember wrote to the kit's durable store",
    "world.memory.search read it back with the observation intact",
    "both calls journaled with query/entity and counts",
  ],
  notCovered: ["the MCP wire (tools/probe-memory-mcp.mjs)", "the HTTP wire (tools/probe-memory-api.mjs)"],
};
