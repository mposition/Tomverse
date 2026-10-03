import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { DAILY_RUN_CAP } from "@/lib/supportTriageCore";

// SupportTriageRun invariants (docs/policy/support-triage.md §4, §8).
//
// What needs a database: every rule here lives in a trigger or a CHECK of
// migration 20261003120000_support_triage_run. The deadline and creation time
// come from the database's clock, the daily cap is serialised by an advisory
// lock, a late success is downgraded on update, and young rows refuse delete.
//
// Some fixtures move a row's times into the past. The triggers forbid exactly
// that, so those fixtures disable the relevant trigger for one statement and
// re-enable it at once; the assertion that follows always runs with every
// trigger enabled.

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
};

const withTriggerDisabled = async (trigger: string, sql: string) => {
  await prisma.$executeRawUnsafe(`ALTER TABLE "SupportTriageRun" DISABLE TRIGGER "${trigger}"`);
  try {
    await prisma.$executeRawUnsafe(sql);
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "SupportTriageRun" ENABLE TRIGGER "${trigger}"`);
  }
};

const startRun = (id: string, kind: "worker" | "retention") =>
  prisma.supportTriageRun.create({
    // The caller's deadline is deliberately absurd: the trigger must replace it.
    data: { id, kind, deadlineAt: new Date("2099-01-01T00:00:00Z") },
  });

beforeEach(reset);

after(async () => {
  await reset();
  await prisma.$disconnect();
});

test("the database sets the deadline from the kind and ignores the caller's", async () => {
  const worker = await startRun("w1", "worker");
  const retention = await startRun("r1", "retention");
  assert.equal(worker.deadlineAt.getTime() - worker.createdAt.getTime(), 5 * 60_000);
  assert.equal(retention.deadlineAt.getTime() - retention.createdAt.getTime(), 100_000);
});

test("a run cannot be inserted already finished", async () => {
  await assert.rejects(
    prisma.supportTriageRun.create({
      data: {
        id: "x",
        kind: "worker",
        deadlineAt: new Date(),
        outcome: "success",
        finishedAt: new Date(),
      },
    }),
    /must be inserted as running/
  );
});

test("an in-time success keeps its outcome and gets the database's finish time", async () => {
  await startRun("w1", "worker");
  const finished = await prisma.supportTriageRun.update({
    where: { id: "w1" },
    data: { outcome: "success", finishedAt: new Date("2000-01-01T00:00:00Z") },
  });
  assert.equal(finished.outcome, "success");
  assert.ok(finished.finishedAt && finished.finishedAt.getTime() > Date.UTC(2001, 0, 1));
});

test("a late success or partial is recorded as deadline_exceeded", async () => {
  for (const outcome of ["success", "partial"] as const) {
    await reset();
    await startRun("r1", "retention");
    await withTriggerDisabled(
      "SupportTriageRun_before_update",
      `UPDATE "SupportTriageRun" SET "deadlineAt" = "createdAt" - interval '1 second' WHERE id = 'r1'`
    );
    const finished = await prisma.supportTriageRun.update({
      where: { id: "r1" },
      data: { outcome, batchesCompleted: 3 },
    });
    assert.equal(finished.outcome, "deadline_exceeded", outcome);
  }
});

test("a finished row is final and identity and deadline never change", async () => {
  await startRun("w1", "worker");
  await prisma.supportTriageRun.update({ where: { id: "w1" }, data: { outcome: "failed" } });
  await assert.rejects(
    prisma.supportTriageRun.update({ where: { id: "w1" }, data: { outcome: "success" } }),
    /already finished/
  );
  await startRun("r1", "retention");
  for (const data of [
    { kind: "worker" },
    { id: "r1-renamed" },
    { sequence: BigInt(999_999) },
    { deadlineAt: new Date("2099-01-01T00:00:00Z") },
    { createdAt: new Date("2000-01-01T00:00:00Z") },
  ]) {
    await assert.rejects(
      prisma.supportTriageRun.update({ where: { id: "r1" }, data }),
      /immutable/,
      Object.keys(data).join(",")
    );
  }
});

test("a retention run may report exactly eight batches, never nine", async () => {
  await startRun("r8", "retention");
  const eight = await prisma.supportTriageRun.update({
    where: { id: "r8" },
    data: { outcome: "success", batchesCompleted: 8 },
  });
  assert.equal(eight.batchesCompleted, 8);
  await startRun("r1", "retention");
  await assert.rejects(
    prisma.supportTriageRun.update({
      where: { id: "r1" },
      data: { outcome: "success", batchesCompleted: 9 },
    }),
    /SupportTriageRun_retention_batches_check/
  );
});

test("rows younger than 30 days refuse delete; the boundary row is deletable", async () => {
  await startRun("old", "worker");
  await startRun("young", "worker");
  await withTriggerDisabled(
    "SupportTriageRun_before_update",
    `UPDATE "SupportTriageRun" SET "createdAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '30 days' - interval '1 second' WHERE id = 'old'`
  );
  await withTriggerDisabled(
    "SupportTriageRun_before_update",
    `UPDATE "SupportTriageRun" SET "createdAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '30 days' + interval '5 seconds' WHERE id = 'young'`
  );
  await prisma.supportTriageRun.delete({ where: { id: "old" } });
  await assert.rejects(
    prisma.supportTriageRun.delete({ where: { id: "young" } }),
    /inside its 30-day retention window/
  );
});

