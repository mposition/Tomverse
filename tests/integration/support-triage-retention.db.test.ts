import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { resetTestFixture } from "./resetTestFixture";
import { invalidateClosedReportSuggestions, runSupportTriageRetention } from "@/lib/supportTriageRetention";

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
  await prisma.$executeRawUnsafe(`DELETE FROM "SupportTriageSuggestion"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "SupportTriageGroup"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "SupportTriageDecisionRecord"`);
  await prisma.feedback.deleteMany({ where: { id: { startsWith: "fb-ret-" } } });
  await resetTestFixture(prisma, `TRUNCATE TABLE "AdminAuditLog" RESTART IDENTITY CASCADE`);
};

/**
 * Inserts finished worker rows aged past the 30-day boundary by `extra`.
 * `insertOrder` orders the INSERT over `g`: it decides where rows land in the
 * heap, and so which one a sequential scan meets first, never their createdAt.
 */
const seedExpired = async (count: number, extra = "1 hour", insertOrder = "g") => {
  await disableTrigger("SupportTriageRun_before_insert");
  try {
    await prisma.$executeRawUnsafe(`
      INSERT INTO "SupportTriageRun" ("id", "kind", "outcome", "createdAt", "deadlineAt", "finishedAt")
      SELECT 'old-' || lpad(g::text, 5, '0'), 'worker', 'success',
             t.base - interval '${extra}' + g * interval '1 millisecond',
             t.base, t.base
        FROM generate_series(1, ${count}) g,
             -- One clock read, so finishedAt never trails deadlineAt.
             (SELECT (clock_timestamp() AT TIME ZONE 'UTC') - interval '30 days' AS base) t
       ORDER BY ${insertOrder}`);
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
  // One toxic row 25 hours past its boundary, then 200 deletable rows after it:
  // its 125-row window is skipped and the other 76 rows commit.
  await seedExpired(1, "25 hours");
  await disableTrigger("SupportTriageRun_before_insert");
  try {
    await prisma.$executeRawUnsafe(`
      INSERT INTO "SupportTriageRun" ("id", "kind", "outcome", "createdAt", "deadlineAt", "finishedAt")
      SELECT 'ok-' || lpad(g::text, 5, '0'), 'worker', 'success', t.base - interval '1 hour', t.base, t.base
        FROM generate_series(1, 200) g,
             (SELECT (clock_timestamp() AT TIME ZONE 'UTC') - interval '30 days' AS base) t`);
  } finally {
    await enableTrigger("SupportTriageRun_before_insert");
  }
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
  // The batches after the skipped window commit, so only the age condition
  // can make this run not progressing.
  assert.ok(result.batchesCompleted > 0);
  assert.ok(result.oldestOverdueAgeSeconds > 86_400);
  assert.equal(result.notProgressing, true);
});

