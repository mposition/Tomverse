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
