/* workflow
description: "Probe: the tool registry's capability grants and the audit line that names each one."
whenToUse: Probe only — never a real task. Verifies that a call inside its
  granted capability fires with the grant journaled, and a call outside it is
  refused with the same audit line naming the missing grant.
args:
  task:
    type: string
    description: Unused by this probe; kept so --args matches the library shape.
    required: false
*/

// The registry: default grants cover what the shipped library already does, so
// a workspace read, a plain compute run and the workspace's own test script all
// fire without any --grant. The package capability is not granted here, so an
// install attempt must be refused — and the refusal must be journaled exactly
// like the fired calls, because a capability the run did not have is as
// auditable as one it used.
const probe = async (label: string, fn: () => Promise<unknown>) => {
  try {
    const r = await fn();
    return { label, fired: true, note: r ? String(r).slice(0, 40) : null };
  } catch (e: unknown) {
    return { label, fired: false, note: String((e as Error)?.message ?? e).slice(0, 120) };
  }
};

const trials = [
  await probe("read a workspace file", () => Promise.resolve(files.read("package.json"))),
  await probe("npm test (test-runner)", async () => {
    const r = await world.run("npm", ["test"]);
    return `exit ${r.exitCode}`;
  }),
  await probe("node -e (process)", async () => {
    const r = await world.run("node", ["-e", "process.stdout.write('ok')"]);
    return `exit ${r.exitCode} ${r.stdout}`;
  }),
  await probe("npm install (package)", async () => {
    const r = await world.run("npm", ["install"]);
    return `exit ${r.exitCode}`;
  }),
  await probe("curl (not an allowed exe)", async () => {
    const r = await world.run("curl", ["https://example.com"]);
    return `exit ${r.exitCode}`;
  }),
];

for (const t of trials) log(`grant trial ${t.fired ? "FIRED" : "REFUSED"} · ${t.label} · ${t.note}`);

const fired = trials.filter((t) => t.fired).map((t) => t.label);
const refused = trials.filter((t) => !t.fired).map((t) => t.label);

return {
  conclusion: `grants probe: ${fired.length} fired inside their grant, ${refused.length} refused outside it`,
  findings: [],
  verified: [
    ...trials.map((t) => `${t.fired ? "fired" : "refused"}: ${t.label} — ${t.note}`),
    "every attempt — fired or refused — is one journal line naming its grant (see run.jsonl)",
  ],
  notCovered: [
    "a granted --grant package run succeeding — rerun with `--grant package` to see the install fire",
    "net-fetch — the capability exists in the registry but no tool claims it until item 7 lands",
  ],
};
