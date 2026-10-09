#!/usr/bin/env node
/**
 * narrate's seam, executed and held (C4).
 *
 * The loop's promise: render narration through the media lane, assemble the
 * hyperframes seam from the engine's own accountable rows, and gate the result
 * against the script — advisory, never blocking. Proven here by driving the
 * REAL workflow body (the plane's own `annotateAskSites` transform, the
 * surface bound as globals by this probe, `export default async function`)
 * over stub CLIs answering in the lane's pinned machine rows, with
 * the plane-side writes going through the kit's own `worldRun` into a real
 * temp workspace so the seam files are read back off disk rather than trusted:
 *
 *   1. verify mode gates a planted script/audio pair on the pass path and the
 *      gaps path, escalating exactly once on gaps and never blocking — the
 *      artifact and the normal result are still produced;
 *   2. the error path (nothing verified) refuses by name and escalates not at
 *      all, and a transport refusal fails the loop open with the CLI's own
 *      sentence;
 *   3. a `--project` path-escape is the engine's refusal by name, passed
 *      through verbatim — the loop resolves nothing itself;
 *   4. render mode speaks each line, stages the request in the seam's dialect,
 *      assembles audio_meta.json from the speak rows themselves (the row's
 *      target as the path, its byte-measured duration, its leg, its request
 *      id), and gates the seam it just built;
 *   5. a refused line is omitted from the meta and named, so a partial run is
 *      never mistaken for a complete one; a served container that disagrees
 *      with the filename is named too;
 *   6. dryRun calls no speak leg and writes no meta, and still gates;
 *   7. the structure — the file spawns no agent, publishes exactly one
 *      artifact, and carries the never-blocks marker.
 *
 *   node tools/probe-narrate.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const engineDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { media } = await import(path.join(engineDir, "lib", "workflow", "services.mjs"));
const { annotateAskSites } = await import(path.join(engineDir, "lib", "workflow", "schema.mjs"));
const { worldRun, resolveGrants } = await import(path.join(engineDir, "lib", "workflow", "tools.mjs"));

let pass = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok — ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL — ${name}: ${String(e?.message ?? e).slice(0, 300)}`);
  }
}

const yard = fs.mkdtempSync(path.join(os.tmpdir(), "narrate-probe-"));
const workspace = path.join(yard, "ws");
fs.mkdirSync(path.join(workspace, "assets", "voice"), { recursive: true });

// ── the stub CLIs: the lane's pinned rows, one scenario per file ─────────────
// Each stub answers media-speak (keyed by the --out basename, so a per-line
// answer is a real per-line answer) and media-gate (echoing the --request or
// --script it was handed, so the target proves what rode the wire), and drops
// its argv into a file.
function stub(name, { speak = {}, gate }) {
  const p = path.join(yard, name);
  const argvFile = path.join(yard, `${name}.argv`);
  const body = [
    `#!/usr/bin/env node`,
    `require("node:fs").appendFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
    `const argv = process.argv.slice(2);`,
    `const flag = (n) => { const i = argv.indexOf("--" + n); return i < 0 ? null : argv[i + 1]; };`,
    `const cmd = argv[0];`,
    `if (cmd === "media-speak") {`,
    `  const out = flag("out");`,
    `  const rows = ${JSON.stringify(speak)};`,
    `  const key = Object.keys(rows).find((k) => out.endsWith("/" + k + ".mp3") || out.endsWith("/" + k + ".wav"));`,
    `  const r = key ? rows[key] : null;`,
    `  if (!r) { process.exit(2); }`,
    `  process.stdout.write(JSON.stringify(Object.assign({ op: "media-speak", ok: true, target: out, task: "media_speak", escalated: false }, r)) + "\\n");`,
    `  process.exit(0);`,
    `}`,
    `if (cmd === "media-gate") {`,
    `  const target = flag("request") || flag("script") || "seam";`,
    `  const seam = flag("request") !== null;`,
    `  const rows = ${JSON.stringify(gate.rows)};`,
    `  for (const r of rows) { process.stdout.write(JSON.stringify(Object.assign({ target, mode: seam ? "seam" : "single" }, r)) + "\\n"); }`,
    `  process.exit(${gate.exit ?? 0});`,
    `}`,
    `process.exit(2);`,
  ];
  fs.writeFileSync(p, body.join("\n"), { mode: 0o755 });
  return p;
}

const line = (id, agreement, missing, extra, ref = 6, got = 6) => ({
  id,
  agreement,
  ref_tokens: ref,
  got_tokens: got,
  missing,
  extra,
  audio_sha256: `sha-${id}`,
});
const gateRow = (over) => ({
  op: "media-gate",
  ok: true,
  provider: "gen1_raw/stepfun",
  task: "media_gate",
  input_sha256: "sha-in",
  escalated: false,
  ...over,
});

const SPEAK_OK = {
  l1: { provider: "gen1_raw/qwen", duration_seconds: 2.5, format: "mp3", sample_rate: 24000, request_id: "req-l1", voice: "Cherry", verdict: "ok" },
  l2: { provider: "gen1_raw/qwen", duration_seconds: 3.25, format: "mp3", sample_rate: 24000, request_id: "req-l2", voice: "Cherry", verdict: "ok" },
};
const SPEAK_WAV = {
  l1: SPEAK_OK.l1,
  // A leg that serves wav into a .mp3 filename: the row's format is the truth.
  l2: { provider: "gen1_raw/stepfun", duration_seconds: 3.25, format: "wav", sample_rate: 44100, request_id: "req-l2", voice: "cixingnansheng", verdict: "ok" },
};
const SPEAK_ONE_REFUSED = {
  l1: SPEAK_OK.l1,
  l2: { provider: "gen1_raw", verdict: "refused" },
};

const GATE_PASS = { rows: [gateRow({ lines: [line("script.txt", 1.0, 0, 0)], refused: [], verdict: "pass", note: "1 verified, 0 refused, 0 with gaps" })] };
const GATE_GAPS = {
  rows: [gateRow({ lines: [line("script.txt", 0.75, 2, 1, 6, 5)], refused: [], verdict: "gaps", note: "1 verified, 0 refused, 1 with gaps" })],
  exit: 1, // the lane's advisory WARN exit — the bridge treats rows as payload
};
const GATE_ERROR = {
  rows: [gateRow({ lines: [], refused: [{ id: "script.txt", error: "transcription refused — gen1_raw has no ASR leg" }], verdict: "error", note: "0 verified, 1 refused, 0 with gaps" })],
  exit: 3,
};
const GATE_REFUSED = { rows: [{ ok: false, error: "media-gate: cannot read script/audio: [Errno 2] No such file or directory: 'nope.mp3'" }], exit: 3 };
const GATE_ESCAPE = {
  rows: [
    gateRow({
      lines: [],
      refused: [{ id: "l1", error: "path escapes --project: ../outside.mp3" }],
      verdict: "error",
      note: "0 verified, 1 refused, 0 with gaps",
    }),
  ],
  exit: 3,
};
const GATE_SEAM_PASS = { rows: [gateRow({ lines: [line("l1", 1.0, 0, 0), line("l2", 0.98, 0, 0)], refused: [], verdict: "pass", note: "2 verified, 0 refused, 0 with gaps" })] };
const GATE_SEAM_GAPS = {
  rows: [
    gateRow({
      lines: [line("l1", 1.0, 0, 0)],
      refused: [{ id: "l2", error: "no rendered audio for line l2" }],
      verdict: "gaps",
      note: "1 verified, 1 refused, 0 with gaps",
    }),
  ],
  exit: 1,
};
const GATE_NO_META = {
  rows: [gateRow({ lines: [], refused: [{ id: "?", error: "unreadable seam: [Errno 2] No such file or directory: 'assets/voice/audio_meta.json'" }], verdict: "error", note: "0 verified, 1 refused, 0 with gaps" })],
  exit: 3,
};

const PASS_STUB = stub("pass", { gate: GATE_PASS });
const GAPS_STUB = stub("gaps", { gate: GATE_GAPS });
const ERROR_STUB = stub("error", { gate: GATE_ERROR });
const REFUSED_STUB = stub("refused", { gate: GATE_REFUSED });
const ESCAPE_STUB = stub("escape", { gate: GATE_ESCAPE });
const RENDER_STUB = stub("render", { speak: SPEAK_OK, gate: GATE_SEAM_PASS });
const RENDER_WAV_STUB = stub("render-wav", { speak: SPEAK_WAV, gate: GATE_SEAM_PASS });
const RENDER_REFUSED_STUB = stub("render-refused", { speak: SPEAK_ONE_REFUSED, gate: GATE_SEAM_GAPS });
const DRYRUN_STUB = stub("dryrun", { speak: {}, gate: GATE_NO_META });
const ABSENT = path.join(yard, "no-such-cli");

// The planted request: three lines, the third empty — the loop must skip it
// before a leg is spent on it, and name the skip.
const REQUEST = { lines: [{ id: "l1", text: "The router decides." }, { id: "l2", text: "The engine logs." }, { id: "l3", text: "   " }] };
fs.writeFileSync(path.join(workspace, "request.json"), JSON.stringify(REQUEST));
fs.writeFileSync(path.join(workspace, "script.txt"), "The router decides.\n");

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

// ── the loop, driven through the plane's own transform ───────────────────────
const source = fs.readFileSync(path.join(engineDir, "workflows", "narrate.ts"), "utf8");
const moduleText = `export default async function __wfRun() {\n${annotateAskSites(source).source}\n}`;
const modulePath = path.join(yard, "narrate.mts");
fs.writeFileSync(modulePath, moduleText);
const mod = await import(new URL(`file://${modulePath}`).href);

/** Bind the run surface as globals — the engine's own line — and call the loop. */
async function drive(runArgs) {
  // Every drive starts with a clean wire record: the stubs append, so a
  // leftover line would be another drive's call counted as this one's.
  for (const f of fs.readdirSync(yard)) {
    if (f.endsWith(".argv")) fs.rmSync(path.join(yard, f));
  }
  const collected = { logs: [], phases: [], reports: [], artifacts: [], escalations: [] };
  const grants = resolveGrants({});
  const api = {
    args: runArgs,
    log: (m) => collected.logs.push(String(m)),
    phase: (n) => collected.phases.push(String(n)),
    report: (item) => collected.reports.push(item),
    escalate: async (question, context, tag) => {
      collected.escalations.push({ question: String(question), context: String(context), tag: String(tag) });
      return "accept the drift";
    },
    artifact: {
      markdown: async (id, content, opts) => {
        collected.artifacts.push({ id, content: String(content), title: opts?.title ?? id, primary: opts?.primary ?? false });
        return { id, version: 1 };
      },
      file: async (id) => {
        throw new Error(`narrate must never publish a file artifact (${id})`);
      },
    },
    files: {
      // The real workspace read, so the planted request is really read.
      read: (rel) => fs.readFileSync(path.join(workspace, String(rel)), "utf8"),
      glob: () => [],
      grep: () => [],
    },
    world: {
      // The kit's own bridge, so the advisory-exit and stdout-refusal handling
      // under test here is the one a real run exercises.
      // The engine's binding, cwd included: the lane's paths are
      // workspace-relative, so the CLI runs in the run's workspace.
      media: (command, callArgs, callOpts) => media(command, callArgs, { ...callOpts, cwd: workspace }),
      // The kit's own worldRun into the temp workspace, so the seam files are
      // written for real and read back off disk.
      run: (command, args) => worldRun(command, args, workspace, grants, () => {}),
    },
  };
  const keys = Object.keys(api);
  for (const k of keys) globalThis[k] = api[k];
  try {
    const result = await mod.default();
    return { ...collected, result };
  } finally {
    for (const k of keys) delete globalThis[k];
  }
}

