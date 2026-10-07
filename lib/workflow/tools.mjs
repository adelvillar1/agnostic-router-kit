/**
 * The workspace tools a workflow's agents may use, and the journal that records
 * what they did.
 *
 * The tool set is deliberately narrow and read-mostly: agents read files,
 * search, run an allowlisted command, and write inside the workspace. A harness
 * runtime gives its actors the full tool belt; this kit gives them a fixed
 * surface with fixed argv (no shell anywhere) so a workflow run can never
 * express a command the run log cannot show. Writing matters — coverage-push's
 * test writers and migration's migrators have to change files to do their job —
 * so `write_file` exists, scoped to the workspace the operator chose.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fetchUrl, browserFetch, searchWeb, installPolicy, ProcessRegistry, DEV_SERVER_LIFETIME_MS, COMMAND_LIFETIME_MS } from "./services.mjs";
import { FACT_KINDS } from "./harness.mjs";
// An agent's tool result lands in its context, so the model-facing cap is far
// smaller than the network guard: a workflow's fetch can write a page to disk,
// but a model cannot read a megabyte of HTML and still do its work.
const FETCH_MODEL_CAP = 64 * 1024;

const READ_CAP = 512 * 1024; // a single file read, bytes
const GREP_CAP = 2000; // matching lines before the call refuses
const RUN_CAP = 256 * 1024; // per stream
const RUN_TIMEOUT_MS = 300000;
// One poll's worth of output. A poll is a delta, so a long command is read in
// pieces rather than truncated — but the piece still has to fit a model.
const COMMAND_POLL_CAP = 64 * 1024;

/**
 * Commands world.run and an agent's run_command may execute. Extend with
 * --allow-cmd. `dev-decisions` is here because the plane's judging path
 * (makeJudgingClassifier) composes it — a judgment that cannot reach the
 * calibration store falls back to raw sys1 and records the fallback.
 */
export const DEFAULT_ALLOWED_COMMANDS = ["npm", "npx", "node", "git", "pnpm", "yarn", "make", "python3", "pytest", "cargo", "go", "dev-decisions"];

/**
 * The tool registry: what the plane can do, what this run was granted, and the
 * audit line that ties every call back to its grant.
 *
 * A capability is a class of effect. Every tool and every executable maps to
 * exactly one. The three the shipped library already exercises are granted by
 * default, so existing workflows run unchanged; the rest are opt-in per run
 * (`--grant package`, `--grant net-fetch`) and the run journal shows the grant
 * on each call. A workflow that suddenly needs the network or dependency
 * installs is therefore visible in how it was launched, not only in what it did.
 */
export const CAPABILITIES = {
  "workspace-io": {
    granted: true,
    what: "read, search, list and write files inside the workspace",
  },
  process: {
    granted: true,
    what: "run an allowlisted executable with fixed argv (no shell)",
  },
  "test-runner": {
    granted: true,
    what: "run the workspace's own tests and builds (npm test/run/ci, pytest)",
  },
  package: {
    granted: false,
    what: "install or change dependencies (npm install, pnpm add)",
  },
  "net-fetch": {
    granted: false,
    what: "fetch a URL over the network",
  },
  "net-search": {
    granted: false,
    what: "search the web via the run's configured search backend",
  },
  // The local browsing tiers, both default-off: a run that never asked to
  // browse stays a run that cannot browse, and turning a tier on is visible in
  // how the run was launched, the way net-fetch and package are. `browser` is
  // the read tier — web_render, and the moli leg of a scrape — a rendered read
  // of one allowlisted URL through moli, the operator's own installed browser
  // binary (absent, the tier refuses by name). `browser-layout` is the drive
  // tier — serve --layout, screenshots, coordinate input — a strictly larger
  // effect on the operator's machine, so it is its own grant rather than a
  // flag on `browser`.
  browser: {
    granted: false,
    what: "render a URL through the local moli browser (web_render, rendered scrapes) — off by default, opt in per run",
  },
  "browser-layout": {
    granted: false,
    what: "drive the local browser's layout tier (serve --layout, screenshots, coordinate input) — off by default, opt in per run",
  },
  // Spawning is a capability like any other: a child is a fresh context with
  // the same grants and its own model calls, so an agent that can spawn can
  // spend the run's budget. Opt-in, journaled, depth-capped at one.
  "sub-agents": {
    granted: false,
    what: "spawn a fresh-context sub-agent to complete one self-contained subproblem",
  },
  // The durable memory plane: opt-in, because a run that can remember can
  // also change what every future run and harness sees. Writes land in the
  // kit's shared JSONL graph and are attributed to the run.
  memory: {
    granted: false,
    what: "read and write the kit's durable cross-run memory graph",
  },
  // The tabular lane: dev-decisions' batch verdict commands, read through one
  // service. Off by default like the net tiers — and batch-only by law: a
  // workflow calls it between agent rounds, never inside an ask, because a
  // TabPFN call is a network round-trip the synchronous paths forbid.
  tabular: {
    granted: false,
    what: "run dev-decisions batch tabular verdicts (forecast bands, flake scores, priors) — off by default, opt in per run; batch-only, never inside an agent turn",
  },
  // The semantic lane, the third model class: embeddings over the graded
  // history and over file corpora (render PNGs, sweep findings). Same laws as
  // tabular — off by default, batch-only between agent rounds — plus the
  // lane's own: embeddings propose, sys1/sdm1 dispose. The surface returns
  // geometry (neighbors, dupe pairs) for a workflow to render; a similarity
  // score is a lead to confirm, never a verdict, so nothing downstream of
  // this grant gates or blocks on a score.
  semantic: {
    granted: false,
    what: "run dev-decisions batch semantic queries (vector index, near-dupe pairs, nearest graded neighbors) — off by default, opt in per run; batch-only, never inside an agent turn; eval-only by lane law",
  },
};

