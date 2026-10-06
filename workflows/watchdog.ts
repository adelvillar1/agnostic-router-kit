/* workflow
description: "Watches a thing between runs: reads the watched URLs and paths,
  diffs the state the spawner handed in, and judges whether what matters
  changed. The new state comes back in the result for the caller to carry into
  the next spawn — state lives with the caller, so nothing outlives the run."
whenToUse: On a schedule, through the run API or a cron: docs drift, dependency
  bumps, upstream changelogs, price or availability pages.
args:
  watch:
    type: string
    description: JSON {urls?: string[], paths?: string[]} — what to watch. URLs need the net-fetch grant and an allowlist; paths are workspace-relative.
    required: true
  matters:
    type: string
    description: What a change that matters looks like, in a sentence or two.
    required: true
  priorState:
    type: string
    description: JSON {snapshots: {key: hash}} — the state the last run returned. Omit to establish the baseline.
    required: false
*/
/**
 * watchdog: state in, state out, judgment only where it is needed.
 * The diff is deterministic (content hashes); the model is consulted only when
 * something changed, to decide whether the change matters. A no-change run is
 * cheap and journaled as such — a first run with no prior state establishes
 * the baseline and spends no model call either.
 */

interface Watch {
  urls?: string[];
  paths?: string[];
}

interface Judgment {
  /** True when the change is one the operator cares about. */
  matters: boolean;
  /** What changed and why it does or does not matter. */
  why: string;
}

const ESCALATE =
  "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.";

let watch: Watch = {};
try {
  watch = typeof args.watch === "string" ? JSON.parse(args.watch) : args.watch;
} catch (e) {
  throw new Error(`watch is not valid JSON: ${String(e?.message ?? e)}`);
}
const matters = String(args.matters ?? "").trim();
if (!matters) throw new Error("watchdog needs to be told what a change that matters looks like");
let prior: { snapshots: Record<string, string> } = { snapshots: {} };
if (args.priorState) {
  try {
    prior = typeof args.priorState === "string" ? JSON.parse(args.priorState) : args.priorState;
  } catch (e) {
    throw new Error(`priorState is not valid JSON: ${String(e?.message ?? e)}`);
  }
}

// djb2 over the content — deterministic, stable across runs, no imports.
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

phase("Read the watched things");
const current: Record<string, { hash: string; bytes: number; error?: string }> = {};
const contents: Record<string, string> = {};
for (const p of watch.paths ?? []) {
  try {
    const text = await files.read(String(p));
    contents[`path:${p}`] = text;
    current[`path:${p}`] = { hash: hash(text), bytes: text.length };
  } catch (e) {
    current[`path:${p}`] = { hash: "error", bytes: 0, error: String(e?.message ?? e).slice(0, 160) };
  }
}
for (const u of watch.urls ?? []) {
  const res = await world.fetch(String(u));
  if (res.ok) {
    contents[`url:${u}`] = res.body;
    current[`url:${u}`] = { hash: hash(res.body), bytes: res.bytes };
  } else {
    current[`url:${u}`] = { hash: "error", bytes: 0, error: res.reason };
  }
}

phase("Diff against the state the spawner handed in");
const changes: { key: string; kind: "added" | "removed" | "changed" | "error" }[] = [];
for (const key of Object.keys(current)) {
  const before = prior.snapshots?.[key];
  const now = current[key];
  if (now.error) changes.push({ key, kind: "error" });
  else if (before === undefined) changes.push({ key, kind: "added" });
  else if (before !== now.hash) changes.push({ key, kind: "changed" });
}
for (const key of Object.keys(prior.snapshots ?? {})) {
  if (!current[key]) changes.push({ key, kind: "removed" });
}
const realChanges = changes.filter((c) => c.kind !== "error");
const hadBaseline = Object.keys(prior.snapshots ?? {}).length > 0;

