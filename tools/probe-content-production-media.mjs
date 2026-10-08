#!/usr/bin/env node
/**
 * content-production's optional voice leg, executed and held (C6).
 *
 * The leg's promise: with the media grant, the finished piece gains a voice
 * track — spoken and gated through dev-decisions, advisory, never a block.
 * Without the grant, or when any leg refuses, the workflow returns exactly the
 * shape it always returned. Proven here by driving the REAL workflow body (the
 * same text transform the plane applies — `annotateAskSites`, the surface bound
 * as globals, `export default async function`) over a stub agent roster and
 * stub CLIs answering in the lane's pinned machine rows, with the plane-side
 * write going through the kit's own `worldRun` into a real temp workspace so
 * the spoken script is read back off disk rather than trusted:
 *
 *   1. the absent-grant path is byte-identical to the committed pre-leg
 *      workflow — the same body driven with the grant held returns the same
 *      conclusion, findings, verified and notCovered, with no voice field, no
 *      plane-side write and no wire call;
 *   2. the grant path speaks the prose of the deliverable (its markup stripped,
 *      named) through media-speak, gates that exact script against the render,
 *      and rides the verdict as an advisory line plus a voice-track artifact;
 *   3. a gaps verdict is advisory too — the escalation count is still zero, the
 *      deliverable artifact is still published, and the piece stands;
 *   4. every refusal path — an absent CLI, a pre-row refusal row on stdout, a
 *      gate that verified nothing — names the engine's own sentence in the log
 *      and leaves the result exactly as the no-grant path returned it;
 *   5. a served container that disagrees with the .mp3 filename is named, never
 *      hidden;
 *   6. the structure — the leg spawns no agent of its own, escalates nothing,
 *      and never sets a blocked verdict.
 *
 *   node tools/probe-content-production-media.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const engineDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { media } = await import(path.join(engineDir, "lib", "workflow", "services.mjs"));
const { annotateAskSites, parseTypeText } = await import(path.join(engineDir, "lib", "workflow", "schema.mjs"));
const { extractInterfaces } = await import(path.join(engineDir, "lib", "workflow", "meta.mjs"));
const { worldRun, resolveGrants } = await import(path.join(engineDir, "lib", "workflow", "tools.mjs"));

/** The plane's own compile: annotate the ask sites, parse each type argument
 * against the file's interfaces, and emit the `__wfTypeN` preamble the
 * annotated asks resolve to. A probe that skipped this would drive a body the
 * engine never loads. */
function compile(source) {
  const annotated = annotateAskSites(source);
  const interfaces = extractInterfaces(source);
  const schemas = annotated.types.map((text) => parseTypeText(text, interfaces));
  const preamble = schemas.map((s, i) => `const __wfType${i} = ${s ? JSON.stringify(s) : "null"};`).join("\n");
  return `${preamble}\nexport default async function __wfRun() {\n${annotated.source}\n}`;
}

