/* workflow
description: "The media lane's narration seam, as a one-pass batch loop: render a
  request file of lines through gen1's speak legs, assemble the hyperframes
  `audio_meta.json` from the engine's own accountable rows, and gate the result
  against the script through the ASR round-trip. Verify mode is the default —
  a `--script`/`--audio` pair or an existing `--request`/`--meta`/`--project`
  render is gated with nothing rendered. Render mode speaks each line into
  `outDir` and gates the seam it just built. The verdict is advisory by the
  lane's law: `gaps` reports and escalates once, and the loop never blocks,
  because the engine's gate never blocks. A `--project` path-escape is the
  engine's refusal by name — the loop resolves nothing itself and passes the
  refusal through verbatim. Fails open by name: no dev-decisions, an unreadable
  request, or a refusing leg ends the loop with the refusal verbatim and
  nothing rendered."
whenToUse: Before or after rendering narration, when the question is whether the
  spoken audio still says what the script says. Run with `--grant media`.
  Hand-launched by design — the args are structured, and a render spends real
  provider seconds, so nothing here is router-assignable.
args:
  script:
    type: string
    description: Ground-truth script text (verify mode, single-file). Pair with `audio`.
    required: false
  audio:
    type: string
    description: Rendered audio file to verify against `script` (verify mode, single-file).
    required: false
  request:
    type: string
    description: Request file of lines (a JSON array of {id, text}, or an object with a "lines" array). With `meta` it is an existing render to verify; without it, render mode speaks these lines.
    required: false
  meta:
    type: string
    description: An existing audio_meta.json — its presence puts the loop in verify-seam mode against the render already on disk.
    required: false
  project:
    type: string
    description: Render project dir the meta's audio paths resolve against (default "." — the workspace root; the loop's own meta paths are workspace-relative).
    required: false
  outDir:
    type: string
    description: Where renders land and the loop's own audio_request.json / audio_meta.json are written (default assets/voice). Project-relative: a path outside the workspace is the engine's path-escape refusal, by name.
    required: false
  voice:
    type: string
    description: Voice id forwarded to every speak leg (default the provider catalog's own).
    required: false
  language:
    type: string
    description: Language forwarded to the speak legs and the ASR gate (default en).
    required: false
  speed:
    type: number
    description: Speech rate multiplier forwarded to the speak legs (default the provider's own).
    required: false
  format:
    type: string
    description: Audio format the render is named for and forwarded to the speak legs (default mp3). Every provider serves its own container and the row says which — a disagreement is named, never hidden.
    required: false
  dryRun:
    type: boolean
    description: Verify without rendering: no speak leg is called and no meta is written; the gate still runs against whatever seam is already on disk.
    required: false
*/
/**
 * narrate: the seam's two halves, held together by the engine's own rows.
 *
 * Batch-only by the media lane's law — every leg here is a dev-decisions verb
 * between agent rounds, and this loop spawns no agents at all. It composes the
 * hyperframes seam from the engine's accountable rows rather than shelling
 * gen1's own route under the process grant: the rows are the accountability
 * surface (duration measured from the returned bytes, the provider leg that
 * answered, the request id), and one grant is one thing to police.
 *
 * The advisory law is the engine's, inherited unchanged: media-gate returns
 * WARN on gaps and ERROR when nothing could be verified, and it can never
 * block — the verdict rides an uncalibrated ASR until record-asr earns floors.
 * So this loop reports `gaps`, escalates once, and returns a normal result.
 * There is no blocking branch to take.
 *
 * The path-escape law is the engine's too: a meta whose voice path leaves the
 * project is refused by name inside the gate's row, and the loop passes that
 * sentence through verbatim. It resolves nothing itself.
 */

// media-loops: this loop never blocks — the engine's gate is advisory, and so is this

const FAIL_OPEN = "narration unavailable — nothing was rendered or verified";

// The plane-side write, the same fixed node -e the diagram loop uses: content
// rides argv, never the script text, and the write journals as a command under
// the run's default-on compute grant. The seam's two JSON files are the loop's
// only writes; media-speak itself lands the audio.
const WRITE_JSON = [
  'const fs=require("node:fs"),path=require("node:path");',
  'fs.mkdirSync(path.dirname(process.argv[1]),{recursive:true});',
  'fs.writeFileSync(process.argv[1],process.argv[2]);',
].join("");

