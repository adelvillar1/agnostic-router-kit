/* workflow
description: "Probe: all-settled competitions — one champion's failure no longer discards its siblings, and a comparison of fewer than two entries is not crowned by default."
whenToUse: Probe only — never a real task. Runs one competition in which a
  champion fails deliberately and the survivors are judged head to head, then the
  same settlement at one survivor — which is delivered as still standing rather
  than crowned — and at none, where there is no winner to name. The failing
  members die before they spend a model call, so each trial is about the
  settlement rather than a champion's luck; the survivors and the judge are real
  asks. Run as `kit workflows run competition-probe`; no grant is needed, because
  every member is an ask and the failing ones die before they would have touched
  the workspace.
args: {}
*/
/**
 * competition-probe: a parallel set is a failure domain, and the plane settles
 * it — every member runs to the end whatever happens to the others, and the
 * caller learns which came back, which failed and why, and whether what survived
 * is enough for the next step. What the probe asserts is what it can see at
 * runtime: that a champion's failure leaves its siblings judged rather than
 * discarded, that a lone survivor is honest about having had nothing to beat,
 * and that a set in which nothing survived is reported as exactly that. The
 * run's own record carries each member's outcome the way the competition this
 * probes does — the `status` lines for what settled and the findings for what
 * failed.
 */

const problems: string[] = [];
const findings: string[] = [];

/** The head-to-head judgments this probe actually asked a judge to make. */
const judgments: string[] = [];

/** One sentence from one champion — short enough that a competition is cheap. */
const championBrief = (way: string) =>
  `You are one champion in a competition of ways to ${way}. ` +
  `In one sentence, name the single strongest reason your way works.`;

/**
 * One champion's entry. The ask is the member's `run`, so the champion is one
 * member of the set: its failure is recorded by the settlement, not thrown past
 * it, and the champion that outlives a sibling is judged the same way it would
 * have been had the sibling sailed through.
 */
const championEntry = (name: string, way: string) => {
  const a = agent(`Champion for ${name}`, {
    system:
      "You are one champion in a solution competition. You never see the other entries. " +
      "Answer in one sentence. If a check is impossible to pass, escalate and say so plainly rather than working around it.",
  });
  return a.ask(championBrief(way));
};

// ── the plane's own number ───────────────────────────────────────────────────
// Two entries can be judged against each other; one entry has nothing to be
// judged against, and crowning it by default is a different claim from having
// won. The minimum is the plane's, and this probe asserts it rather than
// assuming it.
if (Number(COMPETITION_MINIMUM) !== 2) {
  problems.push(`the plane's competition minimum is ${String(COMPETITION_MINIMUM)}, not the two a comparison needs`);
}

// ── trial 1: a champion fails, and its siblings are still judged ─────────────
// Three members, one of which fails before it has spent a model call. The
// survivors each answer one short ask, and the head-to-head is a real ask over
// what they wrote — the comparison the competition exists for still happens.
const settled = await settleMembers([
  { name: "Wedge", run: () => championEntry("Wedge", "wedge a door open with a folded note") },
  {
    name: "Doomed",
    run: () => Promise.reject(new Error("this champion died on purpose, before it spent a model call")),
  },
  { name: "Hook", run: () => championEntry("Hook", "hold a door open with a hook over the frame") },
]);

if (settled.failures.length !== 1 || settled.failures[0].name !== "Doomed") {
  problems.push(`trial 1: the failed champion is not the one recorded failure: ${JSON.stringify(settled.failures)}`);
} else if (!settled.failures[0].reason.includes("on purpose")) {
  problems.push(`trial 1: the failure was recorded without its reason: ${settled.failures[0].reason}`);
}
if (settled.survivors.length !== 2) {
  problems.push(`trial 1: ${settled.survivors.length} champion(s) survived, not the two that ran`);
}
if (settled.survivors.some((s) => s.name === "Doomed")) {
  problems.push("trial 1: the champion that failed appears among the survivors");
}
if (settled.enough !== true) {
  problems.push("trial 1: two survivors did not satisfy the plane's competition minimum");
}
for (const f of settled.failures) {
  world.remember({ kind: "status", part: `champion:${f.name}`, fact: `failed and settled out: ${f.reason}` });
}

if (settled.enough) {
  const judge = agent("Head-to-head judge", {
    system:
      "You judge a competition head to head: pick the winner and give one reason, from the entries as written. " +
      "If a check is impossible to pass, escalate and say so plainly rather than working around it.",
    shape: "verify",
  });
  judgments.push("head-to-head");
  const verdict = String(
    await judge.ask(
      `Two entries were made about holding a door open:\n` +
        `1) Wedge: ${String(settled.survivors[0]?.value ?? "")}\n` +
        `2) Hook: ${String(settled.survivors[1]?.value ?? "")}\n\n` +
        "Name the winner (Wedge or Hook) and give one reason."
    )
  );
  if (!verdict.includes("Wedge") && !verdict.includes("Hook")) {
    problems.push(`trial 1: the judge's verdict names neither surviving entry: ${verdict}`);
  }
  findings.push(`trial 1: the failed champion was settled out and the two survivors were judged — ${verdict.slice(0, 100)}`);
  world.remember({ kind: "decision", fact: `the head-to-head judge picked: ${verdict.slice(0, 120)}` });
}

