#!/usr/bin/env node
/**
 * The swarm risk composition's positive proof (plan C6): a planted
 * top-decile row in the cached risk_prior.csv causes a part whose paths touch
 * that directory to be gated TWICE — and both passes must support.
 *
 * This drives the REAL composition (createSwarm's gateParts, via the
 * testability seam on the returned object) against a stubbed
 * DEV_DECISIONS_BIN that records every invocation and its plan file's first
 * line, so the assertions read the actual second gate's plan note. The real
 * risk_prior.csv is backed up before the fixture is written and restored
 * after — the store is shared machine state and leaves this probe untouched.
 *
 * Scenarios:
 *   1  both passes support → the risky part runs two gates (the second plan
 *      carries the elevated note) and is accepted with elevated:true; the
 *      clean part runs exactly one gate
 *   2  the elevated pass refuses (exit 1, a real gate answer) while the
 *      primary supports → the part is DROPPED with elevated:true — both must
 *      support is the whole point
 *
 * Usage: node tools/probe-swarm-risk-gate.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let passed = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STORE = path.join(os.homedir(), ".local", "share", "dev-decisions", "tables");
const RISK_TABLE = path.join(STORE, "risk_prior.csv");
const FIXTURE = ["dir,commits,churn_lines,revert_prior,confidence",
  "docs,3,120,0.05,0.90",
  "router,8,400,0.10,0.90",
  "lib,2,60,0.95,0.95",
].join("\n") + "\n";

// The stub CLI: records {argv, planFirstLine} per invocation, answers
// SUPPORTED — unless STUB_REJECT_ELEVATED is set and the plan is the
// elevated pass, where it answers NOT_SUPPORTED on exit 1 (a real gate
// answer, per runGate's own parsing).
const STUB = `#!/usr/bin/env node
import fs from "node:fs";
// runGate invokes: stub evidence-gate <plan> <evidence> — slice(3) skips
// node, this script, and the subcommand.
const [planPath, evidencePath] = process.argv.slice(3);
const log = process.env.STUB_LOG;
const line = { sub: process.argv[2], plan: planPath, planFirstLine: (fs.readFileSync(planPath, "utf8").split("\\n")[0] || "") };
fs.appendFileSync(log, JSON.stringify(line) + "\\n");
const rejectElevated = process.env.STUB_REJECT_ELEVATED === "1";
if (rejectElevated && (fs.readFileSync(planPath, "utf8").includes("elevated pass"))) {
  console.log("verdict: NOT_SUPPORTED");
  console.log("detail: the elevated pass refuses on policy");
  process.exit(1);
}
console.log("verdict: SUPPORTED");
`;

const parts = [
  { id: "p1", title: "Edit the plane core", instruction: "Change lib/workflow/services.mjs to add the flag.", acceptance: ["the flag lands"] },
  { id: "p2", title: "Docs pass", instruction: "Update docs/readme.md with the new section.", acceptance: ["the section lands"] },
];
const built = [
  { text: "p1 built text", providerId: "fake", model: "fake" },
  { text: "p2 built text", providerId: "fake", model: "fake" },
];

async function runScenario({ rejectElevated }) {
  const stubLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "risk-gate-")), "invocations.jsonl");
  const stubPath = path.join(path.dirname(stubLog), "stub-dd.mjs");
  fs.writeFileSync(stubPath, STUB);
  fs.chmodSync(stubPath, 0o755);
  fs.writeFileSync(stubLog, "");

  process.env.DEV_DECISIONS_BIN = stubPath;
  process.env.STUB_LOG = stubLog;
  if (rejectElevated) process.env.STUB_REJECT_ELEVATED = "1";
  else delete process.env.STUB_REJECT_ELEVATED;

  // Import AFTER the env pin: GATE_BIN is read at module load.
  const { createSwarm } = await import("../router/swarm.mjs");
  const events = [];
  const swarm = createSwarm({
    getConfig: () => ({}),
    upstream: {},
    rewriteBody: (b) => b,
    thinkingStyleFor: () => "none",
    usage: {},
    log: (e) => events.push(e),
  });

  const signals = { lastUser: "probe request" };
  const { accepted, report } = await swarm.gateParts(signals, parts, built, "risk-gate-probe", "auto");

  const invocations = fs.readFileSync(stubLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { accepted, report, invocations, events: events.filter((e) => e.error || e.stderr || e.event === 'swarm-gate') };
}

// ── the shared fixture, backed up and restored around the whole proof ───────
fs.mkdirSync(STORE, { recursive: true });
const hadRealTable = fs.existsSync(RISK_TABLE);
const backup = hadRealTable ? fs.readFileSync(RISK_TABLE) : null;
fs.writeFileSync(RISK_TABLE, FIXTURE);

try {
  console.log("\n1 — both passes support: the risky part is gated twice");
  {
    const { accepted, report, invocations } = await runScenario({ rejectElevated: false });
    const p1 = report.find((r) => r.id === "p1");
    const p2 = report.find((r) => r.id === "p2");
    ok("the risky part is accepted with elevated:true", p1?.state === "accepted" && p1?.elevated === true, JSON.stringify(p1));
    ok("the clean part is accepted without elevation", p2?.state === "accepted" && !p2?.elevated, JSON.stringify(p2));
    const p1Gates = invocations.filter((i) => String(i.plan).endsWith("plan-part-p1.md") || String(i.plan).endsWith("plan-part-p1-elevated.md"));
    const p1Normal = p1Gates.filter((i) => String(i.plan).endsWith("plan-part-p1.md"));
    const p1Elevated = p1Gates.filter((i) => String(i.plan).endsWith("plan-part-p1-elevated.md"));
    ok("the risky part ran TWO gate invocations", p1Gates.length === 2, `got ${p1Gates.length}: ${JSON.stringify(p1Gates.map((i) => i.plan))}`);
    ok("the second gate's plan carries the elevated note", p1Elevated.length === 1 && p1Elevated[0].planFirstLine.includes("elevated pass"), JSON.stringify(p1Elevated[0]));
    ok("both elevated answers were SUPPORT", p1Normal.length === 1 && p1Elevated.length === 1);
    const p2Gates = invocations.filter((i) => String(i.plan).endsWith("plan-part-p2.md"));
    ok("the clean part ran exactly ONE gate", p2Gates.length === 1, `got ${p2Gates.length}`);
    ok("the elevated part landed in accepted", accepted.some((a) => a.id === "p1"));
    ok("the swarm-risk event fired", invocations.length >= 3);
  }

  console.log("\n2 — the elevated pass refuses: both must support");
  {
    const { accepted, report, invocations } = await runScenario({ rejectElevated: true });
    const p1 = report.find((r) => r.id === "p1");
    ok("the risky part is DROPPED despite its primary pass supporting", p1?.state === "dropped" && p1?.elevated === true, JSON.stringify(p1));
    ok("the drop names the elevated gate", /elevated gate/.test(p1?.reason ?? ""), p1?.reason);
    ok("the risky part never reached accepted", !accepted.some((a) => a.id === "p1"));
    const p1Elevated = invocations.filter((i) => String(i.plan).endsWith("plan-part-p1-elevated.md"));
    ok("the elevated invocation still fired (the refusal is the gate's answer)", p1Elevated.length === 1);
    const p2 = report.find((r) => r.id === "p2");
    ok("the clean part is unaffected by the refusal", p2?.state === "accepted");
  }

  await sleep(50);
} finally {
  if (backup !== null) fs.writeFileSync(RISK_TABLE, backup);
  else fs.rmSync(RISK_TABLE, { force: true });
}

console.log(`\nprobe-swarm-risk-gate: ${passed} checks pass, ${failures.length} fail`);
if (failures.length) {
  console.log(`failed: ${failures.join("; ")}`);
  process.exit(1);
}