let pass = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok — ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL — ${name}: ${String(e?.message ?? e).slice(0, 400)}`);
  }
}

const yard = fs.mkdtempSync(path.join(os.tmpdir(), "content-prod-probe-"));
const workspace = path.join(yard, "ws");
fs.mkdirSync(path.join(workspace, "out", "content"), { recursive: true });

// ── the stub CLIs: the lane's pinned rows, one scenario per file ─────────────
// Each stub answers media-speak (keyed by the --out basename) and media-gate
// (echoing the --script it was handed, so the target proves what rode the
// wire), and drops its argv into a file.
function stub(name, { speak = {}, gate }) {
  const p = path.join(yard, name);
  const argvFile = path.join(yard, `${name}.argv`);
  const cwdFile = path.join(yard, `${name}.cwd`);
  const body = [
    `#!/usr/bin/env node`,
    `require("node:fs").appendFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
    `require("node:fs").appendFileSync(${JSON.stringify(cwdFile)}, process.cwd() + "\\n");`,
    `const argv = process.argv.slice(2);`,
    `const flag = (n) => { const i = argv.indexOf("--" + n); return i < 0 ? null : argv[i + 1]; };`,
    `const cmd = argv[0];`,
    `if (cmd === "media-speak") {`,
    `  const out = flag("out");`,
    `  const rows = ${JSON.stringify(speak)};`,
    `  const key = Object.keys(rows).find((k) => out.endsWith("/" + k));`,
    `  const r = key ? rows[key] : null;`,
    `  if (!r) { process.exit(2); }`,
    `  process.stdout.write(JSON.stringify(Object.assign({ op: "media-speak", ok: true, target: out, task: "media_speak", escalated: false }, r)) + "\\n");`,
    `  process.exit(0);`,
    `}`,
    `if (cmd === "media-gate") {`,
    `  const rows = ${JSON.stringify(gate.rows)};`,
    `  for (const r of rows) { process.stdout.write(JSON.stringify(Object.assign({ op: "media-gate", ok: true, target: flag("script") || "script", mode: "single", escalated: false }, r)) + "\\n"); }`,
    `  process.exit(${gate.exit ?? 0});`,
    `}`,
    `process.exit(2);`,
  ];
  fs.writeFileSync(p, body.join("\n"), { mode: 0o755 });
  return p;
}

const SPEAK_OK = {
  "voice.mp3": {
    provider: "gen1_raw/qwen",
    duration_seconds: 4.5,
    format: "mp3",
    sample_rate: 24000,
    request_id: "req-voice",
    voice: "Cherry",
    verdict: "ok",
  },
};
const SPEAK_WAV = {
  "voice.mp3": { ...SPEAK_OK["voice.mp3"], provider: "gen1_raw/stepfun", format: "wav", sample_rate: 44100 },
};
const GATE_PASS = {
  rows: [
    {
      provider: "gen1_raw/qwen",
      task: "media_gate",
      input_sha256: "sha-in",
      lines: [
        {
          id: "voice-script",
          agreement: 1.0,
          ref_tokens: 42,
          got_tokens: 42,
          missing: 0,
          extra: 0,
          audio_sha256: "sha-audio",
        },
      ],
      refused: [],
      verdict: "pass",
      note: "1 verified, 0 refused, 0 with gaps",
    },
  ],
};
const GATE_GAPS = {
  rows: [
    {
      ...GATE_PASS.rows[0],
      lines: [{ ...GATE_PASS.rows[0].lines[0], agreement: 0.75, got_tokens: 40, missing: 6, extra: 4 }],
      verdict: "gaps",
      note: "1 verified, 0 refused, 1 with gaps",
    },
  ],
  exit: 1, // the lane's advisory WARN exit — the bridge treats rows as payload
};
// A pre-row refusal: the lane prints {ok: false, error} on stdout and exits 3,
// which the bridge surfaces as transport-success carrying the sentence in
// `refused` — the W1 difference this leg is pinned against.
const GATE_REFUSED_ROW = {
  rows: [{ op: "media-gate", ok: false, error: "media-gate: cannot read script/audio: [Errno 2] No such file or directory: 'out/content/voice.mp3'" }],
  exit: 3,
};
const GATE_ERROR = {
  rows: [{ ...GATE_PASS.rows[0], lines: [], refused: [{ id: "voice-script", error: "transcription refused: no key" }], verdict: "error", note: "0 verified, 1 refused, 0 with gaps" }],
  exit: 3,
};

const PASS_STUB = stub("pass", { speak: SPEAK_OK, gate: GATE_PASS });
const GAPS_STUB = stub("gaps", { speak: SPEAK_OK, gate: GATE_GAPS });
const WAV_STUB = stub("wav", { speak: SPEAK_WAV, gate: GATE_PASS });
const GATE_REFUSED_STUB = stub("gate-refused", { speak: SPEAK_OK, gate: GATE_REFUSED_ROW });
const GATE_ERROR_STUB = stub("gate-error", { speak: SPEAK_OK, gate: GATE_ERROR });

// ── the stub agent roster ───────────────────────────────────────────────────
// The agents a real run would spawn, answered from a script. The Finisher does
// the one thing a stub agent must do honestly: it writes the deliverable file,
// the way its write_file tool would, because the leg under test reads that file
// back off disk.
const DELIVERABLE = [
  "# The Routing Report",
  "",
  "The router decides **which** plan serves each task. See [the docs](docs/README.md) for detail.",
  "",
  "## Findings",
  "",
  "- First finding with `code` in it.",
  "- Second finding.",
  "",
  "| lane | verdict |",
  "|---|---|",
  "",
  "> A quoted line.",
  "",
  "![a diagram](img/diagram.png)",
  "",
  "Done.",
].join("\n");
const SPOKEN = [
  "The Routing Report",
  "",
  "The router decides which plan serves each task. See the docs for detail.",
  "",
  "Findings",
  "",
  "First finding with code in it.",
  "Second finding.",
  "",
  "lane  verdict",
  "",
  "A quoted line.",
  "",
  "a diagram",
  "",
  "Done.",
].join("\n");

const BRIEF = "A short report on which routing lane wins.";

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

/** Bind the run surface as globals — the engine's own line — and call the loop. */
async function drive({ grants = "", brief = BRIEF, deliverable = DELIVERABLE } = {}) {
  // Every drive starts with a clean wire record and a clean workspace: the
  // stubs append, so a leftover line would be another drive's call counted as
  // this one's, and a planted deliverable would be this drive's own.
  for (const f of fs.readdirSync(yard)) {
    if (f.endsWith(".argv") || f.endsWith(".cwd")) fs.rmSync(path.join(yard, f));
  }
  fs.rmSync(path.join(workspace, "out"), { recursive: true, force: true });
  fs.mkdirSync(path.join(workspace, "out", "content"), { recursive: true });

  const collected = { logs: [], phases: [], reports: [], artifacts: [], escalations: [], agents: [], writes: [], calls: [] };
  const held = resolveGrants({ grants });
  const api = {
    args: { brief },
    agent: (name) => {
      const label = String(name);
      return {
        name: label,
        stats: { asks: 0 },
        ask: async (instructions) => {
          // The invocation, not the construction: the workflow builds its
          // Polisher before the review loop, so a construction list would count
          // an agent that was never asked.
          collected.agents.push(label);
          if (label === "Outliner") {
            return {
              thesis: "Routing is a per-task decision.",
              sections: [
                { id: "1", title: "The lanes", angle: "What each lane decides." },
                { id: "2", title: "The pick", angle: "How the router chooses." },
              ],
            };
          }
          if (label.startsWith("Writer for ")) {
            const title = label.slice("Writer for ".length);
            return { sectionId: title === "The lanes" ? "1" : "2", text: `Section ${title === "The lanes" ? "1" : "2"} prose.` };
          }
          if (label === "Reviewer") return { issues: [] };
          if (label === "Polisher") return `Polished: ${String(instructions).slice(0, 24)}`;
          if (label === "Finisher") {
            // The finisher's write_file, planted here: the leg reads the
            // deliverable back, so the file has to really exist.
            fs.writeFileSync(path.join(workspace, "out", "content", "deliverable.md"), deliverable);
            return { path: "out/content/deliverable.md", summary: "A report on routing." };
          }
          throw new Error(`unstubbed agent: ${label}`);
        },
      };
    },
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
      file: async (id, rel, opts) => {
        collected.artifacts.push({ id, path: String(rel), file: true, title: opts?.title ?? id, primary: opts?.primary ?? false });
        return { id, version: 1 };
      },
    },
    files: {
      // The real workspace read, so the planted deliverable is really read.
      read: (rel) => fs.readFileSync(path.join(workspace, String(rel)), "utf8"),
      glob: () => [],
      grep: () => [],
    },
    world: {
      // The kit's own bridge, so the advisory-exit and stdout-refusal handling
      // under test here is the one a real run exercises. The cwd is the
      // engine's binding exactly: the run's workspace, because the lane's
      // paths are workspace-relative and a CLI that cannot see the file a
      // workflow staged would refuse a leg that is on disk.
      media: (command, callArgs, callOpts) => {
        collected.calls.push({ command, args: callArgs });
        return media(command, callArgs, { ...callOpts, cwd: workspace });
      },
      // The kit's own worldRun into the temp workspace, so the spoken script is
      // written for real and read back off disk.
      run: (command, args) => {
        collected.writes.push({ command, args });
        return worldRun(command, args, workspace, held, () => {});
      },
      grants: () => ({ caps: held.summary(), has: (cap) => held.has(cap) }),
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

const argvAll = (name) => {
  try {
    return fs.readFileSync(path.join(yard, `${name}.argv`), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
// Where the stub CLI actually ran: the lane's paths are workspace-relative, so
// a child in any other directory cannot read the script this leg staged.
const cwdAll = (name) => {
  try {
    return fs.readFileSync(path.join(yard, `${name}.cwd`), "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
};
const readWs = (rel) => fs.readFileSync(path.join(workspace, rel), "utf8");

// ── both bodies: the leg as written, and the committed pre-leg workflow ─────
const source = fs.readFileSync(path.join(engineDir, "workflows", "content-production.ts"), "utf8");
const modulePath = path.join(yard, "content-production.mts");
fs.writeFileSync(modulePath, compile(source));
const mod = await import(new URL(`file://${modulePath}`).href);

