import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { ApiSecurityError } from "@/lib/apiSecurity";
import {
    getUserChatUsageKey,
    usagePeriodStart,
} from "@/lib/chatSecurity";
import { externalContentDigest } from "@/lib/externalImportDigest";
import { settleExtractionRunCredits } from "@/lib/memoryExtractionCredits";
import type { MemoryExtractionEvalEntry } from "@/lib/memoryExtractionEvalRegister";
import { MEMORY_EXTRACTION_LEASE_TTL_MS } from "@/lib/memoryExtractionCore";
import {
    cancelMemoryExtractionRun,
    claimMemoryExtractionRun,
    claimNextExtractionChunk,
    completeExtractionChunk,
    createMemoryExtractionRun,
    estimateMemoryExtraction,
    reconcileExpiredMemoryExtractionRuns,
} from "@/lib/memoryExtractionService";
import { deleteAllMemories } from "@/lib/memoryService";
import { prisma } from "@/lib/prisma";

/**
 * Entitlement for an extraction run (§11), against a real database because
 * every rule here is about what the account actually holds afterwards.
 *
 * The reservation is per run rather than per chunk: §11 shows the plan and its
 * credit total before the run starts and refuses a stale confirmation, so the
 * run is the unit the user agreed to. What these tests pin is the other half
 * of that promise -- a run that does not finish gives back what it did not
 * spend, exactly once.
 */

const resetData = () =>
    prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "MemoryExtractionCreditReservation",
      "MemoryExtractionChunk",
      "MemoryExtractionRun",
      "MemoryEvidence",
      "MemoryItem",
      "ExternalMessage",
      "ExternalConversation",
      "ExternalImport",
      "ChatUsageBucket",
      "CreditLot",
      "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(resetData);
after(async () => {
    await resetData();
    await prisma.$disconnect();
});

const APPROVED_REGISTER: readonly MemoryExtractionEvalEntry[] = [
    {
        extractionModelId: "gpt-5-6-luna",
        promptVersion: "mem-extract-v1",
        status: "approved",
        owner: "@qa",
        registeredAt: "2026-08-03",
        evalBudget: {
            approvedBy: "@qa",
            maxUsd: 100,
            ticket: "QA-1",
            approvedAt: "2026-08-03",
        },
        evaluation: {
            artifactRef: "qa-fixture",
            evaluatedCommit: "a".repeat(40),
            datasetVersion: "v1",
            languages: ["ko", "en"],
            sampleCounts: Object.fromEntries(
                ["1", "2", "3", "4"].flatMap((category) =>
                    ["ko", "en"].map((language) => [
                        `${category}:${language}`,
                        200,
                    ])
                )
            ),
            metrics: {
                precisionWilsonLowerAggregate: 0.96,
                recallWilsonLowerAggregate: 0.9,
                precisionWilsonLowerByArm: { ko: 0.96, en: 0.95 },
                recallWilsonLowerByArm: { ko: 0.9, en: 0.86 },
            },
            criticalFalseAcceptances: 0,
            approver: "@qa",
            approvedAt: "2026-08-03",
            expiresAt: "2027-08-03",
            knownLimitations: "test fixture",
        },
    },
];

const seed = async (conversationCount = 2) => {
    const user = await prisma.user.create({
        data: { email: `credits-${randomUUID()}@example.test` },
    });
    const importRow = await prisma.externalImport.create({
        data: {
            userId: user.id,
            provider: "chatgpt",
            status: "completed",
            parserVersion: "test-1",
            digestVersion: 1,
        },
    });
    const ids: string[] = [];
    for (let index = 0; index < conversationCount; index += 1) {
        const content = `conversation body ${index}`;
        const conversation = await prisma.externalConversation.create({
            data: {
                userId: user.id,
                importId: importRow.id,
                provider: "chatgpt",
                externalStableId: randomUUID().replaceAll("-", ""),
                title: `credit fixture ${index}`,
                conversationDigest: randomUUID().replaceAll("-", "").repeat(2),
                digestVersion: 1,
                messageCount: 1,
                contentBytes: BigInt(content.length),
                finalized: true,
            },
        });
        await prisma.externalMessage.create({
            data: {
                userId: user.id,
                externalConversationId: conversation.id,
                externalStableId: randomUUID().replaceAll("-", ""),
                role: "user",
                content,
                contentDigest: externalContentDigest(content),
                digestVersion: 1,
                ordinal: 0,
            },
        });
        ids.push(conversation.id);
    }
    return { user, conversationIds: ids };
};

