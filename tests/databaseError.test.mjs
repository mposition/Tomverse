import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import {
  databaseErrorMetadata,
  hasDatabaseSqlstate,
  isCheckViolationDatabaseError,
  isRetryableDatabaseError,
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
