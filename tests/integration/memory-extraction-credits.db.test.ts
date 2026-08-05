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
import {
    cancelMemoryExtractionRun,
    createMemoryExtractionRun,
    estimateMemoryExtraction,
} from "@/lib/memoryExtractionService";
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