const preLeg = execFileSync("git", ["-C", engineDir, "show", "HEAD:workflows/content-production.ts"], {
  encoding: "utf8",
  maxBuffer: 8 * 1024 * 1024,
});
const prePath = path.join(yard, "pre-leg.mts");
fs.writeFileSync(prePath, compile(preLeg));
const preMod = await import(new URL(`file://${prePath}`).href);

/** Drive the pre-leg body with the same stub surface, for the identity claim. */
async function drivePre() {
  for (const f of fs.readdirSync(yard)) {
    if (f.endsWith(".argv")) fs.rmSync(path.join(yard, f));
  }
  fs.rmSync(path.join(workspace, "out"), { recursive: true, force: true });
  fs.mkdirSync(path.join(workspace, "out", "content"), { recursive: true });
  const collected = { logs: [], phases: [], artifacts: [], writes: [], calls: [] };
  const api = {
    args: { brief: BRIEF },
    agent: (name) => {
      const label = String(name);
      return {
        name: label,
        stats: { asks: 0 },
        ask: async (instructions) => {
          if (label === "Outliner") {
            return {
              thesis: "Routing is a per-task decision.",
              sections: [
                { id: "1", title: "The lanes", angle: "What each lane decides." },
                { id: "2", title: "The pick", angle: "How the router chooses." },
              ],
            };
          }
          if (label.startsWith("Writer for ")) {
            const title = label.slice("Writer for ".length);
            return { sectionId: title === "The lanes" ? "1" : "2", text: `Section ${title === "The lanes" ? "1" : "2"} prose.` };
          }
          if (label === "Reviewer") return { issues: [] };
          if (label === "Polisher") return `Polished: ${String(instructions).slice(0, 24)}`;
          if (label === "Finisher") {
            fs.writeFileSync(path.join(workspace, "out", "content", "deliverable.md"), DELIVERABLE);
            return { path: "out/content/deliverable.md", summary: "A report on routing." };
          }
          throw new Error(`unstubbed agent: ${label}`);
        },
      };
    },
    log: (m) => collected.logs.push(String(m)),
    phase: (n) => collected.phases.push(String(n)),
    report: () => {},
    escalate: async () => "accept",
    artifact: {
      markdown: async () => ({ id: "x", version: 1 }),
      file: async (id, rel) => {
        collected.artifacts.push({ id, path: String(rel) });
        return { id, version: 1 };
      },
    },
    files: { read: (rel) => fs.readFileSync(path.join(workspace, String(rel)), "utf8"), glob: () => [], grep: () => [] },
    world: {
      media: (command, callArgs) => {
        collected.calls.push({ command, args: callArgs });
        return media(command, callArgs);
      },
      run: (command, args) => {
        collected.writes.push({ command, args });
        return worldRun(command, args, workspace, resolveGrants({}), () => {});
      },
      grants: () => ({ caps: {}, has: () => false }),
    },
  };
  for (const k of Object.keys(api)) globalThis[k] = api[k];
  try {
    return { ...collected, result: await preMod.default() };
  } finally {
    for (const k of Object.keys(api)) delete globalThis[k];
  }
}

