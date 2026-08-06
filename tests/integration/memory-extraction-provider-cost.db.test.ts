import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import {
    admitExtractionProviderCall,
    markExtractionProviderCallIssued,
    reconcileUnsettledExtractionProviderCalls,
    releaseUnusedExtractionProviderCall,
    settleExtractionProviderCall,
} from "@/lib/memoryExtractionProviderCost";
import { getProviderCostBudget } from "@/lib/providerCostBudget";
import { prisma } from "@/lib/prisma";

/**
 * Operational provider-cost accounting (policy §3, §11).
 *
 * The property under test is the one that separates this layer from the run's
 * user credits: **a request that went out is never refunded to the provider
 * budget.** User credits refund a failed chunk, because the user did not get
 * it. The provider may still have billed for it, and erasing that would let a
 * run that keeps failing consume an unbounded share of a budget that reads as
 * untouched.
 */

// Configured well above the single-account floor: a provider budget below one
// account's own plan guardrail is deliberately raised to it
// (lib/providerCostBudget.ts), so a small number here would silently become a
// large one and the ceiling assertions below would test nothing.
const ENV = {
    CHAT_PROVIDER_OPENAI_COST_MICROUSD_PER_DAY: "100000000",
    CHAT_PROVIDER_OPENAI_COST_MICROUSD_PER_MONTH: "1000000000",
    // 100%, so the sub-budget does not mask a provider-total assertion.
    MEMORY_EXTRACTION_PROVIDER_OPENAI_MAX_PERCENT_PER_DAY: "100",
    MEMORY_EXTRACTION_PROVIDER_OPENAI_MAX_PERCENT_PER_MONTH: "100",
} as Record<string, string | undefined>;

const NOW = new Date("2026-08-05T12:00:00.000Z");

