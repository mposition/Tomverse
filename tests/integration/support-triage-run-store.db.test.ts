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
