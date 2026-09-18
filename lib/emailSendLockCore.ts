/**
 * The time budgets around a customer send's address lock, and the one error
 * that means "somebody else holds it".
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 7.4
 * (time budgets), docs/policy/email-notifications.md section 9.8.
 *
 * Pure and dependency-free so tests/emailSendLockCore.test.mjs can drive the
 * classifier without a database. The locking itself lives in
 * lib/emailSendLock.ts.
 */

/**
 * How long a queued send waits for the address lock. Two seconds is long
 * enough to outlast a withdrawal's own transaction and short enough that a
 * drain pass carrying fifty rows cannot be stalled by one of them.
 */
export const STANDARD_SEND_LOCK_TIMEOUT_MS = 2_000;

/**
 * The interactive transaction that holds the lock across the provider call.
 * It has to outlast the provider timeout below, or the transaction would
 * expire while the submission it is protecting is still in flight.
 */
export const STANDARD_SEND_TRANSACTION_TIMEOUT_MS = 15_000;

/**
 * The provider call itself. Stated rather than left to the adapter's default:
 * the lane now holds a lock while it waits, so "how long can this wait" is a
 * decision the lock's budget depends on.
 */
export const STANDARD_SEND_PROVIDER_TIMEOUT_MS = 10_000;

/**
 * The credential lane's share. A login code has a person watching a sign-in
 * screen and a three-second request budget (CREDENTIAL_SEND_BUDGET_MS), so it
 * waits for the lock in tenths of a second and treats a miss as one more
 * retryable attempt rather than a reason to hold the request.
 */
export const CREDENTIAL_SEND_LOCK_TIMEOUT_MS = 300;

/**
 * When a queued message loses the lock and its own retry curve has nothing
 * left to offer -- a row already at its last attempt -- it still comes back,
 * because losing a lock is not a failed attempt. A minute, matching the first
 * step of every curve in lib/emailSendRetryCore.ts.
 */
export const SEND_LOCK_RETRY_MS = 60_000;

/**
 * Left to the provider call out of whatever budget remains once the lock is
 * held, so a submission never runs past the transaction that protects it.
 */
export const CREDENTIAL_SEND_RESERVE_MS = 100;

/**
 * Kept back from the transaction's remaining life, so a submission that spends
 * all of its timeout still leaves room for the transaction to finish.
 *
 * The provider timeout and the transaction timeout are two clocks that do not
 * know about each other. Prisma's `timeout` ends the transaction and releases
 * the advisory locks with it; an `AbortSignal.timeout` already in flight keeps
 * running. A send that began a ten-second call with six seconds of transaction
 * left would be submitting after its lock had gone -- after a withdrawal could
 * have taken that lock, committed, and answered the person who asked for it.
 * So the provider's budget is cut from what the transaction has left, less
 * this, and a send with nothing left submits nothing.
 */
export const SEND_COMMIT_RESERVE_MS = 250;

/**
 * What the provider may be given, out of what the transaction has left.
 *
 * Whole milliseconds, because `AbortSignal.timeout()` validates a uint32 and
 * throws `ERR_OUT_OF_RANGE` on the fraction `performance.now()` arithmetic
 * produces; rounded down, so the cut is never generous. Below one millisecond
 * there is no call to make -- the submission would be in flight after the
 * rollback released the address.
 *
 * Pure so the arithmetic is exercised directly: the value reaches the provider
 * through a mocked `fetch`, where the number itself is no longer observable.
 */
export const providerSendBudget = (input: {
  /** Transaction life left, already less the commit reserve. */
  leftMs: number;
  /** The lane cap, when the lane states one. */
  capMs?: number;
}): { send: false } | { send: true; providerTimeoutMs: number } => {
  const providerTimeoutMs = Math.floor(Math.min(input.capMs ?? input.leftMs, input.leftMs));
  if (providerTimeoutMs < 1) return { send: false };
  return { send: true, providerTimeoutMs };
};

