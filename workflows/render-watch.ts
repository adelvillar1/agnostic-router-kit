/* workflow
description: "The visual drift pre-filter, in shadow: a rendered wave's PNGs
  are embedded into a named corpus (dev-decisions' st-worker image leg —
  deterministic re-encode, so an unchanged render re-embeds at exactly 1.0000
  cosine), and each render is compared against the last-accepted baseline. A
  1.0000 match is logged as would-skip — the visual-judge dispatch a future
  wave could skip — and everything else is logged as dispatch-needed. SHADOW
  LAW: this loop skips nothing and dispatches nothing; it counts, and its
  counts are the promotion evidence. The one flip it owns is the baseline:
  with promote (or the owner's escalation answer) the wave's renders become
  the next baseline. Fails open by name."
whenToUse: After a visual deliverable wave, when the question is how much
  judge spend an unchanged re-render would have cost. Run with `--grant
  semantic`. The loop never touches the visual judge — it reads geometry and
  counts.
args:
  dir:
    type: string
    description: Directory of this wave's rendered images (PNG/JPEG; indexed as the current corpus).
    required: true
  baselineCorpus:
    type: string
    description: The corpus holding the last-accepted renders (default "renders-baseline").
    required: false
  currentCorpus:
    type: string
    description: Where this wave's renders are indexed (default "renders-current").
    required: false
  promote:
    type: boolean
    description: Index this wave into the baseline corpus after comparison (default false — the escalation can grant it instead).
    required: false
*/
/**
 * render-watch: the watchdog law ("no-change runs spend nothing") extended to
 * pixels — in shadow. The comparison is deterministic on the embedding side
 * (the re-encode is proven 1.0000-stable), so a 1.0000 match means
 * "provably the same pixels", which is a hash-like property, not a similarity
 * judgment; everything below 1.0 is a lead. Skipping visual-judge dispatches
 * is a LATER wave's decision, earned by this loop's shadow counts — the code
 * here contains no skip and no dispatch, only counts, and the probe holds
 * that line (grep + execution).
 */

const dir = String(args.dir ?? "").trim();
if (!dir) throw new Error("render-watch needs args.dir — the wave's renders directory");
const baselineCorpus = String(args.baselineCorpus ?? "renders-baseline").trim() || "renders-baseline";
const currentCorpus = String(args.currentCorpus ?? "renders-current").trim() || "renders-current";
const promote = args.promote === true || args.promote === "true";
const FAIL_OPEN = "render watch unavailable, nothing skipped (shadow: nothing ever is)";

// Bounded lister — the quota loop's stat pattern: fixed argv `node -e`, no
// shell, one JSON line. Images only; the CLI's indexer routes by extension
// and skips the rest, and this listing mirrors that so counts agree.
const LIST = [
  'const fs=require("fs"),path=require("path");',
  'const root=process.argv[process.argv.length-1];',
  'const exts=new Set([".png",".jpg",".jpeg",".gif",".webp",".bmp"]);',
  'try{const out=[];',
  '(function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){',
  'const p=path.join(d,e.name);',
  'if(e.isDirectory())walk(p);',
  'else if(exts.has(path.extname(e.name).toLowerCase()))out.push(p);}})(root);',
  'out.sort();',
  'process.stdout.write(JSON.stringify({ok:true,files:out.map(f=>({path:f,bytes:fs.statSync(f).size}))}))}',
  'catch(e){process.stdout.write(JSON.stringify({ok:false,reason:String(e.code||e.message)}))}',
].join("");

const verdictOf = (score) =>
  score === 1 ? "would-skip (identical pixels)" : score >= 0.98 ? "near-match (lead — dispatch-needed)" : "dispatch-needed";

phase("Index the wave's renders");

const listing = await world.run("node", ["-e", LIST, dir]);
let files = [];
try {
  const parsed = JSON.parse(String(listing?.stdout ?? ""));
  if (parsed.ok) files = parsed.files;
  else throw new Error(parsed.reason);
} catch (e) {
  log(`${FAIL_OPEN} — the renders directory could not be listed (${String(e?.message ?? e)}).`);
  return {
    conclusion: `${FAIL_OPEN}`,
    failOpen: true,
    reason: String(e?.message ?? e),
    compared: [],
    wouldSkip: 0,
    dispatchNeeded: 0,
    verified: ["an unreadable directory ends the loop before any embedding is spent"],
    notCovered: ["the comparison — there are no renders to compare"],
  };
}
if (!files.length) {
  log(`${FAIL_OPEN} — no images under ${dir}.`);
  return {
    conclusion: `${FAIL_OPEN} — no images found.`,
    failOpen: true,
    compared: [],
    wouldSkip: 0,
    dispatchNeeded: 0,
    verified: ["an empty wave ends the loop rather than comparing from nothing"],
    notCovered: ["the comparison — the directory holds no images"],
  };
}

