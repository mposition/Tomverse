import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import type { Session } from "next-auth";
import {
  AdminApprovalRequiredError,
  runWithAdminApproval,
} from "@/lib/adminApproval";
import { AdminReauthenticationRequiredError } from "@/lib/adminReauthentication";
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

type AdminTestActor = {
  session: Session;
  request: Request;
};

// assertRecentAdminAuthentication is the only gate on session freshness, and it
// reads session.user.authenticatedAt -- a JWT claim. The app runs
// session.strategy "jwt" (lib/auth.ts), under which NextAuth never writes the
// Session table, so a fixture that persisted a Session row and a session-token
// cookie modelled an authentication mode the app no longer has. Only the JWT
// shape is reproduced here; the Request stays because writeAdminAuditLog reads
// the client IP and user agent off it.
//
// authenticatedAt is a parameter so the reauthentication window itself can be
// exercised: `null` omits the claim, and an explicit ISO string ages it.
const ADMIN_SESSION_TTL_MS = 60 * 60 * 1_000;

const createAdminSession = async (
  label: string,
  authenticatedAt: string | null = new Date().toISOString()
): Promise<AdminTestActor> => {
  const user = await prisma.user.create({
    data: {
      email: `${label}-${randomUUID()}@example.test`,
      lastLoginAt: new Date(),
    },
  });
  const expires = new Date(Date.now() + ADMIN_SESSION_TTL_MS);
  const session: Session = {
    user: {
      id: user.id,
      email: user.email,
      name: label,
      ...(authenticatedAt === null ? {} : { authenticatedAt }),
    },
    expires: expires.toISOString(),
  };
  return {
    session,
    request: new Request("https://tomverse.test/admin"),
  };
};

// recentAuthMinutes() clamps ADMIN_RECENT_AUTH_MINUTES to at most 240, so a
// timestamp this old is stale under every reachable configuration and the
// expiry test cannot drift with the environment.
const staleAuthenticatedAt = () =>
  new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();

test("an exact approval payload is consumed once", async () => {
  const requester = await createAdminSession("requester");
  const reviewer = await createAdminSession("reviewer");
  let executions = 0;
  const input = {
    session: requester.session,
    request: requester.request,
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
  // A recently re-authenticated admin still gets no execution until a second
  // administrator approves: the first call only records the request.
  assert.equal(executions, 0);
  const pending = await prisma.adminActionApproval.findFirstOrThrow({
    where: { action: input.action, status: "pending" },
  });
  await prisma.adminActionApproval.update({
    where: { id: pending.id },
    data: {
      status: "approved",
      reviewedAt: new Date(),
      reviewedById: reviewer.session.user?.id,
      reviewedByEmail: reviewer.session.user?.email,
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
    session: requester.session,
    request: requester.request,
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

// runWithAdminApproval checks re-authentication before it touches the approval
// store. Both tests below assert that ordering through its observable effect:
// a stale admin leaves no approval row behind, so they cannot get a pending
// request queued for a second administrator to rubber-stamp later.
test("a session without authenticatedAt is refused before an approval is recorded", async () => {
  const requester = await createAdminSession("requester", null);
  let executions = 0;

  await assert.rejects(
    () =>
      runWithAdminApproval(
        {
          session: requester.session,
          request: requester.request,
          action: "user.plan_adjust",
          targetType: "User",
          targetId: "target-user",
          payload: { plan: "Pro", reason: "verified support request" },
          reason: "verified support request",
        },
        async () => { executions += 1; }
      ),
    AdminReauthenticationRequiredError
  );
  assert.equal(executions, 0);
  assert.equal(await prisma.adminActionApproval.count(), 0);
});

test("an elapsed re-authentication window is refused before an approval is recorded", async () => {
  const requester = await createAdminSession(
    "requester",
    staleAuthenticatedAt()
  );
  let executions = 0;

  await assert.rejects(
    () =>
      runWithAdminApproval(
        {
          session: requester.session,
          request: requester.request,
          action: "model.disable",
          targetType: "Model",
          targetId: "model-a",
          payload: { status: "disabled" },
          reason: "provider deprecated model",
        },
        async () => { executions += 1; }
      ),
    AdminReauthenticationRequiredError
  );
  assert.equal(executions, 0);
  assert.equal(await prisma.adminActionApproval.count(), 0);
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
