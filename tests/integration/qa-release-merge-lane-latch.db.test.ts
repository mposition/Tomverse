import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { Prisma } from "@prisma/client";

import { writeAdminAuditLog, writeSystemAuditLog } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";
import { recordQaReleaseOperatorControl } from "@/lib/qaReleaseOperatorControlStore";

// QaReleaseMergeLaneLatch against PostgreSQL through the migration history
// (20261004020000_qa_release_merge_lane_latch): consecutive events, set by
// the merge lane and released by a person in the same transaction, a release
// only while latched, a named attempt that exists, and no change or removal.

const requireDedicatedTestDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  const runtimeRaw = process.env.DATABASE_URL?.trim();
  if (!testRaw) throw new Error("TEST_DATABASE_URL is required");
  if (runtimeRaw !== testRaw) {
    throw new Error("REFUSE: DATABASE_URL must equal TEST_DATABASE_URL for this DB test");
  }
};
requireDedicatedTestDatabase();

const session = { user: { id: "qa-latch-operator", email: "operator@example.test" }, expires: "2099-01-01T00:00:00.000Z" };
const ATTEMPT = `latch-attempt-${process.pid}`;

const cleanup = async () => {
  for (const table of ["QaReleaseMergeLaneLatch", "QaReleaseMergeAttempt", "QaReleaseOperatorControl"]) {
    await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${table}_before_delete"`);
    try {
      await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${table}_before_delete"`);
    }
  }
};

before(async () => {
  await cleanup();
  const { revision } = await recordQaReleaseOperatorControl({
    session: session as never,
    control: {
      digestEnabled: false,
      mergeLaneEnabled: true,
      developLaneOn: true,
      iacCommit: null,
      digestSecretRotatedAt: null,
      monitorSecretRotatedAt: null,
      mergeLaneSecretRotatedAt: null,
      githubAppKeyRotatedAt: null,
      railwayTokenRotatedAt: null,
      githubReadTokenRotatedAt: null,
    },
  });
  await prisma.$transaction(async (tx) => {
    const auditId = await writeSystemAuditLog({
      tx,
      systemActor: "qa-release-merge-lane",
      action: "qa_release.merge_attempt_issued",
      targetType: "QaReleaseMergeAttempt",
      targetId: ATTEMPT,
      summary: "test",
    });
    await tx.$executeRaw`INSERT INTO "QaReleaseMergeAttempt"
      ("id", "pullRequestNumber", "headSha", "base", "controlRevision", "state", "lastAuditLogId")
      VALUES (${ATTEMPT}, 7, ${"a".repeat(40)}, 'develop', ${revision}, 'issued', ${auditId})`;
  });
});

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

type Actor = "lane" | "person" | "none";

const append = (sequence: number, latched: boolean, reason: string | null, actor: Actor, attemptId: string | null = null) =>
  prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    let auditId = `no-such-audit-${sequence}-${Math.random()}`;
    const target = { targetType: "QaReleaseMergeLaneLatch", targetId: String(sequence), summary: "test" };
    if (actor === "lane") {
      auditId = await writeSystemAuditLog({ tx, systemActor: "qa-release-merge-lane", action: "qa_release.merge_lane_latched", ...target });
    } else if (actor === "person") {
      auditId = await writeAdminAuditLog({ tx, session: session as never, action: "qa_release.merge_lane_released", ...target });
    }
    await tx.$executeRaw`INSERT INTO "QaReleaseMergeLaneLatch" ("sequence", "latched", "reason", "attemptId", "auditLogId")
      VALUES (${sequence}, ${latched}, ${reason}, ${attemptId}, ${auditId})`;
  });

const newest = async () =>
  (await prisma.$queryRaw<{ sequence: number; latched: boolean }[]>`SELECT "sequence", "latched" FROM "QaReleaseMergeLaneLatch" ORDER BY "sequence" DESC LIMIT 1`)[0] ??
  null;

test("a release with nothing latched is refused; the lane latches, latches again, and a person releases it", async () => {
  await assert.rejects(append(1, false, null, "person"), /releases only a latched lane/);
  await append(1, true, "deploy_failed", "lane", ATTEMPT);
  await append(2, true, "deploy_unreadable", "lane", ATTEMPT);
  await append(3, false, null, "person");
  assert.deepEqual(await newest(), { sequence: 3, latched: false });
  await assert.rejects(append(4, false, null, "person"), /releases only a latched lane/);
});

test("events are consecutive", async () => {
  const next = ((await newest())?.sequence ?? 0) + 1;
  await assert.rejects(append(next + 1, true, "revision_mismatch", "lane"), /consecutive/);
  await assert.rejects(append(next - 1, true, "revision_mismatch", "lane"), /consecutive|duplicate key|unique/i);
});

test("the lane sets and a person releases; neither may do the other's, and an unaudited event is refused", async () => {
  const next = ((await newest())?.sequence ?? 0) + 1;
  await assert.rejects(append(next, true, "deploy_failed", "person"), /set by the merge lane, released by a person/);
  await assert.rejects(append(next, true, "deploy_failed", "none"), /set by the merge lane, released by a person/);
  await append(next, true, "deploy_failed", "lane");
  await assert.rejects(append(next + 1, false, null, "lane"), /set by the merge lane, released by a person/);
  await append(next + 1, false, null, "person");
});

test("a set carries a listed reason, a release none, and a named attempt must exist", async () => {
  const next = ((await newest())?.sequence ?? 0) + 1;
  await assert.rejects(append(next, true, null, "lane"), /reason_when_set_check/);
  await assert.rejects(append(next, true, "bored", "lane"), /reason_check/);
  await assert.rejects(append(next, true, "deploy_failed", "lane", "no-such-attempt"), /attemptId_fkey/);
  await append(next, true, "deploy_failed", "lane");
  await assert.rejects(append(next + 1, false, "deploy_failed", "person"), /reason_when_set_check/);
  await append(next + 1, false, null, "person");
});

test("events are never changed or removed, and their time is the database's", async () => {
  const at = (await prisma.$queryRaw<{ createdAt: Date }[]>`SELECT "createdAt" FROM "QaReleaseMergeLaneLatch" ORDER BY "sequence" DESC LIMIT 1`)[0].createdAt;
  assert.ok(Math.abs(at.getTime() - Date.now()) < 60_000);
  await assert.rejects(prisma.$executeRaw`UPDATE "QaReleaseMergeLaneLatch" SET "latched" = true`, /append-only/);
  await assert.rejects(prisma.$executeRaw`DELETE FROM "QaReleaseMergeLaneLatch"`, /append-only/);
  await assert.rejects(prisma.$executeRawUnsafe(`TRUNCATE "QaReleaseMergeLaneLatch"`), /append-only/);
});