const WORKSPACE_TOOLS = new Set([
  "read_file",
  "list_files",
  "search_files",
  "write_file",
  "edit_file",
]);

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
// argv[0] subjects that change the dependency set rather than run the workspace's own targets
const INSTALL_SUBJECTS = new Set([
  "install", "i", "add", "uninstall", "remove", "rm",
  "update", "upgrade", "link", "publish", "prune", "audit",
]);

/** The capability a call needs, derived from its tool name or executable + argv. */
export function requiredGrant(target, args = []) {
  if (WORKSPACE_TOOLS.has(target)) return "workspace-io";
  if (target === "delegate") return "sub-agents";
  // The browser read tier: web_render only reads one allowlisted URL through
  // moli. Layout-shaped calls — serve --layout, screenshots, coordinate acts —
  // are the drive tier and will require "browser-layout" when they arrive.
  if (target === "web_render") return "browser";
  if (PACKAGE_MANAGERS.has(target)) {
    return INSTALL_SUBJECTS.has(String(args?.[0] ?? "")) ? "package" : "test-runner";
  }
  // Everything else is plain compute: node, npx, python3, pytest, git, make,
  // cargo, go — and dev-decisions, whose CLI the judging path composes, so
  // reaching judgment is never a capability negotiation.
  return "process";
}

/**
 * Turn a run's requests into a grant set. Called once at run start, so an
 * unknown grant fails before the first agent call rather than mid-run.
 */
export function resolveGrants(opts = {}) {
  const held = new Set(
    Object.entries(CAPABILITIES)
      .filter(([, c]) => c.granted)
      .map(([k]) => k),
  );
  const requested = splitList(opts.grants);
  const unknown = requested.filter((g) => !(g in CAPABILITIES));
  if (unknown.length) {
    throw new Error(
      `unknown capability grant${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")} ` +
        `(known: ${Object.keys(CAPABILITIES).join(", ")})`,
    );
  }
  for (const g of requested) held.add(g);
  const exes = new Set([...DEFAULT_ALLOWED_COMMANDS, ...splitList(opts.allowCommands)]);
  return {
    held,
    exes,
    has: (cap) => held.has(cap),
    exeAllowed: (exe) => exes.has(String(exe)),
    summary: () => [...held].sort().join(", "),
    require(cap, what) {
      if (held.has(cap)) return;
      throw new Error(
        `capability not granted in this run: ${cap} — ${CAPABILITIES[cap].what}` +
          `${what ? ` (${what})` : ""} — rerun with \`--grant ${cap}\``,
      );
    },
  };
}

