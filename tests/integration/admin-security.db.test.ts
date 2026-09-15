import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import type { Session } from "next-auth";
import {
  AdminApprovalRequiredError,
  runWithAdminApproval,
} from "@/lib/adminApproval";
import { approvalPayloadHash } from "@/lib/adminApprovalCore";
import {
  AdminSoleApproverRefusedError,
  runAsSoleApprover,
  soleApproverIsAvailable,
} from "@/lib/adminSoleApproverExecution";
import { DRY_RUN_BINDING_MAX_AGE_MS } from "@/lib/adminSoleApproverCore";
import { AdminReauthenticationRequiredError } from "@/lib/adminReauthentication";
import { prisma } from "@/lib/prisma";
import { getScheduledJobsDashboard } from "@/lib/scheduledJobs";
import { SCHEDULED_JOB_DEFINITIONS } from "@/lib/scheduledJobsCore";

const resetAdminSecurityData = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AdminActionApproval",
      "AdminAuditLog",
      "AdminRetentionRun",
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

// SCHED-DRIFT-001 again, from the other side. These fixtures used to hard-code
// "20 minutes ago", which was overdue against the 12-minute budget the
// catalogue carried at the time and is comfortably healthy against the
// 35-minute budget it carries now. A literal here pins the test to whatever
// cadence happened to be true the day it was written, which is the same drift
// the catalogue itself was fixed for -- so both fixtures are derived from the
// budget the dashboard actually applies.
const reconciliationSilenceMs =
  SCHEDULED_JOB_DEFINITIONS.find(
    (definition) => definition.key === "credit_reservation_reconciliation"
  )?.maximumSilenceMs ?? 0;

