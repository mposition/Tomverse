import { sanitizeOperationalText } from "@/lib/operationalMonitoringCore";

type ErrorLike = {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  cause?: unknown;
};

type DriverCause = {
  kind?: unknown;
  code?: unknown;
  originalCode?: unknown;
  originalMessage?: unknown;
  message?: unknown;
};

const asRecord = (value: unknown): ErrorLike | null =>
  value && typeof value === "object" ? (value as ErrorLike) : null;

const driverCause = (error: unknown): DriverCause | null => {
  const cause = asRecord(error)?.cause;
  return cause && typeof cause === "object" ? (cause as DriverCause) : null;
};

const safeString = (value: unknown, maxLength = 500) =>
  typeof value === "string" && value.trim()
    ? sanitizeOperationalText(value, maxLength)
    : undefined;

export const databaseErrorMetadata = (error: unknown) => {
  const value = asRecord(error);
  const cause = driverCause(error);
  return {
    errorName: safeString(value?.name, 120) || "UnknownError",
    errorCode: safeString(value?.code, 80),
    driverKind: safeString(cause?.kind, 120),
    driverCode:
      safeString(cause?.originalCode, 80) || safeString(cause?.code, 80),
    message:
      safeString(cause?.originalMessage) ||
      safeString(cause?.message) ||
      safeString(value?.message) ||
      "Unknown database error.",
  };
};

const RETRYABLE_PRISMA_CODES = new Set([
  "P1001",
  "P1002",
  "P1008",
  "P1017",
  "P2024",
  "P2034",
]);

const RETRYABLE_DRIVER_KINDS = new Set([
  "DatabaseNotReachable",
  "ConnectionClosed",
  "SocketTimeout",
  "TooManyConnections",
  "TransactionWriteConflict",
  "TransactionAlreadyClosed",
]);

const RETRYABLE_POSTGRES_CODES = new Set([
  "40001",
  "40P01",
  "53300",
  "57P01",
  "57P02",
  "57P03",
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
]);

/**
 * Prisma's interactive transaction never got a connection inside `maxWait`.
 *
 * P2028 ("Transaction API error") names two opposite situations. This is the
 * one where nothing ran: the callback was not invoked and no statement was sent.
 * The other P2028 messages ("... on an expired transaction", "Transaction
 * already closed") are raised in the middle of the work, where the outcome of a
 * write may be unknown, and are deliberately not matched.
 */
export const isTransactionStartFailure = (error: unknown) => {
  const value = asRecord(error);
  return (
    value?.code === "P2028" &&
    typeof value.message === "string" &&
    /unable to start a transaction/i.test(value.message)
  );
};

export const isRetryableDatabaseError = (error: unknown) => {
  const metadata = databaseErrorMetadata(error);
  return Boolean(
    (metadata.errorCode && RETRYABLE_PRISMA_CODES.has(metadata.errorCode)) ||
      (metadata.driverKind &&
        RETRYABLE_DRIVER_KINDS.has(metadata.driverKind)) ||
      (metadata.driverCode &&
        RETRYABLE_POSTGRES_CODES.has(metadata.driverCode)) ||
      isTransactionStartFailure(error)
  );
};

export const isUniqueConstraintDatabaseError = (error: unknown) => {
  const metadata = databaseErrorMetadata(error);
  return (
    metadata.errorCode === "P2002" ||
    metadata.driverKind === "UniqueConstraintViolation" ||
    metadata.driverCode === "23505"
  );
};

/**
 * Whether a database error carries this SQLSTATE, wherever Prisma put it.
 *
 * `databaseErrorMetadata` reads `error.cause`, which is not enough: for a code
 * @prisma/adapter-pg does not map (23514 check_violation is one), Prisma throws
 * a `P2039` with no `cause`, and the code sits at
 * `meta.driverAdapterError.cause.originalCode`. Walked structurally so a change
 * in how deeply the adapter wraps it does not hide the code.
 */
