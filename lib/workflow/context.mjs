/**
 * What a run may spend, and what happens when it has spent it.
 *
 * Three policies live here and nowhere else: the cap an ask runs under (rounds on
 * one axis, prompt tokens on the other, resolved once per agent from its shape),
 * the accounting that measures what an ask actually cost — the upstream's own
 * usage when it reports it, the plane's four-chars-a-token measure when it does
 * not — and the compaction that reshapes an agent's history once it has grown
 * past the line rather than letting the ask die at a provider's window.
 *
 * The compaction is the piece worth reading carefully, because two invariants of
 * the ask loop reach across into it and both survive the move only because the
 * bodies are unchanged. The brief's index is captured when the loop opens, so
 * compaction keeps exactly the plane-owned message instead of guessing at it
 * later; and compaction runs before the round check, so a model is never handed
 * a prompt the plane could have shrunk. The loop keeps the messages array and
 * keeps pushing into it, and compaction mutates it in place.
 */
import { chatCompletion } from "./transport.mjs";

// The estimated prompt size at which the plane compacts an agent's context
// rather than letting the ask run into a provider's window. Rounds measure how
// stubborn an agent is; tokens measure what its history costs, and the wall is
// a number, not a count. Overridable per run (--compact-tokens) because a
// provider with a 32k window needs a tighter line than one with 200k.
const CONTEXT_COMPACT_TOKENS = 120000;

export const AGENT_MAX_ROUNDS = 24; // tool-call rounds per ask before the loop gives up

// ── cap policy by ask shape ─────────────────────────────────────────────────
// A build ask is where the work happens: it keeps the run's `--max-rounds` and
// the run's token ceiling. A verification or loop-shaped ask draws a verdict
// from evidence it is handed, so trouble shows in the first few rounds rather
// than the twentieth — it draws a distinct, smaller line on both axes, and at
// that line the plane escalates "stuck" and ends the ask, rather than handing
// the caller a reason to decompose a verification into parts. The two names
// carry one line: what a verification and a repair loop have in common is that
// failing is visible early, so waiting longer costs tokens and changes nothing.
// `--max-rounds` does not apply here — it is the build shape's flag, and a
// caller that needs a different line for one ask tightens it at the ask.
const AGENT_VERIFY_ROUNDS = 12;
// The token ceilings sit above the round cap's natural spend so they are
// ceilings rather than the thing every long ask trips: a build ask that burns
// its 24 rounds with an ordinary brief spends under a million prompt tokens
// (every round resends the history, so the sum grows quadratically), and 2M
// catches the spend a raised --max-rounds would otherwise let through. The
// verification line is one window: a verdict that has already spent a full
// context's worth of prompts is re-reading its own evidence.
const AGENT_TOKEN_BUDGET = 2000000;
const AGENT_VERIFY_TOKEN_BUDGET = 120000;
const SHAPE_BUDGETS = {
  verify: { rounds: AGENT_VERIFY_ROUNDS, tokens: AGENT_VERIFY_TOKEN_BUDGET, atCap: "stuck" },
  loop: { rounds: AGENT_VERIFY_ROUNDS, tokens: AGENT_VERIFY_TOKEN_BUDGET, atCap: "stuck" },
};
/**
 * The cap an agent's asks run under: its shape's line, tightened by a budget
 * the caller declared for that agent. `rounds` is a number, `tokens` a
 * prompt-token ceiling across an ask's whole life (a sum, because every round
 * resends the history), and `atCap` says what the plane does when one is
 * reached. Resolved once per agent — the shape belongs to the agent, and a
 * workflow that needs both lines declares two agents.
 */
export function resolveBudget(persona, opts) {
  const shape = String(persona?.shape ?? "build");
  const tight = persona?.budget ?? {};
  const tighten = (n) => (Number(n) > 0 ? Number(n) : 0);
  const policy = SHAPE_BUDGETS[shape] ?? null;
  if (policy) {
    return {
      shape,
      rounds: tighten(tight.rounds) || policy.rounds,
      tokens: tighten(tight.tokens) || policy.tokens,
      atCap: policy.atCap,
    };
  }
  const runRounds = Number(opts?.agentMaxRounds) > 0 ? Number(opts.agentMaxRounds) : AGENT_MAX_ROUNDS;
  return {
    shape,
    rounds: tighten(tight.rounds) || runRounds,
    tokens: tighten(tight.tokens) || AGENT_TOKEN_BUDGET,
    atCap: "throw",
  };
}