if (!hadBaseline) {
  // Baseline establishment: nothing to compare, no model call to spend.
  log(`baseline established for ${Object.keys(current).length} key(s) — the next run diffs against this`);
  return {
    conclusion: `watchdog baseline: ${Object.keys(current).length} key(s) snapshotted. No judgment spent.`,
    changed: false,
    matters: false,
    why: "baseline established — no prior state to diff against",
    changes: [],
    state: { snapshots: Object.fromEntries(Object.entries(current).map(([k, v]) => [k, v.hash])) },
    verified: ["the baseline state returned is the state the next run diffs against"],
    notCovered: [],
  };
}

// "added" keys are the caller growing the watch list, not the watched thing
// changing — additions re-baseline without spending a judgment.
const meaningful = realChanges.filter((c) => c.kind !== "added");
if (meaningful.length === 0) {
  log(`no change in ${Object.keys(current).length} key(s) — nothing judged, nothing spent`);
  return {
    conclusion: `watchdog: no change across ${Object.keys(current).length} key(s).`,
    changed: false,
    matters: false,
    why: "every watched hash matches the prior state",
    changes: realChanges,
    state: { snapshots: Object.fromEntries(Object.entries(current).map(([k, v]) => [k, v.hash])) },
    verified: ["a no-change run spent no model call"],
    notCovered: [],
  };
}

phase("Judge whether the change matters");
const diffs = meaningful.map((c) => {
  const key = c.key;
  const before = prior.snapshots?.[key];
  const after = current[key];
  const excerpt = (k: string, side: Record<string, string>) => String(side[k] ?? "").slice(0, 400);
  return {
    key,
    kind: c.kind,
    beforeHash: before,
    afterHash: after?.hash,
    contentNote: contents[key] ? String(contents[key]).slice(0, 1200) : after?.error ?? "",
  };
});
// The matters-judgment rides the sys1 judge layer — a flat binary head over
// the diffs and the operator's standard (dev-decisions first, sys1 fallback
// recorded). A run whose nothing-changed path is taken spends no model call;
// this is the only judgment a watchdog run makes.
const MATTERS_SPEC = {
  id: "watchdog_matters",
  description: "Does the observed change touch what the operator said matters?",
  heads: [{ id: "matters", kind: "choice", task: "Does the change touch what the operator said matters? A change outside the standard does not matter.", labels: ["matters", "irrelevant"] }],
};
const judged = await sys1.judge(
  MATTERS_SPEC,
  `What matters: ${matters}\n\nChanges:\n${JSON.stringify(diffs)}`
);
const label = judged?.ok ? judged.answers?.[judged.provider]?.matters?.label : null;
const judgment: Judgment = {
  matters: label === "matters",
  why: label
    ? `${label} — judged by ${judged.provider} (${judged.source ?? "sys1-raw"})`
    : `the judge was unreachable (${String(judged?.reason ?? "unknown").slice(0, 120)}) — treated as not-mattering; the diff is in the report`,
};

const md = [
  `# Watchdog report`,
  "",
  `Watched: ${Object.keys(current).length} key(s). Changes: ${changes.length}. Matters: ${judgment.matters ? "YES" : "no"}.`,
  `Why: ${judgment.why}`,
  "",
  ...changes.map((c) => `- **${c.kind}** ${c.key}${current[c.key]?.error ? ` — error: ${current[c.key].error}` : ""}`),
].join("\n");
await artifact.markdown("deliverable", md, { title: "Watchdog report", primary: true });

return {
  conclusion: `watchdog: ${changes.length} change(s), ${judgment.matters ? "matters" : "does not matter"} — ${judgment.why.slice(0, 200)}`,
  changed: true,
  matters: judgment.matters,
  why: judgment.why,
  changes,
  state: { snapshots: Object.fromEntries(Object.entries(current).map(([k, v]) => [k, v.hash])) },
  verified: [
    "the diff was computed from content hashes, deterministically",
    "the model was consulted only because something changed",
    "the new state returned is what the next run diffs against",
  ],
  notCovered: ["content beyond the excerpts the diff handed the judge"],
};