export const hasDatabaseSqlstate = (error: unknown, wanted: string): boolean => {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  while (queue.length > 0 && seen.size < 16) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (record.code === wanted || record.originalCode === wanted) return true;
    queue.push(record.cause, record.meta, record.driverAdapterError);
  }
  return false;
};

/**
 * A CHECK constraint, or a trigger raising `check_violation`, refused the row.
 * P2004 is Prisma's own name for it; through the pg adapter it arrives as
 * P2039 carrying SQLSTATE 23514.
 */
export const isCheckViolationDatabaseError = (error: unknown) =>
  databaseErrorMetadata(error).errorCode === "P2004" || hasDatabaseSqlstate(error, "23514");

const MISSING_SCHEMA_PRISMA_CODES =new Set(["P2021", "P2022"]);
const MISSING_SCHEMA_DRIVER_KINDS = new Set([
  "TableDoesNotExist",
  "ColumnNotFound",
]);
const MISSING_SCHEMA_POSTGRES_CODES = new Set(["42P01", "42703"]);

/**
 * Detects an unavailable table or column during a rolling deployment. Callers
 * must only use this for data that has a safe compatibility fallback; it must
 * not be used to hide general database failures.
 */
export const isMissingDatabaseSchemaError = (error: unknown) => {
  const metadata = databaseErrorMetadata(error);
  return Boolean(
    (metadata.errorCode &&
      MISSING_SCHEMA_PRISMA_CODES.has(metadata.errorCode)) ||
      (metadata.driverKind &&
        MISSING_SCHEMA_DRIVER_KINDS.has(metadata.driverKind)) ||
      (metadata.driverCode &&
        MISSING_SCHEMA_POSTGRES_CODES.has(metadata.driverCode))
  );
};

/* -------------------------------------------------------------------------- */
/* A transient refusal, as the server says it and the browser reads it         */
/* -------------------------------------------------------------------------- */
/*
 * The one code, header and delay a transient database refusal travels with.
 * Raised by the chat route and by the shared rate limiter, read by the browser,
 * so everything here is pure: this file is imported into a client bundle.
 *
 * What the code promises: nothing a provider could have seen happened, and the
 * same request may be sent once more. It never describes a failure after a
 * provider call began -- that is `AI_PROVIDER_ERROR`'s story, and re-sending
 * there could pay twice.
 */

export const DATABASE_TEMPORARILY_UNAVAILABLE_CODE =
  "DATABASE_TEMPORARILY_UNAVAILABLE";

/** `Retry-After` the server sends, in seconds. */
export const DATABASE_RETRY_AFTER_SECONDS = 2;

/** The browser never waits longer than this before its single resend. */
export const DATABASE_RETRY_MAX_DELAY_MS = 10_000;

export const isTransientDatabaseCode = (code: unknown): boolean =>
  code === DATABASE_TEMPORARILY_UNAVAILABLE_CODE;

/**
 * How long to wait before the one automatic resend.
 *
 * `Retry-After` carries delta-seconds here; an HTTP-date, a negative number or
 * garbage falls back to the server's own default instead of being trusted, and
 * the result is clamped so a misbehaving proxy cannot park a send for minutes.
 */
export const transientDatabaseRetryDelayMs = (
  retryAfterHeader: string | null | undefined
): number => {
  const seconds = Number(retryAfterHeader);
  const chosen =
    retryAfterHeader && Number.isFinite(seconds) && seconds >= 0
      ? seconds
      : DATABASE_RETRY_AFTER_SECONDS;
  return Math.min(Math.round(chosen * 1_000), DATABASE_RETRY_MAX_DELAY_MS);
};

/**
 * Resolves after `ms`, or at once when `signal` aborts so a Stop pressed during
 * the wait is honoured immediately. The caller re-checks the signal afterwards.
 */
export const waitForTransientRetry = (
  ms: number,
  signal: AbortSignal
): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
