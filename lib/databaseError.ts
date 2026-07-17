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
