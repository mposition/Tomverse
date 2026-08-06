import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { getMemoryExtractionReport } from "@/lib/memoryExtractionMetrics";
import { prisma } from "@/lib/prisma";

/**
 * The extraction report against a real database (§22, the B list).
 *
 * The queries are what matters here rather than the arithmetic, which
 * tests/memoryExtractionMetricsCore.test.mjs covers: whether the window
 * excludes what it should, whether queue health deliberately ignores that
 * window, and whether the chunk query really reaches chunks through their run.
 */

const resetData = () =>
    prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "MemoryExtractionCreditReservation",
      "MemoryExtractionChunk",
      "MemoryExtractionRun",
      "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(resetData);
after(async () => {
    await resetData();
    await prisma.$disconnect();
});

const createUser = () =>
    prisma.user.create({
        data: { email: `metrics-${randomUUID()}@example.test` },
    });

const createRun = async (
    userId: string,
    overrides: {
        status?: string;
        createdAt?: Date;
        completedAt?: Date | null;
        leaseExpiresAt?: Date | null;
        extractionModelId?: string;
        chunkTotal?: number;
    } = {}
) =>
    prisma.memoryExtractionRun.create({
        data: {
            userId,
            status: overrides.status ?? "completed",
            extractionModelId: overrides.extractionModelId ?? "gpt-5-6-luna",
            promptVersion: "mem-extract-v1",
            sourceSelection: ["c1"],
            chunkTotal: overrides.chunkTotal ?? 1,
            chunkCompleted: 0,
            createdAt: overrides.createdAt ?? new Date(),
            completedAt: overrides.completedAt ?? null,
            leaseExpiresAt: overrides.leaseExpiresAt ?? null,
        },
    });

test("the window excludes older runs but queue health does not", async () => {
    // A run stuck since before the window is exactly the one an operator needs
    // to see, so the live queue counts are deliberately unwindowed.
    const user = await createUser();
    const old = new Date(Date.now() - 30 * 86_400_000);
    await createRun(user.id, {
        status: "pending",
        createdAt: old,
        completedAt: null,
    });
    await createRun(user.id, { status: "completed", completedAt: new Date() });

    const report = await getMemoryExtractionReport({ windowDays: 7 });
    assert.equal(report.runs.total, 1);
    assert.deepEqual(report.runs.byStatus, { completed: 1 });
    assert.equal(report.queue.pendingRuns, 1);
    assert.ok(
        (report.queue.oldestPendingAgeSeconds ?? 0) > 20 * 86_400,
        "the stuck run's age is reported even though it is outside the window"
    );
});

test("a lapsed lease is counted, so a dispatcher falling behind is visible", async () => {
    const user = await createUser();
    await createRun(user.id, {
        status: "running",
        completedAt: null,
        leaseExpiresAt: new Date(Date.now() - 60_000),
    });
    await createRun(user.id, {
        status: "running",
        completedAt: null,
        leaseExpiresAt: new Date(Date.now() + 600_000),
    });

    const report = await getMemoryExtractionReport();
    assert.equal(report.queue.runningRuns, 2);
    assert.equal(report.queue.expiredLeases, 1);
});

test("chunks are reached through their run's window", async () => {
    const user = await createUser();
    const recent = await createRun(user.id, { chunkTotal: 2 });
    const old = await createRun(user.id, {
        chunkTotal: 1,
        createdAt: new Date(Date.now() - 30 * 86_400_000),
    });
    await prisma.memoryExtractionChunk.createMany({
        data: [
            {
                runId: recent.id,
                chunkIndex: 0,
                conversationIds: ["c1"],
                status: "completed",
                attemptCount: 1,
            },
            {
                runId: recent.id,
                chunkIndex: 1,
                conversationIds: ["c2"],
                status: "failed",
                attemptCount: 3,
                failureCode: "provider_error",
            },
            {
                runId: old.id,
                chunkIndex: 0,
                conversationIds: ["c3"],
                status: "failed",
                attemptCount: 1,
                failureCode: "persist_error",
            },
        ],
    });

    const report = await getMemoryExtractionReport({ windowDays: 7 });
    assert.equal(report.chunks.total, 2);
    assert.deepEqual(report.chunks.failureCodes, { provider_error: 1 });
    assert.equal(report.chunks.retryRate, 0.5);
});

test("the window is clamped rather than trusted", async () => {
    assert.equal((await getMemoryExtractionReport({ windowDays: 0 })).windowDays, 1);
    assert.equal(
        (await getMemoryExtractionReport({ windowDays: 10_000 })).windowDays,
        90
    );
    assert.equal(
        (await getMemoryExtractionReport({ windowDays: Number.NaN })).windowDays,
        7
    );
});

test("an empty database reports zeroes, not nulls that read as an outage", async () => {
    const report = await getMemoryExtractionReport();
    assert.equal(report.runs.total, 0);
    assert.equal(report.chunks.total, 0);
    assert.equal(report.credits.reservations, 0);
    assert.equal(report.queue.pendingRuns, 0);
    assert.equal(report.queue.oldestPendingAgeSeconds, null);
    assert.equal(report.truncated, false);
});