const baseInput = (userId: string, conversationIds: string[]) => ({
    userId,
    extractionModelId: "gpt-5-6-luna",
    promptVersion: "mem-extract-v1",
    plan: "Pro" as const,
    selectedConversationIds: conversationIds,
    register: APPROVED_REGISTER,
});

const createRun = async (userId: string, conversationIds: string[]) => {
    const estimate = await estimateMemoryExtraction(
        baseInput(userId, conversationIds)
    );
    const run = await createMemoryExtractionRun({
        ...baseInput(userId, conversationIds),
        confirmedCredits: estimate.estimatedCredits,
    });
    return { run, estimate };
};

const monthlyUsed = async (userId: string) => {
    const row = await prisma.chatUsageBucket.findFirst({
        where: {
            key: getUserChatUsageKey(userId),
            period: "month",
            periodStart: usagePeriodStart("month", new Date()),
        },
    });
    return Number(row?.count ?? 0);
};

test("creating a run reserves the confirmed credits in the same transaction (§11)", async () => {
    const { user, conversationIds } = await seed();
    const { run, estimate } = await createRun(user.id, conversationIds);

    const reservation = await prisma.memoryExtractionCreditReservation.findUniqueOrThrow(
        { where: { runId: run.id } }
    );
    assert.equal(reservation.status, "reserved");
    assert.equal(reservation.outcome, null);
    assert.equal(reservation.reservedCredits, estimate.estimatedCredits);
    assert.equal(reservation.chunkTotal, estimate.chunkCount);
    assert.equal(
        reservation.planReservedCredits + reservation.addOnReservedCredits,
        reservation.reservedCredits
    );
    // Frozen at reservation: a price change afterwards must not re-settle a
    // run the user already confirmed at these numbers.
    assert.ok(reservation.pricingVersion.length > 0);
    assert.ok(reservation.costSource.length > 0);

    assert.equal(await monthlyUsed(user.id), reservation.planReservedCredits);
});

test("a refused reservation leaves no run, no chunks and no charge", async () => {
    const { user, conversationIds } = await seed();
    // Spend the plan's monthly allowance first.
    await prisma.chatUsageBucket.create({
        data: {
            key: getUserChatUsageKey(user.id),
            period: "month",
            periodStart: usagePeriodStart("month", new Date()),
            count: 1_000_000,
        },
    });
    const estimate = await estimateMemoryExtraction(
        baseInput(user.id, conversationIds)
    );
    await assert.rejects(
        createMemoryExtractionRun({
            ...baseInput(user.id, conversationIds),
            confirmedCredits: estimate.estimatedCredits,
        }),
        (error: unknown) =>
            error instanceof ApiSecurityError &&
            error.code === "CREDIT_BALANCE_INSUFFICIENT"
    );

    // The whole transaction rolled back, so the account is not left holding an
    // unrunnable run it can never start another one behind.
    assert.equal(await prisma.memoryExtractionRun.count(), 0);
    assert.equal(await prisma.memoryExtractionChunk.count(), 0);
    assert.equal(await prisma.memoryExtractionCreditReservation.count(), 0);
});

test("cancelling before any chunk ran refunds everything (§11)", async () => {
    const { user, conversationIds } = await seed();
    const { run } = await createRun(user.id, conversationIds);
    const reserved = await prisma.memoryExtractionCreditReservation.findUniqueOrThrow(
        { where: { runId: run.id } }
    );
    assert.ok(reserved.planReservedCredits > 0);

    await cancelMemoryExtractionRun(user.id, run.id);

    const settled = await prisma.memoryExtractionCreditReservation.findUniqueOrThrow(
        { where: { runId: run.id } }
    );
    assert.equal(settled.status, "settled");
    assert.equal(settled.outcome, "cancelled");
    assert.equal(settled.settledCredits, 0);
    assert.equal(settled.chunksCharged, 0);
    assert.ok(settled.refundedAt);
    assert.equal(await monthlyUsed(user.id), 0);
});