const argvLines = (name, n) => fs.readFileSync(path.join(yard, `${name}.argv`), "utf8").trim().split("\n").slice(-n);
const argvAll = (name) => {
  try {
    return fs.readFileSync(path.join(yard, `${name}.argv`), "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
};
const md = (run) => run.artifacts.find((a) => a.id === "narrate")?.content ?? "";
const readWs = (rel) => JSON.parse(fs.readFileSync(path.join(workspace, rel), "utf8"));

// ── verify mode: one file, gated, advisory ──────────────────────────────────

await check("verify mode gates a single file on the pass path and escalates nothing", async () => {
  const run = await withBin(PASS_STUB, () => drive({ script: "script.txt", audio: "out/script.mp3" }));
  const argv = argvLines("pass", 1);
  assert.deepEqual(JSON.parse(argv[0]), ["media-gate", "--json", "--script", "script.txt", "--audio", "out/script.mp3"]);
  const r = run.result;
  assert.equal(r.failOpen, undefined, `fail-open fired: ${r.refused ?? ""}`);
  assert.equal(r.verdict, "pass");
  assert.equal(r.blocked, false, "a pass verdict must still declare it blocks nothing");
  assert.equal(run.escalations.length, 0, "a pass escalates nothing");
  assert.equal(r.mode, "verify-single");
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].agreement, 1.0);
  assert.match(r.conclusion, /^narrate: verdict pass \(verify-single mode\) — 1 line\(s\) verified, 0 with gaps, 0 refused/);
  assert.match(md(run), /\| script\.txt \| 1\.000 \| 6 \| 6 \| match \|/);
});

