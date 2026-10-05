/* workflow
description: "Probe: background commands — start, poll from an offset, stop, and the lifetime cap."
whenToUse: Probe only — never a real task. The plane starts a slow command and
  reads its output in pieces, starts a long one and stops it, and starts one
  with a one-second lifetime to let the cap kill it. Run with
  `--grant workspace-io,process`; `--args '{"mode":"ungranted"}'` proves the
  capability gate on the same three tools.
args:
  mode:
    type: string
    description: "granted (default) — the process capability is on; ungranted — it is not."
    required: false
*/
/**
 * commands-probe: a tool round must not be held hostage by a slow command.
 *
 * `run_command` is synchronous because most commands are, and its five-minute
 * kill is the right default for those. A ten-minute test suite is the case that
 * shape cannot serve: the round dies while the work is still running. The
 * background surface hands back a handle immediately, reads output from an
 * offset so a poll is a stream rather than a re-read, and caps a lifetime so a
 * command nobody stops still dies.
 *
 * The offset is the part worth proving. A poll that restarted at zero each time
 * would return the same output forever and burn the agent's context doing it;
 * a poll that truncated without moving the offset would lose bytes silently.
 * Both are asserted here against the exact sequence of ticks on disk.
 */

const MODE = String(args.mode ?? "granted") === "ungranted" ? "ungranted" : "granted";

/** A blocking sleep with no timer backlog, so the ticks keep their spacing. */
const sleep = (ms) => `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms})`;

/** Twenty ticks, 300ms apart — about six seconds end to end. */
const TICKS = `for (let i = 1; i <= 20; i++) { console.log('tick ' + i); ${sleep(300)} }`;
/** A minute of nothing, for the commands that must be stopped rather than finish. */
const LONG = `const t = Date.now(); while (Date.now() - t < 60000) { ${sleep(200)} }`;

interface PollResult {
  handle: string;
  running: boolean;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  offset: number;
  truncated?: boolean;
}

if (MODE === "ungranted") {
  phase("Attempt the background surface without the capability");

  // `process` and `test-runner` are on by default, so the capability that can
  // gate this surface is the opt-in one a background command inherits from its
  // classification: `npm install` (bare) is a restore, so the install policy
  // lets it through and the capability is what refuses.
  const problems: string[] = [];
  const refusals: Record<string, string> = {};
  const seeded = await world.run("node", [
    "-e",
    `require('fs').writeFileSync('package.json', JSON.stringify({name:'commands-probe',version:'1.0.0',dependencies:{}}), 'utf8')`,
  ]);
  if (seeded.exitCode !== 0) throw new Error(`seed failed: ${seeded.stderr || seeded.stdout}`);
  try {
    await world.command.start({ command: "npm", args: ["install"] });
    problems.push("start accepted a dependency-installing command without the package capability");
  } catch (e) {
    refusals.start = String(e?.message ?? e);
    if (!/package/.test(refusals.start) || !/not granted/.test(refusals.start)) {
      problems.push(`start refused without naming the capability: ${refusals.start}`);
    }
  }
  // A handle the run never started is not a capability question, and a poll that
  // answered one would be inventing knowledge it does not have.
  for (const [name, call] of [
    ["poll", () => world.command.poll("no-such-handle", 0)],
    ["stop", () => world.command.stop("no-such-handle")],
  ] as [string, () => Promise<unknown>][]) {
    try {
      await call();
      problems.push(`${name} accepted a handle this run never started`);
    } catch (e) {
      refusals[name] = String(e?.message ?? e);
      if (!/no such handle/.test(refusals[name])) {
        problems.push(`${name} misreported an unknown handle: ${refusals[name]}`);
      }
    }
  }

  return {
    conclusion: problems.length
      ? `ungranted: ${problems.length} problem(s)`
      : "the ungranted run refused the install and named the capability, and named the unknown handle",
    findings: problems,
    report: { mode: MODE, refusals },
  };
}

const problems: string[] = [];

phase("Start a slow command and read its output in pieces");

const started = await world.command.start({ command: "node", args: ["-e", TICKS], readyText: "tick 1" });
report(`started ${started.handle} (pid ${started.pid}), running=${started.running}, ready=${started.ready}`);
if (!started.handle) problems.push("start returned no handle");
if (started.running !== true) problems.push(`a just-started command reports running=${started.running}`);
if (started.ready !== true) problems.push(`the readiness marker was not seen: ready=${started.ready}`);

// Read it to the end through the offsets, keeping every delta and the order
// they arrived in. The offsets are the assertion: each poll must continue where
// the last stopped, never re-send and never skip.
const deltas: string[] = [];
const seenOffsets: number[] = [];
let offset = 0;
let last: PollResult | null = null;
for (let i = 0; i < 200 && !(last && !last.running); i++) {
  last = await world.command.poll(started.handle, offset);
  if (last.handle !== started.handle) problems.push(`poll returned a different handle: ${last.handle}`);
  offset = last.offset;
  seenOffsets.push(offset);
  if (last.stdout) deltas.push(last.stdout);
  if (last.truncated) problems.push("a six-second command's output hit the poll cap");
  if (last.running) await new Promise((r) => setTimeout(r, 100));
}

