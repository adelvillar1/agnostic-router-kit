#!/usr/bin/env node
/**
 * The transport, against a fetch stub and no provider at all.
 *
 * This module is the only place the plane leaves the machine, so it is the one
 * place a live-provider test would be half a test: the interesting behaviour is
 * what happens when the upstream misbehaves — refuses tools, rate-limits, sits
 * silent for five minutes, answers in one JSON blob instead of SSE. Those are
 * exactly the cases a stub makes cheap and a real provider makes slow.
 *
 * `chatCompletion` calls the global `fetch`, so replacing it here replaces the
 * network. Nothing in this file opens a socket; every response below is a plain
 * object shaped enough like a Response for what the transport reads.
 *
 * The idle cap is 300000ms of real time. The transport's only clock is a pair
 * of timers it installs itself, so this file clamps long delays to milliseconds
 * and asserts the abort happens rather than waiting it out.
 *
 *   node tools/test-transport.mjs
 */
import assert from "node:assert/strict";
import path from "node:path";

const engineDir = path.resolve(import.meta.dirname, "..");
const { chatCompletion, ASK_IDLE_TIMEOUT_MS } = await import(
  path.join(engineDir, "lib", "workflow", "transport.mjs")
);
const { WorkflowRunError } = await import(path.join(engineDir, "lib", "workflow", "runstate.mjs"));

// ── the stub plumbing ────────────────────────────────────────────────────────

/** An SSE-chunked body, as the router actually sends one. */
function sseBody(chunks, signal) {
  const bytes = chunks.map((c) => new TextEncoder().encode(typeof c === "string" ? c : c));
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of bytes) {
        if (signal?.aborted) throw signal.reason;
        yield chunk;
      }
      // A stream that ends here is normal; a stream that hangs is the case the
      // idle cap is for, and `hang()` produces one.
    },
  };
}

/** A body that never yields, and stops hanging when the request is aborted. */
function hang(signal) {
  return {
    async *[Symbol.asyncIterator]() {
      await new Promise((_, reject) => {
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      throw signal.reason;
    },
  };
}

/** Enough of a Response for the four things the transport reads off one. */
function stubResponse({ status = 200, body = null, json = null, text = "", ctype = "text/event-stream" }) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? ctype : null) },
    body,
    json: async () => json,
    text: async () => text,
    clone: () => ({ text: async () => text }),
  };
}

/**
 * One SSE frame carrying one delta. Built with JSON.stringify because the
 * fragments below hold `{"a":` as a *value*, and a hand-escaped copy of that
 * inside another JSON literal is exactly how a test ends up asserting against
 * brackets nobody balanced.
 */
function delta(payload) {
  return `data: ${JSON.stringify({ choices: [{ delta: payload }] })}\n\n`;
}

/** A run-shaped ctx: the six fields the transport destructures. */
function ctx(state = {}) {
  const events = [];
  return {
    value: {
      baseUrl: "https://router.invalid",
      token: "test-token",
      model: "test-model",
      state: { providerToolsOk: true, ...state },
      emit: (e) => events.push(e),
    },
    events,
  };
}

/** Replace globalThis.fetch with one that always answers from `responder`. */
async function withFetch(responder, body) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const out = await responder(calls.length, url, init);
    return out;
  };
  try {
    const out = await body();
    return { out, calls };
  } finally {
    globalThis.fetch = real;
  }
}

