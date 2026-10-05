/**
 * The workflow runtime engine.
 *
 * A workflow is a TypeScript file under `workflows/` that uses the documented
 * surface (docs/features/workflow-runtime.md): `agent(...).ask<T>()`, `phase`,
 * `log`, `report`, `artifact.*`, `files.*`, `git.*`, `world.run`, `args`.
 * This module loads that file, binds the surface as globals, runs it, and
 * journals everything it did.
 *
 * Loading is by text transform, not by framework: the file is wrapped in one
 * async function (its top-level `return` becomes that function's result) and
 * each `.ask<T>` call site is annotated with the schema parsed from the
 * workflow's own type text, because TypeScript erases type arguments at
 * runtime. Nothing about the format is hard-coded beyond the API surface — a
 * file that sticks to the surface runs as-is, with or without a metadata
 * header.
 *
 * Every model call an agent makes goes through the router's own
 * /v1/chat/completions, so a workflow run is metered in the same usage ledger
 * as every other request the router serves, and inherits its failover.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseHeader, validateArgs, extractInterfaces } from "./meta.mjs";
import { coerceResult, extractJson } from "./coerce.mjs";
import { WorkflowRunError, slug, freeRunDir, KIT_WORKFLOW_RUNS, makeArtifacts } from "./runstate.mjs";
// The kit's CLI reads the runs directory through the engine's public export, so
// the symbol stays named here even though the implementation moved out.
export { KIT_WORKFLOW_RUNS };
import { chatCompletion } from "./transport.mjs";
import { gitChangedFiles, gitDiff, gitStatus, gitLog } from "./gitworld.mjs";
import { annotateAskSites, parseTypeText } from "./schema.mjs";
import { buildTools, worldRun, resolveGrants, CAPABILITIES } from "./tools.mjs";
import { fetchUrl, runFormatHooks } from "./services.mjs";
import {
  renderContract,
  renderBrief,
  measureEnvironment,
  makeSys1Classifier,
  makeJudgingClassifier,
  validateContract,
  validatePartResult,
  makeRunMemory,
  judgeContract,
  gateVerdict,
  gateNeedsFixup,
  settleMembers,
  COMPETITION_MINIMUM,
} from "./harness.mjs";
import { buildUnderCheckpoint, takeCheckpoint, restoreCheckpoint } from "./checkpoint.mjs";
import {
  resolveBudget,
  measureMessages,
  recordUsage,
  recordEstimatedUsage,
  ensureRoom,
  AGENT_MAX_ROUNDS,
  fmtTokens,
} from "./context.mjs";
// The kit's CLI prints token counts off the events this module emits, so the
// formatter stays on the engine's surface even though it moved with the policy.
export { fmtTokens };

// A delegated sub-agent starts with nothing: no conversation history, no
// sibling context, one task and its own contract. Its system prompt says so,
// because an agent that assumes it can see its parent's work will spend rounds
// trying.
const SUBAGENT_SYSTEM =
  "You are a sub-agent. You were handed exactly one self-contained task by another agent, and you see none of its " +
  "context — do not ask for it, do not look for it. Do the task, then call submit_result with your answer. If the " +
  "task cannot be done as given, say why plainly rather than working around it. You cannot delegate further.";

/**
 * Run one workflow file.
 *
 * opts: args, workdir (where agents read/write; default cwd), outDir (where the
 * run's journal and artifacts live), model (router profile or provider/model;
 * default "hard"), baseUrl + token (the router to route agent calls through),
 * grants (comma-separated capability grants), allowCommands (extra executables),
 * answers (owner answers for escalations), onEvent.
 */
