/* workflow
description: "Probe: edit_file — one exact match, declared."
whenToUse: Probe only — never a real task. Seeds a file, then has one agent
  change part of it with edit_file and attempt the two edits that must fail: a
  zero match and an ambiguous match. The file on disk afterwards is the
  assertion — a whole-file rewrite would have rewritten the untouched lines.
args:
  task:
    type: string
    description: Unused; kept so --args matches the library shape.
    required: false
*/
/**
 * edit-probe: the read-before-write discipline, enforced as code.
 *
 * Whole-file regeneration is the dominant corruption mode for a part that
 * touches an existing file — a 400-line file written from the model's memory
 * truncates and drifts silently. edit_file refuses to guess: the old_string
 * must be present exactly once, and the count is named when it isn't.
 */

interface EditReport {
  /** The tool's own return for the edit that must apply. */
  uniqueEdit: string;
  /** The tool's error for an old_string present twice. */
  ambiguous: string;
  /** The tool's error for an old_string present nowhere. */
  missing: string;
}

const REL = "out/edit-probe/1/target.txt";

phase("Seed the file the editor will edit");

const seeded = await world.run("node", [
  "-e",
  `require('fs').mkdirSync('out/edit-probe/1',{recursive:true});` +
    `require('fs').writeFileSync('${REL}',` +
    `'line one keeps the word token\\nline two keeps the word token\\nline three is unique\\n','utf8')`,
]);
if (seeded.exitCode !== 0) throw new Error(`seed failed: ${seeded.stderr || seeded.stdout}`);
report(`seeded ${REL} (${String(await files.read(REL)).length} chars)`);

phase("Edit one line, and attempt the two edits that must fail");

const editor = agent("Editor", {
  system:
    "You change part of one existing file. You use edit_file for every change — never write_file, which would " +
    "rewrite the lines you did not mean to touch. Report each tool result verbatim, including error text.",
  contract: {
    files: [REL],
    acceptance: [
      "the unique edit is applied with edit_file and its return value reported verbatim",
      "an old_string that appears twice is attempted and the error reported verbatim",
      "an old_string that appears nowhere is attempted and the error reported verbatim",
      "no whole-file write happens: every change goes through edit_file",
    ],
    provides: "the three tool results as text",
  },
});

const r = await editor.ask<EditReport>(
  `The file ${REL} holds exactly:\n` +
    `line one keeps the word token\nline two keeps the word token\nline three is unique\n\n` +
    `Make these three calls with edit_file, in order, and report each result verbatim:\n` +
    `1. Replace "line three is unique" with "line three is edited" — this must apply.\n` +
    `2. Replace "keeps the word token" with "keeps the word token twice" — this must fail: it appears twice.\n` +
    `3. Replace "nowhere in this file" with "anything" — this must fail: it is absent.\n\n` +
    `Return uniqueEdit (call 1's result), ambiguous (call 2's error text), missing (call 3's error text).`
);

phase("Read the file back — the untouched lines are the assertion");

const after = await files.read(REL);
const lines = String(after ?? "").split("\n");
const problems: string[] = [];
if (!String(after).includes("line three is edited")) problems.push("the unique edit did not apply");
if (String(after).includes("line three is unique")) problems.push("the edited line still reads as before");
if (lines[0] !== "line one keeps the word token" || lines[1] !== "line two keeps the word token") {
  problems.push(`the untouched lines drifted: ${JSON.stringify(lines.slice(0, 3))}`);
}
if (String(after).includes("token twice")) problems.push("the ambiguous edit applied when it must have failed");
if (!/edited .*target\.txt/.test(String(r.uniqueEdit ?? ""))) problems.push(`uniqueEdit not the tool's return: ${r.uniqueEdit}`);
if (!/2 times/.test(String(r.ambiguous ?? ""))) problems.push(`ambiguous does not name the count: ${r.ambiguous}`);
if (!/not found/.test(String(r.missing ?? ""))) problems.push(`missing does not say it was absent: ${r.missing}`);

return {
  conclusion: problems.length ? `${problems.length} problem(s)` : "edit_file applied the unique edit and refused both others",
  findings: problems,
  report: { ...r, fileAfter: String(after).trimEnd() },
};
