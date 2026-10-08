/* workflow
description: "Produces a document, report, or deck content from a brief: an
  outliner shapes the thesis and sections, section writers draft in parallel,
  and a fresh reviewer with a fix pass polishes the assembled draft before it is
  written to its final file. With the media grant, the finished piece also
  gains a voice track — spoken and gated through dev-decisions, advisory, and
  never a block."
whenToUse: When the request is to produce written content — a report, article,
  deck content, or long-form document — from a brief.
args:
  brief:
    type: string
    description: "What to produce: the content, audience, format, and purpose."
    required: true
*/
/**
 * content-production: produce a document, report, or deck content from a
 * brief. Outliner shapes it, section writers work in parallel, and a fresh
 * reviewer with a fix pass polishes the assembled draft.
 */

interface Outline {
  /** What the piece argues or delivers, one sentence. */
  thesis: string;
  sections: {
    /** Short id like "1". */
    id: string;
    /** The section title. */
    title: string;
    /** What this section must accomplish, one or two sentences. */
    angle: string;
  }[];
}

interface Draft {
  /** The section covered. */
  sectionId: string;
  /** The finished section text in the requested format. */
  text: string;
}

interface Review {
  /** What is unclear, unsupported, or missing — ask for failures, not approval. */
  issues: string[];
}

interface Final {
  /** Path of the finished piece. */
  path: string;
  /** Two or three sentences on what the piece delivers. */
  summary: string;
}

interface Finding {
  where: string;
  what: string;
  evidence: string;
  status: "verified" | "unconfirmed";
  severity: "low" | "medium" | "high";
}

const brief = String(args.brief ?? "").trim() || "Write something.";

