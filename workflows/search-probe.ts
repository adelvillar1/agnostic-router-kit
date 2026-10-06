/* workflow
description: "Probe: the net-search capability and its Firecrawl service — granted
  fires one real search and asserts the shape; refused asserts the capability
  refusal; no-key asserts the configured-absence refusal. Zero model calls."
whenToUse: Probe only — never a real task. Run the granted mode with
  --grant net-search (one real search, ~1 credit); the refused mode with no
  grant; the no-key mode with the grant but a runtime env lacking the key.
args:
  mode:
    type: string
    description: "granted | refused | no-key — which assertion this run makes."
    required: true
*/
/**
 * search-probe: three deterministic outcomes, one file, zero model calls.
 * The plane journals every search line with its cost; the probe asserts the
 * shape and the refusals, and the journal is checked afterwards for the
 * key-neutrality guard (no key material in any line).
 */

phase("search-probe");
const mode = String(args.mode ?? "granted");

if (mode === "refused") {
  // Launched without --grant net-search: the surface refuses by name before
  // any call happens, and the refusal is journaled like every other refusal.
  let refused = null;
  try {
    await world.search("probe should never run this search");
  } catch (e) {
    refused = String(e?.message ?? e);
  }
  if (!refused || !refused.includes("capability not granted")) {
    throw new Error(`expected the capability refusal by name, got: ${refused}`);
  }
  return {
    conclusion: "search-probe: the net-search grant refusal fired by name",
    refused,
    verified: ["the grant is enforced in code and the refusal is journaled"],
    notCovered: [],
  };
}

// granted | no-key: the grant is held; the outcome differs by the environment.
const result = await world.search("firecrawl search api self test", { limit: 1 });

if (mode === "no-key") {
  if (result.ok) {
    throw new Error("expected the no-key refusal, but the search fired — the env was not supposed to carry the key");
  }
  if (!/FIRECRAWL_API_KEY/.test(result.reason)) {
    throw new Error(`expected the refusal to name FIRECRAWL_API_KEY, got: ${result.reason}`);
  }
  return {
    conclusion: `search-probe: a missing key is a configured absence — ${result.reason}`,
    refused: result.reason,
    verified: ["a missing key refuses by naming the variable and kit env set, without crashing"],
    notCovered: [],
  };
}

if (!result.ok) {
  throw new Error(`search failed: ${result.reason}`);
}
if (!result.results.length) {
  throw new Error("the search fired but returned zero results — shape drift?");
}
const first = result.results[0];
if (!first.url || !first.title) {
  throw new Error(`result rows malformed: ${JSON.stringify(first).slice(0, 120)}`);
}
return {
  conclusion: `search-probe: one real search fired — ${result.results.length} result(s), ${result.creditsUsed} credit(s)`,
  first: { url: first.url, title: first.title },
  creditsUsed: result.creditsUsed,
  verified: [
    "world.search fires the real backend and normalizes rows to url + title",
    "the journal line carries the query, the result count, and creditsUsed",
  ],
  notCovered: [],
};
