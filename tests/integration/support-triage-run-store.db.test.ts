import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { resetTestFixture } from "./resetTestFixture";
import { DAILY_RUN_CAP } from "@/lib/supportTriageCore";
import {
  SupportTriageRunNotRunning,
  retryRunWriteOnce,
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
// whole retention run failed. A rolled-back write is asked once more; a lost
// session is asked once more only if the write did not take effect.
const failOnce = async (timing: "INSERT" | "UPDATE", action: string) => {
  await prisma.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS test_run_write_once`);
  await prisma.$executeRawUnsafe(`CREATE SEQUENCE test_run_write_once`);
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION test_run_write_fail_once() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF nextval('test_run_write_once') = 1 THEN
        ${action};
      END IF;
      RETURN NEW;
    END $$`);
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_run_write_fail_once ON "SupportTriageRun"`);
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER test_run_write_fail_once BEFORE ${timing} ON "SupportTriageRun"
       FOR EACH ROW EXECUTE FUNCTION test_run_write_fail_once()`
  );
};
const raise = (sqlstate: string) => `RAISE EXCEPTION 'injected' USING ERRCODE = '${sqlstate}'`;
// What a real idle timeout looks like to the client: the server ends the
// session, and the next statement finds the connection closed, with no SQLSTATE.
const endSession = "PERFORM pg_terminate_backend(pg_backend_pid())";
const clearFailOnce = async () => {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_run_write_fail_once ON "SupportTriageRun"`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_run_write_fail_once()`);
  await prisma.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS test_run_write_once`);
};
type Mockable = { mock: { method: (o: object, m: string, f: (...a: unknown[]) => void) => unknown; restoreAll: () => void } };
const retriedCodes = (t: Mockable) => {
  const codes: string[] = [];
  t.mock.method(console, "warn", (line: unknown) => {
    try {
      const parsed = JSON.parse(String(line));
      if (parsed?.event === "support_triage_run_write_retried") codes.push(parsed.code);
    } catch { /* another warning */ }
  });
  return codes;
};

test("a start the database rolled back is asked once more and leaves one row and one audit entry", async (t) => {
  for (const sqlstate of ["25P03", "40001", "40P01"]) {
    await reset();
    const codes = retriedCodes(t);
    await failOnce("INSERT", raise(sqlstate));
    try {
      const run = await startSupportTriageRun("retention");
      assert.equal(await prisma.supportTriageRun.count(), 1, sqlstate);
      assert.deepEqual((await runAudits()).map((a) => [a.action, a.targetId]), [["support_triage.run_started", run.id]], sqlstate);
      // Prisma reports a deadlock or serialization failure as P2034.
      assert.equal(codes.length, 1, sqlstate);
      assert.ok([sqlstate, "P2034"].includes(codes[0]), `${sqlstate}: ${codes[0]}`);
    } finally {
      await clearFailOnce();
      t.mock.restoreAll();
    }
  }
});

test("a start whose session the server ended is asked once more and leaves one row and one audit entry", async (t) => {
  const codes = retriedCodes(t);
  await failOnce("INSERT", endSession);
  try {
    const run = await startSupportTriageRun("retention");
    assert.equal(await prisma.supportTriageRun.count(), 1);
    assert.deepEqual((await runAudits()).map((a) => [a.action, a.targetId]), [["support_triage.run_started", run.id]]);
    assert.equal(codes.length, 1);
  } finally {
    await clearFailOnce();
  }
});

test("a finish rolled back or cut off is asked once more and records the outcome once", async (t) => {
  for (const action of [raise("25P03"), raise("40001"), endSession]) {
    await reset();
    const run = await startSupportTriageRun("retention");
    const codes = retriedCodes(t);
    await failOnce("UPDATE", action);
    try {
      const finished = await finishSupportTriageRun({ id: run.id, kind: "retention", outcome: "success",
        counters: { batchesCompleted: 1, overdueRemaining: 0, oldestOverdueAgeSeconds: 0, blocked: 0 } });
      assert.equal(finished.outcome, "success", action);
      assert.deepEqual((await runAudits()).map((a) => a.action), ["support_triage.run_started", "support_triage.run_finished"], action);
      assert.equal(codes.length, 1, action);
    } finally {
      await clearFailOnce();
      t.mock.restoreAll();
    }
  }
});

test("a failure that is neither a rollback nor a lost session is thrown without a second try", async (t) => {
  const codes = retriedCodes(t);
  await failOnce("INSERT", raise("23514"));
  try {
    await assert.rejects(startSupportTriageRun("retention"));
    assert.equal(await prisma.supportTriageRun.count(), 0);
    assert.equal((await runAudits()).length, 0);
    assert.deepEqual(codes, []);
  } finally {
    await clearFailOnce();
  }
});

test("a write that fails twice is thrown after the second try", async () => {
  for (const timing of ["INSERT", "UPDATE"] as const) {
    await reset();
    const run = timing === "UPDATE" ? await startSupportTriageRun("retention") : null;
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_run_write_fail_always() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected' USING ERRCODE = '40001'; END $$`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER test_run_write_fail_always BEFORE ${timing} ON "SupportTriageRun"
         FOR EACH ROW EXECUTE FUNCTION test_run_write_fail_always()`
    );
    try {
      await assert.rejects(run
        ? finishSupportTriageRun({ id: run.id, kind: "retention", outcome: "success" })
        : startSupportTriageRun("retention"));
      assert.equal((await runAudits()).length, run ? 1 : 0, timing);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_run_write_fail_always ON "SupportTriageRun"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_run_write_fail_always()`);
    }
  }
});

// The case no trigger can produce: the COMMIT took effect and only its answer
// was lost. The retry reads first and returns what committed instead of
// writing the row and its audit entry a second time.
test("after a lost session, a write that did commit is returned, not repeated", async (t) => {
  const codes = retriedCodes(t);
  const closed = Object.assign(new Error("Server has closed the connection."), { code: "P1017" });
  let writes = 0;
  const committed = { id: "run-1" };
  assert.deepEqual(await retryRunWriteOnce({
    write: async () => { writes += 1; throw closed; },
    committed: async () => committed,
  }), committed);
  assert.equal(writes, 1);
  // Nothing committed: written once more.
  writes = 0;
  assert.deepEqual(await retryRunWriteOnce({
    write: async () => { writes += 1; if (writes === 1) throw closed; return { id: "run-2" }; },
    committed: async () => null,
  }), { id: "run-2" });
  assert.equal(writes, 2);
  // A rollback is known to have written nothing; the read is skipped.
  let reads = 0;
  const rolledBack = Object.assign(new Error("deadlock"), { code: "P2034" });
  writes = 0;
  await retryRunWriteOnce({
    write: async () => { writes += 1; if (writes === 1) throw rolledBack; return { id: "run-3" }; },
    committed: async () => { reads += 1; return null; },
  });
  assert.equal(reads, 0);
  assert.deepEqual(codes, ["P1017", "P1017", "P2034"]);
});