export async function runWorkflow(file, opts = {}) {
  const startedAt = Date.now();
  const source = fs.readFileSync(file, "utf8");
  const name = path.basename(file).replace(/\.(m?ts|js)$/, "");
  const meta = parseHeader(source, name);
  if (opts.args) {
    const problems = validateArgs(meta, opts.args);
    if (problems.length) throw new WorkflowRunError(`${name}: ${problems.join("; ")}`);
  }

  const workdir = path.resolve(opts.workdir ?? process.cwd());
  fs.mkdirSync(workdir, { recursive: true });
  // A caller that names its own outDir gets exactly that. Otherwise the run id
  // is second-granular, so two runs started in the same second would share a
  // directory and the second would empty the first's journal — the journal is
  // the durable record of a run, so a run must never be able to erase another.
  const runDir = opts.outDir ?? freeRunDir(`${slug(startedAt)}-${name}`);
  fs.mkdirSync(path.join(runDir, "artifacts"), { recursive: true });
  const journalPath = path.join(runDir, "run.jsonl");
  fs.writeFileSync(journalPath, "");

  const baseUrl = (opts.baseUrl ?? "http://127.0.0.1:8300").replace(/\/+$/, "");
  const token = opts.token ?? "local-auto-router";
  const model = opts.model ?? "hard";

  const state = {
    name,
    journal: [],
    phases: new Set(),
    artifacts: {},
    reportCount: 0,
    agentCalls: 0,
    toolCalls: 0,
    // What the run's model calls cost, as the upstreams reported it. `estimatedCalls`
    // counts the calls a provider left unmeasured, so a run's token totals can be
    // read knowing which part of them is a report and which is the plane's own
    // four-chars-a-token measure.
    promptTokens: 0,
    completionTokens: 0,
    estimatedCalls: 0,
    compactions: 0,
    providerToolsOk: true,
  };

  const journal = (event) => {
    const row = { t: Date.now() - startedAt, ...event };
    state.journal.push(row);
    try {
      fs.appendFileSync(journalPath, JSON.stringify(row) + "\n");
    } catch {
      /* a full disk must not take the run down */
    }
  };

  const emit = (event) => {
    journal(event);
    opts.onEvent?.(event);
  };

  // Grants resolve before anything runs, so an unknown capability fails at launch
  // rather than mid-run — and it fails as a real run, not a bare throw: journal
  // line, summary and runDir, so `kit workflows last` explains itself.
  let grants;
  try {
    grants = resolveGrants({ grants: opts.grants, allowCommands: opts.allowCommands });
  } catch (e) {
    const err = new WorkflowRunError(`${name}: ${e.message}`);
    err.runDir = runDir;
    emit({ kind: "warn", message: e.message });
    emit({ kind: "run-failed", error: e.message });
    fs.writeFileSync(
      path.join(runDir, "summary.json"),
      JSON.stringify(
        {
          name,
          runDir,
          file,
          workdir,
          model,
          startedAt: new Date(startedAt).toISOString(),
          durationMs: Date.now() - startedAt,
          phases: [],
          reports: 0,
          agentCalls: 0,
          toolCalls: 0,
          tokens: { promptTokens: 0, completionTokens: 0, estimatedCalls: 0, compactions: 0 },
          artifacts: [],
          journal: journalPath,
          ok: false,
          result: null,
          error: e.message,
        },
        null,
        2,
      ) + "\n",
    );
    throw err;
  }

  // ── the module text: wrap in a function, annotate typed asks ──────────────
  const annotated = annotateAskSites(source);
  const interfaces = extractInterfaces(source);
  const schemas = annotated.types.map((text) => {
    const schema = parseTypeText(text, interfaces);
    if (!schema) {
      emit({ kind: "warn", message: `could not parse the type \`${text.slice(0, 80)}\` — this ask degrades to lenient JSON` });
    }
    return schema;
  });
  const preamble = schemas
    .map((s, i) => `const __wfType${i} = ${s ? JSON.stringify(s) : "null"};`)
    .join("\n");
  const moduleText = `${preamble}\nexport default async function __wfRun() {\n${annotated.source}\n}`;
  const modulePath = path.join(runDir, "module.mts");
  fs.writeFileSync(modulePath, moduleText);

  // ── the API surface, bound as globals the module resolves to ──────────────
  // The run's fact store: the plane's own record of what it decided and
  // measured, which the workflow writes and reads in full (world.remember,
  // world.facts) and a scoped agent reads through its own part's window (the
  // recall tool). One store per run — it dies with the run, and the journal is
  // the durable record.
  const memory = makeRunMemory((row) => emit(row));
  // One place decides what a tool's journal line carries, so the line an agent's
  // recall produces and the line the plane's own read produces are the same
  // shape — a probe that reads `world.recallAs` asserts what an agent gets.
  // A recall's audit data is the whole point of the line — kinds queried, fact
  // ids returned, bytes rendered — so it rides along here rather than being
  // dropped by the shaper every other tool's fields fit through.
  const recordTool = (e) =>
    emit({
      kind: "tool",
      actor: e.tool ?? e.command ?? "?",
      args: e.args,
      grant: e.grant ?? null,
      refused: e.refused ?? null,
      ...(Number.isFinite(e.facts) ? { facts: e.facts, ids: e.ids, bytes: e.bytes } : {}),
    });
  const tools = buildTools(workdir, (e) => {
    state.toolCalls++;
    recordTool(e);
  }, {
    grants: opts.grants,
    allowCommands: opts.allowCommands,
    netDomains: opts.netDomains,
    memory,
    // The registry's service lines belong in the run journal as their own kind,
    // so the tool callback — which counts tool calls — is not the destination.
    runJournal: journal,
    onEscalate: async (question, evidence, topic) => {
      emit({ kind: "escalation", actor: "?", question, evidence, topic: topic ?? null });
      return answerEscalation(question, evidence, topic ?? null, opts);
    },
    // The spawner an agent's `delegate` tool calls. It lives here rather than in
    // tools.mjs because it needs makeAgent: a child is a real agent of this run,
    // with the same grants and the same workspace, and its calls count against
    // the run's accounting and the parent's.
    onDelegate: async (parent, { task, contract: childContract = null } = {}) => {
      const parentLabel = String(parent?.label ?? "unknown");
      const childLabel = `${parentLabel} → delegate`;
      const started = Date.now() - startedAt;
      emit({ kind: "delegate", op: "spawn", parent: parentLabel, child: childLabel, task: String(task ?? "").slice(0, 200), depth: Number(parent?.depth ?? 0) + 1 });
      const child = makeAgent(
        childLabel,
        { system: SUBAGENT_SYSTEM, contract: childContract ?? null },
        // `depth` overrides the value the spread carried: the child's descriptor
        // must say it sits one level down, or the spawner's own depth check would
        // read the run's zero and the cap would rest on the stripped surface alone.
        { ...agentCalls, tools: tools.childSurface(), depth: Number(parent?.depth ?? 0) + 1 },
      );
      let result;
      try {
        result = await child.ask(String(task ?? ""));
      } catch (e) {
        emit({ kind: "delegate", op: "failed", parent: parentLabel, child: childLabel, reason: String(e?.message ?? e).slice(0, 200) });
        throw e;
      }
      // The child's calls land on the parent that spent them: delegation is a
      // budget transfer, not a fresh allowance — tokens included, so a parent
      // that delegated its whole task is charged for what the child spent.
      const before = parent?.stats;
      if (before) {
        before.asks += child.stats.asks;
        before.toolCalls += child.stats.toolCalls;
        before.promptTokens += child.stats.promptTokens;
        before.completionTokens += child.stats.completionTokens;
        before.compactions += child.stats.compactions;
      }
      emit({
        kind: "delegate",
        op: "done",
        parent: parentLabel,
        child: childLabel,
        ms: Date.now() - startedAt - started,
        asks: child.stats.asks,
        toolCalls: child.stats.toolCalls,
        result: String(result?.built ?? result?.summary ?? result ?? "").slice(0, 120),
      });
      return result;
    },
  });

  const agentCalls = { baseUrl, token, model, tools, memory, state, opts, emit, journal, depth: Number(opts.agentDepth ?? 0) };

  const api = {
    args: opts.args ?? {},
    agent: (name_, persona) => makeAgent(name_, persona, agentCalls),
    log: (message) => emit({ kind: "log", message: String(message) }),
    phase: (name_) => {
      state.phases.add(name_);
      emit({ kind: "phase", phase: name_ });
      // A phase boundary is a run fact any agent may read, so it joins the
      // store like the decisions and measurements do — a builder that recalls
      // after a boundary sees which phase the run is in.
      memory.remember({ kind: "phase", fact: String(name_) });
      opts.onEvent?.({ kind: "phase-display", phase: name_ });
    },
    report: (item, artifactId) => {
      state.reportCount++;
      emit({ kind: "report", item, artifactId: artifactId ?? null });
    },
    artifact: makeArtifacts(runDir, workdir, emit, state),
    files: {
      glob: (pattern) => tools.impls.list_files({ pattern }),
      read: (rel) => tools.impls.read_file({ path: rel }),
      grep: (pattern, glob) => tools.impls.search_files({ pattern, glob }),
    },
    git: {
      changedFiles: (base) => gitChangedFiles(workdir, base),
      diff: (base, rel) => gitDiff(workdir, base, rel),
      status: () => gitStatus(workdir),
      log: (count = 20) => gitLog(workdir, count),
    },
    world: {
      run: (cmd, args = []) => worldRun(cmd, args, workdir, grants, journal),
      // Per-part checkpoint and rollback. A part's builders write straight into
      // the workspace, so a part that fails mid-build leaves debris the champion
      // then integrates; the snapshot and the restore are the plane's, journalled
      // as their own event kinds, and they cover the part's declared paths and
      // nothing else — the exclusive ownership the dispatch gate validates is
      // the boundary a rollback restores to. Both are promises, like every other
      // effect on this surface, so a refusal (a path outside the workspace)
      // reaches a caller's catch rather than its mouth.
      checkpoint: ({ label, paths }) => Promise.resolve().then(() => takeCheckpoint(workdir, journal, { label, paths })),
      rollback: (snapshot) => Promise.resolve().then(() => restoreCheckpoint(workdir, journal, snapshot)),
      // The run's fact store. `remember` is how the coordination layer records
      // what it decided or measured, so an agent can ask about it later instead
      // of guessing or burning a round to re-derive it; `facts` is the plane's
      // own read (unscoped — the scope is what hides a sibling's facts *from
      // agents*, not from the plane that dispatched them). Agents never write:
      // a model that could record run facts could rewrite the run's own record
      // of itself.
      remember: (fact) => memory.remember(fact),
      facts: (opts) => memory.facts(opts),
      // The exact recall closure the engine hands the agent scoped to `part`,
      // journalled through the same tool-line shaper the agent's own recall
      // uses, so a probe that reads it asserts the shape an agent receives.
      // The plane may call it — it dispatched that agent — and it is on the
      // workflow surface so a probe can prove the boundary holds rather than
      // waiting for a model to test it: a scope that stopped refusing a sibling
      // would only ever show up as an agent that stopped asking.
      recallAs: (part, args) => memory.recallTool(part ? { part: String(part) } : null, recordTool)(args ?? {}),
      // The same bounded fetch an agent's fetch_url performs. Workflows reach it
      // directly so a research workflow can cite what it actually retrieved
      // instead of asking a model to remember a page. The grant and the domain
      // allowlist are separate gates: the grant says the run may use the network
      // at all, the allowlist says which hosts, and an allowlist without a grant
      // buys nothing.
      fetch: async (url) => {
        if (!grants.has("net-fetch")) {
          const refusal = `capability not granted in this run: net-fetch — ${CAPABILITIES["net-fetch"].what} — rerun with \`--grant net-fetch\``;
          journal({ kind: "command", command: "fetch_url", args: [String(url)], grant: "net-fetch", refused: refusal });
          throw new Error(refusal);
        }
        journal({ kind: "command", command: "fetch_url", args: [String(url)], grant: "net-fetch" });
        const result = await fetchUrl(url, { allowlist: opts.netDomains ?? [] });
        // A refused fetch reports itself in the result rather than throwing, so
        // the grant line above alone would read as a completed fetch.
        if (!result.ok) {
          journal({ kind: "command", command: "fetch_url", args: [String(url)], grant: "net-fetch", refused: result.reason });
        }
        return result;
      },
      // The same bounded dev server an agent's start_dev_server starts, plus the
      // poll and stop that keep it. A run that ends stops everything it started
      // however the exit happened, so nothing outlives the run by accident.
      server: {
        start: (spec = {}) => tools.impls.start_dev_server(spec),
        poll: (handle, offset = 0) => tools.processes.poll(String(handle), offset),
        stop: (handle) => tools.impls.stop_dev_server({ handle: String(handle) }),
      },
      // The same bounded background command an agent's start_command starts.
      // A workflow that needs one long-running command — a slow test suite, a
      // watcher — gets the handle surface rather than a tool round held open
      // for the whole run.
      command: {
        start: (spec = {}) => tools.impls.start_command(spec),
        poll: (handle, offset = 0) => tools.impls.poll_command({ handle: String(handle), offset }),
        stop: (handle) => tools.impls.stop_command({ handle: String(handle) }),
      },
      // What this run is allowed. A workflow that needs net-fetch or package
      // installs asks here and escalates a missing grant up front, instead of
      // discovering a refusal in the middle of the work.
      grants: () => ({
        caps: grants.summary(),
        domains: [...(opts.netDomains ?? [])],
        has: (cap) => grants.has(cap),
      }),
      // The workspace's own format/lint scripts, run pre-verification, each a
      // fixed-argv npm invocation under the test-runner grant. A failing hook is
      // reported in the result, not thrown — a lint failure is a finding the part
      // needs, not a reason to abandon the run.
      format: (scripts) =>
        runFormatHooks(workdir, {
          run: (cmd, args) => worldRun(cmd, args, workdir, grants, journal),
          ...(scripts ? { scripts } : {}),
        }),
    },
    // ── the control plane's surface: assembly, not content ────────────────────
    // A workflow declares what its agents get (stack, layout, ownership); the
    // plane renders it and journals it, so no workflow assembles a brief by
    // hand. measureEnvironment measures through the run's own command
    // allowlist; renderBrief renders the harness block; renderContract renders
    // the per-part contract the engine also appends to contracted agents' asks.
    // validateContract/judgeContract are the dispatch gate: deterministic
    // rejection in code, then the two-head sys1 judgment — one implementation
    // shared with the swarm, so a workflow that decomposes gets the same gate.
    measureEnvironment,
    renderBrief,
    renderContract,
    validateContract,
    // The gate's other side: a part's result is checked against the contract it
    // was dispatched with before the champion is told it was built. Same
    // deterministic-only rule, same injected side effect — the caller supplies
    // `exists` so a claimed file is checked on disk, not on the model's word.
    validatePartResult,
    judgeContract,
    gateVerdict,
    gateNeedsFixup,
    // The workspace half of the same discipline: a part's build runs under a
    // checkpoint of its own declared paths, so a part that fails mid-build
    // takes its tree with it instead of leaving debris for the champion to
    // integrate. The plane owns it — one implementation, shared with any
    // workflow that decomposes into parts.
    buildUnderCheckpoint,
    // Settling a set of parallel members. One member's failure no longer
    // discards its siblings: every member runs to the end, and the caller learns
    // which came back, which failed and why, and — against the minimum it
    // declared — whether what survived is enough for the next step. A workflow
    // that fans out to a single champion has a comparison it cannot make, and
    // the plane would rather say so than let the workflow crown it.
    settleMembers,
    COMPETITION_MINIMUM,
    // ── sys1: the judgment primitive ──────────────────────────────────────────
    // Every judgment event a workflow makes routes through sys1: a bounded
    // classification (choice/noul/score heads) POSTs to the local gateway with
    // an inline task_spec — the same contract the router's judge uses, and the
    // sanctioned pattern for Node consumers. Fail-open by contract: an
    // unreachable gateway or missing token degrades to {ok:false} and the
    // workflow applies its own fallback, never a hang. Calls log into sys1's
    // own JSONL store (log:true) so per-head floors can be fitted later.
    // Long-context generations (compare these solutions, integrate these
    // parts) are NOT this primitive — those stay agent asks; state the
    // exception when a judgment point skips sys1.
    sys1: {
      // The transport is the plane's (makeSys1Classifier in harness.mjs); the
      // journal line is the run's. One transport, one audit trail.
      classify: (() => {
        const transport = makeSys1Classifier();
        return async (spec, text) => {
          journal({ kind: "command", command: "sys1.classify", args: [String(spec?.id ?? "task")] });
          return transport(spec, text);
        };
      })(),
      // The judging classifier the plane's gates ride: dev-decisions first
      // (rows in the shared calibration store), raw sys1 as the recorded
      // fallback. A workflow passes this where it passed sys1.classify
      // before — judgeContract(p, task, sys1.judge) — and gains the store
      // without changing shape.
      judge: (() => {
        const transport = makeJudgingClassifier(
          (cmd, args) => world.run(cmd, args),
          makeSys1Classifier()
        );
        return async (spec, text) => {
          journal({ kind: "command", command: "sys1.judge", args: [String(spec?.id ?? "task")] });
          return transport(spec, text);
        };
      })(),
    },
  };

  for (const [k, v] of Object.entries(api)) globalThis[k] = v;

  // ── load and run ─────────────────────────────────────────────────────────
  let mod;
  try {
    mod = await import(pathToFileURL(modulePath).href);
  } catch (e) {
    // A workflow that will not load is a file the author can fix, but only if
    // they are told where: Node's frame names the transformed module's line,
    // which maps 1:1 to the source file's line offset by the preamble.
    const detail = String(e?.message ?? e).trim();
    const where = String(e?.stack ?? "").split("\n").find((l) => l.includes("module.mts"));
    const line = where ? Number(/\/(?:module\.mts):(\d+)/.exec(where)?.[1]) : null;
    const inSource = line ? line - (moduleText.split("\n").length - annotated.source.split("\n").length) : null;
    throw new WorkflowRunError(
      `${name}: failed to load — ${detail}` +
      `\n  at ${modulePath}${line ? `:${line}` : ""}` +
      (inSource ? `\n  in ${file}:${inSource} — check that line in the workflow file` : "") +
      `\n  the transform wraps the file in one async function, so a syntax error usually means a statement the wrapper cannot continue`
    );
  }
  emit({ kind: "run-start", name, workdir, model, args: api.args });

  let result = null;
  let error = null;
  try {
    result = await mod.default();
  } catch (e) {
    error = e;
  }
  // A failed run's journal is the diagnosis — make sure the caller can find it.
  if (error && typeof error === "object") {
    try {
      error.runDir = runDir;
    } catch {
      /* a frozen error object must not mask the original failure */
    }
  }

  const summary = {
    name,
    runDir,
    file,
    workdir,
    model,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    phases: [...state.phases],
    reports: state.reportCount,
    agentCalls: state.agentCalls,
    toolCalls: state.toolCalls,
    // The run's own token accounting, so a workflow's cost is a fact in the
    // summary rather than something reconstructed from a provider's dashboard.
    tokens: {
      promptTokens: state.promptTokens,
      completionTokens: state.completionTokens,
      estimatedCalls: state.estimatedCalls,
      compactions: state.compactions,
    },
    artifacts: Object.entries(state.artifacts).map(([id, versions]) => ({ id, versions })),
    journal: journalPath,
    ok: !error,
    result: result ?? null,
    error: error ? String(error?.message ?? error) : null,
    // The stack is the diagnosis: a message like "cannot read X of null" names
    // the symptom, not the line, and a run that fails 20 minutes in is not
    // cheap to reproduce.
    stack: error?.stack ? String(error.stack).split("\n").slice(0, 12) : null,
  };
  fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  // A run that ends leaves nothing listening: dev servers die here, not whenever
  // their lifetime cap happens to expire.
  const stopped = tools.processes?.stopAll() ?? 0;
  if (stopped) emit({ kind: "log", message: `stopped ${stopped} service process${stopped > 1 ? "es" : ""} this run started` });
  emit(error ? { kind: "run-failed", error: summary.error } : { kind: "run-done", durationMs: summary.durationMs });

  if (error) throw error;
  return { summary, runDir, result };
}

