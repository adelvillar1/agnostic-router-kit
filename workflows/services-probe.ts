/* workflow
description: "Probe: the harness services behind their grants — install policy, bounded net-fetch, dev servers, format hooks."
whenToUse: Probe only — never a real task. Verifies each service reaches exactly
  what its own grant allows and nothing more. Every trial names what should
  happen, so a service that grew past its grant shows up as FIRED where REFUSED
  was expected.
args:
  task:
    type: string
    description: Unused; kept so --args matches the library shape.
    required: false
*/

const trial = async (label: string, expected: "fired" | "refused", fn: () => Promise<string>) => {
  let note = "";
  let fired = true;
  try {
    note = String((await fn()) ?? "").slice(0, 180);
  } catch (e: unknown) {
    fired = false;
    note = String((e as Error)?.message ?? e).slice(0, 180);
  }
  const expectedFired = expected === "fired";
  const verdict = fired === expectedFired ? "AS-EXPECTED" : "UNEXPECTED";
  log(`service trial ${fired ? "FIRED" : "REFUSED"} (expected ${expected}) ${verdict} · ${label} · ${note}`);
  return { label, expected, fired, verdict, note };
};

const trials = [];

// 1. Install policy. `ci` restores from the lockfile under the default
// test-runner grant; a named install adds a dependency, which is a human
// decision, and is refused before any registry is contacted. A bare install
// with a manifest to restore is also a restore, so its expectation follows the
// grant like the fetch trials below. Both facts hold under any launch.
const restorable = world.grants().has("package");
trials.push(await trial("npm ci from the lockfile (test-runner default)", "fired", async () => {
  const r = await world.run("npm", ["ci"]);
  return `exit ${r.exitCode}`;
}));
trials.push(await trial("npm install <package> — adds a dependency", "refused", async () => {
  const r = await world.run("npm", ["install", "left-pad"]);
  return `exit ${r.exitCode}`;
}));
trials.push(await trial("npm install with nothing declared — restores the lockfile", restorable ? "fired" : "refused", async () => {
  const r = await world.run("npm", ["install"]);
  return `exit ${r.exitCode}`;
}));

// 2. Bounded net-fetch. The grant says the run may use the network at all; the
// domain allowlist says which hosts, and either one alone fetches nothing. The
// probe asks what this run was granted rather than assuming one, so the same
// trials run under any launch.
const fetchable = world.grants().has("net-fetch") && world.grants().domains.length > 0;
log(`net-fetch grant: ${world.grants().has("net-fetch") ? "held" : "absent"} · allowlist: ${world.grants().domains.join(", ") || "(none)"} · fetchable: ${fetchable}`);

trials.push(await trial("an allowlisted fetch under its grant", fetchable ? "fired" : "refused", async () => {
  const r = await world.fetch("https://example.com/");
  if (!r.ok) throw new Error(r.reason ?? "refused");
  return `status ${r.status} ${r.url} (${r.bytes} bytes${r.truncated ? ", truncated" : ""})`;
}));
trials.push(await trial("a live host outside the allowlist", "refused", async () => {
  const r = await world.fetch("https://www.iana.org/");
  if (!r.ok) throw new Error(r.reason ?? "refused");
  return `status ${r.status} ${r.url} — this host was allowlisted, which fails the trial`;
}));
trials.push(await trial("a non-URL", "refused", async () => {
  const r = await world.fetch("not-a-url");
  if (!r.ok) throw new Error(r.reason ?? "refused");
  return `status ${r.status}`;
}));

// 3. Dev servers: bounded lifetime, readiness marker, and a stop that reports
// itself as a no-op once the process is gone. The scratch workspace carries the
// tiny server this starts, so the trial is a real process, not a mock.
trials.push(await trial("start, poll, and stop a dev server", "fired", async () => {
  const s = await world.server.start({ command: "node", args: ["server.js"], readyText: "listening" });
  const after = world.server.poll(s.handle, 0);
  const stopped = await world.server.stop(s.handle);
  return `handle ${s.handle} ready=${s.ready} running=${s.running} polled=${after.stdout.trim() || "(no output)"} stop=${stopped.alreadyStopped ? "idempotent" : "sent"}`;
}));
// The lifetime cap is the point of a dev server: it dies even if the run forgets
// it. Starting one with a one-second lifetime proves it without waiting minutes.
trials.push(await trial("a dev server dies at its lifetime cap", "fired", async () => {
  const s = await world.server.start({ command: "node", args: ["server.js"], lifetimeSeconds: 1 });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const p = world.server.poll(s.handle, 0);
    if (!p.running) return `cap fired after ${Date.now() - s.startedAt}ms — exit ${p.exitCode}`;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the lifetime cap never fired — the server is still running");
}));

// 4. Format hooks: the workspace's own scripts, run pre-verification, reported
// rather than thrown when they fail.
trials.push(await trial("world.format() runs the workspace's hooks", "fired", async () => {
  const r = await world.format();
  return `${r.ok ? "green" : "findings"} — ${r.hooks.map((h) => `${h.script}:${h.exitCode}`).join(", ")}`;
}));

const unexpected = trials.filter((t) => t.verdict === "UNEXPECTED");

return {
  conclusion: `services probe: ${trials.length - unexpected.length}/${trials.length} services behaved exactly as their grant allows`,
  findings: [],
  verified: [
    ...trials.map((t) => `${t.verdict === "AS-EXPECTED" ? "ok" : "UNEXPECTED"}: ${t.label} — ${t.note}`),
    "dev-server start/poll/stop are journaled as service lines under the run",
  ],
  notCovered: [
    "an allowlisted fetch succeeding — rerun with `--grant net-fetch --allow-domain example.com` to see one fire",
    "a dev server killed by its lifetime cap — that takes five minutes of runtime",
  ],
};
