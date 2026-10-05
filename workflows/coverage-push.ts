/* workflow
description: "Adds the missing tests: per-area gap finders and test writers work
  chained in parallel, then the test suite decides — fix rounds until npm test
  passes. Each area reports which gaps its new tests cover."
whenToUse: When the request is to add tests or improve test coverage for a
  module or the whole codebase.
args:
  target:
    type: string
    description: "The scope to add tests for: a module, directory, or the codebase."
    required: true
*/
/**
 * coverage-push: add the missing tests. Gap finders and test writers work
 * per area in parallel, and the test suite decides when it is done.
 */

interface Gap {
  /** The file or function that lacks coverage. */
  target: string;
  /** What behavior is untested, one sentence. */
  missing: string;
}

interface GapReport {
  /** The area covered. */
  area: string;
  gaps: Gap[];
}

interface WriteOutcome {
  /** The area covered. */
  area: string;
  /** Test files written. */
  files: string[];
  /** Which gaps the new tests cover. */
  covered: string[];
}

interface Finding {
  where: string;
  what: string;
  evidence: string;
  status: "verified" | "unconfirmed";
  severity: "low" | "medium" | "high";
}

const target = String(args.target ?? "").trim() || "the codebase";

phase("Find the missing tests in each area");
const planner = agent("Planner", {
  system:
    "You plan test coverage work: split a scope into 2 to 6 areas and, for each, find the " +
    "behaviors that most need tests — the ones where a wrong result would hurt. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});
const plan = await planner.ask<{ areas: { id: string; name: string; where: string }[] }>(
  `Scope: ${target}\n\nRead the code. Split the scope into 2 to 6 areas. Return areas with id, name, and where.`
);
log(`Finding gaps in ${plan.areas.length} areas in parallel`);

phase("Find each area's gaps and write its tests as they land");
const outcomes = await Promise.all(
  plan.areas.map(async (area) => {
    const finder = agent(`Gap finder for ${area.name}`, {
      system:
        "You find untested behavior in one area of a codebase and never edit files. " +
        "Prioritize behavior where a wrong result would hurt. " +
        "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
    });
    const gaps = await finder.ask<GapReport>(
      `Area: ${area.name} (${area.where})\n\nRead the code and the existing tests. Return the most important untested behaviors as gaps.`
    );
    if (gaps.gaps.length === 0) return { area: area.name, files: [], covered: [] };
    const writer = agent(`Test writer for ${area.name}`, {
      system:
        "You write tests for one area of a codebase: focused, deterministic, and following " +
        "the project's existing test conventions. Write the test files and change nothing else. " +
        "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
    });
    const outcome = await writer.ask<WriteOutcome>(
      `Write tests covering these gaps in ${area.name}:\n${JSON.stringify(gaps.gaps)}\n\n` +
        "Follow the project's test conventions. Return area, files, and covered."
    );
    const f: Finding = {
      where: area.name,
      what: `new tests cover ${outcome.covered.length} of ${gaps.gaps.length} identified gaps`,
      evidence: `files: ${outcome.files.join(", ")}`,
      status: "unconfirmed",
      severity: "low",
    };
    report(f);
    return outcome;
  })
);

const findings: Finding[] = [];
let feedback = "";
let testsPass = false;
phase("Run the test suite and fix failures until green");
const fixer = agent("Fixer", {
  system:
    "You fix failing tests: correct the test when the test is wrong, and say plainly when " +
    "the code is wrong instead of hiding it. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});
for (let round = 1; round <= 3; round++) {
  const tests = await world.run("npm", ["test"]);
  if (tests.exitCode === 0) {
    testsPass = true;
    break;
  }
  feedback = tests.stderr.slice(-2000);
  await fixer.ask(`The test suite fails:\n${feedback}\n\nFix it.`);
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

const md = [
  `# Tests added for: ${target}`,
  "",
  `Suite: ${testsPass ? "green" : "FAILING"}.`,
  "",
  ...outcomes.map((o) => `- **${o.area}** — files: ${o.files.join(", ") || "(none)"}; covered: ${o.covered.join("; ") || "(none)"}`),
].join("\n");
await artifact.markdown("deliverable", md, { title: "Coverage report", primary: true });

return {
  conclusion: `Tests added across ${outcomes.length} areas; the suite is ${testsPass ? "green" : "FAILING"}.`,
  findings,
  verified: ["npm test run as the gate after the new tests landed"],
  notCovered: [
    "gaps an area's writer could not cover in one pass — see each area's covered list",
  ],
};