const clean = (v) => {
  const s = String(v ?? "").trim();
  return s || null;
};
const script = clean(args.script);
const audio = clean(args.audio);
const request = clean(args.request);
const metaGiven = clean(args.meta);
const project = clean(args.project) ?? ".";
const outDir = clean(args.outDir) ?? "assets/voice";
const outDirClean = outDir.replace(/\/+$/, "");
const voice = clean(args.voice);
const language = clean(args.language);
const speedRaw = Number(args.speed);
const speed = Number.isFinite(speedRaw) && speedRaw > 0 ? speedRaw : null;
const format = String(args.format ?? "mp3").trim().replace(/^\./, "") || "mp3";
const dryRun = args.dryRun === true;

// The three modes, discriminated the way the engine's own usage line is: a
// script/audio pair verifies one file, a request with a meta verifies a render
// already on disk, and a request alone renders.
const verifySingle = request === null && script !== null && audio !== null;
const verifySeam = request !== null && metaGiven !== null;
const renderMode = request !== null && metaGiven === null;
let mode = "verify-single";
if (verifySeam) mode = "verify-seam";
else if (renderMode) mode = "render";

const failOpen = (where, refused) => {
  log(`${FAIL_OPEN} — ${where}: ${refused}`);
  report({ failOpen: true, where, refused, mode });
  return {
    conclusion: `${FAIL_OPEN} — ${where}: ${refused}`,
    failOpen: true,
    where,
    refused,
    mode,
    verdict: null,
    blocked: false,
    rendered: [],
    verified: [`an unavailable ${where} ends the loop with the refusal verbatim and renders nothing`],
    notCovered: [
      "rendering — no speak leg was called",
      "the gate — the seam was never assembled, so there was nothing to verify",
    ],
  };
};

// ── the mode check, before anything is spent ────────────────────────────────
if (!verifySingle && !verifySeam && !renderMode) {
  if (script !== null || audio !== null) {
    return failOpen(
      "the args name half of a pair",
      "verify mode needs both --script and --audio (single file), or --request with --meta (an existing render), or --request alone to render — got " +
        `${script ? "--script" : "--audio"} without its pair`,
    );
  }
  return failOpen(
    "the args name no mode",
    "nothing to do: pass --script with --audio to verify one file, --request with --meta to verify an existing render, or --request alone to render and gate",
  );
}

// ── render mode: read the request, stage it in the seam's dialect ───────────
const anomalies = [];
const requestPath = renderMode ? `${outDirClean}/audio_request.json` : request;
const metaOut = `${outDirClean}/audio_meta.json`;
let metaJson = null;
let lines = [];

if (renderMode) {
  phase("Read the request");
  let parsed = null;
  try {
    parsed = JSON.parse(String(await files.read(request)));
  } catch (e) {
    return failOpen(`the request ${request} is unreadable`, String(e?.message ?? e).slice(0, 200));
  }
  const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.lines) ? parsed.lines : null;
  if (!arr) {
    return failOpen(
      `the request ${request} has no lines`,
      'expected a JSON array of {id, text} objects, or an object with a "lines" array',
    );
  }
  lines = arr
    .filter((l) => l && typeof l === "object")
    .map((l, i) => ({ id: clean(l.id) ?? `line_${i + 1}`, text: String(l.text ?? "") }));
  if (!lines.length) return failOpen(`the request ${request} has no lines`, "every entry was not an object");

  // An empty line is skipped before a leg is spent on it — the same rule
  // gen1's own adapter follows, and the reason is named rather than swallowed.
  const empty = lines.filter((l) => !l.text.trim());
  for (const l of empty) anomalies.push(`line ${l.id}: empty text — skipped, no leg spent`);
  lines = lines.filter((l) => l.text.trim());
  log(`${lines.length} line(s) in ${request} → ${requestPath}${empty.length ? ` (${empty.length} skipped: ${empty.map((l) => l.id).join(", ")})` : ""}`);

  phase("Stage the request in the seam's dialect");
  const staged = JSON.stringify({ lines }, null, 2) + "\n";
  const w = await world.run("node", ["-e", WRITE_JSON, requestPath, staged]);
  if (w.exitCode !== 0) {
    return failOpen(
      `the staged request ${requestPath} could not be written`,
      String(w.stderr ?? "").trim().slice(0, 200) || `the writer exited ${w.exitCode}`,
    );
  }
  log(`staged ${requestPath} — ${staged.length} bytes`);
}

