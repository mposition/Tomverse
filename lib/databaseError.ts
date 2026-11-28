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
 * A write failed and nobody could find out whether it committed.
 *
 * Distinct from the write's own error on purpose: that error means "it did
 * not land" (the commit check said so), while this one means "it may have",
 * and a caller must not do anything destructive -- delete what the write
 * would have referenced -- on the strength of it. The write's error is on
 * `cause`.
 */
export class DatabaseWriteOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super("A database write failed and whether it committed is unknown.", {
      cause,
    } as ErrorOptions);
    this.name = "DatabaseWriteOutcomeUnknownError";
  }
}

/**
 * Runs a database write again when it failed with a retryable error -- but
 * only once the failed try is known not to have committed -- and says, for a
 * write that finally fails, whether it is known not to have landed.
 *
 * No failure proves a rollback on its own: a connection that drops during
 * COMMIT leaves the outcome unknown, and running the write again blindly
 * would duplicate it. So every failure is followed by `committed()` (after a
 * short pause for a retryable one). The three outcomes:
 *
 * - committed: `written`, or `already_committed` when the check found it;
 * - known not committed: the write's own error is thrown, once a retryable
 *   failure has had its two more tries;
 * - unknown (the check itself failed): `DatabaseWriteOutcomeUnknownError`,
 *   never retried.
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
      const retryable = isRetryableDatabaseError(error);
      const delay = retryable ? pending.shift() : undefined;
      if (retryable) await sleep(delay ?? FINAL_COMMIT_CHECK_DELAY_MS);
      let committed: boolean;
      try {
        committed = await input.committed();
      } catch {
        throw new DatabaseWriteOutcomeUnknownError(error);
      }
      if (committed) return "already_committed";
      if (delay === undefined) throw error;
      input.onRetry?.({ attempt, error });
    }
  }
}

/**
 * Runs work again after a retryable database failure, for work that decides
 * for itself whether it has already happened.
 *
 * `runRetryableDatabaseWrite` asks a separate `committed()` question because
 * its write cannot tell a re-run from a first run. A transaction that takes its
 * own lock and re-reads the state it is about to change answers that question
 * inside itself: a try whose COMMIT landed and whose answer was lost leaves the
 * state changed, and the next try reads that and changes nothing. Only work of
 * that shape may be handed here -- anything else would be applied twice.
 *
 * A non-retryable failure, or a retryable one after the last delay, is thrown
 * as it was raised.
 */
export async function retrySelfCheckingDatabaseWork<T>(input: {
  run: () => Promise<T>;
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (retry: { attempt: number; error: unknown }) => void;
}): Promise<T> {
  const pending = [...(input.delaysMs ?? DATABASE_WRITE_RETRY_DELAYS_MS)];
  const sleep =
    input.sleep ??
    ((ms: number) => new Promise<void>((settle) => setTimeout(settle, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await input.run();
    } catch (error) {
      const delay = isRetryableDatabaseError(error) ? pending.shift() : undefined;
      if (delay === undefined) throw error;
      input.onRetry?.({ attempt, error });
      await sleep(delay);
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
 * Whether a unique-constraint error names `needle` as one of the constrained columns or as the index.
 *
 * Prisma reports the violated constraint in `meta.target` (the column list, or the index name), and a driver
 * adapter in `meta.driverAdapterError.cause.constraint` (`fields` or `index`). Walked structurally, like
 * hasDatabaseSqlstate, because how deep the adapter wraps it varies. A unique violation that does not say
 * which constraint it was never matches: the caller must not treat an unknown conflict as a known one.
 */
export const uniqueConstraintNames = (error: unknown): string[] => {
  const names: string[] = [];
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  const take = (value: unknown) => {
    if (typeof value === "string") names.push(value);
    else if (Array.isArray(value)) for (const entry of value) if (typeof entry === "string") names.push(entry);
  };
  while (queue.length > 0 && seen.size < 16) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    take(record.target);
    take(record.fields);
    take(record.index);
    queue.push(record.cause, record.meta, record.driverAdapterError, record.constraint);
  }
  return names;
};

/** A unique violation of a constraint that involves `needle` (a column name or the index name). */
export const isUniqueConstraintOn = (error: unknown, needle: string): boolean =>
  isUniqueConstraintDatabaseError(error) &&
  uniqueConstraintNames(error).some((name) => name.includes(needle));

/**
 * Runs an idempotent write and, if it loses a unique-constraint race, runs it
 * once more.
 *
 * Prisma's `upsert` is a read followed by a create, not an atomic statement:
 * two requests that both find no row both try to create it, and the second
 * raises P2002. By the time it does, the winner's row exists, so the same
 * upsert now takes its update branch. Only for a write whose repeat is
 * harmless (the same values, last writer wins); never for one that spends,
 * counts or sends.
 */
export async function retryOnceOnUniqueConstraint<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (!isUniqueConstraintDatabaseError(error)) throw error;
    return write();
  }
}

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