const resetData = async () => {
    await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "MemoryExtractionProviderCall",
      "MemoryExtractionChunk",
      "MemoryExtractionRun",
      "ChatUsageBucket"
    RESTART IDENTITY CASCADE
  `);
};

const seedChunk = async () => {
    const user = await prisma.user.create({
        data: { email: `extraction-cost-${randomUUID()}@example.test` },
    });
    const run = await prisma.memoryExtractionRun.create({
        data: {
            userId: user.id,
            status: "running",
            extractionModelId: "gpt-5-6-luna",
            promptVersion: "mem-extract-v1",
            sourceSelection: [],
            chunkTotal: 1,
        },
    });
    const chunk = await prisma.memoryExtractionChunk.create({
        data: { runId: run.id, chunkIndex: 0, conversationIds: [] },
    });
    return { userId: user.id, runId: run.id, chunkId: chunk.id };
};

const bucket = async (key: string, period: string) => {
    const row = await prisma.chatUsageBucket.findFirst({
        where: { key, period },
        select: { count: true },
    });
    return Number(row?.count ?? 0);
};

const providerDay = () => bucket("provider:openai", "provider-cost-day");
const batchDay = () =>
    bucket("memory-extraction-provider:openai", "provider-cost-day");

const admit = (chunkId: string, cost: number, attemptCount = 1) =>
    admitExtractionProviderCall({
        chunkId,
        attemptCount,
        provider: "openai",
        modelId: "gpt-5-6-luna",
        estimatedCostMicroUsd: cost,
        now: NOW,
        environment: ENV,
    });

beforeEach(resetData);
after(async () => {
    await resetData();
    await prisma.$disconnect();
});

test("admission consumes the provider total and the extraction sub-budget", async () => {
    const { chunkId } = await seedChunk();
    const result = await admit(chunkId, 5_000);
    assert.equal(result.admitted, true);
    // Both ceilings, always: extraction spends its own share of the provider's
    // budget and never borrows the interactive one (§3).
    assert.equal(await providerDay(), 5_000);
    assert.equal(await batchDay(), 5_000);
});

test("a failure before the call gives the whole reservation back", async () => {
    const { chunkId } = await seedChunk();
    const admitted = await admit(chunkId, 5_000);
    assert.ok(admitted.admitted);

    const released = await releaseUnusedExtractionProviderCall({
        providerCallId: admitted.providerCallId,
        failureCode: "pair_unavailable",
        now: NOW,
    });
    assert.equal(released.released, true);
    assert.equal(await providerDay(), 0);
    assert.equal(await batchDay(), 0);
});

test("a request that went out is never released, even when it failed", async () => {
    const { chunkId } = await seedChunk();
    const admitted = await admit(chunkId, 5_000);
    assert.ok(admitted.admitted);
    await markExtractionProviderCallIssued(admitted.providerCallId);

    // This is the whole point of the layer. The user's credits refund a failed
    // chunk; the provider budget cannot, because the provider may have billed.
    const released = await releaseUnusedExtractionProviderCall({
        providerCallId: admitted.providerCallId,
        failureCode: "provider_error",
        now: NOW,
    });
    assert.equal(released.released, false);
    assert.equal(await providerDay(), 5_000);
});

test("a call with no reported usage stays charged at its reservation", async () => {
    const { chunkId } = await seedChunk();
    const admitted = await admit(chunkId, 5_000);
    assert.ok(admitted.admitted);
    await markExtractionProviderCallIssued(admitted.providerCallId);

    await settleExtractionProviderCall({
        providerCallId: admitted.providerCallId,
        usage: { usageFromProvider: false },
        failureCode: "provider_error",
        now: NOW,
    });
    // Settling an issued call as free would understate the guardrail, and the
    // conservative direction is the only safe one when the truth is unknown.
    assert.equal(await providerDay(), 5_000);
    const row = await prisma.memoryExtractionProviderCall.findUniqueOrThrow({
        where: { id: admitted.providerCallId },
    });
    assert.equal(Number(row.settledCostMicroUsd), 5_000);
    assert.equal(row.usageConfirmed, false);
});

test("confirmed usage settles the budget to what was actually spent", async () => {
    const { chunkId } = await seedChunk();
    const admitted = await admit(chunkId, 5_000);
    assert.ok(admitted.admitted);
    await markExtractionProviderCallIssued(admitted.providerCallId);

    await settleExtractionProviderCall({
        providerCallId: admitted.providerCallId,
        usage: {
            usageFromProvider: true,
            actualCostMicroUsd: 1_800,
            inputTokens: 900,
            outputTokens: 120,
            responseId: "resp-1",
        },
        now: NOW,
    });
    assert.equal(await providerDay(), 1_800);
    assert.equal(await batchDay(), 1_800);
});

test("a call that cost more than reserved is recorded, not refused", async () => {
    const { chunkId } = await seedChunk();
    const admitted = await admit(chunkId, 1_000);
    assert.ok(admitted.admitted);
    await markExtractionProviderCallIssued(admitted.providerCallId);

    await settleExtractionProviderCall({
        providerCallId: admitted.providerCallId,
        usage: { usageFromProvider: true, actualCostMicroUsd: 4_000 },
        now: NOW,
    });
    // The call already happened, so the budget records what it cost. The
    // ceiling stops the NEXT admission, which is the only place refusing still
    // prevents anything.
    assert.equal(await providerDay(), 4_000);
});

test("settlement is idempotent, so a replay cannot move the budget twice", async () => {
    const { chunkId } = await seedChunk();
    const admitted = await admit(chunkId, 5_000);
    assert.ok(admitted.admitted);
    await markExtractionProviderCallIssued(admitted.providerCallId);

    const settle = () =>
        settleExtractionProviderCall({
            providerCallId: admitted.providerCallId,
            usage: { usageFromProvider: true, actualCostMicroUsd: 2_000 },
            now: NOW,
        });
    assert.equal((await settle()).settled, true);
    assert.equal((await settle()).settled, false);
    assert.equal(await providerDay(), 2_000);
});

test("an exhausted provider total admits nothing and leaves no trace", async () => {
    const { chunkId } = await seedChunk();
    // Derived from the effective budget rather than hardcoded, so the floor
    // above cannot quietly turn "over the limit" into "well within it".
    const effective = getProviderCostBudget("openai", ENV);
    const result = await admit(chunkId, effective.day + 1);
    assert.equal(result.admitted, false);
    assert.equal(
        result.admitted === false ? result.scope : null,
        "provider_cost_day"
    );
    assert.equal(await providerDay(), 0);
    assert.equal(await prisma.memoryExtractionProviderCall.count(), 0);
});

test("a sub-budget refusal gives the provider total back too", async () => {
    const { chunkId } = await seedChunk();
    // 10% of the day budget, so a cost above it clears the provider total but
    // not extraction's own share.
    const effective = getProviderCostBudget("openai", ENV);
    const result = await admitExtractionProviderCall({
        chunkId,
        attemptCount: 1,
        provider: "openai",
        modelId: "gpt-5-6-luna",
        // Inside the provider total, outside extraction's 10% share of it.
        estimatedCostMicroUsd: Math.floor(effective.day / 2),
        now: NOW,
        environment: {
            ...ENV,
            MEMORY_EXTRACTION_PROVIDER_OPENAI_MAX_PERCENT_PER_DAY: "10",
            MEMORY_EXTRACTION_PROVIDER_OPENAI_MAX_PERCENT_PER_MONTH: "10",
        },
    });
    assert.equal(result.admitted, false);
    assert.equal(
        result.admitted === false ? result.scope : null,
        "extraction_sub_budget_day"
    );
    // One transaction, so failing the second ceiling released the first.
    assert.equal(await providerDay(), 0);
});

test("the same attempt cannot consume the budget twice (§11 identity)", async () => {
    const { chunkId } = await seedChunk();
    assert.ok((await admit(chunkId, 5_000, 1)).admitted);
    // A replayed attempt collides on (chunk, attemptCount).
    await assert.rejects(admit(chunkId, 5_000, 1));
    assert.equal(await providerDay(), 5_000);

    // A genuine retry is a new attempt number and reserves again.
    assert.ok((await admit(chunkId, 5_000, 2)).admitted);
    assert.equal(await providerDay(), 10_000);
});

test("reconciliation settles a call whose worker died mid-flight", async () => {
    const { chunkId } = await seedChunk();
    const admitted = await admit(chunkId, 5_000);
    assert.ok(admitted.admitted);
    await markExtractionProviderCallIssued(admitted.providerCallId);

    // Nothing settled it; without the sweep the budget stays understated for
    // as long as nobody looks.
    const swept = await reconcileUnsettledExtractionProviderCalls({
        now: new Date(NOW.getTime() + 60 * 60_000),
    });
    assert.equal(swept.settled, 1);
    assert.equal(await providerDay(), 5_000);
    const row = await prisma.memoryExtractionProviderCall.findUniqueOrThrow({
        where: { id: admitted.providerCallId },
    });
    assert.equal(row.failureCode, "reconciled_unsettled");

    // Idempotent.
    assert.equal(
        (
            await reconcileUnsettledExtractionProviderCalls({
                now: new Date(NOW.getTime() + 60 * 60_000),
            })
        ).settled,
        0
    );
});

test("reconciliation leaves an unissued reservation alone", async () => {
    const { chunkId } = await seedChunk();
    const admitted = await admit(chunkId, 5_000);
    assert.ok(admitted.admitted);
    // Never issued: this is the release path's business, not the sweep's.
    const swept = await reconcileUnsettledExtractionProviderCalls({
        now: new Date(NOW.getTime() + 60 * 60_000),
    });
    assert.equal(swept.settled, 0);
});
