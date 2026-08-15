import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { cleanupExpiredData } from "@/lib/maintenance";
import { prisma } from "@/lib/prisma";
import { RETENTION_POLICIES, retentionCutoff } from "@/lib/retentionPolicyCore";

/**
 * The retention sweep, against a real database.
 *
 * `tests/retentionPolicy.test.mjs` proves each published policy names a
 * maintenance step. It cannot prove the step deletes anything: a step that
 * runs a query matching nothing passes that test exactly as well as a working
 * one, and a step whose `where` clause is wrong is the more likely of the two.
 *
 * Both tables here were published as retained-for-N-days and swept by nothing
 * at all, so what is asserted below is the part that was missing rather than
 * the part that already worked.
 */

// `cleanupExpiredData` refuses to run at all without this, deliberately and
// before any step: a sweep that re-encrypts OAuth tokens must not proceed with
// no key. Every other environment variable the sweep reads has a default.
process.env.OAUTH_TOKEN_ENCRYPTION_KEY ||=
    "retention-sweep-integration-test-key-0123456789";

const daysAgo = (days: number) =>
    new Date(Date.now() - days * 24 * 60 * 60 * 1000);

const resetData = async () => {
    await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AdminNotificationLog",
      "ProviderHealthCheck",
      "ProviderProbeResult",
      "ScheduledJobRun",
      "ProviderModelCatalogRun"
    RESTART IDENTITY CASCADE
  `);
};

beforeEach(resetData);

const notificationLog = (createdAt: Date, overrides: Record<string, unknown> = {}) =>
    prisma.adminNotificationLog.create({
        data: {
            channel: "email",
            title: "Provider degraded",
            detail: "openai latency above threshold",
            status: "sent",
            createdAt,
            ...overrides,
        },
    });

const healthCheck = (createdAt: Date) =>
    prisma.providerHealthCheck.create({
        data: {
            provider: "openai",
            kind: "configuration",
            status: "ok",
            createdAt,
        },
    });

test("provider check records past the published window are removed", async () => {
    const kept = await healthCheck(daysAgo(29));
    const swept = await healthCheck(daysAgo(31));

    const result = await cleanupExpiredData();

    assert.deepEqual(result.failedSteps, []);
    assert.equal(result.providerHealthChecks, 1);
    const remaining = await prisma.providerHealthCheck.findMany({
        select: { id: true },
    });
    assert.deepEqual(
        remaining.map((row) => row.id),
        [kept.id],
        `${swept.id} is past the 30-day policy and should have been deleted`
    );
});

test("alert delivery logs past the published window are removed", async () => {
    const kept = await notificationLog(daysAgo(89));
    await notificationLog(daysAgo(91));
    await notificationLog(daysAgo(400), { status: "failed", acknowledgedAt: daysAgo(399) });

    const result = await cleanupExpiredData();

    assert.deepEqual(result.failedSteps, []);
    assert.equal(result.notificationLogs, 2);
    const remaining = await prisma.adminNotificationLog.findMany({
        select: { id: true },
    });
    assert.deepEqual(remaining.map((row) => row.id), [kept.id]);
});

test("a failed delivery nobody acknowledged survives any age", async () => {
    // It is still on the work queue, oldest first. Sweeping on age alone would
    // take the one row an operator has not dealt with and leave the ones they
    // have -- the queue would empty by forgetting, not by fixing.
    const unacknowledged = await notificationLog(daysAgo(900), {
        status: "failed",
        acknowledgedAt: null,
    });

    const result = await cleanupExpiredData();

    assert.equal(result.notificationLogs, 0);
    const remaining = await prisma.adminNotificationLog.findMany({
        select: { id: true },
    });
    assert.deepEqual(remaining.map((row) => row.id), [unacknowledged.id]);
});

test("the boundary is the window the policy states, to the minute", async () => {
    // 29 vs 31 days would still pass with a 30-*hour* or 300-day window. This
    // sits a minute either side of the published cutoff, so the sweep has to
    // be using that number and not merely a number in the same neighbourhood.
    const now = new Date();
    const cutoff = retentionCutoff("providerChecks", now).getTime();
    const inside = await healthCheck(new Date(cutoff + 60_000));
    await healthCheck(new Date(cutoff - 60_000));

    const result = await cleanupExpiredData();

    assert.equal(result.providerHealthChecks, 1);
    const remaining = await prisma.providerHealthCheck.findMany({
        select: { id: true },
    });
    assert.deepEqual(remaining.map((row) => row.id), [inside.id]);
});

test("the three tables nothing used to remove rows from now have a ceiling", async () => {
    // Found by `npm run report:unswept-tables`. The probe one is the worst:
    // one row per probed model every ten minutes, and no code reads the table
    // at all -- it had neither a ceiling nor an audience.
    const probeRow = (startedAt: Date) =>
        prisma.providerProbeResult.create({
            data: {
                runId: `run-${startedAt.getTime()}`,
                provider: "openai",
                modelId: "gpt-5-6-luna",
                environment: "test",
                startedAt,
                completedAt: startedAt,
                success: true,
            },
        });
    const keptProbe = await probeRow(daysAgo(29));
    await probeRow(daysAgo(31));

    const keptJobRun = await prisma.scheduledJobRun.create({
        data: { jobKey: "provider_probe", status: "succeeded", startedAt: daysAgo(29) },
    });
    await prisma.scheduledJobRun.create({
        data: { jobKey: "provider_probe", status: "succeeded", startedAt: daysAgo(31) },
    });

    const keptCatalogRun = await prisma.providerModelCatalogRun.create({
        data: { provider: "openai", status: "succeeded", startedAt: daysAgo(364) },
    });
    await prisma.providerModelCatalogRun.create({
        data: { provider: "openai", status: "succeeded", startedAt: daysAgo(366) },
    });

    const result = await cleanupExpiredData();

    assert.deepEqual(result.failedSteps, []);
    assert.equal(result.providerProbeResults, 1);
    assert.equal(result.scheduledJobRuns, 1);
    assert.equal(result.providerModelCatalogRuns, 1);
    assert.deepEqual(
        (await prisma.providerProbeResult.findMany({ select: { id: true } })).map(
            (row) => row.id
        ),
        [keptProbe.id]
    );
    assert.deepEqual(
        (await prisma.scheduledJobRun.findMany({ select: { id: true } })).map(
            (row) => row.id
        ),
        [keptJobRun.id]
    );
    assert.deepEqual(
        (
            await prisma.providerModelCatalogRun.findMany({ select: { id: true } })
        ).map((row) => row.id),
        [keptCatalogRun.id]
    );
});

test("the sweep reports a number for every policy that claims to delete", async () => {
    // A step that threw reports null, which is deliberately distinct from the
    // 0 of a step that ran and found nothing. A published policy whose step
    // reports null is the same silence this whole change is about.
    const result = (await cleanupExpiredData()) as Record<string, unknown>;
    const reported = {
        providerChecks: "providerHealthChecks",
        notificationLogs: "notificationLogs",
        providerErrors: "providerErrorEvents",
        productAnalytics: "productAnalyticsEvents",
        providerProbeResults: "providerProbeResults",
        scheduledJobRuns: "scheduledJobRuns",
        providerModelCatalogRuns: "providerModelCatalogRuns",
    } as const;
    for (const [key, field] of Object.entries(reported)) {
        assert.ok(
            RETENTION_POLICIES.some(
                (policy) => policy.key === key && policy.action === "delete"
            ),
            `${key} is no longer a delete policy; update this test with it`
        );
        assert.equal(
            typeof result[field],
            "number",
            `${field} reported ${result[field]}, so its step did not complete`
        );
    }
});
