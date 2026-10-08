#!/usr/bin/env node
/**
 * The diagram lane's three surfaces, entirely without the real archify CLI.
 *
 * diagramAudit() is the write-free read that keeps the repo's diagram claims
 * anchored: a ref is intact when the bytes at [line..end_line] equal the bytes
 * at that range in the revision its candidate pins — identity, never
 * similarity — and this suite proves all four verdicts against a real temp git
 * repo (a planted move, a planted edited range, a planted deleted file, and
 * refs that did not move), plus the one-git-show-per-(revision,path) rule
 * counted through a PATH shim. diagramRepin() is the pure mechanical half:
 * moves applied and nothing else, revision repinned, second application a
 * byte-identical no-op. diagramFinalize() is the receipt dance, run against a
 * stub CLI pointed at through ARCHIFY_BIN — receipts move back except the
 * candidate copy, an off-list verb refuses before spawn, and an absent CLI is
 * the pinned sentence, not a crash. The engine binding is driven end-to-end so
 * the grant refusal and the journaled counts are executed, not assumed.
 *
 * Nothing here talks to a real archify skill, a browser, or any model; every
 * path runs hermetically on any machine with git on PATH.
 *
 *   node tools/unit-services-diagram.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const engineDir = path.resolve(import.meta.dirname, "..");
const { diagramAudit, diagramRepin, diagramFinalize, nextRefreshDir, resolveArchifyBin, DIAGRAM_COMMANDS, DIAGRAM_TIMEOUT_MS } = await import(
  path.join(engineDir, "lib", "workflow", "services.mjs")
);
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

// ── the yard ─────────────────────────────────────────────────────────────────

const yard = fs.mkdtempSync(path.join(os.tmpdir(), "diagram-probe-"));
/** Absolute git, so the fixture build is immune to the PATH overrides below. */
const GIT = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim() || "/usr/bin/git";
const tempRoots = [yard];

