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
  const allowed = new Set([...DEFAULT_ALLOWED_COMMANDS, ...(opts.allowCommands ?? [])]);
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
  const impls = {
    read_file({ path: rel }) {
      const p = resolveIn(workspace, rel);
      const st = fs.statSync(p);
      if (!st.isFile()) throw new Error(`not a file: ${rel}`);
      const text = fs.readFileSync(p, "utf8");
      if (Buffer.byteLength(text) > READ_CAP) throw new Error(`file over the ${READ_CAP}-byte read cap: ${rel}`);
      return text;
    },
    list_files({ pattern }) {
      const out = [];
      walk(workspace, workspace, pattern, out, 2000);
      return out.sort();
    },
    search_files({ pattern, glob }) {
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
    },
    write_file({ path: rel, content }) {
      const p = resolveIn(workspace, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
      return `wrote ${rel} (${Buffer.byteLength(content)} bytes)`;
    },
    async run_command({ command, args = [] }) {
      if (!allowed.has(command)) {
        throw new Error(`command not allowed in this run: ${command} (allowed: ${[...allowed].join(", ")})`);
      }
      journal?.({ kind: "command", command, args });
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

/** world.run: the workflow script's own effect primitive. Same contract. */
export function worldRun(command, args, cwd, allowed) {
  if (!allowed.has(command)) {
    return Promise.reject(new Error(`command not allowed in this run: ${command} (allowed: ${[...allowed].join(", ")})`));
  }
  return runFixed(command, args ?? [], cwd);
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