await check("verify mode on the gaps path escalates exactly once and still blocks nothing", async () => {
  const run = await withBin(GAPS_STUB, () => drive({ script: "script.txt", audio: "out/script.mp3" }));
  const r = run.result;
  assert.equal(r.verdict, "gaps");
  assert.equal(r.blocked, false, "the WARN-never-block law: a gaps verdict is a normal result");
  assert.equal(run.escalations.length, 1, "exactly one escalation on gaps");
  assert.match(run.escalations[0].question, /narration gaps: 1 of 1 line\(s\) differ from the script \(worst agreement 0\.750\) — advisory, never blocks/);
  assert.equal(run.escalations[0].tag, "narration-gaps");
  assert.equal(r.ownerAnswer, "accept the drift");
  // The report and the artifact are still produced — there is no branch that
  // stops at the warning.
  assert.ok(run.artifacts.length === 1, "the artifact is still published on the gaps path");
  assert.match(md(run), /\| script\.txt \| 0\.750 \| 6 \| 5 \| missing 2, extra 1 \|/);
  assert.match(md(run), /This loop has no blocking branch/);
  assert.equal(run.phases.at(-1), "Gate the narration against the script");
  assert.match(r.conclusion, /advisory, escalated once, nothing blocked/);
});

await check("the error path refuses by name and escalates nothing", async () => {
  const run = await withBin(ERROR_STUB, () => drive({ script: "script.txt", audio: "out/script.mp3" }));
  const r = run.result;
  assert.equal(r.verdict, "error");
  assert.equal(run.escalations.length, 0, "nothing verified is not a decision for the owner");
  assert.deepEqual(r.refused, [{ id: "script.txt", error: "transcription refused — gen1_raw has no ASR leg" }]);
  assert.match(r.conclusion, /refused by name: script\.txt: transcription refused — gen1_raw has no ASR leg/);
  assert.match(md(run), /- `script\.txt`: transcription refused — gen1_raw has no ASR leg/);
});

