/**
 * The orchestration graph builder: plan → criteria → phases → runs →
 * parts/agents → artifacts → gates → commits → recap, assembled read-only
 * from local sources.
 *
 * Sources, each strictly read:
 *   - docs/plans/*.md under `repoRoot`   → plan, criterion (checkboxes numbered
 *     positionally C0.. in document order — the same "order is identity" rule
 *     the plan-gate uses), phase (### headers)
 *   - <kitHome>/workflow-runs/<run>/      → run, agent (per actor, with ask and
 *     tool-call counts), artifact (per deliverable id, versioned)
 *   - <kitHome>/router/logs/router.log   → swarm runs with their parts (from
 *     stage events) and the part/deliverable gate edges (from swarm-gate events)
 *   - the dev-decisions calibration store → gate nodes (verdict, provider,
 *     judged count) keyed by input_sha256
 *   - git log in `repoRoot`              → commit nodes
 *   - docs/recaps/*.md under `repoRoot`  → recap nodes
 *
 * Edge kinds: defines (plan→criterion), sequences (plan→phase), dispatches
 * (phase→run), verifies (criterion→run, when the criterion text names the
 * workflow), spawns (run→agent, swarm→part), produces (run→artifact — the
 * journal does not attribute artifacts to individual actors), judged-by
 * (part/swarm→gate), recorded-by (plan/run→commit, subject-text match),
 * summarized-in (run/artifact→recap, text match).
 *
 * Nothing here writes. A missing source is an empty subtree, never an error.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const TEXT_CAP = 400;

function readText(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function listDirs(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return [];
  }
}

function listFiles(p, ext) {
  try {
    return fs.readdirSync(p).filter((f) => f.endsWith(ext)).sort();
  } catch {
    return [];
  }
}

function jsonLines(text) {
  const out = [];
  if (!text) return out;
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {}
  }
  return out;
}

/** Parse one plan markdown file: frontmatter, phases, positionally-numbered criteria. */
function parsePlan(file, text) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  const front = {};
  if (fm) {
    for (const m of fm[1].matchAll(/^(\w+):\s*(.+)$/gm)) front[m[1]] = m[2].trim();
  }
  const slug = front.slug ?? path.basename(file, ".md");
  const title = (/^# (.+)$/m.exec(text)?.[1] ?? slug).slice(0, TEXT_CAP);
  const plan = { id: `plan:${slug}`, kind: "plan", label: slug, title, status: front.status ?? "unknown", source: file };

  const criteria = [];
  const re = /(^|\n)- \[( |x)\] ([^\n]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const text0 = m[3].replace(/\*\//g, "").trim();
    criteria.push({ id: `crit:${slug}:${criteria.length}`, kind: "criterion", label: `C${criteria.length}`, plan: slug, done: m[2] === "x", text: text0.slice(0, TEXT_CAP) });
  }

  const phases = [];
  const pre = /^### (Phase \d+[^\n]*)$/gm;
  const headers = [];
  while ((m = pre.exec(text))) headers.push({ at: m.index, header: m[1] });
  for (let i = 0; i < headers.length; i++) {
    const end = i + 1 < headers.length ? headers[i + 1].at : Math.min(text.length, headers[i].at + 4000);
    const body = text.slice(headers[i].at, end);
    const title0 = headers[i].header.split("—").slice(1).join("—").trim() || headers[i].header;
    phases.push({ id: `phase:${slug}:${i}`, kind: "phase", label: title0.slice(0, 60), plan: slug, text: body.slice(0, TEXT_CAP) });
  }
  return { plan, criteria, phases };
}

/** Parse one workflow-run directory: summary + journal (agents, artifacts). */
function parseRun(runDir, runId) {
  const run = { id: `run:${runId}`, kind: "run", label: runId, workflow: null, ok: null, ms: null, active: true, startedAt: null };
  const agents = new Map();
  const artifacts = [];
  let terminal = false;
  const summary = readText(path.join(runDir, "summary.json"));
  if (summary) {
    try {
      const s = JSON.parse(summary);
      run.workflow = s.name ?? null;
      run.ok = Boolean(s.ok);
      run.ms = Number.isFinite(s.durationMs) ? s.durationMs : null;
      run.startedAt = s.startedAt ?? null;
      run.active = false;
    } catch {}
  }
  const journal = readText(path.join(runDir, "run.jsonl"));
  if (journal) {
    for (const e of jsonLines(journal)) {
      if (e.kind === "run-start") {
        run.workflow = run.workflow ?? e.name ?? null;
        run.startedAt = run.startedAt ?? null;
      } else if (e.kind === "agent") {
        const actor = String(e.actor ?? "?");
        const a = agents.get(actor) ?? { asks: 0, toolCalls: 0 };
        a.asks += 1;
        agents.set(actor, a);
      } else if (e.kind === "tool") {
        const actor = String(e.actor ?? "?");
        const a = agents.get(actor) ?? { asks: 0, toolCalls: 0 };
        a.toolCalls += 1;
        agents.set(actor, a);
      } else if (e.kind === "artifact") {
        artifacts.push({ id: String(e.id ?? "artifact"), version: e.version ?? null, bytes: e.bytes ?? null, path: e.path ?? null });
      } else if (e.kind === "run-done" || e.kind === "run-failed") {
        terminal = true;
        if (e.kind === "run-failed") run.ok = run.ok ?? false;
      }
    }
  }
  run.active = !terminal && !summary;
  return { run, agents, artifacts };
}

/** Parse the router log for swarm runs, parts, and gate edges. */
function parseSwarm(routerLogPath) {
  const swarms = [];
  const byKey = new Map();
  const gateEvents = [];
  for (const e of jsonLines(readText(routerLogPath))) {
    if (e.event === "swarm" && e.stage === "start" && e.sessionKey) {
      const s = { id: `swarm:${e.sessionKey}:${e.ts ?? ""}`, sessionKey: e.sessionKey, startTs: e.ts ?? null, doneTs: null, ok: null, ms: null, parts: [] };
      byKey.set(e.sessionKey, s);
      swarms.push(s);
    } else if (e.event === "swarm" && e.stage === "decompose" && byKey.has(e.sessionKey)) {
      const s = byKey.get(e.sessionKey);
      s.parts = (Array.isArray(e.titles) ? e.titles : []).map((t, i) => ({ pid: `p${i + 1}`, title: String(t).slice(0, 120) }));
    } else if (e.event === "swarm" && e.stage === "done" && byKey.has(e.sessionKey)) {
      const s = byKey.get(e.sessionKey);
      s.doneTs = e.ts ?? null;
      s.ok = e.gateOk !== false;
      s.ms = Number.isFinite(e.ms) ? e.ms : null;
    } else if (e.event === "swarm-gate") {
      gateEvents.push({ label: String(e.label ?? ""), verdict: String(e.verdict ?? ""), ts: e.ts ?? null });
    }
  }
  return { swarms, gateEvents };
}

/** Gate nodes from the dev-decisions calibration store (recent days only). */
function parseGates(decisionsDir) {
  const gates = [];
  const days = [];
  const now = new Date();
  for (let back = 0; back < 3; back++) {
    const d = new Date(now.getTime() - back * 86400000);
    days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  }
  for (const day of days) {
    const y = day.slice(0, 4), mo = day.slice(5, 7), da = day.slice(8, 10);
    for (const e of jsonLines(readText(path.join(decisionsDir, y, mo, da, "events.jsonl")))) {
      if (e.op !== "evidence-gate") continue;
      gates.push({
        id: `gate:${String(e.input_sha256 ?? e.ts ?? gates.length).slice(0, 12)}`,
        kind: "gate",
        label: e.task ?? "evidence-gate",
        verdict: e.verdict ?? null,
        provider: e.provider ?? null,
        judged: e.judged ?? null,
        ts: e.ts ?? null,
      });
    }
  }
  return gates;
}

function gitCommits(repoRoot, count) {
  try {
    const out = execFileSync("git", ["log", "--oneline", `-n`, String(count)], { cwd: repoRoot, encoding: "utf8", maxBuffer: 1024 * 1024 });
    return out.split("\n").filter(Boolean).map((line) => {
      const sp = line.indexOf(" ");
      return { sha: line.slice(0, sp), subject: line.slice(sp + 1) };
    });
  } catch {
    return [];
  }
}

/**
 * Build the orchestration graph. Returns { generatedAt, kitHome, repoRoot,
 * counts, nodes, edges } — every edge endpoint is guaranteed resolvable, and
 * no source is written to.
 */
export function buildGraph(opts = {}) {
  const { kitHome, repoRoot } = opts;
  if (!kitHome || !repoRoot) throw new Error("buildGraph: kitHome and repoRoot are required");
  const plansDir = opts.plansDir ?? path.join(repoRoot, "docs", "plans");
  const recapsDir = opts.recapsDir ?? path.join(repoRoot, "docs", "recaps");
  const routerLogPath = opts.routerLogPath ?? path.join(kitHome, "router", "logs", "router.log");
  const decisionsDir = opts.decisionsDir ?? path.join(os.homedir(), ".local", "share", "dev-decisions", "logs");

  const nodes = [];
  const edges = [];
  const nodeIds = new Set();
  const add = (n) => {
    if (!n || nodeIds.has(n.id)) return;
    nodeIds.add(n.id);
    nodes.push(n);
  };
  const link = (from, to, kind) => {
    if (!from || !to || from === to || !nodeIds.has(from) || !nodeIds.has(to)) return;
    edges.push({ from, to, kind });
  };

  // ── plans ────────────────────────────────────────────────────────────────
  const planTexts = new Map();
  for (const file of listFiles(plansDir, ".md")) {
    if (/^readme/i.test(file)) continue; // a plans-dir README is not a plan
    const text = readText(path.join(plansDir, file));
    if (!text) continue;
    const { plan, criteria, phases } = parsePlan(path.join(plansDir, file), text);
    add(plan);
    planTexts.set(plan.id, text);
    for (const c of criteria) {
      add(c);
      link(plan.id, c.id, "defines");
    }
    for (const p of phases) {
      add(p);
      link(plan.id, p.id, "sequences");
    }
  }

  // ── workflow runs ────────────────────────────────────────────────────────
  const runsDir = path.join(kitHome, "workflow-runs");
  for (const runId of listDirs(runsDir)) {
    const { run, agents, artifacts } = parseRun(path.join(runsDir, runId), runId);
    add(run);
    for (const [actor, a] of agents) {
      add({ id: `agent:${runId}:${actor}`, kind: "agent", label: actor, asks: a.asks, toolCalls: a.toolCalls, run: runId });
      link(run.id, `agent:${runId}:${actor}`, "spawns");
    }
    for (const art of artifacts) {
      add({ id: `artifact:${runId}:${art.id}`, kind: "artifact", label: art.id, bytes: art.bytes, versions: art.version, path: art.path, run: runId });
      link(run.id, `artifact:${runId}:${art.id}`, "produces");
    }
    // dispatches/verifies: phase or criterion text names the workflow
    const wf = (run.workflow ?? "").toLowerCase();
    if (wf) {
      for (const n of nodes) {
        if (n.kind === "phase" && (n.text ?? "").toLowerCase().includes(wf)) link(n.id, run.id, "dispatches");
        else if (n.kind === "criterion" && (n.text ?? "").toLowerCase().includes(wf)) link(n.id, run.id, "verifies");
      }
    }
  }

  // ── swarm runs, parts, gates ─────────────────────────────────────────────
  const { swarms, gateEvents } = parseSwarm(routerLogPath);
  const gates = parseGates(decisionsDir);
  for (const g of gates) add(g);
  const matchGate = (verdict, ts) => {
    if (!ts) return null;
    const t = Date.parse(ts);
    if (!Number.isFinite(t)) return null;
    let best = null;
    let bestD = Infinity;
    for (const g of gates) {
      const gt = g.ts ? Date.parse(g.ts) : NaN;
      if (!Number.isFinite(gt) || g.verdict !== verdict) continue;
      const d = Math.abs(gt - t);
      if (d < bestD) {
        bestD = d;
        best = g;
      }
    }
    return bestD < 5000 ? best : null;
  };
  for (const s of swarms) {
    add({ id: s.id, kind: "run", label: "swarm", workflow: "swarm", ok: s.ok, ms: s.ms, active: s.doneTs === null });
    for (const p of s.parts) {
      add({ id: `part:${s.id}:${p.pid}`, kind: "part", label: p.title });
      link(s.id, `part:${s.id}:${p.pid}`, "spawns");
    }
    const t0 = s.startTs ? Date.parse(s.startTs) : NaN;
    const t1 = s.doneTs ? Date.parse(s.doneTs) : t0 + 3600000;
    for (const ge of gateEvents) {
      const gt = ge.ts ? Date.parse(ge.ts) : NaN;
      if (!Number.isFinite(gt) || gt < t0 - 1000 || gt > t1 + 1000) continue;
      const g = matchGate(ge.verdict, ge.ts);
      if (!g) continue;
      const pm = /^part-(.+?)(-r\d+)?$/.exec(ge.label);
      if (pm) {
        const partNode = `part:${s.id}:${pm[1]}`;
        if (nodeIds.has(partNode)) link(partNode, g.id, "judged-by");
      } else if (ge.label.startsWith("deliverable")) {
        link(s.id, g.id, "judged-by");
      }
    }
  }

  // ── commits ──────────────────────────────────────────────────────────────
  for (const c of gitCommits(repoRoot, opts.commitCount ?? 40)) {
    const id = `commit:${c.sha.slice(0, 12)}`;
    add({ id, kind: "commit", label: c.subject.slice(0, 90), sha: c.sha });
    const subject = c.subject.toLowerCase();
    for (const n of nodes) {
      if (n.kind === "plan" && subject.includes(n.label.toLowerCase())) link(n.id, id, "recorded-by");
      else if (n.kind === "run" && n.workflow && subject.includes(n.workflow.toLowerCase())) link(n.id, id, "recorded-by");
    }
  }

  // ── recaps ───────────────────────────────────────────────────────────────
  for (const file of listFiles(recapsDir, ".md")) {
    const text = (readText(path.join(recapsDir, file)) ?? "").toLowerCase();
    const id = `recap:${file.replace(/\.md$/, "")}`;
    add({ id, kind: "recap", label: file.replace(/\.md$/, "") });
    for (const n of nodes) {
      if (n.kind === "run" && n.workflow && text.includes(n.workflow.toLowerCase())) link(n.id, id, "summarized-in");
      else if (n.kind === "artifact" && n.label && n.label.length > 4 && text.includes(n.label.toLowerCase())) link(n.id, id, "summarized-in");
    }
  }

  const byKind = {};
  for (const n of nodes) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
  const byEdgeKind = {};
  for (const e of edges) byEdgeKind[e.kind] = (byEdgeKind[e.kind] ?? 0) + 1;
  return {
    generatedAt: new Date().toISOString(),
    kitHome,
    repoRoot,
    counts: { nodes: nodes.length, edges: edges.length, byKind, byEdgeKind },
    nodes,
    edges,
  };
}