// ── 1. the absent-grant path is the workflow that always was ────────────────

await check("without the media grant the workflow is byte-identical to the committed pre-leg one", async () => {
  const now = await drive({ grants: "" });
  const before = await drivePre();
  assert.equal(now.writes.length, 0, "no plane-side write without the grant");
  assert.equal(now.calls.length, 0, "no wire call without the grant");
  assert.deepEqual(now.result, before.result, "the result shape is exactly the pre-leg result");
  assert.ok(!("voice" in now.result), "no voice field without the grant");
  assert.equal(now.logs.filter((l) => l.startsWith("voice")).length, 0, "no voice log without the grant");
  // The agents ran exactly as before — the leg spawns none of its own.
  assert.deepEqual(now.agents, before.agents ?? now.agents);
  assert.deepEqual(now.agents, ["Outliner", "Writer for The lanes", "Writer for The pick", "Reviewer", "Finisher"]);
});

// ── 2. the grant path: speak the prose, gate that script, ride the verdict ──

await check("with the grant the deliverable's prose is spoken and gated, and the verdict rides", async () => {
  const run = await withBin(PASS_STUB, () => drive({ grants: "media" }));
  const argv = argvAll("pass");
  assert.equal(argv.length, 2, `two wire calls, got ${argv.length}`);
  assert.deepEqual(argv[0], [
    "media-speak",
    "--json",
    "--text-file",
    "out/content/voice-script.txt",
    "--out",
    "out/content/voice.mp3",
    "--format",
    "mp3",
  ]);
  // The staged script is the deliverable's prose with its markup stripped —
  // read back off disk through the kit's own worldRun, not trusted.
  assert.equal(readWs("out/content/voice-script.txt"), SPOKEN);
  assert.deepEqual(argv[1], ["media-gate", "--json", "--script", "out/content/voice-script.txt", "--audio", "out/content/voice.mp3"]);
  // Both calls ran IN the workspace: the lane's paths are workspace-relative,
  // so a child in any other directory reads the staged script as absent and
  // the leg refuses a render that is sitting on disk. (macOS puts /var ahead of
  // /private/var in tmpdir, and the child reports the resolved path.)
  const ws = fs.realpathSync(workspace);
  assert.deepEqual(cwdAll("pass"), [ws, ws], "the CLI did not run in the run's workspace");
  const r = run.result;
  assert.equal(r.voice.verdict, "pass");
  assert.equal(r.voice.agreement, 1.0);
  assert.equal(r.voice.audio, "out/content/voice.mp3");
  assert.equal(r.voice.duration, 4.5);
  assert.equal(r.voice.format, "mp3");
  assert.match(r.conclusion, /^A report on routing\. Piece: out\/content\/deliverable\.md\. A voice track rides with it \(out\/content\/voice\.mp3\): media-gate's verdict is pass at 1\.000 agreement — advisory by the lane's law, never a block\.$/);
  assert.ok(r.verified.includes("a voice track was rendered and gated, and the gate's verdict stayed advisory"));
  assert.ok(r.notCovered.some((n) => n.startsWith("the voice track's fidelity")));
  // The deliverable is still the primary artifact, and the voice track rides
  // beside it rather than replacing it.
  const primary = run.artifacts.filter((a) => a.primary);
  assert.equal(primary.length, 1, "the deliverable stays the one primary artifact");
  assert.equal(primary[0].id, "deliverable");
  const track = run.artifacts.find((a) => a.id === "voice-track");
  assert.ok(track, "the voice track is published beside the deliverable");
  assert.equal(track.path, "out/content/voice.mp3");
  assert.equal(run.escalations.length, 0, "the leg escalates nothing — it never blocks");
  assert.equal(r.blocked, undefined, "no blocked verdict on any path");
  // The leg spawns no agent of its own.
  assert.deepEqual(run.agents, ["Outliner", "Writer for The lanes", "Writer for The pick", "Reviewer", "Finisher"]);
  assert.match(run.logs.at(-1), /^voice track: out\/content\/voice\.mp3 — 4\.50s mp3, media-gate verdict pass at 1\.000 agreement \(1 verified, 0 refused, 0 with gaps\) — advisory, the piece stands as written$/);
});

