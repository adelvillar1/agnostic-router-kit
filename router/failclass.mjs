/**
 * Failure classification for the failover walk. Pure: a status plus a bounded
 * body snippet in, one verdict out. The verdict decides (a) whether the walk
 * continues, (b) how long the provider is benched, (c) what the ledger row
 * and the dashboard say.
 *
 * Two laws, ported from OpenMausBot's retry.ts / key-rejections.ts:
 *   - The usage-limit vocabulary is matched BEFORE the 429 pattern, because a
 *     subscription's window is hours away — its limit is terminal (quota)
 *     even when the provider phrases it as a rate limit.
 *   - Quota, billing and rate-limit bodies are never a key rejection: the key
 *     is not the thing that is exhausted. A key is trusted until a real use
 *     of it is refused (401, or 403 speaking key vocabulary).
 *
 * Deterministic, zero-latency, offline — deliberately not a sys1 job; sys1's
 * lane stays routing and judging.
 *
 * The walk gate itself stays in server.js (a status set there is the floor);
 * the bench order is: the roster's failover.cooldowns override, then
 * Retry-After for the honest rate-limit case, then the classified bench, then
 * the legacy per-status floor.
 */
import crypto from "node:crypto";

const QUOTA = /usage limit|weekly limit|monthly limit|quota exceeded|insufficient (credits?|funds)|billing|payment required/i;
const RATE = /rate limit|too many requests|overloaded/i;
const KEY = /invalid[- ]?api[- ]?key|incorrect api key|unauthorized|authentication/i;
const MODEL = /model (does not exist|not found)|unknown model|does not exist or is not accessible|no access to model/i;

export function classifyFailure({ status, body = "" } = {}) {
  const s = Number(status) || 0;
  const text = String(body).slice(0, 400);
  if (s === 402 || QUOTA.test(text))
    return { kind: "quota", isKeyFault: false, walk: true, benchMs: 1_800_000, label: "quota window (hours away — not the key's fault)" };
  if (s === 429 || RATE.test(text))
    return { kind: "rate", isKeyFault: false, walk: true, benchMs: 300_000, label: "rate limited" };
  if (s === 401 || (s === 403 && KEY.test(text)))
    return { kind: "key", isKeyFault: true, walk: true, benchMs: 3_600_000, label: "key rejected by provider" };
  if (s === 403 || MODEL.test(text))
    return { kind: "model", isKeyFault: false, walk: true, benchMs: 0, label: "model not available to this key — walked, provider not benched" };
  if (s === 408 || (s >= 500 && s <= 599))
    return { kind: "transient", isKeyFault: false, walk: true, benchMs: 60_000, label: "transient upstream failure" };
  if (s >= 400 && s < 500)
    return { kind: "client", isKeyFault: false, walk: false, benchMs: 0, label: "client-caused — surfaced as-is" };
  return { kind: "network", isKeyFault: false, walk: true, benchMs: 60_000, label: "no answer / connection failure" };
}

/**
 * Rejection memory: a key is trusted until a real use fails; the rejection is
 * remembered per (base-url + key fingerprint) so the same key can fail on one
 * provider and stay trusted on another. In-memory only — a router restart
 * re-trusts keys, which is the fail-open posture; the dashboard is the
 * running router's surface, so this never crosses into `kit doctor`.
 */
const keyRejections = new Map();
const KEY_REJECTION_CAP = 20;

export function rememberKeyRejection({ providerId, baseUrl, key, status, label }) {
  const fingerprint = crypto.createHash("sha256").update(String(key ?? "")).digest("hex").slice(0, 12);
  const k = `${baseUrl}:${fingerprint}`;
  const prev = keyRejections.get(k);
  keyRejections.set(k, {
    providerId: providerId ?? null,
    baseUrl,
    fingerprint,
    at: Date.now(),
    status: Number.isFinite(status) ? status : null,
    label: label ?? null,
    count: (prev?.count ?? 0) + 1,
  });
  if (keyRejections.size > KEY_REJECTION_CAP) keyRejections.delete(keyRejections.keys().next().value);
}

/** The dashboard's view — fingerprint only, never key material. */
export function keyRejectionView() {
  return [...keyRejections.values()];
}
