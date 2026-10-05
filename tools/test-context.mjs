#!/usr/bin/env node
/**
 * Context policy, offline: budgets, accounting, and the compaction that keeps a
 * brief alive.
 *
 * This module is where a run decides what it may spend and what happens when it
 * has spent it. The budget resolution and the accounting are pure, so they run
 * against plain objects. The compaction needs a provider, so `globalThis.fetch`
 * is replaced — the same trick the transport test uses, because the compaction's
 * one ask goes through the transport and the transport calls the global fetch.
 *
 * Two invariants of the ask loop reach across into compaction, and the plan
 * names both because the split is only safe if they still hold after the move:
 * the brief's index is captured when the loop opens, and compaction runs before
 * the round check. This file asserts the first one directly — a history whose
 * last user message is a re-ask nudge, not the brief — and the second one is
 * visible in where `ensureRoom` is called, which the engine still owns.
 *
 *   node tools/test-context.mjs
 */
import assert from "node:assert/strict";
import path from "node:path";

const engineDir = path.resolve(import.meta.dirname, "..");
const {
  resolveBudget,
  measureMessages,
  recordUsage,
  recordEstimatedUsage,
  ensureRoom,
  fmtTokens,
  AGENT_MAX_ROUNDS,
} = await import(path.join(engineDir, "lib", "workflow", "context.mjs"));

let n = 0;
function pass(what) {
  n += 1;
  console.log(`  ${what}`);
}

/** A run-shaped ctx: the seven fields the budget, accounting and compaction read. */
function ctx(state = {}, opts = {}) {
  const events = [];
  return {
    value: {
      baseUrl: "https://router.invalid",
      token: "test-token",
      model: "test-model",
      // The run's own counters, which the accounting folds into beside the
      // ask's stats — both, because the summary reports the run's totals and the
      // journal line reports the ask's.
      state: { providerToolsOk: true, promptTokens: 0, completionTokens: 0, estimatedCalls: 0, compactions: 0, ...state },
      opts,
      emit: (e) => events.push(e),
    },
    events,
  };
}

function stats() {
  return { promptTokens: 0, completionTokens: 0, peakPromptTokens: 0, compactions: 0 };
}

/** An SSE response the transport reads as one completion. */
function sseResponse(content, usage) {
  const chunks = [`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`];
  if (usage) chunks.push(`data: ${JSON.stringify({ usage })}\n\n`);
  return {
    status: 200,
    ok: true,
    headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "text/event-stream" : null) },
    body: (async function* () {
      for (const c of chunks) yield new TextEncoder().encode(c);
    })(),
    json: async () => ({}),
    text: async () => "",
    clone: () => ({ text: async () => "" }),
  };
}

/** Capture every request the plane makes, and answer it the way `respond` says. */
function withFetch(respond) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    return respond(calls.length);
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// ── 1. the build shape's line ──────────────────────────────────────────────
{
  assert.equal(AGENT_MAX_ROUNDS, 24, "the build shape's default rounds is the loop's cap");
  const b = resolveBudget({ shape: "build" }, {});
  assert.deepEqual(b, { shape: "build", rounds: 24, tokens: 2000000, atCap: "throw" });
  assert.deepEqual(resolveBudget({}, {}), b, "an unshaped persona is the build shape");

  // A caller can tighten either axis for one ask, and the other axis stays put.
  assert.deepEqual(resolveBudget({ budget: { rounds: 5 } }, {}), {
    shape: "build", rounds: 5, tokens: 2000000, atCap: "throw",
  });
  assert.deepEqual(resolveBudget({ budget: { tokens: 5000 } }, {}), {
    shape: "build", rounds: 24, tokens: 5000, atCap: "throw",
  });
  // A budget that says nothing is not a budget: zero and nonsense tighten nothing.
  assert.deepEqual(resolveBudget({ budget: { rounds: 0, tokens: -3 } }, {}), b);
  assert.deepEqual(resolveBudget({ budget: { rounds: "many" } }, {}), b);
  pass("a build ask draws its line from its shape, and a caller may tighten either axis");
}

