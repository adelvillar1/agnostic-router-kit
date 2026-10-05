/**
 * The workflow library: what ships in `workflows/`, what each file declares,
 * and how that becomes the router's routing registry.
 *
 * The registry is the vocabulary the judge routes with — when a verdict picks
 * `workflow: research-report`, the router has to know that name exists and
 * which argument carries the task. It is built from the shipped files rather
 * than hand-maintained, so a workflow that is in the repo is routable and one
 * that is not cannot be routed to by accident. The roster still carries the
 * shape text (the routing hint the judge reads) per workflow, keyed by name;
 * a shipped workflow the roster says nothing about still registers, with the
 * header's description standing in for its shape.
 */
import fs from "node:fs";
import path from "node:path";
import { parseHeader, hasHeader } from "./workflow/meta.mjs";

/** Every workflow file that ships: workflows/*.ts, skipping the runtime dirs. */
export function readLibrary(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(m?ts|js)$/.test(f))
    .map((f) => {
      const file = path.join(dir, f);
      const name = f.replace(/\.(m?ts|js)$/, "");
      const source = fs.readFileSync(file, "utf8");
      return { name, file, source, meta: parseHeader(source, name), header: hasHeader(source) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build the router's `routing.workflows` registry from the shipped library and
 * the roster's shape text. Workflow-shaped entries the roster declares but the
 * repo does not ship (a removed workflow, or the proxy-internal `swarm`) are
 * kept only when they are marked as router-internal — routing to a file that
 * does not exist would dead-end a request.
 */
export function buildRegistry(library, roster) {
  const declared = roster?.workflows?.registry ?? {};
  const registry = [];
  for (const wf of library) {
    const d = declared[wf.name] ?? {};
    const firstRequired = Object.entries(wf.meta.args ?? {}).find(([, spec]) => spec.required)?.[0] ?? "task";
    registry.push({
      name: wf.name,
      taskArg: d.taskArg ?? firstRequired,
      shape: d.shape ?? wf.meta.description ?? wf.meta.whenToUse ?? "",
      ...(d.defaults ? { defaults: d.defaults } : {}),
    });
  }
  return registry;
}

/** Copy the kit's workflows into an install location, reporting what changed. */
export function syncLibrary(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const copied = [];
  const updated = [];
  let unchanged = 0;
  for (const wf of readLibrary(srcDir)) {
    const dest = path.join(destDir, `${wf.name}.ts`);
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(wf.file, dest);
      copied.push(wf.name);
    } else if (fs.readFileSync(dest, "utf8") !== wf.source) {
      fs.copyFileSync(wf.file, dest);
      updated.push(wf.name);
    } else unchanged++;
  }
  return { copied, updated, unchanged };
}
