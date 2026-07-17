import assert from "node:assert/strict";
import test from "node:test";
import {
  isMissingDatabaseSchemaError,
  isRetryableDatabaseError,
} from "../lib/databaseError.ts";

test("recognizes Prisma and PostgreSQL missing-schema errors", () => {
  assert.equal(isMissingDatabaseSchemaError({ code: "P2021" }), true);
  assert.equal(isMissingDatabaseSchemaError({ code: "P2022" }), true);
  assert.equal(
    isMissingDatabaseSchemaError({
      name: "DriverAdapterError",
      cause: { kind: "ColumnNotFound", originalCode: "42703" },
    }),
    true
  );
});

test("does not classify connectivity failures as missing schema", () => {
  const error = {
    name: "DriverAdapterError",
    cause: { kind: "DatabaseNotReachable", originalCode: "08006" },
  };
  assert.equal(isMissingDatabaseSchemaError(error), false);
  assert.equal(isRetryableDatabaseError(error), true);
});