test("a second cancel refunds nothing a second time", async () => {
    const { user, conversationIds } = await seed();
    const { run } = await createRun(user.id, conversationIds);
    await cancelMemoryExtractionRun(user.id, run.id);
    const afterFirst = await monthlyUsed(user.id);

    await cancelMemoryExtractionRun(user.id, run.id);
    assert.equal(await monthlyUsed(user.id), afterFirst);

    const settled = await prisma.memoryExtractionCreditReservation.findUniqueOrThrow(
        { where: { runId: run.id } }
    );
    assert.equal(settled.status, "settled");
    assert.equal(settled.settledCredits, 0);
});

test("settling twice is claimed once, whatever the second call asks for", async () => {
    // The `reserved -> settling -> settled` transition, not a flag: a
    // duplicate settle finds nothing to claim, so it cannot charge for chunks
    // the first settlement already refunded.
    const { user, conversationIds } = await seed();
    const { run } = await createRun(user.id, conversationIds);

    const first = await prisma.$transaction((tx) =>
        settleExtractionRunCredits(tx, {
            runId: run.id,
            outcome: "cancelled",
            chunksCharged: 0,
        })
    );
    assert.equal(first.applied, true);
    assert.equal(first.settledCredits, 0);

    const second = await prisma.$transaction((tx) =>
        settleExtractionRunCredits(tx, {
            runId: run.id,
            outcome: "completed",
            chunksCharged: 99,
        })
    );
    assert.equal(second.applied, false);

    const settled = await prisma.memoryExtractionCreditReservation.findUniqueOrThrow(
        { where: { runId: run.id } }
    );
    assert.equal(settled.outcome, "cancelled");
    assert.equal(settled.settledCredits, 0);
    assert.equal(await monthlyUsed(user.id), 0);
});

test("a partly-run run keeps the chunks it spent and refunds the rest", async () => {
    const { user, conversationIds } = await seed(2);
    const { run } = await createRun(user.id, conversationIds);
    const reservation = await prisma.memoryExtractionCreditReservation.findUniqueOrThrow(
        { where: { runId: run.id } }
    );
    const chunkTotal = reservation.chunkTotal;
    const charged = Math.max(1, chunkTotal - 1);

    const result = await prisma.$transaction((tx) =>
        settleExtractionRunCredits(tx, {
            runId: run.id,
            outcome: "failed",
            chunksCharged: charged,
        })
    );
    assert.equal(result.applied, true);

    const expected = Math.floor(
        (reservation.reservedCredits * charged) / chunkTotal
    );
    assert.equal(result.settledCredits, expected);
    assert.equal(
        result.refundedCredits,
        reservation.reservedCredits - expected
    );
    assert.equal(await monthlyUsed(user.id), expected);
});

test("settlement can never charge more than was reserved", async () => {
    // The CHECK behind the arithmetic: a settlement that charged past the
    // confirmed total would be a silent re-price of a run the user agreed to.
    const { user, conversationIds } = await seed();
    const { run } = await createRun(user.id, conversationIds);
    const reservation = await prisma.memoryExtractionCreditReservation.findUniqueOrThrow(
        { where: { runId: run.id } }
    );
    await assert.rejects(
        prisma.memoryExtractionCreditReservation.update({
            where: { runId: run.id },
            data: { settledCredits: reservation.reservedCredits + 1 },
        })
    );
    await assert.rejects(
        prisma.memoryExtractionCreditReservation.update({
            where: { runId: run.id },
            data: { chunksCharged: reservation.chunkTotal + 1 },
        })
    );
});

/* ---------------------------------------------- canonical lock order (§9) */

/**
 * Every path that reserves or refunds credits takes `credit-account:<userId>`
 * first (credit-and-cost-limits.md §9).
 *
 * `reserveAddOnCredits` reads the account's lots, decides sufficiency from
 * that read, and then decrements them. The decrement is atomic but the
 * *decision* is not, so two transactions that both read the same balance both
 * pass and `CreditLot.remainingCredits` goes negative -- there is no CHECK
 * constraint and no post-update guard behind it. What makes it safe is that
 * every caller holds the account's advisory lock, which serialises them.
 *
 * Chat and image generation take it. Extraction is the third caller of the
 * same primitive from a different orchestration, so it has to take the same
 * lock, and take it *first*: acquiring the run lock before the credit lock
 * would invert chat's order and deadlock the pair.
 *
 * The test holds the lock from outside and asserts the run blocks. Asserting
 * on a raced balance instead would only fail some of the time; blocking is
 * the property, so blocking is what is measured.
 */