// ── agents ──────────────────────────────────────────────────────────────────

/**
 * An agent's `persona` may carry a `contract` — the plane's declaration of
 * what this agent owns ({files, acceptance, provides, verification, extra}).
 * The contract rides with EVERY ask, rendered into the instructions by the
 * plane's renderer, so a builder asked twice gets the same boundary twice; and
 * it is journaled once at the first ask, so a dispatch is auditable after the
 * fact even though the block itself repeats. An agent without a contract is
 * unchanged: a persona string, a {system} object, or an agent whose content is
 * the workflow's own business.
 *
 * A persona may also carry `scope` ({part}) — the window into the run's fact
 * store this agent reads through. It is not a convenience: the scope is baked
 * into the recall tool's closure per agent, so a sibling's part is unreachable
 * by argument and a concurrent agent's window cannot leak into this one. An
 * agent with no scope reads the run's public facts only (a champion, a bare
 * persona), which is why a champion that needs per-part facts takes them from
 * world.facts and renders them into its own instructions.
 */
function makeAgent(name, persona, ctx) {
  const system = typeof persona === "string" ? persona : persona?.system ?? "";
  const contract = (persona && typeof persona === "object" ? persona.contract : null) ?? null;
  const scope = (persona && typeof persona === "object" ? persona.scope : null) ?? null;
  // The cap this agent's asks run under, from its declared shape. Resolved once
  // per agent: the shape belongs to the agent, and a workflow that needs both a
  // build line and a verification line declares two agents — which is what it
  // already does (a champion builds, a judge judges).
  const budget = resolveBudget(persona, ctx.opts);
  const messages = system ? [{ role: "system", content: system }] : [];
  // The agent's own accounting. `promptTokens`/`completionTokens` are what the
  // upstream reported across this agent's calls (a sum, because every round
  // resends the history — that is the spend); `peak` is the largest single
  // prompt, which is what runs into a context window. `compactions` counts the
  // times the plane had to summarize this agent's history to keep it going.
  const stats = { asks: 0, toolCalls: 0, promptTokens: 0, completionTokens: 0, peakPromptTokens: 0, compactions: 0 };
  const label = name || "anonymous";
  let contractRecorded = false;
  // One tools object per agent rather than a shared impl overwritten per ask:
  // agents run concurrently, and a scope or a parent descriptor written into a
  // shared impl would be whichever agent asked last.
  const mayDelegate = Number(ctx.depth ?? 0) === 0 && typeof ctx.tools.delegateFor === "function";
  const tools =
    (scope && ctx.memory && typeof ctx.tools.recallFor === "function") || mayDelegate
      ? {
          defs: ctx.tools.defs,
          impls: {
            ...ctx.tools.impls,
            ...(scope && ctx.memory && typeof ctx.tools.recallFor === "function"
              ? { recall: ctx.tools.recallFor(scope) }
              : {}),
            ...(mayDelegate
              ? { delegate: ctx.tools.delegateFor({ label, stats, scope, depth: Number(ctx.depth ?? 0) }) }
              : {}),
          },
        }
      : ctx.tools;
  return {
    name: label,
    // Exposed so a parent can add its child's calls to its own accounting.
    stats,
    async ask(instructions, schema) {
      stats.asks++;
      ctx.state.agentCalls++;
      if (contract && !contractRecorded) {
        contractRecorded = true;
        ctx.emit({
          kind: "contract",
          actor: label,
          title: contract.title ?? null,
          files: (contract.files ?? []).map((f) => String(f)).slice(0, 20),
          acceptance: (contract.acceptance ?? []).length,
          provides: String(contract.provides ?? "").slice(0, 200),
        });
      }
      const brief = contract
        ? `${String(instructions)}\n\n${renderContract(contract)}`
        : String(instructions);
      messages.push({ role: "user", content: brief });
      // The ask's own accounting line: what this ask cost, in tokens and rounds,
      // journaled at the ask's end — including the end of one that failed,
      // because a run that burned 60k tokens before dying is exactly the run
      // whose journal has to say so.
      const mark = { prompt: stats.promptTokens, completion: stats.completionTokens, compactions: stats.compactions };
      // The ask's own cap rides along with its mark, so the loop knows the line
      // the ask is running under without the ask re-deriving it.
      const acct = { rounds: 0, mark, budget };
      let value;
      try {
        value = await askLoop(messages, schema ?? null, { ...ctx, tools }, label, stats, acct);
      } finally {
        ctx.emit({
          kind: "account",
          actor: label,
          ask: stats.asks,
          shape: budget.shape,
          budget: { rounds: budget.rounds, tokens: budget.tokens },
          rounds: acct.rounds,
          promptTokens: stats.promptTokens - mark.prompt,
          completionTokens: stats.completionTokens - mark.completion,
          compacted: stats.compactions - mark.compactions,
        });
      }
      messages.push({ role: "assistant", content: typeof value === "string" ? value : JSON.stringify(value) });
      return value;
    },
  };
}