export type CredentialSendWindow =
  | { send: false }
  | {
      send: true;
      /** The whole wait for the connection and the locks. */
      lockTimeoutMs: number;
      /** What the transaction may live for, including the room to commit. */
      transactionTimeoutMs: number;
      /** The most this attempt would ever give the provider. */
      providerCapMs: number;
    };

/**
 * What one credential attempt may spend, given what its request has left.
 *
 * Every wait here comes out of the same three seconds: the connection, the
 * locks and the provider call. Deriving them from the caps instead -- 300 +
 * 2,500 + 100 + 250 -- produced a ceiling of 3,150ms, longer than the budget it
 * was supposed to bound, and left a spent request still able to wait 300ms for
 * a connection and 300ms more for a lock before discovering it had nothing to
 * send.
 *
 * Pure, so the arithmetic is exercised at its edges -- a budget already gone, a
 * budget too small to be worth a call -- rather than inferred from the
 * constants (independent review, round 6).
 */
export const credentialSendWindow = (input: {
  budgetLeftMs: number;
  /** The attempt cap the retry curve allows. */
  attemptTimeoutMs: number;
}): CredentialSendWindow => {
  const left = Math.floor(input.budgetLeftMs);
  // Nothing left, or too little to leave the provider a millisecond after the
  // reserve. Either way the attempt is not worth the waits it would start.
  if (left <= CREDENTIAL_SEND_RESERVE_MS) return { send: false };
  const providerCapMs = Math.min(
    Math.floor(input.attemptTimeoutMs),
    left - CREDENTIAL_SEND_RESERVE_MS
  );
  if (providerCapMs < 1) return { send: false };
  return {
    send: true,
    lockTimeoutMs: Math.min(CREDENTIAL_SEND_LOCK_TIMEOUT_MS, left),
    // The room to commit is the one part outside the request budget: the
    // transaction has to survive the last thing the request does.
    transactionTimeoutMs: left + SEND_COMMIT_RESERVE_MS,
    providerCapMs,
  };
};

/**
 * Whether a thrown error is Postgres refusing to keep waiting for a lock
 * (SQLSTATE 55P03, `lock_not_available`).
 *
 * Matched on the SQLSTATE where the driver reports one and on the message
 * otherwise: Prisma wraps a raw-query failure in more than one shape depending
 * on which client path raised it, and a classifier that only knew one of them
 * would turn a busy address into a permanently failed delivery.
 *
 * Deliberately narrow. A statement timeout, a closed connection or a
 * constraint violation are not lock contention, and reporting them as a lock
 * miss would retry them forever under a name that says nothing went wrong.
 */
export const isLockTimeoutError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const meta = (error as { meta?: unknown }).meta;
  if (meta && typeof meta === "object") {
    const code = (meta as { code?: unknown }).code;
    if (typeof code === "string" && code === "55P03") return true;
  }
  const message = (error as { message?: unknown }).message;
  if (typeof message !== "string") return false;
  return (
    message.includes("55P03") ||
    /canceling statement due to lock timeout/i.test(message)
  );
};

/**
 * Whether a thrown error is the client giving up **before the transaction
 * started** -- no connection came free inside `maxWait`.
 *
 * Prisma reports this as `P2024` on some paths and as `P2028: Unable to start
 * a transaction in the given time` on the interactive-transaction path. Both
 * are matched, and neither is trusted on its own: `P2028` is *also* how a
 * transaction that expired **while running** is reported, and those two mean
 * opposite things -- one submitted nothing, the other may have submitted
 * everything. The caller therefore asks this only when it knows the callback
 * never ran (lib/emailSendLock.ts).
 */
export const isTransactionStartTimeoutError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  const text = typeof message === "string" ? message : "";
  if (code === "P2024") return true;
  if (code === "P2028" && /Unable to start a transaction/i.test(text)) return true;
  return (
    /Timed out fetching a new connection from the connection pool/i.test(text) ||
    /Unable to start a transaction in the given time/i.test(text)
  );
};
