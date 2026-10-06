/* workflow
description: "Red-teams a finished deliverable: challengers with distinct
  personas attack it, a judge keeps only attacks that land, every kept attack
  is confirmed independently before a fixer addresses it, and one re-attack
  round checks the fix held. Below two surviving challengers the run says so
  instead of pretending coverage."
whenToUse: Before shipping a deliverable — a design doc, a plan, a report —
  when the question is how it fails, not whether it is nice.
args:
  deliverable:
    type: string
    description: Workspace-relative path of the deliverable to attack.
    required: true
  personas:
    type: string
    description: JSON array of attacker personas (default security, performance, malicious-user, operability).
    required: false
*/
/**
 * red-team: hostile review with confirmation.
 * Nothing is fixed on one model's word: the judge keeps, the confirmer
 * reproduces, and only confirmed attacks reach the fixer. The re-attack round
 * is the loop's honesty — a fix that opened a new hole is a residual finding,
 * reported rather than buried.
 */

interface Attack {
  /** How the deliverable fails under this persona, in a sentence. */
  attack: string;
  /** Where in the deliverable: quote or section. */
  evidence: string;
  /** Why it lands for this persona. */
  whyItLands: string;
}

interface AttackSet {
  persona: string;
  attacks: Attack[];
}

interface KeepVerdict {
  /** True when the attack is real and not a duplicate of one already kept. */
  keep: boolean;
  reason: string;
}

interface Confirmation {
  /** True when the confirmer reproduces the attack from the deliverable alone. */
  confirmed: boolean;
  evidence: string;
}

interface Residual {
  /** Attacks that still land after the fix round. */
  attack: string;
  evidence: string;
}

const ESCALATE =
  "If a check is impossible to pass, or your instructions contradict each other, escalate and say so plainly rather than working around it.";

const deliverable = String(args.deliverable ?? "").trim();
if (!deliverable) throw new Error("red-team needs a deliverable path");
let personas: string[] = (() => {
  try {
    const parsed = typeof args.personas === "string" ? JSON.parse(args.personas) : args.personas;
    if (Array.isArray(parsed) && parsed.length) return parsed.map(String);
  } catch {}
  return ["security", "performance", "malicious-user", "operability"];
})();

async function attackRound(roundLabel: string): Promise<{ attacks: { persona: string; attack: Attack }[]; survivors: number; degraded: boolean }> {
  const settled = await Promise.allSettled(
    personas.map(async (persona, i) => {
      const challenger = agent(`${roundLabel} challenger: ${persona} (${i + 1})`, {
        system:
          `You attack a deliverable as a ${persona} adversary: find how it fails, breaks, or gets abused ` +
          "in your persona's hands. Quote the deliverable as evidence. Real attacks only — an attack " +
          "that lands is specific, evidenced, and consequential. " + ESCALATE,
        shape: "loop",
        budget: { rounds: 6, tokens: 80000 },
      });
      const set: AttackSet = await challenger.ask<AttackSet>(
        `Read ${deliverable} and attack it as ${persona}. Return persona and up to 3 attacks.`
      );
      return { persona, attacks: set.attacks ?? [] };
    })
  );
  const survivors = settled.filter((s) => s.status === "fulfilled").length;
  const attacks = settled
    .filter((s): s is PromiseFulfilledResult<{ persona: string; attacks: Attack[] }> => s.status === "fulfilled")
    .flatMap((s) => (s.value.attacks ?? []).map((a) => ({ persona: s.value.persona, attack: a })));
  return { attacks, survivors, degraded: survivors < 2 };
}

phase("Attack");
const round1 = await attackRound("R1");
if (round1.degraded) {
  log(`only ${round1.survivors} challenger(s) survived — the attack surface is under-covered and the report says so`);
}
log(`R1: ${round1.attacks.length} attack(s) from ${round1.survivors} surviving challenger(s)`);

