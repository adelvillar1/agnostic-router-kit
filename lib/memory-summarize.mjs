/**
 * The consolidation summarizer: deterministic-first, fail-open to the router.
 *
 * When the router is healthy, one `model: auto` call upgrades a digest from
 * the extractive fallback to a proper summary — the same law the router's
 * judge obeys (an outage degrades, it never fails). No key ever appears here:
 * the call rides the router like every other client, with the runtime's
 * localToken read from the rendered config.
 */
import fs from "node:fs";
import path from "node:path";

const KIT_VERSION = "1.0.0";

export async function summarize(lines, { port = 8300, timeoutMs = 20000 } = {}) {
  const input = lines.filter(Boolean).join("\n- ");
  const fallback = lines
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((l) => l.slice(0, 200))
    .join(" | ");
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(process.env.AGNOSTIC_ROUTER_KIT_HOME ?? path.join(process.env.HOME ?? "", ".agnostic-router-kit"), "router", "config.json"), "utf8"));
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.localToken ?? "local-auto-router"}` },
      body: JSON.stringify({
        model: "auto",
        messages: [
          { role: "system", content: "You are a memory consolidation engine. Summarize the user's remembered lines into 1-3 concise sentences. Preserve durable facts, names, preferences, and decisions. Discard fluff. Add nothing." },
          { role: "user", content: `- ${input}` },
        ],
        max_tokens: 300,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return fallback;
    const body = await res.json();
    const text = body.choices?.[0]?.message?.content?.trim();
    return text && text.length > 10 ? text : fallback;
  } catch {
    return fallback;
  }
}
