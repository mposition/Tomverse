import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { externalContentDigest } from "@/lib/externalImportDigest";
import { MEMORY_EXTRACTION_FLAG_KEY } from "@/lib/memoryAccess";
import { memoryExtractionChunkHandler } from "@/lib/memoryExtractionChunkHandler";
import {
    dispatchPendingMemoryExtractionRuns,
    kickMemoryExtractionRun,
} from "@/lib/memoryExtractionDispatch";
import type { MemoryExtractionEvalEntry } from "@/lib/memoryExtractionEvalRegister";
import type { ExtractionModelAdapter } from "@/lib/memoryExtractionPipeline";
import {
    createMemoryExtractionRun,
    estimateMemoryExtraction,
    getMemoryExtractionRun,
} from "@/lib/memoryExtractionService";
import { prisma } from "@/lib/prisma";

/**
 * §11.1's two drivers, end to end, against a real database.
 *
 * Before this existed the pipeline was complete and inert: the slice processor
 * had no production caller, the maintenance sweep reclaimed expired leases but
 * never re-drove what it reclaimed, and a created run therefore sat in
 * `pending` forever. These tests are the proof that a run now finishes, that
 * it finishes only once, and that what it produces is stored and settled.
 *
 * No provider is contacted. The adapter is injected, which is also the point
 * of the seam: the handler's contract is "ask the recorded pair and store what
 * comes back", and every failure mode below is about what happens around that
 * call rather than inside it.
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

const setExtractionFlag = (value: boolean) =>
    prisma.appSetting.upsert({
        where: { key: MEMORY_EXTRACTION_FLAG_KEY },
        create: { key: MEMORY_EXTRACTION_FLAG_KEY, value: String(value) },
        update: { value: String(value) },
    });

beforeEach(async () => {
    await resetData();
    await setExtractionFlag(true);
});
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
        data: { email: `dispatch-${randomUUID()}@example.test` },
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
        const content = `the user prefers formal Korean ${index}`;
        const conversation = await prisma.externalConversation.create({
            data: {
                userId: user.id,
                importId: importRow.id,
                provider: "chatgpt",
                externalStableId: randomUUID().replaceAll("-", ""),
                title: `dispatch fixture ${index}`,
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

const createRun = async (userId: string, conversationIds: string[]) => {
    const base = {
        userId,
        extractionModelId: "gpt-5-6-luna",
        promptVersion: "mem-extract-v1",
        plan: "Pro" as const,
        selectedConversationIds: conversationIds,
        register: APPROVED_REGISTER,
    };
    const estimate = await estimateMemoryExtraction(base);
    const run = await createMemoryExtractionRun({
        ...base,
        confirmedCredits: estimate.estimatedCredits,
    });
    return { run, estimate };
};

/** Answers with one citable candidate per prompt, in the agreed JSON shape. */
const answeringAdapter =
    (calls: { count: number }): ExtractionModelAdapter =>
    async ({ prompt }) => {
        calls.count += 1;
        const label = prompt.allowedMessageLabels[0];
        return {
            text: JSON.stringify({
                candidates: [
                    {
                        kind: "preference",
                        statement: `the user prefers formal Korean (${calls.count})`,
                        confidence: 0.9,
                        sensitivity: "standard",
                        expiresAt: null,
                        evidence: [label],
                    },
                ],
            }),
        };
    };

const handlerWith = (adapter: ExtractionModelAdapter) =>
    memoryExtractionChunkHandler({ adapterFor: () => adapter });

/**
 * The shipped register has no approved pair -- §12.4 keeps extraction closed
 * until one passes eval -- so the boundary re-check would block every dispatch.
 * These tests inject an approved pair for the same reason the B2 suite does:
 * what is under test is the run lifecycle around the gate, not the gate.
 */
const driving = (adapter: ExtractionModelAdapter) => ({
    handler: handlerWith(adapter),
    register: APPROVED_REGISTER,
});

test("the post-response kick drives a created run to completion (§11.1)", async () => {
    const { user, conversationIds } = await seed();
    const { run } = await createRun(user.id, conversationIds);
    assert.equal(run.status, "pending");

    const calls = { count: 0 };
    await kickMemoryExtractionRun(run.id, {
        ...driving(answeringAdapter(calls)),
    });

    const finished = await getMemoryExtractionRun(user.id, run.id);
    assert.equal(finished.status, "completed");
    assert.equal(finished.chunkCompleted, run.chunkTotal);
    assert.equal(calls.count, run.chunkTotal);

    // The candidates the model proposed are stored, awaiting a human (§8.1).
    const items = await prisma.memoryItem.findMany({ where: { userId: user.id } });
    assert.ok(items.length > 0);
    assert.ok(items.every((item) => item.status === "candidate"));
    assert.ok(items.every((item) => item.approvedAt === null));
    assert.ok(items.every((item) => item.extractionRunId === run.id));
});

