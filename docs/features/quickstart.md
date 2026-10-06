# quickstart — the guided install

*From the [install-and-bot-surface plan](../plans/2026-10-06-install-and-bot-surface.md). `kit quickstart` + `lib/prompt.mjs` + `parseJsonc` in `lib/roster.mjs`.*

`kit quickstart` is the CLI's first interactive surface: seven steps in exactly the order the README documents the
manual path, ending with a green doctor and the links (`/chat`, `/setup`, `/dashboard`). It exists so the answer to
"how do I install this" is one command, without making the manual path any less visible — every step prints the command
it runs, and every artifact is byte-identical to what the manual path writes.

## The steps

1. **node check** — 20+ or a friendly stop with the nodejs.org pointer.
2. **dependencies** — root `npm install`, then `router/ npm install --omit=dev`; skipped when already present
   (`node_modules/workflow-plane`, `router/node_modules/@typesafe-ai`).
3. **roster** — written from the template when missing, *kept when present* (a wizard overwriting an edited roster is
   data loss dressed as convenience).
4. **keys** — only the env-var names the roster declares that do not resolve; entered hidden (`askSecret`), saved
   through the same `writeEnvFile` as `kit env set` (chmod 600). Enter skips; `/setup` can collect them later.
5. **dry run** — `kit apply --dry-run`, the house rule: nothing renders before a dry run says it can.
6. **apply** — the real thing, including the service and the health check. `--skip-service` renders the runtime only
   (scratch-home probes, Windows, the desktop shell's owned process).
7. **doctor** — green or it didn't happen, even after a rough apply.

## Rules that keep it honest

- **Every step is the existing command** (or performs the identical write), so the terminal tells a power user exactly
  what ran and the artifacts match `kit init --template` + `kit env set` + `kit apply` key for key.
- **Every step checks before it acts**, so an interrupted run resumes: dependencies skip, the roster is kept, keys
  already set are not re-asked.
- **A healthy install is asked before it is touched** — and refused politely when no human is present to answer
  (exit 0, "nothing to do", `--force` to proceed).
- **Non-interactive is a first-class mode** (`--yes`, or no TTY): defaults everywhere, key prompts skipped with a
  pointer to `/setup`. A wizard that cannot run scripted cannot be probed, so it never got shipped.

## lib/prompt.mjs

Four verbs, zero deps: `ask`, `askSecret` (masked with `*`, the answer only ever lives in the closure), `confirm`,
`choose`. Two contracts: the Enter key alone walks through with sensible defaults, and piped stdin answers prompts
strictly in call order. The queue matters — readline can deliver several lines in one write, and per-prompt `line`
listeners attached too late wait forever on a closed stream while the drained event loop exits with code 0 mid-wizard.
Piped input is slurped once and served from a queue instead.

## The template fix

`kit init --template` had been crashing on its own template: the file opens with a JS-style comment block and
`JSON.parse` refuses comments. `parseJsonc()` strips them string-aware — every provider `baseUrl` contains `//`, so a
regex strip would have eaten the URLs. Both `kit init` and quickstart load the template through it.
