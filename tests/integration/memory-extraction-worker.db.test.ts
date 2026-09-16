import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { externalContentDigest } from "@/lib/externalImportDigest";
import { MEMORY_EXTRACTION_FLAG_KEY } from "@/lib/memoryAccess";
import type { MemoryExtractionEvalEntry } from "@/lib/memoryExtractionEvalRegister";
import { MEMORY_EXTRACTION_LEASE_TTL_MS } from "@/lib/memoryExtractionCore";
import {
    claimMemoryExtractionRun,
    claimNextExtractionChunk,
    createMemoryExtractionRun,
    estimateMemoryExtraction,
} from "@/lib/memoryExtractionService";
import {
    dispatchPendingMemoryExtractionRuns,
    handleMemoryExtractionChunk,
    type ExtractionAdapterFactory,
} from "@/lib/memoryExtractionWorker";
import { prisma } from "@/lib/prisma";

/**
 * The production chunk handler and the two §11.1 drivers, against a real
 * database.
 *
 * No provider is contacted: the adapter is injected, which is the reason the
 * seam exists. What is under test is everything around the call — which
 * conversations a chunk reads, what a broken answer does, what reaches the
 * database, and whether the fifteen-minute dispatcher actually restarts a run
 * rather than only reclaiming its lease.
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
      "ChatUsageBucket",
      "User"
    RESTART IDENTITY CASCADE
  `);
};

beforeEach(resetData);
after(async () => {
    await resetData();
    await prisma.$disconnect();
});

/** The §12.5 pair, approved here so the lifecycle can be exercised at all. */
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
                    ["ko", "en"].map((language) => [`${category}:${language}`, 200])
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

const createUser = () =>
    prisma.user.create({
        data: { email: `extraction-worker-${randomUUID()}@example.test` },
    });

const MESSAGE_BODY = "I always want answers in formal Korean.";

const seedConversations = async (userId: string, count = 1) => {
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
        const conversation = await prisma.externalConversation.create({
            data: {
                userId,
                importId: importRow.id,
                provider: "chatgpt",
                externalStableId: randomUUID().replaceAll("-", ""),
                title: `worker fixture ${index}`,
                conversationDigest: randomUUID().replaceAll("-", "").repeat(2),
                digestVersion: 1,
                messageCount: 1,
                contentBytes: BigInt(MESSAGE_BODY.length),
                finalized: true,
            },
        });
        await prisma.externalMessage.create({
            data: {
                userId,
                externalConversationId: conversation.id,
                externalStableId: randomUUID().replaceAll("-", ""),
                role: "user",
                content: MESSAGE_BODY,
                contentDigest: externalContentDigest(MESSAGE_BODY),
                digestVersion: 1,
                ordinal: 0,
            },
        });
        ids.push(conversation.id);
    }
    return ids;
};

const setExtractionFlag = (value: boolean) =>
    prisma.appSetting.upsert({
        where: { key: MEMORY_EXTRACTION_FLAG_KEY },
        create: { key: MEMORY_EXTRACTION_FLAG_KEY, value: String(value) },
        update: { value: String(value) },
    });

const seedRun = async (conversationCount = 1) => {
    const user = await createUser();
    const conversationIds = await seedConversations(user.id, conversationCount);
    const input = {
        userId: user.id,
        extractionModelId: "gpt-5-6-luna",
        promptVersion: "mem-extract-v1",
        plan: "Free" as const,
        selectedConversationIds: conversationIds,
        register: APPROVED_REGISTER,
    };
    const estimate = await estimateMemoryExtraction(input);
    const run = await createMemoryExtractionRun({
        ...input,
        confirmedCredits: estimate.estimatedCredits,
    });
    await setExtractionFlag(true);
    return { user, run, conversationIds };
};

/**
 * An adapter answering in the schema the prompt asks for, citing `m1` -- the
 * first message label, which the prompt assigns by position starting at one.
 */