/** Comfortably longer than an unblocked run creation, which measures ~300ms. */
const BLOCKED_OBSERVATION_MS = 2_000;

/**
 * Runs `body` while `credit-account:<userId>` is held by another transaction,
 * and reports whether it was still pending after BLOCKED_OBSERVATION_MS. The
 * lock is released afterwards either way, so the caller can also assert that
 * the work then completes -- the property is a wait, not a refusal.
 */
const whileCreditAccountLocked = async <T>(
    userId: string,
    body: () => Promise<T>
): Promise<{ blocked: boolean; result: T }> => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const holder = prisma.$transaction(
        async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`credit-account:${userId}`}))`;
            await held;
        },
        { timeout: 30_000, maxWait: 30_000 }
    );
    // Let the holder actually acquire before the body races it.
    await new Promise((resolve) => setTimeout(resolve, 250));

    let settled = false;
    const running = body();
    // Attached before the wait so a rejection is never unhandled; the real
    // outcome is awaited below.
    void running.then(
        () => {
            settled = true;
        },
        () => {
            settled = true;
        }
    );
    await new Promise((resolve) => setTimeout(resolve, BLOCKED_OBSERVATION_MS));
    const blocked = !settled;

    release();
    await holder;
    return { blocked, result: await running };
};

test("creating a run waits for the account's credit lock (§9 lock order)", async () => {
    const { user, conversationIds } = await seed();
    const estimate = await estimateMemoryExtraction(
        baseInput(user.id, conversationIds)
    );

    const { blocked, result: run } = await whileCreditAccountLocked(
        user.id,
        () =>
            createMemoryExtractionRun({
                ...baseInput(user.id, conversationIds),
                confirmedCredits: estimate.estimatedCredits,
            })
    );

    assert.equal(
        blocked,
        true,
        "the reservation reached the credit lots without holding credit-account:<userId>"
    );
    // And once released it completes normally: the lock is a wait, not a
    // refusal, so an account is never told it cannot start a run because
    // something else was briefly touching its credits.
    const reservation =
        await prisma.memoryExtractionCreditReservation.findUniqueOrThrow({
            where: { runId: run.id },
        });
    assert.equal(reservation.status, "reserved");
});

test("cancelling a run waits for the account's credit lock (§9 lock order)", async () => {
    // The refund half of the same rule. A refund only increments, which is
    // atomic by itself -- but a refund landing between a concurrent
    // reservation's read and its decrement lets that reservation decide
    // against a balance that was never there.
    const { user, conversationIds } = await seed();
    const { run } = await createRun(user.id, conversationIds);

    const { blocked } = await whileCreditAccountLocked(user.id, () =>
        cancelMemoryExtractionRun(user.id, run.id)
    );

    assert.equal(
        blocked,
        true,
        "the refund reached the credit lots without holding credit-account:<userId>"
    );
    const reservation =
        await prisma.memoryExtractionCreditReservation.findUniqueOrThrow({
            where: { runId: run.id },
        });
    assert.equal(reservation.status, "settled");
});

/*
  task_9d445985 (first cycle): a chunk report and a lease reclaim on the same
  run, plus the settlement delete-all now owns.

  Interleavings are forced, not raced. A holder transaction keeps a lock;
  each contender is started and the test waits until PostgreSQL reports it
  waiting on a lock before starting the next, so the queue order is the one
  named in the test rather than whatever the scheduler chose.
*/

/** Waits until at least `count` backends are waiting on a heavyweight lock. */
const waitForLockWaiters = async (count: number) => {
    const deadline = Date.now() + 15_000;
    for (;;) {
        const [row] = await prisma.$queryRaw<Array<{ waiting: number }>>`
            SELECT count(*)::int AS waiting FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
        `;
        if (row.waiting >= count) return;
        if (Date.now() > deadline) throw new Error(`expected ${count} lock waiters, saw ${row.waiting}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
};

