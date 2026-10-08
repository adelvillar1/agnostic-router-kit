#!/usr/bin/env node
/**
 * diagram-refresh's mechanical four-fifths, executed and held (C3/C4).
 *
 * The loop's promise: it keeps the archify diagrams anchored to the code and
 * authors nothing. Proven here by driving the REAL workflow body — the same
 * text transform the plane applies (`annotateAskSites`, the surface bound as
 * globals, `export default async function`) — over a real temp git repo with a
 * planted candidate carrying one of every drift class, and a stub archify CLI:
 *
 *   1. the first pass finds the planted drift, re-pins exactly the moved ref
 *      (byte-identity located verbatim at its new lines), leaves the changed
 *      and missing refs as authored, finalizes through the stub CLI into
 *      refresh-1 with the receipts moved back beside the candidate, and runs
 *      the stills leg against a planted HTML/PNG pair;
 *   2. the second pass is a no-op — 0 moved, 0 changes, no second round, the
 *      candidate byte-identical after (idempotence counted, not trusted);
 *   3. the dry run reports the same drift and writes nothing at all;
 *   4. archify absent ends the loop fail-open by name: the re-pin stands, the
 *      conclusion carries the refusal verbatim, no receipt moves, no refresh
 *      dir is created, and the exit is a normal loop result;
 *   5. the structure — the file spawns no agent, makes no model call, and
 *      writes exactly one file per candidate (the named candidate).
 *
 *   node tools/probe-diagram-refresh.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const engineDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { diagramAudit, diagramRepin, diagramFinalize } = await import(path.join(engineDir, "lib", "workflow", "services.mjs"));
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

const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// ── the planted repo ────────────────────────────────────────────────────────
// Seed commit carries the code every ref pins; the second commit moves one
// anchored block verbatim (a move), edits another block's bytes (a changed
// claim), and deletes a file (missing). One candidate carries all three plus
// an untouched ref; a second candidate is entirely intact.

const PLANE_SEED = [
  `export const GRANT = "diagram";`,
  `export const COMMANDS = ["finalize"];`,
  `export const TIMEOUT = 300000;`,
  ``,
  `// ── the audit ──`,
  `export function audit() {`,
  `  return "byte-identity";`,
  `}`,
  ``,
  `// ── the stills ──`,
  `export function stills() {`,
  `  return "read-never-assumed";`,
  `}`,
].join("\n");
const CLAIMS_SEED = [`export const FIRST = "one";`, ``, `// ── the claims ──`, `export const CLAIM = "original";`, `export const KEEP = "kept";`].join("\n");
const GONE_SEED = [`export const LEAVING = "going";`, `export const ALSO = "going";`, `export function bye() {`, `  return 1;`, `}`].join("\n");

const yard = fs.mkdtempSync(path.join(os.tmpdir(), "diagram-refresh-probe-"));
const repo = path.join(yard, "repo");
fs.mkdirSync(path.join(repo, "lib"), { recursive: true });
fs.mkdirSync(path.join(repo, "docs", "architecture"), { recursive: true });
fs.writeFileSync(path.join(repo, "lib", "plane.mjs"), PLANE_SEED + "\n");
fs.writeFileSync(path.join(repo, "lib", "claims.mjs"), CLAIMS_SEED + "\n");
fs.writeFileSync(path.join(repo, "lib", "gone.mjs"), GONE_SEED + "\n");
// A still the render leg can verify: the planted HTML's viewBox at 2x is
// exactly the planted PNG's IHDR size. render-png --check decodes no pixels —
// it reads the IHDR — so a synthetic PNG with the right dimensions is a real
// check, not a mock of one.
fs.writeFileSync(
  path.join(repo, "docs", "architecture", "system-overview.html"),
  `<!doctype html><html><head><style>@font-face{font-family:x}</style><style>:root{--bg:#fff}</style></head><body><svg viewBox="0 0 200 64"><rect width="200" height="64"/></svg></body></html>`,
);
fs.writeFileSync(path.join(repo, "docs", "architecture", "system-overview.png"), pngBytes(400, 128));
fs.copyFileSync(path.join(engineDir, "docs", "architecture", "render-png.mjs"), path.join(repo, "docs", "architecture", "render-png.mjs"));

const ARCH = path.join(repo, "docs", "architecture");
const CANDIDATE = path.join(ARCH, "system-overview.candidate.json");
const CLEAN = path.join(ARCH, "run-lifecycle.candidate.json");
const candidate = (rev) => ({
  diagram_type: "architecture",
  meta: { repository: { revision: rev } },
  components: [
    { id: "plane", label: "the diagram lane", sources: [{ path: "lib/plane.mjs", line: 1, end_line: 3, label: "the grant row" }] },
    { id: "claims", label: "the claims", sources: [{ path: "lib/claims.mjs", line: 3, end_line: 5, label: "the anchored claim" }] },
    { id: "gone", label: "the departed box", sources: [{ path: "lib/gone.mjs", line: 2, end_line: 3, label: "the departed file" }] },
    { id: "stills", label: "the stills leg", sources: [{ path: "lib/plane.mjs", line: 10, end_line: 13, label: "the stills leg" }] },
  ],
  connections: [{ id: "e1", from: "plane", to: "stills" }],
});
const cleanCandidate = (rev) => ({
  diagram_type: "architecture",
  meta: { repository: { revision: rev } },
  components: [{ id: "lifecycle", label: "the run lifecycle", sources: [{ path: "lib/plane.mjs", line: 1, end_line: 3, label: "the grant row" }] }],
});

git(repo, "init", "-q");
git(repo, "config", "user.email", "probe@example.invalid");
git(repo, "config", "user.name", "probe");
// The candidates are planted before the seed commit so the seed itself is the
// pin they name — the same relation the repo's real candidates have.
const seedRev = (() => {
  fs.writeFileSync(CANDIDATE, JSON.stringify(candidate("PENDING"), null, 2) + "\n");
  fs.writeFileSync(CLEAN, JSON.stringify(cleanCandidate("PENDING"), null, 2) + "\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");
  return git(repo, "rev-parse", "HEAD");
})();
fs.writeFileSync(CANDIDATE, JSON.stringify(candidate(seedRev), null, 2) + "\n");
fs.writeFileSync(CLEAN, JSON.stringify(cleanCandidate(seedRev), null, 2) + "\n");

// The drift: the stills block moves down verbatim (four lines inserted above
// it, leaving the grant row exactly where it was), the claims block's bytes
// are edited, the departed file is removed.
const PLACE_9 = PLANE_SEED.split("\n").slice(0, 9);
const stillsBlock = PLANE_SEED.split("\n").slice(9);
const drift = () => {
  fs.writeFileSync(
    path.join(repo, "lib", "plane.mjs"),
    [...PLACE_9, `// (c) the probe`, `// header line two`, `// header line three`, ``, ...stillsBlock].join("\n") + "\n",
  );
  fs.writeFileSync(path.join(repo, "lib", "claims.mjs"), [`export const FIRST = "one";`, ``, `// ── the claims ──`, `export const CLAIM = "rewritten";`, `export const KEEP = "kept";`].join("\n"));
  fs.rmSync(path.join(repo, "lib", "gone.mjs"));
};
drift();
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "drift");
const headA = git(repo, "rev-parse", "HEAD");
const readCandidate = () => JSON.parse(fs.readFileSync(CANDIDATE, "utf8"));
const srcOf = (json, id) => json.components.find((c) => c.id === id).sources[0];

// ── the stub archify CLI ────────────────────────────────────────────────────
const STUB = path.join(yard, "archify-stub.mjs");
fs.writeFileSync(
  STUB,
  [
    `import fs from "node:fs";`,
    `const [verb, type, cand, outHtml] = process.argv.slice(2);`,
    `if (verb !== "finalize") { console.error("stub: only finalize"); process.exit(2); }`,
    `const outDir = process.argv[process.argv.indexOf("--out-dir") + 1];`,
    `const stem = cand.split("/").pop().replace(/\\.candidate\\.json$/, "").replace(/\\.json$/, "");`,
    `const body = fs.readFileSync(cand, "utf8");`,
    // The real CLI's captureReceipt mkdirs the receipt's parent, so the stub
    // does the same — the plane does not create the round dir for it.
    `fs.mkdirSync(outDir, { recursive: true });`,
    // A finalize re-emits the HTML from the candidate, so the stub keeps the
    // diagram's own shape — the same viewBox — or the stills leg would fail on
    // a render the real CLI would have produced correctly.
    `fs.writeFileSync(outHtml, "<!doctype html><html><head><style>@font-face{font-family:x}</style><style>:root{--bg:#fff}</style></head><body><svg viewBox=\\"0 0 200 64\\"><rect width=\\"200\\" height=\\"64\\"/></svg></body></html>");`,
    `for (const name of [stem + ".finalize.json", stem + ".finalize-summary.json", stem + ".browser-check.json", stem + ".delivery.json"]) {`,
    `  fs.writeFileSync(outDir + "/" + name, JSON.stringify({ stub: true, type, name }));`,
    `}`,
    `// The CLI's own copy of the candidate, deliberately marked: the receipt`,
    `// dance must leave THIS file in the refresh dir and never mistake it for`,
    `// a receipt to move back beside the real one.`,
    `fs.writeFileSync(outDir + "/" + stem + ".candidate.json", JSON.stringify({ marked: "the CLI's copy" }));`,
    `fs.writeFileSync(outDir + "/invocation.json", JSON.stringify({ verb, type, candidate: cand, outHtml, outDir }));`,
    `process.stdout.write(JSON.stringify({ ok: true, stub: true }) + "\\n");`,
  ].join("\n"),
);

// ── the loop, driven through the plane's own transform ──────────────────────
const source = fs.readFileSync(path.join(engineDir, "workflows", "diagram-refresh.ts"), "utf8");
const moduleText = `export default async function __wfRun() {\n${annotateAskSites(source).source}\n}`;
const modulePath = path.join(yard, "module.mts");
fs.writeFileSync(modulePath, moduleText);
const mod = await import(new URL(`file://${modulePath}`).href);
const grants = resolveGrants({ grants: "diagram,process", allowCommands: "node" });

/** Bind the run surface as globals — the engine's own line — and call the loop. */
async function drive(runArgs, { archifyBin }) {
  const collected = { logs: [], phases: [], reports: [], artifacts: [] };
  const prevArchify = process.env.ARCHIFY_BIN;
  if (archifyBin) process.env.ARCHIFY_BIN = archifyBin;
  else delete process.env.ARCHIFY_BIN;
  const api = {
    args: runArgs,
    log: (m) => collected.logs.push(String(m)),
    phase: (n) => collected.phases.push(String(n)),
    report: (item) => collected.reports.push(item),
    escalate: () => {
      throw new Error("diagram-refresh must never escalate — it reports");
    },
    artifact: {
      markdown: async (id, content, opts) => {
        collected.artifacts.push({ id, content: String(content), title: opts?.title ?? id });
        return { id, version: 1 };
      },
      file: async (id) => {
        throw new Error(`diagram-refresh must never publish a file artifact (${id})`);
      },
    },
    files: {
      read: (rel) => fs.readFileSync(path.join(repo, String(rel)), "utf8"),
      glob: () => [],
      grep: () => [],
    },
    world: {
      diagram: {
        audit: (opts) => diagramAudit({ ...opts, cwd: repo }),
        repin: (json, moved, o) => diagramRepin(json, moved, o),
        finalize: (spec, callOpts) => diagramFinalize({ ...spec, cwd: repo }, callOpts),
      },
      run: (cmd, args) => worldRun(cmd, args, repo, grants, () => {}),
    },
  };
  const keys = Object.keys(api);
  for (const k of keys) globalThis[k] = api[k];
  try {
    const result = await mod.default();
    return { ...collected, result };
  } finally {
    for (const k of keys) delete globalThis[k];
    if (prevArchify === undefined) delete process.env.ARCHIFY_BIN;
    else process.env.ARCHIFY_BIN = prevArchify;
  }
}
const one = (run, name) => (run.result.repinned ?? []).filter((r) => r.diagram === name);
// The audit reads the dir in sorted order, so run-lifecycle comes first: look
// each diagram up by name rather than trusting an index.
const diagramOf = (run, name) => run.result.diagrams.find((d) => d.diagram === name);

