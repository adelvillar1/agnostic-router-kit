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
    case "delegate":
      out.op = String(e.op ?? "");
      out.parent = String(e.parent ?? "");
      out.child = String(e.child ?? "");
      out.depth = Number.isFinite(e.depth) ? e.depth : null;
      out.task = preview(e.task);
      out.ms = Number.isFinite(e.ms) ? e.ms : null;
      out.asks = Number.isFinite(e.asks) ? e.asks : null;
      out.toolCalls = Number.isFinite(e.toolCalls) ? e.toolCalls : null;
      out.result = preview(e.result);
      out.reason = preview(e.reason);
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
    // A part's checkpoint and its rollback: the take holds the part's declared
    // paths and the bytes in them; the restore says what came back and what it
    // could not touch. `op` distinguishes the refused take (an escaping path)
    // from a normal one.
    case "checkpoint":
      out.id = typeof e.id === "string" ? e.id : null;
      out.part = String(e.part ?? "");
      out.op = typeof e.op === "string" ? e.op : null;
      out.path = typeof e.path === "string" ? e.path : null;
      out.paths = Number.isFinite(e.paths) ? e.paths : null;
      out.bytes = Number.isFinite(e.bytes) ? e.bytes : null;
      out.oversized = Boolean(e.oversized);
      out.reason = preview(e.reason);
      break;
    case "rollback":
      out.id = typeof e.id === "string" ? e.id : null;
      out.part = String(e.part ?? "");
      out.restored = Number.isFinite(e.restored) ? e.restored : null;
      out.removed = Number.isFinite(e.removed) ? e.removed : null;
      out.uncaptured = Number.isFinite(e.uncaptured) ? e.uncaptured : null;
      out.left = Number.isFinite(e.left) ? e.left : null;
      break;
    // One ask's cost: the token counts the upstream reported for the calls this
    // ask made, the tool rounds it took, and whether the plane had to compact
    // its history mid-ask. An ask's tokens are the sum of its calls' prompts
    // (every round resends the history), which is what the ask cost in total.
    case "account":
      out.actor = String(e.actor ?? "");
      out.ask = Number.isFinite(e.ask) ? e.ask : null;
      out.shape = typeof e.shape === "string" ? e.shape : null;
      out.budget = e.budget && typeof e.budget === "object"
        ? { rounds: Number.isFinite(e.budget.rounds) ? e.budget.rounds : null, tokens: Number.isFinite(e.budget.tokens) ? e.budget.tokens : null }
        : null;
      out.rounds = Number.isFinite(e.rounds) ? e.rounds : null;
      out.promptTokens = Number.isFinite(e.promptTokens) ? e.promptTokens : null;
      out.completionTokens = Number.isFinite(e.completionTokens) ? e.completionTokens : null;
      out.compacted = Number.isFinite(e.compacted) ? e.compacted : null;
      break;
    // The plane stopped an ask at its cap: which axis it ran out on (rounds or
    // tokens), what it had spent, and the shape whose line it was. The build
    // shape throws on from here; a verify-shaped ask escalates instead.
    case "budget":
      out.actor = String(e.actor ?? "");
      out.shape = typeof e.shape === "string" ? e.shape : null;
      out.reason = typeof e.reason === "string" ? e.reason : null;
      out.spent = Number.isFinite(e.spent) ? e.spent : null;
      out.rounds = Number.isFinite(e.rounds) ? e.rounds : null;
      break;
    // A compaction: the prompt size that crossed the line, what survived it
    // (the plane's own poles — persona and brief), and whether the history
    // became a summary or was truncated because the summarizing ask failed.
    case "compact":
      out.actor = String(e.actor ?? "");
      out.mode = typeof e.mode === "string" ? e.mode : null;
      out.before = Number.isFinite(e.before) ? e.before : null;
      out.after = Number.isFinite(e.after) ? e.after : null;
      out.limit = Number.isFinite(e.limit) ? e.limit : null;
      out.summarized = Number.isFinite(e.summarized) ? e.summarized : null;
      out.kept = Number.isFinite(e.kept) ? e.kept : null;
      out.dropped = Number.isFinite(e.dropped) ? e.dropped : null;
      out.summary = preview(e.summary);
      out.ms = Number.isFinite(e.ms) ? e.ms : null;
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