// ── render mode: speak each line, assemble the meta from the rows ───────────
const rendered = [];
if (renderMode && !dryRun) {
  phase(`Render ${lines.length} line(s) into ${outDirClean}`);
  for (const line of lines) {
    const callArgs = { text: line.text, out: `${outDirClean}/${line.id}.${format}`, format };
    if (voice) callArgs.voice = voice;
    if (language) callArgs.language = language;
    if (speed !== null) callArgs.speed = speed;
    const res = await world.media("media-speak", callArgs);
    // A pre-row refusal (usage, an unwritable out) is a broken leg, not a
    // skipped line: the bridge carries its sentence in `refused`, and the loop
    // ends with it rather than guessing a line-level verdict.
    if (!res.ok) return failOpen("media-speak refused", res.reason);
    if (res.refused) return failOpen("media-speak refused", res.refused);
    const row = res.rows.find((r) => r && r.op === "media-speak") ?? res.rows[0] ?? {};
    if (String(row.verdict ?? "") !== "ok") {
      // The engine's refusal row carries no reason of its own — the line is
      // omitted from the seam and named, so a partial run is never mistaken
      // for a complete one.
      anomalies.push(`line ${line.id}: media-speak refused — the row carries no reason; omitted from the seam`);
      log(`line ${line.id}: refused — omitted from the seam`);
      continue;
    }
    // The extension claims a container; the row says what the leg actually
    // served. A disagreement is named, never hidden behind the filename.
    const served = String(row.format ?? "");
    if (served && served !== format) {
      anomalies.push(`line ${line.id}: served ${served} into a .${format} filename — the row's format is the container truth`);
    }
    const duration = Number(row.duration_seconds ?? 0);
    rendered.push({
      id: line.id,
      path: String(row.target ?? `${outDirClean}/${line.id}.${format}`),
      duration,
      provider: String(row.provider ?? ""),
      format: served,
      voice: row.voice ?? null,
      request_id: String(row.request_id ?? ""),
    });
    log(`line ${line.id}: ${duration.toFixed(2)}s ${served} via ${rendered[rendered.length - 1].provider} → ${rendered[rendered.length - 1].path}`);
  }

  phase("Assemble the seam meta from the engine's own rows");
  const voices = rendered.map((r) => ({
    id: r.id,
    path: r.path, // the row's own target, verbatim — the meta never invents a path
    duration_s: Math.round(r.duration * 1000) / 1000,
    words: [], // the seam's pinned empty: gen1 measures duration, it does not align
    provider: r.provider,
    format: r.format,
    voice: r.voice,
    request_id: r.request_id,
  }));
  const meta = {
    voices,
    total_duration_s: Math.round(voices.reduce((n, v) => n + v.duration_s, 0) * 1000) / 1000,
    tts_provider: "gen1",
    voice_id: voices.length ? voices[0].voice : null,
    ...(anomalies.length ? { anomalies } : {}),
  };
  metaJson = JSON.stringify(meta, null, 2) + "\n";
  const mw = await world.run("node", ["-e", WRITE_JSON, metaOut, metaJson]);
  if (mw.exitCode !== 0) {
    return failOpen(
      `the seam meta ${metaOut} could not be written`,
      String(mw.stderr ?? "").trim().slice(0, 200) || `the writer exited ${mw.exitCode}`,
    );
  }
  log(`wrote ${metaOut} — ${voices.length} voice(s), ${meta.total_duration_s}s total`);
} else if (renderMode && dryRun) {
  phase("Dry run — nothing rendered");
  log(
    `dry run: ${lines.length} line(s) would be rendered into ${outDirClean} as .${format} and gated; ` +
      `no speak leg was called and no meta was written — the gate below runs against whatever seam is already at ${metaOut}`,
  );
}