// ── 1. the first pass: the planted drift, re-pinned and finalized ───────────
const run1 = await drive({ dir: "docs/architecture" }, { archifyBin: STUB });

await check("audit: one of every drift class found at the pinned revision", () => {
  const d = diagramOf(run1, "system-overview");
  const clean = diagramOf(run1, "run-lifecycle");
  assert.equal(d.intact, 1);
  assert.equal(d.moved, 1);
  assert.equal(d.changed, 1);
  assert.equal(d.missing, 1);
  assert.equal(d.stale, true, "the pin names the seed commit; the head is past it");
  assert.equal(clean.intact, 1);
  assert.equal(clean.moved + clean.changed + clean.missing, 0);
});
await check("re-pin: exactly the move, at the bytes' verbatim new lines", () => {
  const r = one(run1, "system-overview");
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].changes, [{ path: "lib/plane.mjs", from: [10, 13], to: [14, 17] }]);
});
await check("re-pin: the candidate now carries the new range and the head pin", () => {
  const json = readCandidate();
  const stills = srcOf(json, "stills");
  assert.equal(stills.line, 14);
  assert.equal(stills.end_line, 17);
  assert.equal(json.meta.repository.revision, headA);
  // The unchanged refs are byte-identical: same path, same range, same label.
  const claims = srcOf(json, "claims");
  assert.equal(claims.path, "lib/claims.mjs");
  assert.equal(claims.line, 3);
  assert.equal(claims.label, "the anchored claim");
});
await check("finalize: one round, into refresh-1, receipts moved back", () => {
  const rounds = run1.result.rounds;
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].diagram, "system-overview");
  assert.match(rounds[0].outDir, /refresh-1$/);
  for (const name of ["system-overview.finalize.json", "system-overview.finalize-summary.json", "system-overview.browser-check.json", "system-overview.delivery.json"]) {
    assert.ok(fs.existsSync(path.join(ARCH, name)), `${name} should be back beside the candidate`);
    assert.ok(!fs.existsSync(path.join(yard, rounds[0].outDir, name)), `${name} should have left the refresh dir`);
  }
  // The clean candidate was never touched, so it was never finalized.
  assert.ok(!fs.existsSync(path.join(ARCH, "run-lifecycle.finalize.json")), "an intact candidate is not re-finalized");
});
await check("finalize: the type and a fresh out-dir reached the CLI; the CLI's candidate copy stayed behind", () => {
  const inv = JSON.parse(fs.readFileSync(path.join(repo, rounds1().outDir, "invocation.json"), "utf8"));
  assert.equal(inv.verb, "finalize");
  assert.equal(inv.type, "architecture");
  assert.equal(inv.candidate, CANDIDATE);
  // services resolves the out-dir it spawns with; the loop's own value is the
  // repo-relative one it computed, so the pair is compared as paths.
  assert.equal(inv.outDir, path.resolve(repo, rounds1().outDir));
  // The copy the CLI leaves in the refresh dir is not a receipt: it must not
  // travel back, and the real candidate beside it must not be overwritten.
  assert.ok(fs.existsSync(path.join(repo, rounds1().outDir, "system-overview.candidate.json")));
  assert.equal(readCandidate().meta?.marked, undefined);
});
await check("stills: the render leg ran render-png.mjs --check and passed", () => {
  assert.deepEqual(run1.result.stills, { mode: "check", ran: true, exitCode: 0 });
  assert.match(run1.logs.join("\n"), /system-overview\.png — 400x128/);
});
await check("report: the artifact lists the unresolved refs and commands the eye pass", () => {
  const art = run1.artifacts.find((a) => a.id === "diagram-refresh");
  assert.ok(art, "the loop published its markdown artifact");
  assert.match(art.content, /the anchored claim/);
  assert.match(art.content, /the departed file/);
  assert.match(art.content, /Eye-verify the stills before committing/);
  const owed = run1.result.owed;
  assert.equal(owed.length, 2);
  assert.deepEqual(
    owed.map((o) => o.path).sort(),
    ["lib/claims.mjs", "lib/gone.mjs"],
  );
  assert.equal(run1.result.notCovered.length, 4, "authoring, meaning, layout repair, the stills' appearance");
  assert.match(run1.result.conclusion, /owed to an agent/);
});
await check("journal: the phases ran in order and the run never escalated", () => {
  assert.deepEqual(run1.phases, [
    "Audit the diagram candidates",
    "Re-pin the moved refs",
    "Finalize 1 candidate(s)",
    "Stills — verify",
    "Report what moved and what is still owed",
  ]);
  assert.ok(run1.reports.some((r) => r.repinned));
});
function rounds1() {
  return run1.result.rounds[0];
}

