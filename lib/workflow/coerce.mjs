/**
 * Model answers → the shape the workflow declared.
 *
 * A workflow says `agent("Judge").ask<Judgment>(...)` and the model answers
 * what it feels like: one item where a list was declared, a number where a
 * string was, a nested object with a field left out. The workflow's types say
 * what it will do with those fields, so the runtime settles the shape here
 * instead of letting a run die mid-flight on `e.risks is not iterable`.
 *
 * Coercion, not validation: a value already of the right shape passes through
 * untouched, and a field the model filled with prose stays prose. Missing
 * declared fields become an explicit null so the workflow can see the absence.
 *
 * It also holds the one function that gets the answer into JSON in the first
 * place: a model asked for JSON usually answers with prose around it, so the
 * bare object is recovered from the whole text, a fenced block, or the first
 * balanced object in the reply.
 */

/**
 * Shape one model answer to the schema it was asked for.
 *
 * A schema with `type: "array"` or `items` at the top level (ask<string[]>) is
 * shaped whole; an object schema is walked field by field, with every declared
 * field the answer omitted filled in as an explicit null. Depth is capped at 6
 * so a self-referential schema cannot recurse forever on adversarial input.
 */
export function coerceResult(args, schema, depth = 0) {
  if (!schema || typeof args !== "object" || args === null || depth > 6) return args;
  // A declared array at the top level (`ask<string[]>`) is shaped whole.
  if (schema.type === "array" || schema.items) return coerceToSchema(args, schema, depth);
  const props = schema.properties ?? {};
  const out = Array.isArray(args) ? [] : {};
  for (const [key, value] of Object.entries(args)) {
    out[key] = coerceToSchema(value, props[key], depth);
  }
  for (const key of Object.keys(props)) {
    if (!(key in out)) out[key] = null;
  }
  return out;
}

/**
 * Shape one value against one declared spec. A spec outside the documented
 * subset has `type: undefined` and no `items`/`properties`, and passes its
 * value through unchanged — an unparseable type degrades to leniency here
 * rather than failing the run.
 */
export function coerceToSchema(value, spec, depth) {
  if (!spec || typeof spec !== "object" || value === null || value === undefined) return value ?? null;
  const types = Array.isArray(spec.type) ? spec.type.filter((t) => t !== "null") : [spec.type];
  const type = types[0];
  if (type === "array" || spec.items) {
    // The common break: a model answers with the one item it had in mind and
    // `for (const x of that)` throws.
    if (Array.isArray(value)) return value.map((v) => coerceToSchema(v, spec.items, depth + 1));
    if (typeof value === "string") {
      const t = value.trim();
      return t ? [t] : [];
    }
    if (typeof value === "object") return [coerceResult(value, spec.items, depth + 1)];
    return [value];
  }
  if (type === "object" || spec.properties) {
    if (typeof value !== "object" || Array.isArray(value)) return null;
    return coerceResult(value, spec, depth + 1);
  }
  if (type === "string") {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return null;
  }
  if (type === "number" || type === "integer") {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return type === "integer" ? Math.trunc(n) : n;
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const t = value.trim().toLowerCase();
      if (t === "true" || t === "yes") return true;
      if (t === "false" || t === "no") return false;
    }
    return null;
  }
  return value;
}

/**
 * Pull a JSON object out of a model's prose: whole text, a fenced block, or the
 * first balanced object. Returns null when nothing parses — the caller then
 * falls back to treating the reply as a plain string answer.
 */
export function extractJson(text) {
  if (!text) return null;
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    /* not bare JSON */
  }
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/.exec(t);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* fall through */
    }
  }
  const start = t.search(/[[{]/);
  if (start < 0) return null;
  const open = t[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < t.length; i++) {
    if (t[i] === open) depth++;
    else if (t[i] === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(t.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
