/**
 * The shared journal-event normalizer.
 *
 * Every consumer of workflow-run journals — the router's live watcher, the
 * dashboard, `kit workflows watch` — reads events through this one module, so
 * a journal format change lands here and nowhere else. A journal line is JSON
 * with an offset `t` (ms since run start) and a `kind`; normalize maps it to
 * the flat view event the UI consumes and truncates the loud fields (tool
 * args, prompts, results) to preview size. Unknown kinds pass through shaped
 * but not dropped — the normalizer shapes, it never loses.
 */

const PREVIEW_CAP = 200;

function preview(value, cap = PREVIEW_CAP) {
  if (value === undefined || value === null) return undefined;
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > cap ? s.slice(0, cap) + "…" : s;
}

/**
 * Normalize one journal event. `raw` may be an object or one JSON line;
 * malformed lines return null (the watcher skips them). `ctx` carries the
 * run identity the journal itself does not hold.
 */
export function normalizeEvent(raw, ctx = {}) {
  let e = raw;
  if (typeof e === "string") {
    const s = e.trim();
    if (!s) return null;
    try {
      e = JSON.parse(s);
    } catch {
      return null;
    }
  }
  if (!e || typeof e !== "object" || typeof e.kind !== "string") return null;
  const out = {
    runId: ctx.runId ?? null,
    name: ctx.name ?? (typeof e.name === "string" ? e.name : null),
    t: Number.isFinite(e.t) ? e.t : null,
    kind: e.kind,
  };
  switch (e.kind) {
    case "run-start":
      out.model = e.model ?? null;
      out.workdir = preview(e.workdir);
      break;
    case "phase":
      out.phase = typeof e.phase === "string" ? e.phase : "";
      break;
    case "agent":
      out.actor = String(e.actor ?? "");
      out.ms = Number.isFinite(e.ms) ? e.ms : null;
      out.tools = Boolean(e.tools);
      break;
    case "contract":
      out.actor = String(e.actor ?? "");
      out.title = e.title ?? null;
      out.files = Array.isArray(e.files) ? e.files.length : null;
      out.acceptance = Number.isFinite(e.acceptance) ? e.acceptance : null;
      out.provides = preview(e.provides);
      break;
    case "tool":
      out.actor = String(e.actor ?? "");
      out.tool = String(e.tool ?? "");
      out.args = preview(e.args);
      out.grant = typeof e.grant === "string" ? e.grant : null;
      out.refused = typeof e.refused === "string" ? e.refused : null;
      // A recall's own audit: which fact ids the agent was shown and how many
      // bytes of them, on the tool line rather than a second one — recall IS a
      // tool call, and the run's record of tool calls holds all of them.
      out.facts = Number.isFinite(e.facts) ? e.facts : null;
      out.ids = Array.isArray(e.ids) ? e.ids.map((x) => String(x)).slice(0, 40) : null;
      out.bytes = Number.isFinite(e.bytes) ? e.bytes : null;
      break;
    case "report":
      out.artifactId = e.artifactId ?? null;
      out.item = preview(e.item, 300);
      break;
    case "escalation":
      out.actor = String(e.actor ?? "?");
      out.topic = typeof e.topic === "string" ? e.topic : null;
      out.question = preview(e.question);
      out.evidence = preview(e.evidence);
      break;
    case "artifact":
      out.artifactId = String(e.id ?? "");
      out.version = Number.isFinite(e.version) ? e.version : null;
      out.bytes = Number.isFinite(e.bytes) ? e.bytes : null;
      out.path = e.path ?? null;
      out.title = e.title ?? null;
      out.primary = Boolean(e.primary);
      break;
    case "command":
      out.command = String(e.command ?? "");
      out.args = preview(e.args);
      out.grant = typeof e.grant === "string" ? e.grant : null;
      out.refused = typeof e.refused === "string" ? e.refused : null;
      out.from = typeof e.from === "string" ? e.from : null;
      break;
    case "service":
      out.service = String(e.service ?? "");
      out.handle = typeof e.handle === "string" ? e.handle : null;
      out.event = typeof e.event === "string" ? e.event : null;
      out.command = typeof e.command === "string" ? e.command : null;
      out.args = preview(e.args);
      out.lifetimeMs = Number.isFinite(e.lifetimeMs) ? e.lifetimeMs : null;
      out.exitCode = Number.isFinite(e.exitCode) ? e.exitCode : null;
      // A signal-killed child exits with a null code, so the signal is the only
      // thing that says why — the number alone would read as "still running".
      out.signal = typeof e.signal === "string" ? e.signal : null;
      out.pid = Number.isFinite(e.pid) ? e.pid : null;
      break;
    case "log":
    case "warn":
      out.message = preview(e.message, 300);
      break;
    case "fact":
      // The run's own record of itself, written by the coordination layer alone
      // (world.remember): what the plane decided or measured, with the part the
      // fact belongs to when it belongs to one.
      out.op = typeof e.op === "string" ? e.op : null;
      out.factId = typeof e.factId === "string" ? e.factId : null;
      out.factKind = typeof e.factKind === "string" ? e.factKind : null;
      out.part = typeof e.part === "string" ? e.part : null;
      out.chars = Number.isFinite(e.chars) ? e.chars : null;
      out.text = preview(e.text);
      break;
    case "run-done":
      out.ms = Number.isFinite(e.durationMs) ? e.durationMs : null;
      out.result = preview(e.result, 300);
      break;
    case "run-failed":
      out.error = preview(e.error, 300);
      break;
    default:
      break; // unknown kinds pass through with kind only
  }
  return out;
}

/** True once the journal shows the run has settled. */
export function isTerminal(kind) {
  return kind === "run-done" || kind === "run-failed";
}
