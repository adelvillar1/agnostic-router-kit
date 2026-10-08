/* workflow
description: "The archify diagrams kept anchored to the code. Every source
  ref in a *.candidate.json pins a path and a line range at a revision; this
  loop audits those pins against the revision they name — byte identity over
  the whole pinned range, never label similarity — and re-pins the refs whose
  anchored bytes merely moved, finalizes the candidates it touched through
  the archify CLI (receipts moved back beside the candidate, a fresh
  refresh-<n> per round), and renders the stills. That is the mechanical
  four-fifths of the refresh procedure, executed and re-runnable. The
  judgment fifth is not in this file: what a wave's new node should say,
  whether a claim whose bytes changed is still true, and whether the still
  looks right are an agent's and a reader's. Fails open by name — no git, no
  candidates, an absent archify CLI, a refused layout each end the loop with
  the refusal verbatim and the diagrams exactly as they were authored."
whenToUse: After a code wave, before the diagrams are believed — or on a
  schedule, as the freshness row `kit doctor` already computes. Run with
  `--grant diagram,process` (process covers the stills leg only). The loop
  never authors a node, never verifies a claim's meaning, never repairs a
  rejected layout, and never looks at the PNGs.
args:
  dir:
    type: string
    description: Directory holding the *.candidate.json diagrams and render-png.mjs (default "docs/architecture").
    required: false
  revision:
    type: string
    description: Revision to audit against when a candidate pins none (default "HEAD"; a candidate's own meta.repository.revision always wins).
    required: false
  dryRun:
    type: boolean
    description: Audit and report only — no candidate is written, no finalize runs (default false).
    required: false
  scope:
    type: string
    description: Comma-separated diagram names to finalize even when the re-pin did not touch them (default: the re-pinned diagrams only).
    required: false
  stills:
    type: string
    description: The render leg — "check" (verify the stills' sizes against the HTML viewBoxes, no Chrome, writes nothing: the default), "write" (re-render; needs headless Chrome), or "skip".
    required: false
*/
/**
 * diagram-refresh: the mechanical four-fifths of the archify refresh, run as
 * a workflow.
 *
 * The identity rule is the whole engine here: a ref is intact when the bytes
 * at its pinned [line..end_line] equal the bytes at that range in the
 * revision the candidate pins. Nothing about the label is compared, because
 * fifteen of the repo's sixty-one labels are paraphrases ("run route", "judge
 * spec") that match nothing verbatim in the code they anchor — a label matcher
 * would bury real drift under its own noise. A ref whose bytes moved verbatim
 * elsewhere in the file is arithmetic to re-pin; a ref whose bytes were edited
 * is a claim that may now be false, and editing it is a judgment this loop
 * does not make — it is named, with its label and its old range, in the
 * artifact's to-do list.
 *
 * The fail-open law is moli's and dev-decisions': every not-ok branch ends
 * the loop with the refusal's own words and the standing behavior — the
 * diagrams stay as they were authored, and whoever asked hears why.
 *
 * Batch-only by construction: the loop spawns no agents and makes no model
 * calls. It is the audit/repin/finalize surface plus two process legs (the
 * candidate writer and render-png.mjs), and a report.
 */

const dir = String(args.dir ?? "docs/architecture").trim() || "docs/architecture";
const revision = String(args.revision ?? "HEAD").trim() || "HEAD";
const dryRun = args.dryRun === true || args.dryRun === "true";
const scope = String(args.scope ?? "")
  .split(",")
  .map((s: string) => s.trim())
  .filter(Boolean);
const stills = String(args.stills ?? "check").trim().toLowerCase() || "check";
const FAIL_OPEN = "diagram refresh unavailable — the diagrams stay as they were authored";

// The candidate writer: fixed argv, no shell, the file's own name and the
// repin's serialization passed as arguments. The writer's only power is to
// write one file the caller already named, so a loop that cannot write
// cannot write anything else either.
const WRITE_ONE = `const fs=require("fs");fs.writeFileSync(process.argv[1],process.argv[2]);`;

