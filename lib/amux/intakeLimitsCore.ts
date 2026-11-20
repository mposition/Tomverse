/**
 * Owner direction 2026-11-15: the AMUX idea flow (input, analysis, card plan,
 * score) is an internal development flow. An idea, an analysis page, a plan or
 * a score is never refused, cut or stopped for its length, its count or its
 * age; a large one is carried through in more pages or rounds instead. The
 * boundaries that stay are the irreversible ones: secret and host checks on
 * the input, cost caps and ledgers of paid calls, the audit chain, and data
 * deletion, which only ever happens later than before, never sooner.
 *
 * Owner direction 2026-11-16: the switch that restored the former limits is
 * gone, with every former limit it restored. A database constraint the
 * direction relaxed stays relaxed.
 */

/**
 * The one ceiling left on a single model answer or request body in this flow.
 * It is not a policy limit: no model returns more than about 128k output
 * tokens (about 0.5 MiB of text) in one answer, so 4 MiB never cuts a real
 * answer, idea or CI log; it only keeps one request from holding unbounded
 * memory in the app server.
 */
export const AMUX_INTAKE_SAFETY_MAX_BYTES = 4 * 1024 * 1024;
