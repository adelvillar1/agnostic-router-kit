#!/usr/bin/env node
/**
 * The semantic shadow router's influence guarantee, executed (C8).
 *
 * The shadow must be pure agreement data: it reads the judge's verdict after
 * the fact and logs what the geometry would have picked. Proven here:
 *   1. the geometry — wouldPick/cosine executed over planted vectors (nearest
 *      wins, ties go first, dim mismatch is a named error);
 *   2. the logger — makeSemrouteShadow warmed against a stub embedding
 *      server, notes journaled with evalOnly/applied:false, agreement both
 *      ways;
 *   3. the fail-open — a dead embedding server disables the logger BY NAME,
 *      note() resolves null without throwing, and the disabling row says
 *      "routing unchanged";
 *   4. the wiring — server.js greps: the tap is fire-and-forget after the
 *      judge's verdict, nothing reads its return, and the registry comes
 *      from R.workflows.
 *
 *   node tools/probe-semroute-shadow.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const engineDir = path.resolve(import.meta.dirname, "..");
const { cosine, wouldPick, makeSemrouteShadow } = await import(
  path.join(engineDir, "router", "semroute-shadow.mjs")
);

let pass = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok — ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL — ${name}: ${String(e?.message ?? e).slice(0, 240)}`);
  }
}

// ── 1. the geometry ──────────────────────────────────────────────────────────

await check("geometry: the nearest shape wins, ties go to the earlier", () => {
  const names = ["review-sweep", "deep-research", "triage"];
  const matrix = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  assert.equal(wouldPick([0.9, 0.1, 0], matrix, names).name, "review-sweep");
  assert.equal(wouldPick([0, 0.8, 0.2], matrix, names).name, "deep-research");
  const tie = [
    [1, 0],
    [0, 1],
  ];
  assert.equal(wouldPick([0.70710678, 0.70710678], tie, ["a", "b"]).name, "a");
});
await check("geometry: a dim mismatch is a named error, never a confident wrong answer", () => {
  assert.throws(() => cosine([1, 0], [1, 0, 0]), /dim mismatch/);
});

// ── 2. the logger against a stub embedding server ────────────────────────────

const VECTORS = {
  "reviewing changes": [1, 0, 0],
  "researching a topic": [0, 1, 0],
  "the request text": [0.92, 0.2, 0],
};
const stub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    let input = [];
    try {
      input = JSON.parse(body).input ?? [];
    } catch {}
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: input.map((t) => ({ embedding: VECTORS[t] ?? [0, 0, 1] })) }));
  });
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${stub.address().port}/v1`;

await check("logger: warm embeds the registry; an agreeing note journals eval-only rows", async () => {
  const sink = [];
  const shadow = makeSemrouteShadow({
    registry: [
      { name: "review-sweep", text: "reviewing changes" },
      { name: "deep-research", text: "researching a topic" },
    ],
    embedUrl: url,
    model: "test-model",
    log: (row) => sink.push(row),
  });
  await shadow.warm();
  assert.ok(shadow.warmed, `disabled: ${shadow.disabled}`);
  const row = await shadow.note("the request text", "review-sweep");
  assert.equal(row.agree, true);
  assert.equal(row.evalOnly, true);
  assert.equal(row.applied, false);
  const disagree = await shadow.note("the request text", "triage");
  assert.equal(disagree.agree, false);
  assert.equal(disagree.wouldPick, "review-sweep");
  assert.ok(sink.some((r) => r.event === "semroute-shadow" && r.detail === "warm"));
  assert.ok(sink.filter((r) => r.kind === "semroute-shadow").length === 2);
});
await check("logger: a warm still in flight simply does not log", async () => {
  const shadow = makeSemrouteShadow({
    registry: [{ name: "a", text: "reviewing changes" }],
    embedUrl: url,
    model: "m",
    log: () => {},
  });
  assert.equal(await shadow.note("x", "a"), null, "unwarmed notes are silent no-ops");
});

// ── 3. the fail-open ─────────────────────────────────────────────────────────

await check("fail-open: a dead embedding server disables the logger by name", async () => {
  const sink = [];
  const shadow = makeSemrouteShadow({
    registry: [{ name: "a", text: "reviewing changes" }],
    embedUrl: "http://127.0.0.1:9/enotlistening",
    model: "m",
    log: (row) => sink.push(row),
  });
  await shadow.warm();
  assert.ok(!shadow.warmed);
  assert.match(shadow.disabled, /embedding server unavailable/);
  assert.match(shadow.disabled, /routing unchanged/);
  const row = await shadow.note("anything", "a"); // must not throw
  assert.equal(row, null);
  assert.ok(sink.some((r) => r.detail === "disabled"));
});

// ── 4. the wiring ────────────────────────────────────────────────────────────

await check("wiring: the tap is fire-and-forget after the judge, and nothing reads its return", () => {
  const src = fs.readFileSync(path.join(engineDir, "router", "server.js"), "utf8");
  const tapAt = src.indexOf("void shadowRoute");
  const judgeAt = src.indexOf("const judged = await runJudge(signals);");
  assert.ok(judgeAt > 0 && tapAt > judgeAt, "the tap must sit after the judge's verdict exists");
  const tapBlock = src.slice(tapAt, tapAt + 400);
  assert.ok(!/\bawait\s+shadowRoute/.test(tapBlock), "the tap must not be awaited — delegation timing is identical either way");
  assert.ok(!/=\s*shadowRoute\s*\?\.\s*note/.test(src), "nothing may assign the note's return");
  assert.match(src, /registry: \(R\.workflows \?\? \[\]\)/, "the registry is the roster's own shape sentences");
  assert.match(src, /shadowRoute\.warm\(\);/, "warm rides the listen callback, fire-and-forget");
});

stub.close();
if (failures.length) {
  console.log(`  failed: ${failures.join(" | ")}`);
}
console.log(`probe-semroute-shadow: ${pass} checks pass, ${failures.length} fail`);
process.exitCode = failures.length ? 1 : 0;