test("a completed run settles its reservation for every chunk it ran", async () => {
    const { user, conversationIds } = await seed();
    const { run } = await createRun(user.id, conversationIds);
    await kickMemoryExtractionRun(run.id, {
        ...driving(answeringAdapter({ count: 0 })),
    });

    const reservation = await prisma.memoryExtractionCreditReservation.findUniqueOrThrow(
        { where: { runId: run.id } }
    );
    assert.equal(reservation.status, "settled");
    assert.equal(reservation.outcome, "completed");
    assert.equal(reservation.chunksCharged, reservation.chunkTotal);
    assert.equal(reservation.settledCredits, reservation.reservedCredits);
    // Nothing was refunded: every chunk really did call the provider.
    assert.equal(reservation.refundedAt, null);
});

test("the maintenance sweep re-drives what it reclaims, not just reclaims it (§11.1)", async () => {
    // The exact gap §11.1 names: a reclaimed run goes back to `pending`, and a
    // sweep that only reclaims leaves it there forever unless a request
    // happens to arrive.
    const { user, conversationIds } = await seed();
    const { run } = await createRun(user.id, conversationIds);

    // Simulate a worker that claimed the run and died: running, lease expired.
    await prisma.memoryExtractionRun.update({
        where: { id: run.id },
        data: {
            status: "running",
            leaseGeneration: 1,
            leaseOwner: "dead-worker",
            leaseExpiresAt: new Date(Date.now() - 60_000),
        },
    });

    const result = await dispatchPendingMemoryExtractionRuns({
        ...driving(answeringAdapter({ count: 0 })),
    });
    assert.equal(result.reclaimedRuns, 1);
    assert.equal(result.dispatched, 1);

    const finished = await getMemoryExtractionRun(user.id, run.id);
    assert.equal(finished.status, "completed");
});

test("a chunk a dead worker left running is re-run, not stranded", async () => {
    const { user, conversationIds } = await seed();
    const { run } = await createRun(user.id, conversationIds);
    await prisma.memoryExtractionRun.update({
        where: { id: run.id },
        data: {
            status: "running",
            leaseGeneration: 1,
            leaseOwner: "dead-worker",
            leaseExpiresAt: new Date(Date.now() - 60_000),
        },
    });
    // Its first chunk was claimed and never reported.
    await prisma.memoryExtractionChunk.updateMany({
        where: { runId: run.id, chunkIndex: 0 },
        data: { status: "running", leaseGeneration: 1, attemptCount: 1 },
    });

    await dispatchPendingMemoryExtractionRuns({
        ...driving(answeringAdapter({ count: 0 })),
    });

    const finished = await getMemoryExtractionRun(user.id, run.id);
    assert.equal(finished.status, "completed");
    const chunks = await prisma.memoryExtractionChunk.findMany({
        where: { runId: run.id },
    });
    assert.ok(chunks.every((chunk) => chunk.status === "completed"));
    // The spent attempt is not rolled back: a chunk that keeps killing its
    // worker has to reach the retry cap rather than retry forever.
    const first = chunks.find((chunk) => chunk.chunkIndex === 0);
    assert.ok(first && first.attemptCount >= 2);
});

test("a re-driven chunk replaces its own candidates rather than duplicating them", async () => {
    const { user, conversationIds } = await seed(1);
    const { run } = await createRun(user.id, conversationIds);
    await kickMemoryExtractionRun(run.id, {
        ...driving(answeringAdapter({ count: 0 })),
    });
    const afterFirst = await prisma.memoryItem.count({ where: { userId: user.id } });
    assert.ok(afterFirst > 0);

    // Re-open the run and drive it again, the way a reclaimed orphan would be.
    await prisma.memoryExtractionRun.update({
        where: { id: run.id },
        data: { status: "pending", completedAt: null, chunkCompleted: 0 },
    });
    await prisma.memoryExtractionChunk.updateMany({
        where: { runId: run.id },
        data: { status: "pending", leaseGeneration: null, completedAt: null },
    });
    await kickMemoryExtractionRun(run.id, {
        ...driving(answeringAdapter({ count: 0 })),
    });

    assert.equal(
        await prisma.memoryItem.count({ where: { userId: user.id } }),
        afterFirst
    );
});

test("a completed run is not dispatched again by the sweep", async () => {
    const { user, conversationIds } = await seed();
    const { run } = await createRun(user.id, conversationIds);
    await kickMemoryExtractionRun(run.id, {
        ...driving(answeringAdapter({ count: 0 })),
    });

    const calls = { count: 0 };
    const result = await dispatchPendingMemoryExtractionRuns({
        ...driving(answeringAdapter(calls)),
    });
    assert.equal(result.dispatched, 0);
    assert.equal(calls.count, 0);

    // And the settlement was not disturbed.
    const reservation = await prisma.memoryExtractionCreditReservation.findUniqueOrThrow(
        { where: { runId: run.id } }
    );
    assert.equal(reservation.status, "settled");
    assert.equal(reservation.settledCredits, reservation.reservedCredits);
});

