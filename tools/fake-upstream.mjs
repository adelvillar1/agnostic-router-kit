#!/usr/bin/env node
/**
 * The probes' scripted provider: an OpenAI-compatible upstream whose behavior
 * is encoded in the requested model's name, so a static scratch roster can
 * drive every failure shape deterministically. Zero dependencies, zero real
 * network — the failover probe (tools/probe-failover.mjs) spawns one instance
 * per fake provider and reads GET /hits as the ground truth for "which
 * upstream actually served".
 *
 *   model contains   behavior
 *   ---------------  ------------------------------------------------------
 *   -ok              200, OpenAI-shaped JSON with usage
 *   -stream          SSE, [DONE], usage in the final data line
 *   -429ra<N>        429 with Retry-After: <N>
 *   -429             429, no header
 *   -401             401, key-rejection vocabulary in the body
 *   -402             402, "insufficient credits … usage limit" body
 *   -500             500
 *   -400             400 (client error — the router must pass it through)
 *
 * Usage: node tools/fake-upstream.mjs --port 8511 --tag fa
 */

import http from "node:http";

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const PORT = Number(arg("port", 0));
const TAG = arg("tag", "fake");
if (!PORT) {
  console.error("usage: fake-upstream.mjs --port <port> --tag <name>");
  process.exit(1);
}

let hits = 0;
let lastModel = null;

function behaviorFor(model) {
  const m = String(model ?? "");
  const ra = m.match(/-429ra(\d+)/);
  if (ra) return { kind: "429", retryAfter: Number(ra[1]) };
  if (m.includes("-429")) return { kind: "429" };
  if (m.includes("-401")) return { kind: "401" };
  if (m.includes("-402")) return { kind: "402" };
  if (m.includes("-500")) return { kind: "500" };
  if (m.includes("-400")) return { kind: "400" };
  if (m.includes("-stream")) return { kind: "stream" };
  return { kind: "ok" };
}

const content = (model) => `answer from ${TAG} serving ${model}`;

function errorBody(kind) {
  if (kind === "401") return JSON.stringify({ error: { message: "invalid api key: authentication failed" } });
  if (kind === "402") return JSON.stringify({ error: { message: "insufficient credits: usage limit reached for this plan" } });
  if (kind === "500") return JSON.stringify({ error: { message: "upstream exploded" } });
  return JSON.stringify({ error: { message: "bad request shape" } });
}

const server = http.createServer((req, res) => {
  const path = (req.url ?? "").replace(/\/+$/, "");
  if (req.method === "GET" && path.endsWith("/hits")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tag: TAG, count: hits, lastModel }));
    return;
  }
  if (req.method === "GET" && (path.endsWith("/models") || path === "/v1" || path === "")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: ["fake-ok", "fake-stream", "fake-429", "fake-401", "fake-402", "fake-500", "fake-400"].map((id) => ({ id, object: "model", owned_by: TAG })),
    }));
    return;
  }
  if (req.method !== "POST" || !path.endsWith("/chat/completions")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `fake ${TAG}: no such route` } }));
    return;
  }

  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let model = null;
    let stream = false;
    try {
      const body = JSON.parse(raw || "{}");
      model = typeof body.model === "string" ? body.model : null;
      stream = body.stream === true;
    } catch {}
    hits++;
    lastModel = model;
    const b = behaviorFor(model);

    if (["429", "401", "402", "500", "400"].includes(b.kind)) {
      const headers = { "Content-Type": "application/json" };
      if (b.kind === "429" && b.retryAfter) headers["Retry-After"] = String(b.retryAfter);
      res.writeHead(Number(b.kind), headers);
      res.end(errorBody(b.kind));
      return;
    }

    if (b.kind === "stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const chunk = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      chunk({ id: "fake", object: "chat.completion.chunk", model, choices: [{ delta: { role: "assistant" }, index: 0 }] });
      chunk({ id: "fake", object: "chat.completion.chunk", model, choices: [{ delta: { content: content(model) }, index: 0 }] });
      chunk({ id: "fake", object: "chat.completion.chunk", model, choices: [{ delta: {}, index: 0, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "fake",
      object: "chat.completion",
      model,
      choices: [{ index: 0, message: { role: "assistant", content: content(model) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    }));
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`fake-upstream ${TAG} on 127.0.0.1:${PORT}`));