/** Holds `lockSql` in its own transaction until `release()`. */
const holdLock = (take: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<unknown>) => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });
    let acquired!: () => void;
    const holding = new Promise<void>((resolve) => {
        acquired = resolve;
    });
    const done = prisma.$transaction(
        async (tx) => {
            await take(tx);
            acquired();
            await released;
        },
        { timeout: 30_000, maxWait: 30_000 }
    );
    return { holding, release, done };
};

const holdRunRow = (runId: string) =>
    holdLock((tx) => tx.$queryRaw`SELECT id FROM "MemoryExtractionRun" WHERE id = ${runId} FOR UPDATE`);

/** A running run whose lease has expired, with one chunk its dead worker holds. */
const runWithStaleChunk = async (conversationCount: number) => {
    const { user, conversationIds } = await seed(conversationCount);
    const { run } = await createRun(user.id, conversationIds);
    const stale = await claimMemoryExtractionRun({ runId: run.id, owner: "worker-stale" });
    assert.ok(stale);
    const chunk = await claimNextExtractionChunk(stale);
    assert.ok(chunk);
    await prisma.memoryExtractionRun.update({
        where: { id: run.id },
        data: { leaseExpiresAt: new Date(Date.now() - MEMORY_EXTRACTION_LEASE_TTL_MS) },
    });
    return { user, run, stale, chunk };
};

const reservationFor = (runId: string) =>
    prisma.memoryExtractionCreditReservation.findUniqueOrThrow({ where: { runId } });

test("a stale report queued behind a reclaim is fenced out instead of deadlocking", async () => {
    // On the old order the report held its chunk and waited for the run while
    // the reclaim held the run and waited for that chunk.
    const { run, stale, chunk } = await runWithStaleChunk(2);
    const holder = holdRunRow(run.id);
    await holder.holding;

    const reclaim = claimMemoryExtractionRun({ runId: run.id, owner: "worker-next" });
    await waitForLockWaiters(1);
    const report = completeExtractionChunk(stale, chunk.chunkIndex, { outcome: "completed" });
    await waitForLockWaiters(2);
    holder.release();
    await holder.done;

    const [revived, reported] = await Promise.all([reclaim, report]);
    assert.ok(revived, "the reclaim took the run");
    assert.equal(reported.applied, false, "the superseded generation changed nothing");
    const row = await prisma.memoryExtractionChunk.findFirstOrThrow({
        where: { runId: run.id, chunkIndex: chunk.chunkIndex },
    });
    assert.equal(row.status, "pending");
    assert.equal((await reservationFor(run.id)).status, "reserved");
});

test("a reclaim queued behind a terminal report finds a finished run", async () => {
    const { run, stale, chunk } = await runWithStaleChunk(2);
    assert.equal(run.chunkTotal, 1, "fixture: one chunk, so its report is terminal");
    const holder = holdRunRow(run.id);
    await holder.holding;

    const report = completeExtractionChunk(stale, chunk.chunkIndex, { outcome: "completed" });
    await waitForLockWaiters(1);
    const reclaim = claimMemoryExtractionRun({ runId: run.id, owner: "worker-next" });
    await waitForLockWaiters(2);
    holder.release();
    await holder.done;

    const [reported, revived] = await Promise.all([report, reclaim]);
    assert.deepEqual(
        { applied: reported.applied, runStatus: reported.runStatus },
        { applied: true, runStatus: "completed" }
    );
    assert.equal(revived, null);
    const reservation = await reservationFor(run.id);
    assert.equal(reservation.status, "settled");
    assert.equal(reservation.outcome, "completed");
    assert.equal(reservation.chunksCharged, 1);
});