test("a successful batch clears a floor cancellation, so a new window needs two of its own", async () => {
  // Sequences are not transactional, so they count tries across the
  // cancelled, rolled-back batches. The window holding old-00001 cancels its
  // first three tries (500, 250, 125) and deletes on the fourth; the next
  // window, which holds old-00126 and not old-00001, cancels only its first
  // try at the floor. With the strike cleared by the committed batch in
  // between, that one cancellation is not enough to skip its window.
  //
  // The trigger runs once per DELETE statement and reads the whole window from
  // its transition table; it still runs inside that statement, so the lane's
  // real statement_timeout is what cancels it. A row trigger depended on which
  // row the delete's sequential scan met first: old-00126 is in the 500- and
  // 250-row windows too, and when the free space earlier tests left put it
  // ahead of old-00001 in the heap, its one cancellation went to the 500-row
  // window, old-00001's third cancellation became a second strike at the
  // floor, and 125 rows were skipped. The seed inserts old-00126 onward first,
  // so that heap order is the one this test sees.
  await seedExpired(260, "1 hour", "g >= 126 DESC, g");
  await prisma.$executeRawUnsafe(`CREATE SEQUENCE test_first_tries`);
  await prisma.$executeRawUnsafe(`CREATE SEQUENCE test_second_tries`);
  try {
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION test_slow_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM gone WHERE "id" = 'old-00001') THEN
          IF nextval('test_first_tries') <= 3 THEN PERFORM pg_sleep(1); END IF;
        ELSIF EXISTS (SELECT 1 FROM gone WHERE "id" = 'old-00126') THEN
          IF nextval('test_second_tries') <= 1 THEN PERFORM pg_sleep(1); END IF;
        END IF;
        RETURN NULL;
      END $$`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "test_slow_delete" AFTER DELETE ON "SupportTriageRun"
        REFERENCING OLD TABLE AS gone
        FOR EACH STATEMENT EXECUTE FUNCTION test_slow_delete()`);
    const result = await runSupportTriageRetention();
    assert.equal(result.blocked, 0);
    assert.equal(result.deleted, 260);
    assert.equal(result.outcome, "success");
    // The planned cancellations happened: four tries of the first window,
    // two of the second.
    const [tries] = await prisma.$queryRawUnsafe<{ first: number; second: number }[]>(
      `SELECT (SELECT last_value FROM test_first_tries)::integer AS first,
              (SELECT last_value FROM test_second_tries)::integer AS second`
    );
    assert.deepEqual(tries, { first: 4, second: 2 });
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "test_slow_delete" ON "SupportTriageRun"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_slow_delete()`);
    await prisma.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS test_first_tries`);
    await prisma.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS test_second_tries`);
  }
});

test("the deadline check rolls a late transaction back whole and has the arm function's shape", async () => {
  await seedExpired(1);
  const { writeSystemAuditLog } = await import("@/lib/adminAudit");
  await assert.rejects(
    prisma.$transaction(async (tx) => {
      await tx.supportTriageRun.deleteMany({ where: { id: "old-00001" } });
      await writeSystemAuditLog({
        tx,
        systemActor: "support-triage-retention",
        action: "support_triage.retention_batch",
        targetType: "SupportTriageRun",
        targetId: "late",
        summary: "late batch",
        metadata: { deleted: 1 },
      });
      await tx.$executeRawUnsafe(
        `SELECT "support_triage_assert_deadline"(((clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second')::timestamp(3))`
      );
    }),
    /support_triage_deadline_passed/
  );
  // The delete and the audit entry went with it.
  assert.ok(await prisma.supportTriageRun.findUnique({ where: { id: "old-00001" } }));
  assert.equal(await prisma.adminAuditLog.count({ where: { targetType: "SupportTriageRun" } }), 0);

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

test("an idle run writes no batch audit entry", async () => {
  const result = await runSupportTriageRetention();
  assert.equal(result.deleted, 0);
  assert.deepEqual(await auditActions(), ["support_triage.run_started", "support_triage.run_finished"]);
});

test("statement cancellation is read from the SQLSTATE wherever the client puts it, not from text", async () => {
  const { isStatementCancelled } = await import("@/lib/supportTriageRetention");
  assert.equal(isStatementCancelled({ code: "57014" }), true);
  assert.equal(isStatementCancelled({ meta: { driverAdapterError: { cause: { originalCode: "57014" } } } }), true);
  assert.equal(isStatementCancelled({ cause: { cause: { code: "57014" } } }), true);
  assert.equal(isStatementCancelled({ message: "canceling statement due to statement timeout" }), false);
  assert.equal(isStatementCancelled({ code: "23514" }), false);
  const loop: Record<string, unknown> = {};
  loop.cause = loop;
  assert.equal(isStatementCancelled(loop), false);
});

// The other classes (docs/policy/support-triage.md §5): terminal suggestions
// and terminal groups 30 days after they became terminal, decision records at
// their own retentionUntil. Each fixture moves a timestamp the guard trigger
// owns, so it disables that trigger for one statement.

