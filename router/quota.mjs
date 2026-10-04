/**
 * Quota derivation and quota-aware steering.
 *
 * No provider here exposes a quota API (probed: none of the plan upstreams
 * return rate-limit headers or balance endpoints), so everything derives from
 * two ingredients the kit controls: the ledger's weighted spend (tokens
 * discounted by any declared off-peak schedule) and the user's console
 * readings. A calibration read — "the console says the plan is Z% used" —
 * stamped with the cumulative weighted spend at that instant, converts the
 * provider's opaque unit into router-tokens by simple division:
 *
 *   allowance ≈ (weightedSpend(read2) − weightedSpend(read1)) / (pct2 − pct1)/100
 *
 * The result is an estimate with known direction of error, reconciled against
 * every new console read, and consumed by exactly one decision: the order in
 * which a tier's own candidate chain is walked. Bad estimates degrade to a
 * suboptimal choice among providers the tier already trusts — never to a
 * quality regression outside the tier.
 */

const HOUR_MS = 3600_000;

function minuteOfDayInTz(ts, tz) {
  if (!tz) {
    const d = new Date(ts);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false })
      .formatToParts(new Date(ts));
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    return (h % 24) * 60 + m;
  } catch {
    return null; // unknown timezone: treat as no schedule rather than guess wrong
  }
}

/** Weight of a call made at ts under this provider's declared off-peak schedule. */
export function offpeakWeight(quotaDef, ts) {
  const op = quotaDef?.offpeak;
  if (!op || !Number.isFinite(op.weight) || !/^\d{2}:\d{2}$/.test(op.from ?? "") || !/^\d{2}:\d{2}$/.test(op.to ?? "")) return 1;
  const mod = minuteOfDayInTz(ts, op.tz);
  if (mod === null) return 1;
  const from = Number(op.from.slice(0, 2)) * 60 + Number(op.from.slice(3, 5));
  const to = Number(op.to.slice(0, 2)) * 60 + Number(op.to.slice(3, 5));
  const inWindow = from <= to ? mod >= from && mod < to : mod >= from || mod < to;
  return inWindow ? op.weight : 1;
}

const parseDay = (s) => Date.parse(String(s).slice(0, 10) + "T00:00:00Z");

/**
 * Window start for a provider's quota declaration, in ms. pool: declared
 * start (or earliest read). calendar: most recent billing anchor (declared
 * start's day-of-month, else the 1st, UTC). rolling: now minus windowHours.
 */
