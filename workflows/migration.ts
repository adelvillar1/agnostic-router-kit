/* workflow
description: "Migrates a codebase from one approach to another with command
  gates: a planner splits the work into independent areas, migrators work in
  parallel, and the test suite and build decide when it is done — fix rounds
  until npm test passes, then npm run build before handover."
whenToUse: When the request is to move code from one approach, library, or
  pattern to another across a repository.
args:
  task:
    type: string
    description: What to migrate from, to what.
    required: true
*/
/**
 * migration: move a codebase from one approach to another.
 * A planner splits the work into areas, migrators work in parallel, and the
 * test suite and build decide when it is actually done.
 */

interface MigrationStep {
  /** Short id for the area, like "1". */
  id: string;
  /** One or two sentences: what changes in this area. */
  description: string;
  /** The main files this area touches. */
  files: string[];
}

interface MigrationPlan {
  steps: MigrationStep[];
}

interface StepOutcome {
  /** The area migrated. */
  id: string;
  /** What changed and the key decisions taken. */
  summary: string;
  /** Files written or changed. */
  files: string[];
}

interface Finding {
  where: string;
  what: string;
  evidence: string;
  status: "verified" | "unconfirmed";
  severity: "low" | "medium" | "high";
}

const task = String(args.task ?? "").trim() || "Migrate the codebase.";

phase("Plan the migration");
const planner = agent("Planner", {
  system:
    "You plan code migrations: split the work into 3 to 8 independent areas that different " +
    "people could migrate in parallel without conflicts. Each area has a clear end state. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});
const plan = await planner.ask<MigrationPlan>(
  `Migration: ${task}\n\n` +
    "Read the code first. Return steps with id, description, and files for each area."
);
log(`Migrating ${plan.steps.length} areas in parallel`);

phase("Migrate each area in parallel");
const outcomes = await Promise.all(
  plan.steps.map(async (step) => {
    const migrator = agent(`Migrator for ${step.id}`, {
      system:
        "You are a senior engineer migrating one area of a codebase. Make the change completely " +
        "in your area and leave the code working. " +
        "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
    });
    return migrator.ask<StepOutcome>(
      `Migration: ${task}\n\nYour area: ${step.description}\nFiles: ${step.files.join(", ")}\n\n` +
        "Make the change. Return id, summary, and files."
    );
  })
);

const findings: Finding[] = [];
let feedback = "";
let testsPass = false;
phase("Run the tests and fix what they flag");
const fixer = agent("Fixer", {
  system:
    "You fix failing checks after a migration: minimal, correct changes only. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});
for (let round = 1; round <= 3; round++) {
  const tests = await world.run("npm", ["test"]);
  if (tests.exitCode === 0) {
    testsPass = true;
    break;
  }
  feedback = tests.stderr.slice(-2000);
  await fixer.ask(
    `The test suite fails after this migration: ${task}\n\nFailures:\n${feedback}\n\nFix them.`
  );
}
if (!testsPass) {
  const f: Finding = {
    where: "test suite",
    what: "the tests still fail after the fix rounds",
    evidence: feedback,
    status: "verified",
    severity: "high",
  };
  findings.push(f);
  report(f);
}

phase("Check the build before handing over");
const build = await world.run("npm", ["run", "build"]);
const buildPass = build.exitCode === 0;
if (!buildPass) {
  const f: Finding = {
    where: "build",
    what: "the build does not pass after the migration",
    evidence: build.stderr.slice(-1500),
    status: "verified",
    severity: "high",
  };
  findings.push(f);
  report(f);
  const fixer = agent("Build fixer", {
    system:
      "You fix build failures after a migration: minimal, correct changes only. " +
      "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
  });
  await fixer.ask(`The build fails:\n${build.stderr.slice(-2000)}\n\nFix it.`);
}
const rebuild = await world.run("npm", ["run", "build"]);
const finalBuild = rebuild.exitCode === 0;
const finalTests = await world.run("npm", ["test"]);
testsPass = finalTests.exitCode === 0;

const md = [
  `# Migration: ${task}`,
  "",
  `Tests: ${testsPass ? "passing" : "FAILING"}. Build: ${finalBuild ? "passing" : "FAILING"}.`,
  "",
  ...outcomes.map((o) => `- **${o.id}** ${o.summary}\n  - files: ${o.files.join(", ")}`),
].join("\n");
await artifact.markdown("deliverable", md, { title: "Migration report", primary: true });

return {
  conclusion: `${plan.steps.length} areas migrated; tests ${testsPass ? "pass" : "FAIL"}, build ${finalBuild ? "passes" : "FAILS"}.`,
  findings,
  verified: [
    "npm test run as the gate",
    "npm run build run as the final check",
  ],
  notCovered: [
    "end-to-end suites beyond `npm test` — add one to the repo if the migration touches user-visible behavior",
  ],
};