async function askLoop(messages, schema, ctx, label, stats, acct = null) {
  const { tools, emit } = ctx;
  // The ask's cap, resolved per ask (see makeAgent's ask): rounds on one axis,
  // prompt tokens on the other, because an ask that resends its history every
  // round spends quadratically and a round count alone cannot see it.
  const budget = acct?.budget ?? { shape: "build", rounds: AGENT_MAX_ROUNDS, tokens: 0, atCap: "throw" };
  const defs = [...tools.defs];
  if (schema) {
    defs.push({
      type: "function",
      function: {
        name: "submit_result",
        description:
          "Return your final answer for this task. Call it exactly once, when you are done, with every field the result shape requires.",
        parameters: schema,
      },
    });
  }
  const guidance = messages[0]?.role === "system" ? `${messages[0].content}\n\nWhen your task is complete, call submit_result exactly once with your answer.` : "When your task is complete, call submit_result exactly once with your answer.";
  if (schema && messages[0]?.role === "system") messages[0] = { role: "system", content: guidance };
  else if (schema) messages.unshift({ role: "system", content: guidance });

  // Where the brief sits, taken now — the loop has just opened and this ask's
  // brief is the last message, which makes compaction able to keep exactly the
  // plane-owned message instead of guessing at it later.
  if (acct) acct.briefIdx = messages.length - 1;

  let jsonNudges = 0;
  let lastTool = "none";
  for (let round = 1; round <= budget.rounds; round++) {
    // Before the round, not after: an ask whose history has grown past the line
    // is compacted here, so the model is never handed a prompt the plane could
    // have shrunk — and the ask continues instead of dying at the provider's
    // window. See compactContext for what survives and what is summarized.
    await ensureRoom(ctx, messages, label, stats, acct);
    // The token line, checked at the same point: an ask that has already spent
    // its ceiling does not get another round on top of it, however many rounds
    // remain. Each round resends the whole history, so the sum is the spend and
    // the wall is a token number, not a round number.
    if (budget.tokens > 0 && stats.promptTokens - acct.mark.prompt >= budget.tokens) {
      await capReached(ctx, label, stats, acct, budget, `the ${fmtTokens(budget.tokens)}-token line`, lastTool);
    }
    const sent = measureMessages(messages);
    const data = await chatCompletion(ctx, messages, defs, schema, label);
    if (acct) acct.rounds = round;
    const choice = data?.choices?.[0];
    const message = choice?.message;
    if (!message) throw new WorkflowRunError(`${label}: the router returned no message`);
    messages.push(message);
    if (!recordUsage(ctx, stats, data.usage)) recordEstimatedUsage(ctx, stats, sent, message);
    if (acct) acct.lastPrompt = Number(data.usage?.prompt_tokens) > 0 ? Number(data.usage.prompt_tokens) : sent;

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (toolCalls.length) {
      for (const call of toolCalls) {
        const fn = call.function ?? {};
        lastTool = fn.name ?? "unknown";
        let args = {};
        try {
          args = fn.arguments ? JSON.parse(fn.arguments) : {};
        } catch {
          args = {};
        }
        let content;
        if (fn.name === "submit_result") {
          return coerceResult(args, schema);
        }
        const impl = tools.impls[fn.name];
        if (!impl) {
          content = `unknown tool: ${fn.name}`;
        } else {
          stats.toolCalls++;
          ctx.state.toolCalls++;
          emit({ kind: "tool", actor: label, tool: fn.name, args });
          try {
            content = serializeToolResult(await impl(args));
          } catch (e) {
            content = `error: ${String(e?.message ?? e)}`;
          }
        }
        messages.push({ role: "tool", tool_call_id: call.id, content });
      }
      continue;
    }

    // No tool calls: either the final text, or a structured answer the model
    // wrote inline instead of calling submit_result.
    const text = typeof message.content === "string" ? message.content : "";
    if (!schema) return text;
    const parsed = extractJson(text);
    if (parsed !== null) return coerceResult(parsed, schema);
    if (jsonNudges++ >= 2) return text;
    messages.push({
      role: "user",
      content: "Return your answer by calling submit_result with the result fields.",
    });
  }
  await capReached(ctx, label, stats, acct, budget, `${budget.rounds} tool rounds`, lastTool);
}

