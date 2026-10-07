/**
 * The semantic shadow router: agreement data, zero influence.
 *
 * The judge already picks a first workflow per request by matching the
 * roster's shape sentences. This module embeds those shapes once (the local
 * sem1 llama-server, OpenAI-style /v1/embeddings), and after each fresh judge
 * decision logs which workflow the geometry WOULD have picked beside the
 * judge's actual pick. Every row is eval-only (`evalOnly: true, applied:
 * false`): the rows exist to fit an agreement floor, and a later wave may
 * earn the geometry a real shortlist-in-front-of-the-judge — never this one.
 *
 * The influence guarantee is structural, not disciplinary:
 *   - `note()` runs after the judge's verdict exists, fire-and-forget, and
 *     nothing in the router reads its return value;
 *   - every failure path disables the logger BY NAME (warm failure, embed
 *     failure) and further notes are no-ops — the router routes exactly as
 *     before this module existed.
 *
 * The shadow's registry is captured at startup and re-warmed on config
 * reload, so a roster edit re-embeds shapes without a restart.
 */

/** Cosine with a dim guard — a silent zip truncation would return confident
 * wrong agreements, the one failure shape this lane refuses to produce. */
export function cosine(a, b) {
  if (a.length !== b.length) throw new Error(`dim mismatch: ${a.length} vs ${b.length}`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/** Argmax over the shape matrix; ties go to the earlier shape (deterministic). */
export function wouldPick(queryVec, matrix, names) {
  let best = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < matrix.length; i++) {
    const score = cosine(queryVec, matrix[i]);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best < 0 ? null : { name: names[best], score: bestScore };
}

async function embedTexts(embedUrl, model, texts, key) {
  const res = await fetch(`${embedUrl.replace(/\/+$/, "")}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({ model, input: texts }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`);
  const body = await res.json();
  const vectors = (body?.data ?? []).map((d) => d?.embedding);
  if (vectors.length !== texts.length || vectors.some((v) => !Array.isArray(v))) {
    throw new Error(`embeddings answer shape mismatch: ${vectors.length} for ${texts.length}`);
  }
  return vectors;
}

/**
 * Build the shadow logger. `registry` is [{name, text}] — the roster's
 * workflow shapes; `log` is the router's own JSONL sink. All failure paths
 * disable by name; nothing here ever throws into the caller.
 */
export function makeSemrouteShadow({ registry, embedUrl, model, log, key } = {}) {
  const state = {
    matrix: [],
    names: [],
    warmed: false,
    disabled: null, // the named reason, once
  };
  async function warm() {
    try {
      const texts = registry.map((wf) => wf.text);
      if (!texts.length) {
        state.disabled = "no workflow shapes in the roster registry";
        return;
      }
      state.matrix = await embedTexts(embedUrl, model, texts, key);
      state.names = registry.map((wf) => wf.name);
      state.warmed = true;
      state.disabled = null;
      log({ event: "semroute-shadow", detail: "warm", shapes: state.names.length, model });
    } catch (e) {
      state.warmed = false;
      state.disabled = `embedding server unavailable (${String(e?.message ?? e).slice(0, 120)}) — the shadow logger is off, routing unchanged`;
      log({ event: "semroute-shadow", detail: "disabled", reason: state.disabled });
    }
  }
  async function note(requestText, picked) {
    try {
      if (state.disabled) return null;
      if (!state.warmed) return null; // warm still in flight — this request is simply unlogged
      const [queryVec] = await embedTexts(embedUrl, model, [String(requestText ?? "").slice(0, 8000)], key);
      const would = wouldPick(queryVec, state.matrix, state.names);
      const row = {
        kind: "semroute-shadow",
        evalOnly: true,
        applied: false,
        picked: picked ?? "none",
        wouldPick: would?.name ?? "none",
        agree: (would?.name ?? "none") === (picked ?? "none"),
        score: would ? Number(would.score.toFixed(4)) : null,
        model,
      };
      log(row);
      return row;
    } catch (e) {
      state.disabled = `embed failed (${String(e?.message ?? e).slice(0, 120)}) — the shadow logger is off, routing unchanged`;
      log({ event: "semroute-shadow", detail: "disabled", reason: state.disabled });
      return null;
    }
  }
  return {
    warm,
    note,
    get warmed() {
      return state.warmed;
    },
    get disabled() {
      return state.disabled;
    },
  };
}
