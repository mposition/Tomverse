import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import {
  DatabaseWriteOutcomeUnknownError,
  databaseErrorMetadata,
  hasDatabaseSqlstate,
  isCheckViolationDatabaseError,
  isDatabaseError,
  isRetryableDatabaseError,
  isUniqueConstraintDatabaseError,
  runRetryableDatabaseWrite,
} from "../lib/databaseError.ts";

/**
 * What Prisma throws through the pg adapter for an SQLSTATE the adapter does
 * not map: P2039, no `cause`, the code at
 * `meta.driverAdapterError.cause.originalCode`. Built with Prisma's own class.
 * The product-research window trigger's refusal reached production in exactly
 * this shape (logged databaseCode="P2039") and answered 500.
 */
const unmapped = (sqlstate) =>
  new Prisma.PrismaClientKnownRequestError("refused", {
    code: "P2039",
    clientVersion: "test",
    meta: {
      driverAdapterError: {
        name: "DriverAdapterError",
        cause: { kind: "postgres", code: sqlstate, originalCode: sqlstate, originalMessage: "refused" },
      },
    },
  });

test("finds a trigger's check_violation where Prisma really puts it", () => {
  const error = unmapped("23514");
  assert.equal("cause" in error, false);
  assert.equal(databaseErrorMetadata(error).driverCode, undefined);
  assert.equal(hasDatabaseSqlstate(error, "23514"), true);
  assert.equal(isCheckViolationDatabaseError(error), true);
});

test("check_violation is not any other P2039 or a plain failure", () => {
  assert.equal(isCheckViolationDatabaseError(unmapped("57014")), false);
  assert.equal(isCheckViolationDatabaseError(new Error("23514")), false);
  assert.equal(isCheckViolationDatabaseError({ code: "P2004" }), true);
  assert.equal(isCheckViolationDatabaseError(null), false);
});

test("recognizes retryable Prisma and driver adapter database errors", () => {
  assert.equal(isRetryableDatabaseError({ code: "P2024" }), true);
  assert.equal(
    isRetryableDatabaseError({
      name: "DriverAdapterError",
      cause: { kind: "ConnectionClosed" },
    }),
    true
  );
  assert.equal(
    isRetryableDatabaseError({
      name: "DriverAdapterError",
      cause: { kind: "postgres", code: "53300" },
    }),
    true
  );
  assert.equal(
    isRetryableDatabaseError({
      name: "DriverAdapterError",
      cause: {
        kind: "TransactionAlreadyClosed",
        message: "Transaction is no longer valid. Last state: 'Expired'.",
      },
    }),
    true
  );
});

test("recognizes adapter-level unique constraint errors as deduplicated", () => {
  assert.equal(isUniqueConstraintDatabaseError({ code: "P2002" }), true);
  assert.equal(
    isUniqueConstraintDatabaseError({
      name: "DriverAdapterError",
      cause: { kind: "UniqueConstraintViolation" },
    }),
    true
  );
});

test("exposes a sanitized driver cause for operational diagnosis", () => {
  const metadata = databaseErrorMetadata({
    name: "DriverAdapterError",
    cause: {
      kind: "SocketTimeout",
      originalCode: "ETIMEDOUT",
      originalMessage: "connection timed out",
    },
  });
  assert.deepEqual(metadata, {
    errorName: "DriverAdapterError",
    errorCode: undefined,
    driverKind: "SocketTimeout",
    driverCode: "ETIMEDOUT",
    message: "connection timed out",
  });
});

/*
  runRetryableDatabaseWrite: the assistant Message write's retry
  (app/api/chat/route.ts). A retryable failure is re-run only after a read
  says the failed try did not commit -- a dropped COMMIT has an unknown
  outcome, and a blind re-run would write twice.
*/
const writeConflict = () =>
  Object.assign(new Error("write conflict"), {
    name: "PrismaClientKnownRequestError",
    code: "P2034",
  });
const noSleep = async () => undefined;

