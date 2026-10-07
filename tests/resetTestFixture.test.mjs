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

const makeClient = (database, calls) => ({
  $transaction: async (callback) => callback({
    $queryRawUnsafe: async () => [{ database }],
    $executeRawUnsafe: async (sql) => calls.push(sql),
  }),
});

test("fixture reset refuses non-test, query-override, and mismatched targets", async () => {
  const calls = [];
  const prisma = makeClient("tomverse_test", calls);
  try {
    process.env.TEST_DATABASE_URL = "postgresql://postgres@db.example/tomverse_test";
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    await assert.rejects(resetTestFixture(prisma, 'TRUNCATE TABLE "AdminAuditLog" RESTART IDENTITY CASCADE'), /loopback test databases/);
    process.env.TEST_DATABASE_URL = "postgresql://postgres@127.0.0.1/tomverse_test?host=db.example";
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    await assert.rejects(resetTestFixture(prisma, 'TRUNCATE TABLE "AdminAuditLog" RESTART IDENTITY CASCADE'), /loopback test databases/);
    process.env.TEST_DATABASE_URL = "postgresql://postgres@127.0.0.1/tomverse_test";
    process.env.DATABASE_URL = "postgresql://postgres@127.0.0.1/tomverse_prod";
    await assert.rejects(resetTestFixture(prisma, 'TRUNCATE TABLE "AdminAuditLog" RESTART IDENTITY CASCADE'), /exact test database URL/);
    assert.deepEqual(calls, []);
  } finally { restore(); }
});

test("fixture reset checks the actual backend before trigger bypass", async () => {
  const calls = [];
  try {
    process.env.TEST_DATABASE_URL = "postgresql://postgres@127.0.0.1/tomverse_test";
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    await assert.rejects(resetTestFixture(makeClient("tomverse_prod", calls), 'TRUNCATE TABLE "AdminAuditLog" RESTART IDENTITY CASCADE'), /exact test database backend/);
    assert.deepEqual(calls, []);
    await resetTestFixture(makeClient("tomverse_test", calls), 'TRUNCATE TABLE "AdminAuditLog" RESTART IDENTITY CASCADE');
    assert.deepEqual(calls, ["SET LOCAL session_replication_role = replica", 'TRUNCATE TABLE "AdminAuditLog" RESTART IDENTITY CASCADE']);
    process.env.TEST_DATABASE_URL = ` ${process.env.DATABASE_URL}\r\n`;
    await resetTestFixture(makeClient("tomverse_test", calls), 'TRUNCATE TABLE "AdminAuditLog" RESTART IDENTITY CASCADE');
    assert.equal(calls.length, 4);
    await assert.rejects(resetTestFixture(makeClient("tomverse_test", calls), 'TRUNCATE TABLE "AdminAuditLog" WHERE true RESTART IDENTITY CASCADE'), /TRUNCATE CASCADE/);
  } finally { restore(); }
});
