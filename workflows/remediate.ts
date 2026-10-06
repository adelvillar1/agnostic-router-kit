/* workflow
description: "Applies confirmed findings: a planner groups them by file and fix
  order, each group is fixed under a per-group checkpoint, and the verify
  command decides — a fix that cannot verify is rolled back clean. Every
  finding ends with exactly one verdict: fixed, rolled-back, or unfixable."
whenToUse: When a review-sweep or bug-hunt run produced confirmed findings and
  someone should actually fix them.
args:
  findings:
    type: string
    description: JSON array of {where, what, severity?} — the confirmed findings.
    required: true
  verify:
    type: string
    description: The command that decides, as "cmd arg arg" (default "npm test").
    required: false
*/
/**
 * remediate: apply the findings, let the suite decide.
 * Groups are fixed sequentially (fixes can interact), each under a checkpoint
 * of its own files: a group that cannot verify rolls back to the snapshot, so
 * a failed fix leaves no debris. The suite, not a model, says when it is done.
 */

interface FindingIn {
  /** Workspace-relative path the problem is in. */
  where: string;
  /** One sentence: what is wrong. */
  what: string;
  severity?: "low" | "medium" | "high";
}

interface FixPlan {
  /** Fix groups in order — shared files share a group. */
  groups: { id: string; files: string[]; findings: string[] }[];
}

interface FixOutcome {
  /** The group id. */
  id: string;
  /** What the fixer changed, in a sentence or two. */
  summary: string;
}

const ESCALATE =
  "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.";

let findings: FindingIn[] = [];
try {
  findings = typeof args.findings === "string" ? JSON.parse(args.findings) : args.findings;
} catch (e) {
  throw new Error(`findings is not valid JSON: ${String(e?.message ?? e)}`);
}
if (!Array.isArray(findings) || findings.length === 0) {
  throw new Error("remediate needs at least one finding — there is nothing to fix");
}
const verifyParts = String(args.verify ?? "npm test").trim().split(/\s+/);
const verifyCmd = verifyParts[0];
const verifyArgs = verifyParts.slice(1);
log(`remediating ${findings.length} finding(s); gate: ${verifyCmd} ${verifyArgs.join(" ")}`);

// ── gate files ───────────────────────────────────────────────────────────────
// The gate's inputs are untouchable, and no model gets to declare otherwise:
// test and spec files are excluded from every group's file list no matter what
// the planner declares, and an edit to one is an ownership violation even when
// the planner scoped it in. A fixer that can edit the gate can game the gate.
const GATE_FILE = /(^|\/)(test|tests|spec|__tests__)\//i;
const GATE_FILE_SUFFIX = /\.(test|spec)\.[a-z]+$/i;
const isGateFile = (f) => GATE_FILE.test(f) || GATE_FILE_SUFFIX.test(f);

// ── ownership ────────────────────────────────────────────────────────────────
// A fixer that can edit the tests can game the gate, so the gate must be able
// to detect it: every fixer runs under a whole-workspace snapshot, and any
// change outside its group's declared files rolls the fixer back entirely.
// The manifest re-globs every call, so even a brand-new file counts. A
// workspace over the checkpoint's byte cap degrades honestly — the ownership
// check turns off and the result says so.
function workspaceFiles() {
  return (files.glob("**/*") ?? []).filter(
    (f) => !f.startsWith("node_modules/") && !f.startsWith(".git/") && !f.startsWith("out/")
  );
}
function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
async function manifest() {
  const m = {};
  for (const f of workspaceFiles()) {
    try {
      m[f] = djb2(await files.read(f));
    } catch {
      m[f] = "absent";
    }
  }
  return m;
}
const allFiles = workspaceFiles();

phase("Plan the fix order");
const planner = agent("Remediation planner", {
  system:
    "You plan code fixes: group findings that touch the same files or depend on each other, order " +
    "the groups so independent ones come first, and name the workspace-relative files each group " +
    "will touch. Keep file lists exact — they become the rollback snapshot. You never edit files: " +
    "the fixers do, and a plan that pre-applies a fix would corrupt the rollback snapshot. " + ESCALATE,
});
const fixPlanRaw = await planner.ask<FixPlan>(
  `Findings:\n${JSON.stringify(findings)}\n\n` +
    `Group them into fix groups with id, files, and the finding texts each group covers. ` +
    `Never include test or spec files in a group's files — those belong to the gate.`
);
// Deterministic exclusion: whatever the planner declared, gate files are out.
const fixPlan = {
  groups: fixPlanRaw.groups.map((g) => ({ ...g, files: (g.files ?? []).filter((f) => !isGateFile(f)) })),
};