const answeringAdapter = (statement: string) => () => async () => ({
    text: JSON.stringify({
        candidates: [
            {
                kind: "preference",
                polarity: "affirmed",
                statement,
                confidence: 0.9,
                sensitivity: "standard",
                expiresAt: null,
                // The quote is a span of MESSAGE_BODY: `mem-extract-v6`
                // citations carry one, and the parser checks it against the
                // server's own copy of the cited message.
                evidence: [{ messageLabel: "m1", quote: "formal Korean" }],
            },
        ],
    }),
});

const claimFirstChunk = async (runId: string) => {
    const lease = await claimMemoryExtractionRun({ runId, owner: "qa-worker" });
    assert.ok(lease);
    const chunk = await claimNextExtractionChunk(lease);
    assert.ok(chunk);
    return { lease, chunk };
};

test("a chunk's answer is stored with the pair that produced it", async () => {
    const { user, run } = await seedRun();
    const { lease, chunk } = await claimFirstChunk(run.id);

    const result = await handleMemoryExtractionChunk({
        lease,
        chunk,
        // The handler re-resolves the pair itself now, so a direct call has
        // to supply the same register the run was created against -- the
        // slice driver does exactly this on the production path.
        register: APPROVED_REGISTER,
        adapterFactory: answeringAdapter("The user prefers formal Korean."),
    });
    assert.deepEqual(result, { outcome: "completed" });

    const stored = await prisma.memoryItem.findMany({
        where: { userId: user.id },
    });
    assert.equal(stored.length, 1);
    // Provenance is what §12.4's per-item rule reads later: a memory whose
    // producing pair is revoked must stop being injectable, and it can only
    // be identified if the pair was written down here.
    assert.equal(stored[0].extractionModelId, "gpt-5-6-luna");
    assert.equal(stored[0].promptVersion, "mem-extract-v1");
    assert.equal(stored[0].status, "candidate");
});

test("a chunk reads only its own account's conversations", async () => {
    // The chunk plan is stored data. A stored id is not by itself a statement
    // that the account still owns that conversation, so the load is scoped to
    // the owner as well -- and with nothing readable the chunk is skipped
    // rather than failing forever. Skipped, not completed: nothing called the
    // provider, and a completed chunk is one the account is charged for.
    const { run } = await seedRun();
    const { lease, chunk } = await claimFirstChunk(run.id);
    const stranger = await createUser();
    await prisma.externalConversation.updateMany({
        where: { id: { in: chunk.conversationIds } },
        data: { userId: stranger.id },
    });

    const result = await handleMemoryExtractionChunk({
        lease,
        chunk,
        // The handler re-resolves the pair itself now, so a direct call has
        // to supply the same register the run was created against -- the
        // slice driver does exactly this on the production path.
        register: APPROVED_REGISTER,
        adapterFactory: answeringAdapter("Should never be stored."),
    });
    assert.deepEqual(result, { outcome: "skipped" });
    assert.equal(await prisma.memoryItem.count(), 0);
});

test("a provider error is a retryable chunk failure, not a thrown request", async () => {
    const { run } = await seedRun();
    const { lease, chunk } = await claimFirstChunk(run.id);

    const result = await handleMemoryExtractionChunk({
        lease,
        chunk,
        // The handler re-resolves the pair itself now, so a direct call has
        // to supply the same register the run was created against -- the
        // slice driver does exactly this on the production path.
        register: APPROVED_REGISTER,
        adapterFactory: () => async () => {
            throw new Error("provider exploded");
        },
    });
    assert.deepEqual(result, { outcome: "failed", code: "provider_error" });
    assert.equal(await prisma.memoryItem.count(), 0);
});

test("an unparseable answer fails instead of recording an empty chunk", async () => {
    // Storing zero candidates for a broken answer would record "this chunk
    // had nothing to say" about a chunk nobody actually read.
    const { run } = await seedRun();
    const { lease, chunk } = await claimFirstChunk(run.id);

    const result = await handleMemoryExtractionChunk({
        lease,
        chunk,
        // The handler re-resolves the pair itself now, so a direct call has
        // to supply the same register the run was created against -- the
        // slice driver does exactly this on the production path.
        register: APPROVED_REGISTER,
        adapterFactory: () => async () => ({ text: "not json at all" }),
    });
    assert.deepEqual(result, { outcome: "failed", code: "unparseable_answer" });
    assert.equal(await prisma.memoryItem.count(), 0);
});