export function windowStart(q, now, reads) {
  if (q.kind === "rolling") return now - (q.windowHours ?? 24) * HOUR_MS;
  if (q.kind === "pool") {
    const fromReads = reads.length ? Math.min(...reads.map((r) => parseDay(r.date))) : Infinity;
    const start = q.start ? parseDay(q.start) : fromReads;
    return Number.isFinite(start) ? start : now - 30 * 24 * HOUR_MS;
  }
  const anchor = q.start ? Number(String(q.start).slice(8, 10)) || 1 : 1;
  const d = new Date(now);
  const candidate = Date.parse(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(anchor).padStart(2, "0")}T00:00:00Z`);
  return candidate <= now ? candidate : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, anchor));
}

/**
 * Quota state for every provider that declares one. `usage` supplies hourly
 * buckets and cumulative weighted counters; `roster` supplies declarations;
 * `weightFor(providerId, ts)` applies the off-peak schedule. Pure — the
 * server caches the result.
 */
export function computeQuotaState(roster, usage, weightFor, now = Date.now()) {
  const out = {};
  for (const [pid, p] of Object.entries(roster?.providers ?? {})) {
    const q = p.quota;
    if (!q || typeof q !== "object") continue;
    const reads = (q.calibration?.reads ?? [])
      .map((r) => ({ ...r, ts: parseDay(r.date) }))
      .filter((r) => Number.isFinite(r.ts) && Number.isFinite(r.pct))
      .sort((a, b) => a.ts - b.ts);
    // Stamp unstamped reads from hourly buckets when the date is inside
    // retention; reads older than the ledger stay unstamped and are excluded
    // from pair calibration (a declared allowance still works).
    for (const r of reads) {
      if (!Number.isFinite(r.cum)) {
        const back = weightedSince(usage, pid, r.ts, weightFor);
        if (back !== null) r.cum = usage.cumulativeWeighted(pid) - back;
      }
    }

    // Allowance: the latest calibratable pair wins (most recent conversion
    // rate); earlier pairs give a stability spread; declared is the fallback.
    const pairs = [];
    for (let i = 1; i < reads.length; i++) {
      const a = reads[i - 1], b = reads[i];
      if (!Number.isFinite(a.cum) || !Number.isFinite(b.cum)) continue;
      const dPct = b.pct - a.pct;
      const dCum = b.cum - a.cum;
      if (dPct <= 0) continue; // a percentage that dropped = reset between reads; cannot calibrate across it
      pairs.push({ from: a.date, to: b.date, allowance: dCum / (dPct / 100) });
    }
    const calib = pairs.length ? pairs[pairs.length - 1].allowance : null;
    const source = calib != null ? "calibration" : Number.isFinite(q.allowance) ? "declared" : "none";
    const allowance = calib ?? (Number.isFinite(q.allowance) ? q.allowance : null);

    const wStart = windowStart(q, now, reads);
    const spend = weightedSince(usage, pid, wStart, weightFor) ?? 0;
    const firstHour = usage.hourly(pid)[0]?.hourTs ?? Infinity;
    const incomplete = wStart < firstHour;
    const headroom = allowance != null && allowance > 0 ? Math.min(1, Math.max(0, 1 - spend / allowance)) : null;

    // Extrapolate the last console read forward through the ledger: what the
    // provider's percentage should be now if the model is right. The next
    // console read turns this into a measured drift — the reconciliation.
    const last = reads[reads.length - 1] ?? null;
    let impliedPct = null;
    if (last && Number.isFinite(last.cum) && allowance != null && allowance > 0) {
      impliedPct = Math.min(100, Math.max(0, last.pct + (100 * (usage.cumulativeWeighted(pid) - last.cum)) / allowance));
    }

    out[pid] = {
      providerId: pid,
      kind: q.kind,
      windowStart: wStart,
      windowEnd: q.expires ? parseDay(q.expires) : null,
      spend,
      incomplete,
      allowance,
      source,
      stability: pairs.length > 1
        ? Math.max(...pairs.map((x) => x.allowance)) - Math.min(...pairs.map((x) => x.allowance))
        : null,
      headroom,
      impliedPct,
      lastRead: last ? { date: last.date, pct: last.pct } : null,
      offpeak: q.offpeak ?? null,
      sourceNote: q.source ?? null,
      reads: reads.map((r) => ({ date: r.date, pct: r.pct, cum: Number.isFinite(r.cum) ? r.cum : null })),
      pairs: pairs.map((x) => ({ from: x.from, to: x.to, allowance: Math.round(x.allowance) })),
    };
  }
  return out;
}

/** Weighted tokens from ts to now, from hourly buckets (null: no data at all). */
function weightedSince(usage, pid, ts, weightFor) {
  const buckets = usage.hourly(pid);
  if (!buckets.length) return null;
  let sum = 0;
  for (const b of buckets) {
    if (b.hourTs + HOUR_MS <= ts) continue;
    sum += b.tokens * weightFor(pid, b.hourTs + HOUR_MS / 2);
  }
  return sum;
}

/**
 * Steering: walk a tier's candidate chain in roster preference order and take
 * the first provider whose headroom is at or above the threshold. Providers
 * without a quota declaration are neutral (they pass — balancing never
 * diverts away from what is unknown, only toward what is known to have room).
 * If every declared candidate is under pressure, take the max headroom; ties
 * keep roster order.
 */
export function pickCandidate(candidates, quotaState, threshold = 0.4) {
  let fallback = null;
  let fallbackIndex = 0;
  let fallbackH = -1;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const q = quotaState?.[c.providerId];
    const h = q && Number.isFinite(q.headroom) ? q.headroom : 1;
    if (h >= threshold) return { candidate: c, index: i, headroom: h, exhausted: false };
    if (h > fallbackH) { fallbackH = h; fallback = c; fallbackIndex = i; }
  }
  return { candidate: fallback ?? candidates[0], index: fallbackIndex, headroom: fallbackH, exhausted: true };
}