// The next refresh dir for this base: refresh-<n> with n one past the highest
// numeric suffix already there. The receipt dance needs a dir no previous
// round used, because a finalize's browser evidence is per-round; reusing one
// would mix two runs' receipts. The lister mirrors the quota loop's stat
// pattern — a fixed node -e, one JSON line.
const NEXT_REFRESH = [
  'const fs=require("fs");',
  'let out=[];',
  'try{out=fs.readdirSync(process.argv[process.argv.length-1],{withFileTypes:true})',
  '.filter(e=>/^refresh-(\\d+)$/.test(e.name))',
  '.map(e=>Number(/^refresh-(\\d+)$/.exec(e.name)[1]));}catch(e){}',
  'process.stdout.write(JSON.stringify(out));',
].join("");

const failOpen = (where: string, refused: string) => {
  // The refusal's own words, unshortened, are the report — the standing law
  // across the tabular, semantic and browsing lanes.
  log(`${FAIL_OPEN} — ${where}: ${refused}`);
  report({ failOpen: true, where, refused, dir });
  return {
    conclusion: `${FAIL_OPEN} — ${where}: ${refused}`,
    failOpen: true,
    where,
    refused,
    diagrams: [],
    verified: ["an unavailable audit ends the loop with the refusal verbatim and changes nothing"],
    notCovered: [
      "drift — the audit could not run, so nothing was measured",
      "the re-pin — no candidate was read or written",
      "the finalize — no round ran",
      "the stills — the render leg was not reached",
    ],
  };
};

phase("Audit the diagram candidates");

const audit = await world.diagram.audit({ dir, revision });
if (!audit.ok) return failOpen("the audit refused", String(audit.reason ?? ""));

const diagrams = audit.diagrams as Array<{
  diagram: string;
  type: string;
  pinnedRevision: string;
  stale: boolean;
  refs: {
    intact: number;
    moved: Array<{ path: string; from: number[]; to: number[]; label: string | null }>;
    changed: Array<{ path: string; from: number[]; label: string | null }>;
    missing: Array<{ path: string; from: number[]; label: string | null }>;
  };
}>;
const candidateOf = (d: { diagram: string }) => `${dir}/${d.diagram}.candidate.json`;
const total = (pick: (r: { intact: number }) => number) => diagrams.reduce((n, d) => n + pick(d.refs), 0);
const movedTotal = total((r) => r.moved.length);
const changedTotal = total((r) => r.changed.length);
const missingTotal = total((r) => r.missing.length);
const behindHead = diagrams.filter((d) => d.stale).map((d) => d.diagram);
const inbound = (d: { diagram: string }) => d.refs.moved.length + d.refs.changed.length + d.refs.missing.length;

log(
  `${diagrams.length} candidate(s) in ${dir}, pinned ${audit.head.slice(0, 7)} — ` +
    `${total((r) => r.intact)} intact, ${movedTotal} moved, ${changedTotal} changed, ${missingTotal} missing`,
);
for (const d of diagrams) {
  log(
    `${d.diagram} (${d.type}, pin ${d.pinnedRevision.slice(0, 7)}) — ` +
      `${d.refs.intact} intact, ${d.refs.moved.length} moved, ${d.refs.changed.length} changed, ${d.refs.missing.length} missing` +
      (d.stale ? ` — the pin is behind ${audit.head.slice(0, 7)}, the bytes are still identical` : ""),
  );
  for (const m of d.refs.moved) log(`moved ${m.path}:${m.from.join("-")} → ${m.to.join("-")} — "${m.label ?? ""}"`);
  for (const c of d.refs.changed) log(`changed ${c.path}:${c.from.join("-")} — "${c.label ?? ""}" — the claim may now be false: an agent's repair, not this loop's`);
  for (const m of d.refs.missing) log(`missing ${m.path}:${m.from.join("-")} — "${m.label ?? ""}"`);
}

