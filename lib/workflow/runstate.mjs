/**
 * The state a run owns: what it is called, where it writes, and how it fails.
 *
 * The module starts with the run's error type because the transport module
 * throws it — a run that fails raises `WorkflowRunError`, and every caller
 * distinguishes it from a programming error by `instanceof`. Moving it here
 * rather than into transport.mjs keeps the protocol module free of run concepts,
 * and it keeps `engine.mjs` from having to import `transport.mjs` while
 * `transport.mjs` imports `engine.mjs` back.
 *
 * The rest of this module — run-directory allocation and artifact storage —
 * arrives with the step that moves them.
 */

/**
 * A run that failed for a reason the operator should read.
 *
 * Deliberately bare: the message a caller passes is the whole diagnosis, and
 * its name says where it comes from. Nothing subclasses it, because a run has
 * one failure mode — it could not finish — and the reason lives in the text.
 */
export class WorkflowRunError extends Error {}