test("the 53rd run of a kind in one UTC day is refused; the other kind is not", async () => {
  for (let i = 0; i < DAILY_RUN_CAP.retention; i += 1) {
    await startRun(`r${i}`, "retention");
  }
  await assert.rejects(startRun("r-over", "retention"), /daily_cap_exceeded/);
  await startRun("w1", "worker");
});

test("the worker kind has its own cap of 52", async () => {
  for (let i = 0; i < DAILY_RUN_CAP.worker; i += 1) {
    await startRun(`w${i}`, "worker");
  }
  await assert.rejects(startRun("w-over", "worker"), /daily_cap_exceeded/);
});

test("yesterday's runs do not count toward today's cap, whatever the session time zone", async () => {
  for (let i = 0; i < DAILY_RUN_CAP.retention; i += 1) {
    await startRun(`r${i}`, "retention");
  }
  await withTriggerDisabled(
    "SupportTriageRun_before_update",
    `UPDATE "SupportTriageRun" SET "createdAt" = date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') - interval '100 milliseconds'`
  );
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL TimeZone = 'Australia/Brisbane'`);
    await tx.supportTriageRun.create({
      data: { id: "today", kind: "retention", deadlineAt: new Date() },
    });
  });
});

test("two concurrent inserts at 51 cannot both pass", async () => {
  for (let i = 0; i < DAILY_RUN_CAP.retention - 1; i += 1) {
    await startRun(`r${i}`, "retention");
  }
  // The pool gives the open transaction and the second insert two connections.
  {
    let releaseFirst: () => void = () => {};
    const firstHolding = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstInserted: () => void = () => {};
    const inserted = new Promise<void>((resolve) => {
      firstInserted = resolve;
    });
    const first = prisma.$transaction(
      async (tx) => {
        await tx.supportTriageRun.create({
          data: { id: "a", kind: "retention", deadlineAt: new Date() },
        });
        firstInserted();
        await firstHolding;
      },
      { timeout: 20_000 }
    );
    await inserted;
    // The second insert waits on the advisory lock until the first commits,
    // then counts 52 and is refused.
    const secondInsert = startRun("b", "retention");
    setTimeout(() => releaseFirst(), 500);
    const results = await Promise.allSettled([first, secondInsert]);
    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[1].status, "rejected");
    assert.match(String((results[1] as PromiseRejectedResult).reason), /daily_cap_exceeded/);
    assert.equal(
      await prisma.supportTriageRun.count({ where: { kind: "retention" } }),
      DAILY_RUN_CAP.retention
    );
  }
});

test("the trigger functions are VOLATILE and have no EXCEPTION handler", async () => {
  const rows = await prisma.$queryRawUnsafe<
    { proname: string; provolatile: string; handler: boolean }[]
  >(
    `SELECT proname, provolatile::text AS provolatile, prosrc ILIKE '%EXCEPTION WHEN%' AS handler
       FROM pg_proc WHERE proname LIKE 'support_triage_run_%' ORDER BY proname`
  );
  assert.deepEqual(
    rows.map((row) => [row.proname, row.provolatile, row.handler]),
    [
      ["support_triage_run_before_delete", "v", false],
      ["support_triage_run_before_insert", "v", false],
      ["support_triage_run_before_update", "v", false],
    ]
  );
});