const repinned: Array<{ diagram: string; type: string; changes: Array<{ path: string; from: number[]; to: number[] }> }> = [];
const unreadable: string[] = [];

// ── phase 2: the re-pin — mechanical moves only ─────────────────────────────
if (dryRun) {
  phase("Dry run — report only");
  log(`dry run: ${movedTotal} move(s) would be re-pinned and the revision repinned; no candidate is written and no round runs`);
} else if (movedTotal > 0) {
  phase("Re-pin the moved refs");
  for (const d of diagrams) {
    if (!d.refs.moved.length) continue;
    const rel = candidateOf(d);
    let text: string;
    try {
      text = String(await files.read(rel));
    } catch (e) {
      // A candidate the audit just read but the writer cannot read is a
      // workspace-boundary problem or a concurrent edit; either way the loop
      // names it and leaves the file untouched.
      unreadable.push(`${rel} (${String(e?.message ?? e).slice(0, 120)})`);
      log(`cannot read ${rel} — ${String(e?.message ?? e).slice(0, 120)}; the candidate stays as authored`);
      continue;
    }
    const repin = world.diagram.repin(text, d.refs.moved, { head: audit.head }) as {
      json: string;
      changes: Array<{ path: string; from: number[]; to: number[] }>;
    };
    const w = await world.run("node", ["-e", WRITE_ONE, rel, repin.json]);
    if (w.exitCode !== 0) {
      unreadable.push(`${rel} (the writer exited ${w.exitCode}: ${String(w.stderr ?? "").trim().slice(0, 120)})`);
      log(`cannot write ${rel} — the writer exited ${w.exitCode}: ${String(w.stderr ?? "").trim().slice(0, 160)}`);
      continue;
    }
    repinned.push({ diagram: d.diagram, type: d.type, changes: repin.changes });
    log(`${rel} — re-pinned ${repin.changes.length} move(s) onto ${audit.head.slice(0, 7)}`);
    for (const c of repin.changes) report({ diagram: d.diagram, repinned: c });
  }
  // The second application is a no-op by construction — the moved refs no
  // longer match their old ranges, and the revision is already the head — so
  // a loop that re-pins twice cannot corrupt. The probe drives the second
  // pass to count it rather than to trust it.
  if (!repinned.length) log("nothing was writable — every drifted candidate is named above as unreadable");
}

// ── phase 3: the finalize — the receipt dance, encoded ──────────────────────
const finalizeThese = repinned.map((r) => r.diagram);
for (const want of scope) {
  const d = diagrams.find((x) => x.diagram === want);
  if (!d) {
    log(`scope names ${want}, which is not a candidate in ${dir} — nothing to finalize under that name`);
    continue;
  }
  if (!finalizeThese.includes(want)) {
    finalizeThese.push(want);
    log(`${want} was named in scope: finalized without a re-pin, at its authored refs`);
  }
}
const rounds: Array<{ diagram: string; outDir: string; receipts: string[]; summary: unknown }> = [];
const refusedRounds: Array<{ diagram: string; reason: string }> = [];
if (!dryRun && finalizeThese.length) {
  phase(`Finalize ${finalizeThese.length} candidate(s)`);
  const n = await world.run("node", ["-e", NEXT_REFRESH, dir]);
  let next = 1;
  if (n.exitCode === 0) {
    try {
      const existing = JSON.parse(String(n.stdout ?? "[]")) as number[];
      next = (existing.length ? Math.max(...existing) : 0) + 1;
    } catch {
      /* an unreadable listing means no rounds yet — refresh-1 is right */
    }
  } else {
    log(`could not list ${dir} for refresh dirs (${String(n.stderr ?? "").trim().slice(0, 120)}) — starting at refresh-1`);
  }
  // One round dir per finalize: the HTML owns its browser-evidence path, so
  // each candidate gets a dir no other round used.
  let round = next;
  for (const name of finalizeThese) {
    const d = diagrams.find((x) => x.diagram === name);
    if (!d) continue;
    const rel = candidateOf(d);
    const outDir = `${dir}/refresh-${round}`;
    const run = (await world.diagram.finalize({ type: d.type, candidate: rel, outDir, repoRoot: "." })) as {
      ok: boolean;
      reason?: string;
      receipts?: string[];
      summary?: unknown;
    };
    if (!run.ok) {
      refusedRounds.push({ diagram: name, reason: String(run.reason ?? "") });
      log(`finalize refused for ${name} — ${String(run.reason ?? "")}`);
      continue;
    }
    rounds.push({ diagram: name, outDir, receipts: run.receipts ?? [], summary: run.summary ?? null });
    log(`${name} finalized into ${outDir} — ${(run.receipts ?? []).length} receipt(s) moved back beside the candidate`);
  }
}

