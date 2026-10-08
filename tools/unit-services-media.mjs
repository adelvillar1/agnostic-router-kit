#!/usr/bin/env node
/**
 * The media service, entirely without the real CLI.
 *
 * media() is the semantic surface cloned one lane over — external binary,
 * flag flattener, JSON-lines parsing, absence-is-a-refusal — with two pinned
 * differences this probe exists to hold. First, the media verbs' exit codes
 * are advisory: they exit 1 on gaps and 3 when nothing could be verified while
 * still printing their accountable row, so a non-zero exit with rows on stdout
 * is a success here (the exit code is the signal, the rows are the payload).
 * Second, a pre-row refusal — usage, unreadable input, no data — prints
 * `{ok: false, error}` on stdout, never stderr (039172e's lesson), so that
 * row's error is what a failure reports. The stub yard is the semantic probe's:
 * tiny node scripts standing in for dev-decisions, pointed at through
 * DEV_DECISIONS_BIN, so every path — happy, noisy, slow, advisory, failing,
 * absent — runs hermetically on any machine. Nothing here talks to a real
 * dev-decisions install, gen1, or any provider; the grant assertions read
 * tools.mjs directly.
 *
 *   node tools/unit-services-media.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const engineDir = path.resolve(import.meta.dirname, "..");
const { media, MEDIA_COMMANDS, MEDIA_TIMEOUT_MS } = await import(path.join(engineDir, "lib", "workflow", "services.mjs"));
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

const yard = fs.mkdtempSync(path.join(os.tmpdir(), "media-probe-"));
function stub(name, body) {
  const p = path.join(yard, name);
  fs.writeFileSync(p, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return p;
}

// Echoes its argv — the proof that --json rides first on every call and that
// args flatten behind it — plus a row shaped like the lane's machine output.
const ECHO_STUB = stub(
  "echo-rows",
  [
    `process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");`,
    `process.stdout.write(JSON.stringify({ op: "media-gate", ok: true, verdict: "pass", lines: [] }) + "\\n");`,
  ].join("\n")
);
const SILENT_STUB = stub("silent", ``);
const NOISY_STUB = stub(
  "noisy",
  [
    `console.log("rendering via qwen ...");`,
    `console.log(JSON.stringify({ op: "media-speak", ok: true, verdict: "ok", duration_seconds: 1.25 }));`,
    `console.log("  note: EVAL-ONLY lane");`,
  ].join("\n")
);
const SLOW_STUB = stub("slow", `setTimeout(() => console.log("{}"), 30_000);`);
// The advisory exit: media-gate found gaps, so it exits 1 (EXIT_WARN) — and
// still prints its row. The row is the payload; the exit is the signal.
const ADVISORY_STUB = stub(
  "advisory",
  [
    `process.stdout.write(JSON.stringify({ op: "media-gate", ok: true, verdict: "gaps", note: "1 verified, 0 refused, 1 with gaps" }) + "\\n");`,
    `process.exit(1);`,
  ].join("\n")
);
// The pre-row refusal: usage was wrong, so no row was ever logged — the refusal
// prints on stdout with exit 3, and its error is what the bridge reports.
const REFUSAL_STUB = stub(
  "refusal",
  [
    `process.stdout.write(JSON.stringify({ op: "media-speak", ok: false, error: "usage: media-speak (--text T | --text-file F) --out FILE" }) + "\\n");`,
    `process.exit(3);`,
  ].join("\n")
);
// A crash with nothing on stdout: the stderr slice is all there is.
const CRASH_STUB = stub("crash", `console.error("gen1 not importable — set DEV_DECISIONS_GEN1_PATH"); process.exit(3);`);

async function withBin(bin, body) {
  const real = process.env.DEV_DECISIONS_BIN;
  process.env.DEV_DECISIONS_BIN = bin;
  try {
    return await body();
  } finally {
    if (real === undefined) delete process.env.DEV_DECISIONS_BIN;
    else process.env.DEV_DECISIONS_BIN = real;
  }
}

// ── the happy paths ──────────────────────────────────────────────────────────

await check("media: --json rides first on every call, rows parse whole", async () => {
  const r = await withBin(ECHO_STUB, () => media("media-gate", { script: "s.txt", audio: "a.bin" }, {}));
  assert.equal(r.ok, true, `refused: ${r.reason}`);
  assert.equal(r.command, "media-gate");
  assert.deepEqual(r.rows[0], { argv: ["media-gate", "--json", "--script", "s.txt", "--audio", "a.bin"] });
  assert.deepEqual(r.rows[1], { op: "media-gate", ok: true, verdict: "pass", lines: [] });
});
await check("media: arrays repeat the flag and null drops it, behind the injected --json", async () => {
  const r = await withBin(ECHO_STUB, () =>
    media("record-asr", { fixtures: "/tmp/fx", language: null }, {})
  );
  assert.equal(r.ok, true, `refused: ${r.reason}`);
  assert.deepEqual(r.rows[0], { argv: ["record-asr", "--json", "--fixtures", "/tmp/fx"] });
});
await check("media: empty stdout is an empty row set, not an error", async () => {
  const r = await withBin(SILENT_STUB, () => media("media-transcribe", { audio: "a.bin" }, {}));
  assert.equal(r.ok, true, `refused: ${r.reason}`);
  assert.deepEqual(r.rows, []);
});
await check("media: non-JSON chatter is skipped, JSON rows kept", async () => {
  const r = await withBin(NOISY_STUB, () => media("media-speak", { text: "hello", out: "o.mp3" }, {}));
  assert.equal(r.ok, true, `refused: ${r.reason}`);
  assert.deepEqual(r.rows, [{ op: "media-speak", ok: true, verdict: "ok", duration_seconds: 1.25 }]);
});

// ── the advisory exits — rows survive a non-zero code ────────────────────────

await check("media: a WARN exit with its row on stdout is a success, row intact", async () => {
  const r = await withBin(ADVISORY_STUB, () => media("media-gate", { script: "s.txt", audio: "a.bin" }, {}));
  assert.equal(r.ok, true, `refused: ${r.reason}`);
  assert.deepEqual(r.rows, [{ op: "media-gate", ok: true, verdict: "gaps", note: "1 verified, 0 refused, 1 with gaps" }]);
  assert.equal(r.refused, undefined);
});
await check("media: a pre-row refusal reports the stdout row's error, not a stderr tail", async () => {
  const r = await withBin(REFUSAL_STUB, () => media("media-speak", { text: "hello" }, {}));
  assert.equal(r.ok, true); // the CLI answered; the row says what it refused
  assert.equal(r.refused, "usage: media-speak (--text T | --text-file F) --out FILE");
  assert.equal(r.rows[0].ok, false);
  assert.equal(r.rows[0].op, "media-speak");
});
await check("media: a crash with no stdout rows falls back to the stderr slice", async () => {
  const r = await withBin(CRASH_STUB, () => media("media-transcribe", { audio: "a.bin" }, {}));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "media media-transcribe failed (exit 3): gen1 not importable — set DEV_DECISIONS_GEN1_PATH");
});

// ── the refusals ─────────────────────────────────────────────────────────────

await check("media: an absent CLI is the pinned media sentence", async () => {
  const r = await withBin(path.join(yard, "no-such-bin"), () => media("media-gate", {}, {}));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "dev-decisions not installed — the media grant needs the dev-decisions CLI with gen1 (see docs)");
});
await check("media: an off-list command is refused, naming what ships", async () => {
  const r = await withBin(ECHO_STUB, () => media("speak", {}, {}));
  assert.equal(r.ok, false);
  assert.equal(
    r.reason,
    "unknown media command: speak (shipped: media-gate, media-transcribe, media-speak, media-imagine, record-asr, record-media-runs, media-budget)",
  );
});
await check("media: the other lanes' verbs stay out of the surface", async () => {
  for (const verb of ["semantic-nn", "forecast-band", "diagram-audit"]) {
    const r = await withBin(ECHO_STUB, () => media(verb, {}, {}));
    assert.equal(r.ok, false, verb);
    assert.match(r.reason, new RegExp(`^unknown media command: ${verb}`));
  }
});
await check("media: a non-object args is refused before any process runs", async () => {
  const r = await withBin(ECHO_STUB, () => media("media-gate", "s.txt", {}));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "media args must be an object of CLI flags");
});
await check("media: a child past its timeout is killed, and the refusal names the ms", async () => {
  const t0 = Date.now();
  const r = await withBin(SLOW_STUB, () => media("media-speak", {}, { timeoutMs: 500 }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /exceeded 500ms wall clock — child killed/);
  assert.ok(Date.now() - t0 < 5000, "the kill should fire near the 500ms cap, not the stub's own sleep");
});
await check("media: the default timeout is a minutes-scale batch budget", () => {
  assert.equal(MEDIA_TIMEOUT_MS, 300_000);
});

// ── the grant: default-off, known, and never pre-granted ─────────────────────

await check("grant: media is a known capability and default-off", () => {
  assert.ok(CAPABILITIES.media, "CAPABILITIES must declare media");
  assert.equal(CAPABILITIES.media.granted, false);
  assert.ok(CAPABILITIES.media.what.includes("eval-only"), "the grant names the lane's eval-only law");
});
await check("grant: resolveGrants({}) holds no media", () => {
  const g = resolveGrants({});
  assert.ok(!g.held.has("media"), "defaults must not include media");
  assert.ok(!g.summary().includes("media"));
});
await check("grant: --grant media is accepted, so a run can opt in", () => {
  const g = resolveGrants({ grants: "media" });
  assert.ok(g.held.has("media"));
});

// ── the tally ────────────────────────────────────────────────────────────────

fs.rmSync(yard, { recursive: true, force: true });
if (failures.length) {
  console.log(`  failed: ${failures.join(" | ")}`);
}
console.log(`unit-services-media: ${pass} cases pass, ${failures.length} fail`);
process.exitCode = failures.length ? 1 : 0;