// ── 2. the verify and loop shapes draw their own line ───────────────────────
{
  const v = resolveBudget({ shape: "verify" }, {});
  assert.deepEqual(v, { shape: "verify", rounds: 12, tokens: 120000, atCap: "stuck" });
  assert.deepEqual(resolveBudget({ shape: "loop" }, {}), { shape: "loop", ...v, shape: "loop" });
  // `atCap` is the shape's, not the caller's: a verification that runs out says
  // it is stuck rather than throwing, because staggering is the point of the
  // smaller line.
  assert.equal(v.atCap, "stuck");
  assert.deepEqual(resolveBudget({ shape: "verify", budget: { rounds: 3, tokens: 5 } }, {}), {
    shape: "verify", rounds: 3, tokens: 5, atCap: "stuck",
  });
  assert.equal(resolveBudget({ shape: "verify", budget: { tokens: 0 } }, {}).tokens, 120000, "zero tightens nothing");
  pass("verify and loop draw one smaller line on both axes, and end in stuck rather than a throw");
}

// ── 3. the run's --max-rounds moves the build line, not the others ──────────
{
  assert.deepEqual(resolveBudget({}, { agentMaxRounds: 7 }), {
    shape: "build", rounds: 7, tokens: 2000000, atCap: "throw",
  });
  assert.equal(resolveBudget({}, { agentMaxRounds: 0 }).rounds, 24, "a zero does not cap the loop at nothing");
  assert.equal(resolveBudget({}, { agentMaxRounds: "7" }).rounds, 7, "a string is coerced, not rejected");
  assert.equal(resolveBudget({ shape: "verify" }, { agentMaxRounds: 7 }).rounds, 12, "the flag is the build shape's");
  pass("--max-rounds tightens the build shape and leaves the verification line alone");
}

// ── 4. the plane's own measure of a prompt ─────────────────────────────────
{
  assert.equal(measureMessages([]), 0, "an empty history costs nothing");
  assert.equal(measureMessages([{ role: "user", content: "abcd" }]), 5, "4 for the framing, 1 for four chars");
  assert.equal(measureMessages([{ role: "user", content: "x".repeat(400) }]), 104, "four chars a token");
  const withCalls = measureMessages([
    { role: "assistant", content: "", tool_calls: [{ function: { arguments: "x".repeat(40) } }] },
  ]);
  assert.equal(withCalls, 4 + 10 + 4, "4 framing, 4 for the call itself, and its arguments");
  assert.equal(measureMessages([{ role: "user", content: null }]), 4, "a non-string body costs the framing alone");
  pass("measureMessages counts framing plus bodies, tool arguments included");
}

// ── 5. the upstream's accounting, folded in ────────────────────────────────
{
  const { value: c } = ctx();
  const s = stats();
  assert.equal(recordUsage(c, s, { prompt_tokens: 100, completion_tokens: 20 }), true);
  assert.deepEqual([s.promptTokens, s.completionTokens, s.peakPromptTokens], [100, 20, 100]);
  assert.deepEqual([c.state.promptTokens, c.state.completionTokens], [100, 20]);
  recordUsage(c, s, { prompt_tokens: 40, completion_tokens: 5 });
  assert.deepEqual([s.promptTokens, s.completionTokens, s.peakPromptTokens], [140, 25, 100], "peak is the largest single prompt");
  for (const bad of [null, {}, { prompt_tokens: -1, completion_tokens: 2 }, { prompt_tokens: "x", completion_tokens: 1 }]) {
    assert.equal(recordUsage(c, s, bad), false, `${JSON.stringify(bad)} is not a report`);
  }
  assert.deepEqual([s.promptTokens, s.completionTokens, s.peakPromptTokens], [140, 25, 100], "a non-report changes nothing");
  pass("recordUsage folds the upstream's report in and refuses to fold in a non-report");
}

