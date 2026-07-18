import assert from "node:assert/strict";
import test from "node:test";
import {
  databaseErrorMetadata,
  isRetryableDatabaseError,
  isUniqueConstraintDatabaseError,
} from "../lib/databaseError.ts";

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