// The compactor's system prompt. Deterministic on purpose: the same history
// must compact to the same summary twice, so this is a bookkeeping instruction
// rather than a creative one.
const COMPACT_SYSTEM =
  "You compact an agent's working history so its task can continue in a smaller context. " +
  "Summarize what the agent did and learned: the files it read or wrote and their state, the " +
  "decisions it made and why, the errors it hit and how it resolved them, and any measurements " +
  "it reported. Keep concrete names, paths and numbers. Drop apologies, narration and repeated " +
  "file dumps. Reply with the summary only — no preamble, no questions.";

/**
 * The upstream's own accounting, folded into the agent's stats and the run's.
 * Summed across rounds, because every round resends the whole history — the
 * spend is the sum, not the last call. `peak` is the largest single prompt,
 * which is the number that runs into a provider's window.
 */
export function recordUsage(ctx, stats, usage) {
  const prompt = Number(usage?.prompt_tokens);
  const completion = Number(usage?.completion_tokens);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion) || prompt < 0 || completion < 0) return false;
  stats.promptTokens += prompt;
  stats.completionTokens += completion;
  stats.peakPromptTokens = Math.max(stats.peakPromptTokens, prompt);
  ctx.state.promptTokens += prompt;
  ctx.state.completionTokens += completion;
  return true;
}

/** 8123 → "8.1k", 1_240_000 → "1.2M". Journal lines and the run summary name a
 * cost a human can read at a glance. */
export function fmtTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return "0";
  if (v < 1000) return String(Math.round(v));
  if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}k`;
  return `${(v / 1_000_000).toFixed(1)}M`;
}

/** Rough token count of text. The standard four-characters rule, and only ever
 * used where the upstream reported nothing — a labelled estimate, not a fact. */
function estimateTokens(text) {
  return Math.ceil(String(text ?? "").length / 4);
}

/** The plane's own measure of a prompt: the message bodies plus what the chat
 * template's framing adds per message. Used as the compaction trigger when the
 * upstream has not yet reported a prompt size, and as the fallback count when
 * it never will. */
export function measureMessages(messages) {
  let n = 0;
  for (const m of messages) {
    n += 4;
    if (typeof m.content === "string") n += estimateTokens(m.content);
    for (const c of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
      n += estimateTokens(c.function?.arguments ?? "") + 4;
    }
  }
  return n;
}

/**
 * Token count of what one call sent, measured by the plane: the prompt as it
 * went out and the completion as it came back. The fallback for a provider that
 * reports no usage — the ask's accounting line still says what it cost, and
 * says that the number is measured rather than reported.
 */
export function recordEstimatedUsage(ctx, stats, sent, message) {
  const completion =
    estimateTokens(typeof message?.content === "string" ? message.content : "") +
    (Array.isArray(message?.tool_calls) ? message.tool_calls.reduce((n, c) => n + estimateTokens(c.function?.arguments ?? ""), 0) : 0);
  stats.promptTokens += sent;
  stats.completionTokens += completion;
  stats.peakPromptTokens = Math.max(stats.peakPromptTokens, sent);
  ctx.state.promptTokens += sent;
  ctx.state.completionTokens += completion;
  ctx.state.estimatedCalls++;
}

/**
 * Compact an agent's history when it has grown past the line. What survives is
 * decided by rule, not by the summary: the system message (the plane's persona)
 * and the last user message (the brief the plane wrote — instructions, the
 * rendered contract and the run's measured facts) are kept verbatim, because
 * they are the plane-owned part of the history and the agent has no way to
 * rebuild them. Everything else — earlier asks, their tool rounds, and the
 * rounds of the ask in flight — is replaced by one summary.
 *
 * The summary comes from exactly one ask: temperature 0, no tools, no schema,
 * so the same history compacts the same way twice. Its own input is capped,
 * because a history too large to summarize is a history the summarizer would
 * itself choke on; the oldest turns go first, since the ask in flight lives at
 * the end. If the ask fails, the history is truncated with a marker instead of
 * the ask dying — a rescue must not become a new failure mode.
 */
async function compactContext(ctx, messages, label, stats, size, limit, acct) {
  const system = messages[0]?.role === "system" ? messages[0] : null;
  // The brief is the message the ask was dispatched with. Its index was taken
  // when the loop opened — the last message then, before any round or any
  // re-ask nudge could append a later user message of the loop's own making,
  // because a nudge is not the brief and must not be mistaken for one.
  const briefIdx = Number.isInteger(acct?.briefIdx) && acct.briefIdx >= 0 ? acct.briefIdx : lastUserIndex(messages);
  const brief = briefIdx >= 0 ? messages[briefIdx] : null;
  const kept = [system, brief].filter(Boolean);
  const summarized = messages.filter((m) => m !== system && m !== brief);
  // Nothing the plane may drop: the history is only the plane's own poles. The
  // ask will fail at the provider for the honest reason — its brief alone is
  // over the window — and compaction has nothing to say about that.
  if (!summarized.length) return;

  const started = Date.now();
  const { text: history, dropped } = renderHistory(summarized);
  const summarizerMessages = [
    { role: "system", content: COMPACT_SYSTEM },
    { role: "user", content: history },
  ];
  const summarizerSent = measureMessages(summarizerMessages);
  let summary = null;
  try {
    const data = await chatCompletion(ctx, summarizerMessages, [], null, label, 0);
    // The compaction's own call is metered like any other: a compacted ask's
    // `account` line includes the summary it needed, and a provider that reports
    // nothing gets the same measured fallback the agent's rounds get.
    if (!recordUsage(ctx, stats, data.usage)) {
      recordEstimatedUsage(ctx, stats, summarizerSent, data?.choices?.[0]?.message);
    }
    const text = String(data?.choices?.[0]?.message?.content ?? "").trim();
    if (text) summary = text;
  } catch {
    summary = null;
  }

  const marker = {
    role: "user",
    content:
      `The plane compacted this ask's history: it had grown to about ${fmtTokens(size)} tokens, past the ` +
      `${fmtTokens(limit)}-token line, so one deterministic ask summarized it. Your original brief and ` +
      `contract above are unchanged — the facts you were measured and the boundary you were given are ` +
      `exactly as dispatched.\n\n` +
      (summary
        ? `What came before, summarized:\n\n${summary}`
        : `What came before could not be summarized (the summarizing ask failed), so only the newest turns ` +
          `below survive it. Treat everything older as gone.`),
  };
  // Counted here rather than where the summary succeeded: the history is about
  // to be replaced either way, and a compaction whose summarizer failed still
  // compacted — an agent's `compactions` says how often the plane reshaped its
  // history, not how often the summarizer was healthy.
  stats.compactions++;
  ctx.state.compactions++;
  // A truncated compaction keeps the newest turns rather than nothing: the tool
  // round in flight is the one the agent was about to use.
  const rebuilt = [...kept, marker];
  if (!summary) {
    const tail = summarized.slice(-4);
    rebuilt.push(...tail);
  }
  messages.length = 0;
  messages.push(...rebuilt);

  ctx.emit({
    kind: "compact",
    actor: label,
    mode: summary ? "summarize" : "truncate",
    before: size,
    after: measureMessages(messages),
    limit,
    summarized: summarized.length,
    kept: kept.length,
    dropped,
    // What the summary said, in preview. The sizes say the history shrank; this
    // says what carried across, which is the only way to tell afterwards whether
    // a compaction cost the agent something it needed.
    summary: summary ? summary.slice(0, 400) : null,
    ms: Date.now() - started,
  });
}