test("scheduled job dashboard flags missing and overdue invocations", async () => {
  const now = new Date("2026-07-18T12:00:00.000Z");
  const overdueBy = reconciliationSilenceMs + 5 * 60 * 1_000;
  await prisma.scheduledJobRun.create({
    data: {
      jobKey: "credit_reservation_reconciliation",
      status: "succeeded",
      startedAt: new Date(now.getTime() - overdueBy - 60 * 1_000),
      completedAt: new Date(now.getTime() - overdueBy),
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

test("a run still inside its silence budget is not reported delayed", async () => {
  // The defect #206 fixed: a healthy reconciliation was shown delayed for the
  // last minutes of every cycle. Asserted here against the real dashboard, not
  // only against the timing helper.
  const now = new Date("2026-07-18T12:00:00.000Z");
  const quietFor = reconciliationSilenceMs - 60 * 1_000;
  await prisma.scheduledJobRun.create({
    data: {
      jobKey: "credit_reservation_reconciliation",
      status: "succeeded",
      startedAt: new Date(now.getTime() - quietFor - 60 * 1_000),
      completedAt: new Date(now.getTime() - quietFor),
      processedCount: 1,
    },
  });
  const dashboard = await getScheduledJobsDashboard(now);
  const reconciliation = dashboard.find(
    (job) => job.key === "credit_reservation_reconciliation"
  );
  assert.equal(reconciliation?.delayed, false);
  assert.equal(reconciliation?.status, "succeeded");
});

/* --------------------------------- the single-administrator exception ----- */

/**
 * `retention.cleanup.execute` for an organisation with one administrator.
 *
 * The pure decisions are covered exhaustively without a database
 * (tests/adminSoleApprover.test.mjs). What only a database can show is the
 * wiring: that the eligible set really is read from configuration, that the
 * binding really is checked against the stored dry run, and that the audit
 * rows the sixth condition requires are actually written before and after the
 * operation.
 *
 * This is where the path is proven at all. Staging cannot do it -- its
 * `ADMIN_OWNER_EMAILS` names two addresses, so the exception correctly stays
 * shut there (observed 2026-08-23); production names one.
 */

const withSoleAdmin = async <T>(
  emails: string[],
  run: () => Promise<T>
): Promise<T> => {
  const previous = {
    admins: process.env.ADMIN_EMAILS,
    owners: process.env.ADMIN_OWNER_EMAILS,
    expiry: process.env.ADMIN_ACCESS_EXPIRY_JSON,
    userIds: process.env.ADMIN_USER_IDS,
  };
  process.env.ADMIN_EMAILS = emails.join(",");
  // Id-admitted administrators are counted as approvers, so an inherited
  // ADMIN_USER_IDS would silently close every sole-path test here.
  delete process.env.ADMIN_USER_IDS;
  process.env.ADMIN_OWNER_EMAILS = emails.join(",");
  delete process.env.ADMIN_ACCESS_EXPIRY_JSON;
  try {
    return await run();
  } finally {
    // Restored rather than left set: the surrounding suite reads the same
    // variables, and a test that widens who is an administrator must not do it
    // for the tests after it.
    if (previous.admins === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = previous.admins;
    if (previous.owners === undefined) delete process.env.ADMIN_OWNER_EMAILS;
    else process.env.ADMIN_OWNER_EMAILS = previous.owners;
    if (previous.expiry !== undefined)
      process.env.ADMIN_ACCESS_EXPIRY_JSON = previous.expiry;
    if (previous.userIds === undefined) delete process.env.ADMIN_USER_IDS;
    else process.env.ADMIN_USER_IDS = previous.userIds;
  }
};

const DRY_RUN_RESULT = {
  sessions: 0,
  assistantKnowledge: {
    pendingTombstones: 2,
    retryable: 2,
    exhausted: 0,
    oldestPendingAt: "2026-08-23T04:58:00.000Z",
    executionLimit: 200,
    truncated: false,
    orphanScan: {
      status: "not_run",
      reason: "A dry run does not list the object store.",
    },
  },
};

const seedDryRun = async (
  actor: AdminTestActor,
  overrides: { createdAt?: Date; mode?: string; result?: unknown } = {}
) => {
  const run = await prisma.adminRetentionRun.create({
    data: {
      mode: overrides.mode ?? "dry-run",
      status: "completed",
      result: (overrides.result ?? DRY_RUN_RESULT) as never,
      createdById: actor.session.user?.id,
      createdByEmail: actor.session.user?.email,
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    },
  });
  return { run, digest: approvalPayloadHash(run.result) };
};

const executeAsSoleApprover = (
  actor: AdminTestActor,
  submittedRunId: string,
  submittedDigest: string,
  operation: () => Promise<unknown>
) =>
  runAsSoleApprover(
    {
      session: actor.session,
      request: actor.request,
      action: "retention.cleanup.execute",
      targetType: "Retention",
      targetId: "expired-data",
      confirmation: {
        kind: "retention_dry_run" as const,
        submittedRunId,
        submittedDigest,
      },
    },
    operation
  );

test("the sole administrator executes, and the audit says why one was enough", async () => {
  const admin = await createAdminSession("sole-admin");
  await withSoleAdmin([admin.session.user?.email as string], async () => {
    assert.equal(
      soleApproverIsAvailable("retention.cleanup.execute", admin.session),
      true
    );
    const { run, digest } = await seedDryRun(admin);
    let executions = 0;
    const result = await executeAsSoleApprover(admin, run.id, digest, async () => {
      executions += 1;
      return { assistantKnowledgeObjectsDeleted: 2 };
    });
    assert.equal(executions, 1);
    assert.deepEqual(result, { assistantKnowledgeObjectsDeleted: 2 });

    const audit = await prisma.adminAuditLog.findMany({
      where: { action: { startsWith: "admin_sole_approver." } },
      orderBy: { createdAt: "asc" },
    });
    assert.deepEqual(
      audit.map((entry) => entry.action),
      ["admin_sole_approver.execution_started", "admin_sole_approver.executed"]
    );
    const started = audit[0].metadata as Record<string, unknown>;
    // Named in the record rather than left to be worked out from
    // configuration that may have changed by the time anyone reads it.
    assert.equal(started.eligibleApproverCount, 1);
    assert.equal(started.dryRunId, run.id);
    assert.equal(started.dryRunDigest, digest);
    const executed = audit[1].metadata as Record<string, unknown>;
    assert.deepEqual(executed.result, { assistantKnowledgeObjectsDeleted: 2 });

    // The exception is not an approval: nothing is written to the approval
    // table, so it cannot be mistaken for one that somebody granted.
    assert.equal(await prisma.adminActionApproval.count(), 0);
  });
});

test("a second eligible administrator closes the path without being asked", async () => {
  const admin = await createAdminSession("first-admin");
  const other = await createAdminSession("second-admin");
  await withSoleAdmin(
    [admin.session.user?.email as string, other.session.user?.email as string],
    async () => {
      // Condition 6, read from configuration on this call -- there is no
      // stored mode to migrate and no flag anyone has to remember to clear.
      assert.equal(
        soleApproverIsAvailable("retention.cleanup.execute", admin.session),
        false
      );
      const { run, digest } = await seedDryRun(admin);
      let executions = 0;
      await assert.rejects(
        () =>
          executeAsSoleApprover(admin, run.id, digest, async () => {
            executions += 1;
          }),
        AdminSoleApproverRefusedError
      );
      assert.equal(executions, 0);
    }
  );
});

test("every way the binding can fail refuses before anything is deleted", async () => {
  const admin = await createAdminSession("binding-admin");
  const other = await createAdminSession("binding-other");
  await withSoleAdmin([admin.session.user?.email as string], async () => {
    const attempt = async (
      runId: string,
      digest: string,
      expected: string
    ) => {
      let executions = 0;
      await assert.rejects(
        () =>
          executeAsSoleApprover(admin, runId, digest, async () => {
            executions += 1;
          }),
        (error: unknown) => {
          assert.ok(error instanceof AdminSoleApproverRefusedError);
          assert.equal(error.reason, expected);
          return true;
        }
      );
      assert.equal(executions, 0, `${expected} must not execute`);
    };

    await attempt("", "", "preview_missing");

    const fresh = await seedDryRun(admin);
    await attempt(fresh.run.id, "b".repeat(64), "preview_digest_mismatch");

    // A newer run of any mode supersedes it. Reported as superseded rather
    // than as a bad digest: the submitted id does exist.
    const newer = await seedDryRun(admin, { mode: "execute" });
    await attempt(fresh.run.id, fresh.digest, "preview_superseded");
    await attempt(newer.run.id, newer.digest, "preview_not_a_dry_run");

    await prisma.adminRetentionRun.deleteMany({});
    const theirs = await seedDryRun(other);
    await attempt(
      theirs.run.id,
      theirs.digest,
      "preview_belongs_to_another_administrator"
    );

    await prisma.adminRetentionRun.deleteMany({});
    const old = await seedDryRun(admin, {
      createdAt: new Date(Date.now() - DRY_RUN_BINDING_MAX_AGE_MS - 60_000),
    });
    await attempt(old.run.id, old.digest, "preview_expired");

    // A refusal is not an event worth an audit row of its own: nothing
    // happened, and the request is already rate limited.
    assert.equal(
      await prisma.adminAuditLog.count({
        where: { action: { startsWith: "admin_sole_approver." } },
      }),
      0
    );
  });
});

test("a stale session is refused before the binding is even read", async () => {
  const admin = await createAdminSession("stale-admin", staleAuthenticatedAt());
  await withSoleAdmin([admin.session.user?.email as string], async () => {
    const { run, digest } = await seedDryRun(admin);
    let executions = 0;
    await assert.rejects(
      () =>
        executeAsSoleApprover(admin, run.id, digest, async () => {
          executions += 1;
        }),
      AdminReauthenticationRequiredError
    );
    assert.equal(executions, 0);
  });
});

/* ------------------------- every other two-person action, since 2026-09-15 ----- */

/**
 * docs/policy/admin-sole-approver.md. `runWithAdminApproval` itself now lets
 * the sole eligible administrator execute, so the routes that call it --
 * plan adjustment, refunds above the threshold, account deletion, OAuth
 * unlink, billing hold release, model disable, suppression removal, policy
 * activation -- need no change of their own. What only a database can show is
 * that the audit record really stands where the reviewer would, that no
 * approval row pretends someone granted anything, and that a second
 * administrator puts the queue back.
 */

const planAdjustInput = (actor: AdminTestActor) => ({
  session: actor.session,
  request: actor.request,
  action: "user.plan_adjust",
  targetType: "User",
  targetId: "target-user",
  payload: { plan: "Pro", reason: "verified support request" },
  reason: "verified support request",
});

test("the sole administrator adjusts a plan alone, and the audit stands in for the reviewer", async () => {
  const admin = await createAdminSession("sole-billing");
  await withSoleAdmin([admin.session.user?.email as string], async () => {
    const input = planAdjustInput(admin);
    let executions = 0;
    const result = await runWithAdminApproval(input, async () => {
      executions += 1;
      return "adjusted";
    });
    assert.equal(result, "adjusted");
    assert.equal(executions, 1);
    assert.equal(await prisma.adminActionApproval.count(), 0);

    const audit = await prisma.adminAuditLog.findMany({
      where: { action: { startsWith: "admin_sole_approver." } },
      orderBy: { createdAt: "asc" },
    });
    assert.deepEqual(
      audit.map((entry) => entry.action),
      ["admin_sole_approver.execution_started", "admin_sole_approver.executed"]
    );
    const started = audit[0].metadata as Record<string, unknown>;
    assert.equal(started.action, "user.plan_adjust");
    assert.equal(started.rule, "general_sole_administrator");
    assert.equal(started.eligibleApproverCount, 1);
    assert.equal(started.reason, "verified support request");
    assert.equal(started.payloadHash, approvalPayloadHash(input.payload));
    assert.equal(audit[0].targetId, "target-user");
  });
});

test("a failed sole execution is recorded as failed and leaves nothing claimable", async () => {
  const admin = await createAdminSession("sole-failure");
  await withSoleAdmin([admin.session.user?.email as string], async () => {
    await assert.rejects(
      () =>
        runWithAdminApproval(planAdjustInput(admin), async () => {
          throw new Error("stripe unavailable");
        }),
      /stripe unavailable/
    );
    assert.equal(await prisma.adminActionApproval.count(), 0);
    assert.deepEqual(
      (
        await prisma.adminAuditLog.findMany({
          where: { action: { startsWith: "admin_sole_approver." } },
          orderBy: { createdAt: "asc" },
        })
      ).map((entry) => entry.action),
      [
        "admin_sole_approver.execution_started",
        "admin_sole_approver.execution_failed",
      ]
    );
  });
});

test("a second eligible administrator restores the queue for every action", async () => {
  const admin = await createAdminSession("first-billing");
  const other = await createAdminSession("second-billing");
  await withSoleAdmin(
    [admin.session.user?.email as string, other.session.user?.email as string],
    async () => {
      let executions = 0;
      await assert.rejects(
        () =>
          runWithAdminApproval(planAdjustInput(admin), async () => {
            executions += 1;
          }),
        (error: unknown) => {
          assert.ok(error instanceof AdminApprovalRequiredError);
          // Said, not silent: the operator can tell two administrators from a
          // misconfiguration.
          assert.equal(
            error.soleApproverUnavailable,
            "multiple_eligible_approvers"
          );
          return true;
        }
      );
      assert.equal(executions, 0);
      assert.equal(
        await prisma.adminActionApproval.count({ where: { status: "pending" } }),
        1
      );
    }
  );
});

test("the general path never stands in for a bound one", async () => {
  // Retention cleanup and campaign approval keep their digest bindings. A
  // sole administrator reaching them through runWithAdminApproval -- without
  // the dry run or the copy they read -- gets the ordinary queue, not a
  // shortcut around the proof.
  const admin = await createAdminSession("bound-admin");
  await withSoleAdmin([admin.session.user?.email as string], async () => {
    let executions = 0;
    await assert.rejects(
      () =>
        runWithAdminApproval(
          {
            session: admin.session,
            request: admin.request,
            action: "retention.cleanup.execute",
            targetType: "Retention",
            targetId: "expired-data",
            payload: { mode: "execute", confirmText: "RUN CLEANUP" },
            reason: "Execute destructive retention cleanup.",
          },
          async () => {
            executions += 1;
          }
        ),
      AdminApprovalRequiredError
    );
    assert.equal(executions, 0);
  });
});

test("an administrator admitted by user id is counted, so the sole path fails closed", async () => {
  // Codex review, 2026-09-15. An ADMIN_USER_IDS administrator takes their role
  // from a session email the configuration cannot see, so their row reads as
  // readonly. Leaving them out would count one approver where there are two.
  const admin = await createAdminSession("email-owner");
  const other = await createAdminSession("id-owner");
  await withSoleAdmin([admin.session.user?.email as string], async () => {
      // Set inside: withSoleAdmin clears and restores ADMIN_USER_IDS itself.
      process.env.ADMIN_USER_IDS = other.session.user?.id as string;
      let executions = 0;
      await assert.rejects(
        () =>
          runWithAdminApproval(planAdjustInput(admin), async () => {
            executions += 1;
          }),
        AdminApprovalRequiredError
      );
      assert.equal(executions, 0);

      // The requester's own id is the requester, not a second person.
      process.env.ADMIN_USER_IDS = admin.session.user?.id as string;
      await runWithAdminApproval(planAdjustInput(admin), async () => {
        executions += 1;
      });
      assert.equal(executions, 1);
  });
});

test("a request already approved by a second administrator is closed, not left claimable", async () => {
  const admin = await createAdminSession("returning-owner");
  const reviewer = await createAdminSession("departed-reviewer");
  const input = planAdjustInput(admin);
  await withSoleAdmin(
    [admin.session.user?.email as string, reviewer.session.user?.email as string],
    async () => {
      await assert.rejects(
        () => runWithAdminApproval(input, async () => undefined),
        AdminApprovalRequiredError
      );
    }
  );
  const pending = await prisma.adminActionApproval.findFirstOrThrow({
    where: { status: "pending" },
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

  // The reviewer has left the configuration; the requester is now alone.
  await withSoleAdmin([admin.session.user?.email as string], async () => {
    let executions = 0;
    await runWithAdminApproval(input, async () => {
      executions += 1;
    });
    assert.equal(executions, 1);
    assert.equal(
      (await prisma.adminActionApproval.findUniqueOrThrow({ where: { id: pending.id } })).status,
      "expired"
    );
  });

  // With the reviewer back, the same request queues again rather than running
  // on the approval that was already carried out.
  await withSoleAdmin(
    [admin.session.user?.email as string, reviewer.session.user?.email as string],
    async () => {
      let executions = 0;
      await assert.rejects(
        () => runWithAdminApproval(input, async () => { executions += 1; }),
        AdminApprovalRequiredError
      );
      assert.equal(executions, 0);
    }
  );
});

test("the bound retention path closes an approved cleanup request too", async () => {
  const admin = await createAdminSession("bound-returning-owner");
  const approval = await prisma.adminActionApproval.create({
    data: {
      action: "retention.cleanup.execute",
      targetType: "Retention",
      targetId: "expired-data",
      status: "approved",
      payload: { mode: "execute", confirmText: "RUN CLEANUP" },
      payloadHash: approvalPayloadHash({ mode: "execute", confirmText: "RUN CLEANUP" }),
      requestedById: admin.session.user?.id,
      expiresAt: new Date(Date.now() + 30 * 60_000),
    },
  });
  await withSoleAdmin([admin.session.user?.email as string], async () => {
    const { run, digest } = await seedDryRun(admin);
    await executeAsSoleApprover(admin, run.id, digest, async () => ({ ok: true }));
  });
  assert.equal(
    (await prisma.adminActionApproval.findUniqueOrThrow({ where: { id: approval.id } })).status,
    "expired"
  );
  const started = await prisma.adminAuditLog.findFirstOrThrow({
    where: { action: "admin_sole_approver.execution_started" },
  });
  assert.deepEqual(
    (started.metadata as Record<string, unknown>).supersededApprovalIds,
    [approval.id]
  );
});

test("a pending request is expired by the sole execution that carries it out", async () => {
  const admin = await createAdminSession("queued-owner");
  const other = await createAdminSession("queued-other");
  const input = planAdjustInput(admin);
  await withSoleAdmin(
    [admin.session.user?.email as string, other.session.user?.email as string],
    async () => {
      await assert.rejects(
        () => runWithAdminApproval(input, async () => undefined),
        AdminApprovalRequiredError
      );
    }
  );
  const pending = await prisma.adminActionApproval.findFirstOrThrow({
    where: { status: "pending" },
  });
  await withSoleAdmin([admin.session.user?.email as string], async () => {
    await runWithAdminApproval(input, async () => undefined);
  });
  assert.equal(
    (await prisma.adminActionApproval.findUniqueOrThrow({ where: { id: pending.id } })).status,
    "expired"
  );
  const started = await prisma.adminAuditLog.findFirstOrThrow({
    where: { action: "admin_sole_approver.execution_started" },
  });
  assert.deepEqual(
    (started.metadata as Record<string, unknown>).supersededApprovalIds,
    [pending.id]
  );
});

test("an approval already being carried out refuses a sole execution of the same change", async () => {
  // Confirmation review (Codex, 2026-09-15): an ordinary claim that has moved
  // a row to `executing` is the same change in flight, and a sole execution
  // beside it would run it twice.
  const admin = await createAdminSession("in-flight-owner");
  const input = planAdjustInput(admin);
  await prisma.adminActionApproval.create({
    data: {
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      status: "executing",
      payload: input.payload,
      payloadHash: approvalPayloadHash(input.payload),
      requestedById: admin.session.user?.id,
      expiresAt: new Date(Date.now() + 30 * 60_000),
    },
  });
  await withSoleAdmin([admin.session.user?.email as string], async () => {
    let executions = 0;
    await assert.rejects(
      () => runWithAdminApproval(input, async () => { executions += 1; }),
      (error: unknown) => {
        assert.ok(error instanceof AdminSoleApproverRefusedError);
        assert.equal(error.reason, "approval_executing");
        return true;
      }
    );
    assert.equal(executions, 0);
    // Refused before the intent record, and nothing was closed.
    assert.equal(
      await prisma.adminAuditLog.count({
        where: { action: { startsWith: "admin_sole_approver." } },
      }),
      0
    );
  });
});