const withDisabled = async (table: string, trigger: string, sql: string) => {
  await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
  try {
    await prisma.$executeRawUnsafe(sql);
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`);
  }
};

const seedOtherClasses = async (age: string) => {
  await prisma.feedback.create({ data: { id: "fb-ret-1", type: "bug", message: "retention fixture" } });
  // Two terminal suggestions and one open one, all with the given age.
  await withDisabled(
    "SupportTriageSuggestion",
    "SupportTriageSuggestion_guard",
    `INSERT INTO "SupportTriageSuggestion" ("id", "feedbackId", "inputDigest", "state", "failureCode", "createdAt", "updatedAt")
     VALUES ('s-acc', 'fb-ret-1', '${"a".repeat(64)}', 'superseded', NULL,
             (clock_timestamp() AT TIME ZONE 'UTC') - interval '${age}', (clock_timestamp() AT TIME ZONE 'UTC') - interval '${age}'),
            ('s-fail', 'fb-ret-1', '${"b".repeat(64)}', 'failed', 'internal_error',
             (clock_timestamp() AT TIME ZONE 'UTC') - interval '${age}', (clock_timestamp() AT TIME ZONE 'UTC') - interval '${age}'),
            ('s-open', 'fb-ret-1', '${"c".repeat(64)}', 'pending', NULL,
             (clock_timestamp() AT TIME ZONE 'UTC') - interval '${age}', (clock_timestamp() AT TIME ZONE 'UTC') - interval '${age}')`
  );
  // One terminal group and one open group.
  await withDisabled(
    "SupportTriageGroup",
    "SupportTriageGroup_guard",
    `INSERT INTO "SupportTriageGroup" ("id", "state", "primaryKind", "primarySnapshotDigest", "groupCandidateKey", "keyRetiredAt", "createdAt", "updatedAt")
     VALUES ('g-ended', 'expired', 'same_account', NULL, '${"d".repeat(64)}',
             (clock_timestamp() AT TIME ZONE 'UTC') - interval '${age}',
             (clock_timestamp() AT TIME ZONE 'UTC') - interval '${age}', (clock_timestamp() AT TIME ZONE 'UTC') - interval '${age}'),
            ('g-open', 'candidate', 'same_account', '${"e".repeat(64)}', '${"f".repeat(64)}', NULL,
             (clock_timestamp() AT TIME ZONE 'UTC') - interval '${age}', (clock_timestamp() AT TIME ZONE 'UTC') - interval '${age}')`
  );
  // One decision record whose retentionUntil is as far past (or short of) now
  // as the other classes' 30-day boundary: age minus 30 days.
  // The guard stamps decidedAt; it is disabled outside the transaction, which
  // ends with the deferred has-link check pending and so cannot ALTER the table.
  await prisma.$executeRawUnsafe(`ALTER TABLE "SupportTriageDecisionRecord" DISABLE TRIGGER "SupportTriageDecisionRecord_guard"`);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO "SupportTriageDecisionRecord" ("id", "decisionKind", "decidedAt", "decisionEnvelopeDigest", "digestVersion", "retentionUntil")
         SELECT 'dr-old', 'group_confirmed', t.d, '${"9".repeat(64)}', 1, t.d + interval '12 months'
           FROM (SELECT (clock_timestamp() AT TIME ZONE 'UTC') - interval '12 months' - (interval '${age}' - interval '30 days') AS d) t`
      );
      await tx.supportTriageDecisionRecordLink.create({ data: { id: "dr-old-l0", recordId: "dr-old", feedbackId: "fb-ret-1" } });
    });
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "SupportTriageDecisionRecord" ENABLE TRIGGER "SupportTriageDecisionRecord_guard"`);
  }
};

test("terminal suggestions, terminal groups and expired decision records are deleted in the same batch", async () => {
  await seedOtherClasses("31 days");
  await seedExpired(3);
  const result = await runSupportTriageRetention();
  assert.equal(result.deleted, 3 + 2 + 1 + 1);
  assert.equal(result.batchesCompleted, 1);
  assert.equal(result.overdueRemaining, 0);
  assert.equal(result.outcome, "success");
  assert.deepEqual((await prisma.supportTriageSuggestion.findMany({ select: { id: true } })).map((r) => r.id), ["s-open"]);
  assert.deepEqual((await prisma.supportTriageGroup.findMany({ select: { id: true } })).map((r) => r.id), ["g-open"]);
  assert.equal(await prisma.supportTriageDecisionRecord.count(), 0);
  assert.equal(await prisma.supportTriageDecisionRecordLink.count(), 0);
  const [batch] = await prisma.adminAuditLog.findMany({ where: { action: "support_triage.retention_batch" } });
  assert.deepEqual(batch.metadata, {
    deleted: 7,
    batchSize: 500,
    runs: 3,
    suggestions: 2,
    groups: 1,
    decisionRecords: 1,
    invalidated: 0,
    systemActor: "support-triage-retention",
  });
});

test("rows of the other classes inside their period are left alone and are not overdue", async () => {
  await seedOtherClasses("29 days");
  const result = await runSupportTriageRetention();
  assert.equal(result.deleted, 0);
  assert.equal(result.overdueRemaining, 0);
  assert.equal(await prisma.supportTriageSuggestion.count(), 3);
  assert.equal(await prisma.supportTriageGroup.count(), 2);
  assert.equal(await prisma.supportTriageDecisionRecord.count(), 1);
});

test("an overdue row of another class counts toward overdueRemaining and its age", async () => {
  await seedOtherClasses("33 days");
  // Make every delete of SupportTriageGroup sleep past statement_timeout.
  await prisma.$executeRawUnsafe(`CREATE FUNCTION test_slow_group_delete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_sleep(1); RETURN OLD; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER "test_slow_group_delete" BEFORE DELETE ON "SupportTriageGroup"
    FOR EACH ROW EXECUTE FUNCTION test_slow_group_delete()`);
  try {
    const result = await runSupportTriageRetention();
    // The group never deletes; the cancelled class alone is skipped and blocked.
    assert.equal(result.blocked, 1);
    assert.ok(await prisma.supportTriageGroup.findUnique({ where: { id: "g-ended" } }));
    assert.equal(result.overdueRemaining, 1);
    assert.ok(result.oldestOverdueAgeSeconds >= 2 * 86_400, String(result.oldestOverdueAgeSeconds));
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "test_slow_group_delete" ON "SupportTriageGroup"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_slow_group_delete()`);
  }
});

