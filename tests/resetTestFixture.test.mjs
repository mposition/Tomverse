import assert from "node:assert/strict";
import test from "node:test";
import { resetTestFixture } from "./integration/resetTestFixture.ts";

const previous = {
  test: process.env.TEST_DATABASE_URL,
  active: process.env.DATABASE_URL,
};
const restore = () => {
  if (previous.test === undefined) delete process.env.TEST_DATABASE_URL;
  else process.env.TEST_DATABASE_URL = previous.test;
  if (previous.active === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previous.active;
};

test("fixture reset rejects non-test and mismatched database targets", async () => {
  const called = [];
  const prisma = { $transaction: async (callback) => {
    called.push("transaction");
    return callback({ $executeRawUnsafe: async (sql) => called.push(sql),
      $queryRawUnsafe: async () => [{ database: "tomverse_test" }] });
  } };
  try {
    process.env.TEST_DATABASE_URL = "postgresql://postgres@127.0.0.1:55477/tomverse_test";
    process.env.DATABASE_URL = "postgresql://postgres@127.0.0.1:55477/tomverse_prod";
    await assert.rejects(resetTestFixture(prisma, "TRUNCATE TABLE x CASCADE"), /exact test database/);
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.TEST_DATABASE_URL = "postgresql://postgres@db.example/tomverse_test";
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    await assert.rejects(resetTestFixture(prisma, "TRUNCATE TABLE x CASCADE"), /loopback test databases/);
    process.env.TEST_DATABASE_URL = "postgresql://postgres@127.0.0.1:55477/tomverse_test?host=db.example";
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    await assert.rejects(resetTestFixture(prisma, 'TRUNCATE TABLE "AdminAuditLog" RESTART IDENTITY CASCADE'), /loopback test databases/);
    assert.deepEqual(called, []);
  } finally { restore(); }
});

test("fixture reset scopes trigger bypass to one transaction and one truncate", async () => {
  const statements = [];
  const prisma = { $transaction: async (callback) => callback({
    $executeRawUnsafe: async (sql) => statements.push(sql),
    $queryRawUnsafe: async () => [{ database: "tomverse_test" }],
  }) };
  try {
    process.env.TEST_DATABASE_URL = "postgresql://postgres@127.0.0.1:55477/tomverse_test";
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    await resetTestFixture(prisma, 'TRUNCATE TABLE "AdminAuditLog" RESTART IDENTITY CASCADE');
    assert.deepEqual(statements, [
      "SET LOCAL session_replication_role = replica",
      'TRUNCATE TABLE "AdminAuditLog" RESTART IDENTITY CASCADE',
    ]);
    await resetTestFixture(prisma, '\n TRUNCATE TABLE\n  "AdminAuditLog"\n RESTART IDENTITY CASCADE\n');
    assert.equal(statements.at(-1).trim(), 'TRUNCATE TABLE\n  "AdminAuditLog"\n RESTART IDENTITY CASCADE');
    process.env.TEST_DATABASE_URL = ` ${process.env.DATABASE_URL}\r\n`;
    await resetTestFixture(prisma, 'TRUNCATE TABLE "AdminAuditLog" RESTART IDENTITY CASCADE');
    await assert.rejects(resetTestFixture(prisma, "DELETE FROM x CASCADE"), /TRUNCATE CASCADE/);
    await assert.rejects(resetTestFixture(prisma, "TRUNCATE TABLE x; SELECT 1 CASCADE"), /TRUNCATE CASCADE/);
    await assert.rejects(resetTestFixture(prisma, 'TRUNCATE TABLE "AdminAuditLog" WHERE true RESTART IDENTITY CASCADE'), /TRUNCATE CASCADE/);
  } finally { restore(); }
});

test("fixture reset rejects a Prisma connection to another backend", async () => {
  const called = [];
  const prisma = { $transaction: async (callback) => callback({
    $queryRawUnsafe: async () => [{ database: "tomverse_prod" }],
    $executeRawUnsafe: async (sql) => called.push(sql),
  }) };
  try {
    process.env.TEST_DATABASE_URL = "postgresql://postgres@127.0.0.1:55477/tomverse_test";
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    await assert.rejects(resetTestFixture(prisma, 'TRUNCATE TABLE "AdminAuditLog" RESTART IDENTITY CASCADE'), /exact test database backend/);
    assert.deepEqual(called, []);
  } finally { restore(); }
});