test("the dispatcher drives a pending run to completion", async () => {
    // The gap §11.1 names: before this, a run reached `pending` and nothing
    // ever picked it up.
    const { user, run } = await seedRun();

    const result = await dispatchPendingMemoryExtractionRuns(new Date(), 5, {
        adapterFactory: answeringAdapter("The user prefers formal Korean."),
        register: APPROVED_REGISTER,
    });
    assert.equal(result.dispatchedRuns, 1);
    assert.ok(result.chunksProcessed >= 1);

    const finished = await prisma.memoryExtractionRun.findUniqueOrThrow({
        where: { id: run.id },
    });
    assert.equal(finished.status, "completed");
    assert.equal(await prisma.memoryItem.count({ where: { userId: user.id } }), 1);
});

test("the dispatcher reclaims an orphaned lease and then restarts the run", async () => {
    // Reclaiming without driving was the whole bug: the run becomes claimable
    // and then waits for a request that may never come.
    const { run } = await seedRun();
    const lease = await claimMemoryExtractionRun({
        runId: run.id,
        owner: "worker-that-died",
    });
    assert.ok(lease);
    await prisma.memoryExtractionRun.update({
        where: { id: run.id },
        data: {
            leaseExpiresAt: new Date(Date.now() - MEMORY_EXTRACTION_LEASE_TTL_MS),
        },
    });

    const result = await dispatchPendingMemoryExtractionRuns(new Date(), 5, {
        adapterFactory: answeringAdapter("The user prefers formal Korean."),
        register: APPROVED_REGISTER,
    });
    assert.equal(result.reclaimedRuns, 1);
    assert.equal(result.dispatchedRuns, 1);

    const finished = await prisma.memoryExtractionRun.findUniqueOrThrow({
        where: { id: run.id },
    });
    assert.equal(finished.status, "completed");
});

test("one poisoned run does not stop the others from recovering", async () => {
    const healthy = await seedRun();
    const poisoned = await seedRun();

    const result = await dispatchPendingMemoryExtractionRuns(new Date(), 5, {
        adapterFactory: () => async () => {
            throw new Error("provider exploded");
        },
        register: APPROVED_REGISTER,
    });
    // Both were driven; the failure is the chunk's, recorded durably, not an
    // exception that ends the cycle for every other account.
    assert.equal(result.dispatchedRuns, 2);
    for (const seeded of [healthy, poisoned]) {
        const row = await prisma.memoryExtractionRun.findUniqueOrThrow({
            where: { id: seeded.run.id },
        });
        assert.notEqual(row.status, "running");
    }
});

test("the sweep is bounded so one slow provider cannot hold up maintenance", async () => {
    const runIds: string[] = [];
    for (let index = 0; index < 4; index += 1) {
        const { run } = await seedRun();
        runIds.push(run.id);
    }

    const result = await dispatchPendingMemoryExtractionRuns(new Date(), 2, {
        adapterFactory: answeringAdapter("The user prefers formal Korean."),
        register: APPROVED_REGISTER,
    });
    assert.equal(result.dispatchedRuns, 2);

    // The rest are untouched and still durable, for the next pass.
    assert.equal(
        await prisma.memoryExtractionRun.count({
            where: { id: { in: runIds }, status: "pending" },
        }),
        2
    );
});

test("the pass stops at its wall-clock ceiling, not only its run cap (§11.1)", async () => {
    // A run count is not a time bound. One slice may take
    // MEMORY_EXTRACTION_SLICE_BUDGET_MS, so five runs back to back is minutes
    // inside a request that also reconciles credits, drains notifications and
    // sweeps refunds -- exactly what §11.1 says extraction must not delay.
    const runIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
        const { run } = await seedRun();
        runIds.push(run.id);
    }

    // A ceiling below one chunk's timeout: the first run may start (the floor
    // guarantees at least one gets a fair slice) and the rest are deferred
    // rather than run past the deadline.
    const result = await dispatchPendingMemoryExtractionRuns(new Date(), 5, {
        adapterFactory: answeringAdapter("The user prefers formal Korean."),
        register: APPROVED_REGISTER,
        budgetMs: 1,
    });
    assert.ok(
        result.skippedForTime > 0,
        "the pass stopped before draining the queue"
    );

    // Deferred, not lost: every run the pass did not finish is back at
    // `pending` holding no lease, which is what makes the next pass able to
    // take it. A slice that runs out of budget before its first chunk hands
    // the lease back and parks the run -- the point of checking the budget
    // before claiming rather than after.
    assert.equal(
        await prisma.memoryExtractionRun.count({
            where: { id: { in: runIds }, status: "running" },
        }),
        0,
        "no run is left claimed by a pass that has ended"
    );
    assert.equal(
        await prisma.memoryExtractionRun.count({
            where: { id: { in: runIds }, leaseExpiresAt: { not: null } },
        }),
        0,
        "a parked run holds no lease"
    );
});