// ── 6. the measured fallback, and what it costs ────────────────────────────
{
  const { value: c } = ctx();
  const s = stats();
  recordEstimatedUsage(c, s, 500, { content: "hello" });
  assert.equal(s.promptTokens, 500, "the prompt is what went out, measured as it went");
  assert.equal(s.completionTokens, 2, "the completion is the answer's four-chars-a-token cost");
  assert.equal(c.state.estimatedCalls, 1, "and the run says this call was measured, not reported");
  recordEstimatedUsage(c, s, 100, { content: "", tool_calls: [{ function: { arguments: "x".repeat(40) } }] });
  assert.equal(s.completionTokens, 2 + 10, "tool arguments count, and only what the model actually produced");
  assert.equal(s.peakPromptTokens, 500);
  pass("recordEstimatedUsage measures the call a provider left unmeasured");
}

// ── 7. the formatter that stayed on the engine's surface ───────────────────
{
  assert.equal(fmtTokens(0), "0");
  assert.equal(fmtTokens(7), "7");
  assert.equal(fmtTokens(8123), "8.1k");
  assert.equal(fmtTokens(12400), "12k");
  assert.equal(fmtTokens(1_240_000), "1.2M");
  assert.equal(fmtTokens(-5), "0");
  assert.equal(fmtTokens("nonsense"), "0");
  assert.equal(fmtTokens(120000), "120k", "the compaction line reads as a token number");
  pass("fmtTokens says a token count the way a journal line reads it");
}

// ── 8. below the line, nothing is compacted and no ask is made ─────────────
{
  const { value: c } = ctx({}, { compactTokens: 100000 });
  const stub = withFetch(() => {
    throw new Error("the plane asked a provider for a summary it did not need");
  });
  const messages = [
    { role: "system", content: "persona" },
    { role: "user", content: "a small brief" },
    { role: "assistant", content: "a small answer" },
  ];
  await ensureRoom(c, messages, "ask-1", stats(), { briefIdx: 1 });
  stub.restore();
  assert.equal(messages.length, 3, "the history is untouched");
  pass("an ask under the line is left alone, with no summarizer call at all");
}

// ── 9. compaction with a healthy summarizer keeps the brief by index ───────
{
  const { value: c, events } = ctx({}, { compactTokens: 100 });
  const s = stats();
  const messages = [
    { role: "system", content: "THE SYSTEM PERSONA" },
    { role: "user", content: "THE BRIEF, with the contract and the run's facts" },
    { role: "assistant", content: "read a file, wrote a file" },
    { role: "assistant", content: "more work" },
    { role: "user", content: "A RE-ASK NUDGE the loop appended later" },
  ];
  // The brief's index, taken when the loop opened: the last message then, before
  // the loop's own nudge could append a later user message. This is the whole
  // point of the index — a nudge is not the brief and must not be kept as one.
  const acct = { briefIdx: 1, lastPrompt: 9999 };

  const stub = withFetch(() => sseResponse("summary of what came before", { prompt_tokens: 30, completion_tokens: 8 }));
  await ensureRoom(c, messages, "ask-1", s, acct);
  stub.restore();

  assert.equal(stub.calls.length, 1, "exactly one ask, for the summary alone");
  assert.equal(stub.calls[0].body.temperature, 0, "a compaction is bookkeeping: the same history compacts the same way twice");
  assert.equal(stub.calls[0].body.tools, undefined, "and the summarizer gets no tools");
  assert.equal(stub.calls[0].body.model, "test-model");

  const kept = messages.map((m) => m.content);
  assert.equal(kept[0], "THE SYSTEM PERSONA", "the system message survives verbatim");
  assert.ok(kept.includes("THE BRIEF, with the contract and the run's facts"), "the brief survives verbatim");
  assert.ok(!kept.some((t) => t.includes("RE-ASK NUDGE")), "the nudge is not the brief, and is summarized away");
  assert.ok(!kept.some((t) => t.includes("read a file")), "and the rounds are summarized away");
  assert.ok(kept.some((t) => t.includes("summary of what came before")), "the summary replaced them");
  assert.ok(kept.some((t) => t.startsWith("The plane compacted this ask's history")), "with a marker saying so");

  // The compaction's own call is metered like any other.
  const ev = events.find((e) => e.kind === "compact");
  assert.equal(ev.before, 9999, "the trigger is the larger of what the upstream reported and what the plane measures");
  assert.deepEqual([s.promptTokens, s.completionTokens, s.peakPromptTokens], [30, 8, 30]);
  assert.equal(c.state.promptTokens, 30, "and it lands on the run's totals");
  assert.equal(s.compactions, 1);
  assert.equal(c.state.compactions, 1, "an ask's compactions says how often the plane reshaped its history");

  assert.equal(ev.mode, "summarize");
  assert.equal(ev.actor, "ask-1");
  assert.equal(ev.limit, 100);
  assert.equal(ev.summarized, 3, "three messages were summarized away");
  assert.equal(ev.kept, 2, "two were kept");
  assert.equal(ev.summary, "summary of what came before");
  assert.ok(ev.after < ev.before, "the history shrank");
  assert.ok(ev.ms >= 0);
  pass("a compaction keeps the system and the brief by index, summarizes the rest, and meters its own ask");
}