phase("Shape the outline");
const outliner = agent("Outliner", {
  system:
    "You shape briefs into outlines: a clear thesis and 3 to 7 sections, each with a job. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});
const outline = await outliner.ask<Outline>(
  `Brief: ${brief}\n\nReturn a thesis and 3 to 7 sections with id, title, and angle.`
);
log(`Drafting ${outline.sections.length} sections in parallel`);

phase("Draft each section in parallel");
const drafts = await Promise.all(
  outline.sections.map(async (s) => {
    const writer = agent(`Writer for ${s.title}`, {
      system:
        "You write one section of a larger piece: finished prose in the format the brief asks " +
        "for, hitting your section's angle exactly. " +
        "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
    });
    return writer.ask<Draft>(
      `Brief: ${brief}\nThesis: ${outline.thesis}\nYour section: ${s.title} — ${s.angle}\n\n` +
        "Write the finished section text. Return sectionId and text."
    );
  })
);

phase("Review the assembled draft with fresh eyes and fix what it finds");
const assembled = drafts.map((d) => d.text).join("\n\n");
const reviewer = agent("Reviewer", {
  system:
    "You review an assembled draft with fresh eyes and never edit files. " +
    "Ask for failures, not approval: what is unclear, unsupported, inconsistent between " +
    "sections, or missing for the audience. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});
const polisher = agent("Polisher", {
  system:
    "You revise a draft to address review comments, keeping the author's voice and structure. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});
let current = assembled;
let openIssues: string[] = [];
const findings: Finding[] = [];
for (let round = 1; round <= 2; round++) {
  const review = await reviewer.ask<Review>(
    `Review this assembled draft for the brief "${brief}":\n\n${current}\n\nReturn issues.`
  );
  if (review.issues.length === 0) break;
  openIssues = review.issues;
  current = await polisher.ask<string>(
    `Revise the draft to address each issue:\n${JSON.stringify(review.issues)}\n\nDraft:\n${current}\n\nReturn the revised full text only.`
  );
}
for (const issue of openIssues) {
  const f: Finding = {
    where: "the piece",
    what: issue,
    evidence: "raised by the fresh-eyes reviewer of the assembled draft",
    status: "unconfirmed",
    severity: "low",
  };
  findings.push(f);
  report(f);
}

phase("Write the finished piece to its file");
const finisher = agent("Finisher", {
  system:
    "You write the finished version of a piece to its final file, exactly as revised. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.",
});
const final = await finisher.ask<Final>(
  `Brief: ${brief}\n\nWrite the finished piece to out/content/deliverable.md exactly as follows, then return path and summary:\n\n${current}`
);

try {
  await artifact.file("deliverable", final.path, { title: "The finished piece", primary: true });
} catch {
  await finisher.ask(`Re-write the piece to ${final.path} — the file is missing.`);
  await artifact.file("deliverable", final.path, { title: "The finished piece", primary: true });
}

// The deliverable is markdown; a voice track speaks its prose. Stripping the
// scaffolding is this leg's own small transform, named here so the gate's
// verdict reads as "the render matches the script that was spoken" rather
// than a silent comparison against markup nobody hears.
const spokenScript = (md: string): string =>
  md
    .replace(/```[\s\S]*?```/g, "\n") // fenced code is not narration
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "") // heading markers
    .replace(/^[ \t]{0,3}>[ \t]?/gm, "") // quote markers
    .replace(/^[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]+/gm, "") // list markers
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links and images keep their text
    .replace(/[*_~`|]/g, "") // emphasis, strikethrough, code ticks, table rules
    .replace(/^[ \t:|-]+$/gm, "") // a stripped table rule or horizontal rule is not narration
    .replace(/^[ \t]+|[ \t]+$/gm, "") // per-line trim
    .replace(/\n{3,}/g, "\n\n")
    .trim();

// ── the optional voice leg (media lane) ────────────────────────────────────
// media-loops: the finished piece gains a voice track behind the media grant,
// and the leg never blocks. media-gate's verdict is advisory by its own law —
// it rides an uncalibrated ASR until record-asr earns floors — and this loop
// keeps it that way: every path below names what happened and leaves the
// deliverable exactly as the finisher wrote it. Grant absent → this block
// never runs and the piece is byte-identical to the content-production that
// always was (the triage.ts eval-head pattern). dev-decisions is the gate:
// the leg speaks its verbs and never a provider's API, and the engine writes
// the audio itself rather than a shell under the process grant.
const WRITE_ONE = [
  'const fs=require("node:fs"),path=require("node:path");',
  'fs.mkdirSync(path.dirname(process.argv[1]),{recursive:true});',
  'fs.writeFileSync(process.argv[1],process.argv[2]);',
].join("");

let voice: {
  verdict: string;
  agreement: number | null;
  audio: string;
  duration: number | null;
  format: string;
} | null = null;

if (world.grants().has("media")) {
  // One helper, one shape: either a refusal sentence or the leg's outcome.
  // The leg never throws and never blocks — a caller reads the sentence and
  // the piece stands.
  const runVoiceLeg = async (): Promise<
    | { refused: string }
    | { verdict: string; agreement: number | null; audio: string; duration: number | null; format: string; note: string }
  > => {
    let draftText: string;
    try {
      draftText = String(await files.read(final.path));
    } catch (e) {
      return { refused: `the finished piece could not be read back — ${String(e?.message ?? e).slice(0, 160)}` };
    }
    const scriptText = spokenScript(draftText);
    if (!scriptText) {
      return { refused: "the finished piece has no prose to speak once its markup is stripped" };
    }
    const scriptPath = "out/content/voice-script.txt";
    const audioPath = "out/content/voice.mp3";
    const staged = await world.run("node", ["-e", WRITE_ONE, scriptPath, scriptText]);
    if (staged.exitCode !== 0) {
      return {
        refused: `the spoken script could not be staged — the writer exited ${staged.exitCode}: ${String(staged.stderr ?? "").trim().slice(0, 160)}`,
      };
    }
    // The W1 bridge difference, pinned by narrate's probe: a pre-row refusal
    // resolves as transport-success carrying the sentence in `refused`, so
    // `!res.ok` alone would read a refusal row as a rendered leg.
    const render = await world.media("media-speak", { "text-file": scriptPath, out: audioPath, format: "mp3" });
    if (!render.ok) return { refused: `media-speak refused — ${String(render.reason ?? "")}` };
    if (render.refused) return { refused: `media-speak refused — ${String(render.refused)}` };
    const row = render.rows[0];
    if (!row) return { refused: "media-speak answered with no row — nothing was rendered" };
    // Every gen1 provider serves its own container and ignores the requested
    // one, so the .mp3 extension was this leg's guess: the row's format is the
    // container truth, and a disagreement is named rather than hidden.
    const served = String(row.format ?? "mp3");
    const containerNote =
      served !== "mp3" ? ` — served ${served} into a .mp3 filename, and the row's format is the container truth` : "";
    const gate = await world.media("media-gate", { script: scriptPath, audio: audioPath });
    if (!gate.ok) return { refused: `media-gate refused — ${String(gate.reason ?? "")}` };
    if (gate.refused) return { refused: `media-gate refused — ${String(gate.refused)}` };
    const g = gate.rows[0];
    if (!g) return { refused: "media-gate answered with no row — the render stands unverified" };
    const agreement = g.lines?.[0]?.agreement;
    return {
      verdict: String(g.verdict ?? "unknown"),
      agreement: typeof agreement === "number" ? agreement : null,
      audio: audioPath,
      duration: typeof row.duration_seconds === "number" ? Number(row.duration_seconds) : null,
      format: served,
      note: `${String(g.note ?? "")}${containerNote}`,
    };
  };

  try {
    const leg = await runVoiceLeg();
    if ("refused" in leg) {
      // A refusal produces no voice track, so the deliverable's shape is
      // untouched: the sentence rides the log and the journal, exactly as the
      // triage eval-head's unavailable line does.
      log(`voice leg unavailable — ${leg.refused}`);
    } else {
      voice = {
        verdict: leg.verdict,
        agreement: leg.agreement,
        audio: leg.audio,
        duration: leg.duration,
        format: leg.format,
      };
      log(
        `voice track: ${leg.audio} — ${leg.duration !== null ? `${leg.duration.toFixed(2)}s ` : ""}${leg.format}, ` +
          `media-gate verdict ${leg.verdict}${leg.agreement !== null ? ` at ${leg.agreement.toFixed(3)} agreement` : ""} ` +
          `(${leg.note}) — advisory, the piece stands as written`,
      );
      try {
        await artifact.file("voice-track", leg.audio, { title: "The finished piece, spoken" });
      } catch {
        // A render the engine wrote but the artifact API cannot see is a
        // workspace surprise; the audio stands on disk and the leg says so
        // rather than failing the piece over a publication.
        log(`the voice track rendered at ${leg.audio} but could not be published as an artifact`);
      }
    }
  } catch (e) {
    log(`voice leg unavailable — ${String(e?.message ?? e).slice(0, 200)}`);
  }
}

// The advisory line rides the deliverable, and the field only exists when a
// voice track does: a run that produced none — no grant, or any refusal —
// returns exactly the shape this workflow always returned.
const voiceLine = voice
  ? ` A voice track rides with it (${voice.audio}): media-gate's verdict is ${voice.verdict}` +
    `${voice.agreement !== null ? ` at ${voice.agreement.toFixed(3)} agreement` : ""} — advisory by the lane's law, never a block.`
  : "";

return {
  conclusion: `${final.summary} Piece: ${final.path}.${voiceLine}`,
  findings,
  ...(voice ? { voice } : {}),
  verified: [
    "the assembled draft had a fresh-eyes review with a fix pass",
    ...(voice ? ["a voice track was rendered and gated, and the gate's verdict stayed advisory"] : []),
  ],
  notCovered: [
    "factual claims in the prose are written to the brief, not independently verified",
    ...(openIssues.length > 0 ? ["the last review's issues may remain partially addressed"] : []),
    ...(voice ? ["the voice track's fidelity — media-gate's verdict rides an uncalibrated ASR until record-asr earns floors"] : []),
  ],
};
