/**
 * Pure decisions for the QA-release digest silence check.
 *
 * docs/policy/qa-release-agent.md is the contract: the app, not the digest
 * service, decides whether the daily digest has gone quiet, and it does so
 * with nothing but the facts read inside one database transaction. This
 * module turns those facts into a verdict. It reads no clock of its own, no
 * environment and no database -- every input is passed in, so the whole table
 * is covered by fixed-clock unit tests.
 */

/** A digest whose age is 28 hours or more is stale. Policy section 10. */
export const QA_RELEASE_STALE_AFTER_MS = 28 * 60 * 60 * 1000;

/**
 * The most each transaction of one silence round may take (policy section 10:
 * `3A + 5` seconds for A statements). Application figures derived from the
 * statement and idle timeouts, not database bounds.
 */
export const QA_RELEASE_READ_TX_MAX_MS = 11_000;
export const QA_RELEASE_STALE_WRITE_TX_MAX_MS = 32_000;
export const QA_RELEASE_FAILURE_WRITE_TX_MAX_MS = 26_000;

export type QaReleaseFreshnessVerdict =
  /** No secret and no record of being enabled: this environment cannot record a digest. */
  | "dark_not_configured"
  /** The operator recorded the agent as off: silence is expected. */
  | "operator_disabled"
  /** No secret while recorded as enabled: removed outside the audit trail. */
  | "control_mismatch"
  | "stale"
  | "fresh";

export type QaReleaseFreshnessInput = {
  /** Whether the app has `QA_RELEASE_DIGEST_SECRET` at all. Never its value. */
  digestSecretConfigured: boolean;
  /**
   * The latest operator-control revision's `desiredEnabled`, or `null` when no
   * revision has been recorded yet.
   */
  desiredEnabled: boolean | null;
  /** `createdAt` of the newest digest row for this agent, or `null` if none. */
  latestDigestCreatedAtMs: number | null;
  /** The database clock at the time of the read. */
  dbNowMs: number;
};

function assertClock(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be a finite number`);
}

/**
 * The verdict, in the order the policy states it.
 *
 * - Recorded off: quiet, whatever else is true.
 * - No secret: quiet if never recorded as enabled, a mismatch if it was.
 * - A secret and no row at all: there is nothing to be fresh against, so stale.
 * - A secret and a row: stale once the newest row is 28 hours old, and stale
 *   when the newest row is dated after the database clock -- a clock set
 *   backwards or a write from outside the app must not read as healthy.
 *
 * A clock that is not a finite number throws: the caller records that as a
 * monitor failure rather than as a verdict.
 */
export function judgeQaReleaseFreshness(input: QaReleaseFreshnessInput): QaReleaseFreshnessVerdict {
  assertClock(input.dbNowMs, "dbNowMs");
  if (input.latestDigestCreatedAtMs !== null) {
    assertClock(input.latestDigestCreatedAtMs, "latestDigestCreatedAtMs");
  }

  if (input.desiredEnabled === false) return "operator_disabled";
  if (!input.digestSecretConfigured) {
    return input.desiredEnabled === true ? "control_mismatch" : "dark_not_configured";
  }
  const latest = input.latestDigestCreatedAtMs;
  if (latest === null) return "stale";
  if (latest > input.dbNowMs) return "stale";
  if (input.dbNowMs - latest >= QA_RELEASE_STALE_AFTER_MS) return "stale";
  return "fresh";
}

/** `YYYY-MM-DD` of the database clock in UTC -- the key one alert per day hangs on. */
export function qaReleaseUtcDateKey(dbNowMs: number): string {
  assertClock(dbNowMs, "dbNowMs");
  return new Date(dbNowMs).toISOString().slice(0, 10);
}

/** `referenceId` of the stale alert. One per UTC date, enforced by the queue's unique key. */
export function qaReleaseStaleReferenceId(dbNowMs: number): string {
  return `stale:${qaReleaseUtcDateKey(dbNowMs)}`;
}

export type QaReleaseRoundTransaction = "read" | "stale_write" | "failure_write";

const TRANSACTION_MAX_MS: Record<QaReleaseRoundTransaction, number> = {
  read: QA_RELEASE_READ_TX_MAX_MS,
  stale_write: QA_RELEASE_STALE_WRITE_TX_MAX_MS,
  failure_write: QA_RELEASE_FAILURE_WRITE_TX_MAX_MS,
};

/**
 * Whether one transaction of the silence round may be opened now.
 *
 * Asked immediately before each transaction with the time spent so far,
 * including any transaction this round already ran: the budget is spent in
 * sequence, so a read that took its full 11 s leaves 11 s less for the write
 * after it. `budgetMs` is the caller's own deadline -- the route's when the
 * step runs inside the credit-reconciliation route, the Monitor caller's when
 * it runs on its own -- never a constant assumed here.
 */
export function qaReleaseTransactionFits(
  transaction: QaReleaseRoundTransaction,
  elapsedMs: number,
  budgetMs: number,
): boolean {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new RangeError("elapsedMs must be a non-negative finite number");
  }
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    throw new RangeError("budgetMs must be a positive finite number");
  }
  return budgetMs - elapsedMs >= TRANSACTION_MAX_MS[transaction];
}
