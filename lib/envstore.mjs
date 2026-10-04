/**
 * .env handling for the runtime router dir. Keys live ONLY here (chmod 600) —
 * never in the roster, never in git, never in any harness's config.
 */
import fs from "node:fs";
import path from "node:path";

export function readEnvFile(p) {
  const out = {};
  if (!p || !fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

export function writeEnvFile(p, entries, { header = [] } = {}) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const lines = [];
  for (const h of header) lines.push(`# ${h}`);
  if (header.length) lines.push("");
  for (const [k, v] of Object.entries(entries)) {
    const q = /[ \t"']/.test(String(v)) ? JSON.stringify(String(v)) : String(v);
    lines.push(`${k}=${q}`);
  }
  fs.writeFileSync(p, lines.join("\n") + "\n", { mode: 0o600 });
  fs.chmodSync(p, 0o600);
}