// ── 2. the second pass: idempotence, counted ────────────────────────────────
const before2 = fs.readFileSync(CANDIDATE, "utf8");
const run2 = await drive({ dir: "docs/architecture" }, { archifyBin: STUB });
await check("idempotence: the second pass is a no-op", () => {
  const d = diagramOf(run2, "system-overview");
  assert.equal(d.moved, 0);
  // The edit the first pass named is the head's own bytes now: the re-pin
  // moved the pin onto the revision that made it, so the claim reads intact
  // against its own pin and the first pass's artifact is where it was named.
  // The loop does not nag, and it does not repair — the second pass proves it
  // leaves the file exactly as the first pass wrote it.
  assert.equal(d.changed, 0);
  assert.equal(d.stale, false, "the pin now names the head");
  assert.equal(run2.result.repinned.length, 0);
  assert.equal(run2.result.rounds.length, 0, "no second finalize round ran");
  assert.equal(fs.readFileSync(CANDIDATE, "utf8"), before2, "the candidate is byte-identical after");
  // The deleted file is still gone, so the missing ref stays owed and the
  // conclusion keeps the owed branch — a refresh does not resurrect a file.
  assert.match(run2.result.conclusion, /0 move\(s\)\), 0 finalized, 0 changed \/ 1 missing ref\(s\) owed to an agent/);
  assert.ok(!fs.existsSync(path.join(ARCH, "refresh-2")), "no second refresh dir was created");
});