test("a deferred run is picked up by the next pass", async () => {
    const runIds: string[] = [];
    for (let index = 0; index < 2; index += 1) {
        const { run } = await seedRun();
        runIds.push(run.id);
    }

    const first = await dispatchPendingMemoryExtractionRuns(new Date(), 1, {
        adapterFactory: answeringAdapter("The user prefers formal Korean."),
        register: APPROVED_REGISTER,
    });
    assert.equal(first.dispatchedRuns, 1);

    const second = await dispatchPendingMemoryExtractionRuns(new Date(), 5, {
        adapterFactory: answeringAdapter("The user prefers formal Korean."),
        register: APPROVED_REGISTER,
    });
    assert.equal(second.dispatchedRuns, 1);

    assert.equal(
        await prisma.memoryExtractionRun.count({
            where: { id: { in: runIds }, status: "completed" },
        }),
        2
    );
});


/* ------------------------------------------------- sources locked mid-run */

/**
 * A run is created against an unlocked selection, and it can run for a long
 * time. These pin what happens when the owner locks a source in the meantime
 * (docs/policy/external-conversation-import-and-memory.md §7.1, §11.1).
 *
 * The adapter here calls `onCallIssued` the way the production adapter does
 * (lib/memoryExtractionProvider.ts) -- `answeringAdapter` above does not, and
 * the last-moment lock check lives inside that hook, so a test built on it
 * would pass without ever reaching the check.
 */
const issuingAdapter = (
    statement: string,
    hooks: {
        /** Runs after the chunk has loaded and before the request leaves. */
        beforeIssue?: () => Promise<void>;
        /** Runs after the request has left and before the answer returns. */
        afterIssue?: () => Promise<void>;
        prompts?: string[];
    } = {}
): ExtractionAdapterFactory => (factory) => async ({ prompt }) => {
    if (hooks.beforeIssue) await hooks.beforeIssue();
    await factory.onCallIssued();
    hooks.prompts?.push(prompt.user);
    if (hooks.afterIssue) await hooks.afterIssue();
    return {
        text: JSON.stringify({
            candidates: [
                {
                    kind: "preference",
                    polarity: "affirmed",
                    statement,
                    confidence: 0.9,
                    sensitivity: "standard",
                    expiresAt: null,
                    evidence: [{ messageLabel: "m1", quote: "formal Korean" }],
                },
            ],
        }),
    };
};

const lockConversation = (id: string) =>
    prisma.externalConversation.update({
        where: { id },
        // Any stored value means locked; the check is `password IS NOT NULL`.
        data: { password: "scrypt$1$test-locked" },
    });

const titleOf = async (id: string) =>
    (
        await prisma.externalConversation.findUniqueOrThrow({
            where: { id },
            select: { title: true },
        })
    ).title;

const providerCallsFor = (runId: string) =>
    prisma.memoryExtractionProviderCall.findMany({
        where: { chunk: { runId } },
        select: { callIssued: true },
    });

test("a source locked after the run was created never reaches the provider", async () => {
    const { run } = await seedRun(1);
    const { lease, chunk } = await claimFirstChunk(run.id);
    await lockConversation(chunk.conversationIds[0]);

    const prompts: string[] = [];
    const result = await handleMemoryExtractionChunk({
        lease,
        chunk,
        register: APPROVED_REGISTER,
        adapterFactory: issuingAdapter("Should never be asked.", { prompts }),
    });

    // Every source in the chunk is locked, so there is nothing to send: the
    // chunk is skipped, which settlement does not charge.
    assert.deepEqual(result, { outcome: "skipped" });
    assert.equal(prompts.length, 0, "the adapter was never called");
    assert.deepEqual(
        await providerCallsFor(run.id),
        [],
        "no provider call was even admitted"
    );
});

