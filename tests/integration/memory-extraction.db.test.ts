import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { ApiSecurityError } from "@/lib/apiSecurity";
import { externalContentDigest } from "@/lib/externalImportDigest";
import {
    MEMORY_EXTRACTION_LEASE_TTL_MS,
} from "@/lib/memoryExtractionCore";
import type { MemoryExtractionEvalEntry } from "@/lib/memoryExtractionEvalRegister";
import {
    cancelMemoryExtractionRun,
    completeMemoryExtractionChunk,
    createMemoryExtractionRun,
    estimateMemoryExtraction,
    getMemoryExtractionRun,
    heartbeatMemoryExtractionRun,
    reconcileExpiredMemoryExtractionRuns,
} from "@/lib/memoryExtractionService";
import { prisma } from "@/lib/prisma";

/**
 * Release B slice B2 against a real database: the §3 background-concurrency
 * layer, the §11 confirmation and idempotent-progress contracts, lease
 * reclamation, and the §12.1 fail-closed pair gate. No provider is ever
 * contacted — the register shipped in code has no approved pair, and these
 * tests inject one only to exercise the run lifecycle around it.
 */

const resetData = async () => {
    await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "MemoryExtractionRun",
      "MemoryEvidence",
      "MemoryItem",
      "ExternalMessage",
      "ExternalConversation",
      "ExternalImport",
      "ChatUsageBucket"
    RESTART IDENTITY CASCADE
  `);
};

const createUser = () =>
    prisma.user.create({
        data: { email: `memory-extraction-${randomUUID()}@example.test` },
    });

/** Injected register: the same §12.5 pair, but approved for lifecycle tests. */
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

const seedConversations = async (userId: string, count = 2) => {
    const importRow = await prisma.externalImport.create({
        data: {
            userId,
            provider: "chatgpt",
            status: "completed",
            parserVersion: "test-1",
            digestVersion: 1,
        },
    });
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
        const content = `conversation body ${index}`;
        const conversation = await prisma.externalConversation.create({
            data: {
                userId,
                importId: importRow.id,
                provider: "chatgpt",
                externalStableId: randomUUID().replaceAll("-", ""),
                title: `extraction fixture ${index}`,
                conversationDigest: randomUUID().replaceAll("-", "").repeat(2),
                digestVersion: 1,
                messageCount: 1,
                contentBytes: BigInt(content.length),
                finalized: true,
            },
        });
        await prisma.externalMessage.create({
            data: {
                userId,
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
    return ids;
};

const baseInput = (userId: string, conversationIds: string[]) => ({
    userId,
    extractionModelId: "gpt-5-6-luna",
    promptVersion: "mem-extract-v1",
    plan: "Free" as const,
    selectedConversationIds: conversationIds,
    register: APPROVED_REGISTER,
});

const expectCode = (code: string) => (error: unknown) =>
    error instanceof ApiSecurityError && error.code === code;

beforeEach(resetData);

after(async () => {
    await resetData();
    await prisma.$disconnect();
});

test("the shipped register blocks run creation fail-closed (§12.1)", async () => {
    const user = await createUser();
    const conversationIds = await seedConversations(user.id);
    await assert.rejects(
        createMemoryExtractionRun({
            ...baseInput(user.id, conversationIds),
            register: undefined, // the real code register: candidates only
            confirmedCredits: 1,
        }),
        expectCode("MEMORY_EXTRACTION_PAIR_UNAVAILABLE")
    );
});

test("estimate → confirm → create, with one active run per user (§3, §11)", async () => {
    const user = await createUser();
    const conversationIds = await seedConversations(user.id);

    const estimate = await estimateMemoryExtraction(
        baseInput(user.id, conversationIds)
    );
    assert.equal(estimate.conversationCount, 2);
    assert.ok(estimate.chunkCount >= 1);
    assert.ok(estimate.estimatedCredits >= estimate.chunkCount);

    // A confirmation that no longer matches the live estimate re-asks.
    await assert.rejects(
        createMemoryExtractionRun({
            ...baseInput(user.id, conversationIds),
            confirmedCredits: estimate.estimatedCredits + 1,
        }),
        expectCode("MEMORY_ESTIMATE_CHANGED")
    );

    const run = await createMemoryExtractionRun({
        ...baseInput(user.id, conversationIds),
        confirmedCredits: estimate.estimatedCredits,
    });
    assert.equal(run.status, "pending");
    assert.equal(run.chunkTotal, estimate.chunkCount);

    await assert.rejects(
        createMemoryExtractionRun({
            ...baseInput(user.id, conversationIds),
            confirmedCredits: estimate.estimatedCredits,
        }),
        expectCode("MEMORY_EXTRACTION_ALREADY_RUNNING")
    );

    // Cross-user probes read as not-found.
    const stranger = await createUser();
    await assert.rejects(
        getMemoryExtractionRun(stranger.id, run.id),
        expectCode("NOT_FOUND")
    );
});

test("selection must be the owner's finalized conversations", async () => {
    const user = await createUser();
    const other = await createUser();
    const otherConversations = await seedConversations(other.id, 1);
    await assert.rejects(
        estimateMemoryExtraction(baseInput(user.id, otherConversations)),
        expectCode("NOT_FOUND")
    );
});

test("heartbeat claims the lease and chunk completion is idempotent (§11)", async () => {
    const user = await createUser();
    const conversationIds = await seedConversations(user.id, 2);
    const estimate = await estimateMemoryExtraction(
        baseInput(user.id, conversationIds)
    );
    const run = await createMemoryExtractionRun({
        ...baseInput(user.id, conversationIds),
        confirmedCredits: estimate.estimatedCredits,
    });

    await heartbeatMemoryExtractionRun(user.id, run.id);
    const running = await prisma.memoryExtractionRun.findUniqueOrThrow({
        where: { id: run.id },
    });
    assert.equal(running.status, "running");
    assert.ok(running.leaseExpiresAt);

    // Complete chunk 0 twice: the replay is a no-op, not a double count.
    assert.deepEqual(
        await completeMemoryExtractionChunk(user.id, run.id, 0),
        { advanced: true }
    );
    assert.deepEqual(
        await completeMemoryExtractionChunk(user.id, run.id, 0),
        { advanced: false }
    );

    for (let chunk = 1; chunk < run.chunkTotal; chunk += 1) {
        await completeMemoryExtractionChunk(user.id, run.id, chunk);
    }
    const completed = await getMemoryExtractionRun(user.id, run.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.chunkCompleted, run.chunkTotal);
    assert.ok(completed.completedAt);
});

test("an expired lease is reclaimed to pending with progress intact (§3)", async () => {
    const user = await createUser();
    const conversationIds = await seedConversations(user.id, 2);
    const estimate = await estimateMemoryExtraction(
        baseInput(user.id, conversationIds)
    );
    const run = await createMemoryExtractionRun({
        ...baseInput(user.id, conversationIds),
        confirmedCredits: estimate.estimatedCredits,
    });
    await heartbeatMemoryExtractionRun(user.id, run.id);
    await prisma.memoryExtractionRun.update({
        where: { id: run.id },
        data: {
            leaseExpiresAt: new Date(
                Date.now() - MEMORY_EXTRACTION_LEASE_TTL_MS
            ),
        },
    });

    // A heartbeat against a dead lease reports the §18 410, not a claim.
    await assert.rejects(
        heartbeatMemoryExtractionRun(user.id, run.id),
        expectCode("MEMORY_EXTRACTION_LEASE_EXPIRED")
    );

    const sweep = await reconcileExpiredMemoryExtractionRuns();
    assert.equal(sweep.reclaimedRuns, 1);
    const reclaimed = await prisma.memoryExtractionRun.findUniqueOrThrow({
        where: { id: run.id },
    });
    assert.equal(reclaimed.status, "pending");
    assert.equal(reclaimed.leaseExpiresAt, null);
});

test("cancel is a deterministic, idempotent release (§11)", async () => {
    const user = await createUser();
    const conversationIds = await seedConversations(user.id, 1);
    const estimate = await estimateMemoryExtraction(
        baseInput(user.id, conversationIds)
    );
    const run = await createMemoryExtractionRun({
        ...baseInput(user.id, conversationIds),
        confirmedCredits: estimate.estimatedCredits,
    });

    assert.deepEqual(await cancelMemoryExtractionRun(user.id, run.id), {
        outcome: "cancelled",
    });
    assert.deepEqual(await cancelMemoryExtractionRun(user.id, run.id), {
        outcome: "cancelled",
    });

    // A cancelled run frees the per-user slot.
    const next = await createMemoryExtractionRun({
        ...baseInput(user.id, conversationIds),
        confirmedCredits: estimate.estimatedCredits,
    });
    assert.notEqual(next.id, run.id);
});

test("the batch sub-budget refuses with the dedicated 503 semantics (§3)", async () => {
    const user = await createUser();
    const conversationIds = await seedConversations(user.id, 1);
    const estimate = await estimateMemoryExtraction(
        baseInput(user.id, conversationIds)
    );
    await assert.rejects(
        createMemoryExtractionRun({
            ...baseInput(user.id, conversationIds),
            confirmedCredits: estimate.estimatedCredits,
            environment: {
                ...process.env,
                MEMORY_EXTRACTION_PROVIDER_OPENAI_COST_MICROUSD_PER_DAY: "10",
            },
        }),
        (error: unknown) =>
            error instanceof ApiSecurityError &&
            error.code === "MEMORY_EXTRACTION_PROVIDER_BUDGET_EXHAUSTED" &&
            error.status === 503 &&
            typeof error.retryAfter === "number" &&
            error.retryAfter > 0
    );
});
