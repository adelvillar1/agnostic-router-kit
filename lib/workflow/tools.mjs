/**
 * The workspace tools a workflow's agents may use, and the journal that records
 * what they did.
 *
 * The tool set is deliberately narrow and read-mostly: agents read files,
 * search, run an allowlisted command, and write inside the workspace. ZCode's
 * runtime gives its actors the harness's full tools; this kit gives them a fixed
 * surface with fixed argv (no shell anywhere) so a workflow run can never
 * express a command the run log cannot show. Writing matters — coverage-push's
 * test writers and migration's migrators have to change files to do their job —
 * so `write_file` exists, scoped to the workspace the operator chose.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const READ_CAP = 512 * 1024; // a single file read, bytes
const GREP_CAP = 2000; // matching lines before the call refuses
const RUN_CAP = 256 * 1024; // per stream
const RUN_TIMEOUT_MS = 300000;

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
  ];

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
    async run_command({ command, args = [] }) {
      if (!grants.exeAllowed(command)) {
        const refusal = `command not allowed in this run: ${command} (allowed: ${[...grants.exes].join(", ")})`;
        journal?.({ kind: "command", command, args, grant: null, refused: refusal });
        throw new Error(refusal);
      }
      const cap = requiredGrant(command, args);
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
    async escalate({ question, evidence, topic }) {
      return opts.onEscalate
        ? opts.onEscalate(question, evidence, topic ?? null)
        : "No owner is available in this run; proceed on your best judgment and say so plainly in your result.";
    },
  };

  return { defs, impls };
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
