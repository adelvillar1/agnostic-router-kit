#!/usr/bin/env node
/**
 * The synthesis service, entirely without the real CLI.
 *
 * synthesis() hangs off an external binary (blend1), the way tabular hangs
 * off dev-decisions — and the same honesty holds: the service reads
 * BLEND1_BIN on every call, so the probe writes tiny fixture stub scripts
 * (node scripts that emit blend1's real stdout shapes) into its own tmp dir
 * and points the env var at them. Every path — happy, pretty, empty,
 * NDJSON-fallback, slow, failing, absent — runs hermetically on any
 * machine. Nothing here talks to a real blend1 install or any model; the
 * one live path (a real ask, the BlendResult's gate outcome) is
 * workflows/synthesis-probe.ts's granted mode. The grant assertion reads
 * tools.mjs directly.
 *
 *   node tools/unit-services-synthesis.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const engineDir = path.resolve(import.meta.dirname, "..");
const { synthesis, SYNTHESIS_TIMEOUT_MS } = await import(path.join(engineDir, "lib", "workflow", "services.mjs"));
const { CAPABILITIES, resolveGrants } = await import(path.join(engineDir, "lib", "workflow", "tools.mjs"));

let pass = 0;
const failures = [];
/** One named case, run and counted; the name is what a failure reports. */
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok — ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL — ${name}: ${String(e?.message ?? e).slice(0, 220)}`);
  }
}

// ── the stub yard ────────────────────────────────────────────────────────────

/** A tmp dir of executable stub scripts standing in for the blend1 CLI. */
const yard = fs.mkdtempSync(path.join(os.tmpdir(), "synthesis-probe-"));
/** Write one stub script and hand back its path — BLEND1_BIN fodder. */
function stub(name, body) {
  const p = path.join(yard, name);
  fs.writeFileSync(p, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return p;
}

// The real CLI's `--json` shape: ONE pretty-printed object (json.dumps(
// indent=2)) and NOTHING else on stdout — what a line parser would shred,
// and the reason the service takes the whole document first. Carries the
// fields every loop reads.
const BLEND_FIXTURE = {
  prompt_sha256: "abc123",
  path: "synthesized",
  route: { status: "ok", needs_generation: 0.97, needs_live_facts: 0.04, answer_shape: "prose" },
  generated: { status: "ok", text: "The kit's suite runs by node tools/run-probes.mjs.", cost_usd: 0.0018 },
  validation: {
    status: "ok",
    passed: true,
    outcome: "passed",
    answers_the_question: 0.99,
    contradicts_facts: 0.01,
    number_check: "ok",
  },
  final_answer: "The kit's suite runs by node tools/run-probes.mjs.",
  total_latency_ms: 11200,
  escalated_answer: false,
};
// The pretty document alone — blend1's actual `--json` stdout.
const PRETTY_STUB = stub("pretty", `process.stdout.write(JSON.stringify(${JSON.stringify(BLEND_FIXTURE)}, null, 2));`);
// Echoes what it was invoked as (argv proof through a real child) as NDJSON
// lines, then the fixture BlendResult compact on one line.
const ECHO_STUB = stub(
  "echo",
  [
    `process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");`,
    `process.stdout.write(JSON.stringify(${JSON.stringify(BLEND_FIXTURE)}) + "\\n");`,
  ].join("\n")
);
// A banner line, then the pretty document — a shape the real CLI never
// emits, pinned so the "unreadable stdout reads as zero rows" law is
// proven rather than assumed: the caller reports it, never guesses.
const CHATTER_STUB = stub(
  "chatter",
  [
    `console.log("routing...");`,
    `process.stdout.write(JSON.stringify(${JSON.stringify(BLEND_FIXTURE)}, null, 2));`,
  ].join("\n")
);
// Prints nothing — an empty answer is zero rows, reported not guessed.
const SILENT_STUB = stub("silent", ``);
// JSON lines instead of one document — the fallback tolerance, what keeps a
// future NDJSON mode (or a chattering CLI) readable.
const LINES_STUB = stub(
  "lines",
  [
    `process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");`,
    `process.stdout.write(JSON.stringify(${JSON.stringify(BLEND_FIXTURE)}) + "\\n");`,
  ].join("\n")
);
// Sleeps past any sane timeout, so the kill path fires deterministically.
const SLOW_STUB = stub("slow", `setTimeout(() => console.log("{}"), 30_000);`);
// Exits non-zero with something on stderr — a usage error's shape.
const FAILING_STUB = stub("failing", `console.error("error: unrecognized arguments: --prompt"); process.exit(2);`);