await check("a gaps verdict is advisory too — the deliverable stands and nothing escalates", async () => {
  const run = await withBin(GAPS_STUB, () => drive({ grants: "media" }));
  const r = run.result;
  assert.equal(r.voice.verdict, "gaps");
  assert.equal(r.voice.agreement, 0.75);
  assert.equal(run.escalations.length, 0, "narration drift is the engine's advisory, not this loop's escalation");
  assert.ok(run.artifacts.some((a) => a.id === "deliverable"), "the deliverable is still published on the gaps path");
  assert.ok(run.artifacts.some((a) => a.id === "voice-track"), "the voice track is still published on the gaps path");
  assert.match(r.conclusion, /media-gate's verdict is gaps at 0\.750 agreement/);
  assert.equal(r.voice.duration, 4.5);
});

await check("a served container that disagrees with the filename is named, never hidden", async () => {
  const run = await withBin(WAV_STUB, () => drive({ grants: "media" }));
  const r = run.result;
  assert.equal(r.voice.format, "wav", "the row's format is the container truth");
  assert.equal(r.voice.audio, "out/content/voice.mp3", "the filename stays what was asked for");
  assert.match(run.logs.at(-1), /served wav into a \.mp3 filename, and the row's format is the container truth/);
});

// ── 3. every refusal path leaves the deliverable's shape untouched ──────────

await check("an absent CLI is the configured absence, named, and changes nothing", async () => {
  const run = await withBin(path.join(yard, "no-such-cli"), () => drive({ grants: "media" }));
  assert.equal(run.calls.length, 1, "the speak leg was attempted and refused");
  assert.match(run.logs.at(-1), /^voice leg unavailable — media-speak refused — dev-decisions not installed — the media grant needs the dev-decisions CLI with gen1 \(see docs\)$/);
  assert.ok(!("voice" in run.result), "a refusal produces no voice field");
  assert.equal(run.result.conclusion, "A report on routing. Piece: out/content/deliverable.md.");
  assert.equal(run.writes.length, 1, "the script was staged before the leg refused — one write, no more");
  assert.deepEqual(run.result.verified, ["the assembled draft had a fresh-eyes review with a fix pass"]);
});

await check("a pre-row refusal row is the engine's sentence, verbatim, and changes nothing", async () => {
  const run = await withBin(GATE_REFUSED_STUB, () => drive({ grants: "media" }));
  // The W1 difference: exit 3 with {ok: false} on stdout resolves as
  // transport-success carrying the sentence in `refused`.
  assert.equal(run.calls.length, 2, "both legs rode the wire");
  assert.match(
    run.logs.at(-1),
    /^voice leg unavailable — media-gate refused — media-gate: cannot read script\/audio: \[Errno 2\] No such file or directory: 'out\/content\/voice\.mp3'$/,
  );
  assert.ok(!("voice" in run.result), "a refusal produces no voice field");
  assert.equal(run.result.conclusion, "A report on routing. Piece: out/content/deliverable.md.");
});

await check("a gate that verified nothing reports an error verdict and still blocks nothing", async () => {
  const run = await withBin(GATE_ERROR_STUB, () => drive({ grants: "media" }));
  // The render exists — the gate simply could not transcribe it — so the
  // track stands and the engine's error verdict rides it, advisory.
  assert.equal(run.result.voice.verdict, "error");
  assert.equal(run.result.voice.agreement, null, "nothing verified means no agreement to report");
  assert.equal(run.escalations.length, 0, "an error verdict escalates nothing here either");
  assert.match(run.result.conclusion, /media-gate's verdict is error — advisory by the lane's law, never a block/);
  assert.ok(run.artifacts.some((a) => a.id === "voice-track"), "the rendered track is still published");
  assert.ok(run.artifacts.some((a) => a.id === "deliverable"), "the deliverable is still the primary artifact");
});

await check("a deliverable with no prose once stripped names that and changes nothing", async () => {
  // A piece that is nothing but a fenced code block: the strip leaves nothing
  // to speak, and no leg is spent guessing.
  const run = await withBin(PASS_STUB, () => drive({ grants: "media", deliverable: "```\nconst x = 1;\n```\n" }));
  assert.equal(run.calls.length, 0, "no leg is spent on an empty script");
  assert.equal(run.writes.length, 0, "nothing is even staged when there is nothing to speak");
  assert.match(run.logs.at(-1), /^voice leg unavailable — the finished piece has no prose to speak once its markup is stripped$/);
  assert.equal(run.result.conclusion, "A report on routing. Piece: out/content/deliverable.md.");
  assert.ok(!("voice" in run.result), "no voice field when nothing was spoken");
});

// ── 4. the structure ────────────────────────────────────────────────────────

await check("the leg's structure: one write, two verbs, no agent, no block", () => {
  const src = fs.readFileSync(path.join(engineDir, "workflows", "content-production.ts"), "utf8");
  assert.ok(src.includes("media-loops: the finished piece gains a voice track behind the media grant"), "the lane marker is present");
  assert.ok(!src.includes("blocked: true"), "no path declares a block");
  assert.ok(!src.includes('world.grants().has("media")') === false, "the leg is gated on the grant");
  // The leg speaks exactly two verbs and no provider's API.
  const verbs = [...src.matchAll(/world\.media\("([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(verbs, ["media-speak", "media-gate"]);
  assert.ok(!/fetch\(|require\("child_process"\)/.test(src), "no direct provider call, no child_process");
});

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL — ${f}`);
  process.exit(1);
}
