#!/usr/bin/env node
/**
 * The coercion contract, case by case.
 *
 * Coercion is where a model's answer becomes the shape the workflow declared,
 * and every branch of it exists because some model did that once: answered with
 * the one item it had in mind for a `string[]`, put `12` where a string was
 * declared, wrapped its JSON in a markdown fence. A run that dies on
 * `e.risks is not iterable` is a run that never reached its interesting part,
 * so this asserts each shape the runtime promises — and each way it declines
 * to invent.
 *
 * The plan for the plane split assumed such a check already existed. It did
 * not; this is it, written as part of the extraction so the moved code arrives
 * with the coverage it was always supposed to have.
 *
 *   node tools/unit-coerce.mjs
 */
import assert from "node:assert/strict";
import path from "node:path";

const engineDir = path.resolve(import.meta.dirname, "..");
const { coerceResult, coerceToSchema, extractJson } = await import(
  path.join(engineDir, "lib", "workflow", "coerce.mjs")
);

let n = 0;
/** One named case, run and counted; the name is what a failure reports. */
const coerceCase = (name, args, schema, expected) => {
  n += 1;
  assert.deepEqual(coerceResult(args, schema), expected, `coerceResult: ${name}`);
};

// ── the passthrough cases: coercion invents nothing ──────────────────────────
coerceCase(
  "no schema means no shaping",
  { a: 1 },
  undefined,
  { a: 1 }
);
coerceCase(
  "a scalar answer against a schema is not an object to walk",
  "plain string answer",
  { type: "object", properties: { a: { type: "string" } } },
  "plain string answer"
);
coerceCase(
  "a spec outside the documented subset passes its value through",
  7,
  { enum: [7, 8] },
  7
);

// ── objects: declared fields, missing fields, extra fields ───────────────────
coerceCase(
  "a well-formed answer is returned unchanged",
  { verdict: "go", risks: ["none"] },
  { type: "object", properties: { verdict: { type: "string" }, risks: { type: "array", items: { type: "string" } } } },
  { verdict: "go", risks: ["none"] }
);
coerceCase(
  "a declared field the answer omitted becomes an explicit null",
  { verdict: "go" },
  { type: "object", properties: { verdict: { type: "string" }, risks: { type: "array", items: { type: "string" } } } },
  { verdict: "go", risks: null }
);
coerceCase(
  "a field the model added is kept — coercion shapes, it does not whitelist",
  { verdict: "go", extra: "kept" },
  { type: "object", properties: { verdict: { type: "string" } } },
  { verdict: "go", extra: "kept" }
);
coerceCase(
  "nested objects are shaped to their own declared schema",
  { outer: { inner: 5 } },
  { type: "object", properties: { outer: { type: "object", properties: { inner: { type: "string" } } } } },
  { outer: { inner: "5" } }
);

// ── arrays: the break that motivated the whole module ────────────────────────
const listSchema = {
  type: "object",
  properties: { risks: { type: "array", items: { type: "string" } } },
};
coerceCase(
  "one item where a list was declared becomes a list of one",
  { risks: "single risk" },
  listSchema,
  { risks: ["single risk"] }
);
coerceCase(
  "an empty answer for a declared list becomes an empty list",
  { risks: "   " },
  listSchema,
  { risks: [] }
);
coerceCase(
  "one object where a list of objects was declared becomes a list",
  { parts: { name: "a" } },
  { type: "object", properties: { parts: { type: "array", items: { type: "object", properties: { name: { type: "string" } } } } } },
  { parts: [{ name: "a" }] }
);
// The same shaping, reached directly: coerceToSchema is the engine of every
// case above, and these three drive its array paths on their own.
n += 1;
assert.deepEqual(
  coerceToSchema(["one", 2], { type: "array", items: { type: "string" } }, 0),
  ["one", "2"],
  "coerceToSchema: an array of mixed scalars is shaped item by item"
);
n += 1;
assert.deepEqual(
  coerceToSchema(3, { type: "array", items: { type: "number" } }, 0),
  [3],
  "coerceToSchema: a scalar for a declared list is wrapped"
);
n += 1;
assert.deepEqual(
  coerceToSchema(null, { type: "array", items: { type: "string" } }, 0),
  null,
  "coerceToSchema: a null value stays null rather than becoming a list"
);

// ── scalars: the conversions a model actually makes ──────────────────────────
coerceCase(
  "a number where a string was declared is stringified",
  { count: 12 },
  { type: "object", properties: { count: { type: "string" } } },
  { count: "12" }
);
coerceCase(
  "numeric text where a number was declared becomes a number",
  { score: "8.5" },
  { type: "object", properties: { score: { type: "number" } } },
  { score: 8.5 }
);
coerceCase(
  "a declared integer is truncated, not rejected",
  { rounds: "7.9" },
  { type: "object", properties: { rounds: { type: "integer" } } },
  { rounds: 7 }
);
coerceCase(
  "unusable text for a declared number is an explicit null",
  { score: "not a number" },
  { type: "object", properties: { score: { type: "number" } } },
  { score: null }
);
coerceCase(
  "a scalar where an object was declared is an explicit null",
  { report: "a paragraph" },
  { type: "object", properties: { report: { type: "object", properties: { title: { type: "string" } } } } },
  { report: null }
);
coerceCase(
  "yes/no prose for a declared boolean",
  { ready: "YES", healthy: "no", unsure: "maybe" },
  {
    type: "object",
    properties: { ready: { type: "boolean" }, healthy: { type: "boolean" }, unsure: { type: "boolean" } },
  },
  { ready: true, healthy: false, unsure: null }
);

// ── the depth cap: a self-referential schema terminates ──────────────────────
n += 1;
assert.deepEqual(
  coerceToSchema({ a: 1 }, { type: "object", properties: { a: { type: "object", properties: { b: { type: "string" } } } } }, 99),
  { a: 1 },
  "coerceToSchema: past the depth cap the value is returned as it came"
);

// ── JSON recovery: models do not answer in bare JSON ─────────────────────────
const jsonCase = (name, text, expected) => {
  n += 1;
  assert.deepEqual(extractJson(text), expected, `extractJson: ${name}`);
};
jsonCase("bare JSON is used as it came", '{"a":1}', { a: 1 });
jsonCase("a fenced json block is unwrapped", 'Sure.\n\n```json\n{"a":1}\n```\nDone.', { a: 1 });
jsonCase("a fence with no language tag still unwraps", '```\n{"a":1}\n```', { a: 1 });
jsonCase("prose around the object is dropped", 'Here you go:\n{"a":1}\nLet me know.', { a: 1 });
jsonCase("an array embedded in prose is recovered", "Results:\n[1,2]\nfin", [1, 2]);
jsonCase("an unbalanced object is refused, not repaired", '{"a":1', null);
jsonCase("prose with no JSON at all is refused", "I could not do that.", null);
jsonCase("empty text is refused", "", null);
jsonCase(
  "a fence holding something that is not JSON falls through to the balanced search",
  "```json\nnot json\n``` the answer is {\"a\":1}",
  { a: 1 }
);

console.log(`unit-coerce: ${n} cases pass — shaping, null-filling, and JSON recovery`);
