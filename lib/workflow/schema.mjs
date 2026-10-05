/**
 * TypeScript type text → JSON schema, for the workflow runtime's typed asks.
 *
 * A workflow says `agent("Judge").ask<Judgment>(...)` and the runtime must
 * hand the model a schema for Judgment. Type arguments are erased at runtime,
 * so the engine recovers them from the workflow's own source: this module
 * parses the documented type subset (see docs/features/workflow-runtime.md)
 * out of the .ts text and annotates each `.ask<...>` call site with the schema
 * found there.
 *
 * The subset is deliberately small — interfaces with JSDoc'd fields, string
 * literals, unions of literals, arrays, and nested inline object types, which
 * is everything the documented style uses. Anything outside it returns null,
 * and the runtime degrades that ask to lenient JSON parsing rather than
 * failing the run: an unparseable type is a quality problem, not a crash.
 */
import { extractInterfaces } from "./meta.mjs";

// ── the scanner ──────────────────────────────────────────────────────────────
// A hand-written scanner rather than a regex because the type grammar nests
// (an array of inline objects with optional fields) and the same text can hold
// comments, strings, and braces that must all be balanced to find the end.

class Scanner {
  constructor(text) {
    this.s = text;
    this.i = 0;
  }
  get done() {
    return this.i >= this.s.length;
  }
  /** Skip whitespace and comments, remembering the last comment seen. */
  skipTrivia(capture) {
    let doc = null;
    for (;;) {
      const c = this.s[this.i];
      if (c === undefined) break;
      if (/\s/.test(c)) {
        this.i++;
        continue;
      }
      if (c === "/" && this.s[this.i + 1] === "/") {
        const end = this.s.indexOf("\n", this.i);
        this.i = end < 0 ? this.s.length : end + 1;
        continue;
      }
      if (c === "/" && this.s[this.i + 1] === "*") {
        const end = this.s.indexOf("*/", this.i + 2);
        const body = end < 0 ? this.s.slice(this.i + 2) : this.s.slice(this.i + 2, end);
        const flat = body.replace(/\*\//g, "").replace(/^\s*\*\s?/gm, "").trim();
        if (flat) doc = flat;
        this.i = end < 0 ? this.s.length : end + 2;
        continue;
      }
      break;
    }
    if (capture) capture.doc = doc;
  }
  peek() {
    return this.s[this.i];
  }
  next() {
    return this.s[this.i++];
  }
  eat(str) {
    if (this.s.startsWith(str, this.i)) {
      this.i += str.length;
      return true;
    }
    return false;
  }
  expect(str) {
    if (!this.eat(str)) throw new Error(`expected ${str} at ${this.i}`);
  }
}

// ── type grammar ─────────────────────────────────────────────────────────────

const PRIMITIVES = {
  string: { type: "string" },
  number: { type: "number" },
  boolean: { type: "boolean" },
  any: null,
  unknown: null,
};

/** Parse one type expression. Returns a schema, or null when unrepresentable. */
/**
 * Parse one type expression, unions included. All-literal unions become an
 * enum (the severity pattern); a `| null` alternative is dropped, because
 * JSON-schema-in-a-tool-parameter has no clean nullable form that every
 * provider accepts and the workflow's own `??` already handles the absence.
 * Anything else that varies (mixed types, generics, aliases) returns null,
 * which degrades this one type — never the run.
 */
function parseType(sc, interfaces, depth) {
  if (depth > 6) return null;
  const cap = {};
  sc.skipTrivia(cap);
  const first = parsePrimary(sc, interfaces, depth);
  sc.skipTrivia();
  if (sc.peek() !== "|") return first;
  const parts = [first];
  while (sc.eat("|")) {
    sc.skipTrivia();
    if (sc.eat("null") || sc.eat("undefined")) {
      parts.push("null");
      sc.skipTrivia();
      continue;
    }
    parts.push(parsePrimary(sc, interfaces, depth));
    sc.skipTrivia();
  }
  const nonNull = parts.filter((p) => p !== "null");
  if (nonNull.some((p) => !p)) return null;
  if (nonNull.every((p) => typeof p === "object" && "const" in p)) {
    const values = nonNull.map((p) => p.const);
    return values.every((v) => typeof v === "string") ? { type: "string", enum: values } : { enum: values };
  }
  if (nonNull.length === 1) return nonNull[0];
  return null;
}

function parsePrimary(sc, interfaces, depth) {
  let schema = null;
  if (sc.eat("{")) schema = parseFields(sc, interfaces, depth);
  else if (sc.eat("(") || sc.eat("[")) return null; // tuple / function-ish — not in the subset
  else if (sc.peek() === '"' || sc.peek() === "'") {
    const quote = sc.next();
    let text = "";
    while (!sc.done && sc.peek() !== quote) text += sc.next();
    sc.eat(quote);
    schema = { const: text };
  } else {
    const ident = readIdent(sc);
    if (!ident) return null;
    if (PRIMITIVES[ident]) schema = PRIMITIVES[ident];
    // else: an alias or import we cannot resolve — leave it untyped.
    else if (interfaces.has(ident)) schema = typeToSchema(interfaces.get(ident), interfaces, depth + 1);
    sc.skipTrivia();
    if (sc.peek() === "<") return null; // generics — not in the subset
    return suffix(sc, schema);
  }
  sc.skipTrivia();
  return suffix(sc, schema);
}

/** One or more `[]` suffixes wrap what precedes them. */
function suffix(sc, schema) {
  let out = schema;
  while (sc.peek() === "[" && sc.s[sc.i + 1] === "]") {
    sc.i += 2;
    out = out ? { type: "array", items: out } : null;
    sc.skipTrivia();
  }
  return out;
}

function parseObject(sc, interfaces, depth) {
  const schema = parseFields(sc, interfaces, depth);
  sc.skipTrivia();
  sc.expect("}");
  return schema;
}

function readIdent(sc) {
  const m = /^[A-Za-z_$][\w$]*/.exec(sc.s.slice(sc.i));
  if (!m) return null;
  sc.i += m[0].length;
  return m[0];
}

/** The field list inside `{ ... }` — or an interface body, which is the same text without the braces. */
function parseFields(sc, interfaces, depth) {
  const properties = {};
  const required = [];
  for (;;) {
    const cap = {};
    sc.skipTrivia(cap);
    if (sc.eat("}")) break;
    if (sc.done) break;
    const name = readIdent(sc) ?? (sc.peek() === '"' ? readString(sc) : null);
    if (!name) throw new Error(`expected a field name at ${sc.i}`);
    sc.skipTrivia();
    const optional = sc.eat("?");
    sc.expect(":");
    const schema = parseType(sc, interfaces, depth);
    if (schema) properties[name] = cap.doc ? { ...schema, description: cap.doc } : schema;
    if (!optional) required.push(name);
    sc.skipTrivia();
    if (!sc.eat(";") && !sc.eat(",")) sc.eat("\n");
  }
  if (!Object.keys(properties).length) return null;
  const schema = { type: "object", properties };
  if (required.length) schema.required = required;
  return schema;
}

function readString(sc) {
  const quote = sc.next();
  let text = "";
  while (!sc.done && sc.peek() !== quote) text += sc.next();
  sc.eat(quote);
  return text;
}

/** Compile one interface's body: a field list, optionally braced. */
function typeToSchema(body, interfaces, depth) {
  const sc = new Scanner(body);
  sc.skipTrivia();
  if (sc.peek() === "{") {
    sc.i++;
    return parseObject(sc, interfaces, depth);
  }
  return parseFields(sc, interfaces, depth);
}

/**
 * Parse a type expression (used for inline `ask<{...}>` types). Returns a JSON
 * schema, or null when the expression falls outside the documented subset.
 * Interface bodies are compiled by typeToSchema, which is the same grammar
 * without the outer braces.
 */
export function parseTypeText(text, interfaces = new Map()) {
  try {
    const sc = new Scanner(String(text));
    return parseType(sc, interfaces, 0);
  } catch {
    return null;
  }
}

// ── call-site annotation ─────────────────────────────────────────────────────

/**
 * Rewrite the workflow source so every `x.ask<T>(args)` becomes
 * `x.ask(args, __wfTypeN)` with `__wfTypeN` declared in the preamble the engine
 * prepends. Returns the list of type texts found (index = N), or null when the
 * source holds something the scanner cannot balance — the engine then runs the
 * workflow unannotated and every ask degrades to lenient JSON.
 *
 * The scan skips strings and comments on purpose: a prompt that mentions
 * `.ask<` must not move the needle. A site that does not balance is left
 * untouched rather than failing the whole file.
 */
export function annotateAskSites(source) {
  const interfaces = extractInterfaces(source);
  const types = [];
  let out = "";
  let i = 0;
  const s = source;
  while (i < s.length) {
    const c = s[i];
    // copy strings verbatim (with ${} nesting) so their contents never parse as code
    if (c === '"' || c === "'" || c === "`") {
      const j = skipString(s, i);
      out += s.slice(i, j);
      i = j;
      continue;
    }
    if (c === "/" && s[i + 1] === "/") {
      const end = s.indexOf("\n", i);
      const j = end < 0 ? s.length : end + 1;
      out += s.slice(i, j);
      i = j;
      continue;
    }
    if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      const j = end < 0 ? s.length : end + 2;
      out += s.slice(i, j);
      i = j;
      continue;
    }
    const m = /^\.\s*ask\s*</.exec(s.slice(i));
    if (!m) {
      out += c;
      i++;
      continue;
    }
    // Found `.ask<` — extract the type argument, then the argument list.
    let j = i + m[0].length;
    const typeStart = j;
    let angle = 1;
    while (j < s.length && angle > 0) {
      const ch = s[j];
      if (ch === '"' || ch === "'" || ch === "`") j = skipString(s, j);
      else if (ch === "<") angle++, j++;
      else if (ch === ">") angle--, j++;
      else j++;
    }
    if (angle !== 0) {
      out += s.slice(i, typeStart);
      i = typeStart;
      continue;
    }
    const typeText = s.slice(typeStart, j - 1).trim();
    // Now the call's argument list: `(` … matching `)`.
    let k = j;
    while (k < s.length && /\s/.test(s[k])) k++;
    if (s[k] !== "(") {
      out += s.slice(i, typeStart);
      i = typeStart;
      continue;
    }
    const argsStart = k + 1;
    let depth = 1;
    let p = argsStart;
    let failed = false;
    while (p < s.length && depth > 0) {
      const ch = s[p];
      if (ch === '"' || ch === "'" || ch === "`") {
        p = skipString(s, p);
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth--;
      if (depth === 0) break;
      p++;
    }
    if (depth !== 0 || !s.startsWith(")", p)) failed = true;
    if (failed) {
      out += s.slice(i, typeStart);
      i = typeStart;
      continue;
    }
    const argsText = s.slice(argsStart, p);
    // A trailing comma in the call is legal where it was written — and becomes
    // illegal once the type argument is appended as a further argument, so it
    // is dropped here. Without this, a workflow whose ask is formatted across
    // lines with a trailing comma loads as `SyntaxError: Expression expected`.
    const args = argsText.replace(/,(\s*)$/, "$1");
    // `ask<string>` / `ask()` carry no structured result.
    const bare = !typeText || typeText === "string" || typeText === "String";
    const idx = bare ? -1 : types.push(typeText) - 1;
    out += ".ask(";
    out += args;
    if (idx >= 0) out += `, __wfType${idx}`;
    out += ")";
    i = p + 1;
  }
  return { source: out, types };
}

/** Skip a string literal starting at `start`, balancing ${} inside templates. */
function skipString(s, start) {
  const quote = s[start];
  let i = start + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    if (quote === "`" && c === "$" && s[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (i < s.length && depth > 0) {
        const d = s[i];
        if (d === '"' || d === "'" || d === "`") {
          i = skipString(s, i);
          continue;
        }
        if (d === "{") depth++;
        else if (d === "}") depth--;
        i++;
      }
      continue;
    }
    i++;
  }
  return i;
}