function emit_compact(ctx, event) {
  ctx.emit(event);
}

/**
 * Render a history for the summarizer, newest-preserving: the cap is on the
 * text, and the trim takes the oldest messages first. `dropped` is journalled,
 * so a summary that was made from a partial history says so.
 */
function renderHistory(messages) {
  const CAP = 60000;
  const lines = [];
  for (const m of messages) {
    const body = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    const calls = (Array.isArray(m.tool_calls) ? m.tool_calls : [])
      .map((c) => `${c.function?.name ?? "?"}(${String(c.function?.arguments ?? "").slice(0, 400)})`)
      .join(" ");
    lines.push(`[${m.role ?? "?"}] ${body}${calls ? `\n  → calls: ${calls}` : ""}`);
  }
  let dropped = 0;
  while (lines.join("\n\n").length > CAP && lines.length > 1) {
    lines.shift();
    dropped++;
  }
  return {
    text: (dropped ? `[${dropped} earlier messages were dropped as too old to summarize]\n\n` : "") + lines.join("\n\n"),
    dropped,
  };
}

/** Index of the last user message, or -1. The fallback for finding the brief
 * when the ask did not record its index. */
function lastUserIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

/** Compact the history if the prompt has crossed the line. Mutates `messages`
 * in place — the ask loop holds this array and keeps pushing into it. */
export async function ensureRoom(ctx, messages, label, stats, acct) {
  const limit = Number(ctx.opts.compactTokens) > 0 ? Number(ctx.opts.compactTokens) : CONTEXT_COMPACT_TOKENS;
  if (!(limit > 0)) return;
  // The larger of what the upstream last said this prompt cost and what the
  // plane measures now: a provider counts more than four-chars-a-token, so
  // trusting only the estimate would compact late, and trusting only the report
  // would never compact a first round.
  const size = Math.max(Number(acct?.lastPrompt) > 0 ? Number(acct.lastPrompt) : 0, measureMessages(messages));
  if (size < limit) return;
  await compactContext(ctx, messages, label, stats, size, limit, acct);
}