phase("Judge and confirm what landed");
// Keep/drop and confirmation ride the sys1 judge layer — flat heads over the
// deliverable text and the attack (dev-decisions first, calibration rows,
// sys1 fallback recorded). Only the challengers and the fixer are LLM asks:
// generation is theirs; judgment is the decision layer's.
let deliverableText = "";
try {
  deliverableText = await files.read(deliverable);
} catch {
  deliverableText = "";
}
const deliverableExcerpt = String(deliverableText ?? "").slice(0, 8000);
const KEEP_SPEC = {
  id: "red_team_keep",
  description: "Does this attack on the deliverable land: real, specific, consequential, not a duplicate?",
  heads: [{ id: "keep", kind: "choice", task: "Keep the attack when it is real, specific, and consequential, and not a duplicate of one already kept. Otherwise drop it.", labels: ["keep", "drop"] }],
};
const CONFIRM_SPEC = {
  id: "red_team_confirmed",
  description: "Reproducing one reported attack from the deliverable text alone: does the failure follow?",
  heads: [{ id: "confirmed", kind: "choice", task: "Confirm the attack when the deliverable text itself shows the failure it describes. Otherwise reject it.", labels: ["confirmed", "not-confirmed"] }],
};
const kept: { persona: string; attack: Attack; keepReason: string }[] = [];
for (const { persona, attack } of round1.attacks) {
  const judged = await sys1.judge(
    KEEP_SPEC,
    `Deliverable:\n${deliverableExcerpt}\n\nAttack (${persona}): ${JSON.stringify(attack)}\n\n` +
      `Already kept: ${JSON.stringify(kept.map((k) => k.attack.attack))}`
  );
  const label = judged?.ok ? judged.answers?.[judged.provider]?.keep?.label : null;
  if (label === "keep") kept.push({ persona, attack, keepReason: `judged by ${judged.provider} (${judged.source ?? "sys1-raw"})` });
  else report({ attack: attack.attack, status: "dropped", note: label === "drop" ? "judged drop" : `judge unavailable: ${String(judged?.reason ?? "unknown").slice(0, 100)}` });
}

const confirmed: { persona: string; attack: Attack; evidence: string }[] = [];
for (const k of kept) {
  const judged = await sys1.judge(
    CONFIRM_SPEC,
    `Deliverable:\n${deliverableExcerpt}\n\nThe attack (${k.persona}): ${JSON.stringify(k.attack)}`
  );
  const label = judged?.ok ? judged.answers?.[judged.provider]?.confirmed?.label : null;
  if (label === "confirmed") confirmed.push({ persona: k.persona, attack: k.attack, evidence: `confirmed by ${judged.provider} (${judged.source ?? "sys1-raw"})` });
  else report({ attack: k.attack.attack, status: "not-confirmed", note: label === "not-confirmed" ? "judged not-confirmed" : `judge unavailable: ${String(judged?.reason ?? "unknown").slice(0, 100)}` });
}
log(`${kept.length} kept, ${confirmed.length} confirmed`);

phase("Fix the confirmed attacks");
if (confirmed.length > 0) {
  const fixer = agent("Fixer", {
    system:
      "You fix confirmed attacks on a deliverable: address each confirmed attack in the document " +
      "itself — tighten the claim, add the mitigation, or scope the caveat. Write back to the same " +
      "path. " + ESCALATE,
  });
  await fixer.ask(
    `Deliverable: ${deliverable}\nConfirmed attacks:\n${JSON.stringify(confirmed)}\n\n` +
      `Fix each in the deliverable.`
  );
}

phase("Re-attack the fixed deliverable");
const round2 = await attackRound("R2");
const residuals: Residual[] = [];
if (round2.attacks.length > 0) {
  for (const { persona, attack } of round2.attacks) {
    const judged2 = await sys1.judge(
      KEEP_SPEC,
      `Deliverable (after fixes): ${deliverable}\nAttack (${persona}): ${JSON.stringify(attack)}\n\n` +
        `Already kept in round one: ${JSON.stringify(kept.map((k) => k.attack.attack))}`
    );
    const label2 = judged2?.ok ? judged2.answers?.[judged2.provider]?.keep?.label : null;
    if (label2 === "keep") residuals.push({ attack: attack.attack, evidence: attack.evidence });
  }
}

const md = [
  `# Red-team report: ${deliverable}`,
  "",
  `R1: ${round1.attacks.length} attacks, ${kept.length} kept, ${confirmed.length} confirmed and fixed.` +
    (round1.degraded ? ` **Only ${round1.survivors} challenger(s) survived — under-covered.**` : ""),
  `R2 (after fixes): ${round2.attacks.length} attacks, ${residuals.length} residuals.`,
  "",
  ...confirmed.map((c) => `- **fixed** (${c.persona}) ${c.attack.attack}\n  - evidence: ${c.evidence}`),
  ...residuals.map((r) => `- **residual** ${r.attack}\n  - evidence: ${r.evidence}`),
].join("\n");
await artifact.markdown("deliverable", md, { title: "Red-team report", primary: true });

return {
  conclusion: `red-team: ${round1.attacks.length} attacks, ${confirmed.length} confirmed and fixed, ${residuals.length} residuals after the re-attack.` +
    (round1.degraded ? ` Under-covered: only ${round1.survivors} challenger(s) survived.` : ""),
  stats: { attacks: round1.attacks.length, kept: kept.length, confirmed: confirmed.length, residuals: residuals.length, survivors: round1.survivors },
  verified: [
    "every kept attack was confirmed by someone who did not produce it",
    "the fixed deliverable was re-attacked before the loop closed",
    ...(round1.degraded ? ["the below-two-survivor settlement was reported, not hidden"] : []),
  ],
  notCovered: ["residual attacks are reported, not fixed again — one fix round per run"],
};