await check("a pre-row refusal fails the loop open with the CLI's own sentence", async () => {
  const run = await withBin(REFUSED_STUB, () => drive({ script: "script.txt", audio: "nope.mp3" }));
  const r = run.result;
  assert.equal(r.failOpen, true);
  assert.equal(r.where, "media-gate refused");
  assert.equal(r.refused, "media-gate: cannot read script/audio: [Errno 2] No such file or directory: 'nope.mp3'");
  assert.match(r.conclusion, /^narration unavailable — nothing was rendered or verified — media-gate refused: /);
  assert.equal(run.artifacts.length, 0, "a refusal publishes no artifact");
  assert.equal(run.escalations.length, 0);
});

await check("an absent CLI is the configured absence, named", async () => {
  const run = await withBin(ABSENT, () => drive({ script: "script.txt", audio: "out/script.mp3" }));
  const r = run.result;
  assert.equal(r.failOpen, true);
  assert.match(r.refused, /dev-decisions not installed — the media grant needs the dev-decisions CLI with gen1/);
});

// ── verify-seam mode: the engine's path-escape, verbatim ────────────────────

await check("a --project path-escape is the engine's refusal by name, resolved by nothing", async () => {
  const run = await withBin(ESCAPE_STUB, () => drive({ request: "assets/voice/audio_request.json", meta: "assets/voice/audio_meta.json", project: "." }));
  const argv = argvLines("escape", 1);
  assert.deepEqual(JSON.parse(argv[0]), ["media-gate", "--json", "--request", "assets/voice/audio_request.json", "--meta", "assets/voice/audio_meta.json", "--project", "."]);
  const r = run.result;
  assert.equal(r.mode, "verify-seam");
  assert.equal(r.verdict, "error");
  assert.equal(r.blocked, false);
  assert.deepEqual(r.refused, [{ id: "l1", error: "path escapes --project: ../outside.mp3" }]);
  // The loop resolves nothing: the engine's sentence rides through untouched.
  assert.match(r.conclusion, /refused by name: l1: path escapes --project: \.\.\/outside\.mp3/);
  assert.match(md(run), /The loop resolves nothing itself/);
  assert.equal(run.escalations.length, 0);
});