// ── the gate: one call, every mode ──────────────────────────────────────────
phase("Gate the narration against the script");
const gateArgs = verifySingle
  ? { script, audio }
  : { request: requestPath, meta: metaGiven ?? metaOut, project };
if (language) gateArgs.language = language;
const gate = await world.media("media-gate", gateArgs);
if (!gate.ok) return failOpen("media-gate refused", gate.reason);
// The lane prints pre-row refusals on stdout as {ok: false, error} — the
// bridge surfaces that sentence in `refused` rather than as a transport
// failure, and the loop passes it through verbatim.
if (gate.refused) return failOpen("media-gate refused", gate.refused);
if (!gate.rows.length) return failOpen("media-gate answered with no row", "the verb printed nothing on stdout");

const row = gate.rows.find((r) => r && r.op === "media-gate") ?? gate.rows[0];
const verdict = String(row.verdict ?? "error");
const gateLines = (Array.isArray(row.lines) ? row.lines : []).map((l) => ({
  id: String(l.id ?? "?"),
  agreement: Number(l.agreement ?? 0),
  refTokens: Number(l.ref_tokens ?? 0),
  gotTokens: Number(l.got_tokens ?? 0),
  missing: Number(l.missing ?? 0),
  extra: Number(l.extra ?? 0),
}));
const gateRefused = (Array.isArray(row.refused) ? row.refused : []).map((r) => ({
  id: String(r.id ?? "?"),
  error: String(r.error ?? ""),
}));
const gapLines = gateLines.filter((l) => l.missing || l.extra);
const target = String(row.target ?? (verifySingle ? script : requestPath));

log(
  `${target} (${String(row.mode ?? mode)} mode, ${String(row.provider ?? "")}) — verdict ${verdict}` +
    (gateLines.length
      ? "\n  id                        agreement  script/transcript  gap\n" +
        gateLines
          .map(
            (l) =>
              `  ${l.id.padEnd(24)}${l.agreement.toFixed(3).padStart(9)}  ${String(l.refTokens).padStart(6)}/${String(l.gotTokens).padStart(6)}      ${l.missing || l.extra ? "gaps" : "ok"}`,
          )
          .join("\n")
      : "") +
    (gateRefused.length ? "\n" + gateRefused.map((r) => `  ${r.id}: refused — ${r.error}`).join("\n") : ""),
);
for (const r of gateRefused) report({ refused: r.id, error: r.error });
for (const l of gateLines) {
  report({ line: l.id, agreement: l.agreement, refTokens: l.refTokens, gotTokens: l.gotTokens, missing: l.missing, extra: l.extra });
}

// The one escalation, and only for gaps: a drifted narration is a decision the
// owner makes (re-render, or accept), and the lane's WARN exit is advisory —
// this loop's answer rides the same law and blocks nothing.
let ownerAnswer = null;
if (verdict === "gaps") {
  const worst = gateLines.length ? Math.min(...gateLines.map((l) => l.agreement)) : null;
  const answer = await escalate(
    `narration gaps: ${gapLines.length} of ${gateLines.length} line(s) differ from the script ` +
      `(worst agreement ${worst == null ? "—" : worst.toFixed(3)}) — advisory, never blocks: re-render, or accept the drift?`,
    JSON.stringify({ verdict, lines: gateLines, refused: gateRefused }),
    "narration-gaps",
  );
  ownerAnswer = String(answer ?? "").slice(0, 300) || null;
  report({ escalated: true, verdict, gapLines: gapLines.length, ownerAnswer });
}