function splitList(v) {
  return String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolveIn(workspace, rel) {
  const p = path.resolve(workspace, rel);
  const root = path.resolve(workspace);
  if (p !== root && !p.startsWith(root + path.sep)) {
    throw new Error(`path escapes the workspace: ${rel}`);
  }
  return p;
}

/**
 * The OpenAI-shaped tool declarations handed to the model with every ask, plus
 * the implementations. A JSON-schema-shaped `submit_result` is added by the
 * engine only when the ask carries a type.
 */
export function buildTools(workspace, journal, opts = {}) {
  const grants = resolveGrants({ grants: opts.grants, allowCommands: opts.allowCommands });
  // The run's fact store, created by the engine so world.remember and an
  // agent's recall read the same one. Absent only in a caller that constructs
  // tools without a run (a unit test), and then the tool is simply not offered.
  const memory = opts.memory ?? null;
  // One registry per run, so a dev server's lifetime is bounded by the run's own
  // process registry, and the engine can stop everything on run-done. Its lines
  // go to the run journal directly — a service event is its own kind, not a tool
  // call, and the tool callback would relabel it. The ceiling is the background
  // command's, which is the longer of the two: a dev server still defaults to
  // its own tighter DEV_SERVER_LIFETIME_MS at the call site.
  const processes = new ProcessRegistry(opts.runJournal ?? journal, { lifetimeCapMs: COMMAND_LIFETIME_MS });
  const defs = [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a UTF-8 text file from the workspace. Relative paths only.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Workspace-relative file path." } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_files",
        description: "List workspace files matching a glob, as relative paths.",
        parameters: {
          type: "object",
          properties: { pattern: { type: "string", description: "Glob such as \"src/**/*.ts\"." } },
          required: ["pattern"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_files",
        description: "Search file contents for a regular expression. Returns matching lines with paths and line numbers.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Regular expression." },
            glob: { type: "string", description: "Optional glob narrowing which files are searched." },
          },
          required: ["pattern"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Write a UTF-8 text file inside the workspace, creating directories as needed. Relative paths only.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative file path." },
            content: { type: "string", description: "The full file content." },
          },
          required: ["path", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "edit_file",
        description:
          "Replace one exact, unique stretch of text in an existing workspace file. Prefer this over write_file for a partial change: a whole-file rewrite regenerates the untouched parts from memory and drifts. Fails loudly if old_string is absent or appears more than once.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative file path." },
            old_string: { type: "string", description: "The exact text to replace; it must appear exactly once in the file." },
            new_string: { type: "string", description: "What replaces it." },
          },
          required: ["path", "old_string", "new_string"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "run_command",
        description:
          "Run a command with fixed arguments in the workspace (no shell). Returns exitCode, stdout and stderr; a nonzero exit is a normal result, not an error.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "The executable, from the run's allowlist." },
            args: { type: "array", items: { type: "string" }, description: "Fixed arguments." },
          },
          required: ["command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "escalate",
        description:
          "Ask the run's owner a blocking question when a check cannot be passed or two instructions cannot both be satisfied. Returns the owner's answer, or a note that no owner is available.",
        parameters: {
          type: "object",
          properties: {
            topic: {
              type: "string",
              description:
                "A short topic slug for this question (e.g. \"stack\", \"layout\", \"tie-break\", \"scope\"). The run's pre-supplied answers are keyed by topic, so the slug is what makes an operator's answer match yours.",
            },
            question: { type: "string" },
            evidence: { type: "string", description: "What you already checked, briefly." },
          },
          required: ["question"],
        },
      },
    },
    // Delegation is a capability (sub-agents) and only appears on the surface of
    // a run whose engine wired a spawner: a tool an agent can see but the
    // engine cannot serve is a refusal the model has to discover by trying it.
    ...(typeof opts.onDelegate === "function"
      ? [
          {
            type: "function",
            function: {
              name: "delegate",
              description:
                "Hand one self-contained subproblem to a fresh agent with its own empty context, and get its result back. Use it when the subproblem is exactly one concern — a lookup, a single file, one decision — so your own context stays on the part you were dispatched for. It is not a way to hand off the whole task, and the child cannot delegate further.",
              parameters: {
                type: "object",
                properties: {
                  task: {
                    type: "string",
                    description: "What the sub-agent must do, stated fully and standalone: it sees none of your context.",
                  },
                  contract: {
                    type: "object",
                    description: "Optional. The child's declared contract — files it owns, acceptance criteria, what it provides.",
                    properties: {
                      files: { type: "array", items: { type: "string" } },
                      acceptance: { type: "array", items: { type: "string" } },
                      provides: { type: "string" },
                    },
                  },
                },
                required: ["task"],
              },
            },
          },
        ]
      : []),
    {
      type: "function",
      function: {
        name: "web_search",
        description:
          "Search the web and return normalized results (url, title, description, and condensed page content when scrape is requested). The backend is the run's configured one: auto (keyless DuckDuckGo first, Firecrawl fallback), duckduckgo, or firecrawl. Requires the net-search grant; the cost lands in the journal as creditsUsed.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "The search query (max 500 chars)." },
            limit: { type: "number", description: "Results to return, 1-10 (default 5)." },
            scrape: {
              type: "string",
              description: 'Optional condensed page content per result: "summary" (cheap) or "markdown" (fuller).',
            },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "fetch_url",
        description:
          "Fetch a URL and return its text, bounded and capped. Requires the net-fetch grant and a domain allowlist; a host outside the allowlist is refused and the refusal is journaled.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "https or http URL. The host must be in this run's domain allowlist." },
          },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "web_render",
        description:
          "Render a URL through the local moli browser and return extraction-optimized content (markdown or semantic tree text). Requires the browser grant; a host outside the fetch allowlist is refused and the refusal is journaled.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "https or http URL. The host must be in this run's domain allowlist." },
            format: {
              type: "string",
              enum: ["markdown", "semantic_tree_text"],
              description: 'How the rendered page is dumped, default "markdown".',
            },
            waitSelector: {
              type: "string",
              description: "Optional CSS selector to wait for before the dump — a lazily rendered page's content root.",
            },
          },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "start_dev_server",
        description:
          "Start a dev server (or any server-shaped process) in the workspace with a bounded lifetime. Returns a handle, a port and whether it readied up. Stop it with stop_dev_server; a lifetime cap stops it even if the run forgets.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "The executable, from the run's allowlist." },
            args: { type: "array", items: { type: "string" }, description: "Fixed arguments." },
            port: { type: "number", description: "Port the server listens on." },
            readyText: {
              type: "string",
              description: "A substring the server prints when it is listening; the call waits for it before returning.",
            },
            lifetimeSeconds: { type: "number", description: "Seconds until the server is stopped automatically (capped)." },
          },
          required: ["command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "stop_dev_server",
        description:
          "Stop a dev server this run started, given its handle. Idempotent: stopping one that already exited reports that rather than failing.",
        parameters: {
          type: "object",
          properties: {
            handle: { type: "string", description: "The handle start_dev_server returned." },
          },
          required: ["handle"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "start_command",
        description:
          "Start a command in the background and get a handle back immediately, instead of holding your tool round " +
          "for its whole run. The command's output is kept by the run, so use poll_command to read what it has " +
          "printed so far — pass the offset poll_command gave you last time to read only the new part — and " +
          "stop_command to end it early. A lifetime cap stops it even if you never call stop. Use this for a build, " +
          "a test suite or any command that runs longer than one tool round; use run_command for something that " +
          "finishes and whose result you want straight away.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "The executable, from the run's allowlist." },
            args: { type: "array", items: { type: "string" }, description: "Fixed arguments — there is no shell." },
            cwd: { type: "string", description: "Optional working directory, relative to the workspace." },
            readyText: {
              type: "string",
              description:
                "Optional substring whose appearance in the command's output means it is under way; the call waits for it before returning.",
            },
            lifetimeSeconds: {
              type: "number",
              description: "Seconds until the command is stopped automatically, capped at 900.",
            },
          },
          required: ["command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "poll_command",
        description:
          "Read a background command's output from an offset, and whether it is still running. Every call returns the " +
          "offset to read from next time, so polling repeatedly streams the output without repeating what you have " +
          "already read. When running turns false, exitCode says how it finished — a null exitCode with a signal " +
          "means it was killed.",
        parameters: {
          type: "object",
          properties: {
            handle: { type: "string", description: "The handle start_command returned." },
            offset: { type: "number", description: "Where to read from; the last poll_command's offset. Omit to read from the start." },
          },
          required: ["handle"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "stop_command",
        description:
          "Stop a background command this run started, given its handle. Idempotent: stopping one that already " +
          "exited reports that, with its exit code, rather than failing.",
        parameters: {
          type: "object",
          properties: {
            handle: { type: "string", description: "The handle start_command returned." },
          },
          required: ["handle"],
        },
      },
    },
  ];

  // The run's fact store, on the default agent surface: a read of the plane's
  // own record, the way read_file is a read of the workspace. Deliberately not
  // `guarded` — it needs no capability beyond having been dispatched, and
  // `requiredGrant` would label it "process", which would be a lie in the
  // journal. The store writes its own audit line through this journal, so a
  // recall is journaled like every other tool call, fired or refused.
  // The durable tier: unlike recall (this run's facts), memory_search reads
  // the kit's shared cross-run graph. Opt-in via the memory capability; the
  // impl journals fired-or-refused like every other tool.
  defs.push({
    type: "function",
    function: {
      name: "memory_search",
      description:
        "Search the kit's durable memory graph — facts, decisions and lessons remembered by earlier runs and other agents, surviving across runs. Use it when something from before this run might matter: prior decisions, project conventions, what was already tried. Requires the memory grant.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look for; matches entity names and their recorded observations (case-insensitive)." },
          limit: { type: "number", description: "Results to return, 1-10 (default 5)." },
        },
        required: ["query"],
      },
    },
  });

  if (memory) {
    defs.push({
      type: "function",
      function: {
        name: "recall",
        description:
          "Look up a fact the coordination layer recorded about THIS run: the task, the pinned stack, the measured environment, a decision, a gate verdict about your part, a part's status, or the run's phase. You see the run's public facts and your own part's — another part's work is out of bounds, and naming another part is refused. Newest facts last.",
        parameters: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              description: `Optional: one kind (${FACT_KINDS.join(", ")}). Omit for everything you may see.`,
            },
            part: {
              type: "string",
              description:
                "Optional: your own part's label. The plane already knows which part is yours — omit this, and know that naming any other part is refused.",
            },
          },
        },
      },
    });
  }

  // Every impl below is pure local filesystem work, so it is synchronous: the
  // workflow script's `files.*` surface promises sync results, and an impl that
  // returned a promise would leak async into a contract that is sync everywhere
  // else. The agent loop awaits these, which is harmless on a plain value.
  //
  // `guarded` checks the grant before the effect and emits the journal line
  // naming it — on the fired call and the refused one alike, so the log reads
  // the same either way and a capability the run did not have is as auditable
  // as one it used.
  const guarded = (tool, fn) => (...callArgs) => {
    const cap = requiredGrant(tool);
    let refusal = null;
    if (!grants.has(cap)) {
      try {
        grants.require(cap, tool);
      } catch (e) {
        refusal = e.message;
      }
    }
    journal?.({ kind: "tool", tool, args: callArgs[0] ?? null, grant: cap, refused: refusal });
    if (refusal) throw new Error(refusal);
    return fn(...callArgs);
  };

  const impls = {
    read_file: guarded("read_file", ({ path: rel }) => {
      const p = resolveIn(workspace, rel);
      const st = fs.statSync(p);
      if (!st.isFile()) throw new Error(`not a file: ${rel}`);
      const text = fs.readFileSync(p, "utf8");
      if (Buffer.byteLength(text) > READ_CAP) throw new Error(`file over the ${READ_CAP}-byte read cap: ${rel}`);
      return text;
    }),
    list_files: guarded("list_files", ({ pattern }) => {
      const out = [];
      walk(workspace, workspace, pattern, out, 2000);
      return out.sort();
    }),
    search_files: guarded("search_files", ({ pattern, glob }) => {
      const re = new RegExp(pattern);
      const files = [];
      walk(workspace, workspace, glob ?? "**/*", files, 20000);
      const matches = [];
      for (const rel of files) {
        let text;
        try {
          text = fs.readFileSync(path.join(workspace, rel), "utf8");
        } catch {
          continue;
        }
        const lines = text.split("\n");
        for (let n = 0; n < lines.length; n++) {
          if (re.test(lines[n])) {
            matches.push({ path: rel, line: n + 1, text: lines[n].slice(0, 500) });
            if (matches.length >= GREP_CAP) throw new Error(`search over the ${GREP_CAP}-line cap — narrow the pattern`);
          }
        }
      }
      return matches;
    }),
    write_file: guarded("write_file", ({ path: rel, content }) => {
      const p = resolveIn(workspace, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
      return `wrote ${rel} (${Buffer.byteLength(content)} bytes)`;
    }),
    // One exact match, declared. A zero match or a second match is an error
    // naming the count, never a silent rewrite of the wrong lines — the whole
    // file regenerated from the model's memory is the dominant corruption mode
    // for a part that touches an existing file, and this is the read-before-write
    // discipline a harness enforces as code. The replacement is a function so
    // `$&`-shaped text in new_string lands literally.
    edit_file: guarded("edit_file", ({ path: rel, old_string: from, new_string: to }) => {
      if (typeof from !== "string" || from === "") throw new Error("edit_file needs a non-empty old_string to replace");
      const p = resolveIn(workspace, rel);
      const st = fs.statSync(p);
      if (!st.isFile()) throw new Error(`not a file: ${rel}`);
      const before = fs.readFileSync(p, "utf8");
      if (Buffer.byteLength(before) > READ_CAP) throw new Error(`file over the ${READ_CAP}-byte read cap: ${rel}`);
      const count = before.split(from).length - 1;
      // The count is the refusal, and it is journalled as one: a fired line
      // followed by nothing would read as an edit that landed, and the file
      // never changed — the same discipline fetchUrl applies.
      if (count === 0) {
        const reason = `old_string not found in ${rel}`;
        journal?.({ kind: "tool", tool: "edit_file", args: { path: rel, old_string: from }, grant: "workspace-io", refused: reason });
        throw new Error(reason);
      }
      if (count > 1) {
        const reason = `old_string appears ${count} times in ${rel} — widen it until it matches exactly once`;
        journal?.({ kind: "tool", tool: "edit_file", args: { path: rel, old_string: from }, grant: "workspace-io", refused: reason });
        throw new Error(reason);
      }
      const after = before.replace(from, () => String(to ?? ""));
      fs.writeFileSync(p, after);
      return `edited ${rel} (${before.length} → ${after.length} chars)`;
    }),
    async run_command({ command, args = [] }) {
      if (!grants.exeAllowed(command)) {
        const refusal = `command not allowed in this run: ${command} (allowed: ${[...grants.exes].join(", ")})`;
        journal?.({ kind: "command", command, args, grant: null, refused: refusal });
        throw new Error(refusal);
      }
      const cap = requiredGrant(command, args);
      if (cap === "package") {
        const policy = installPolicy(command, args, workspace);
        if (policy.kind === "refuse") {
          journal?.({ kind: "command", command, args, grant: cap, refused: policy.reason });
          throw new Error(policy.reason);
        }
        if (policy.lockfile) {
          journal?.({ kind: "command", command, args, grant: cap, from: policy.lockfile });
        }
      }
      let refusal = null;
      if (!grants.has(cap)) {
        try {
          grants.require(cap, `${command} ${args.join(" ")}`.trim());
        } catch (e) {
          refusal = e.message;
        }
      }
      journal?.({ kind: "command", command, args, grant: cap, refused: refusal });
      if (refusal) throw new Error(refusal);
      return runFixed(command, args, workspace);
    },
    async fetch_url({ url }) {
      const cap = "net-fetch";
      let refusal = null;
      if (!grants.has(cap)) {
        try {
          grants.require(cap, String(url));
        } catch (e) {
          refusal = e.message;
        }
      }
      journal?.({ kind: "tool", tool: "fetch_url", args: { url }, grant: cap, refused: refusal });
      if (refusal) throw new Error(refusal);
      const result = await fetchUrl(url, { allowlist: opts.netDomains ?? [], maxBytes: FETCH_MODEL_CAP });
      // The allowlist refuses by returning a result rather than throwing, so the
      // fired line above alone would read as a completed fetch. The second line
      // records that it was not one.
      if (!result.ok) journal?.({ kind: "tool", tool: "fetch_url", args: { url }, grant: cap, refused: result.reason });
      return result;
    },
    async web_render({ url, format, waitSelector }) {
      const cap = "browser";
      let refusal = null;
      if (!grants.has(cap)) {
        try {
          grants.require(cap, String(url));
        } catch (e) {
          refusal = e.message;
        }
      }
      journal?.({ kind: "tool", tool: "web_render", args: { url }, grant: cap, refused: refusal });
      if (refusal) throw new Error(refusal);
      // The same allowlist and model-facing byte cap the plain fetch runs
      // under: a rendered page is still untrusted input riding an agent's
      // history, so the browser tier gets no looser line than the fetch tier.
      const result = await browserFetch(url, {
        format: format ?? "markdown",
        waitSelector: waitSelector ?? null,
        allowlist: opts.netDomains ?? [],
        maxBytes: FETCH_MODEL_CAP,
      });
      // The gate refuses by returning a result rather than throwing, so the
      // fired line above alone would read as a completed render. The second
      // line records the leg that answered — web_render's only leg is moli —
      // with its bytes and truncation, or the refusal, fetch_url's discipline.
      if (!result.ok) {
        journal?.({ kind: "tool", tool: "web_render", args: { url }, grant: cap, refused: result.reason });
      } else {
        journal?.({
          kind: "tool",
          tool: "web_render",
          args: { url },
          grant: cap,
          via: result.via ?? "moli",
          bytes: result.bytes,
          truncated: result.truncated,
        });
      }
      return result;
    },
    async web_search({ query, limit, scrape }) {
      const cap = "net-search";
      let refusal = null;
      if (!grants.has(cap)) {
        try {
          grants.require(cap, String(query));
        } catch (e) {
          refusal = e.message;
        }
      }
      if (refusal) {
        journal?.({ kind: "tool", tool: "web_search", args: { query }, grant: cap, refused: refusal });
        throw new Error(refusal);
      }
      // One line per search, carrying either the refusal or the cost: the
      // journal says what the search returned and what it spent, and never
      // sees the key.
      const result = await searchWeb(query, { ...(opts.search ?? {}), limit, scrape });
      journal?.({
        kind: "tool",
        tool: "web_search",
        args: { query, limit: Number(limit) || 5, scrape: scrape ?? null },
        grant: cap,
        ...(result.ok
          ? { results: result.results.length, creditsUsed: result.creditsUsed }
          : { refused: result.reason }),
      });
      return result;
    },
    async memory_search({ query, limit }) {
      const cap = "memory";
      let refusal = null;
      if (!grants.has(cap)) {
        try {
          grants.require(cap, String(query));
        } catch (e) {
          refusal = e.message;
        }
      }
      if (refusal) {
        journal?.({ kind: "tool", tool: "memory_search", args: { query }, grant: cap, refused: refusal });
        throw new Error(refusal);
      }
      const graph = loadGraph(memoryStorePath());
      const hits = searchGraph(graph, query, { limit: Math.min(Number(limit) || 5, 10) });
      journal?.({
        kind: "tool",
        tool: "memory_search",
        args: { query: String(query).slice(0, 300), limit: hits.length },
        grant: cap,
        results: hits.length,
        bytes: hits.reduce((n, e) => n + e.observations.join("").length, 0),
      });
      return {
        ok: true,
        results: hits.map((e) => ({ entity: e.name, type: e.entityType, observations: e.observations.slice(0, 5) })),
      };
    },
    async start_dev_server({ command, args = [], port, readyText, lifetimeSeconds }) {
      const cap = "process";
      let refusal = null;
      if (!grants.has(cap)) {
        try {
          grants.require(cap, `${command} ${args.join(" ")}`.trim());
        } catch (e) {
          refusal = e.message;
        }
      }
      journal?.({ kind: "tool", tool: "start_dev_server", args: { command, args }, grant: cap, refused: refusal });
      if (refusal) throw new Error(refusal);
      // A port claim without a listener is the failure mode this tool exists to
      // remove, so callers pass readyText; without one ready stays false and the
      // call says nothing was verified instead of asserting the server is up.
      const started = await processes.start({
        label: "dev-server",
        command,
        args,
        cwd: workspace,
        waitFor: readyText ?? null,
        lifetimeMs: lifetimeSeconds ? Number(lifetimeSeconds) * 1000 : DEV_SERVER_LIFETIME_MS,
        env: port ? { PORT: String(port) } : {},
        cap,
      });
      return { ...started, url: port ? `http://127.0.0.1:${port}` : null };
    },
    async stop_dev_server({ handle }) {
      const cap = "process";
      let refusal = null;
      if (!grants.has(cap)) {
        try {
          grants.require(cap, handle);
        } catch (e) {
          refusal = e.message;
        }
      }
      journal?.({ kind: "tool", tool: "stop_dev_server", args: { handle }, grant: cap, refused: refusal });
      if (refusal) throw new Error(refusal);
      return processes.stop(String(handle));
    },
    // A background command is run_command with the round given back: the same
    // exe allowlist, the same classified capability, the same install policy.
    // Skipping either would make a handle a bypass — the synchronous path
    // refuses `curl` and an ungranted `npm ci`, and backgrounding one is not a
    // reason to forget why.
    async start_command({ command, args = [], cwd, readyText, lifetimeSeconds }) {
      if (!grants.exeAllowed(command)) {
        const refusal = `command not allowed in this run: ${command} (allowed: ${[...grants.exes].join(", ")})`;
        journal?.({ kind: "tool", tool: "start_command", args: { command, args }, grant: null, refused: refusal });
        throw new Error(refusal);
      }
      const cap = requiredGrant(command, args);
      if (cap === "package") {
        const policy = installPolicy(command, args, workspace);
        if (policy.kind === "refuse") {
          journal?.({ kind: "tool", tool: "start_command", args: { command, args }, grant: cap, refused: policy.reason });
          throw new Error(policy.reason);
        }
      }
      let refusal = null;
      if (!grants.has(cap)) {
        try {
          grants.require(cap, `${command} ${args.join(" ")}`.trim());
        } catch (e) {
          refusal = e.message;
        }
      }
      journal?.({ kind: "tool", tool: "start_command", args: { command, args }, grant: cap, refused: refusal });
      if (refusal) throw new Error(refusal);
      const lifetimeMs = lifetimeSeconds
        ? Math.min(Number(lifetimeSeconds) * 1000, COMMAND_LIFETIME_MS)
        : COMMAND_LIFETIME_MS;
      return processes.start({
        label: "command",
        command,
        args,
        cwd: cwd ? path.resolve(workspace, String(cwd)) : workspace,
        waitFor: readyText ?? null,
        lifetimeMs,
        cap,
      });
    },
    async poll_command({ handle, offset }) {
      const h = String(handle);
      // Judged on the capability the handle was started under: a command that
      // needed `test-runner` to start is not made readable by a `process` grant
      // it never had.
      const cap = processes.capFor(h) ?? "process";
      let refusal = null;
      if (!grants.has(cap)) {
        try {
          grants.require(cap, h);
        } catch (e) {
          refusal = e.message;
        }
      }
      const at = Number(offset ?? 0);
      if (!Number.isFinite(at) || at < 0) {
        refusal = `offset must be a non-negative number, got ${JSON.stringify(offset)}`;
      }
      journal?.({ kind: "tool", tool: "poll_command", args: { handle: h, offset: at }, grant: cap, refused: refusal });
      if (refusal) throw new Error(refusal);
      const got = processes.poll(h, at);
      if (!got.ok) throw new Error(got.reason);
      // The offset is what makes polling a stream rather than a re-read, so the
      // cap must move the offset with the truncation: a reader that skipped the
      // held-back bytes would lose output silently.
      const full = String(got.stdout ?? "");
      const stdout = full.length > COMMAND_POLL_CAP ? full.slice(0, COMMAND_POLL_CAP) : full;
      return {
        handle: h,
        running: got.running,
        exitCode: got.exitCode,
        signal: got.signal,
        stdout,
        stderr: String(got.stderr ?? "").slice(-COMMAND_POLL_CAP),
        offset: at + stdout.length,
        truncated: full.length > stdout.length,
      };
    },
    async stop_command({ handle }) {
      const h = String(handle);
      const cap = processes.capFor(h) ?? "process";
      let refusal = null;
      if (!grants.has(cap)) {
        try {
          grants.require(cap, h);
        } catch (e) {
          refusal = e.message;
        }
      }
      journal?.({ kind: "tool", tool: "stop_command", args: { handle: h }, grant: cap, refused: refusal });
      if (refusal) throw new Error(refusal);
      const got = processes.stop(h);
      if (!got.ok) throw new Error(got.reason);
      return got;
    },
    async escalate({ question, evidence, topic }) {
      return opts.onEscalate
        ? opts.onEscalate(question, evidence, topic ?? null)
        : "No owner is available in this run; proceed on your best judgment and say so plainly in your result.";
    },
    // Delegation without a parent descriptor (a plane-side call) is a refusal,
    // not a spawn: the child's budget has to land on an agent that exists.
    async delegate(args = {}) {
      const refusal = `delegate needs the engine's per-agent spawner (this call came from ${String(args?.__from ?? "no agent")})`;
      journal?.({ kind: "tool", tool: "delegate", args: { task: previewTask(args?.task) }, grant: "sub-agents", refused: refusal });
      throw new Error(refusal);
    },
    // The scope-free view (the run's public facts) is what an agent without a
    // part gets; the engine swaps in a scoped one per agent through `recallFor`.
    ...(memory ? { recall: memory.recallTool(null, journal) } : {}),
  };

  // Hoisted to a local so `childSurface` can pass the same factory on without
  // reaching for `this`, which an arrow in an object literal does not bind.
  const recallFor = memory ? (scope) => memory.recallTool(scope, journal) : null;

  return {
    defs,
    impls,
    processes,
    grants,
    memory,
    // The engine builds this per agent so the scope rides in a closure rather
    // than a shared impl that concurrent agents would overwrite.
    recallFor,
    // Same for delegation: the parent descriptor (who is spawning, how deep,
    // whose budget the child spends) rides in the closure, so two concurrent
    // parents never cross.
    delegateFor:
      typeof opts.onDelegate === "function"
        ? (parent) => async (args = {}) => {
            const cap = "sub-agents";
            let refusal = null;
            // Depth cap one, enforced by the descriptor rather than by the model's
            // memory of the rule: a child's surface has no delegate at all, and
            // an agent that reaches this with depth already set is a plane bug.
            if (Number(parent?.depth ?? 0) > 0) {
              refusal = "a delegated sub-agent cannot delegate again — the depth cap is one";
            } else if (!grants.has(cap)) {
              try {
                grants.require(cap, "delegate");
              } catch (e) {
                refusal = e.message;
              }
            }
            journal?.({ kind: "tool", tool: "delegate", args: { task: previewTask(args?.task) }, grant: cap, refused: refusal });
            if (refusal) throw new Error(refusal);
            return opts.onDelegate(parent, args);
          }
        : null,
    // A delegated child gets the run's surface minus delegation. Stripping the
    // capability rather than trusting a prompt is what makes the depth cap a
    // fact about the tree rather than a request to a model. The recall factory
    // and the store ride along: the child sees the run's public facts, and a
    // scoped child keeps its scope rather than falling back to the shared one.
    childSurface: () => ({
      defs: defs.filter((d) => d?.function?.name !== "delegate"),
      impls: { ...impls, delegate: undefined },
      memory,
      ...(recallFor ? { recallFor } : {}),
    }),
  };
}