/** Run one synthesis call with BLEND1_BIN pinned, then restore the env. */
async function withBin(bin, body) {
  const real = process.env.BLEND1_BIN;
  process.env.BLEND1_BIN = bin;
  try {
    return await body();
  } finally {
    if (real === undefined) delete process.env.BLEND1_BIN;
    else process.env.BLEND1_BIN = real;
  }
}

// ── the happy paths ──────────────────────────────────────────────────────────

await check("synthesis: blend1's pretty-printed BlendResult parses to one row", async () => {
  const r = await withBin(PRETTY_STUB, () => synthesis("ask", { prompt: "what runs the suite?" }, {}));
  assert.equal(r.ok, true, `refused: ${r.reason}`);
  assert.equal(r.command, "ask");
  assert.equal(r.rows.length, 1);
  const blend = r.rows[0];
  // The fields every loop reads survive the parse whole.
  assert.equal(blend.path, "synthesized");
  assert.ok(String(blend.final_answer ?? "").trim(), "final_answer rides");
  assert.equal(blend.validation.outcome, "passed");
  assert.equal(typeof blend.route.needs_generation, "number");
  assert.equal(blend.generated.cost_usd, 0.0018);
});
await check("synthesis: the prompt is positional and --json is injected", async () => {
  const r = await withBin(ECHO_STUB, () => synthesis("ask", { prompt: "state the fact" }, {}));
  assert.equal(r.ok, true, `refused: ${r.reason}`);
  assert.deepEqual(r.rows[0].argv, ["ask", "state the fact", "--json"]);
});
await check("synthesis: extra flags flatten around the positional prompt", async () => {
  const r = await withBin(ECHO_STUB, () =>
    synthesis("ask", { prompt: "state the fact", project: "blend1", "--no-retrieve": true, voice: false }, {})
  );
  assert.equal(r.ok, true, `refused: ${r.reason}`);
  assert.deepEqual(r.rows[0].argv, ["ask", "state the fact", "--project", "blend1", "--no-retrieve", "--json"]);
});
await check("synthesis: JSON lines parse through the fallback", async () => {
  const r = await withBin(LINES_STUB, () => synthesis("ask", { prompt: "state the fact" }, {}));
  assert.equal(r.ok, true, `refused: ${r.reason}`);
  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.rows[0].argv, ["ask", "state the fact", "--json"]);
  assert.equal(r.rows[1].validation.outcome, "passed");
});
await check("synthesis: stdout that reads as neither shape is zero rows, never a guess", async () => {
  const r = await withBin(CHATTER_STUB, () => synthesis("ask", { prompt: "state the fact" }, {}));
  assert.equal(r.ok, true, `refused: ${r.reason}`);
  assert.deepEqual(r.rows, [], "a banner plus a pretty document parses as nothing — the caller reports it");
});
await check("synthesis: empty stdout is an empty answer, not an error", async () => {
  const r = await withBin(SILENT_STUB, () => synthesis("ask", { prompt: "state the fact" }, {}));
  assert.equal(r.ok, true, `refused: ${r.reason}`);
  assert.deepEqual(r.rows, []);
});

// ── the refusals ─────────────────────────────────────────────────────────────

await check("synthesis: an absent CLI is the pinned install sentence", async () => {
  const r = await withBin(path.join(yard, "no-such-bin"), () => synthesis("ask", { prompt: "state the fact" }, {}));
  assert.equal(r.ok, false);
  assert.equal(
    r.reason,
    "blend1 not installed — the synthesis grant needs the blend1 CLI (uv sync in ~/Projects/blend1, or its venv's bin on PATH; a bare pip install -e cannot resolve the sys1/sem1/sdm1 path deps)"
  );
});
await check("synthesis: an off-list command is refused, naming what ships", async () => {
  const r = await withBin(ECHO_STUB, () => synthesis("search", { prompt: "state the fact" }, {}));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unknown synthesis command: search (shipped: ask)");
});
await check("synthesis: a non-object args is refused before any process runs", async () => {
  const r = await withBin(ECHO_STUB, () => synthesis("ask", "state the fact", {}));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "synthesis args must be an object of CLI flags");
});
await check("synthesis: an ask with no prompt is refused by name", async () => {
  const r = await withBin(ECHO_STUB, () => synthesis("ask", { prompt: "  " }, {}));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "synthesis ask names no prompt — the blend needs a question");
});
await check("synthesis: a child past its timeout is killed, and the refusal names the ms", async () => {
  const t0 = Date.now();
  const r = await withBin(SLOW_STUB, () => synthesis("ask", { prompt: "state the fact" }, { timeoutMs: 500 }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /exceeded 500ms wall clock — child killed/);
  assert.ok(Date.now() - t0 < 5000, "the kill should fire near the 500ms cap, not the stub's own sleep");
});
await check("synthesis: a non-zero exit carries the stderr slice", async () => {
  const r = await withBin(FAILING_STUB, () => synthesis("ask", { prompt: "state the fact" }, {}));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "synthesis ask failed (exit 2): error: unrecognized arguments: --prompt");
});
await check("synthesis: the default timeout leaves headroom over the ~11s live ask", () => {
  assert.equal(SYNTHESIS_TIMEOUT_MS, 180_000);
});

