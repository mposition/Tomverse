import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import type { Session } from "next-auth";
import {
  AdminApprovalRequiredError,
  runWithAdminApproval,
} from "@/lib/adminApproval";
import { prisma } from "@/lib/prisma";
import { getScheduledJobsDashboard } from "@/lib/scheduledJobs";

const resetAdminSecurityData = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AdminActionApproval",
      "AdminAuditLog",
      "ScheduledJobRun",
      "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(resetAdminSecurityData);
after(async () => {
  await resetAdminSecurityData();
  await prisma.$disconnect();
});

const createAdminSession = async (label: string): Promise<Session> => {
  const user = await prisma.user.create({
    data: {
      email: `${label}-${randomUUID()}@example.test`,
      lastLoginAt: new Date(),
    },
  });
  return {
    user: { id: user.id, email: user.email, name: label },
    expires: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
  };
};

test("an exact approval payload is consumed once", async () => {
  const requester = await createAdminSession("requester");
  const reviewer = await createAdminSession("reviewer");
  let executions = 0;
  const input = {
    session: requester,
    action: "user.plan_adjust",
    targetType: "User",
    targetId: "target-user",
    payload: { plan: "Pro", reason: "verified support request" },
    reason: "verified support request",
  };

  await assert.rejects(
    () => runWithAdminApproval(input, async () => { executions += 1; }),
    AdminApprovalRequiredError
  );
  const pending = await prisma.adminActionApproval.findFirstOrThrow({
    where: { action: input.action, status: "pending" },
  });
  await prisma.adminActionApproval.update({
    where: { id: pending.id },
    data: {
      status: "approved",
      reviewedAt: new Date(),
      reviewedById: reviewer.user?.id,
      reviewedByEmail: reviewer.user?.email,
    },
  });

  await runWithAdminApproval(input, async () => { executions += 1; });
  assert.equal(executions, 1);
  assert.equal(
    (await prisma.adminActionApproval.findUniqueOrThrow({ where: { id: pending.id } })).status,
    "consumed"
  );

  await assert.rejects(
    () => runWithAdminApproval(input, async () => { executions += 1; }),
    AdminApprovalRequiredError
  );
  assert.equal(executions, 1);
  assert.equal(
    await prisma.adminActionApproval.count({
      where: { action: input.action, status: "pending" },
    }),
    1
  );
  assert.ok(
    await prisma.adminAuditLog.findFirst({
      where: { action: "admin_approval.consumed", targetId: pending.id },
    })
  );
});

test("a changed payload cannot reuse a previously approved action", async () => {
  const requester = await createAdminSession("requester");
  const base = {
    session: requester,
    action: "model.disable",
    targetType: "Model",
    targetId: "model-a",
    reason: "provider deprecated model",
  };
  await assert.rejects(
    () => runWithAdminApproval({ ...base, payload: { status: "disabled" } }, async () => undefined),
    AdminApprovalRequiredError
  );
  await assert.rejects(
    () => runWithAdminApproval({ ...base, payload: { status: "disabled", public: false } }, async () => undefined),
    AdminApprovalRequiredError
  );
  assert.equal(
    await prisma.adminActionApproval.count({ where: { action: "model.disable" } }),
    2
  );
});

test("scheduled job dashboard flags missing and overdue invocations", async () => {
  const now = new Date("2026-07-18T12:00:00.000Z");
  await prisma.scheduledJobRun.create({
    data: {
      jobKey: "credit_reservation_reconciliation",
      status: "succeeded",
      startedAt: new Date(now.getTime() - 20 * 60 * 1_000),
      completedAt: new Date(now.getTime() - 19 * 60 * 1_000),
      processedCount: 3,
    },
  });
  const dashboard = await getScheduledJobsDashboard(now);
  const reconciliation = dashboard.find(
    (job) => job.key === "credit_reservation_reconciliation"
  );
  const cleanup = dashboard.find((job) => job.key === "retention_cleanup");
  assert.equal(reconciliation?.status, "delayed");
  assert.equal(reconciliation?.lastProcessedCount, 3);
  assert.equal(cleanup?.status, "delayed");
  assert.equal(cleanup?.lastRunAt, null);
});