const idx = await world.semantic("semantic-index", { corpus: currentCorpus, inputs: dir });
if (!idx.ok) {
  log(`${FAIL_OPEN} — semantic-index refused: ${idx.reason}`);
  return {
    conclusion: `${FAIL_OPEN} — ${idx.reason}`,
    failOpen: true,
    refused: idx.reason,
    compared: [],
    wouldSkip: 0,
    dispatchNeeded: 0,
    verified: ["the refusal is reported verbatim; nothing was compared and nothing skipped"],
    notCovered: ["the comparison — the indexer refused"],
  };
}
const indexSummary = idx.rows.find((r) => r && r.op === "semantic-index") ?? {};
log(`indexed ${indexSummary.indexed ?? files.length} render(s) into corpus '${currentCorpus}'`);

phase("Compare each render against the last-accepted baseline");

const compared: { path: string; bytes: number; score: number | null; verdict: string }[] = [];
let baselineAbsent = false;
for (const f of files) {
  const nn = await world.semantic("semantic-nn", { corpus: baselineCorpus, file: f.path, k: "1" });
  if (!nn.ok) {
    if (!baselineAbsent) {
      baselineAbsent = true;
      log(`baseline corpus '${baselineCorpus}' unavailable (${nn.reason}) — every render counts as dispatch-needed`);
    }
    compared.push({ path: f.path, bytes: f.bytes, score: null, verdict: "dispatch-needed (no baseline)" });
    report({ path: f.path, verdict: "dispatch-needed", baselineAbsent: true });
    continue;
  }
  const hits = nn.rows.filter((r) => r && r.key && r.score !== undefined);
  const score = hits.length ? Number(hits[0].score) : null;
  const v = score === null ? "dispatch-needed (baseline empty)" : verdictOf(score);
  compared.push({ path: f.path, bytes: f.bytes, score, verdict: v });
  report({ path: f.path, score, verdict: v });
}

const wouldSkip = compared.filter((c) => c.verdict.startsWith("would-skip")).length;
const dispatchNeeded = compared.length - wouldSkip;

phase("Shadow report; the owner holds the baseline");

log(
  `SHADOW RESULT: ${compared.length} render(s) — ${wouldSkip} would-skip, ${dispatchNeeded} dispatch-needed. ` +
    `Nothing was skipped and no judge was touched; these counts are the promotion evidence.`,
);
for (const c of compared) report({ shadow: true, applied: false, path: c.path, score: c.score, verdict: c.verdict });

let promoted = false;
const grantPromote =
  !promote &&
  wouldSkip > 0 &&
  (await escalate(
    `${wouldSkip} of ${compared.length} render(s) match the accepted baseline at identical pixels — promote this wave to baseline?`,
    JSON.stringify({ baselineCorpus, currentCorpus, wouldSkip, dispatchNeeded }),
    "render-baseline-promotion",
  ));
if (promote || String(grantPromote ?? "").trim().toLowerCase() === "yes" || String(grantPromote ?? "").trim().toLowerCase() === "promote") {
  const prom = await world.semantic("semantic-index", { corpus: baselineCorpus, inputs: dir });
  promoted = !!prom.ok;
  log(promoted ? `baseline promoted: ${dir} is now corpus '${baselineCorpus}'` : `baseline promotion refused: ${prom.reason}`);
} else {
  log(`baseline unchanged — rerun with promote:true (or answer the escalation) once the wave is accepted`);
}

const md = [
  `# Render watch (shadow) — ${dir}`,
  "",
  `Renders: ${compared.length} — would-skip ${wouldSkip}, dispatch-needed ${dispatchNeeded}` +
    (baselineAbsent ? " (no baseline corpus — everything counts as needed)" : "") + ".",
  "",
  `**Shadow law:** nothing was skipped and no visual judge was touched. A 1.0000 match means provably identical pixels ` +
    `(deterministic re-encode) — the skip a future wave could take; anything below is a lead, dispatched. ` +
    `These counts are the promotion evidence.`,
  "",
  `Baseline: ${promoted ? `promoted from this wave (\`${baselineCorpus}\`)` : `unchanged (\`${baselineCorpus}\`)`}.`,
  "",
  "| render | bytes | best baseline score | verdict |",
  "|---|---|---|---|",
  ...compared.map((c) => `| ${c.path} | ${c.bytes} | ${c.score === null ? "—" : c.score.toFixed(4)} | ${c.verdict} |`),
].join("\n");
await artifact.markdown("render-watch", md, { title: "Render watch (shadow)", primary: true });

return {
  conclusion:
    `render-watch (shadow): ${compared.length} render(s) — ${wouldSkip} would-skip, ${dispatchNeeded} dispatch-needed; ` +
    `nothing skipped, baseline ${promoted ? "promoted" : "unchanged"}.`,
  shadow: true,
  compared,
  wouldSkip,
  dispatchNeeded,
  promoted,
  verified: [
    "the wave was indexed idempotently before any comparison; its size is reported",
    "every render's best baseline score is reported; 1.0000 counts as would-skip, everything else as dispatch-needed",
    "SHADOW: no skip path exists in this loop and no judge was touched — the counts are the deliverable",
  ],
  notCovered: [
    "skipping visual-judge dispatches — a later wave's decision, earned by these counts",
    "renders whose baseline match is near-but-not-1.0 — they are leads, and they count as dispatch-needed",
  ],
};