// ── render mode: speak, assemble, gate ──────────────────────────────────────

await check("render mode speaks each line and forwards the voice args", async () => {
  const run = await withBin(RENDER_STUB, () => drive({ request: "request.json", voice: "Cherry", language: "en", speed: 1.25 }));
  const argv = argvAll("render");
  const speaks = argv.map((l) => JSON.parse(l)).filter((a) => a[0] === "media-speak");
  const gates = argv.map((l) => JSON.parse(l)).filter((a) => a[0] === "media-gate");
  assert.equal(speaks.length, 2, `two speak legs — the empty third line is skipped first: ${argv.length} call(s)`);
  assert.deepEqual(speaks[0], ["media-speak", "--json", "--text", "The router decides.", "--out", "assets/voice/l1.mp3", "--format", "mp3", "--voice", "Cherry", "--language", "en", "--speed", "1.25"]);
  assert.deepEqual(speaks[1], ["media-speak", "--json", "--text", "The engine logs.", "--out", "assets/voice/l2.mp3", "--format", "mp3", "--voice", "Cherry", "--language", "en", "--speed", "1.25"]);
  assert.equal(gates.length, 1, "one gate, after the renders");
  assert.deepEqual(gates[0], ["media-gate", "--json", "--request", "assets/voice/audio_request.json", "--meta", "assets/voice/audio_meta.json", "--project", ".", "--language", "en"]);
});

await check("the staged request is the seam's dialect, written through the plane's own write", async () => {
  await withBin(RENDER_STUB, () => drive({ request: "request.json" }));
  const staged = readWs("assets/voice/audio_request.json");
  assert.deepEqual(staged, { lines: [{ id: "l1", text: "The router decides." }, { id: "l2", text: "The engine logs." }] });
});