/** Clamp the transport's timers so a 300s cap and its backoff are observed fast. */
async function withShortTimers(body) {
  const [realSet, realClear] = [globalThis.setTimeout, globalThis.clearTimeout];
  const clamp = (delay) => (Number(delay) > 200 ? 5 : delay);
  globalThis.setTimeout = (fn, delay, ...rest) => realSet(fn, clamp(delay), ...rest);
  globalThis.clearTimeout = realClear;
  try {
    return await body();
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
}

let n = 0;
const caseName = (msg) => `transport: ${msg}`;

// ── 1. a streamed answer assembles from its deltas ───────────────────────────
{
  n += 1;
  const { value: c, events } = ctx();
  const chunks = [delta({ role: "assistant" }), delta({ content: "Hello" }), delta({ content: ", world" }), "data: [DONE]\n\n"];
  const { out } = await withFetch(
    (i, url, init) => {
      const signal = init.signal;
      return stubResponse({ body: sseBody(chunks, signal), calls: [] });
    },
    async () => chatCompletion(c, [], [], null, "ask-1")
  );
  assert.deepEqual(out, {
    choices: [{ message: { role: "assistant", content: "Hello, world" } }],
    usage: null,
  });
  assert.equal(events.length, 1, "the transport should emit one agent event on success");
  assert.equal(events[0].kind, "agent");
  assert.equal(events[0].actor, "ask-1");
  assert.equal(events[0].tools, false, "no tools were declared, so the event says so");
  assert.equal(typeof events[0].ms, "number");
  console.log(`  a streamed answer assembles from content deltas, one agent event`);
}

// ── 2. tool_calls assemble by index, out of order and fragmented ───────────────
{
  n += 1;
  const { value: c } = ctx();
  const toolDefs = [{ type: "function", function: { name: "submit_result", parameters: {} } }];
  const chunks = [
    delta({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "later", arguments: '{"a":' } }] }),
    delta({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "first", arguments: '{"x":' } }] }),
    delta({ tool_calls: [{ index: 1, function: { arguments: "1}" } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: "true}" } }] }),
    delta({}),
    'data: {"usage":{"prompt_tokens":11,"completion_tokens":22,"total_tokens":33}}\n\n',
  ];
  const { out } = await withFetch(
    (i, url, init) => stubResponse({ body: sseBody(chunks, init.signal) }),
    async () => chatCompletion(c, [], toolDefs, null, "ask-tools")
  );
  const { message } = out.choices[0];
  const { usage } = out;
  assert.equal(message.tool_calls.length, 2, "two tool calls were streamed");
  // Sorted by index, so the transport returns them in the order the model meant.
  assert.equal(message.tool_calls[0].id, "call_a");
  assert.equal(message.tool_calls[0].function.name, "first");
  assert.equal(message.tool_calls[0].function.arguments, '{"x":true}', "arguments arrived in fragments and were concatenated");
  assert.equal(message.tool_calls[1].function.name, "later");
  assert.equal(message.tool_calls[1].function.arguments, '{"a":1}');
  assert.deepEqual(usage, { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 }, "usage comes from the upstream's own final chunk");
  console.log(`  tool_calls assemble by index and arguments concatenate across fragments`);
}

// ── 3. a non-streaming answer is read whole ──────────────────────────────────
{
  n += 1;
  const { value: c } = ctx();
  const payload = { choices: [{ message: { role: "assistant", content: "one shot" } }], usage: { total_tokens: 7 } };
  const { out } = await withFetch(
    () => stubResponse({ ctype: "application/json", json: payload }),
    async () => chatCompletion(c, [], [], null, "ask-json")
  );
  assert.deepEqual(out, payload, "an unstreamed completion is returned as it came");
  console.log(`  a non-streaming answer is read whole`);
}

// ── 4. an upstream that refuses tools degrades the run, it does not fail it ────
{
  n += 1;
  const { value: c } = ctx();
  const toolDefs = [{ type: "function", function: { name: "submit_result", parameters: {} } }];
  const { out, calls } = await withFetch(
    (attempt, url, init) => {
      if (attempt === 1) {
        return stubResponse({
          status: 400,
          ctype: "application/json",
          text: '{"error":{"message":"tools are not supported by this model"}}',
        });
      }
      const chunks = [delta({ content: "fine, no tools" }), "data: [DONE]\n\n"];
      return stubResponse({ body: sseBody(chunks, init.signal) });
    },
    async () => chatCompletion(c, [], toolDefs, null, "ask-degrade")
  );
  assert.equal(calls.length, 2, "the refusal was retried once without tools");
  assert.deepEqual(JSON.parse(calls[0].init.body).tools, toolDefs, "the first attempt asked with tools");
  assert.equal("tools" in JSON.parse(calls[1].init.body), false, "the retry asked without them");
  assert.equal(c.state.providerToolsOk, false, "the run remembers the refusal so no later ask repeats it");
  assert.equal(out.choices[0].message.content, "fine, no tools");
  console.log(`  a tools refusal degrades the run once and retries without tools`);
}

