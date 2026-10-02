/**
 * Pure decisions for the QA-release digest silence check.
 *
 * docs/policy/qa-release-agent.md (version 1) is the contract: the app, not the
 * digest service, decides whether the daily digest has gone quiet, and it does
 * so with nothing but the facts read inside one database transaction. This
 * module turns those facts into a verdict. It reads no clock of its own, no
 * environment and no database -- every input is passed in, so the whole table
 * is covered by fixed-clock unit tests.
 */

/** A digest older than this is stale. Policy section 10: 28 hours. */
export const QA_RELEASE_STALE_AFTER_MS = 28 * 60 * 60 * 1000;

/**
 * The route budget the silence step runs inside, and the most each of its
 * transactions may take. Section 10 of the policy names these: the judgement
 * read is 11 s, the stale alert write 32 s and the monitor-failure write 26 s.
 * These are application figures derived from the statement and idle timeouts,
 * not database bounds.
 */
export const QA_RELEASE_ROUTE_BUDGET_MS = 300_000;
export const QA_RELEASE_READ_TX_MAX_MS = 11_000;
export const QA_RELEASE_STALE_WRITE_TX_MAX_MS = 32_000;
export const QA_RELEASE_FAILURE_WRITE_TX_MAX_MS = 26_000;

export type QaReleaseFreshnessVerdict =
  | "dark_not_configured"
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

/**
 * The four answers, in the order the policy states them.
 *
 * - No secret and nothing recorded as enabled: the environment cannot record a
 *   digest, and silence is expected (`dark_not_configured`).
 * - No secret while the operator recorded the agent as enabled: something
 *   removed it outside the audit trail, so it is reported, not hidden.
 * - A secret and no row at all: there is nothing to be fresh against.
 * - A secret and a row: stale once the newest row is 28 hours old.
 *
 * A row dated after `dbNowMs` reads as fresh. That happens only through a
 * write outside the app or a clock set backwards, both named residuals.
 */
export function judgeQaReleaseFreshness(input: QaReleaseFreshnessInput): QaReleaseFreshnessVerdict {
  if (!input.digestSecretConfigured) {
    return input.desiredEnabled === true ? "control_mismatch" : "dark_not_configured";
  }
  if (input.latestDigestCreatedAtMs === null) return "stale";
  if (input.dbNowMs - input.latestDigestCreatedAtMs >= QA_RELEASE_STALE_AFTER_MS) return "stale";
  return "fresh";
}

/** `YYYY-MM-DD` of the database clock in UTC -- the key one alert per day hangs on. */
export function qaReleaseUtcDateKey(dbNowMs: number): string {
  if (!Number.isFinite(dbNowMs)) throw new RangeError("dbNowMs must be a finite number");
  return new Date(dbNowMs).toISOString().slice(0, 10);
}

/** `referenceId` of the stale alert. One per UTC date, enforced by the queue's unique key. */
export function qaReleaseStaleReferenceId(dbNowMs: number): string {
  return `stale:${qaReleaseUtcDateKey(dbNowMs)}`;
}

export type QaReleaseBudgetPlan =
  /** Not even the read fits: touch nothing. */
  | { kind: "skipped_no_budget" }
  /**
   * The read fits but the stale-alert write would not: read, and defer that
   * write. Whether a failed read could still be recorded depends on the
   * smaller failure-write maximum.
   */
  | { kind: "read_only"; failureWriteFits: boolean }
  /** The read and both writes fit. */
  | { kind: "full" };

/**
 * What the silence step may open, given how much of the route's budget the
 * steps before it already spent. A transaction is opened only when the budget
 * left is at least its maximum.
 */
export function planQaReleaseFreshnessBudget(elapsedMs: number): QaReleaseBudgetPlan {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new RangeError("elapsedMs must be a non-negative finite number");
  }
  const remaining = QA_RELEASE_ROUTE_BUDGET_MS - elapsedMs;
  if (remaining < QA_RELEASE_READ_TX_MAX_MS) return { kind: "skipped_no_budget" };
  if (remaining < QA_RELEASE_STALE_WRITE_TX_MAX_MS) {
    return { kind: "read_only", failureWriteFits: remaining >= QA_RELEASE_FAILURE_WRITE_TX_MAX_MS };
  }
  return { kind: "full" };
}
