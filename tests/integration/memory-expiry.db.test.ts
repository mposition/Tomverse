import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { reconcileExpiredMemories } from "@/lib/memoryExpiryService";
import { getMemoryReport } from "@/lib/memoryMetrics";
import { retrieveMemoryContext } from "@/lib/memoryRetrievalService";
import { memoryRetrievalTerms } from "@/lib/memoryRetrievalTerms";
import { prisma } from "@/lib/prisma";

/**
 * §8.6 — the expiry sweep, and its relationship to the lazy check.
 *
 * The two halves are not redundant and the tests say which is which: the lazy
 * check in retrieval is what guarantees an expired memory never reaches a
 * prompt, and the sweep is what makes the row *say* it expired. A sweep that
 * never ran must not be able to leak one into a prompt, so that case is
 * asserted directly.
 */

const resetData = async () => {
    await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "MemoryEvidence",
      "MemoryItem",
      "UserMemorySettings",
      "ChatUsageBucket"
    RESTART IDENTITY CASCADE
  `);
};

const createUser = () =>
    prisma.user.create({
        data: { email: `memory-expiry-${randomUUID()}@example.test` },
    });

const NOW = new Date("2026-08-04T00:00:00.000Z");
const PAST = new Date("2026-08-03T00:00:00.000Z");
const FUTURE = new Date("2026-09-01T00:00:00.000Z");

const seedMemory = (
    userId: string,
    overrides: {
        statement?: string;
        status?: string;
        expiresAt?: Date | null;
    } = {}
) => {
    const statement = overrides.statement ?? "사용자는 커피를 좋아한다";
    return prisma.memoryItem.create({
        data: {
            userId,
            kind: "preference",
            statement,
            status: overrides.status ?? "active",
            confidence: 0.9,
            pinned: true,
            expiresAt: overrides.expiresAt ?? null,
            approvedAt: new Date("2026-08-01T00:00:00.000Z"),
            searchTerms: memoryRetrievalTerms(statement),
            retrievalVersion: 1,
        },
    });
};

const statusOf = async (id: string) =>
    (
        await prisma.memoryItem.findUnique({
            where: { id },
            select: { status: true },
        })
    )?.status ?? null;

beforeEach(resetData);

after(async () => {
    await resetData();
    await prisma.$disconnect();
});

test("a memory past its expiry is moved to expired", async () => {
    const user = await createUser();
    const memory = await seedMemory(user.id, { expiresAt: PAST });

    const result = await reconcileExpiredMemories(NOW);
    assert.equal(result.expiredMemories, 1);
    assert.equal(await statusOf(memory.id), "expired");
});

test("memories awaiting review expire too", async () => {
    const user = await createUser();
    const candidate = await seedMemory(user.id, {
        status: "candidate",
        expiresAt: PAST,
    });
    const flagged = await seedMemory(user.id, {
        statement: "다른 문장",
        status: "manual_review_required",
        expiresAt: PAST,
    });

    await reconcileExpiredMemories(NOW);
    assert.equal(await statusOf(candidate.id), "expired");
    assert.equal(await statusOf(flagged.id), "expired");
});

test("a memory with no expiry, or one still in the future, is untouched", async () => {
    const user = await createUser();
    const forever = await seedMemory(user.id, { expiresAt: null });
    const later = await seedMemory(user.id, {
        statement: "다른 문장",
        expiresAt: FUTURE,
    });

    const result = await reconcileExpiredMemories(NOW);
    assert.equal(result.expiredMemories, 0);
    assert.equal(await statusOf(forever.id), "active");
    assert.equal(await statusOf(later.id), "active");
});

test("an archived memory keeps the status that says why it left", async () => {
    // Same rule as the §13.1 source-delete path: it is out of retrieval
    // either way, and overwriting would replace the true reason.
    const user = await createUser();
    const rejected = await seedMemory(user.id, {
        status: "rejected",
        expiresAt: PAST,
    });
    const suspended = await seedMemory(user.id, {
        statement: "다른 문장",
        status: "suspended_by_source_delete",
        expiresAt: PAST,
    });

    await reconcileExpiredMemories(NOW);
    assert.equal(await statusOf(rejected.id), "rejected");
    assert.equal(await statusOf(suspended.id), "suspended_by_source_delete");
});

test("the sweep is idempotent — a second run finds nothing", async () => {
    const user = await createUser();
    await seedMemory(user.id, { expiresAt: PAST });

    assert.equal((await reconcileExpiredMemories(NOW)).expiredMemories, 1);
    assert.equal((await reconcileExpiredMemories(NOW)).expiredMemories, 0);
});

test("expiry moves the account's memory fingerprint inputs", async () => {
    // §10 binds the active count and the newest modification. Expiring a row
    // has to move at least one, or a bundle priced against the old set would
    // keep verifying.
    const user = await createUser();
    await seedMemory(user.id, { expiresAt: PAST });
    const before = await prisma.memoryItem.aggregate({
        where: { userId: user.id, status: "active" },
        _count: { _all: true },
        _max: { updatedAt: true },
    });

    await reconcileExpiredMemories(NOW);
    const after = await prisma.memoryItem.aggregate({
        where: { userId: user.id, status: "active" },
        _count: { _all: true },
        _max: { updatedAt: true },
    });
    assert.equal(before._count._all, 1);
    assert.equal(after._count._all, 0, "the active set changed");
});

test("an expired memory never reaches a prompt, swept or not", async () => {
    // The load-bearing half. If this ever fails, the sweep's schedule becomes
    // a correctness dependency, which §8.6 says it must not be.
    const user = await createUser();
    await seedMemory(user.id, { expiresAt: PAST });

    const beforeSweep = await retrieveMemoryContext({
        userId: user.id,
        query: "커피",
        now: NOW,
    });
    assert.deepEqual(beforeSweep.selected, [], "lazy exclusion holds first");

    await reconcileExpiredMemories(NOW);
    const afterSweep = await retrieveMemoryContext({
        userId: user.id,
        query: "커피",
        now: NOW,
    });
    assert.deepEqual(afterSweep.selected, []);
});

test("another account's expired memories are swept in the same pass", async () => {
    // The sweep is global maintenance, not per-account: it must not need a
    // request from an owner to clean their rows up.
    const first = await createUser();
    const second = await createUser();
    const a = await seedMemory(first.id, { expiresAt: PAST });
    const b = await seedMemory(second.id, { expiresAt: PAST });

    const result = await reconcileExpiredMemories(NOW);
    assert.equal(result.expiredMemories, 2);
    assert.equal(await statusOf(a.id), "expired");
    assert.equal(await statusOf(b.id), "expired");
});

test("a memory expiring exactly now is expired, not left for the next pass", async () => {
    const user = await createUser();
    const memory = await seedMemory(user.id, { expiresAt: NOW });

    assert.equal((await reconcileExpiredMemories(NOW)).expiredMemories, 1);
    assert.equal(await statusOf(memory.id), "expired");
});

test("the sweep reports how many it expired, as a content-free counter", async () => {
    // §22: the transition leaves no row to aggregate afterwards, so the count
    // is only knowable at the moment of the sweep.
    const user = await createUser();
    await seedMemory(user.id, { expiresAt: PAST });
    await seedMemory(user.id, { statement: "다른 문장", expiresAt: PAST });

    await reconcileExpiredMemories(NOW);
    const report = await getMemoryReport({ now: NOW });
    assert.equal(report.counters.memory_expired, 2);
});