test("a reclaim queued behind a non-terminal report finds a renewed lease", async () => {
    const { run, stale, chunk } = await runWithStaleChunk(11);
    assert.ok(run.chunkTotal >= 2, "fixture: more than one chunk, so the report is not terminal");
    const holder = holdRunRow(run.id);
    await holder.holding;

    const report = completeExtractionChunk(stale, chunk.chunkIndex, { outcome: "completed" });
    await waitForLockWaiters(1);
    const reclaim = claimMemoryExtractionRun({ runId: run.id, owner: "worker-next" });
    await waitForLockWaiters(2);
    holder.release();
    await holder.done;

    const [reported, revived] = await Promise.all([report, reclaim]);
    assert.deepEqual(
        { applied: reported.applied, runStatus: reported.runStatus },
        { applied: true, runStatus: "running" }
    );
    assert.equal(revived, null, "the report renewed the lease");
    assert.equal((await reservationFor(run.id)).status, "reserved");
});

test("delete-all queued behind a terminal report leaves the report's settlement alone", async () => {
    const { user, run, stale, chunk } = await runWithStaleChunk(2);
    const holder = holdRunRow(run.id);
    await holder.holding;

    // The report takes the credit account, then waits for the run row.
    const report = completeExtractionChunk(stale, chunk.chunkIndex, { outcome: "completed" });
    await waitForLockWaiters(1);
    // Delete-all waits for the credit account the report holds.
    const deletion = deleteAllMemories(user.id);
    await waitForLockWaiters(2);
    holder.release();
    await holder.done;

    const [reported, deleted] = await Promise.all([report, deletion]);
    assert.equal(reported.applied, true);
    assert.equal(deleted.cancelledRuns, 0, "the run had finished before delete-all looked");
    const reservation = await reservationFor(run.id);
    assert.equal(reservation.status, "settled");
    assert.equal(reservation.outcome, "completed");
    assert.equal(reservation.chunksCharged, 1);
});

test("a report queued behind delete-all is fenced out, and delete-all settles once", async () => {
    const { user, run, stale, chunk } = await runWithStaleChunk(2);
    const holder = holdRunRow(run.id);
    await holder.holding;

    // Delete-all takes the credit account, then waits for the run row.
    const deletion = deleteAllMemories(user.id);
    await waitForLockWaiters(1);
    // The report waits for the credit account.
    const report = completeExtractionChunk(stale, chunk.chunkIndex, { outcome: "completed" });
    await waitForLockWaiters(2);
    holder.release();
    await holder.done;

    const [deleted, reported] = await Promise.all([deletion, report]);
    assert.equal(deleted.cancelledRuns, 1);
    assert.equal(reported.applied, false);
    const row = await prisma.memoryExtractionChunk.findFirstOrThrow({
        where: { runId: run.id, chunkIndex: chunk.chunkIndex },
    });
    assert.equal(row.status, "running", "the fenced report did not touch its chunk");
    const reservation = await reservationFor(run.id);
    assert.equal(reservation.status, "settled");
    assert.equal(reservation.outcome, "cancelled");
    assert.equal(reservation.chunksCharged, 0);
    assert.equal(reservation.settledCredits, 0);
    assert.equal(await monthlyUsed(user.id), 0, "everything reserved came back");
});

test("delete-all refunds a run that never started, and never refunds a settled one twice", async () => {
    const { user, conversationIds } = await seed();
    const { run } = await createRun(user.id, conversationIds);

    const first = await deleteAllMemories(user.id);
    assert.equal(first.cancelledRuns, 1);
    const reservation = await reservationFor(run.id);
    assert.equal(reservation.status, "settled");
    assert.equal(reservation.outcome, "cancelled");
    assert.equal(await monthlyUsed(user.id), 0);

    // An active run whose reservation is somehow already settled: delete-all
    // cancels the run and claims nothing a second time.
    await prisma.memoryExtractionRun.update({ where: { id: run.id }, data: { status: "pending" } });
    const second = await deleteAllMemories(user.id);
    assert.equal(second.cancelledRuns, 1);
    const again = await reservationFor(run.id);
    assert.deepEqual(again.settledAt, reservation.settledAt);
    assert.equal(await monthlyUsed(user.id), 0);
});

test("the lease sweep skips runs another transaction holds instead of waiting on them", async () => {
    const { run } = await runWithStaleChunk(2);
    const holder = holdRunRow(run.id);
    await holder.holding;
    const swept = await reconcileExpiredMemoryExtractionRuns();
    assert.equal(swept.reclaimedRuns, 0, "a held row is left for the next cycle");
    holder.release();
    await holder.done;
    assert.equal((await reconcileExpiredMemoryExtractionRuns()).reclaimedRuns, 1);
});


