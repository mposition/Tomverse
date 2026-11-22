import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { resetTestFixture } from "./resetTestFixture";
import { DAILY_RUN_CAP } from "@/lib/supportTriageCore";
import {
  SupportTriageRunNotRunning,
  finishSupportTriageRun,
  startSupportTriageRun,
} from "@/lib/supportTriageRunStore";

// The SupportTriageRun writer (docs/policy/support-triage.md §4, §7).
//
// What needs a database: that a run row and its system audit entry commit or
// roll back together is a transaction property, and the times and the late
// downgrade come from triggers.

const reset = async () => {
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "SupportTriageRun" DISABLE TRIGGER "SupportTriageRun_before_delete"`
  );
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM "SupportTriageRun"`);
  } finally {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "SupportTriageRun" ENABLE TRIGGER "SupportTriageRun_before_delete"`
    );
  }
  await resetTestFixture(prisma, `TRUNCATE TABLE "AdminAuditLog" RESTART IDENTITY CASCADE`);
};

const runAudits = () =>
  prisma.adminAuditLog.findMany({
    where: { targetType: "SupportTriageRun" },
    orderBy: { createdAt: "asc" },
    select: { action: true, targetId: true, actorUserId: true, metadata: true },
  });

beforeEach(reset);

after(async () => {
  await reset();
  await prisma.$disconnect();
});

test("starting a run writes the row and one system audit entry", async () => {
  const run = await startSupportTriageRun("retention");
  assert.equal(run.deadlineAt.getTime() - run.createdAt.getTime(), 100_000);
  const audits = await runAudits();
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "support_triage.run_started");
  assert.equal(audits[0].targetId, run.id);
  assert.equal(audits[0].actorUserId, null);
  assert.equal((audits[0].metadata as Record<string, unknown>).systemActor, "support-triage-retention");
});

test("finishing in time records the outcome and a second audit entry", async () => {
  const run = await startSupportTriageRun("worker");
  const finished = await finishSupportTriageRun({
    id: run.id,
    kind: "worker",
    outcome: "success",
  });
  assert.equal(finished.outcome, "success");
  const audits = await runAudits();
  assert.deepEqual(audits.map((a) => a.action), ["support_triage.run_started", "support_triage.run_finished"]);
  assert.equal((audits[1].metadata as Record<string, unknown>).systemActor, "support-triage-worker");
});

test("finishing a run that is not running throws and its audit entry rolls back", async () => {
  const run = await startSupportTriageRun("retention");
  await finishSupportTriageRun({ id: run.id, kind: "retention", outcome: "failed" });
  await assert.rejects(
    finishSupportTriageRun({ id: run.id, kind: "retention", outcome: "success" }),
    SupportTriageRunNotRunning
  );
  await assert.rejects(
    finishSupportTriageRun({ id: run.id, kind: "worker", outcome: "success" }),
    SupportTriageRunNotRunning
  );
  assert.equal((await runAudits()).length, 2);
  const row = await prisma.supportTriageRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(row.outcome, "failed");
});

test("a late finish is recorded as deadline_exceeded", async () => {
  const run = await startSupportTriageRun("retention");
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "SupportTriageRun" DISABLE TRIGGER "SupportTriageRun_before_update"`
  );
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE "SupportTriageRun" SET "deadlineAt" = "createdAt" - interval '1 second' WHERE id = '${run.id}'`
    );
  } finally {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "SupportTriageRun" ENABLE TRIGGER "SupportTriageRun_before_update"`
    );
  }
  const finished = await finishSupportTriageRun({
    id: run.id,
    kind: "retention",
    outcome: "success",
    counters: { batchesCompleted: 8, overdueRemaining: 0, oldestOverdueAgeSeconds: 0, blocked: 0 },
  });
  assert.equal(finished.outcome, "deadline_exceeded");
});

test("a run refused by the daily cap leaves no audit entry", async () => {
  for (let i = 0; i < DAILY_RUN_CAP.worker; i += 1) await startSupportTriageRun("worker");
  const before = (await runAudits()).length;
  await assert.rejects(startSupportTriageRun("worker"), /daily_cap_exceeded/);
  assert.equal((await runAudits()).length, before);
});

