import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { runSupportTriageRetention } from "@/lib/supportTriageRetention";

// One retention run (docs/policy/support-triage.md §5).
//
// What needs a database: rows past their boundary are found and deleted by the
// database's clock, each batch commits with its audit entry or not at all, and
// a statement_timeout cancellation is real server behaviour. A slow row is
// simulated with a test-only trigger that sleeps when one marked row is
// deleted; it is dropped at the end of each test.

const disableTrigger = (name: string) =>
  prisma.$executeRawUnsafe(`ALTER TABLE "SupportTriageRun" DISABLE TRIGGER "${name}"`);
const enableTrigger = (name: string) =>
  prisma.$executeRawUnsafe(`ALTER TABLE "SupportTriageRun" ENABLE TRIGGER "${name}"`);

const reset = async () => {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "test_slow_delete" ON "SupportTriageRun"`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_slow_delete()`);
  await disableTrigger("SupportTriageRun_before_delete");
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM "SupportTriageRun"`);
  } finally {
    await enableTrigger("SupportTriageRun_before_delete");
  }
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE "AdminAuditLog" RESTART IDENTITY CASCADE`);
};

/** Inserts finished worker rows aged past the 30-day boundary by `extra`. */
const seedExpired = async (count: number, extra = "1 hour") => {
  await disableTrigger("SupportTriageRun_before_insert");
  try {
    await prisma.$executeRawUnsafe(`
      INSERT INTO "SupportTriageRun" ("id", "kind", "outcome", "createdAt", "deadlineAt", "finishedAt")
      SELECT 'old-' || lpad(g::text, 5, '0'), 'worker', 'success',
             t.base - interval '${extra}' + g * interval '1 millisecond',
             t.base, t.base
        FROM generate_series(1, ${count}) g,
             -- One clock read, so finishedAt never trails deadlineAt.
             (SELECT (clock_timestamp() AT TIME ZONE 'UTC') - interval '30 days' AS base) t`);
  } finally {
    await enableTrigger("SupportTriageRun_before_insert");
  }
};

const auditActions = async () =>
  (
    await prisma.adminAuditLog.findMany({
      where: { targetType: "SupportTriageRun" },
      orderBy: { createdAt: "asc" },
      select: { action: true },
    })
  ).map((row) => row.action);

beforeEach(reset);

after(async () => {
  await reset();
  await prisma.$disconnect();
});

test("rows past the boundary are deleted in audited batches and the run succeeds", async () => {
  await seedExpired(600);
  const result = await runSupportTriageRetention();
  assert.equal(result.deleted, 600);
  assert.equal(result.batchesCompleted, 2);
  assert.equal(result.overdueRemaining, 0);
  assert.equal(result.blocked, 0);
  assert.equal(result.outcome, "success");
  assert.equal(result.notProgressing, false);
  assert.equal(await prisma.supportTriageRun.count(), 1); // the retention run itself
  assert.deepEqual(await auditActions(), [
    "support_triage.run_started",
    "support_triage.retention_batch",
    "support_triage.retention_batch",
    "support_triage.run_finished",
  ]);
  const run = await prisma.supportTriageRun.findUniqueOrThrow({ where: { id: result.runId } });
  assert.equal(run.kind, "retention");
  assert.equal(run.batchesCompleted, 2);
  assert.equal(run.overdueRemaining, 0);
});

test("rows inside their 30 days are left alone", async () => {
  await disableTrigger("SupportTriageRun_before_insert");
  try {
    await prisma.$executeRawUnsafe(`
      INSERT INTO "SupportTriageRun" ("id", "kind", "outcome", "createdAt", "deadlineAt", "finishedAt")
      VALUES ('young', 'worker', 'success',
              (clock_timestamp() AT TIME ZONE 'UTC') - interval '29 days',
              (clock_timestamp() AT TIME ZONE 'UTC') - interval '29 days',
              (clock_timestamp() AT TIME ZONE 'UTC') - interval '29 days')`);
  } finally {
    await enableTrigger("SupportTriageRun_before_insert");
  }
  const result = await runSupportTriageRetention();
  assert.equal(result.deleted, 0);
  assert.equal(result.notProgressing, false);
  assert.ok(await prisma.supportTriageRun.findUnique({ where: { id: "young" } }));
});