/* ------------------------------------------ chunks that called no provider */

/**
 * The defect these pin: a chunk whose conversations had all gone returned
 * `completed`, and `chunksCharged` is the count of completed chunks, so the
 * account paid for a provider call nobody made. The settlement contract says
 * in as many words that a charged chunk "really did call the provider"
 * (lib/memoryExtractionCredits.ts), so this was a contradiction rather than a
 * decision -- and deleting a source is an ordinary, repeatable thing to do.
 */

test("a chunk that called no provider finishes the run and is not charged", async () => {
    const { user, conversationIds } = await seed(2);
    const { run } = await createRun(user.id, conversationIds);
    assert.equal(run.chunkTotal, 1, "fixture: one chunk, so its report is terminal");

    const lease = await claimMemoryExtractionRun({ runId: run.id, owner: "worker" });
    assert.ok(lease);
    const chunk = await claimNextExtractionChunk(lease);
    assert.ok(chunk);

    const reported = await completeExtractionChunk(lease, chunk.chunkIndex, {
        outcome: "skipped",
    });
    assert.deepEqual(
        { applied: reported.applied, runStatus: reported.runStatus },
        { applied: true, runStatus: "completed" },
        "a skip still finishes the run -- waiting for it would never end"
    );

    const row = await prisma.memoryExtractionChunk.findFirstOrThrow({
        where: { runId: run.id, chunkIndex: chunk.chunkIndex },
    });
    assert.equal(row.status, "skipped");
    assert.ok(row.completedAt, "terminal like completed, so it has a finish time");

    const reservation = await reservationFor(run.id);
    assert.equal(reservation.status, "settled");
    assert.equal(reservation.outcome, "completed");
    assert.equal(reservation.chunksCharged, 0, "nothing called the provider");
    assert.equal(reservation.settledCredits, 0);
    assert.ok(
        reservation.reservedCredits > 0,
        "fixture: there was something to refund"
    );
});

test("a run that skipped one chunk and ran another is charged for one", async () => {
    const { user, conversationIds } = await seed(11);
    const { run } = await createRun(user.id, conversationIds);
    assert.ok(run.chunkTotal >= 2, "fixture: more than one chunk");

    const lease = await claimMemoryExtractionRun({ runId: run.id, owner: "worker" });
    assert.ok(lease);
    let charged = 0;
    for (let index = 0; index < run.chunkTotal; index += 1) {
        const chunk = await claimNextExtractionChunk(lease);
        assert.ok(chunk, `fixture: chunk ${index} was claimable`);
        // The first one ran; every other one had nothing left to read.
        const outcome = index === 0 ? ("completed" as const) : ("skipped" as const);
        if (outcome === "completed") charged += 1;
        await completeExtractionChunk(lease, chunk.chunkIndex, { outcome });
    }

    const finished = await prisma.memoryExtractionRun.findUniqueOrThrow({
        where: { id: run.id },
    });
    assert.equal(finished.status, "completed");
    assert.equal(
        finished.chunkCompleted,
        run.chunkTotal,
        "progress counts processed chunks, or the bar never fills"
    );

    const reservation = await reservationFor(run.id);
    assert.equal(reservation.chunksCharged, charged);
    assert.ok(
        reservation.settledCredits < reservation.reservedCredits,
        "the chunks that did not run were refunded"
    );
});

test("a superseded generation cannot record a skip or settle on it", async () => {
    // The fence is the same one a completed report meets, and it has to hold
    // for the new outcome too: a skip settles the run when it is the last
    // chunk, so a stale worker recording one would settle a run it no longer
    // owns.
    const { run, stale, chunk } = await runWithStaleChunk(2);
    await claimMemoryExtractionRun({ runId: run.id, owner: "worker-next" });

    const reported = await completeExtractionChunk(stale, chunk.chunkIndex, {
        outcome: "skipped",
    });
    assert.equal(reported.applied, false);

    const row = await prisma.memoryExtractionChunk.findFirstOrThrow({
        where: { runId: run.id, chunkIndex: chunk.chunkIndex },
    });
    assert.notEqual(row.status, "skipped");
    assert.equal((await reservationFor(run.id)).status, "reserved");
});