// ── 3. the dry run: the same drift, reported and not written ────────────────
// A fresh move planted after the idempotence pass: two more lines land above
// the stills block, so the audit has real work and the dry run must decline it.
const planeNow = () => fs.readFileSync(path.join(repo, "lib", "plane.mjs"), "utf8").split("\n");
fs.writeFileSync(path.join(repo, "lib", "plane.mjs"), [...planeNow().slice(0, 9), `// a line`, `// another line`, ...planeNow().slice(9)].join("\n"));
const beforeDry = fs.readFileSync(CANDIDATE, "utf8");
const run3 = await drive({ dir: "docs/architecture", dryRun: true }, { archifyBin: STUB });
await check("dry run: reports the move, writes nothing, runs no round", () => {
  assert.equal(diagramOf(run3, "system-overview").moved, 1);
  assert.equal(run3.result.repinned.length, 0);
  assert.equal(run3.result.rounds.length, 0);
  assert.equal(fs.readFileSync(CANDIDATE, "utf8"), beforeDry, "the candidate is untouched");
  assert.match(run3.logs.join("\n"), /dry run: 1 move\(s\) would be re-pinned/);
  assert.equal(run3.result.stills.exitCode, 0, "the check leg is a read, so it still runs");
});

// ── 4. archify absent: fail-open by name ────────────────────────────────────
const run4 = await drive({ dir: "docs/architecture" }, { archifyBin: path.join(yard, "no-such-archify.mjs") });
await check("archify absent: the re-pin stands, the refusal is verbatim, nothing else runs", () => {
  // The same planted move the dry run declined is applied here.
  const r = one(run4, "system-overview");
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].changes, [{ path: "lib/plane.mjs", from: [14, 17], to: [16, 19] }]);
  assert.equal(run4.result.rounds.length, 0);
  assert.equal(run4.result.finalizeRefused.length, 1);
  assert.match(run4.result.finalizeRefused[0].reason, /archify CLI not found/);
  assert.match(run4.logs.join("\n"), /archify CLI not found/);
  assert.match(run4.result.conclusion, /archify CLI not found/);
  // No receipt moved and no round dir appeared: refresh-2 would be the next
  // number after refresh-1, so its absence is the proof a round did not run.
  assert.ok(!fs.existsSync(path.join(ARCH, "refresh-2")));
  assert.ok(!fs.existsSync(path.join(ARCH, "run-lifecycle.finalize.json")));
  assert.equal(run4.result.stills.exitCode, 0);
});