// ── phase 4: the stills — read, never assumed ───────────────────────────────
const stillsLeg: { mode: string; ran: boolean; exitCode: number | null; output: string } = {
  mode: stills,
  ran: false,
  exitCode: null,
  output: "",
};
if (stills !== "skip") {
  phase(`Stills — ${stills === "write" ? "re-render" : "verify"}`);
  const renderArgs = stills === "write" ? [] : ["--check"];
  const r = await world.run("node", [`${dir}/render-png.mjs`, ...renderArgs]);
  stillsLeg.ran = true;
  stillsLeg.exitCode = r.exitCode ?? null;
  stillsLeg.output = String(r.stdout ?? "").trim();
  const err = String(r.stderr ?? "").trim();
  // The script's own words either way: the write leg needs headless Chrome
  // and reports its own failure verbatim, which is the whole diagnosis.
  log(`${dir}/render-png.mjs ${renderArgs.join(" ")} — exit ${r.exitCode}\n${stillsLeg.output}${err ? `\n${err}` : ""}`);
  if (r.exitCode !== 0) log(`the stills leg failed on the script's own report above — the stills are unverified, and this loop never edits a PNG`);
}

// ── phase 5: the report ─────────────────────────────────────────────────────
phase("Report what moved and what is still owed");

for (const d of diagrams) {
  if (!inbound(d)) continue;
  report({
    diagram: d.diagram,
    type: d.type,
    pinnedRevision: d.pinnedRevision,
    stale: d.stale,
    intact: d.refs.intact,
    moved: d.refs.moved.map((m) => ({ path: m.path, from: m.from, to: m.to, label: m.label })),
    changed: d.refs.changed.map((c) => ({ path: c.path, from: c.from, label: c.label })),
    missing: d.refs.missing.map((m) => ({ path: m.path, from: m.from, label: m.label })),
    repinned: repinned.some((r) => r.diagram === d.diagram),
  });
}
for (const u of unreadable) report({ unreadable: u });
for (const r of rounds) report({ finalized: r.diagram, receipts: r.receipts.length, outDir: r.outDir });
for (const r of refusedRounds) report({ finalizeRefused: r.diagram, refused: r.reason });