// ── 10. a summarizer that fails is a truncation, not a new failure ─────────
{
  const { value: c, events } = ctx({}, { compactTokens: 50 });
  const s = stats();
  const many = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i}` }));
  const messages = [{ role: "system", content: "persona" }, { role: "user", content: "THE BRIEF" }, ...many];
  const acct = { briefIdx: 1, lastPrompt: 900 };

  // HTTP 400: the transport throws immediately, which is the path a summarizer
  // that the upstream refused takes.
  const stub = withFetch(() => ({
    status: 400,
    ok: false,
    headers: { get: () => "text/plain" },
    body: null,
    json: async () => ({}),
    text: async () => "bad request",
    clone: () => ({ text: async () => "bad request" }),
  }));
  await ensureRoom(c, messages, "ask-2", s, acct);
  stub.restore();

  const kept = messages.map((m) => m.content);
  assert.equal(kept[0], "persona", "the system message survives a failed summarizer too");
  assert.ok(kept.includes("THE BRIEF"), "and so does the brief");
  assert.equal(events.find((e) => e.kind === "compact").mode, "truncate");
  assert.equal(s.compactions, 1, "a failed summary still compacted: the plane reshaped the history either way");
  const survived = kept.filter((t) => /^turn \d$/.test(t));
  assert.equal(survived.length, 4, "the newest four turns survive, because the round in flight was about to use them");
  assert.ok(kept.some((t) => t.includes("could not be summarized")), "and the marker says why the rest went");
  assert.equal(c.state.estimatedCalls, 0, "a summarizer that failed metered nothing: the plane does not bill a rescue that never happened");
  assert.equal(c.state.completionTokens, 0, "nothing came back, so nothing was spent");
  pass("a summarizer the upstream refused truncates the history instead of failing the ask");
}

// ── 11. a history that is only the plane's own poles must not be dropped ────
{
  const { value: c, events } = ctx({}, { compactTokens: 1 });
  const messages = [
    { role: "system", content: "persona" },
    { role: "user", content: "a brief that is already over the line" },
  ];
  // `measureMessages` here is over the line, but there is nothing to summarize:
  // every message is one the plane owns. The compactor must say nothing and let
  // the ask fail at the provider for the honest reason.
  const before = messages.map((m) => m.content);
  const stub = withFetch(() => {
    throw new Error("a compaction with nothing to summarize asked for a summary anyway");
  });
  await ensureRoom(c, messages, "ask-3", stats(), { briefIdx: 1 });
  stub.restore();
  assert.deepEqual(messages.map((m) => m.content), before, "the history is untouched");
  assert.equal(events.filter((e) => e.kind === "compact").length, 0, "and no compaction was journalled");
  pass("a history with nothing but the plane's own poles is left alone");
}

console.log(`test-context: ${n} cases pass offline — budgets, accounting, compaction, the brief index`);