// ── trial 2: one survivor is still standing, not crowned ─────────────────────
// The same settlement, one survivor. There is no second entry, so no head-to-head
// ask is made at all — and the entry is delivered saying so, which is a different
// claim from having won.
const lone = await settleMembers([
  { name: "Latch", run: () => championEntry("Latch", "hold a door open with a spring latch") },
  {
    name: "Also doomed",
    run: () => Promise.reject(new Error("died on purpose, after the first entry had already finished")),
  },
]);

if (lone.enough !== false) {
  problems.push("trial 2: a single survivor satisfied the plane's competition minimum");
}
if (lone.survivors.length !== 1) {
  problems.push(`trial 2: ${lone.survivors.length} champion(s) survived, not one`);
}
if (judgments.length !== 1) {
  problems.push(`trial 2: ${judgments.length} head-to-head judgment(s) have been asked for — a one-survivor set is not a comparison`);
}
if (Number(COMPETITION_MINIMUM) > 1 && lone.enough) {
  problems.push("trial 2: the set reported enough survivors to compare when there is only one");
}
if (lone.failures.length !== 1) {
  problems.push(`trial 2: ${lone.failures.length} recorded failure(s), not one`);
}

const stillStanding = {
  winner: String(lone.survivors[0]?.name ?? ""),
  why:
    `this entry was the only champion that survived; ${lone.failures.length} failed and it was not compared against any ` +
    `other, so "winning" here means "still standing"`,
};
if (!stillStanding.why.includes("still standing")) {
  problems.push("trial 2: the degraded judgment does not say it is a survivor rather than a winner");
}
findings.push(`trial 2: one survivor and no head-to-head ask — delivered as still standing: ${stillStanding.winner}`);

// ── trial 3: nothing survived, and there is no winner to name ────────────────
// The floor. Every member fails: the set reports nothing and nothing here
// pretends otherwise. A competition with no survivors has no winner, and the run
// says that plainly instead of crowning an empty entry.
const empty = await settleMembers([
  { name: "First", run: () => Promise.reject(new Error("died on purpose")) },
  { name: "Second", run: () => Promise.reject(new Error("died on purpose as well")) },
]);

if (empty.enough !== false) {
  problems.push("trial 3: a set in which nothing survived satisfied the plane's minimum");
}
if (empty.survivors.length !== 0) {
  problems.push(`trial 3: ${empty.survivors.length} survivor(s) from a set in which every member threw`);
}
if (empty.failures.length !== 2) {
  problems.push(`trial 3: ${empty.failures.length} recorded failure(s), not two`);
}
if (empty.failures.some((f) => !f.reason)) {
  problems.push("trial 3: a failure came back without its reason");
}
findings.push(`trial 3: no survivors and ${empty.failures.length} recorded failures — there is no winner to name`);

// ── trial 4: a member that is not even a runner ──────────────────────────────
// The plane's own guard, on both floors: a member with no run(), and a member
// whose run throws before it can return a promise. Each is that member's
// failure, recorded like any other, rather than an exception that ends the set —
// which is the whole point of settling rather than awaiting.
const malformed = await settleMembers([{ name: "No runner" }], { minimum: 1 });
if (malformed.survivors.length !== 0 || malformed.failures.length !== 1) {
  problems.push(`trial 4: a member with no run() was neither a survivor nor a recorded failure`);
} else if (!malformed.failures[0].reason.includes("no run")) {
  problems.push(`trial 4: the malformed member's reason does not say what was wrong: ${malformed.failures[0].reason}`);
}

const threwEarly = await settleMembers(
  [
    {
      name: "Throws before returning",
      run: () => {
        throw new Error("this member threw before it could return a promise");
      },
    },
    { name: "Survivor of that", run: () => Promise.resolve("still here") },
  ],
  { minimum: 1 }
);
if (threwEarly.failures.length !== 1 || !threwEarly.failures[0].reason.includes("before it could return")) {
  problems.push(`trial 4: a synchronously throwing run() was not recorded as that member's failure: ${JSON.stringify(threwEarly.failures)}`);
}
if (threwEarly.survivors.length !== 1 || !threwEarly.enough) {
  problems.push(`trial 4: a synchronously throwing member took its sibling down with it: ${JSON.stringify(threwEarly.survivors)}`);
}
findings.push("trial 4: a member with no run(), and one that threw before returning a promise, were both recorded as their own failure");

// ── verdict ──────────────────────────────────────────────────────────────────
const conclusion = problems.length
  ? `competition probe: ${problems.length} problem(s) — ${problems.join("; ")}`
  : `competition probe: the settlement held — a champion that failed was settled out and its two siblings were judged head ` +
    `to head, a lone survivor was delivered as still standing with no comparison asked of it, and a set with nothing ` +
    `surviving reported no winner; a member that could not even run was recorded as its own failure`;

if (problems.length) for (const p of problems) console.log(`  \u2717 ${p}`);
if (findings.length) for (const f of findings) console.log(`  \u2219 ${f}`);
console.log(`  ${problems.length ? "competition probe FAILED" : "competition probe passed"} — ${judgments.length} head-to-head judgment(s) were asked for`);

return {
  conclusion,
  findings,
  report: {
    problems,
    trial1Survivors: settled.survivors.map((s) => s.name),
    trial1Failures: settled.failures.map((f) => ({ name: f.name, reason: f.reason })),
    trial1Enough: settled.enough,
    trial2StillStanding: stillStanding.winner,
    trial2Compared: judgments.length > 1,
    trial3Survivors: empty.survivors.length,
    trial4MalformedRecorded: malformed.failures.length === 1,
    trial4SyncThrowRecorded: threwEarly.failures.length === 1,
  },
};