test("a provider that keeps failing exhausts the retry budget and fails the run", async () => {
    const { user, conversationIds } = await seed(1);
    const { run } = await createRun(user.id, conversationIds);

    const failing: ExtractionModelAdapter = async () => {
        throw new Error("provider exploded");
    };
    // Drive repeatedly the way successive maintenance passes would.
    for (let pass = 0; pass < 6; pass += 1) {
        const state = await prisma.memoryExtractionRun.findUniqueOrThrow({
            where: { id: run.id },
        });
        if (state.status === "failed") break;
        await kickMemoryExtractionRun(run.id, driving(failing));
    }

    const finished = await getMemoryExtractionRun(user.id, run.id);
    assert.equal(finished.status, "failed");

    // A failed run charges only the chunks that completed -- here, none.
    const reservation = await prisma.memoryExtractionCreditReservation.findUniqueOrThrow(
        { where: { runId: run.id } }
    );
    assert.equal(reservation.status, "settled");
    assert.equal(reservation.outcome, "failed");
    assert.equal(reservation.chunksCharged, 0);
    assert.equal(reservation.settledCredits, 0);
    assert.ok(reservation.refundedAt);

    // Nothing was stored from a run that never got an answer.
    assert.equal(await prisma.memoryItem.count({ where: { userId: user.id } }), 0);
});

test("the sweep is bounded so one slow provider cannot hold up maintenance", async () => {
    const runs: string[] = [];
    for (let index = 0; index < 4; index += 1) {
        const { user, conversationIds } = await seed(1);
        const { run } = await createRun(user.id, conversationIds);
        runs.push(run.id);
    }

    const result = await dispatchPendingMemoryExtractionRuns({
        maxRuns: 2,
        ...driving(answeringAdapter({ count: 0 })),
    });
    assert.equal(result.dispatched, 2);

    // The rest are untouched and still durable, for the next pass.
    const stillPending = await prisma.memoryExtractionRun.count({
        where: { id: { in: runs }, status: "pending" },
    });
    assert.equal(stillPending, 2);
});

test("the pass stops at its wall-clock ceiling, not only its run cap (§11.1)", async () => {
    // A run count is not a time bound. One slice may take
    // MEMORY_EXTRACTION_SLICE_BUDGET_MS, so three runs back to back is minutes
    // inside a request that also reconciles credits, drains notifications and
    // sweeps refunds -- exactly what §11.1 says extraction must not delay.
    const runs: string[] = [];
    for (let index = 0; index < 3; index += 1) {
        const { user, conversationIds } = await seed(1);
        const { run } = await createRun(user.id, conversationIds);
        runs.push(run.id);
    }

    const slow: ExtractionModelAdapter = async ({ prompt }) => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return {
            text: JSON.stringify({
                candidates: [
                    {
                        kind: "preference",
                        statement: "the user prefers formal Korean",
                        confidence: 0.9,
                        sensitivity: "standard",
                        expiresAt: null,
                        evidence: [prompt.allowedMessageLabels[0]],
                    },
                ],
            }),
        };
    };

    // A ceiling below one chunk's timeout: the first run may start (the floor
    // guarantees at least one gets a fair slice) and the rest are deferred
    // rather than run past the deadline.
    const result = await dispatchPendingMemoryExtractionRuns({
        ...driving(slow),
        budgetMs: 1,
    });
    assert.ok(result.dispatched >= 1, "at least one run gets a real slice");
    assert.ok(result.dispatched < 3, "the pass stopped before draining the queue");
    assert.equal(result.skippedForTime, 3 - result.dispatched);

    // Deferred, not lost. All three are still `pending`: the two the pass had
    // no time to reach, and the one it started -- a slice that runs out of
    // budget before its first chunk hands the lease back and parks the run,
    // which is the whole point of the budget being checked before claiming
    // rather than after.
    const stillPending = await prisma.memoryExtractionRun.count({
        where: { id: { in: runs }, status: "pending" },
    });
    assert.equal(stillPending, 3);
    assert.equal(
        await prisma.memoryExtractionRun.count({
            where: { id: { in: runs }, leaseExpiresAt: { not: null } },
        }),
        0,
        "a parked run holds no lease"
    );
});

test("a deferred run is picked up by the next pass", async () => {
    const runs: string[] = [];
    for (let index = 0; index < 2; index += 1) {
        const { user, conversationIds } = await seed(1);
        const { run } = await createRun(user.id, conversationIds);
        runs.push(run.id);
    }

    const first = await dispatchPendingMemoryExtractionRuns({
        ...driving(answeringAdapter({ count: 0 })),
        maxRuns: 1,
    });
    assert.equal(first.dispatched, 1);

    const second = await dispatchPendingMemoryExtractionRuns({
        ...driving(answeringAdapter({ count: 0 })),
    });
    assert.equal(second.dispatched, 1);

    const completed = await prisma.memoryExtractionRun.count({
        where: { id: { in: runs }, status: "completed" },
    });
    assert.equal(completed, 2);
});