test("an open suggestion of a closed report is invalidated, so it is deleted 30 days after the closure", async () => {
  await prisma.feedback.create({ data: { id: "fb-ret-closed", type: "bug", message: "closed", status: "resolved" } });
  await prisma.feedback.create({ data: { id: "fb-ret-open", type: "bug", message: "open" } });
  await prisma.supportTriageSuggestion.create({ data: { id: "s-closed", feedbackId: "fb-ret-closed", inputDigest: "1".repeat(64) } });
  await prisma.supportTriageSuggestion.create({ data: { id: "s-open-report", feedbackId: "fb-ret-open", inputDigest: "2".repeat(64) } });
  const result = await runSupportTriageRetention();
  assert.equal(result.deleted, 0);
  assert.equal(result.batchesCompleted, 1);
  const closed = await prisma.supportTriageSuggestion.findUniqueOrThrow({ where: { id: "s-closed" } });
  assert.equal(closed.state, "invalidated");
  assert.ok(Math.abs(closed.updatedAt.getTime() - Date.now()) < 60_000);
  assert.equal((await prisma.supportTriageSuggestion.findUniqueOrThrow({ where: { id: "s-open-report" } })).state, "pending");
  const [batch] = await prisma.adminAuditLog.findMany({ where: { action: "support_triage.retention_batch" } });
  assert.equal((batch.metadata as Record<string, unknown>).invalidated, 1);
});

