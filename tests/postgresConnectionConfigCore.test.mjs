import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

import {
  isSamePostgresDatabaseTarget,
  PostgresConnectionConfigurationError,
  resolvePostgresConnectionConfig,
} from "../lib/postgresConnectionConfigCore.mjs";

test("schema parameters become both adapter schema and a no-fallback search_path", () => {
  const config = resolvePostgresConnectionConfig(
    "postgresql://tester:secret@db.example.test:5432/postgres?schema=tomverse_test_guard&sslmode=require",
    { requireTestMarker: true }
  );

  assert.equal(config.schema, "tomverse_test_guard");
  assert.equal(config.poolOptions, "-c search_path=tomverse_test_guard");
  assert.equal(new URL(config.connectionString).searchParams.has("schema"), false);
  assert.equal(
    new URL(config.connectionString).searchParams.get("uselibpqcompat"),
    "true"
  );
});

test("a missing test marker and an unsafe schema are refused", () => {
  assert.throws(
    () =>
      resolvePostgresConnectionConfig(
        "postgresql://tester:secret@db.example.test:5432/postgres",
        { requireTestMarker: true }
      ),
    PostgresConnectionConfigurationError
  );
  assert.throws(
    () =>
      resolvePostgresConnectionConfig(
        "postgresql://tester:secret@db.example.test:5432/postgres?schema=test%3Bpublic"
      ),
    /simple lowercase PostgreSQL identifier/
  );
});

test("database identity ignores passwords and query parameters", () => {
  const application =
    "postgresql://app:old-secret@db.example.test:5432/postgres?sslmode=verify-full";
  const derivedTest =
    "postgresql://rotated-role:new-secret@db.example.test:5432/postgres?schema=tomverse_test_guard";
  assert.equal(isSamePostgresDatabaseTarget(application, derivedTest), true);
  assert.equal(
    isSamePostgresDatabaseTarget(
      application,
      "postgresql://app:new-secret@db.example.test:5432/tomverse_test"
    ),
    false
  );
});

test("the DB integration runner rejects a production-derived schema before starting Prisma", () => {
  const base = "postgresql://app:production-secret@db.example.test:5432/postgres";
  const result = spawnSync(
    process.execPath,
    [join(process.cwd(), "scripts", "run-db-integration-tests.mjs")],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TEST_DATABASE_URL: `${base}?schema=tomverse_test_guard`,
        DATABASE_URL: "",
        DIRECT_DATABASE_URL: `${base}?sslmode=verify-full`,
      },
      encoding: "utf8",
    }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /same PostgreSQL database as DIRECT_DATABASE_URL/);
  assert.doesNotMatch(result.stderr, /production-secret/);
  assert.doesNotMatch(result.stdout, /Generating the Prisma client/);
});
