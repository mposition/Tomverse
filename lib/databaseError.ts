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

export const isRetryableDatabaseError = (error: unknown) => {
  const metadata = databaseErrorMetadata(error);
  return Boolean(
    (metadata.errorCode && RETRYABLE_PRISMA_CODES.has(metadata.errorCode)) ||
      (metadata.driverKind &&
        RETRYABLE_DRIVER_KINDS.has(metadata.driverKind)) ||
      (metadata.driverCode &&
        RETRYABLE_POSTGRES_CODES.has(metadata.driverCode))
  );
};

/**
 * Whether an error was raised by Prisma or its driver adapter, whatever its
 * code: a fact about this application's database, never about a provider.
 */
export const isDatabaseError = (error: unknown) => {
  const name = databaseErrorMetadata(error).errorName;
  return name.startsWith("PrismaClient") || name === "DriverAdapterError";
};

/** Backoff before each re-run of a write that failed retryably: two more tries. */
export const DATABASE_WRITE_RETRY_DELAYS_MS: readonly number[] = [150, 500];
/** The pause before asking whether the last failed try committed after all. */
const FINAL_COMMIT_CHECK_DELAY_MS = 150;

/**
 * Runs a database write again when it failed with a retryable error -- but
 * only once the failed try is known not to have committed.
 *
 * A retryable error does not prove a rollback: a connection that drops during
 * COMMIT leaves the outcome unknown, and running the write again blindly would
 * duplicate it. So every failure is followed by `committed()`, after a short
 * pause, and a write that turns out to have landed is reported as
 * `already_committed` instead of being run again. If that read fails too, the
 * outcome stays unknown and the original error is thrown, never retried.
 *
 * `write` must be safe to run again after a rollback: one transaction, with
 * nothing outside it that the first try already changed.
 */
export async function runRetryableDatabaseWrite(input: {
  write: () => Promise<unknown>;
  committed: () => Promise<boolean>;
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (retry: { attempt: number; error: unknown }) => void;
}): Promise<"written" | "already_committed"> {
  const pending = [...(input.delaysMs ?? DATABASE_WRITE_RETRY_DELAYS_MS)];
  const sleep =
    input.sleep ??
    ((ms: number) => new Promise<void>((settle) => setTimeout(settle, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      await input.write();
      return "written";
    } catch (error) {
      if (!isRetryableDatabaseError(error)) throw error;
      const delay = pending.shift();
      await sleep(delay ?? FINAL_COMMIT_CHECK_DELAY_MS);
      let committed: boolean;
      try {
        committed = await input.committed();
      } catch {
        throw error;
      }
      if (committed) return "already_committed";
      if (delay === undefined) throw error;
      input.onRetry?.({ attempt, error });
    }
  }
}

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