test("a chunk with one source locked sends the others and only the others", async () => {
    const { run } = await seedRun(2);
    const { lease, chunk } = await claimFirstChunk(run.id);
    assert.equal(chunk.conversationIds.length, 2, "fixture: both in one chunk");
    const [lockedId, openId] = chunk.conversationIds;
    const lockedTitle = await titleOf(lockedId);
    const openTitle = await titleOf(openId);
    await lockConversation(lockedId);

    const prompts: string[] = [];
    const result = await handleMemoryExtractionChunk({
        lease,
        chunk,
        register: APPROVED_REGISTER,
        adapterFactory: issuingAdapter("The user prefers formal Korean.", {
            prompts,
        }),
    });

    // One lock does not throw away the other source the owner approved, and
    // the call that did go out is charged like any other.
    assert.deepEqual(result, { outcome: "completed" });
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0].includes(openTitle), "the unlocked source was sent");
    assert.ok(
        !prompts[0].includes(lockedTitle),
        "the locked source's title was not sent"
    );
});

test("a source locked while the request was being prepared stops it before it leaves", async () => {
    // The load filtered nothing -- the source was open then -- and the lock
    // lands between that read and the request. The last-moment check has to
    // catch it, because nothing earlier can.
    const { run } = await seedRun(1);
    const { lease, chunk } = await claimFirstChunk(run.id);

    const prompts: string[] = [];
    const result = await handleMemoryExtractionChunk({
        lease,
        chunk,
        register: APPROVED_REGISTER,
        adapterFactory: issuingAdapter("Should never be asked.", {
            prompts,
            beforeIssue: async () => {
                await lockConversation(chunk.conversationIds[0]);
            },
        }),
    });

    assert.deepEqual(result, { outcome: "failed", code: "source_locked" });
    assert.equal(prompts.length, 0, "the request never left");
    const calls = await providerCallsFor(run.id);
    assert.equal(calls.length, 1, "fixture: the call was admitted");
    assert.equal(
        calls[0].callIssued,
        false,
        "never marked issued, so its cost is released rather than settled"
    );
    assert.equal(await prisma.memoryItem.count(), 0);
});

test("an answer that arrived after its source was locked is kept as an ordinary candidate", async () => {
    // The request left while the source was open and the lock landed while
    // the provider was answering. The exposure has already happened and
    // cannot be undone; what is left to decide is what to do with the answer.
    //
    // Kept, and kept as `candidate` -- not `suspended_by_source_lock`. That
    // status is written only over `active` and restored to `active` on
    // unlock (lib/memorySourceLock.ts), so storing a candidate in it would let
    // unlocking promote something the user never approved. Nor does keeping it
    // expose anything: retrieval excludes a memory whose evidence is all
    // locked at read time, whatever its status says -- pinned by "a locked
    // source's memory is excluded from retrieval even if its status was
    // missed" in tests/integration/external-conversation-lock.db.test.ts.
    const { run } = await seedRun(1);
    const { lease, chunk } = await claimFirstChunk(run.id);

    const result = await handleMemoryExtractionChunk({
        lease,
        chunk,
        register: APPROVED_REGISTER,
        adapterFactory: issuingAdapter("The user prefers formal Korean.", {
            afterIssue: async () => {
                await lockConversation(chunk.conversationIds[0]);
            },
        }),
    });

    assert.deepEqual(result, { outcome: "completed" });
    const stored = await prisma.memoryItem.findMany({
        select: { status: true, approvedAt: true },
    });
    assert.equal(stored.length, 1);
    assert.equal(stored[0].status, "candidate");
    assert.equal(stored[0].approvedAt, null);
    const calls = await providerCallsFor(run.id);
    assert.equal(calls[0]?.callIssued, true, "the call really did go out");
});