const col = (s: unknown, n: number) => {
  const t = String(s ?? "—");
  return t.length >= n ? t.slice(0, n) : t + " ".repeat(n - t.length);
};
const md = [
  `# Diagram refresh`,
  "",
  `Directory: \`${dir}\` — ${diagrams.length} candidate(s), audited against \`${revision}\` (head ${audit.head.slice(0, 7)}).`,
  `Pins behind the head: ${behindHead.length ? behindHead.join(", ") : "none"} — the bytes at their pinned ranges are still identical, so nothing is false; the pin is simply older than the tree.`,
  "",
  `| diagram | type | pin | intact | moved | changed | missing | re-pinned | finalized |`,
  `|---|---|---|---|---|---|---|---|---|`,
  ...diagrams.map(
    (d) =>
      `| ${d.diagram} | ${d.type} | ${d.pinnedRevision.slice(0, 7)} | ${d.refs.intact} | ${d.refs.moved.length} | ` +
      `${d.refs.changed.length} | ${d.refs.missing.length} | ${repinned.some((r) => r.diagram === d.diagram) ? "yes" : "—"} | ` +
      `${rounds.some((r) => r.diagram === d.diagram) ? "yes" : "—"} |`,
  ),
  "",
  repinned.length
    ? [
        `## Re-pinned (mechanical)`,
        "",
        ...repinned.flatMap((r) =>
          r.changes.map((c) => `- \`${r.diagram}\` — \`${c.path}\` ${c.from.join("-")} → ${c.to.join("-")}: the pinned bytes were located verbatim at their new lines, and the revision moved to ${audit.head.slice(0, 7)}`),
        ),
        "",
        `The re-pin is arithmetic, not judgment: the audit proved the whole pinned range was byte-identical before anything moved, so a moved ref carries no new claim. Running it twice changes nothing — the probe counts the second pass.`,
      ].join("\n")
    : `## Re-pinned (mechanical)`,
  "",
  `## Owed to an agent (judgment — this loop makes none of it)`,
  "",
  changedTotal || missingTotal
    ? [
        ...diagrams.flatMap((d) =>
          [...d.refs.changed, ...d.refs.missing].map(
            (c) => `- \`${d.diagram}\` — \`${c.path}\` ${(c as { from: number[] }).from.join("-")} "${c.label ?? ""}" (${"changed" in c ? "the anchored bytes were edited" : "the file is gone"}) — re-read the range in the current file, decide whether the claim still holds, and only then edit the candidate`,
          ),
        ),
        "",
        `A \`changed\` verdict means the bytes at the pin no longer match: the claim may now be false, and a false claim on the architecture diagram is worse than a stale one. That reading is the agent's; this loop reports the old range and the label and stops.`,
      ].join("\n")
    : `Nothing is owed to an agent this run — no ref's anchored bytes were edited, and no anchored file is gone.`,
  "",
  unreadable.length ? `## Could not be written\n\n${unreadable.map((u) => `- ${u}`).join("\n")}\n` : `## Could not be written\n\nNothing.`,
  "",
  `## Finalize rounds`,
  "",
  rounds.length
    ? [
        ...rounds.map(
          (r) =>
            `- \`${r.diagram}\` → \`${r.outDir}\` — ${r.receipts.length} receipt(s) moved back beside the candidate (the refresh dir stays scratch; the repo tracks the receipts, not the round)`,
        ),
      ].join("\n")
    : `No finalize round ran${dryRun ? " (dry run)" : refusedRounds.length ? ` — every round was refused: ${refusedRounds.map((r) => `${r.diagram}: ${r.reason}`).join("; ")}` : " — nothing was re-pinned and nothing was named in scope"}.`,
  "",
  `## Stills — ${stills === "skip" ? "skipped by request" : stillsLeg.ran ? `\`render-png.mjs\` ${stills === "write" ? "(write leg)" : "--check"} exited ${stillsLeg.exitCode}` : "not reached"}`,
  "",
  stills === "skip" ? "The stills leg was skipped." : "```\n" + (stillsLeg.output || "(no output)") + "\n```",
  "",
  `**Eye-verify the stills before committing.** This loop proves the stills' sizes match the HTML viewBoxes; it does not look at them. A byte-identical still after a label-only edit is success, not a render failure — but a new node, an edge, or a moved box is a reader's call. Open each PNG beside its candidate and read it the way the archify skill's procedure reads it: the diagram is the repo's claim about itself, and this loop only kept that claim anchored.`,
  "",
  `What this loop does not cover, by design: it never authors a node, edge, or label; it never verifies that a claim whose bytes changed is still true; it never repairs a layout the archify gates rejected; and it never accepts a still.`,
];
await artifact.markdown("diagram-refresh", md.join("\n"), { title: "Diagram refresh", primary: true });

const eyeOwed = stills === "skip" ? "the stills leg was skipped" : stillsLeg.exitCode === 0 ? "the stills verified by size" : "the stills leg failed its own report";
// A refused round is part of the outcome, not a footnote: the fail-open law
// says every not-ok branch ends the loop with the refusal's own words, and the
// conclusion is the words a caller reads first.
const refusedTail = refusedRounds.length
  ? ` — finalize refused: ${refusedRounds.map((r) => `${r.diagram}: ${r.reason}`).join("; ")}`
  : "";
return {
  conclusion:
    (movedTotal || changedTotal || missingTotal
      ? `diagram-refresh: ${repinned.length} candidate(s) re-pinned (${repinned.reduce((n, r) => n + r.changes.length, 0)} move(s)), ` +
        `${rounds.length} finalized, ${changedTotal} changed / ${missingTotal} missing ref(s) owed to an agent, ${eyeOwed}`
      : `diagram-refresh: drift-free — ${diagrams.length} candidate(s), ${total((r) => r.intact)} ref(s) intact at ${audit.head.slice(0, 7)}${
          behindHead.length ? ` (${behindHead.length} pin(s) behind the head, bytes identical)` : ""
        }, ${eyeOwed}`) + refusedTail,
  head: audit.head,
  diagrams: diagrams.map((d) => ({
    diagram: d.diagram,
    type: d.type,
    pinnedRevision: d.pinnedRevision,
    stale: d.stale,
    intact: d.refs.intact,
    moved: d.refs.moved.length,
    changed: d.refs.changed.length,
    missing: d.refs.missing.length,
    repinned: repinned.some((r) => r.diagram === d.diagram),
    finalized: rounds.some((r) => r.diagram === d.diagram),
  })),
  repinned: repinned.map((r) => ({ diagram: r.diagram, changes: r.changes })),
  owed: diagrams.flatMap((d) =>
    [...d.refs.changed, ...d.refs.missing].map((c) => ({
      diagram: d.diagram,
      path: c.path,
      from: c.from,
      label: c.label,
    })),
  ),
  rounds: rounds.map((r) => ({ diagram: r.diagram, outDir: r.outDir, receipts: r.receipts })),
  finalizeRefused: refusedRounds,
  stills: { mode: stillsLeg.mode, ran: stillsLeg.ran, exitCode: stillsLeg.exitCode },
  verified: [
    `every ref in every candidate was compared byte-for-byte at its pinned range against ${revision} — identity, not similarity`,
    repinned.length
      ? `the re-pin applied only the moved verdicts (${repinned.reduce((n, r) => n + r.changes.length, 0)} ref(s)) and repinned the revision in the same write; a second application changes nothing`
      : "no ref moved, so no candidate was written — the re-pin's no-op is its second application",
    rounds.length ? `the finalize receipt dance ran for ${rounds.length} candidate(s): receipts moved back beside the candidate, one refresh dir per round` : "no finalize round ran — either nothing was re-pinned, or every round was refused by name",
    stills === "skip" ? "the stills leg did not run (skipped by request)" : stillsLeg.exitCode === 0 ? `the stills leg ran and passed on the script's own report` : `the stills leg ran and failed on the script's own report (exit ${stillsLeg.exitCode})`,
  ],
  notCovered: [
    "authoring — no node, edge, or label is invented here; a wave's new claim is an agent's edit and this loop's audit will check its anchors next run",
    "meaning — byte identity proves the anchored bytes are unchanged, not that the claim they anchor is still worth making; a ref that moved with its code is still a true claim about the same bytes, and only a reader judges whether that claim matters",
    "layout repair — archify's gates reject over-long sublabels and position collisions, and an agent repairs; this loop takes a rejection as a refusal by name",
    "the stills' appearance — this loop compares sizes, never pixels; eye-acceptance is the reader's pass, and the artifact commands it",
  ],
};
