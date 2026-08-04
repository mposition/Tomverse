import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { ApiSecurityError } from "@/lib/apiSecurity";
import { externalContentDigest } from "@/lib/externalImportDigest";
import {
    MEMORY_EXTRACTION_CHUNK_MAX_ATTEMPTS,
    MEMORY_EXTRACTION_CHUNK_MAX_CONVERSATIONS,
    MEMORY_EXTRACTION_LEASE_TTL_MS,
} from "@/lib/memoryExtractionCore";
import { MEMORY_EXTRACTION_FLAG_KEY } from "@/lib/memoryAccess";
import type { MemoryExtractionEvalEntry } from "@/lib/memoryExtractionEvalRegister";
import {
    cancelMemoryExtractionRun,
    claimMemoryExtractionRun,
    claimNextExtractionChunk,
    completeExtractionChunk,
    createMemoryExtractionRun,
    driveMemoryExtractionRunSlice,
    estimateMemoryExtraction,
    getMemoryExtractionRun,
    heartbeatMemoryExtractionRun,
    reconcileExpiredMemoryExtractionRuns,
    type ExtractionChunkHandler,
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
      "MemoryExtractionChunk",
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

const setExtractionFlag = (value: boolean) =>
    prisma.appSetting.upsert({
        where: { key: MEMORY_EXTRACTION_FLAG_KEY },
        create: { key: MEMORY_EXTRACTION_FLAG_KEY, value: String(value) },
        update: { value: String(value) },
    });

const completingHandler: ExtractionChunkHandler = async () => ({
    outcome: "completed",
});

/** Creates a run with `count` chunks and returns it with the flag enabled. */
const seedRun = async (conversationCount: number) => {
    const user = await createUser();
    const conversationIds = await seedConversations(user.id, conversationCount);
    const estimate = await estimateMemoryExtraction(
        baseInput(user.id, conversationIds)
    );
    const run = await createMemoryExtractionRun({
        ...baseInput(user.id, conversationIds),
        confirmedCredits: estimate.estimatedCredits,
    });
    await setExtractionFlag(true);
    return { user, run };
};

test("a run is created with its durable chunk work list (§11)", async () => {
    const { run } = await seedRun(2);
    const chunks = await prisma.memoryExtractionChunk.findMany({
        where: { runId: run.id },
        orderBy: { chunkIndex: "asc" },
    });
    assert.equal(chunks.length, run.chunkTotal);
    assert.deepEqual(
        chunks.map((chunk) => chunk.status),
        chunks.map(() => "pending")
    );
    // The plan is stored, not re-derived later from a differently-ordered read.
    assert.ok(
        chunks.every(
            (chunk) =>
                Array.isArray(chunk.conversationIds) &&
                (chunk.conversationIds as string[]).length > 0
        )
    );
    assert.equal(chunks[0].attemptCount, 0);
});

test("only one claimant wins a run, and the loser gets null (§11 fencing)", async () => {
    const { run } = await seedRun(1);
    const [first, second] = await Promise.all([
        claimMemoryExtractionRun({ runId: run.id, owner: "worker-a" }),
        claimMemoryExtractionRun({ runId: run.id, owner: "worker-b" }),
    ]);
    const winners = [first, second].filter(Boolean);
    assert.equal(winners.length, 1, "exactly one claimant may hold the lease");

    const held = await prisma.memoryExtractionRun.findUniqueOrThrow({
        where: { id: run.id },
    });
    assert.equal(held.status, "running");
    assert.equal(held.leaseGeneration, 1);
    assert.ok(held.leaseExpiresAt);
});

test("a superseded worker cannot heartbeat, claim or complete (§11 fencing)", async () => {
    const { run } = await seedRun(2);
    const stale = await claimMemoryExtractionRun({
        runId: run.id,
        owner: "worker-a",
    });
    assert.ok(stale);

    // The lease lapses and the recovery path takes over, bumping the fence.
    await prisma.memoryExtractionRun.update({
        where: { id: run.id },
        data: {
            leaseExpiresAt: new Date(Date.now() - MEMORY_EXTRACTION_LEASE_TTL_MS),
        },
    });
    const fresh = await claimMemoryExtractionRun({
        runId: run.id,
        owner: "worker-b",
    });
    assert.ok(fresh);
    assert.equal(fresh.leaseGeneration, stale.leaseGeneration + 1);

    // Everything the old worker might do after waking up late fails closed.
    assert.equal(await heartbeatMemoryExtractionRun(stale), false);
    assert.equal(await claimNextExtractionChunk(stale), null);

    // Even a chunk the new worker is holding cannot be reported by the old one.
    const claimed = await claimNextExtractionChunk(fresh);
    assert.ok(claimed);
    const staleReport = await completeExtractionChunk(
        stale,
        claimed.chunkIndex,
        { outcome: "completed" }
    );
    assert.equal(staleReport.applied, false);
    const stillRunning = await prisma.memoryExtractionChunk.findFirstOrThrow({
        where: { runId: run.id, chunkIndex: claimed.chunkIndex },
    });
    assert.equal(stillRunning.status, "running");
});

test("a slice drives the run to completion and derives progress (§11)", async () => {
    const { user, run } = await seedRun(2);
    const seen: number[] = [];
    const result = await driveMemoryExtractionRunSlice({
        runId: run.id,
        owner: "worker-a",
        register: APPROVED_REGISTER,
        handler: async ({ chunk }) => {
            seen.push(chunk.chunkIndex);
            return { outcome: "completed" };
        },
    });
    assert.equal(result.outcome, "completed");
    assert.equal(result.chunksProcessed, run.chunkTotal);
    assert.deepEqual(
        seen,
        Array.from({ length: run.chunkTotal }, (_, index) => index)
    );

    const finished = await getMemoryExtractionRun(user.id, run.id);
    assert.equal(finished.status, "completed");
    assert.equal(finished.chunkCompleted, run.chunkTotal);
    assert.ok(finished.completedAt);
});

test("a slice stops at its chunk budget and hands the lease back (§11)", async () => {
    const { run } = await seedRun(MEMORY_EXTRACTION_CHUNK_MAX_CONVERSATIONS * 2);
    assert.ok(run.chunkTotal > 1, "this test needs a multi-chunk run");

    const result = await driveMemoryExtractionRunSlice({
        runId: run.id,
        owner: "worker-a",
        register: APPROVED_REGISTER,
        maxChunks: 1,
        handler: completingHandler,
    });
    assert.equal(result.outcome, "paused");
    assert.equal(result.reason, "chunk_budget");
    assert.equal(result.chunksProcessed, 1);

    // Parked, not held: the next dispatch continues without waiting for a TTL.
    const parked = await prisma.memoryExtractionRun.findUniqueOrThrow({
        where: { id: run.id },
    });
    assert.equal(parked.status, "pending");
    assert.equal(parked.leaseExpiresAt, null);
    assert.equal(parked.chunkCompleted, 1);

    const resumed = await driveMemoryExtractionRunSlice({
        runId: run.id,
        owner: "worker-b",
        register: APPROVED_REGISTER,
        handler: completingHandler,
    });
    assert.equal(resumed.outcome, "completed");
});

test("an exhausted time budget stops the slice before starting a chunk", async () => {
    const { run } = await seedRun(2);
    const result = await driveMemoryExtractionRunSlice({
        runId: run.id,
        owner: "worker-a",
        register: APPROVED_REGISTER,
        budgetMs: 0,
        handler: async () => {
            assert.fail("no chunk may start once the budget is spent");
        },
    });
    assert.equal(result.outcome, "paused");
    assert.equal(result.reason, "time_budget");
    assert.equal(result.chunksProcessed, 0);
});

test("the rollout flag is re-read at every chunk boundary (§15)", async () => {
    const { run } = await seedRun(1);
    await setExtractionFlag(false);
    const result = await driveMemoryExtractionRunSlice({
        runId: run.id,
        owner: "worker-a",
        register: APPROVED_REGISTER,
        handler: async () => {
            assert.fail("a disabled rollout must not reach a provider");
        },
    });
    assert.equal(result.outcome, "blocked");
    assert.equal(result.reason, "feature_disabled");
    const parked = await prisma.memoryExtractionRun.findUniqueOrThrow({
        where: { id: run.id },
    });
    assert.equal(parked.status, "pending");
});

test("an unapproved pair blocks dispatch without contacting a provider (§12.1)", async () => {
    const { run } = await seedRun(1);
    const result = await driveMemoryExtractionRunSlice({
        runId: run.id,
        owner: "worker-a",
        // No register override: the shipped register has no approved pair.
        handler: async () => {
            assert.fail("an unapproved pair must never reach a provider");
        },
    });
    assert.equal(result.outcome, "blocked");
    assert.equal(result.reason, "pair_unavailable");
});

test("a cancelled run stops its driver at the next boundary (§11)", async () => {
    const { user, run } = await seedRun(MEMORY_EXTRACTION_CHUNK_MAX_CONVERSATIONS * 2);
    assert.ok(run.chunkTotal > 1);

    const result = await driveMemoryExtractionRunSlice({
        runId: run.id,
        owner: "worker-a",
        register: APPROVED_REGISTER,
        handler: async ({ chunk }) => {
            if (chunk.chunkIndex === 0) {
                await cancelMemoryExtractionRun(user.id, run.id);
            }
            return { outcome: "completed" };
        },
    });
    assert.equal(result.outcome, "cancelled");
    // The in-flight chunk's report is refused: the run is no longer running,
    // so its result cannot land after the user cancelled.
    assert.equal(result.chunksProcessed, 1);
    const cancelled = await prisma.memoryExtractionRun.findUniqueOrThrow({
        where: { id: run.id },
    });
    assert.equal(cancelled.status, "cancelled");
});

test("a failing chunk is retried, then fails the run at its cap (§11)", async () => {
    const { run } = await seedRun(1);
    for (let attempt = 1; attempt < MEMORY_EXTRACTION_CHUNK_MAX_ATTEMPTS; attempt += 1) {
        const retryable = await driveMemoryExtractionRunSlice({
            runId: run.id,
            owner: `worker-${attempt}`,
            register: APPROVED_REGISTER,
            handler: async () => ({ outcome: "failed", code: "provider_error" }),
        });
        // The slice ends on a retryable failure rather than looping: retrying
        // in place would spend the whole budget during a provider outage.
        assert.equal(retryable.outcome, "paused");
        assert.equal(retryable.reason, "chunk_failed");
        assert.equal(retryable.chunksProcessed, 1);
        const parked = await prisma.memoryExtractionChunk.findFirstOrThrow({
            where: { runId: run.id, chunkIndex: 0 },
        });
        assert.equal(parked.status, "pending", "below the cap a chunk retries");
        assert.equal(parked.attemptCount, attempt);
    }

    const terminal = await driveMemoryExtractionRunSlice({
        runId: run.id,
        owner: "worker-last",
        register: APPROVED_REGISTER,
        handler: async () => ({ outcome: "failed", code: "provider_error" }),
    });
    assert.equal(terminal.outcome, "failed");
    const failed = await prisma.memoryExtractionRun.findUniqueOrThrow({
        where: { id: run.id },
    });
    assert.equal(failed.status, "failed");
    const chunk = await prisma.memoryExtractionChunk.findFirstOrThrow({
        where: { runId: run.id, chunkIndex: 0 },
    });
    assert.equal(chunk.status, "failed");
    assert.equal(chunk.failureCode, "provider_error");
});

test("a handler that hangs is timed out rather than holding the lease", async () => {
    const { run } = await seedRun(1);
    const result = await driveMemoryExtractionRunSlice({
        runId: run.id,
        owner: "worker-a",
        register: APPROVED_REGISTER,
        maxChunks: 1,
        chunkTimeoutMs: 20,
        handler: () => new Promise(() => {}),
    });
    assert.equal(result.chunksProcessed, 1);
    const chunk = await prisma.memoryExtractionChunk.findFirstOrThrow({
        where: { runId: run.id, chunkIndex: 0 },
    });
    assert.equal(chunk.failureCode, "chunk_timeout");
});

test("a run only one driver can claim is not driven twice concurrently", async () => {
    const { run } = await seedRun(MEMORY_EXTRACTION_CHUNK_MAX_CONVERSATIONS * 2);
    let concurrent = 0;
    let maxConcurrent = 0;
    const handler: ExtractionChunkHandler = async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrent -= 1;
        return { outcome: "completed" };
    };
    const [a, b] = await Promise.all([
        driveMemoryExtractionRunSlice({
            runId: run.id,
            owner: "worker-a",
            register: APPROVED_REGISTER,
            handler,
        }),
        driveMemoryExtractionRunSlice({
            runId: run.id,
            owner: "worker-b",
            register: APPROVED_REGISTER,
            handler,
        }),
    ]);
    assert.equal(maxConcurrent, 1, "two drivers must never overlap on one run");
    assert.ok(
        [a.outcome, b.outcome].includes("not_claimed"),
        "the second driver must lose the claim"
    );
});