// ── 5. a rate-limited upstream is retried, then reported ──────────────────────
{
  n += 1;
  const { value: c } = ctx();
  let fetchCalls = 0;
  await withFetch(
    () => {
      fetchCalls += 1;
      return stubResponse({ status: 429, text: "slow down" });
    },
    async () => {
      await assert.rejects(chatCompletion(c, [], [], null, "ask-throttled"), (e) => {
        assert.ok(e instanceof WorkflowRunError, "the failure is a run error, not a transport error");
        assert.match(e.message, /ask-throttled: the router did not answer/);
        assert.match(e.message, /router HTTP 429/, "the last reason is kept in the message");
        return true;
      });
      return null;
    }
  );
  assert.equal(fetchCalls, 3, "three attempts, then the run fails rather than hanging");
  console.log(`  a throttled upstream is retried three times then fails the run`);
}

// ── 6. a hard error is not retried and its body surfaces ─────────────────────
{
  n += 1;
  const { value: c } = ctx();
  let fetchCalls = 0;
  await withFetch(
    () => {
      fetchCalls += 1;
      return stubResponse({ status: 500, ctype: "text/plain", text: "upstream exploded in a way we cannot retry" });
    },
    async () => {
      await assert.rejects(chatCompletion(c, [], [], null, "ask-500"), (e) => {
        assert.ok(e instanceof WorkflowRunError);
        assert.match(e.message, /ask-500: router HTTP 500/);
        assert.match(e.message, /upstream exploded/, "the upstream's own words are the diagnosis");
        return true;
      });
      return null;
    }
  );
  assert.equal(fetchCalls, 1, "a non-retryable status fails immediately");
  console.log(`  a non-retryable status fails once with the upstream's own words`);
}

// ── 7. the summarizer ask, and a summarizer that never answers ────────────────
{
  n += 1;
  const { value: c } = ctx();
  // The compaction ask's shape: no tools, temperature 0.
  const { out, calls } = await withFetch(
    () => stubResponse({ ctype: "application/json", json: { choices: [{ message: { role: "assistant", content: "summary" } }] } }),
    async () => chatCompletion(c, [], [], null, "summarizer", 0)
  );
  assert.equal(out.choices[0].message.content, "summary");
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.temperature, 0, "the summarizer asks at 0 so the same history compacts the same way twice");
  assert.equal("tools" in sent, false);
  console.log(`  the summarizer's shape is a low-temperature, tools-free ask`);

  // And when it cannot answer, the run fails with the summarizer's label.
  await withFetch(
    () => stubResponse({ status: 502, text: "summarizer upstream down" }),
    async () => {
      await assert.rejects(chatCompletion(c, [], [], null, "summarizer", 0), (e) => {
        assert.ok(e instanceof WorkflowRunError);
        assert.match(e.message, /^summarizer: the router did not answer/);
        return true;
      });
      return null;
    }
  );
  console.log(`  a summarizer that cannot answer fails the run with its own label`);
}

// ── 8. a connection that goes quiet is aborted, not waited on ────────────────
{
  n += 1;
  const { value: c, events } = ctx();
  await withShortTimers(() =>
    withFetch(
      async (i, url, init) => {
        // Never resolves through one chunk, hangs, and drops when aborted.
        return stubResponse({ body: hang(init.signal) });
      },
      async () => {
        await assert.rejects(chatCompletion(c, [], [], null, "ask-quiet"), (e) => {
          assert.ok(e instanceof WorkflowRunError, "the idle abort lands as a run error");
          assert.match(e.message, /the router did not answer/);
          assert.match(e.message, /no bytes for 300000ms/, "the abort reason is the idle cap");
          return true;
        });
        return null;
      }
    )
  );
  assert.equal(events.length, 0, "a run that never got a byte emits no agent event");
  console.log(`  a connection with no bytes for the idle cap is aborted and reported`);
}

// ── 9. nothing here talked to a real router ──────────────────────────────────
{
  n += 1;
  const { value: c } = ctx();
  const { calls } = await withFetch(
    () => stubResponse({ ctype: "application/json", json: { choices: [{ message: { role: "assistant", content: "x" } }] } }),
    async () => {
      await chatCompletion(c, [], [], null, "offline");
      return null;
    }
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://router.invalid/v1/chat/completions");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer test-token");
  assert.ok(calls[0].init.signal instanceof AbortSignal, "every attempt carries an abort signal");
  console.log(`  the request is a POST to the router's completions path with an abort signal`);
}

console.log(`test-transport: ${n} cases pass offline — stream assembly, degradation, retries, idle abort`);
console.log(`  the idle cap the abort reports is ${ASK_IDLE_TIMEOUT_MS}ms`);
