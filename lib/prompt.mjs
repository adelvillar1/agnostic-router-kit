/**
 * The kit's prompt surface — the small interactive layer `kit quickstart` runs.
 *
 * Zero dependencies, three verbs: ask, askSecret, confirm. Everything is
 * built so the Enter key alone walks a new user through with sensible
 * defaults, and so a script (or a probe) gets the same outcome by piping
 * answers on stdin or passing --yes — a wizard that only works when a human
 * is watching is a wizard that cannot be verified.
 *
 * Secrets never echo: askSecret mutes the terminal (a `*` per character) and
 * non-interactive input is read from piped stdin, so a key is never in a
 * shell's history and never in the process list.
 */
import readline from "node:readline";
import { Writable } from "node:stream";

export function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

// Piped stdin is slurped once and served as a queue: prompts then answer
// strictly in call order no matter how the lines physically arrive. Listening
// for `line` per prompt does not survive a single fast write carrying several
// lines — readline emits them back-to-back before the next prompt has
// attached its listener, the late listener waits on a closed stream, and the
// drained event loop exits the process mid-wizard with code 0.
let pipedQueue = null;
function nextPipedLine() {
  if (pipedQueue) return pipedQueue.shift() ?? "";
  pipedQueue = [];
  const chunks = [];
  return new Promise((resolve) => {
    const finish = () => {
      pipedQueue = Buffer.concat(chunks).toString("utf8").split("\n").map((s) => s.trim());
      resolve(pipedQueue.shift() ?? "");
    };
    if (process.stdin.readableEnded) return finish();
    process.stdin.on("data", (d) => chunks.push(d));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

let shared;
function iface() {
  if (!shared) shared = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  return shared;
}

/**
 * One line of input. Interactive: the question prints with its default and
 * Enter takes the default. Piped: one line is read from stdin (empty or
 * exhausted stdin takes the default too, so a probe can answer only the
 * questions it cares about).
 */
export async function ask(question, { def = "" } = {}) {
  const suffix = def ? ` (${def})` : "";
  if (isInteractive()) {
    const a = await new Promise((resolve) => iface().question(`${question}${suffix}: `, resolve));
    return a.trim() || def;
  }
  return (await nextPipedLine()) || def;
}

/**
 * A secret: the prompt prints, the answer does not. With a TTY the echo is
 * replaced by one `*` per character (backspaces redraw through readline as
 * usual). Without one — a script feeding stdin — the line is simply not
 * repeated to the screen by us; nothing else about the flow changes.
 */
export async function askSecret(question) {
  if (!isInteractive()) return (await nextPipedLine()).trim();
  // Readline echoes to `output`; hand it a stream that keeps the newline
  // (so the answer lands on its own line) and reduces every visible
  // character to a `*`. The answer itself only ever lives in the closure.
  return new Promise((resolve) => {
    const masked = new Writable({
      write(chunk, _enc, cb) {
        const s = chunk.toString();
        if (/[\r\n]/.test(s)) process.stdout.write("\n");
        else if (s.trim()) process.stdout.write("*");
        cb();
      },
    });
    const rl = readline.createInterface({ input: process.stdin, output: masked, terminal: true });
    rl.question(question, (a) => {
      rl.close();
      resolve(a.trim());
    });
  });
}

/** A yes/no question. Enter takes the default. Piped: empty line takes it too. */
export async function confirm(question, { def = true } = {}) {
  const hint = def ? "(Y/n)" : "(y/N)";
  const a = await ask(`${question} ${hint}`, { def: "" });
  if (!a) return def;
  return /^y/i.test(a);
}

/**
 * A numbered choice. Prints the options with a friendly one-liner each,
 * accepts the number or the name, Enter takes the default.
 */
export async function choose(question, options, { def = 0 } = {}) {
  for (let i = 0; i < options.length; i++) {
    process.stdout.write(`  ${i === def ? ">" : " "} ${i + 1}. ${options[i].label} — ${options[i].hint}\n`);
  }
  const a = await ask(question, { def: String(def + 1) });
  const n = Number.parseInt(a, 10);
  if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1];
  const byName = options.find((o) => o.label.toLowerCase() === a.toLowerCase());
  return byName ?? options[def];
}
