/* workflow
description: "Probe: context services — a part's result is checked against the contract it was dispatched with, in code, before its champion is told it was built."
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

const unexpected = trials.filter((t) => t.verdict === "UNEXPECTED");

return {
  conclusion: `context probe: ${trials.length - unexpected.length}/${trials.length} results checked exactly as the plane claims`,
  findings: [],
  verified: [
    ...trials.map((t) => `${t.verdict === "AS-EXPECTED" ? "ok" : "UNEXPECTED"}: ${t.label} — ${t.note}`),
    "the check needs no agent call: it is deterministic code over the result and the contract",
  ],
  notCovered: [
    "the re-ask path in adversarial-solve's buildPart — that takes a live builder, so it shows in a real adversarial-solve run",
    "a part whose files exist but whose provides disagrees with the declared interface — a semantic comparison the plane leaves to the champion",
  ],
};
