/**
 * The harnessed agent control plane's assembly module.
 *
 * An agent in a workflow run gets no harness: no CLAUDE.md, no shell history,
 * no installed-tooling knowledge, no notion of what it owns. Everything a real
 * harness would have handed it is assembled here, from measured facts and
 * declared contracts:
 *
 *   - measureEnvironment() probes the workspace through the run's own command
 *     allowlist — versions are measured at dispatch time, never assumed;
 *   - renderBrief() renders the run-level harness block (environment, pinned
 *     stack, layout, verification recipe, completeness clause);
 *   - renderContract() renders the per-part contract (owned files, isolation
 *     rule, acceptance criteria, exposed interface) — the block the engine
 *     appends to every ask an agent with a contract makes.
 *
 * Both consumers route through this module: the engine's
 * `agent(name, { system, contract })` and every workflow's brief blocks. A
 * brief assembled anywhere else is the duplication this module exists to end.
 */

/** Probes the plane runs to measure the workspace. Allowlisted argv, like every command a run makes. */
const DEFAULT_ENV_PROBES = [
  ["node", ["--version"]],
  ["python3", ["--version"]],
  ["git", ["--version"]],
  ["npm", ["--version"]],
];

export { DEFAULT_ENV_PROBES };

/**
 * Measure the workspace's runtime facts. `run` is the caller's own effect
 * primitive (world.run: fixed argv, allowlisted) so the measurement is as
 * auditable as every other command the run makes. A probe that fails is
 * recorded as "(unavailable)", never assumed: a brief that guesses a version
 * is worse than one that admits the gap.
 */
export async function measureEnvironment(run, opts = {}) {
  const probes = opts.probes ?? DEFAULT_ENV_PROBES;
  const facts = [];
  const toolchain = {};
  for (const [cmd, args] of probes) {
    let line = null;
    try {
      const r = await run(cmd, args);
      const out = String(r?.stdout ?? "").trim().split("\n")[0];
      if (out) line = out;
    } catch {
      /* the allowlist refused it, the binary is absent, or it timed out — the gap is the fact */
    }
    toolchain[cmd] = line;
    facts.push(`- ${cmd}: ${line ?? "(unavailable)"}`);
  }
  return { facts, toolchain };
}

/**
 * The per-part contract block: what this part owns, what bounds it, what it
 * must expose. The isolation rule states the unbounded paths as an explicit
 * fact, because "you own exactly these files" only binds when it also says
 * what happens to every other path — the cross-part clobber class.
 */
export function renderContract(contract = {}) {
  const lines = [];
  const files = (contract.files ?? []).map((f) => String(f).trim()).filter(Boolean);
  if (files.length) lines.push(`Files you own, exclusively (create or modify exactly these): ${files.join(", ")}`);
  lines.push(
    "You own nothing else. Other parts build in parallel elsewhere and their files are out of bounds — " +
      "never read, write, wait for, or test another part's files."
  );
  const acceptance = (contract.acceptance ?? []).map((a) => String(a).trim()).filter(Boolean);
  lines.push(
    acceptance.length
      ? `Acceptance criteria: ${acceptance.join(" | ")}`
      : "Acceptance criteria: as stated in your part's instruction."
  );
  if (contract.provides) {
    lines.push(`Interface you expose (the exact paths and exported names/signatures): ${String(contract.provides)}`);
  }
  if (contract.verification) lines.push(`Verification: ${String(contract.verification)}`);
  if (contract.extra) lines.push(String(contract.extra));
  return lines.join("\n");
}

/**
 * The run-level harness block, rendered once per dispatch context. `facts`
 * comes from measureEnvironment; `stack` is the run's pinned stack; `ns` is the
 * namespace the briefed agent's files live under; `verification` is the recipe
 * that keeps a part from validating itself against parts it does not own. The
 * completeness clause is load-bearing: it converts a missing fact into an
 * escalation before the build, instead of a burned tool round discovering it.
 *
 * A contract (or its ownership/acceptance/provides fields) is inlined at the
 * end when present, so a single render produces a complete builder brief.
 */
export function renderBrief({ stack, ns, ownership, acceptance, provides, verification, facts, extra, contract } = {}) {
  const lines = ["ENVIRONMENT (measured in this workspace at dispatch time — not assumed):"];
  lines.push(...(facts ?? []));
  if (stack) lines.push(`- pinned stack for every part of this competition: ${stack}`);
  if (ns) lines.push(`- workspace layout: your part's files live under ${ns} and nowhere else`);
  if (verification) lines.push(`- verification recipe: ${verification}`);
  lines.push("- no network installs: the stack text's dependency policy is binding");
  lines.push(
    "YOUR BRIEF IS COMPLETE: everything you need is in this message. If a fact you need is missing, escalate BEFORE building."
  );
  const c = contract ?? { files: ownership, acceptance, provides, extra };
  const hasFiles = (c.files ?? []).length > 0;
  const hasAcceptance = (c.acceptance ?? []).length > 0;
  if (hasFiles || hasAcceptance || c.provides || c.extra) {
    lines.push("", renderContract(c));
  }
  return lines.join("\n");
}
