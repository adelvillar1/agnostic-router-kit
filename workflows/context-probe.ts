/* workflow
description: "Probe: context services — a part's result is checked against the contract it was dispatched with, in code, before its champion is told it was built; and the run's fact store is read back scoped, capped, and journaled."
whenToUse: Probe only — never a real task. Exercises the plane's result-shaping check in
  both directions: a sound result passes, and every defect class the check exists to
  catch is named. Each trial states what should happen, so a check that stopped
  biting shows up as CLEAN where DEFECTIVE was expected.
args:
  task:
    type: string
    description: Unused; kept so --args matches the library shape.
    required: false
*/

interface Part {
  title: string;
  instruction: string;
  files: string[];
  acceptance: string[];
  provides: string;
}

interface PartResult {
  built: string;
  location: string;
  provides: string;
}

const trial = (label: string, expected: "clean" | "defective", fn: () => string) => {
  let note = "";
  let clean = true;
  try {
    const problems = fn();
    clean = problems.length === 0;
    note = clean ? "no problems" : `${problems.length}: ${problems[0]}`.slice(0, 190);
  } catch (e: unknown) {
    clean = false;
    note = String((e as Error)?.message ?? e).slice(0, 190);
  }
  const expectedClean = expected === "clean";
  const verdict = clean === expectedClean ? "AS-EXPECTED" : "UNEXPECTED";
  log(`result trial ${clean ? "CLEAN" : "DEFECTIVE"} (expected ${expected}) ${verdict} · ${label} · ${note}`);
  return { label, expected, clean, verdict, note };
};

const trials = [];

// The namespace a builder writes under, and the disk the declared paths land
// on. Both are injected exactly as the plane's own API takes them: the caller
// owns the effects, the plane owns the checks.
const ns = "out/adversarial/champ-1/";
const onDisk = new Set(["a.js", "answer.md"]);

const sound = {
  built: "Retry wrapper around fetch with exponential backoff and a jittered cap",
  location: "a.js",
  provides: "a.js: exports retry(fn, opts) — opts.capMs, opts.baseMs",
};
const part: Part = {
  title: "retry wrapper",
  instruction: "Build the retry wrapper in a.js",
  files: ["a.js"],
  acceptance: ["retries up to the cap"],
  provides: "a.js: exports retry(fn, opts)",
};

const check = (result: unknown, p: Part = part, opts: Record<string, unknown> = {}) =>
  validatePartResult(result, p, {
    namespace: ns,
    exists: (rel: string) => onDisk.has(rel),
    ...opts,
  });

// 1. A sound result passes: every field present, `built` a description, the
// owned path on disk, and nothing claimed outside the contract.
trials.push(trial("a sound result passes", "clean", () => check(sound)));
trials.push(
  trial("an owned path reported under its namespace", "clean", () => check({ ...sound, location: `${ns}a.js` }))
);
trials.push(
  trial(
    "an answer-shaped part with no files",
    "clean",
    () =>
      check(
        { built: "The approach's failure mode is the retry storm, not the timeout", location: "answer", provides: "answer" },
        { ...part, files: [] }
      )
  )
);

// 2. The shape failures: the ask demanded built/location/provides, and a
// confirmation is not a description.
trials.push(
  trial("a missing provides is a shape failure", "defective", () => {
    const { provides, ...rest } = sound;
    return check(rest);
  })
);
trials.push(
  trial("a one-word built is a confirmation, not a description", "defective", () => check({ ...sound, built: "ok" }))
);

// 3. The check code can make that a model cannot: every declared path on disk.
trials.push(
  trial("a declared file that is not on disk", "defective", () =>
    check(sound, { ...part, files: ["a.js", "a.test.js"] })
  )
);

// 4. A path the contract never authorized — work done elsewhere, or credit
// for another part's file.
trials.push(
  trial("a foreign path in the location", "defective", () =>
    check({ ...sound, location: "out/adversarial/other/b.js" })
  )
);
trials.push(
  trial("a foreign path in the provides prose", "defective", () =>
    check({ ...sound, provides: `${ns}a.js: exports retry; out/adversarial/other/b.js: exports b` })
  )
);

// 5. Honesty about the plane's own limits: without the namespace a reported
// namespaced path cannot be told from a foreign one, so the path check stays
// off rather than guessing — and says so in the result rather than passing
// silently.
trials.push(
  trial("no namespace supplied: the path check stays off", "clean", () =>
    check({ ...sound, location: `${ns}a.js` }, part, { namespace: "" })
  )
);

// ── the run's fact store ────────────────────────────────────────────────────
// The pull half of the context services, on the same no-agent-call terms: the
// store is code, so every claim it makes is a trial like the ones above.
// `recallAs(part)` is the exact closure the engine hands the agent scoped to
// `part` — the probe calls it as the plane that dispatched them, which is the
// only way to show the boundary holding without waiting for a model to test it.