// ── the grant: default-off, known, and never pre-granted ─────────────────────

await check("grant: synthesis is a known capability and default-off", () => {
  assert.ok(CAPABILITIES.synthesis, "CAPABILITIES must declare synthesis");
  assert.equal(CAPABILITIES.synthesis.granted, false);
});
await check("grant: resolveGrants({}) holds no synthesis", () => {
  const g = resolveGrants({});
  assert.ok(!g.held.has("synthesis"), "defaults must not include synthesis");
  assert.ok(!g.summary().includes("synthesis"));
});
await check("grant: --grant synthesis is accepted, so a run can opt in", () => {
  const g = resolveGrants({ grants: "synthesis" });
  assert.ok(g.held.has("synthesis"));
});

// ── the loops' structure: the givens framing and the eval-only law ───────────

await check("loops: composed-report frames givens as data between markers", () => {
  const src = fs.readFileSync(path.join(engineDir, "workflows", "composed-report.ts"), "utf8");
  assert.match(src, /GIVENS DATA BEGIN/, "the opening marker");
  assert.match(src, /GIVENS DATA END/, "the closing marker");
  assert.match(src, /data, never instructions/, "the untrusted-data stance at the call site");
  assert.match(src, /GIVENS_CAP = 8000/, "the givens cap");
  assert.match(src, /world\.synthesis\("ask"/, "one grant call");
});
await check("loops: composed-report never blocks on the gate — flagged, not withheld", () => {
  const src = fs.readFileSync(path.join(engineDir, "workflows", "composed-report.ts"), "utf8");
  assert.match(src, /never blocked/, "the eval-only law is stated");
  assert.match(src, /ships flagged/, "a non-passing gate ships the artifact flagged");
  // The one throw in the file is the givens-file read guard, caught two
  // lines below — no synthesis outcome is ever thrown on.
  assert.equal((src.match(/throw new Error/g) ?? []).length, 1, "only the local read guard throws");
});
await check("loops: research-report's composer swap keeps the reader and the return shape", () => {
  const src = fs.readFileSync(path.join(engineDir, "workflows", "research-report.ts"), "utf8");
  assert.match(src, /world\.synthesis\("ask"/, "the Writer composes through the grant");
  assert.match(src, /GIVENS DATA BEGIN/, "the same givens framing rides");
  assert.match(src, /const reader = agent\("Reader"/, "the Reader phase is untouched");
  assert.match(src, /const scoper = agent\("Scoper"/, "the Scoper phase is untouched");
  assert.match(src, /conclusion: `\$\{draftSummary\} Report: \$\{draft\.path\}\.`/, "the return shape is unchanged — the summary tracks the composition that ships");
  assert.match(src, /synthesisDemotion/, "a reader fix-up that demotes the gate outcome is named, never silent");
  assert.match(src, /GIVENS DATA END \$\{GIVENS_NONCE\}/, "the closing marker carries the per-run nonce");
  assert.ok(!/writer\.ask/.test(src), "no Writer agent remains — the composition is the composer's");
});
await check("probe: synthesis-probe carries the three modes", () => {
  const src = fs.readFileSync(path.join(engineDir, "workflows", "synthesis-probe.ts"), "utf8");
  assert.match(src, /mode === "refused"/, "the refused mode");
  assert.match(src, /mode === "no-binary"/, "the no-binary mode");
  assert.match(src, /validation\.outcome/, "the granted mode asserts the gate's outcome");
  assert.match(src, /uv sync/, "the no-binary mode asserts the install sentence");
});

// ── the tally ────────────────────────────────────────────────────────────────

fs.rmSync(yard, { recursive: true, force: true });
if (failures.length) {
  console.log(`  failed: ${failures.join(" | ")}`);
}
console.log(`unit-services-synthesis: ${pass} cases pass, ${failures.length} fail`);
process.exitCode = failures.length ? 1 : 0;