/**
 * An ask reached its cap. What happens next is the shape's policy, and the
 * difference is the point: a build ask whose work was merely too big for its
 * line throws with the round count, so the caller can decompose it (that is what
 * adversarial-solve's cap recovery does). A verification or loop-shaped ask has
 * nothing to decompose — splitting a verdict in half does not produce two
 * verdicts — so the plane asks the owner instead, escalates with the stuck
 * reason, and ends the ask. In both shapes the ask never returns a result it
 * did not earn: either it settled, or the journal says why it did not.
 */
async function capReached(ctx, label, stats, acct, budget, reason, lastTool) {
  const spent = acct ? stats.promptTokens - acct.mark.prompt : stats.promptTokens;
  const rounds = acct?.rounds ?? 0;
  const where = `${label} spent ${reason} and ${fmtTokens(spent)} in prompt tokens without settling (last tool: ${lastTool})`;
  if (budget.atCap === "stuck") {
    const question =
      `${where}. Its shape is "${budget.shape}", which draws a smaller line than a build ask ` +
      `(${budget.rounds} round(s) / ${fmtTokens(budget.tokens)} tokens): stuck looks different from big. ` +
      `What should happen to this ask?`;
    const evidence =
      `shape ${budget.shape}; ${reason}; ${fmtTokens(spent)} prompt tokens across ${rounds} round(s); ` +
      `last tool ${lastTool}; the ask never called submit_result`;
    ctx.emit({ kind: "escalation", actor: label, question, evidence, topic: "stuck" });
    const answer = await answerEscalation(question, evidence, "stuck", ctx.opts);
    throw new WorkflowRunError(
      `${label}: the ${budget.shape} ask is stuck, not big — ${where}. ` +
        `The plane escalated with the stuck reason rather than decomposing it. ` +
        `The owner's answer: ${answer}`
    );
  }
  ctx.emit({ kind: "budget", actor: label, shape: budget.shape, reason, spent, rounds });
  throw new WorkflowRunError(
    `${label}: the ask did not settle after ${reason} (last tool: ${lastTool}) — ` +
      (reason.endsWith("tool rounds")
        ? `the cap guards against a runaway loop; narrow the instructions or split the ask`
        : `the token ceiling is a cost guard, not a loop guard; narrow the ask or re-shape it`)
  );
}

function serializeToolResult(value) {
  if (value === undefined) return "(no output)";
  if (typeof value === "string") return value;
  return JSON.stringify(value).slice(0, 64 * 1024);
}

// ── escalations ─────────────────────────────────────────────────────────────

/**
 * Escalate-to-owner, ranked: the escalation's structured TOPIC matched against
 * the --answers table (deterministic — a topic is a key the operator can see,
 * not a substring the question happens to contain), then the loose
 * question-substring match, then the operator's terminal, then a recorded
 * no-owner-available answer. A run that never blocks on an unanswered question
 * is the point — the parked-ask model belongs to an interactive harness, and
 * this one answers, degrades, and says so in the journal.
 */
export async function answerEscalation(question, evidence, topic, opts) {
  const answers = opts.answers ?? {};
  if (topic && typeof topic === "string" && topic in answers) return answers[topic];
  const key = Object.keys(answers).find((k) => question.includes(k));
  if (key) return answers[key];
  if (opts.askOwner) {
    return opts.askOwner(question, evidence);
  }
  return "No owner is available in this run; proceed on your best judgment and state plainly in your result that the question went unanswered.";
}