test("a chunk orphaned by a dead worker is reclaimed on the next claim (§11)", async () => {
    const { run } = await seedRun(1);
    const dead = await claimMemoryExtractionRun({
        runId: run.id,
        owner: "worker-dead",
    });
    assert.ok(dead);
    const claimed = await claimNextExtractionChunk(dead);
    assert.ok(claimed, "the dead worker took a chunk before dying");

    // The process disappears mid-chunk: the chunk stays `running` under a
    // generation nobody holds, and only pending chunks are claimable.
    await prisma.memoryExtractionRun.update({
        where: { id: run.id },
        data: {
            leaseExpiresAt: new Date(Date.now() - MEMORY_EXTRACTION_LEASE_TTL_MS),
        },
    });

    const revived = await claimMemoryExtractionRun({
        runId: run.id,
        owner: "worker-next",
    });
    assert.ok(revived);
    const reclaimedChunk = await prisma.memoryExtractionChunk.findFirstOrThrow({
        where: { runId: run.id, chunkIndex: claimed.chunkIndex },
    });
    assert.equal(reclaimedChunk.status, "pending");
    assert.equal(reclaimedChunk.leaseGeneration, null);
    // The spent attempt is kept, so a chunk that kills its worker every time
    // still reaches the retry cap instead of looping forever.
    assert.equal(reclaimedChunk.attemptCount, 1);

    // And the work is actually claimable again.
    const retried = await claimNextExtractionChunk(revived);
    assert.ok(retried);
    assert.equal(retried.chunkIndex, claimed.chunkIndex);
    assert.equal(retried.attemptCount, 2);
});

test("an expired lease is reclaimed to pending with progress intact (§3)", async () => {
    const { run } = await seedRun(2);
    const lease = await claimMemoryExtractionRun({
        runId: run.id,
        owner: "worker-a",
    });
    assert.ok(lease);
    await prisma.memoryExtractionRun.update({
        where: { id: run.id },
        data: {
            leaseExpiresAt: new Date(
                Date.now() - MEMORY_EXTRACTION_LEASE_TTL_MS
            ),
        },
    });

    const sweep = await reconcileExpiredMemoryExtractionRuns();
    assert.equal(sweep.reclaimedRuns, 1);
    const reclaimed = await prisma.memoryExtractionRun.findUniqueOrThrow({
        where: { id: run.id },
    });
    assert.equal(reclaimed.status, "pending");
    assert.equal(reclaimed.leaseExpiresAt, null);

    // And the worker whose lease lapsed can no longer write.
    assert.equal(await heartbeatMemoryExtractionRun(lease), false);
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
