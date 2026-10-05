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
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { parseHeader, validateArgs, extractInterfaces } from "./meta.mjs";
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
} from "./harness.mjs";

const AGENT_MAX_ROUNDS = 24; // tool-call rounds per ask before the loop gives up
// An idle cap, not a total one: a streamed completion that emits tokens is
// healthy however long the turn runs. Generous because thinking-heavy models
// can sit minutes before the first token.
const ASK_IDLE_TIMEOUT_MS = 300000;
const FILE_CAP = 20 * 1024 * 1024;
const MARKDOWN_CAP = 256 * 1024;

export class WorkflowRunError extends Error {}

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
  const runDir = opts.outDir ?? path.join(KIT_WORKFLOW_RUNS(), `${slug(startedAt)}-${name}`);
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
  });

  const agentCalls = { baseUrl, token, model, tools, memory, state, opts, emit, journal };

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

export function KIT_WORKFLOW_RUNS() {
  const home = process.env.AGNOSTIC_ROUTER_KIT_HOME ?? path.join(os.homedir(), ".agnostic-router-kit");
  const dir = path.join(home, "workflow-runs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function slug(ts) {
  return new Date(ts).toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
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
  const messages = system ? [{ role: "system", content: system }] : [];
  const stats = { asks: 0, toolCalls: 0 };
  const label = name || "anonymous";
  let contractRecorded = false;
  // One tools object per scoped agent rather than a shared impl overwritten
  // per ask: agents run concurrently, and a scope written into a shared impl
  // would be whichever agent asked last.
  const tools =
    scope && ctx.memory && typeof ctx.tools.recallFor === "function"
      ? { defs: ctx.tools.defs, impls: { ...ctx.tools.impls, recall: ctx.tools.recallFor(scope) } }
      : ctx.tools;
  return {
    name: label,
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
      const value = await askLoop(messages, schema ?? null, { ...ctx, tools }, label, stats);
      messages.push({ role: "assistant", content: typeof value === "string" ? value : JSON.stringify(value) });
      return value;
    },
  };
}

