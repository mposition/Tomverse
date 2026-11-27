import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import {
  databaseErrorMetadata,
  hasDatabaseSqlstate,
  isCheckViolationDatabaseError,
  isRetryableDatabaseError,
  isTransactionStartFailure,
  isUniqueConstraintDatabaseError,
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
