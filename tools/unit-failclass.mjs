#!/usr/bin/env node
/**
 * The failure classifier's unit table: the two ordering laws as cases.
 *   1. usage-limit vocabulary is matched BEFORE the 429 pattern — a
 *      subscription's window is hours away, so its limit is terminal (quota)
 *      even when the provider phrases it as a rate limit.
 *   2. quota/billing/rate-limit bodies are never a key fault — the key is not
 *      the thing that is exhausted.
 * Direct module import, no server, the unit-coerce idiom.
 *
 * Usage: node tools/unit-failclass.mjs
 */

import { classifyFailure, rememberKeyRejection, keyRejectionView } from "../router/failclass.mjs";

let passed = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Law 1 — the ordering law.
{
  const c = classifyFailure({ status: 429, body: "you hit your weekly usage limit" });
  ok("429 + usage-limit body classifies as quota (checked before the rate pattern)", c.kind === "quota", JSON.stringify(c));
  ok("a quota verdict is not a key fault", c.isKeyFault === false);
  ok("a quota verdict benches long (the window is hours away)", c.benchMs >= 1_000_000, String(c.benchMs));
  const r = classifyFailure({ status: 429, body: "slow down, too many requests" });
  ok("429 without usage vocabulary is rate", r.kind === "rate");
  const r2 = classifyFailure({ status: 429, body: "" });
  ok("a bare 429 is rate", r2.kind === "rate");
}

// Law 2 — the key-fault exemption.
{
  const q = classifyFailure({ status: 402, body: "insufficient credits" });
  ok("402 is quota and never a key fault", q.kind === "quota" && q.isKeyFault === false);
  const k = classifyFailure({ status: 401, body: "" });
  ok("401 is a key fault", k.kind === "key" && k.isKeyFault === true);
  const k403 = classifyFailure({ status: 403, body: "Invalid API key provided" });
  ok("403 with key vocabulary is a key fault", k403.kind === "key" && k403.isKeyFault === true);
  const m403 = classifyFailure({ status: 403, body: "model gorp-9 does not exist or you lack access to it" });
  ok("403 with model vocabulary is a model gap, benching nothing", m403.kind === "model" && m403.benchMs === 0, JSON.stringify(m403));
  const m404 = classifyFailure({ status: 404, body: "unknown model gorp-9" });
  ok("unknown-model body is a model gap", m404.kind === "model");
  ok("a model gap still walks (another provider may carry the model)", m404.walk === true);
}

// The walk gate and the network default.
{
  const c400 = classifyFailure({ status: 400, body: "bad request shape" });
  ok("a client-caused 400 never walks", c400.kind === "client" && c400.walk === false);
  const t = classifyFailure({ status: 503 });
  ok("5xx is transient and walks", t.kind === "transient" && t.walk === true);
  const n = classifyFailure({ status: 0 });
  ok("no status at all is the network case", n.kind === "network" && n.walk === true);
}

// The rejection memory: per url+fingerprint, counted, viewable.
{
  rememberKeyRejection({ providerId: "fa", baseUrl: "http://x/v1", key: "secret-1", status: 401, label: "key rejected by provider" });
  rememberKeyRejection({ providerId: "fa", baseUrl: "http://x/v1", key: "secret-1", status: 401, label: "key rejected by provider" });
  rememberKeyRejection({ providerId: "fb", baseUrl: "http://x/v1", key: "secret-2", status: 403, label: "key rejected by provider" });
  const view = keyRejectionView();
  ok("the same key on the same url is one counted rejection", view.filter((e) => e.providerId === "fa").length === 1 && view.find((e) => e.providerId === "fa")?.count === 2, JSON.stringify(view));
  ok("the same key on another url is its own rejection", view.length === 2);
  ok("no key material ever reaches the view", !JSON.stringify(view).includes("secret"));
}

console.log(`\nunit-failclass: ${passed} cases pass, ${failures.length} fail`);
if (failures.length) {
  console.log(`failed: ${failures.join("; ")}`);
  process.exit(1);
}
