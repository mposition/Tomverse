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
  isTransactionStartFailure,
  isUniqueConstraintDatabaseError,
  retrySelfCheckingDatabaseWork,
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

/**
 * P2028 is Prisma's "Transaction API error", and it is two opposite things.
 * Only "Unable to start a transaction in the given time" is a failure before
 * anything ran; the expired/closed variants are raised in the middle of the
 * work, where a write's outcome may be unknown.
 */
const p2028 = (message) =>
  new Prisma.PrismaClientKnownRequestError(message, {
    code: "P2028",
    clientVersion: "test",
  });

test("a transaction that never started is retryable", () => {
  const error = p2028("Transaction API error: Unable to start a transaction in the given time.");
  assert.equal(isTransactionStartFailure(error), true);
  assert.equal(isRetryableDatabaseError(error), true);
});

test("a transaction that died part way is not made retryable by sharing its code", () => {
  for (const message of [
    "Transaction API error: A commit cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms.",
    "Transaction API error: A query cannot be executed on an expired transaction.",
    "Transaction API error: Transaction already closed: A commit cannot be executed on a committed transaction.",
    "Transaction API error: Transaction not found.",
  ]) {
    const error = p2028(message);
    assert.equal(isTransactionStartFailure(error), false, message);
    assert.equal(isRetryableDatabaseError(error), false, message);
  }
});

test("the start-failure message only counts on P2028", () => {
  const other = new Prisma.PrismaClientKnownRequestError(
    "Unable to start a transaction in the given time.",
    { code: "P2002", clientVersion: "test" }
  );
  assert.equal(isTransactionStartFailure(other), false);
  assert.equal(isTransactionStartFailure(new Error("Unable to start a transaction")), false);
  assert.equal(isTransactionStartFailure(null), false);
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

/*
  retrySelfCheckingDatabaseWork: for work that re-reads its own state under a
  lock, as the Chat settlement does (lib/chatSecurity.ts settleChatUsage). Its
  shape is what makes a blind re-run safe; these pin the retry itself.
*/
const connectionClosed = () =>
  Object.assign(new Error("connection closed"), {
    name: "DriverAdapterError",
    cause: { kind: "ConnectionClosed" },
  });

test("self-checking work is run again after a retryable failure", async () => {
  const delays = [];
  let runs = 0;
  const value = await retrySelfCheckingDatabaseWork({
    run: async () => {
      runs += 1;
      if (runs === 1) throw connectionClosed();
      return "settled";
    },
    sleep: async (ms) => { delays.push(ms); },
  });
  assert.equal(value, "settled");
  assert.equal(runs, 2);
  assert.deepEqual(delays, [150]);
});

test("a commit whose answer was lost is found by the next try and applied once", async () => {
  // The state the work guards: a reservation that is `reserved` until one
  // settlement moves it. The first try commits and then loses its answer.
  const row = { status: "reserved", applications: 0 };
  const settle = async () => {
    if (row.status !== "reserved") return { applied: false, status: row.status };
    row.status = "settled";
    row.applications += 1;
    return { applied: true, status: row.status };
  };
  let runs = 0;
  const result = await retrySelfCheckingDatabaseWork({
    run: async () => {
      runs += 1;
      const outcome = await settle();
      if (runs === 1) throw connectionClosed();
      return outcome;
    },
    sleep: noSleep,
  });
  assert.deepEqual(result, { applied: false, status: "settled" });
  assert.equal(row.applications, 1, "no second charge or refund");
  assert.equal(runs, 2);
});

test("a non-retryable failure is thrown at once", async () => {
  const refusal = new Error("constraint");
  let runs = 0;
  await assert.rejects(
    retrySelfCheckingDatabaseWork({
      run: async () => {
        runs += 1;
        throw refusal;
      },
      sleep: noSleep,
    }),
    (error) => error === refusal
  );
  assert.equal(runs, 1);
});

test("at most two more tries, then the last failure is thrown", async () => {
  const delays = [];
  const retries = [];
  let runs = 0;
  await assert.rejects(
    retrySelfCheckingDatabaseWork({
      run: async () => {
        runs += 1;
        throw writeConflict();
      },
      sleep: async (ms) => { delays.push(ms); },
      onRetry: ({ attempt }) => { retries.push(attempt); },
    }),
    (error) => error.code === "P2034"
  );
  assert.equal(runs, 3);
  assert.deepEqual(delays, [150, 500]);
  assert.deepEqual(retries, [1, 2]);
});

test("isDatabaseError names Prisma and driver-adapter errors, never a provider error", () => {
  assert.equal(isDatabaseError(writeConflict()), true);
  assert.equal(isDatabaseError(unmapped("23514")), true);
  assert.equal(isDatabaseError({ name: "DriverAdapterError", cause: { kind: "SocketTimeout" } }), true);
  assert.equal(isDatabaseError(Object.assign(new Error("overloaded"), { name: "AI_APICallError", statusCode: 529 })), false);
  assert.equal(isDatabaseError(new Error("plain")), false);
  assert.equal(isDatabaseError(null), false);
});