const md = [
  `# Narration gate — ${verdict}`,
  "",
  `Mode: **${mode}**${dryRun ? " (dry run — nothing rendered)" : ""}.`,
  verifySingle
    ? `Single file: script \`${script}\`, audio \`${audio}\`.`
    : `Seam: request \`${requestPath}\`, meta \`${metaGiven ?? metaOut}\`, project \`${project}\`.`,
  "",
  gateLines.length
    ? [
        "| line | agreement | script tokens | transcript tokens | gap |",
        "|---|---|---|---|---|",
        ...gateLines.map(
          (l) =>
            `| ${l.id} | ${l.agreement.toFixed(3)} | ${l.refTokens} | ${l.gotTokens} | ${l.missing || l.extra ? `missing ${l.missing}, extra ${l.extra}` : "match"} |`,
        ),
      ].join("\n")
    : "No line could be verified.",
  "",
  gateRefused.length
    ? [
        "## Refused, by name",
        "",
        ...gateRefused.map((r) => `- \`${r.id}\`: ${r.error}`),
        "",
        "The loop resolves nothing itself: a path that escapes `--project`, a missing render, an unreadable seam — each is the engine's own sentence, passed through verbatim.",
      ].join("\n")
    : "## Refused, by name\n\nNothing was refused.",
  "",
  rendered.length
    ? [
        "## Rendered this run",
        "",
        `Into \`${outDirClean}\` as \`.${format}\`, assembled from the speak rows themselves:`,
        "",
        "| line | duration_s | format | provider leg | request_id |",
        "|---|---|---|---|---|",
        ...rendered.map((r) => `| ${r.id} | ${r.duration.toFixed(3)} | ${r.format} | ${r.provider} | ${r.request_id || "—"} |`),
        "",
        "```json",
        metaJson,
        "```",
      ].join("\n")
    : `## Rendered this run\n\nNothing was rendered${dryRun ? " (dry run)" : " — verify mode gates a render that already exists"}.`,
  "",
  anomalies.length ? `## Named anomalies\n\n${anomalies.map((a) => `- ${a}`).join("\n")}` : "## Named anomalies\n\nNone.",
  "",
  "**Advisory by the lane's law.** The verdict rides an uncalibrated ASR until `record-asr` earns floors, so `gaps` escalates and never blocks. This loop has no blocking branch: the engine's gate cannot block, and neither can this.",
  "",
  "Raw gate row, verbatim:",
  "```json",
  JSON.stringify(row),
  "```",
].join("\n");
await artifact.markdown("narrate", md, { title: `Narration gate — ${verdict}`, primary: true });

return {
  conclusion:
    `narrate: verdict ${verdict} (${mode} mode${dryRun ? ", dry run" : ""}) — ` +
    `${gateLines.length} line(s) verified, ${gapLines.length} with gaps, ${gateRefused.length} refused` +
    (rendered.length
      ? `, ${rendered.length} rendered into ${outDirClean} (${rendered.reduce((n, r) => n + r.duration, 0).toFixed(1)}s)`
      : "") +
    (verdict === "gaps" ? " — advisory, escalated once, nothing blocked" : "") +
    (gateRefused.length ? ` — refused by name: ${gateRefused.map((r) => `${r.id}: ${r.error}`).join("; ")}` : ""),
  mode,
  dryRun,
  verdict,
  blocked: false,
  target,
  lines: gateLines,
  refused: gateRefused,
  rendered: rendered.map((r) => ({
    id: r.id,
    path: r.path,
    duration_s: r.duration,
    provider: r.provider,
    format: r.format,
    voice: r.voice,
    request_id: r.request_id,
  })),
  anomalies,
  ownerAnswer,
  verified: [
    verifySingle
      ? `the single-file gate ran against ${script} and ${audio} — the engine's own comparator, not this loop's`
      : `the seam gate ran against ${requestPath} and ${metaGiven ?? metaOut} under ${project} — every audio path resolved by the engine, and an escape refused by name`,
    renderMode && !dryRun
      ? "every rendered line's meta row came from the speak row itself: the row's target as the path, its byte-measured duration, its provider leg, its format, its request id"
      : "nothing was rendered — verify mode gates a render that already exists",
    verdict === "gaps"
      ? "the gaps path reported and escalated exactly once, then returned a normal result — the WARN-never-block law holds"
      : "no gaps, so no escalation",
    "the loop never blocks: the marker `media-loops: this loop never blocks` in the source holds, and no branch returns a blocked state",
  ],
  notCovered: [
    "word timestamps — gen1 measures duration from bytes and does not align text to audio, so the seam's `words` is the pinned empty and captions are a separate pass",
    "re-rendering — a gaps verdict escalates and stops; the owner decides whether to render again",
    "container transcoding — a leg serves the container it serves, and a disagreement between the filename and the row's format is named rather than converted",
  ],
};