function git(args, cwd) {
  const r = spawnSync(GIT, ["-C", cwd, "-c", "user.email=probe@example.com", "-c", "user.name=probe", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(r.stderr).trim()}`);
  return String(r.stdout).trim();
}

/** A repo the audit can actually rev-parse: `git init` alone has no HEAD, so
 * every fixture base gets one commit before the audit is pointed at it. */
function makeRepo(name) {
  const repo = path.join(yard, name);
  fs.mkdirSync(path.join(repo, "docs", "architecture"), { recursive: true });
  git(["init", "-q"], repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "base"], repo);
  tempRoots.push(repo);
  return repo;
}

/** Env overrides for a synchronous or async body, restored either way. */
async function withEnv(overrides, body) {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await body();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ── the fixture: a real git repo whose second commit plants every drift ──────

const A_V1 = [
  "// a.mjs — the audit fixture", // 1
  "// line two", // 2
  "// line three", // 3
  "", // 4
  "export function movedAnchor() {", // 5
  '  return "moved";', // 6
  "}", // 7
  "", // 8
  "export function intactAnchor() {", // 9
  '  return "intact";', // 10
  "}", // 11
  "", // 12
  "export function editedAnchor() {", // 13
  '  return "original";', // 14
  "}", // 15
].join("\n") + "\n";
// The drift commit: ten lines above the anchors, and one anchored line edited.
const A_V2 = [...Array.from({ length: 10 }, (_, i) => `// drift ${i + 1}`), ...A_V1.split("\n").map((l, i) => (i === 13 ? '  return "edited";' : l))].join(
  "\n",
) + "\n";
const STABLE = ["// stable.mjs — untouched by the drift commit", "export const stable = true;", "export function untouched() {", '  return "same bytes";', "}"].join(
  "\n",
) + "\n";

const fixtureRepo = makeRepo("fixture");
fs.writeFileSync(path.join(fixtureRepo, "src", "..", "a.mjs"), A_V1);
fs.mkdirSync(path.join(fixtureRepo, "src"), { recursive: true });
fs.writeFileSync(path.join(fixtureRepo, "src", "a.mjs"), A_V1);
fs.writeFileSync(path.join(fixtureRepo, "src", "stable.mjs"), STABLE);
fs.writeFileSync(path.join(fixtureRepo, "src", "gone.mjs"), "// gone — deleted at the second commit\nexport const gone = true;\n");
git(["add", "-A"], fixtureRepo);
git(["commit", "-q", "-m", "one — the pinned world"], fixtureRepo);
const pin = git(["rev-parse", "HEAD"], fixtureRepo);

const archPath = path.join(fixtureRepo, "docs", "architecture", "fixture-arch.candidate.json");
const flowPath = path.join(fixtureRepo, "docs", "architecture", "fixture-flow.candidate.json");
const freshPath = path.join(fixtureRepo, "docs", "architecture", "fixture-fresh.candidate.json");
fs.writeFileSync(
  archPath,
  `${JSON.stringify(
    {
      schema_version: 1,
      diagram_type: "architecture",
      meta: { title: "fixture — architecture", repository: { revision: pin } },
      // All three architecture collections carry a ref: components (intact,
      // moved, changed, missing) and boundaries (intact).
      components: [
        { id: "intact", type: "module", label: "intact anchor", sources: [{ path: "src/stable.mjs", line: 1, end_line: 3, label: "intact anchor" }] },
        { id: "moved", type: "module", label: "moved anchor", sources: [{ path: "src/a.mjs", line: 5, end_line: 7, label: "moved anchor" }] },
        { id: "edited", type: "module", label: "edited anchor", sources: [{ path: "src/a.mjs", line: 13, end_line: 15, label: "edited anchor" }] },
        { id: "gone", type: "module", label: "deleted file", sources: [{ path: "src/gone.mjs", line: 1, end_line: 2, label: "deleted file" }] },
      ],
      boundaries: [{ id: "b1", label: "the workspace edge", sources: [{ path: "src/stable.mjs", line: 4, end_line: 6, label: "boundary anchor" }] }],
      connections: [],
    },
    null,
    2,
  )}\n`,
);
fs.writeFileSync(
  flowPath,
  `${JSON.stringify(
    {
      schema_version: 1,
      diagram_type: "workflow",
      meta: { title: "fixture — workflow", repository: { revision: pin } },
      lanes: [],
      phases: [],
      mainPath: [],
      // A workflow diagram's refs live on nodes and edges; the edge ref carries
      // no end_line, so it aliases its own start.
      nodes: [{ id: "n1", lane: "l1", col: 0, type: "external", label: "header node", sources: [{ path: "src/a.mjs", line: 1, end_line: 3, label: "node anchor" }] }],
      edges: [{ id: "e1", from: "n1", to: "n1", label: "aliased edge", sources: [{ path: "src/a.mjs", line: 1, label: "edge anchor (no end_line)" }] }],
    },
    null,
    2,
  )}\n`,
);
git(["add", "-A"], fixtureRepo);
fs.writeFileSync(path.join(fixtureRepo, "src", "a.mjs"), A_V2);
fs.rmSync(path.join(fixtureRepo, "src", "gone.mjs"));
git(["add", "-A"], fixtureRepo);
git(["commit", "-q", "-m", "two — the drift"], fixtureRepo);
const head2 = git(["rev-parse", "HEAD"], fixtureRepo);
// A candidate pinned at HEAD is the no-drift case: stale false, refs intact.
fs.writeFileSync(
  freshPath,
  `${JSON.stringify(
    {
      schema_version: 1,
      diagram_type: "architecture",
      meta: { title: "fixture — fresh at head", repository: { revision: head2 } },
      components: [{ id: "now", type: "module", label: "fresh at head", sources: [{ path: "src/a.mjs", line: 11, end_line: 13, label: "fresh at head" }] }],
      boundaries: [],
      connections: [],
    },
    null,
    2,
  )}\n`,
);

// ── the audit: all four ref verdicts against the real pinned revision ────────

let fixtureAudit;
await check("audit: classifies intact / moved / changed / missing on the planted fixture", async () => {
  fixtureAudit = await diagramAudit({ cwd: fixtureRepo });
  assert.equal(fixtureAudit.ok, true, `refused: ${fixtureAudit.reason}`);
  assert.equal(fixtureAudit.head, head2);
  assert.deepEqual(fixtureAudit.summary, { intact: 3, moved: 3, changed: 1, missing: 1 });

  const [arch, flow, fresh] = fixtureAudit.diagrams;
  assert.deepEqual(fixtureAudit.diagrams.map((d) => d.diagram), ["fixture-arch", "fixture-flow", "fixture-fresh"]);
  assert.equal(arch.type, "architecture");
  assert.equal(flow.type, "workflow");

  // stable.mjs was never touched: its two refs are intact by the identity rule.
  assert.equal(arch.refs.intact, 2);
  // The drifted file's anchors moved whole — old range located verbatim at its
  // new place, same height reported.
  assert.deepEqual(arch.refs.moved, [{ path: "src/a.mjs", from: [5, 7], to: [15, 17], label: "moved anchor" }]);
  // The edited range is not a move: the bytes changed, so the claim may be false
  // and it escalates rather than being auto-corrected.
  assert.deepEqual(arch.refs.changed, [{ path: "src/a.mjs", from: [13, 15], label: "edited anchor" }]);
  // The deleted file.
  assert.deepEqual(arch.refs.missing, [{ path: "src/gone.mjs", from: [1, 2], label: "deleted file" }]);

  // The workflow shape walks nodes[].sources and edges[].sources the same way,
  // and an edge ref with no end_line aliases its own start.
  assert.deepEqual(flow.refs.moved, [
    { path: "src/a.mjs", from: [1, 3], to: [11, 13], label: "node anchor" },
    { path: "src/a.mjs", from: [1, 1], to: [11, 11], label: "edge anchor (no end_line)" },
  ]);
  assert.equal(fresh.stale, false, "a candidate pinned at HEAD is not stale");
  assert.equal(arch.stale, true);
  assert.equal(flow.stale, true);
  assert.equal(fresh.refs.intact, 1);
});

await check("audit: the engine repo's own candidates audit, and the counts are self-consistent", async () => {
  // Report-shaped, not count-pinned: a wave legitimately moves refs, so the
  // assertion is the schema (three diagrams, each with a pin and a stale flag)
  // and the invariant that the summary is the sum of the per-diagram verdicts.
  const real = await diagramAudit({ cwd: engineDir });
  assert.equal(real.ok, true, `refused: ${real.reason}`);
  assert.ok(real.diagrams.length >= 1, "the repo carries candidates");
  const summed = { intact: 0, moved: 0, changed: 0, missing: 0 };
  for (const d of real.diagrams) {
    assert.ok(typeof d.pinnedRevision === "string" && d.pinnedRevision.length > 0, `${d.diagram} names its pin`);
    assert.equal(typeof d.stale, "boolean");
    assert.ok(["architecture", "workflow"].includes(d.type), `${d.diagram}: ${d.type}`);
    summed.intact += d.refs.intact;
    summed.moved += d.refs.moved.length;
    summed.changed += d.refs.changed.length;
    summed.missing += d.refs.missing.length;
  }
  assert.deepEqual(real.summary, summed);
});

await check("audit: one git show per distinct (revision, path), one rev-parse per call", async () => {
  // The audit spawns git through execFile directly, so a monkey-patched
  // child_process.execFile cannot see it (the named import is bound at link
  // time). Counting goes through a PATH shim that logs each spawn and forwards
  // to the real git — hermetic, and it sees every spawn including git's own.
  const shimDir = path.join(yard, "shim");
  fs.mkdirSync(shimDir, { recursive: true });
  const gitLog = path.join(yard, "git-calls.log");
  fs.writeFileSync(
    path.join(shimDir, "git"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${gitLog}"\nexec ${GIT} "$@"\n`,
    { mode: 0o755 },
  );
  fs.rmSync(gitLog, { force: true });
  await withEnv({ PATH: `${shimDir}:${process.env.PATH}` }, async () => {
    await diagramAudit({ cwd: fixtureRepo });
  });
  const lines = fs.existsSync(gitLog) ? fs.readFileSync(gitLog, "utf8").split("\n").filter(Boolean) : [];
  const revParses = lines.filter((l) => l.includes("rev-parse HEAD"));
  const shows = lines.filter((l) => /\bshow\s/.test(l));
  assert.equal(revParses.length, 1, `expected one rev-parse, got ${JSON.stringify(lines)}`);
  // Four distinct (revision, path) pairs: three at the pinned revision and the
  // fresh candidate's ref at HEAD — a second revision is exactly what proves the
  // cache is keyed on both, since a.mjs is read once per revision, not once per
  // ref (five refs, two reads).
  assert.equal(shows.length, 4, `expected four git shows, got ${JSON.stringify(shows)}`);
  assert.equal(shows.filter((l) => l.endsWith(":src/a.mjs")).length, 2, "a.mjs: one read per revision across five refs");
  assert.equal(shows.filter((l) => l.endsWith(":src/stable.mjs")).length, 1, "two refs share one stable.mjs show");
  assert.equal(shows.filter((l) => l.endsWith(":src/gone.mjs")).length, 1, "the deleted file is read once, from the pin");
});

await check("audit: the dir is checked before git is", async () => {
  const r = await diagramAudit({ cwd: yard, dir: "no/such/architecture" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^diagram audit: no no\/such\/architecture directory at /);
});

await check("audit: a directory with no candidates refuses by name", async () => {
  const repo = makeRepo("empty");
  const r = await diagramAudit({ cwd: repo });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^diagram audit: no \*\.candidate\.json in /);
});

await check("audit: git absent is a refusal, not a throw", async () => {
  const before = await diagramAudit({ cwd: fixtureRepo });
  assert.equal(before.ok, true);
  const r = await withEnv({ PATH: path.join(yard, "no-git-here") }, () => diagramAudit({ cwd: fixtureRepo }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /^git not installed/);
});

await check("audit: a candidate that does not parse refuses rather than auditing around it", async () => {
  const repo = makeRepo("broken");
  fs.writeFileSync(path.join(repo, "docs", "architecture", "broken.candidate.json"), '{ "diagram_type": "architecture",\n');
  const r = await diagramAudit({ cwd: repo });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^diagram audit: broken\.candidate\.json is not valid JSON/);
});

// ── the re-pin: moves only, mechanical, idempotent ───────────────────────────

await check("repin: applies the moved refs, leaves changed and missing exactly as authored", async () => {
  const raw = fs.readFileSync(archPath, "utf8");
  const before = JSON.parse(raw);
  const arch = fixtureAudit.diagrams.find((d) => d.diagram === "fixture-arch");
  const r = diagramRepin(raw, arch.refs.moved, { head: fixtureAudit.head });
  assert.equal(r.changes.length, 1);
  assert.deepEqual(r.changes, [{ path: "src/a.mjs", from: [5, 7], to: [15, 17] }]);
  const after = JSON.parse(r.json);
  const find = (o, id) => o.components.find((c) => c.id === id);
  assert.deepEqual(find(after, "moved").sources[0], { path: "src/a.mjs", line: 15, end_line: 17, label: "moved anchor" });
  assert.deepEqual(find(after, "edited").sources, find(before, "edited").sources, "the changed ref is not repaired");
  assert.deepEqual(find(after, "gone").sources, find(before, "gone").sources, "the missing ref is not repaired");
  assert.deepEqual(find(after, "intact").sources, find(before, "intact").sources, "the intact ref is not touched");
  assert.deepEqual(after.boundaries, before.boundaries, "the boundary ref is not touched");
  assert.equal(after.meta.repository.revision, fixtureAudit.head, "the revision rode the same batch");
});

await check("repin: a second application is zero changes and byte-identical json", async () => {
  const raw = fs.readFileSync(archPath, "utf8");
  const arch = fixtureAudit.diagrams.find((d) => d.diagram === "fixture-arch");
  const first = diagramRepin(raw, arch.refs.moved, { head: fixtureAudit.head });
  const second = diagramRepin(first.json, arch.refs.moved, { head: fixtureAudit.head });
  assert.equal(second.changes.length, 0);
  assert.equal(second.json, first.json);
});

await check("repin: a parsed object and its JSON text give the same bytes", async () => {
  const raw = fs.readFileSync(archPath, "utf8");
  const arch = fixtureAudit.diagrams.find((d) => d.diagram === "fixture-arch");
  const fromText = diagramRepin(raw, arch.refs.moved, { head: fixtureAudit.head });
  const fromObject = diagramRepin(JSON.parse(raw), arch.refs.moved, { head: fixtureAudit.head });
  assert.equal(fromText.json, fromObject.json);
  assert.deepEqual(fromObject.changes, fromText.changes);
});

await check("repin: the serialization is the candidates' own byte shape", async () => {
  const raw = fs.readFileSync(archPath, "utf8");
  const arch = fixtureAudit.diagrams.find((d) => d.diagram === "fixture-arch");
  const { json } = diagramRepin(raw, arch.refs.moved, { head: fixtureAudit.head });
  // The repo's real candidates are exactly two-space pretty text with one
  // trailing newline (verified with xxd on system-overview.candidate.json), and
  // the re-pinned candidate must read the same.
  assert.equal(json, `${JSON.stringify(JSON.parse(json), null, 2)}\n`);
  assert.ok(json.endsWith("}\n"), "the candidate ends with a newline, like the repo's files");
  assert.ok(!json.endsWith("\n\n"), "and exactly one");
});

await check("repin: the workflow shape carries an edge ref that grows its end_line", async () => {
  const flow = fixtureAudit.diagrams.find((d) => d.diagram === "fixture-flow");
  const r = diagramRepin(fs.readFileSync(flowPath, "utf8"), flow.refs.moved, { head: fixtureAudit.head });
  assert.equal(r.changes.length, 2);
  const after = JSON.parse(r.json);
  assert.deepEqual(after.nodes[0].sources[0], { path: "src/a.mjs", line: 11, end_line: 13, label: "node anchor" });
  assert.deepEqual(after.edges[0].sources[0], { path: "src/a.mjs", line: 11, end_line: 11, label: "edge anchor (no end_line)" });
});

await check("repin: a move that names no ref changes nothing but still repins", async () => {
  const raw = fs.readFileSync(archPath, "utf8");
  const r = diagramRepin(raw, [{ path: "src/nope.mjs", from: [1, 1], to: [2, 2] }], { head: "deadbee" });
  assert.equal(r.changes.length, 0);
  assert.equal(JSON.parse(r.json).meta.repository.revision, "deadbee");
});

// ── the finalize: the receipt dance against a stub CLI ───────────────────────

const finRepo = makeRepo("fin");
const finCandidate = path.join(finRepo, "docs", "architecture", "fin.candidate.json");
fs.writeFileSync(
  finCandidate,
  `${JSON.stringify(
    {
      schema_version: 1,
      diagram_type: "architecture",
      meta: { title: "fixture — finalize", repository: { revision: pin } },
      components: [{ id: "c1", type: "module", label: "one", sources: [{ path: "src/a.mjs", line: 5, end_line: 7, label: "one" }] }],
      boundaries: [],
      connections: [],
    },
    null,
    2,
  )}\n`,
);
git(["add", "-A"], finRepo);
git(["commit", "-q", "-m", "one"], finRepo);

function stub(name, body) {
  const p = path.join(yard, name);
  fs.writeFileSync(p, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return p;
}

// Stands in for archify: writes the receipt set protocol a real finalize leaves
// in --out-dir (including the candidate copy that must NOT come back), emits the
// HTML beside the candidate, and exits zero.
const RECEIPT_STUB = stub(
  "archify-receipts",
  [
    `const fs = require("node:fs"); const path = require("node:path");`,
    `const argv = process.argv.slice(2);`,
    `const outDir = argv[argv.indexOf("--out-dir") + 1];`,
    `const type = argv[1]; const candidate = argv[2]; const outHtml = argv[3];`,
    `const stem = path.basename(candidate).replace(/\\.candidate\\.json$/, "").replace(/\\.json$/, "");`,
    `fs.mkdirSync(outDir, { recursive: true });`,
    `const write = (name, body) => fs.writeFileSync(path.join(outDir, name), typeof body === "string" ? body : JSON.stringify(body, null, 2) + "\\n");`,
    `if (process.env.STUB_TRACE) fs.appendFileSync(process.env.STUB_TRACE, argv.join(" ") + "\\n");`,
    `write(\`\${stem}.finalize.json\`, { ok: true, command: "finalize", type, stem });`,
    `write(\`\${stem}.finalize-summary.json\`, { ok: true, command: "finalize", type, stem, gates: { quality: "showcase", passed: 2, rejected: 0 } });`,
    `write(\`\${stem}.delivery.json\`, { ok: true, stem, notice: "delivery update pending" });`,
    `write(\`\${stem}.browser-check.json\`, { ok: true, stem, viewport: 1440 });`,
    `write(\`\${stem}.candidate.json\`, fs.readFileSync(candidate, "utf8"));`,
    `fs.writeFileSync(outHtml, "<!doctype html><title>stub</title>\\n", "utf8");`,
    `process.stdout.write(JSON.stringify({ ok: true, outDir }) + "\\n");`,
  ].join("\n"),
);
const EXIT_STUB = stub(
  "archify-exit3",
  [
    `const fs = require("node:fs"); const path = require("node:path");`,
    `const argv = process.argv.slice(2); const outDir = argv[argv.indexOf("--out-dir") + 1];`,
    `fs.mkdirSync(outDir, { recursive: true });`,
    `process.stderr.write("finalize gate rejected: 8px overlap at component c1/mysql\\n");`,
    `process.exit(3);`,
  ].join("\n"),
);
// The real CLI's other failure face: under --json it leaves stderr empty and
// puts the refusal on stdout as {ok:false, status:"fail", failedStage,
// diagnostics:[{code,message}]} — a schema cap reads exactly like this.
const JSON_FAIL_STUB = stub(
  "archify-jsonfail",
  [
    `const fs = require("node:fs"); const path = require("node:path");`,
    `const argv = process.argv.slice(2); const outDir = argv[argv.indexOf("--out-dir") + 1];`,
    `fs.mkdirSync(outDir, { recursive: true });`,
    `process.stdout.write(JSON.stringify({`,
    `  ok: false, command: "finalize", status: "fail", failedStage: "validate",`,
    `  diagnostics: [{ code: "schema/maxItems", message: "/components/12/sources must NOT have more than 3 items" }],`,
    `}) + "\\n");`,
    `process.exit(1);`,
  ].join("\n"),
);
const SLOW_STUB = stub("archify-slow", `const fs = require("node:fs"); setTimeout(() => { fs.appendFileSync("/tmp/never", "late"); process.exit(0); }, 30_000);`);

await check("finalize: the allowlist speaks finalize and refuses every other verb before spawn", async () => {
  assert.deepEqual(DIAGRAM_COMMANDS, ["finalize"]);
  assert.equal(DIAGRAM_TIMEOUT_MS, 300_000, "finalize runs a real browser-check — a batch budget");
  const traced = path.join(yard, "spawn-trace.log");
  fs.rmSync(traced, { force: true });
  const r = await withEnv({ ARCHIFY_BIN: RECEIPT_STUB, STUB_TRACE: traced }, () =>
    diagramFinalize({ command: "preview", type: "architecture", candidate: finCandidate, outDir: path.join(finRepo, "refresh-1") }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unknown diagram command: preview (shipped: finalize)");
  assert.equal(fs.existsSync(traced), false, "an off-list verb never reaches the CLI");
});

await check("finalize: receipts move back beside the candidate, the candidate copy stays put", async () => {
  const outDir = path.join(finRepo, "refresh-1");
  const r = await withEnv({ ARCHIFY_BIN: RECEIPT_STUB }, () =>
    diagramFinalize({ type: "architecture", candidate: finCandidate, outDir, repoRoot: "." }),
  );
  assert.equal(r.ok, true, `refused: ${r.reason}`);
  assert.equal(r.type, "architecture");
  assert.equal(r.outDir, outDir);
  const beside = fs.readdirSync(path.dirname(finCandidate)).sort();
  assert.deepEqual(beside, [
    "fin.browser-check.json",
    "fin.candidate.json",
    "fin.delivery.json",
    "fin.finalize-summary.json",
    "fin.finalize.json",
    "fin.html", // the artifact itself, which the CLI emits beside the candidate
  ]);
  assert.deepEqual(
    r.receipts.map((p) => path.basename(p)).sort(),
    ["fin.browser-check.json", "fin.delivery.json", "fin.finalize-summary.json", "fin.finalize.json"],
  );
  assert.ok(r.receipts.every((p) => path.isAbsolute(p) && path.dirname(p) === path.dirname(finCandidate)), "absolute, beside the candidate");
  // The candidate copy the CLI leaves in the refresh dir is the one file that
  // does not come back — the candidate beside the candidate is not a thing.
  assert.ok(fs.existsSync(path.join(outDir, "fin.candidate.json")), "the candidate copy stays in the refresh dir");
  assert.equal(fs.readFileSync(finCandidate, "utf8"), fs.readFileSync(path.join(outDir, "fin.candidate.json"), "utf8"));
  // The summary's content rides the result.
  assert.equal(r.summary.ok, true);
  assert.equal(r.summary.stem, "fin");
  assert.equal(r.summary.gates.quality, "showcase");
});

await check("finalize: an ARCHIFY_BIN pointing at nothing is the pinned sentence, verbatim", async () => {
  const r = await withEnv({ ARCHIFY_BIN: path.join(yard, "no-such-cli.mjs") }, () =>
    diagramFinalize({ type: "architecture", candidate: finCandidate, outDir: path.join(finRepo, "refresh-2") }),
  );
  assert.equal(r.ok, false);
  assert.equal(
    r.reason,
    "archify CLI not found — the diagram grant needs the archify skill (set ARCHIFY_BIN=/path/to/archify.mjs; see docs)",
  );
  assert.equal(fs.existsSync(path.join(finRepo, "refresh-2")), false, "an absence never spawns a round");
});

await check("finalize: a non-zero exit carries the stderr tail and moves nothing", async () => {
  const outDir = path.join(finRepo, "refresh-3");
  const r = await withEnv({ ARCHIFY_BIN: EXIT_STUB }, () => diagramFinalize({ type: "architecture", candidate: finCandidate, outDir }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /^archify finalize failed \(exit 3\): finalize gate rejected: 8px overlap at component c1\/mysql/);
  assert.equal(fs.existsSync(path.join(outDir, "fin.finalize.json")), false, "a failed round moves no receipt back");
});

await check("finalize: a --json refusal on stdout is not an empty reason", async () => {
  const outDir = path.join(finRepo, "refresh-3");
  const r = await withEnv({ ARCHIFY_BIN: JSON_FAIL_STUB }, () => diagramFinalize({ type: "architecture", candidate: finCandidate, outDir }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /^archify finalize failed \(exit 1\): validate refused: \/components\/12\/sources must NOT have more than 3 items/);
  assert.equal(fs.existsSync(path.join(outDir, "fin.finalize.json")), false, "a failed round moves no receipt back");
});

await check("finalize: a child past its wall clock is killed and says so", async () => {
  const t0 = Date.now();
  const r = await withEnv({ ARCHIFY_BIN: SLOW_STUB }, () => diagramFinalize({ type: "architecture", candidate: finCandidate, outDir: path.join(finRepo, "refresh-4") }, { timeoutMs: 400 }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /archify finalize exceeded 400ms wall clock — child killed/);
  assert.ok(Date.now() - t0 < 5000, "the kill fires near the cap, not the stub's own sleep");
});

await check("archify resolution: ARCHIFY_BIN wins, then ~/.zcode, then ~/.agents", async () => {
  const both = path.join(yard, "home-both");
  const agentsOnly = path.join(yard, "home-agents");
  for (const home of [both, agentsOnly]) {
    fs.mkdirSync(path.join(home, ".agents", "skills", "archify", "bin"), { recursive: true });
    fs.writeFileSync(path.join(home, ".agents", "skills", "archify", "bin", "archify.mjs"), "#!/usr/bin/env node\n");
  }
  fs.mkdirSync(path.join(both, ".zcode", "skills", "archify", "bin"), { recursive: true });
  fs.writeFileSync(path.join(both, ".zcode", "skills", "archify", "bin", "archify.mjs"), "#!/usr/bin/env node\n");

  const zcode = path.join(both, ".zcode", "skills", "archify", "bin", "archify.mjs");
  const agents = path.join(agentsOnly, ".agents", "skills", "archify", "bin", "archify.mjs");
  // HOME is what os.homedir() reads on POSIX; USERPROFILE covers the other one.
  assert.equal(await withEnv({ HOME: both, USERPROFILE: both }, () => resolveArchifyBin()), zcode);
  assert.equal(await withEnv({ HOME: agentsOnly, USERPROFILE: agentsOnly }, () => resolveArchifyBin()), agents);
  assert.equal(await withEnv({ HOME: both, USERPROFILE: both, ARCHIFY_BIN: RECEIPT_STUB }, () => resolveArchifyBin()), RECEIPT_STUB);
  // Set but absent is an absence by name, not a hint to keep searching.
  assert.equal(await withEnv({ HOME: both, USERPROFILE: both, ARCHIFY_BIN: path.join(yard, "gone.mjs") }, () => resolveArchifyBin()), null);
  // Nothing configured anywhere: null, and the caller refuses with the sentence.
  assert.equal(await withEnv({ HOME: path.join(yard, "home-empty"), USERPROFILE: path.join(yard, "home-empty") }, () => resolveArchifyBin()), null);
});

// ── the next refresh dir ─────────────────────────────────────────────────────

await check("nextRefreshDir: a fresh base is refresh-1, existing rounds are never reused", () => {
  const fresh = path.join(yard, "arch-fresh");
  fs.mkdirSync(fresh, { recursive: true });
  assert.equal(nextRefreshDir(fresh), path.join(fresh, "refresh-1"));
  const used = path.join(yard, "arch-used");
  for (const name of ["refresh-1", "refresh-3", "refresh-semantic"]) fs.mkdirSync(path.join(used, name), { recursive: true });
  assert.equal(nextRefreshDir(used), path.join(used, "refresh-4"), "non-numeric refresh dirs are not rounds");
  // A base that does not exist yet still names the first round.
  assert.equal(nextRefreshDir(path.join(yard, "not-there")), path.join(yard, "not-there", "refresh-1"));
});

// ── the engine binding: the grant, the journal, the refusal ──────────────────

const wfDir = fs.mkdtempSync(path.join(os.tmpdir(), "diagram-wf-"));
const wfFile = path.join(wfDir, "diagram-binding-smoke.ts");
fs.writeFileSync(
  wfFile,
  `/* workflow
description: "Probe: the world.diagram binding — grant gate, journaling, service call."
whenToUse: Probe only — never a real task.
*/
phase("audit the fixture candidates");
const outcome = { refused: null, moved: null, changes: null };
try {
  const audit = await world.diagram.audit({ dir: "docs/architecture" });
  if (audit.ok) outcome.moved = audit.summary.moved;
  else outcome.refused = audit.reason;
} catch (e) {
  outcome.refused = String((e as Error)?.message ?? e);
}
try {
  const repin = world.diagram.repin("{}", [], { head: "c0ffee" });
  outcome.changes = repin.changes.length;
} catch (e) {
  outcome.refused = String((e as Error)?.message ?? e);
}
return { conclusion: "diagram binding smoke", findings: [], verified: [], notCovered: [], outcome };
`,
);

/** The journal lines of one run, in order. */
function journalOf(runDir) {
  return fs
    .readFileSync(path.join(runDir, "run.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

await check("binding: a granted run fires, and every leg is one journal line with counts", async () => {
  const runDir = path.join(yard, "run-granted");
  fs.mkdirSync(runDir, { recursive: true });
  const { runWorkflow } = await import(path.join(engineDir, "lib", "workflow", "engine.mjs"));
  const run = await withEnv({ MEMORY_FILE_PATH: path.join(yard, "memory.jsonl") }, () =>
    runWorkflow(wfFile, { grants: "diagram", workdir: fixtureRepo, outDir: runDir }),
  );
  assert.equal(run.summary.ok, true, `run failed: ${run.summary.error}\n${String(run.summary.stack ?? "").split("\n").slice(0, 6).join("\n")}`);
  assert.equal(run.result?.outcome?.moved, 3, "the workflow saw the fixture's three moves");
  assert.equal(run.result?.outcome?.changes, 0);
  const lines = journalOf(runDir).filter((e) => String(e.command ?? "").startsWith("diagram_"));
  assert.equal(lines.length, 2, JSON.stringify(lines));
  const [auditLine, repinLine] = lines;
  assert.equal(auditLine.kind, "command");
  assert.equal(auditLine.command, "diagram_audit");
  assert.equal(auditLine.grant, "diagram");
  assert.deepEqual([auditLine.intact, auditLine.moved, auditLine.changed, auditLine.missing], [3, 3, 1, 1]);
  assert.equal(repinLine.command, "diagram_repin");
  assert.equal(repinLine.changes, 0);
});

await check("binding: an ungranted run refuses by name and journals the refusal", async () => {
  const runDir = path.join(yard, "run-denied");
  fs.mkdirSync(runDir, { recursive: true });
  const { runWorkflow } = await import(path.join(engineDir, "lib", "workflow", "engine.mjs"));
  const run = await withEnv({ MEMORY_FILE_PATH: path.join(yard, "memory.jsonl") }, () =>
    runWorkflow(wfFile, { workdir: fixtureRepo, outDir: runDir }),
  );
  assert.equal(run.summary.ok, true, `run failed: ${run.summary.error}`);
  assert.match(String(run.result?.outcome?.refused ?? ""), /^capability not granted in this run: diagram/);
  const denied = journalOf(runDir).filter((e) => String(e.command ?? "").startsWith("diagram_"));
  assert.equal(denied.length, 2);
  assert.ok(denied.every((e) => e.refused && e.grant === "diagram"), JSON.stringify(denied));
  assert.ok(denied[0].refused.includes(CAPABILITIES.diagram.what));
});

await check("binding: finalize threads the run's workspace as its cwd", async () => {
  // The stub's argv is the proof: the out-dir it receives is the refresh dir
  // under the workspace the run was given, not the process cwd.
  const traced = path.join(yard, "finalize-trace.log");
  fs.rmSync(traced, { force: true });
  const runDir = path.join(yard, "run-finalize");
  fs.mkdirSync(runDir, { recursive: true });
  const finWf = path.join(wfDir, "diagram-finalize-smoke.ts");
  fs.writeFileSync(
    finWf,
    `/* workflow
description: "Probe: the finalize leg of the diagram binding."
whenToUse: Probe only — never a real task.
args:
  outDir:
    type: string
    description: Refresh dir under the run's workspace.
    required: true
  candidate:
    type: string
    description: Candidate path, relative to the workspace.
    required: true
*/
const r = await world.diagram.finalize({ type: "architecture", candidate: args.candidate, outDir: args.outDir });
if (!r.ok) return { ok: false, refused: r.reason, findings: [], verified: [], notCovered: [] };
return { ok: true, receipts: r.receipts.length, summary: r.summary, findings: [], verified: [], notCovered: [] };
`,
  );
  const { runWorkflow } = await import(path.join(engineDir, "lib", "workflow", "engine.mjs"));
  const run = await withEnv({ MEMORY_FILE_PATH: path.join(yard, "memory.jsonl"), ARCHIFY_BIN: RECEIPT_STUB, STUB_TRACE: traced }, () =>
    runWorkflow(finWf, {
      grants: "diagram",
      workdir: finRepo,
      outDir: runDir,
      args: { outDir: "refresh-1", candidate: "docs/architecture/fin.candidate.json" },
    }),
  );
  assert.equal(run.summary.ok, true, `run failed: ${run.summary.error}\n${String(run.summary.stack ?? "").split("\n").slice(0, 6).join("\n")}`);
  // Relative spec paths resolve against the run's workspace (finRepo), which is
  // where the candidate lives; the receipts land beside it there.
  assert.equal(run.result.ok, true, `finalize refused: ${run.result.refused}`);
  assert.equal(run.result.receipts, 4);
  assert.ok(fs.existsSync(path.join(finRepo, "docs", "architecture", "fin.finalize.json")), "receipts beside the candidate, in the workspace");
  const trace = fs.readFileSync(traced, "utf8").trim().split("\n");
  assert.equal(trace.length, 1, "one spawn, node <cli> finalize …");
  assert.match(trace[0], /--repo-root \. --quality showcase --json --out-dir \S*refresh-1/, `argv: ${trace[0]}`);
});

// ── the grant: default-off, known, and never pre-granted ─────────────────────

await check("grant: diagram is a known capability and default-off", () => {
  assert.ok(CAPABILITIES.diagram, "CAPABILITIES must declare diagram");
  assert.equal(CAPABILITIES.diagram.granted, false);
  assert.match(CAPABILITIES.diagram.what, /archify diagrams/);
  assert.match(CAPABILITIES.diagram.what, /batch-only, never inside an agent turn/);
});
await check("grant: resolveGrants({}) holds no diagram", () => {
  const g = resolveGrants({});
  assert.ok(!g.held.has("diagram"), "defaults must not include diagram");
  assert.ok(!g.summary().includes("diagram"));
});
await check("grant: --grant diagram is accepted, so a run can opt in", () => {
  const g = resolveGrants({ grants: "diagram" });
  assert.ok(g.held.has("diagram"));
});

// ── the tally ────────────────────────────────────────────────────────────────

for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(wfDir, { recursive: true, force: true });
if (failures.length) {
  console.log(`  failed: ${failures.join(" | ")}`);
}
console.log(`unit-services-diagram: ${pass} cases pass, ${failures.length} fail`);
process.exitCode = failures.length ? 1 : 0;