test("toxic rows in three classes cannot keep the fourth from committing", async () => {
  await seedOtherClasses("31 days");
  await seedExpired(1);
  // One row in each of runs, suggestions and groups sleeps past statement_timeout on delete.
  for (const [table, id] of [
    ["SupportTriageRun", "old-00001"],
    ["SupportTriageSuggestion", "s-acc"],
    ["SupportTriageGroup", "g-ended"],
  ]) {
    await prisma.$executeRawUnsafe(`CREATE FUNCTION "test_toxic_${table}"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD."id" = '${id}' THEN PERFORM pg_sleep(1); END IF; RETURN OLD; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER "test_toxic" BEFORE DELETE ON "${table}"
      FOR EACH ROW EXECUTE FUNCTION "test_toxic_${table}"()`);
  }
  try {
    const result = await runSupportTriageRetention();
    // The decision record committed although every other class cancelled first.
    assert.equal(await prisma.supportTriageDecisionRecord.count(), 0);
    assert.ok(result.batchesCompleted >= 1);
    assert.ok(await prisma.supportTriageRun.findUnique({ where: { id: "old-00001" } }));
    assert.ok(await prisma.supportTriageGroup.findUnique({ where: { id: "g-ended" } }));
  } finally {
    for (const table of ["SupportTriageRun", "SupportTriageSuggestion", "SupportTriageGroup"]) {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "test_toxic" ON "${table}"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "test_toxic_${table}"()`);
    }
  }
});

test("a suggestion of a report closed 40 days ago is deleted now, not 30 days after its invalidation", async () => {
  await prisma.feedback.create({ data: { id: "fb-ret-long-closed", type: "bug", message: "closed", status: "closed" } });
  await prisma.supportTriageSuggestion.create({ data: { id: "s-long", feedbackId: "fb-ret-long-closed", inputDigest: "3".repeat(64) } });
  await prisma.$executeRawUnsafe(
    `UPDATE "Feedback" SET "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '40 days' WHERE "id" = 'fb-ret-long-closed'`
  );
  // Before the run the row already counts as overdue.
  const result = await runSupportTriageRetention();
  assert.equal(await prisma.supportTriageSuggestion.count({ where: { id: "s-long" } }), 0);
  assert.equal(result.overdueRemaining, 0);
  const [batch] = await prisma.adminAuditLog.findMany({ where: { action: "support_triage.retention_batch" } });
  assert.equal((batch.metadata as Record<string, unknown>).invalidated, 1);
  assert.equal((batch.metadata as Record<string, unknown>).suggestions, 1);
});

test("an open suggestion of a report closed 40 days ago is overdue until a run deletes it", async () => {
  await prisma.feedback.create({ data: { id: "fb-ret-stuck", type: "bug", message: "closed", status: "resolved" } });
  await prisma.supportTriageSuggestion.create({ data: { id: "s-stuck", feedbackId: "fb-ret-stuck", inputDigest: "4".repeat(64) } });
  await prisma.$executeRawUnsafe(
    `UPDATE "Feedback" SET "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '40 days' WHERE "id" = 'fb-ret-stuck'`
  );
  // Every invalidation sleeps past statement_timeout, so the run cannot touch it.
  await prisma.$executeRawUnsafe(`CREATE FUNCTION test_slow_invalidate() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_sleep(1); RETURN NEW; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER "test_slow_invalidate" BEFORE UPDATE ON "SupportTriageSuggestion"
    FOR EACH ROW EXECUTE FUNCTION test_slow_invalidate()`);
  try {
    const result = await runSupportTriageRetention();
    assert.equal(result.overdueRemaining, 1);
    assert.ok(result.oldestOverdueAgeSeconds >= 9 * 86_400, String(result.oldestOverdueAgeSeconds));
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "test_slow_invalidate" ON "SupportTriageSuggestion"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_slow_invalidate()`);
  }
});

test("two overlapping invalidations of the same row: the second skips it instead of failing", async () => {
  await prisma.feedback.create({ data: { id: "fb-ret-race", type: "bug", message: "closed", status: "closed" } });
  await prisma.supportTriageSuggestion.create({ data: { id: "s-race", feedbackId: "fb-ret-race", inputDigest: "5".repeat(64) } });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let held!: () => void;
  const holding = new Promise<void>((resolve) => (held = resolve));
  const first = prisma.$transaction(async (tx) => {
    const count = await invalidateClosedReportSuggestions(tx, 500);
    held();
    await gate;
    return count;
  }, { timeout: 15_000 });
  await holding;
  let secondPid = 0;
  const second = prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_catalog.pg_backend_pid() AS pid`;
    secondPid = row.pid;
    return invalidateClosedReportSuggestions(tx, 500);
  }, { timeout: 15_000 });
  for (let i = 0; ; i += 1) {
    if (secondPid !== 0) {
      const [row] = await prisma.$queryRaw<{ n: number }[]>`
        SELECT pg_catalog.cardinality(pg_catalog.pg_blocking_pids(${secondPid}::int))::int AS n`;
      if (row.n > 0) break;
    }
    assert.ok(i < 100, "the second invalidation never waited on the first");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  release();
  assert.equal(await first, 1);
  assert.equal(await second, 0);
  assert.equal((await prisma.supportTriageSuggestion.findUniqueOrThrow({ where: { id: "s-race" } })).state, "invalidated");
});