async function askLoop(messages, schema, ctx, label, stats) {
  const { tools, emit } = ctx;
  const maxRounds = Number(ctx.opts.agentMaxRounds) > 0 ? Number(ctx.opts.agentMaxRounds) : AGENT_MAX_ROUNDS;
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

  let jsonNudges = 0;
  let lastTool = "none";
  for (let round = 1; round <= maxRounds; round++) {
    const data = await chatCompletion(ctx, messages, defs, schema, label);
    const choice = data?.choices?.[0];
    const message = choice?.message;
    if (!message) throw new WorkflowRunError(`${label}: the router returned no message`);
    messages.push(message);

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
  throw new WorkflowRunError(
    `${label}: the ask did not settle after ${maxRounds} tool rounds (last tool: ${lastTool}) — ` +
      `the cap guards against a runaway loop; narrow the instructions or split the ask`
  );
}

/**
 * Shape one model answer to the schema the workflow declared. Models answer
 * what they feel like: one item where a list was declared, a number where a
 * string was, a nested object with a field left out. The workflow's types say
 * what it will do with those fields, so the runtime settles the shape here
 * instead of letting a run die mid-flight on `e.risks is not iterable`.
 *
 * Coercion, not validation: a value already of the right shape passes through
 * untouched, and a field the model filled with prose stays prose. Missing
 * declared fields become an explicit null so the workflow can see the absence.
 */
function coerceResult(args, schema, depth = 0) {
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

function coerceToSchema(value, spec, depth) {
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

function serializeToolResult(value) {
  if (value === undefined) return "(no output)";
  if (typeof value === "string") return value;
  return JSON.stringify(value).slice(0, 64 * 1024);
}

/** Pull a JSON object out of a model's prose: whole text, a fenced block, or the first balanced object. */
function extractJson(text) {
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

/**
 * One chat completion through the router, streamed. Falls back to a tools-free
 * call when the upstream refuses tools.
 *
 * The stream is not a presentation choice: with `stream: false` nothing
 * arrives until the whole completion exists, and a long agent turn sits
 * silent for minutes — into the fetch stack's ~5-minute headers timeout,
 * which kills the connection and surfaces as "the router did not answer".
 * Streaming keeps bytes flowing, so the deadline that matters is an IDLE cap:
 * a completion that is emitting tokens is healthy however long it runs; what
 * gets aborted is a connection with nothing arriving for ASK_IDLE_TIMEOUT_MS.
 */
async function chatCompletion(ctx, messages, defs, schema, label) {
  const { baseUrl, token, model, state, emit } = ctx;
  const body = { model, messages, temperature: 0.4, stream: true };
  const withTools = state.providerToolsOk && defs.length;
  if (withTools) body.tools = defs;
  const started = Date.now();
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ac = new AbortController();
    let idle = setTimeout(() => ac.abort(new Error(`no bytes for ${ASK_IDLE_TIMEOUT_MS}ms`)), ASK_IDLE_TIMEOUT_MS);
    const bump = () => {
      clearTimeout(idle);
      idle = setTimeout(() => ac.abort(new Error(`no bytes for ${ASK_IDLE_TIMEOUT_MS}ms`)), ASK_IDLE_TIMEOUT_MS);
    };
    try {
      const r = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      bump();
      if (r.status === 400 && withTools && /tool|function/i.test(await r.clone().text())) {
        // This upstream will not take tools — degrade the whole run rather
        // than fail every ask on it.
        clearTimeout(idle);
        state.providerToolsOk = false;
        delete body.tools;
        continue;
      }
      if (r.status === 429 || r.status >= 502) {
        clearTimeout(idle);
        lastErr = new Error(`router HTTP ${r.status}`);
        await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
        continue;
      }
      if (!r.ok) {
        clearTimeout(idle);
        throw new WorkflowRunError(`${label}: router HTTP ${r.status} — ${(await r.text()).slice(0, 300)}`);
      }
      const message = await consumeStream(r, bump);
      clearTimeout(idle);
      emit({ kind: "agent", actor: label, ms: Date.now() - started, tools: Boolean(withTools) });
      return { choices: [{ message }] };
    } catch (e) {
      clearTimeout(idle);
      if (e instanceof WorkflowRunError) throw e;
      lastErr = e;
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    }
  }
  throw new WorkflowRunError(`${label}: the router did not answer — ${String(lastErr?.message ?? lastErr)}`);
}

/**
 * Assemble one OpenAI-shaped assistant message out of an SSE completion:
 * content deltas concatenate, tool_calls assemble by index (id and function
 * name arrive once, arguments stream in fragments).
 */
async function consumeStream(r, bump) {
  const ctype = r.headers.get("content-type") ?? "";
  if (!ctype.includes("text/event-stream") || !r.body) {
    const d = await r.json().catch(() => null);
    return d?.choices?.[0]?.message ?? { role: "assistant", content: "" };
  }
  let content = "";
  const calls = new Map();
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of r.body) {
    bump();
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let j = null;
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = j?.choices?.[0]?.delta ?? {};
      if (typeof delta.content === "string") content += delta.content;
      for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const idx = tc.index ?? 0;
        const cur = calls.get(idx) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
        if (tc.id) cur.id = tc.id;
        if (tc.type) cur.type = tc.type;
        if (tc.function?.name) cur.function.name += tc.function.name;
        if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
        calls.set(idx, cur);
      }
    }
  }
  const message = { role: "assistant", content };
  if (calls.size) message.tool_calls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
  return message;
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

// ── artifacts ───────────────────────────────────────────────────────────────

function makeArtifacts(runDir, workdir, emit, state) {
  const nextVersion = (id) => {
    const arr = (state.artifacts[id] ??= []);
    const version = arr.length + 1;
    arr.push(version);
    return version;
  };
  return {
    async file(id, rel, opts2 = {}) {
      // Workspace-relative, like files.read — an absolute path is honoured only
      // when it really is inside the workspace.
      const full = path.resolve(workdir, rel);
      if (!fs.existsSync(full)) throw new Error(`artifact file missing: ${rel}`);
      const st = fs.statSync(full);
      if (!st.isFile()) throw new Error(`not a file: ${rel}`);
      if (st.size > FILE_CAP) throw new Error(`artifact over the ${FILE_CAP}-byte cap: ${rel}`);
      const version = nextVersion(id);
      const dest = artifactDest(runDir, id, version, path.basename(rel));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(full, dest);
      emit({ kind: "artifact", id, version, kindType: "file", path: rel, bytes: st.size, title: opts2.title ?? id, primary: Boolean(opts2.primary) });
      return { id, version };
    },
    async markdown(id, content, opts2 = {}) {
      const text = String(content ?? "");
      if (Buffer.byteLength(text) > MARKDOWN_CAP) throw new Error(`markdown over the ${MARKDOWN_CAP}-byte cap`);
      const version = nextVersion(id);
      const dest = artifactDest(runDir, id, version, `${id}.md`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, text);
      emit({ kind: "artifact", id, version, kindType: "markdown", bytes: Buffer.byteLength(text), title: opts2.title ?? id, primary: Boolean(opts2.primary) });
      return { id, version };
    },
  };
}

function artifactDest(runDir, id, version, base) {
  return path.join(runDir, "artifacts", id, `v${version}`, base);
}

// ── git observations (fixed argv, never a shell) ─────────────────────────────
function git(cwd, args) {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export async function gitChangedFiles(cwd, base) {
  if (base) {
    const r = git(cwd, ["diff", "--name-only", base]);
    if (!r.ok) throw new Error(`git diff --name-only ${base} failed in ${cwd}`);
    return r.out.split("\n").map((s) => s.trim()).filter(Boolean);
  }
  const r = git(cwd, ["status", "--porcelain"]);
  if (!r.ok) throw new Error(`git status failed in ${cwd} — is it a repository?`);
  return r.out
    .split("\n")
    .map((l) => l.replace(/^(..)\s+/, "").replace(/^ "(.*)"$/, "$1").trim())
    .filter(Boolean);
}

export async function gitDiff(cwd, base, rel) {
  const args = ["diff", base ?? "HEAD"];
  if (rel) args.push("--", rel);
  const r = git(cwd, args);
  if (!r.ok) throw new Error(`git diff failed in ${cwd}`);
  const d = r.out;
  if (d.length > 512 * 1024) throw new Error("diff over the 512KB cap — narrow the path");
  return d;
}

export async function gitStatus(cwd) {
  const r = git(cwd, ["status", "--porcelain"]);
  if (!r.ok) throw new Error(`git status failed in ${cwd}`);
  const staged = [];
  const unstaged = [];
  const untracked = [];
  for (const line of r.out.split("\n").filter(Boolean)) {
    const x = line[0];
    const y = line[1];
    const p = line.slice(3).replace(/^"(.*)"$/, "$1");
    if (x === "?" && y === "?") untracked.push(p);
    else {
      if (x !== " " && x !== "?") staged.push(p);
      if (y !== " " && y !== "?") unstaged.push(p);
    }
  }
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return { branch: branch.ok ? branch.out.trim() : undefined, clean: r.out.trim().length === 0, staged, unstaged, untracked };
}

export async function gitLog(cwd, count = 20) {
  const n = Math.min(Math.max(count, 1), 100);
  const r = git(cwd, ["log", `-n${n}`, "--pretty=format:%H%x1f%s%x1f%an%x1f%aI"]);
  if (!r.ok) throw new Error(`git log failed in ${cwd}`);
  return r.out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, subject, author, date] = line.split("\x1f");
      return { hash, subject, author, date };
    });
}
