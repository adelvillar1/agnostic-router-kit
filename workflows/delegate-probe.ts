/* workflow
description: "Probe: bounded sub-agent delegation — one level, a real spawn, a real refusal."
whenToUse: Probe only — never a real task. One part has to complete its work by
  handing one sub-lookup to a sub-agent, which proves the round trip. Run with
  `--grant workspace-io,sub-agents` for the spawn path and with only
  `--grant workspace-io` for the refusal path (`--args '{"mode":"ungranted"}'`).
args:
  mode:
    type: string
    description: "granted (default) — the sub-agents capability is on; ungranted — it is not."
    required: false
*/
/**
 * delegate-probe: a sub-agent is a real agent of the run, not a prompt trick.
 *
 * The value of delegation is a context that does not carry the parent's
 * history into the part that needs a fresh look. That only holds if the child
 * is spawned by the engine, with the workspace and grants of the run and a
 * surface that has no way back into delegation itself. Two paths are asserted
 * here: the spawn path (the child does the lookup, its answer returns to the
 * parent, and the journal carries the child's contract and its own tool calls)
 * and the refusal path (a run without the capability refuses, and the refusal
 * is as auditable as a fired call).
 */

const MODE = String(args.mode ?? "granted") === "ungranted" ? "ungranted" : "granted";

const REL = "out/delegate-probe/1/ledger.txt";
const CODE_WORD = "QUARTZ-4117";

phase("Seed the ledger the sub-agent will be asked to read");

const seeded = await world.run("node", [
  "-e",
  `require('fs').mkdirSync('out/delegate-probe/1',{recursive:true});` +
    `require('fs').writeFileSync('${REL}',` +
    `['kettle handle count: 1','hearth sweep: daily','SECRET CODE WORD: ${CODE_WORD}',` +
    `'oat store: 40kg','brook depth: 2m'].join('\\n')+'\\n','utf8')`,
]);
if (seeded.exitCode !== 0) throw new Error(`seed failed: ${seeded.stderr || seeded.stdout}`);

const lines = String(await files.read(REL)).split("\n").filter((l) => l.length > 0);
if (lines.length !== 5) throw new Error(`seeded ${lines.length} lines, expected 5`);
report(`seeded ${REL} with a five-line ledger; the code word is on the SECRET CODE WORD line`);

phase(MODE === "granted" ? "Delegate the lookup, then answer from what comes back" : "Attempt the delegation the capability does not cover");

const coordinator = agent("Coordinator", {
  system:
    "You are given one job and you may not do the lookup part of it yourself. Hand every lookup to a sub-agent " +
    "with the delegate tool: state the task fully, because the sub-agent sees none of your context. Report the " +
    "sub-agent's reply verbatim.",
  contract: {
    files: [REL],
    acceptance: [
      "the lookup of the ledger's code word is delegated, not read by the coordinator",
      "the sub-agent's reply is reported verbatim",
      "the final answer is the code word the sub-agent returned, nothing else",
    ],
    provides: "the code word, and the sub-agent's reply verbatim",
  },
});

const r = await coordinator.ask<{
  codeWord: string;
  subAgentReply: string;
  refusalText?: string;
}>(
  MODE === "granted"
    ? [
        `The file ${REL} holds a five-line ledger. One line reads "SECRET CODE WORD: <word>".`,
        ``,
        `Do NOT read this file yourself. Call the delegate tool exactly once, with the task:`,
        `"Read the file ${REL} in this workspace and report the single word on the line that begins with SECRET CODE WORD, and nothing else."`,
        `Give the sub-agent this contract: files ["${REL}"], acceptance ["the word on the SECRET CODE WORD line is read from the file", "nothing else is reported"], provides "the single code word".`,
        `Then answer with what the sub-agent replied.`,
        ``,
        `Return codeWord (the word the sub-agent reported) and subAgentReply (its reply, verbatim).`,
      ].join("\n")
    : [
        `The file ${REL} holds a five-line ledger. One line reads "SECRET CODE WORD: <word>".`,
        ``,
        `Call the delegate tool once, with the task:`,
        `"Read the file ${REL} and report the word on the line that begins with SECRET CODE WORD."`,
        `The call is expected to be refused. When it is, do not retry it — report the refusal text verbatim`,
        `instead of reading the file yourself.`,
        ``,
        `Return refusalText (the tool's error text, verbatim) and codeWord set to the string "REFUSED".`,
      ].join("\n")
);

const problems: string[] = [];
if (MODE === "granted") {
  if (String(r.codeWord ?? "").trim() !== CODE_WORD) {
    problems.push(`the sub-agent's answer did not come back: ${JSON.stringify(r.codeWord)}`);
  }
  if (!String(r.subAgentReply ?? "").includes(CODE_WORD)) {
    problems.push(`the sub-agent's reply was not reported verbatim: ${JSON.stringify(r.subAgentReply)}`);
  }
} else {
  if (String(r.codeWord ?? "").trim() !== "REFUSED") {
    problems.push(`the ungranted run did not stop at the refusal: ${JSON.stringify(r.codeWord)}`);
  }
  // The error comes back through whichever field the model reports it in — the
  // shape of the report is the agent's choice, the refusal is not.
  const refusalText = String(r.refusalText ?? r.subAgentReply ?? "");
  if (!/sub-agents/.test(refusalText) || !/not granted/.test(refusalText)) {
    problems.push(`the refusal does not name the capability: ${JSON.stringify(r.refusalText ?? r.subAgentReply)}`);
  }
}

return {
  conclusion: problems.length
    ? `${MODE}: ${problems.length} problem(s)`
    : MODE === "granted"
      ? "the sub-agent read the ledger and its answer returned to the parent intact"
      : "the ungranted run refused the delegation and named the capability",
  findings: problems,
  report: { mode: MODE, ledgerLines: lines.length, ...r },
};
