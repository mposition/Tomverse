/**
 * The limits of the long single-transaction writes the Ideas flow posts, and
 * the browser deadline each request needs to outlast them.
 *
 * `adminFetch` aborts a request after 15 s (lib/adminFetch.ts). The plan
 * approval is one Serializable transaction that may legitimately run for
 * 120 s, so in production the browser gave up at 15 s (Railway logged the
 * request as closed by the client, HTTP 499) while the server kept working,
 * and the operator was told the outcome was unknown for a write that was still
 * about to commit. A request that waits for a transaction must outlast the
 * transaction's own `maxWait` + `timeout`; the services take their limits from
 * here, so the two cannot drift apart, and tests/amuxIdeaProgress.test.mjs
 * pins that each deadline exceeds the transaction it waits for.
 *
 * Pure: no database and no `server-only`, because the client reads it too.
 */

export type AmuxTransactionLimits = { readonly maxWait: number; readonly timeout: number };

/** The one-transaction writes that finish in well under a second in practice. */
export const AMUX_IDEA_STANDARD_TRANSACTION: AmuxTransactionLimits = { maxWait: 5_000, timeout: 15_000 };
/** Execution approval: the exact-input confirmation and the budget reservation together. */
export const AMUX_IDEA_EXECUTION_APPROVAL_TRANSACTION: AmuxTransactionLimits = { maxWait: 5_000, timeout: 20_000 };
/** Plan approval: every node, Story and Task, their scores and consent, in one transaction. */
export const AMUX_IDEA_PLAN_APPROVAL_TRANSACTION: AmuxTransactionLimits = { maxWait: 5_000, timeout: 120_000 };
/** The card-only and node-only plan writers (no screen posts to them yet). */
export const AMUX_IDEA_CARD_PLAN_APPROVAL_TRANSACTION: AmuxTransactionLimits = { maxWait: 5_000, timeout: 90_000 };
export const AMUX_IDEA_NODE_PLAN_APPROVAL_TRANSACTION: AmuxTransactionLimits = { maxWait: 5_000, timeout: 60_000 };

/** What the route, the response and the network may add around the transactions. */
export const AMUX_IDEA_REQUEST_MARGIN_MS = 10_000;

/**
 * The browser deadline of a request whose server work is these transactions
 * run one after another: each may wait for a connection and then run to its
 * timeout, plus the margin.
 */
export const amuxIdeaRequestTimeoutMs = (...transactions: AmuxTransactionLimits[]): number =>
  transactions.reduce((total, limits) => total + limits.maxWait + limits.timeout, AMUX_IDEA_REQUEST_MARGIN_MS);

/** POST /api/admin/amux/ideas/plan: 5 s + 120 s + margin = 135 s. */
export const AMUX_IDEA_PLAN_APPROVAL_REQUEST_TIMEOUT_MS = amuxIdeaRequestTimeoutMs(AMUX_IDEA_PLAN_APPROVAL_TRANSACTION);
/** POST /api/admin/amux/ideas/execution-approval: 5 s + 20 s + margin = 35 s. */
export const AMUX_IDEA_EXECUTION_APPROVAL_REQUEST_TIMEOUT_MS =
  amuxIdeaRequestTimeoutMs(AMUX_IDEA_EXECUTION_APPROVAL_TRANSACTION);
/**
 * POST /api/admin/amux/ideas/build-preview saves the idea, prepares its plan
 * and prepares its preview, each in its own standard transaction, one after
 * the other: 3 x 20 s + margin = 70 s.
 */
export const AMUX_IDEA_BUILD_PREVIEW_REQUEST_TIMEOUT_MS = amuxIdeaRequestTimeoutMs(
  AMUX_IDEA_STANDARD_TRANSACTION, AMUX_IDEA_STANDARD_TRANSACTION, AMUX_IDEA_STANDARD_TRANSACTION);