test("a row that keeps cancelling is skipped with its window, counted as blocked, and reported", async () => {
  await seedExpired(200);
  // Deleting the first row sleeps past the retention lane's 400 ms statement_timeout.
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION test_slow_delete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD."id" = 'old-00001' THEN PERFORM pg_sleep(1); END IF;
      RETURN OLD;
    END $$`);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER "test_slow_delete" BEFORE DELETE ON "SupportTriageRun"
      FOR EACH ROW EXECUTE FUNCTION test_slow_delete()`);
  const result = await runSupportTriageRetention();
  // 500, 250, 125 and 125 again cancel; the 125-row window is skipped and the
  // other 75 rows go in the next batch.
  assert.equal(result.blocked, 125);
  assert.equal(result.deleted, 75);
  assert.equal(result.overdueRemaining, 125);
  assert.equal(result.outcome, "partial");
  assert.ok(result.oldestOverdueAgeSeconds >= 3_600);
  assert.equal(result.notProgressing, false);
  assert.ok(await prisma.supportTriageRun.findUnique({ where: { id: "old-00001" } }));
});

test("a run that completes no batch while rows are overdue is not progressing", async () => {
  await seedExpired(10);
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION test_slow_delete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_sleep(1); RETURN OLD; END $$`);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER "test_slow_delete" BEFORE DELETE ON "SupportTriageRun"
      FOR EACH ROW EXECUTE FUNCTION test_slow_delete()`);
  const result = await runSupportTriageRetention();
  assert.equal(result.batchesCompleted, 0);
  assert.equal(result.blocked, 10);
  assert.equal(result.overdueRemaining, 10);
  assert.equal(result.notProgressing, true);
});

test("a row past its grace makes the run not progressing even when batches complete", async () => {
  await seedExpired(1, "25 hours");
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION test_slow_delete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_sleep(1); RETURN OLD; END $$`);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER "test_slow_delete" BEFORE DELETE ON "SupportTriageRun"
      FOR EACH ROW EXECUTE FUNCTION test_slow_delete()`);
  const result = await runSupportTriageRetention();
  assert.ok(result.oldestOverdueAgeSeconds > 86_400);
  assert.equal(result.notProgressing, true);
});

test("the deadline check rolls a late transaction back whole and has the arm function's shape", async () => {
  await assert.rejects(
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`TRUNCATE TABLE "AdminAuditLog" RESTART IDENTITY CASCADE`);
      await tx.$executeRawUnsafe(
        `SELECT "support_triage_assert_deadline"(((clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second')::timestamp(3))`
      );
    }),
    /support_triage_deadline_passed/
  );
  await assert.rejects(
    prisma.$executeRawUnsafe(`SELECT "support_triage_assert_deadline"(NULL)`),
    /support_triage_deadline_passed/
  );
  await prisma.$executeRawUnsafe(
    `SELECT "support_triage_assert_deadline"(((clock_timestamp() AT TIME ZONE 'UTC') + interval '1 minute')::timestamp(3))`
  );
  const rows = await prisma.$queryRawUnsafe<
    { config: string[] | null; definer: boolean; volatile: string; handler: boolean }[]
  >(
    `SELECT proconfig AS config, prosecdef AS definer, provolatile::text AS volatile,
            prosrc ILIKE '%EXCEPTION WHEN%' AS handler
       FROM pg_proc WHERE proname = 'support_triage_assert_deadline'`
  );
  assert.deepEqual(rows, [{ config: null, definer: false, volatile: "v", handler: false }]);
});