await check("the seam meta is assembled from the speak rows themselves", async () => {
  const run = await withBin(RENDER_STUB, () => drive({ request: "request.json" }));
  const meta = readWs("assets/voice/audio_meta.json");
  assert.equal(meta.tts_provider, "gen1");
  assert.equal(meta.total_duration_s, 5.75);
  assert.equal(meta.voice_id, "Cherry");
  assert.deepEqual(meta.voices, [
    { id: "l1", path: "assets/voice/l1.mp3", duration_s: 2.5, words: [], provider: "gen1_raw/qwen", format: "mp3", voice: "Cherry", request_id: "req-l1" },
    { id: "l2", path: "assets/voice/l2.mp3", duration_s: 3.25, words: [], provider: "gen1_raw/qwen", format: "mp3", voice: "Cherry", request_id: "req-l2" },
  ]);
  // The path is the row's own target — the loop never invents one.
  assert.equal(meta.voices[0].path, "assets/voice/l1.mp3");
  const r = run.result;
  assert.equal(r.verdict, "pass");
  assert.equal(r.rendered.length, 2);
  assert.deepEqual(r.rendered[0], { id: "l1", path: "assets/voice/l1.mp3", duration_s: 2.5, provider: "gen1_raw/qwen", format: "mp3", voice: "Cherry", request_id: "req-l1" });
  assert.deepEqual(r.anomalies, ["line l3: empty text — skipped, no leg spent"]);
  assert.match(r.conclusion, /2 rendered into assets\/voice \(5\.8s\)/);
  assert.match(md(run), /## Rendered this run/);
  assert.match(md(run), /"duration_s": 2\.5/);
});

await check("a refused line is omitted from the meta and named, and the seam still gates", async () => {
  const run = await withBin(RENDER_REFUSED_STUB, () => drive({ request: "request.json" }));
  const meta = readWs("assets/voice/audio_meta.json");
  assert.equal(meta.voices.length, 1, "the refused line is not in the seam");
  assert.equal(meta.voices[0].id, "l1");
  assert.ok(meta.anomalies.some((a) => /line l2: media-speak refused — the row carries no reason/.test(a)), JSON.stringify(meta.anomalies));
  const r = run.result;
  assert.equal(r.verdict, "gaps");
  assert.equal(run.escalations.length, 1, "the seam's gaps escalate once");
  assert.deepEqual(r.refused, [{ id: "l2", error: "no rendered audio for line l2" }]);
  assert.match(r.conclusion, /refused by name: l2: no rendered audio for line l2/);
});

await check("a served container that disagrees with the filename is named, never hidden", async () => {
  const run = await withBin(RENDER_WAV_STUB, () => drive({ request: "request.json" }));
  const meta = readWs("assets/voice/audio_meta.json");
  assert.equal(meta.voices[1].format, "wav", "the row's format is the container truth");
  assert.equal(meta.voices[1].path, "assets/voice/l2.mp3");
  assert.ok(meta.anomalies.some((a) => /line l2: served wav into a \.mp3 filename/.test(a)), JSON.stringify(meta.anomalies));
  assert.ok(run.result.anomalies.some((a) => /served wav into a \.mp3 filename/.test(a)));
});

await check("dryRun calls no speak leg, writes no meta, and still gates", async () => {
  const metaFile = path.join(workspace, "assets", "voice", "audio_meta.json");
  const before = fs.existsSync(metaFile);
  const run = await withBin(DRYRUN_STUB, () => drive({ request: "request.json", dryRun: true }));
  const argv = argvAll("dryrun");
  assert.equal(argv.length, 1, `only the gate call rode the wire: ${argv.join(" | ")}`);
  assert.equal(JSON.parse(argv[0])[0], "media-gate");
  assert.equal(fs.existsSync(metaFile), before, "dryRun writes no meta");
  const r = run.result;
  assert.equal(r.dryRun, true);
  assert.equal(r.verdict, "error", "the gate found no meta to verify, and says so");
  assert.match(r.conclusion, /dry run/);
  assert.deepEqual(r.refused, [{ id: "?", error: "unreadable seam: [Errno 2] No such file or directory: 'assets/voice/audio_meta.json'" }]);
  assert.match(run.logs.join("\n"), /dry run: 2 line\(s\) would be rendered into assets\/voice as \.mp3 and gated; no speak leg was called/);
});

// ── the refusals that end the loop before anything is spent ─────────────────

await check("the args naming half a pair fail open by name", async () => {
  const run = await withBin(PASS_STUB, () => drive({ script: "script.txt" }));
  const r = run.result;
  assert.equal(r.failOpen, true);
  assert.equal(r.where, "the args name half of a pair");
  assert.match(r.refused, /got --script without its pair/);
  assert.equal(argvAll("pass").length, 0, "nothing rode the wire");
});

await check("no args at all names no mode, by name", async () => {
  const run = await withBin(PASS_STUB, () => drive({}));
  const r = run.result;
  assert.equal(r.failOpen, true);
  assert.equal(r.where, "the args name no mode");
  assert.match(r.refused, /nothing to do: pass --script with --audio/);
});

await check("an unreadable request ends the render before any leg is spent", async () => {
  const run = await withBin(RENDER_STUB, () => drive({ request: "missing.json" }));
  const r = run.result;
  assert.equal(r.failOpen, true);
  assert.match(r.where, /the request missing\.json is unreadable/);
  assert.match(r.refused, /ENOENT/);
  assert.equal(argvAll("render").length, 0, "no speak leg and no gate rode the wire");
});

await check("a request with no lines array fails open by name", async () => {
  fs.writeFileSync(path.join(workspace, "bad.json"), JSON.stringify({ nope: true }));
  const run = await withBin(RENDER_STUB, () => drive({ request: "bad.json" }));
  const r = run.result;
  assert.equal(r.failOpen, true);
  assert.match(r.refused, /expected a JSON array of \{id, text\} objects, or an object with a "lines" array/);
});

// ── the structure ───────────────────────────────────────────────────────────

await check("the file spawns no agent, publishes one artifact, and carries the never-blocks marker", async () => {
  assert.ok(source.includes("// media-loops: this loop never blocks"), "the marker line is present");
  assert.ok(!source.includes("blocked: true"), "no branch returns a blocked state");
  assert.ok(!/\bagent\s*\(/.test(source), "no agent is spawned");
  assert.ok(!source.includes("child_process"), "no child_process import — the bridge owns the spawn");
  const run = await withBin(RENDER_STUB, () => drive({ request: "request.json" }));
  assert.equal(run.artifacts.length, 1);
  assert.equal(run.artifacts[0].primary, true);
  assert.equal(run.artifacts[0].title, "Narration gate — pass");
  // The phases prove the order: read, stage, render, assemble, gate.
  assert.deepEqual(run.phases, [
    "Read the request",
    "Stage the request in the seam's dialect",
    "Render 2 line(s) into assets/voice",
    "Assemble the seam meta from the engine's own rows",
    "Gate the narration against the script",
  ]);
});

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL — ${f}`);
  process.exit(1);
}