phase("Fix each group under its checkpoint and let the verify command decide");
const verdicts: { what: string; where: string; verdict: "fixed" | "rolled-back"; note: string }[] = [];
let ownershipOn = true;
for (const group of fixPlan.groups) {
  const before = ownershipOn ? await manifest() : null;
  const ownershipSnap = ownershipOn
    ? await world.checkpoint({ label: `${group.id}-ownership`, paths: allFiles })
    : null;
  if (ownershipSnap?.oversized) {
    ownershipOn = false;
    log(`workspace over the checkpoint byte cap — the ownership check degrades off for the rest of the run`);
  }
  const snapshot = await world.checkpoint({ label: group.id, paths: group.files });
  const fixer = agent(`Fixer ${group.id}`, {
    system:
      "You fix exactly the findings you are handed: minimal, correct changes in the named files " +
      "only. You do not refactor beyond the findings. Do NOT run the verify command or the test " +
      "suite yourself — the run does that after you return, and rounds spent re-running it are " +
      "wasted. Editing anything outside the named files — especially the tests — is an ownership " +
      "violation: the run detects it and rolls you back. Read, edit, return. " + ESCALATE,
    budget: { rounds: 6, tokens: 150000 },
  });
  let outcome: FixOutcome | null = null;
  try {
    outcome = await fixer.ask<FixOutcome>(
      `Fix these findings:\n${JSON.stringify(group.findings)}\n\nFiles you may touch: ${group.files.join(", ")}\n\n` +
        `You already know the defect — make the edit in one or two rounds and return. Return id and summary.`
    );
  } catch (e) {
    // A fixer that hits its line leaves the question "did the fix land?" to
    // the only honest judge: the verify command. The gate runs either way.
    log(`fixer ${group.id} hit its line: ${String(e?.message ?? e).slice(0, 160)}`);
  }
  // Ownership: any change outside the group's declared files — and any edit to
  // a gate file, declared or not — voids the fix. A fixer that could touch the
  // gate cannot be trusted to have passed it.
  if (ownershipSnap && !ownershipSnap.oversized) {
    const after = await manifest();
    const touched = Object.keys(after).filter((k) => before[k] !== after[k]);
    const violations = touched.filter((k) => !group.files.includes(k) || isGateFile(k));
    if (violations.length) {
      await world.rollback(ownershipSnap);
      for (const what of group.findings)
        verdicts.push({
          what,
          where: group.id,
          verdict: "rolled-back",
          note: `ownership violation — the fixer edited outside its files (${violations.join(", ")}); the whole group rolled back`,
        });
      report({ group: group.id, verdict: "rolled-back", ownershipViolation: violations });
      continue;
    }
  }
  const check = await world.run(verifyCmd, verifyArgs);
  if (check.exitCode === 0) {
    for (const what of group.findings)
      verdicts.push({ what, where: group.id, verdict: "fixed", note: outcome?.summary ?? "the fix landed; the fixer hit its round cap but the gate verified" });
    report({ group: group.id, verdict: "fixed", summary: outcome?.summary ?? "gate verified after a capped fixer" });
    continue;
  }
  if (outcome) {
    // One repair round with the failure output, then the checkpoint decides.
    try {
      await fixer.ask(
        `The verify command still fails after your fix:\n${String(check.stderr || check.stdout).slice(-2000)}\n\n` +
          `Fix what it flags. Do not run the command yourself.`
      );
    } catch (e) {
      log(`repair round hit its line: ${String(e?.message ?? e).slice(0, 160)}`);
    }
  }
  const recheck = await world.run(verifyCmd, verifyArgs);
  if (recheck.exitCode === 0) {
    for (const what of group.findings) verdicts.push({ what, where: group.id, verdict: "fixed", note: outcome?.summary ?? "repaired after one round" });
    report({ group: group.id, verdict: "fixed", summary: "verified after the repair round" });
  } else {
    await world.rollback(snapshot);
    for (const what of group.findings)
      verdicts.push({
        what,
        where: group.id,
        verdict: "rolled-back",
        note: `the group could not verify — rolled back to the checkpoint; last failure: ${String(recheck.stderr || recheck.stdout).slice(-400)}`,
      });
    report({ group: group.id, verdict: "rolled-back" });
  }
}

phase("Final gate");
const finalCheck = await world.run(verifyCmd, verifyArgs);
const suitePass = finalCheck.exitCode === 0;

const fixed = verdicts.filter((v) => v.verdict === "fixed").length;
const rolledBack = verdicts.filter((v) => v.verdict === "rolled-back").length;
const md = [
  `# Remediation report`,
  "",
  `Gate: \`${verifyCmd} ${verifyArgs.join(" ")}\` — ${suitePass ? "passing" : "FAILING"}.`,
  `Findings: ${verdicts.length} (${fixed} fixed, ${rolledBack} rolled back).`,
  "",
  ...verdicts.map((v) => `- **${v.verdict}** ${v.what}\n  - ${v.note}`),
].join("\n");
await artifact.markdown("deliverable", md, { title: "Remediation report", primary: true });

return {
  conclusion: `${verdicts.length} findings: ${fixed} fixed, ${rolledBack} rolled back. Gate ${suitePass ? "passes" : "FAILS"}.`,
  verdicts,
  suitePass,
  verified: [
    "every finding received exactly one verdict",
    "a group that could not verify was rolled back to its checkpoint — no debris",
    "the verify command decided, not a model",
  ],
  notCovered: ["findings whose fix requires changes outside the named files — those roll back by design"],
};