test("malformed counters are refused before anything is written", async () => {
  const run = await startSupportTriageRun("retention");
  for (const counters of [{ batchesCompleted: 9 }, { overdueRemaining: -1 }, { blocked: 1.5 }]) {
    await assert.rejects(
      finishSupportTriageRun({ id: run.id, kind: "retention", outcome: "success", counters }),
      RangeError
    );
  }
  assert.equal((await runAudits()).length, 1);
  const row = await prisma.supportTriageRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(row.outcome, "running");
});

// 2026-11-21 (dev): a run-row transaction lost its session to 25P03 and the
// whole retention run failed. A failure PostgreSQL rolled back as a whole is
// asked once more; anything else is thrown as before.
const failOnce = async (timing: "INSERT" | "UPDATE", sqlstate: string) => {
  await prisma.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS test_run_write_once`);
  await prisma.$executeRawUnsafe(`CREATE SEQUENCE test_run_write_once`);
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION test_run_write_fail_once() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF nextval('test_run_write_once') = 1 THEN
        RAISE EXCEPTION 'injected' USING ERRCODE = '${sqlstate}';
      END IF;
      RETURN NEW;
    END $$`);
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_run_write_fail_once ON "SupportTriageRun"`);
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER test_run_write_fail_once BEFORE ${timing} ON "SupportTriageRun"
       FOR EACH ROW EXECUTE FUNCTION test_run_write_fail_once()`
  );
};
const clearFailOnce = async () => {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_run_write_fail_once ON "SupportTriageRun"`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_run_write_fail_once()`);
  await prisma.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS test_run_write_once`);
};
const warnings = (t: { mock: { method: (o: object, m: string, f: (...a: unknown[]) => void) => unknown } }) => {
  const lines: string[] = [];
  t.mock.method(console, "warn", (line: unknown) => { lines.push(String(line)); });
  return lines;
};

test("a start the database rolled back is asked once more and leaves one row and one audit entry", async (t) => {
  for (const sqlstate of ["25P03", "40001", "40P01"]) {
    await reset();
    const lines = warnings(t);
    await failOnce("INSERT", sqlstate);
    try {
      const run = await startSupportTriageRun("retention");
      assert.equal((await prisma.supportTriageRun.count()), 1, sqlstate);
      const audits = await runAudits();
      assert.deepEqual(audits.map((a) => [a.action, a.targetId]), [["support_triage.run_started", run.id]], sqlstate);
      // Prisma reports a deadlock or serialization failure as P2034.
      const retried = lines.map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .find((line) => line?.event === "support_triage_run_write_retried");
      assert.ok([sqlstate, "P2034"].includes(retried?.code), `${sqlstate}: ${retried?.code}`);
    } finally {
      await clearFailOnce();
      t.mock.restoreAll();
    }
  }
});

test("a finish the database rolled back is asked once more and records the outcome once", async (t) => {
  const run = await startSupportTriageRun("retention");
  const lines = warnings(t);
  await failOnce("UPDATE", "25P03");
  try {
    const finished = await finishSupportTriageRun({ id: run.id, kind: "retention", outcome: "success",
      counters: { batchesCompleted: 1, overdueRemaining: 0, oldestOverdueAgeSeconds: 0, blocked: 0 } });
    assert.equal(finished.outcome, "success");
    assert.deepEqual((await runAudits()).map((a) => a.action), ["support_triage.run_started", "support_triage.run_finished"]);
    assert.ok(lines.some((line) => line.includes("support_triage_run_write_retried")));
  } finally {
    await clearFailOnce();
  }
});

test("a failure that is not a rollback is thrown without a second try", async (t) => {
  const lines = warnings(t);
  await failOnce("INSERT", "23514");
  try {
    await assert.rejects(startSupportTriageRun("retention"));
    assert.equal(await prisma.supportTriageRun.count(), 0);
    assert.equal((await runAudits()).length, 0);
    assert.equal(lines.some((line) => line.includes("support_triage_run_write_retried")), false);
  } finally {
    await clearFailOnce();
  }
});

test("a write that is rolled back twice is thrown after the second try", async () => {
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION test_run_write_fail_always() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected' USING ERRCODE = '40001'; END $$`);
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER test_run_write_fail_always BEFORE INSERT ON "SupportTriageRun"
       FOR EACH ROW EXECUTE FUNCTION test_run_write_fail_always()`
  );
  try {
    await assert.rejects(startSupportTriageRun("retention"));
    assert.equal((await runAudits()).length, 0);
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_run_write_fail_always ON "SupportTriageRun"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_run_write_fail_always()`);
  }
});