// The public facts a run records before anything is dispatched.
world.remember({ kind: "task", fact: "counts tokens in a file" });
world.remember({ kind: "stack", fact: "JavaScript on Node 24, node:test, zero npm deps" });

// A remember that returns ok is the happy path; anything else returns the
// plane's own reason. `trial` counts problems, so a reason is one problem —
// returning prose here would make the journal note read "118: r".
const failedRemember = (kind: string, fact: string): string[] => {
  const r = world.remember({ kind, fact });
  return r.ok ? [] : [`remember accepted it: ${String((r as { reason?: string }).reason ?? r)}`];
};

trials.push(trial("an unknown fact kind is refused by name", "defective", () => failedRemember("poetry", "a limerick")));
trials.push(trial("a fact with no text is refused", "defective", () => failedRemember("task", "   ")));
trials.push(
  trial(
    "every declared kind is stored",
    "clean",
    () =>
      ["task", "stack", "environment", "decision", "verdict", "status", "phase"]
        .flatMap((k) => failedRemember(k, `a ${k} fact`))
        .join("; ")
  )
);

world.remember({ kind: "verdict", part: "ns/A", fact: "blocked: two parts claim the same file" });
world.remember({ kind: "status", part: "ns/A", fact: "built" });
world.remember({ kind: "verdict", part: "ns/B", fact: "clean" });

trials.push(
  trial("the plane reads every part's facts", "clean", () => {
    const all = world.facts();
    const problems = [];
    if (!all.ok || !all.text.includes("clean") || !all.text.includes("blocked: two parts")) problems.push(`plane saw: ${all.text}`);
    return problems;
  })
);
trials.push(
  trial("the plane narrows its own read to one part", "clean", () => {
    const a = world.facts({ part: "ns/A" });
    const problems = [];
    if (!a.ok || !a.text.includes("blocked: two parts") || a.text.includes("clean")) problems.push(`plane saw: ${a.text}`);
    return problems;
  })
);

// the agent-side boundary, which is the reason the store can be on the default
// agent surface at all
trials.push(
  trial("a scoped agent reads the public facts and its own", "clean", () => {
    const seen = world.recallAs("ns/A");
    const problems = [];
    if (!seen.includes("counts tokens") || !seen.includes("blocked: two parts")) problems.push(`agent saw: ${seen}`);
    return problems;
  })
);
trials.push(
  trial("a scope-free agent reads the public facts only", "clean", () => {
    const seen = world.recallAs(null);
    const problems = [];
    if (!seen.includes("counts tokens")) problems.push(`agent saw no public fact: ${seen}`);
    if (seen.includes("clean") || seen.includes("blocked: two parts")) problems.push(`agent saw a part's fact: ${seen}`);
    return problems;
  })
);
trials.push(
  trial("naming a sibling part is refused, by name", "defective", () => {
    world.recallAs("ns/A", { part: "ns/B" });
    return ["the recall returned instead of refusing"];
  })
);

// the caps: a reader told nothing about what it did not get will ask again
for (let i = 0; i < 60; i++) world.remember({ kind: "status", part: "ns/Z", fact: `z${i} ${"x".repeat(80)}` });
trials.push(
  trial("the fact-count cap says what it held back", "clean", () => {
    const seen = world.recallAs("ns/Z");
    return /over the 40-fact cap/.test(seen) ? [] : [`no truncation line: ${seen.slice(-200)}`];
  })
);
world.remember({ kind: "decision", fact: "y".repeat(9_000) });
trials.push(
  trial("the byte cap says what it held back", "clean", () => {
    const seen = world.recallAs(null, { kind: "decision" });
    return /over the 8192-byte cap/.test(seen) ? [] : [`no truncation line: ${seen.slice(-200)}`];
  })
);

const allUnexpected = trials.filter((t) => t.verdict === "UNEXPECTED");

return {
  conclusion: `context probe: ${allUnexpected.length ? `${trials.length - allUnexpected.length}/${trials.length}` : `${trials.length}/${trials.length}`} trials checked exactly as the plane claims`,
  findings: [],
  verified: [
    ...trials.map((t) => `${t.verdict === "AS-EXPECTED" ? "ok" : "UNEXPECTED"}: ${t.label} — ${t.note}`),
    "no trial needed a model call: result-shaping and the fact store are both deterministic code",
  ],
  notCovered: [
    "the re-ask path in adversarial-solve's buildPart — that takes a live builder, so it shows in a real adversarial-solve run",
    "a part whose files exist but whose provides disagrees with the declared interface — a semantic comparison the plane leaves to the champion",
    "a model choosing to call recall at all — the store makes the read available and bounded; whether an agent wants it is the run's business",
  ],
};
