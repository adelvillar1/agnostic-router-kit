/**
 * The plane's only external protocol: one chat completion over the router.
 *
 * Everything else in the plane talks to itself — agents, tools, budgets,
 * journals. This module is the one place the plane leaves the machine, and it
 * owes three things to the caller: the completion arrives as an OpenAI-shaped
 * assistant message whatever the transport did underneath, a connection that
 * goes quiet is aborted rather than left hanging, and an upstream that refuses
 * the request shape is worked around instead of failing every ask.
 *
 * It takes a context object and returns data. It knows nothing about agents,
 * loops, tools or runs, which is what lets it be exercised against a stubbed
 * fetch with no provider anywhere in the picture.
 */
import { WorkflowRunError } from "./runstate.mjs";

// An idle cap, not a total one: a streamed completion that emits tokens is
// healthy however long the turn runs. Generous because thinking-heavy models
// can sit minutes before the first token.
export const ASK_IDLE_TIMEOUT_MS = 300000;

/**
 * One chat completion through the router, streamed. Falls back to a tools-free
 * call when the upstream refuses tools.
 *
 * The stream is not a presentation choice: with `stream: false` nothing
 * arrives until the whole completion exists, and a long agent turn sits
 * silent for minutes — into the fetch stack's ~5-minute headers timeout,
 * which kills the connection and surfaces as "the router did not answer".
 * Streaming keeps bytes flowing, so the deadline that matters is an IDLE cap:
 * a completion that is emitting tokens is healthy however long it runs; what
 * gets aborted is a connection with nothing arriving for ASK_IDLE_TIMEOUT_MS.
 *
 * `temperature` is a parameter for one reason: the context compactor asks for a
 * summary at 0, because a compaction is bookkeeping rather than a creative act
 * and the same history should compact the same way twice.
 */
export async function chatCompletion(ctx, messages, defs, schema, label, temperature = 0.4) {
  const { baseUrl, token, model, state, emit } = ctx;
  const body = { model, messages, temperature, stream: true };
  const withTools = state.providerToolsOk && defs.length;
  if (withTools) body.tools = defs;
  const started = Date.now();
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ac = new AbortController();
    let idle = setTimeout(() => ac.abort(new Error(`no bytes for ${ASK_IDLE_TIMEOUT_MS}ms`)), ASK_IDLE_TIMEOUT_MS);
    const bump = () => {
      clearTimeout(idle);
      idle = setTimeout(() => ac.abort(new Error(`no bytes for ${ASK_IDLE_TIMEOUT_MS}ms`)), ASK_IDLE_TIMEOUT_MS);
    };
    try {
      const r = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      bump();
      if (r.status === 400 && withTools && /tool|function/i.test(await r.clone().text())) {
        // This upstream will not take tools — degrade the whole run rather
        // than fail every ask on it.
        clearTimeout(idle);
        state.providerToolsOk = false;
        delete body.tools;
        continue;
      }
      if (r.status === 429 || r.status >= 502) {
        clearTimeout(idle);
        lastErr = new Error(`router HTTP ${r.status}`);
        await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
        continue;
      }
      if (!r.ok) {
        clearTimeout(idle);
        throw new WorkflowRunError(`${label}: router HTTP ${r.status} — ${(await r.text()).slice(0, 300)}`);
      }
      const { message, usage } = await consumeStream(r, bump);
      clearTimeout(idle);
      emit({ kind: "agent", actor: label, ms: Date.now() - started, tools: Boolean(withTools) });
      return { choices: [{ message }], usage };
    } catch (e) {
      clearTimeout(idle);
      if (e instanceof WorkflowRunError) throw e;
      lastErr = e;
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    }
  }
  throw new WorkflowRunError(`${label}: the router did not answer — ${String(lastErr?.message ?? lastErr)}`);
}

/**
 * Assemble one OpenAI-shaped assistant message out of an SSE completion:
 * content deltas concatenate, tool_calls assemble by index (id and function
 * name arrive once, arguments stream in fragments).
 */
export async function consumeStream(r, bump) {
  const ctype = r.headers.get("content-type") ?? "";
  if (!ctype.includes("text/event-stream") || !r.body) {
    const d = await r.json().catch(() => null);
    return { message: d?.choices?.[0]?.message ?? { role: "assistant", content: "" }, usage: d?.usage ?? null };
  }
  let content = "";
  let calls = new Map();
  let usage = null;
  let buffer = "";
  let decoder = new TextDecoder();
  for await (const chunk of r.body) {
    bump();
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let j = null;
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      // The upstream reports its own accounting in a final chunk with no
      // choices — the router's ledger meters it, and the run's journal should
      // say the same thing rather than estimate what was measured upstream.
      if (j && typeof j.usage === "object" && j.usage !== null) usage = j.usage;
      const delta = j?.choices?.[0]?.delta ?? {};
      if (typeof delta.content === "string") content += delta.content;
      for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const idx = tc.index ?? 0;
        const cur = calls.get(idx) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
        if (tc.id) cur.id = tc.id;
        if (tc.type) cur.type = tc.type;
        if (tc.function?.name) cur.function.name += tc.function.name;
        if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
        calls.set(idx, cur);
      }
    }
  }
  const message = { role: "assistant", content };
  if (calls.size) message.tool_calls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
  return { message, usage };
}