test("a retryable failure that did not commit is run again", async () => {
  let writes = 0;
  const retries = [];
  const outcome = await runRetryableDatabaseWrite({
    write: async () => {
      writes += 1;
      if (writes === 1) throw writeConflict();
    },
    committed: async () => false,
    sleep: noSleep,
    onRetry: (retry) => retries.push(retry.attempt),
  });
  assert.equal(outcome, "written");
  assert.equal(writes, 2);
  assert.deepEqual(retries, [1]);
});

test("a failed try that in fact committed is not written twice", async () => {
  let writes = 0;
  const outcome = await runRetryableDatabaseWrite({
    write: async () => {
      writes += 1;
      throw writeConflict();
    },
    committed: async () => true,
    sleep: noSleep,
  });
  assert.equal(outcome, "already_committed");
  assert.equal(writes, 1);
});

test("a non-retryable failure is not retried, but is still checked before it is called a rollback", async () => {
  const unique = Object.assign(new Error("duplicate"), { code: "P2002" });
  let writes = 0;
  let checks = 0;
  const delays = [];
  await assert.rejects(
    runRetryableDatabaseWrite({
      write: async () => {
        writes += 1;
        throw unique;
      },
      committed: async () => {
        checks += 1;
        return false;
      },
      sleep: async (ms) => {
        delays.push(ms);
      },
    }),
    // Checked and not found: the write's own error, meaning "not committed".
    (error) => error === unique
  );
  assert.equal(writes, 1);
  assert.equal(checks, 1);
  assert.deepEqual(delays, [], "nothing to wait for when no retry follows");
});

test("an unreadable outcome is never retried and is reported as unknown, not as the write's error", async () => {
  const conflict = writeConflict();
  let writes = 0;
  await assert.rejects(
    runRetryableDatabaseWrite({
      write: async () => {
        writes += 1;
        throw conflict;
      },
      committed: async () => {
        throw new Error("database still down");
      },
      sleep: noSleep,
    }),
    (error) => error instanceof DatabaseWriteOutcomeUnknownError && error.cause === conflict
  );
  assert.equal(writes, 1);
});

test("a non-retryable failure whose outcome cannot be read is unknown too", async () => {
  const odd = new Error("socket hang up during COMMIT");
  await assert.rejects(
    runRetryableDatabaseWrite({
      write: async () => {
        throw odd;
      },
      committed: async () => {
        throw new Error("still down");
      },
      sleep: noSleep,
    }),
    (error) => error instanceof DatabaseWriteOutcomeUnknownError && error.cause === odd
  );
});

test("at most two more tries, then the last failure is checked once more and thrown", async () => {
  let writes = 0;
  let checks = 0;
  const delays = [];
  const conflict = writeConflict();
  await assert.rejects(
    runRetryableDatabaseWrite({
      write: async () => {
        writes += 1;
        throw conflict;
      },
      committed: async () => {
        checks += 1;
        return false;
      },
      sleep: async (ms) => {
        delays.push(ms);
      },
    }),
    (error) => error === conflict
  );
  assert.equal(writes, 3);
  assert.equal(checks, 3);
  assert.deepEqual(delays, [150, 500, 150]);
});

test("a last try that turns out to have committed is reported as committed", async () => {
  let checks = 0;
  const outcome = await runRetryableDatabaseWrite({
    write: async () => {
      throw writeConflict();
    },
    committed: async () => {
      checks += 1;
      return checks === 3;
    },
    sleep: noSleep,
  });
  assert.equal(outcome, "already_committed");
});

test("isDatabaseError names Prisma and driver-adapter errors, never a provider error", () => {
  assert.equal(isDatabaseError(writeConflict()), true);
  assert.equal(isDatabaseError(unmapped("23514")), true);
  assert.equal(isDatabaseError({ name: "DriverAdapterError", cause: { kind: "SocketTimeout" } }), true);
  assert.equal(isDatabaseError(Object.assign(new Error("overloaded"), { name: "AI_APICallError", statusCode: 529 })), false);
  assert.equal(isDatabaseError(new Error("plain")), false);
  assert.equal(isDatabaseError(null), false);
});
