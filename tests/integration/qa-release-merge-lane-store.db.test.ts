import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { writeAdminAuditLog, writeSystemAuditLog } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";
import { recordQaReleaseOperatorControl } from "@/lib/qaReleaseOperatorControlStore";
import { QaReleaseMergeLaneLate, issueQaReleaseMergeInstruction } from "@/lib/qaReleaseMergeLaneStore";

// The merge lane's single writer against PostgreSQL: instruction issue.

const requireDedicatedTestDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  const runtimeRaw = process.env.DATABASE_URL?.trim();
  if (!testRaw) throw new Error("TEST_DATABASE_URL is required");
  if (runtimeRaw !== testRaw) {
    throw new Error("REFUSE: DATABASE_URL must equal TEST_DATABASE_URL for this DB test");
  }
};
requireDedicatedTestDatabase();

const session = { user: { id: "qa-lane-store-operator", email: "operator@example.test" }, expires: "2099-01-01T00:00:00.000Z" };
const HEAD = "e".repeat(40);
let revision = 0;

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

const recordControl = async (developLaneOn: boolean) =>
  (revision = (
    await recordQaReleaseOperatorControl({
      session: session as never,
      control: {
        digestEnabled: false,
        mergeLaneEnabled: true,
        developLaneOn,
        iacCommit: null,
        digestSecretRotatedAt: null,
        monitorSecretRotatedAt: null,
        mergeLaneSecretRotatedAt: null,
        githubAppKeyRotatedAt: null,
        railwayTokenRotatedAt: null,
        githubReadTokenRotatedAt: null,
      },
    })
  ).revision);

beforeEach(async () => {
  await cleanup();
  await recordControl(true);
});

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

const budget = (overrides: Partial<{ startedAt: number; budgetMs: number; clock: () => number }> = {}) => ({
  startedAt: Date.now(),
  budgetMs: 110_000,
  clock: Date.now,
  ...overrides,
});

const issue = (overrides: Partial<{ callerRevision: number | null; number: number; headSha: string }> = {}) =>
  issueQaReleaseMergeInstruction({
    callerRevision: overrides.callerRevision === undefined ? revision : overrides.callerRevision,
    pullRequest: { number: overrides.number ?? 21, headSha: overrides.headSha ?? HEAD },
    budget: budget(),
  });

const attempts = () =>
  prisma.qaReleaseMergeAttempt.findMany({ select: { id: true, state: true, controlRevision: true, pullRequestNumber: true } });

test("an instruction opens one attempt under the newest revision, audited by the merge lane", async () => {
  const result = await issue();
  assert.equal(result.issued, true);
  if (!result.issued) return;
  assert.equal(result.controlRevision, revision);
  assert.deepEqual(await attempts(), [{ id: result.attemptId, state: "issued", controlRevision: revision, pullRequestNumber: 21 }]);
  const audit = await prisma.adminAuditLog.findFirst({ where: { targetId: result.attemptId } });
  assert.equal(audit?.action, "qa_release.merge_attempt_issued");
  assert.equal((audit?.metadata as Record<string, unknown>).systemActor, "qa-release-merge-lane");
  assert.ok(result.expiresAt.getTime() > Date.now());
});

test("a second instruction while one is open is refused and writes nothing", async () => {
  assert.equal((await issue()).issued, true);
  assert.deepEqual(await issue({ number: 22 }), { issued: false, reason: "attempt_open" });
  assert.equal((await attempts()).length, 1);
});

test("a stale caller revision, a lane switched off and an invalid pull request are refused", async () => {
  assert.deepEqual(await issue({ callerRevision: revision - 1 }), { issued: false, reason: "revision_mismatch" });
  assert.deepEqual(await issue({ headSha: "xyz" }), { issued: false, reason: "invalid_pull_request" });
  await recordControl(false);
  assert.deepEqual(await issue(), { issued: false, reason: "develop_lane_off" });
  assert.equal((await attempts()).length, 0);
});

test("a latched lane is refused", async () => {
  // Latch the lane the way only the lane may: an audited set event.
  await prisma.$transaction(async (tx) => {
    const auditId = await writeSystemAuditLog({
      tx,
      systemActor: "qa-release-merge-lane",
      action: "qa_release.merge_lane_latched",
      targetType: "QaReleaseMergeLaneLatch",
      targetId: "1",
      summary: "test",
    });
    await tx.$executeRaw`INSERT INTO "QaReleaseMergeLaneLatch" ("sequence", "latched", "reason", "auditLogId")
      VALUES (1, true, 'deploy_failed', ${auditId})`;
  });
  assert.deepEqual(await issue(), { issued: false, reason: "latched" });
  // A person's release opens it again.
  await prisma.$transaction(async (tx) => {
    const auditId = await writeAdminAuditLog({
      tx,
      session: session as never,
      action: "qa_release.merge_lane_released",
      targetType: "QaReleaseMergeLaneLatch",
      targetId: "2",
      summary: "test",
    });
    await tx.$executeRaw`INSERT INTO "QaReleaseMergeLaneLatch" ("sequence", "latched", "reason", "auditLogId")
      VALUES (2, false, NULL, ${auditId})`;
  });
  assert.equal((await issue()).issued, true);
});

test("a round past its deadline records nothing", async () => {
  await assert.rejects(
    issueQaReleaseMergeInstruction({
      callerRevision: revision,
      pullRequest: { number: 21, headSha: HEAD },
      budget: budget({ budgetMs: 1 }),
    }),
    QaReleaseMergeLaneLate,
  );
  assert.equal((await attempts()).length, 0);
  assert.equal(await prisma.adminAuditLog.count({ where: { action: "qa_release.merge_attempt_issued", targetId: { not: null } } }) >= 0, true);
});
