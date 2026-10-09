import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import type { Session } from "next-auth";
import { runWithAdminApproval } from "@/lib/adminApproval";
import { approvalPayloadHash } from "@/lib/adminApprovalCore";
import {
  AdminSoleApproverRefusedError,
  runAsSoleApprover,
  soleApproverIsAvailable,
} from "@/lib/adminSoleApproverExecution";
import { DRY_RUN_BINDING_MAX_AGE_MS } from "@/lib/adminSoleApproverCore";
import { AdminReauthenticationRequiredError } from "@/lib/adminReauthentication";
import { prisma } from "@/lib/prisma";
import { resetTestFixture } from "./resetTestFixture";
import { getScheduledJobsDashboard } from "@/lib/scheduledJobs";
import { SCHEDULED_JOB_DEFINITIONS } from "@/lib/scheduledJobsCore";

const resetAdminSecurityData = () =>
  resetTestFixture(prisma, `
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

test("an eligible administrator executes without recording an approval", async () => {
  const requester = await createAdminSession("requester");
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

  await withSoleAdmin([requester.session.user?.email as string], async () => {
    await runWithAdminApproval(input, async () => { executions += 1; });
    await runWithAdminApproval(input, async () => { executions += 1; });
  });
  assert.equal(executions, 2);
  assert.equal(await prisma.adminActionApproval.count(), 0);
});

test("a changed payload is its own execution and still creates no approval", async () => {
  const requester = await createAdminSession("requester");
  const base = {
    session: requester.session,
    request: requester.request,
    action: "model.disable",
    targetType: "Model",
    targetId: "model-a",
    reason: "provider deprecated model",
  };
  let executions = 0;
  await withSoleAdmin([requester.session.user?.email as string], async () => {
    await runWithAdminApproval(
      { ...base, payload: { status: "disabled" } },
      async () => { executions += 1; }
    );
    await runWithAdminApproval(
      { ...base, payload: { status: "disabled", public: false } },
      async () => { executions += 1; }
    );
  });
  assert.equal(executions, 2);
  assert.equal(await prisma.adminActionApproval.count(), 0);
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

/**
 * A daily job is read from its own history, not from a window every other job
 * shares.
 *
 * The dashboard used to read the newest 150 rows across all jobs and pick each
 * job's runs out of them. Five jobs share the 15-minute cron and the provider
 * probe runs every 10 minutes, so those rows fill 150 within hours; by
 * midday a daily job that ran at 03:00 had fallen out, read as never run, and
 * was shown `delayed`. The run had happened -- the maintenance cron wrote it --
 * the dashboard just no longer looked that far back.
 *
 * The fixture is that morning: the daily rows are written first and the
 * frequent jobs then fill far more than 150 rows on top of them. Every time
 * asserted is the stored row's own, so "the screen matches the cron record" is
 * the check itself rather than a paraphrase of it.
 */
test("a daily job keeps its own latest run, success and failure when frequent jobs fill the recent window", async () => {
  const now = new Date("2026-09-29T12:00:00.000Z");
  const at = (iso: string) => new Date(iso);

  // What the maintenance cron (03:00 UTC) recorded for retention cleanup: a
  // failure yesterday, then a success this morning.
  const cleanupFailure = await prisma.scheduledJobRun.create({
    data: {
      jobKey: "retention_cleanup",
      status: "failed",
      startedAt: at("2026-09-28T03:00:00.000Z"),
      completedAt: at("2026-09-28T03:04:00.000Z"),
      error: "Error: bucket listing timed out",
    },
  });
  const cleanupSuccess = await prisma.scheduledJobRun.create({
    data: {
      jobKey: "retention_cleanup",
      status: "succeeded",
      startedAt: at("2026-09-29T03:00:00.000Z"),
      completedAt: at("2026-09-29T03:02:00.000Z"),
      processedCount: 41,
    },
  });

  // A daily job on a failure streak whose last success is days old: the
  // streak and the success must both come from this job's own rows.
  const usageSuccess = await prisma.scheduledJobRun.create({
    data: {
      jobKey: "provider_usage_sync",
      status: "succeeded",
      startedAt: at("2026-09-27T00:30:00.000Z"),
      completedAt: at("2026-09-27T00:31:00.000Z"),
    },
  });
  await prisma.scheduledJobRun.create({
    data: {
      jobKey: "provider_usage_sync",
      status: "failed",
      startedAt: at("2026-09-28T00:30:00.000Z"),
      completedAt: at("2026-09-28T00:31:00.000Z"),
      error: "Error: older failure",
    },
  });
  const usageLatestFailure = await prisma.scheduledJobRun.create({
    data: {
      jobKey: "provider_usage_sync",
      status: "failed",
      startedAt: at("2026-09-29T00:30:00.000Z"),
      completedAt: at("2026-09-29T00:31:00.000Z"),
      error: "Error: provider usage endpoint returned 503",
    },
  });

  // Then the frequent jobs, every cycle from 00:31 to noon.
  const frequentEvery15 = [
    "credit_reservation_reconciliation",
    "notification_delivery_retry",
    "standard_email_drain",
    "campaign_wave_scheduler",
    "infrastructure_threshold_monitor",
  ];
  const frequentRows: Array<{
    jobKey: string;
    status: string;
    startedAt: Date;
    completedAt: Date;
  }> = [];
  const windowStart = at("2026-09-29T00:31:00.000Z").getTime();
  const pushCycle = (jobKey: string, everyMinutes: number) => {
    for (
      let startedAt = windowStart;
      startedAt < now.getTime();
      startedAt += everyMinutes * 60 * 1_000
    ) {
      frequentRows.push({
        jobKey,
        status: "succeeded",
        startedAt: new Date(startedAt),
        completedAt: new Date(startedAt + 1_000),
      });
    }
  };
  for (const jobKey of frequentEvery15) pushCycle(jobKey, 15);
  pushCycle("provider_probe", 10);
  await prisma.scheduledJobRun.createMany({ data: frequentRows });

  // The fixture only proves something if the daily rows really are outside
  // the old shared window.
  const newerThanDailyRuns = await prisma.scheduledJobRun.count({
    where: { startedAt: { gt: usageLatestFailure.startedAt } },
  });
  assert.ok(
    newerThanDailyRuns > 150,
    `expected more than 150 newer rows, got ${newerThanDailyRuns}`
  );

  const dashboard = await getScheduledJobsDashboard(now);
  const cleanup = dashboard.find((job) => job.key === "retention_cleanup");
  const usage = dashboard.find((job) => job.key === "provider_usage_sync");

  // The screen shows exactly what the maintenance cron recorded.
  assert.equal(cleanup?.lastRunAt, cleanupSuccess.startedAt.toISOString());
  assert.equal(cleanup?.lastSuccessAt, cleanupSuccess.completedAt?.toISOString());
  assert.equal(cleanup?.lastFailureAt, cleanupFailure.completedAt?.toISOString());
  assert.equal(cleanup?.lastError, cleanupFailure.error);
  assert.equal(cleanup?.lastProcessedCount, 41);
  assert.equal(cleanup?.consecutiveFailures, 0);
  assert.equal(cleanup?.delayed, false);
  assert.equal(cleanup?.status, "succeeded");

  assert.equal(usage?.lastRunAt, usageLatestFailure.startedAt.toISOString());
  assert.equal(usage?.lastSuccessAt, usageSuccess.completedAt?.toISOString());
  assert.equal(usage?.lastFailureAt, usageLatestFailure.completedAt?.toISOString());
  assert.equal(usage?.lastError, usageLatestFailure.error);
  assert.equal(usage?.consecutiveFailures, 2);
  assert.equal(usage?.delayed, false);
  assert.equal(usage?.status, "failed");

  // A daily job with no row at all is still reported as never run: the fix
  // reads further back, it does not invent a run.
  const catalogMonitor = dashboard.find(
    (job) => job.key === "provider_model_catalog_monitor"
  );
  assert.equal(catalogMonitor?.lastRunAt, null);
  assert.equal(catalogMonitor?.delayed, true);
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
 * This is where the path is proven at all. A second eligible administrator
 * is counted on the audit row and does not close the path. The dry-run
 * digest binding still has to match.
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
  // ADMIN_USER_IDS would change the count these tests assert.
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

test("a second eligible administrator does not close the retention path", async () => {
  const admin = await createAdminSession("first-admin");
  const other = await createAdminSession("second-admin");
  await withSoleAdmin(
    [admin.session.user?.email as string, other.session.user?.email as string],
    async () => {
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
      assert.equal(await prisma.adminActionApproval.count(), 0);
      const started = await prisma.adminAuditLog.findFirstOrThrow({
        where: { action: "admin_sole_approver.execution_started" },
      });
      assert.equal(
        (started.metadata as Record<string, unknown>).eligibleApproverCount,
        2
      );
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

test("a second eligible administrator does not restore a queue", async () => {
  const admin = await createAdminSession("first-billing");
  const other = await createAdminSession("second-billing");
  await withSoleAdmin(
    [admin.session.user?.email as string, other.session.user?.email as string],
    async () => {
      let executions = 0;
      await runWithAdminApproval(planAdjustInput(admin), async () => {
        executions += 1;
      });
      assert.equal(executions, 1);
      assert.equal(await prisma.adminActionApproval.count(), 0);
      const started = await prisma.adminAuditLog.findFirstOrThrow({
        where: { action: "admin_sole_approver.execution_started" },
      });
      assert.equal(
        (started.metadata as Record<string, unknown>).eligibleApproverCount,
        2
      );
    }
  );
});

test("the general path never stands in for a bound one", async () => {
  // Retention cleanup and campaign approval keep their digest bindings. A
  // sole administrator reaching them through runWithAdminApproval -- without
  // the dry run or the copy they read -- is refused, not given a shortcut
  // around the proof and not queued for a second administrator.
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
      (error: unknown) => {
        assert.ok(error instanceof AdminSoleApproverRefusedError);
        assert.equal(error.reason, "action_has_bound_path");
        return true;
      }
    );
    assert.equal(executions, 0);
    assert.equal(await prisma.adminActionApproval.count(), 0);
  });
});

test("an administrator admitted by user id does not restore a queue", async () => {
  // Codex review, 2026-09-15. An ADMIN_USER_IDS administrator takes their role
  // from a session email the configuration cannot see, so their row reads as
  // readonly. Leaving them out would count one approver where there are two.
  const admin = await createAdminSession("email-owner");
  const other = await createAdminSession("id-owner");
  await withSoleAdmin([admin.session.user?.email as string], async () => {
      // Set inside: withSoleAdmin clears and restores ADMIN_USER_IDS itself.
      process.env.ADMIN_USER_IDS = other.session.user?.id as string;
      let executions = 0;
      await runWithAdminApproval(planAdjustInput(admin), async () => {
        executions += 1;
      });
      assert.equal(executions, 1);

      // The requester's own id is the requester, not a second person.
      process.env.ADMIN_USER_IDS = admin.session.user?.id as string;
      await runWithAdminApproval(planAdjustInput(admin), async () => {
        executions += 1;
      });
      assert.equal(executions, 2);
  });
});

test("an already approved request is expired when the action runs, including with a second administrator", async () => {
  const admin = await createAdminSession("returning-owner");
  const reviewer = await createAdminSession("departed-reviewer");
  const input = planAdjustInput(admin);
  const pending = await prisma.adminActionApproval.create({
    data: {
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      status: "approved",
      payload: input.payload,
      payloadHash: approvalPayloadHash(input.payload),
      requestedById: admin.session.user?.id,
      reviewedById: reviewer.session.user?.id,
      expiresAt: new Date(Date.now() + 30 * 60_000),
    },
  });

  await withSoleAdmin(
    [admin.session.user?.email as string, reviewer.session.user?.email as string],
    async () => {
      let executions = 0;
      await runWithAdminApproval(input, async () => {
        executions += 1;
      });
      assert.equal(executions, 1);
      assert.equal(
        (await prisma.adminActionApproval.findUniqueOrThrow({ where: { id: pending.id } })).status,
        "expired"
      );
      assert.equal(
        await prisma.adminActionApproval.count({ where: { status: "pending" } }),
        0
      );
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

test("a pending request is expired by the execution that carries it out", async () => {
  const admin = await createAdminSession("queued-owner");
  const other = await createAdminSession("queued-other");
  const input = planAdjustInput(admin);
  const pending = await prisma.adminActionApproval.create({
    data: {
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      status: "pending",
      payload: input.payload,
      payloadHash: approvalPayloadHash(input.payload),
      requestedById: admin.session.user?.id,
      expiresAt: new Date(Date.now() + 30 * 60_000),
    },
  });
  await withSoleAdmin(
    [admin.session.user?.email as string, other.session.user?.email as string],
    async () => {
      await runWithAdminApproval(input, async () => undefined);
    }
  );
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

test("an approved row is expired by the execution and does not keep a lease", async () => {
  const admin = await createAdminSession("near-expiry-owner");
  const reviewer = await createAdminSession("near-expiry-reviewer");
  const input = planAdjustInput(admin);
  const approval = await prisma.adminActionApproval.create({
    data: {
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      status: "approved",
      payload: input.payload,
      payloadHash: approvalPayloadHash(input.payload),
      requestedById: admin.session.user?.id,
      reviewedById: reviewer.session.user?.id,
      reviewedAt: new Date(),
      expiresAt: new Date(Date.now() + 2_000),
    },
  });
  await withSoleAdmin(
    [admin.session.user?.email as string, reviewer.session.user?.email as string],
    async () => {
      let executions = 0;
      await runWithAdminApproval(input, async () => {
        executions += 1;
      });
      assert.equal(executions, 1);
    }
  );
  assert.equal(
    (await prisma.adminActionApproval.findUniqueOrThrow({ where: { id: approval.id } })).status,
    "expired"
  );
  await withSoleAdmin([admin.session.user?.email as string], async () => {
    let executions = 0;
    await runWithAdminApproval(input, async () => {
      executions += 1;
    });
    assert.equal(executions, 1);
  });
});