if (!last) problems.push("no poll ever ran");
else {
  if (last.running) problems.push("the command never finished under polling");
  if (last.exitCode !== 0) problems.push(`the finished command exited ${last.exitCode} (signal ${last.signal})`);
}

const ticks = deltas.join("").split("\n").filter((l) => l.length > 0);
const expected = Array.from({ length: 20 }, (_, i) => `tick ${i + 1}`);
if (ticks.join("|") !== expected.join("|")) {
  problems.push(`the deltas do not read as ticks 1..20 in order: ${JSON.stringify(ticks.slice(0, 6))}…`);
}
// A monotonic offset is what makes this a stream. Steady is fine — an empty
// poll reads no new bytes and returns the same offset — but an offset that
// went backwards would re-send output the reader already has, and a jump past
// unread output would lose it. Both are asserted against the bytes on disk.
if (seenOffsets.some((o, i) => i > 0 && o < seenOffsets[i - 1])) {
  problems.push(`offsets went backwards: ${seenOffsets.slice(0, 10).join(", ")}`);
}
const bytesRead = deltas.join("").length;
if (offset !== bytesRead) {
  problems.push(`the last offset (${offset}) does not match the bytes read (${bytesRead}) — output was skipped or re-sent`);
}
report(`read the command to its end in ${deltas.length} polls; ${ticks.length} ticks, offsets ${seenOffsets[0]}…${seenOffsets[seenOffsets.length - 1]}`);

phase("Stop a long command before it finishes");

const longStarted = await world.command.start({ command: "node", args: ["-e", LONG] });
const longPoll = await world.command.poll(longStarted.handle, 0);
if (!longPoll.running) problems.push("the long command was not running when polled");
const stopped = await world.command.stop(longStarted.handle);
if (stopped.ok !== true) problems.push(`stop returned ${JSON.stringify(stopped)}`);
// Stop is a request; the exit code is the next poll's to report, because a
// SIGTERM'd child has a null exit code and the signal is the reason.
await new Promise((r) => setTimeout(r, 300));
const afterStop = await world.command.poll(longStarted.handle, 0);
if (afterStop.running) problems.push("the command was still running after a stop");
if (afterStop.exitCode !== null) problems.push(`a killed command exited ${afterStop.exitCode}, expected null`);
if (afterStop.signal !== "SIGTERM") problems.push(`a killed command reports signal ${afterStop.signal}`);
report(`stopped ${longStarted.handle}; poll reports running=false, signal=${afterStop.signal}`);

// Stopping twice is the outcome, not an error: the second stop says so.
const again = await world.command.stop(longStarted.handle);
if (again.ok !== true || again.alreadyStopped !== true) {
  problems.push(`the second stop did not report alreadyStopped: ${JSON.stringify(again)}`);
}

phase("The lifetime cap stops a command nobody stops");

const capped = await world.command.start({ command: "node", args: ["-e", LONG], lifetimeSeconds: 1 });
await new Promise((r) => setTimeout(r, 2000));
const cappedPoll = await world.command.poll(capped.handle, 0);
if (cappedPoll.running) problems.push("the lifetime cap did not stop the command");
if (cappedPoll.signal !== "SIGTERM") problems.push(`the lifetime cap left signal ${cappedPoll.signal}, expected SIGTERM`);
report(`the one-second lifetime cap stopped ${capped.handle} with signal ${cappedPoll.signal}`);

phase("Refusals a handle surface must have");

const notAllowed = await world.command
  .start({ command: "curl", args: ["-s", "http://127.0.0.1:1/"] })
  .then(() => null)
  .catch((e) => String(e?.message ?? e));
if (!notAllowed || !/not allowed in this run/.test(notAllowed)) {
  problems.push(`a non-allowlisted exe was not refused: ${notAllowed}`);
}

const badOffset = await world.command
  .poll(started.handle, -5)
  .then(() => null)
  .catch((e) => String(e?.message ?? e));
if (!badOffset || !/offset/.test(badOffset)) {
  problems.push(`a negative offset was not refused: ${badOffset}`);
}

const unknown = await world.command
  .poll("no-such-handle", 0)
  .then(() => null)
  .catch((e) => String(e?.message ?? e));
if (!unknown || !/no such handle/.test(unknown)) {
  problems.push(`an unknown handle was not refused: ${unknown}`);
}
report(`refused: curl (not an allowed exe), offset -5, and a handle this run never started`);

return {
  conclusion: problems.length ? `${problems.length} problem(s)` : "the background surface streamed, stopped, capped, and refused",
  findings: problems,
  report: {
    mode: MODE,
    polls: deltas.length,
    ticks: ticks.length,
    firstOffset: seenOffsets[0],
    lastOffset: seenOffsets[seenOffsets.length - 1],
    stopSignal: afterStop.signal,
    capSignal: cappedPoll.signal,
    refusals: { notAllowed, badOffset, unknown },
  },
};