// ── 5. the structure: what the file cannot do ───────────────────────────────
await check("structure: no agent, no model call, no import, one writer", () => {
  assert.ok(!/\bagent\s*\(\s*["'`]/.test(source), "the loop spawns no agent");
  assert.ok(!/\.ask<?/.test(source), "the loop makes no model ask");
  assert.ok(!/world\.(search|scrape)/.test(source), "the loop touches no network");
  assert.ok(!/^import /m.test(source), "the loop imports nothing — every effect rides the bound surface");
  assert.ok(/world\.diagram\.audit/.test(source) && /world\.diagram\.repin/.test(source) && /world\.diagram\.finalize/.test(source));
  assert.match(source, /writeFileSync\(process\.argv\[1\],process\.argv\[2\]\)/, "the writer names exactly one file");
  for (const line of ["never authors a node", "never verifies", "never repairs a layout", "never accepts a still"]) {
    assert.ok(source.includes(line), `the file says it ${line}`);
  }
});
await check("structure: the four drift verdicts and the eye line are the loop's own words", () => {
  const art = run1.artifacts.find((a) => a.id === "diagram-refresh").content;
  for (const phrase of ["byte-identical", "Re-pinned (mechanical)", "Owed to an agent (judgment", "Eye-verify the stills before committing"]) {
    assert.ok(art.includes(phrase), `the artifact carries "${phrase}"`);
  }
});

fs.rmSync(yard, { recursive: true, force: true });
console.log(`\n${pass} checks, ${failures.length} failed${failures.length ? `: ${failures.join("; ")}` : ""}`);
if (failures.length) process.exit(1);

// ── helpers ─────────────────────────────────────────────────────────────────
/** A PNG with the given IHDR dimensions — render-png --check reads only those. */
function pngBytes(w, h) {
  const chunk = (type, data) => {
    const out = Buffer.alloc(4);
    out.writeUInt32BE(data.length);
    const head = Buffer.concat([out, Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(head.subarray(4)));
    return Buffer.concat([head.subarray(0, head.length), crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const idat = zlib.deflateSync(Buffer.alloc(1 + w * h));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
