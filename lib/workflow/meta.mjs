/**
 * Workflow file metadata: the leading `/* workflow ... *\/` header block and the
 * top-level `interface` declarations a workflow's typed asks refer to.
 *
 * The header is a documented convention (see docs/features/workflow-runtime.md),
 * not a parser dependency: the runtime runs any TypeScript file that sticks to
 * the API surface, with or without a header. It exists so `kit workflows list`
 * can show a library, so arguments can be validated before a run starts, and so
 * the roster's workflow registry can be built from what actually ships.
 *
 * The format is a small YAML-shaped block, kept byte-compatible so a workflow
 * moves between editions by changing nothing but the marker word. The kit
 * edition writes `/* zcode-workflow` (its own tooling reads that one), so the
 * marker is accepted with or without the `zcode-` prefix — otherwise a ported
 * file parses as an empty header here and the run API refuses the first
 * argument the file plainly declares.
 *
 *   /* workflow
 *   description: "..."
 *   whenToUse: "..."
 *   args:
 *     name:
 *       type: string
 *       description: "..."
 *       required: false
 *       default: ""
 *   *\/
 */

/** Extract top-level `interface X { ... }` bodies by brace matching. */
export function extractInterfaces(source) {
  const out = new Map();
  const re = /(^|\n)\s*interface\s+([A-Za-z_$][\w$]*)\s*\{/g;
  let m;
  while ((m = re.exec(source))) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let i = open;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === '"' || c === "'" || c === "`") {
        i = skip(source, i);
        continue;
      }
      if (c === "/" && source[i + 1] === "*") {
        const end = source.indexOf("*/", i + 2);
        i = end < 0 ? source.length : end + 1;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) continue;
    out.set(m[2], source.slice(open + 1, i));
  }
  return out;
}

function skip(s, start) {
  const quote = s[start];
  let i = start + 1;
  while (i < s.length) {
    if (s[i] === "\\") {
      i += 2;
      continue;
    }
    if (s[i] === quote) return i + 1;
    if (quote === "`" && s[i] === "$" && s[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (i < s.length && depth > 0) {
        if (s[i] === "{") depth++;
        else if (s[i] === "}") depth--;
        i++;
      }
      continue;
    }
    i++;
  }
  return i;
}

const MARKER = /\/\*\s*(?:zcode-)?workflow\b/;

export function hasHeader(source) {
  return MARKER.test(source);
}

/**
 * Parse the header block into { name, description, whenToUse, args }.
 * `name` comes from the filename, not the block. Missing or malformed blocks
 * yield defaults rather than throwing — the header is a convention.
 */
export function parseHeader(source, name) {
  const meta = { name, description: "", whenToUse: "", args: {} };
  const m = /\/\*\s*(?:zcode-)?workflow\s*\n([\s\S]*?)\*\//.exec(source);
  if (!m) return meta;
  const lines = m[1].split("\n");
  let section = null; // "args" once inside the args block
  let current = null;
  let lastRootKey = null; // the root key a continuation line (if any) belongs to
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (indent === 0) {
      section = null;
      current = null;
      lastRootKey = null;
      const kv = /^([A-Za-z_$][\w$]*)\s*:\s*(.*)$/.exec(line);
      if (kv && kv[1] !== "args") {
        // A root scalar may wrap onto the indented lines below it, quoted or not.
        lastRootKey = kv[1];
        meta[kv[1]] = opensScalar(kv[2]) ? unquote(kv[2]).replace(/^["']/, "") : unquote(kv[2]);
      } else if (kv && kv[1] === "args") section = "args";
      continue;
    }
    if (section === null) {
      if (!lastRootKey) continue;
      meta[lastRootKey] = `${meta[lastRootKey]} ${unquoteContinuation(line)}`.trim();
      continue;
    }
    const kv = /^([A-Za-z_$][\w$]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    if (indent <= 2) {
      // an argument name
      current = kv[1];
      meta.args[current] = {};
      if (kv[2]) {
        meta.args[current].description = opensScalar(kv[2]) ? unquote(kv[2]).replace(/^["']/, "") : unquote(kv[2]);
      }
    } else if (current) {
      // a property of the current argument
      const v = unquote(kv[2]);
      if (kv[1] === "required") meta.args[current].required = v === "true";
      else if (kv[1] === "default") meta.args[current].default = parseDefault(v);
      else meta.args[current][kv[1]] = v;
    }
  }
  return meta;
}

/** A quoted value with no closing quote yet — the scalar continues on the next line. */
function opensScalar(v) {
  const s = String(v ?? "").trim();
  return s.startsWith('"') && !(s.length > 1 && s.endsWith('"'));
}

function unquote(v) {
  const s = String(v ?? "").trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

function unquoteContinuation(line) {
  const s = line.trim();
  if (s.endsWith('"') || s.endsWith("'")) return s.slice(0, -1);
  return s;
}

function parseDefault(v) {
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/** Validate caller-supplied args against the declaration. */
export function validateArgs(meta, args) {
  const problems = [];
  const given = args ?? {};
  for (const name of Object.keys(given)) {
    if (!meta.args[name]) problems.push(`unknown argument "${name}" — ${meta.name} declares: ${Object.keys(meta.args).join(", ") || "(none)"}`);
  }
  for (const [name, spec] of Object.entries(meta.args)) {
    if (spec.required && given[name] === undefined) problems.push(`missing required argument "${name}"`);
    if (given[name] !== undefined && spec.type && spec.type !== "string" && typeof given[name] !== spec.type) {
      problems.push(`argument "${name}" must be a ${spec.type}`);
    }
    if (given[name] === undefined && "default" in spec) given[name] = spec.default;
  }
  return problems;
}