function previewTask(task) {
  const text = String(task ?? "").trim();
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function runFixed(command, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, maxBuffer: RUN_CAP * 2, timeout: RUN_TIMEOUT_MS, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err && (err.killed || err.signal)) {
        reject(new Error(`command failed to run: ${command} ${args.join(" ")} (${err.code ?? err.message})`));
        return;
      }
      resolve({
        exitCode: err ? (err.code ?? 1) : 0,
        stdout: String(stdout ?? "").slice(0, RUN_CAP),
        stderr: String(stderr ?? "").slice(0, RUN_CAP),
      });
    });
  });
}

/**
 * world.run: the workflow script's own effect primitive. Same contract as an
 * agent's run_command — same allowlist, same grant check — because a capability
 * is the capability whether the caller is a model or the script that spawned it.
 */
export function worldRun(command, args, cwd, grants, journal) {
  const argv = args ?? [];
  if (!grants.exeAllowed(command)) {
    const refusal = `command not allowed in this run: ${command} (allowed: ${[...grants.exes].join(", ")})`;
    journal?.({ kind: "command", command, args: argv, grant: null, refused: refusal });
    return Promise.reject(new Error(refusal));
  }
  const cap = requiredGrant(command, argv);
  if (cap === "package") {
    const policy = installPolicy(command, argv, cwd);
    if (policy.kind === "refuse") {
      journal?.({ kind: "command", command, args: argv, grant: cap, refused: policy.reason });
      return Promise.reject(new Error(policy.reason));
    }
    if (policy.lockfile) {
      journal?.({ kind: "command", command, args: argv, grant: cap, from: policy.lockfile });
    }
  }
  if (!grants.has(cap)) {
    const refusal = `capability not granted in this run: ${cap} (${`${command} ${argv.join(" ")}`.trim()}) — rerun with \`--grant ${cap}\``;
    journal?.({ kind: "command", command, args: argv, grant: cap, refused: refusal });
    return Promise.reject(new Error(refusal));
  }
  journal?.({ kind: "command", command, args: argv, grant: cap, refused: null });
  return runFixed(command, argv, cwd);
}

/** A tiny glob: `**` across directories, `*` within a segment, `?`, and literals. */
function walk(root, dir, pattern, out, cap) {
  if (out.length >= cap) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= cap) return;
    if (e.name === ".git" || e.name === "node_modules") continue;
    const abs = path.join(dir, e.name);
    const rel = path.relative(root, abs);
    if (e.isDirectory()) {
      walk(root, abs, pattern, out, cap);
    } else if (matchGlob(rel, pattern)) {
      out.push(rel);
    }
  }
}

function matchGlob(rel, pattern) {
  if (pattern === "**/*" || pattern === "**") return true;
  // One segment at a time: `**` crosses directories, `*` stays inside one.
  const re = new RegExp(
    "^" +
      pattern
        .split("/")
        .map((seg) =>
          seg === "**"
            ? ".*"
            : seg
                .split("*")
                .map((s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\?/g, "."))
                .join("[^/]*")
        )
        .join("/") +
      "$"
  );
  return re.test(rel);
}
