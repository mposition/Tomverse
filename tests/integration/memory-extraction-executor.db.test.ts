import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { externalContentDigest } from "@/lib/externalImportDigest";
import { MEMORY_EXTRACTION_FLAG_KEY } from "@/lib/memoryAccess";
import { dispatchPendingMemoryExtractionRuns } from "@/lib/memoryExtractionDispatch";
import { createExtractionChunkHandler } from "@/lib/memoryExtractionRunner";
import type { MemoryExtractionEvalEntry } from "@/lib/memoryExtractionEvalRegister";
import {
    claimMemoryExtractionRun,
    claimNextExtractionChunk,
    createMemoryExtractionRun,
    driveMemoryExtractionRunSlice,
    estimateMemoryExtraction,
} from "@/lib/memoryExtractionService";
import { prisma } from "@/lib/prisma";

/**
 * The live executor's cancellation and cost contracts (policy §11, §11.1).
 *
 * Cancellation and cost accounting are NOT alternatives to each other:
 *
 *   * the AbortSignal is best-effort — it stops work that has not started and
 *     drops a request in flight, and a handler is free to ignore it;
 *   * the provider-call ledger is what records a request that was actually
 *     issued, because an abort reaching the network does not promise the
 *     charge goes away.
 *
 * So the tests below pin both, and the boundary between them.
 */

const ENV = {
    CHAT_PROVIDER_OPENAI_COST_MICROUSD_PER_DAY: "100000000",
    CHAT_PROVIDER_OPENAI_COST_MICROUSD_PER_MONTH: "1000000000",
    MEMORY_EXTRACTION_PROVIDER_OPENAI_MAX_PERCENT_PER_DAY: "100",
    MEMORY_EXTRACTION_PROVIDER_OPENAI_MAX_PERCENT_PER_MONTH: "100",
} as Record<string, string | undefined>;

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

const resetData = async () => {
    await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "MemoryExtractionProviderCall",
      "MemoryExtractionChunk",
      "MemoryExtractionRun",
      "MemoryEvidence",
      "MemoryItem",
      "ExternalMessage",
      "ExternalConversation",
      "ExternalImport",
      "ChatUsageBucket",
      "AppSetting"
    RESTART IDENTITY CASCADE
  `);
};

const setFlag = (value: boolean) =>
    prisma.appSetting.upsert({
        where: { key: MEMORY_EXTRACTION_FLAG_KEY },
        create: { key: MEMORY_EXTRACTION_FLAG_KEY, value: String(value) },
        update: { value: String(value) },
    });

const seedRun = async () => {
    const user = await prisma.user.create({
        data: { email: `extraction-exec-${randomUUID()}@example.test` },
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
    const content = "간결한 답변을 선호해요.";
    const conversation = await prisma.externalConversation.create({
        data: {
            userId: user.id,
            importId: importRow.id,
            provider: "chatgpt",
            externalStableId: randomUUID().replaceAll("-", ""),
            title: "executor fixture",
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
    const base = {
        userId: user.id,
        extractionModelId: "gpt-5-6-luna",
        promptVersion: "mem-extract-v1",
        plan: "Free" as const,
        selectedConversationIds: [conversation.id],
        register: APPROVED_REGISTER,
    };
    const estimate = await estimateMemoryExtraction(base);
    const run = await createMemoryExtractionRun({
        ...base,
        confirmedCredits: estimate.estimatedCredits,
    });
    await setFlag(true);
    return { user, run };
};

const ANSWER = {
    candidates: [
        {
            kind: "verbosity",
            statement: "사용자는 간결한 답변을 선호한다",
            confidence: 0.9,
            evidence: ["m1"],
        },
    ],
};

/**
 * Stands in for the provider adapter, on the same seam the real one is built
 * from — so what runs here is the production composition with the network call
 * replaced, not a parallel path.
 */
type AdapterOptions = {
    signal: AbortSignal;
    onCallIssued: () => Promise<void> | void;
    onResult: (result: unknown) => void;
    maxRetries?: number;
};
const fakeAdapter =
    (behaviour: {
        answer?: unknown;
        issue?: boolean;
        delayMs?: number;
        throwBefore?: boolean;
        onCalled?: (options: AdapterOptions) => void;
    }) =>
    (options: AdapterOptions) =>
    async () => {
        behaviour.onCalled?.(options);
        // Contract point 4: the handler must not call a provider on an already
        // aborted signal.
        options.signal.throwIfAborted();
        if (behaviour.throwBefore) throw new Error("provider refused");
        if (behaviour.issue !== false) await options.onCallIssued();
        if (behaviour.delayMs) {
            await new Promise((resolve) =>
                setTimeout(resolve, behaviour.delayMs)
            );
        }
        options.onResult({
            usage: {
                inputTokens: 900,
                outputTokens: 120,
                usageFromProvider: true,
            },
            responseId: "resp-fake",
        });
        return { text: JSON.stringify(behaviour.answer ?? ANSWER) };
    };

const drive = (runId: string, adapter: unknown, overrides = {}) =>
    driveMemoryExtractionRunSlice({
        runId,
        owner: "worker-exec",
        register: APPROVED_REGISTER,
        environment: ENV,
        handler: createExtractionChunkHandler({
            register: APPROVED_REGISTER,
            environment: ENV,
            adapterFactory: adapter as never,
        }),
        ...overrides,
    });

beforeEach(resetData);
after(async () => {
    await resetData();
    await prisma.$disconnect();
});

test("the executor calls, stores and settles one chunk end to end (§11)", async () => {
    const { user, run } = await seedRun();
    const result = await drive(run.id, fakeAdapter({}));
    assert.equal(result.outcome, "completed");

    const items = await prisma.memoryItem.findMany({
        where: { userId: user.id },
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].status, "candidate");

    const call = await prisma.memoryExtractionProviderCall.findFirstOrThrow({
        where: { chunk: { runId: run.id } },
    });
    assert.equal(call.callIssued, true);
    assert.ok(call.settledAt);
    assert.equal(call.usageConfirmed, true);
});

test("the adapter receives the slice's signal and no SDK retry (§11)", async () => {
    const { run } = await seedRun();
    let seen: AdapterOptions | null = null;
    await drive(
        run.id,
        fakeAdapter({ onCalled: (options) => (seen = options) })
    );
    const captured = seen as AdapterOptions | null;
    assert.ok(captured, "the adapter was built and called");
    assert.ok(captured!.signal instanceof AbortSignal);
    // maxRetries is the provider module's own constant; what the seam has to
    // carry is the signal. The offline-boundary test pins `maxRetries: 0` in
    // the real adapter's source.
    assert.equal(captured!.signal.aborted, false);
});

test("a timeout aborts the handler's signal (§11)", async () => {
    const { run } = await seedRun();
    let captured: AbortSignal | null = null;
    const result = await drive(
        run.id,
        fakeAdapter({
            delayMs: 400,
            onCalled: (options) => (captured = options.signal),
        }),
        { chunkTimeoutMs: 50 }
    );
    assert.equal(result.outcome, "paused");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(captured, "the adapter ran");
    assert.equal((captured as unknown as AbortSignal).aborted, true);
});

test("an abort is classified as a timeout, not a handler error (§11)", async () => {
    const { run } = await seedRun();
    await drive(run.id, fakeAdapter({ delayMs: 400 }), { chunkTimeoutMs: 50 });
    const chunk = await prisma.memoryExtractionChunk.findFirstOrThrow({
        where: { runId: run.id },
    });
    // `handler_error` would hide every slow provider inside "broken code".
    assert.equal(chunk.failureCode, "chunk_timeout");
});

test("a late result from a timed-out handler stores nothing (§11)", async () => {
    const { user, run } = await seedRun();
    // This adapter ignores the signal entirely, which is exactly the case the
    // bounded race exists for.
    const ignoresSignal =
        (options: AdapterOptions) => async () => {
            await options.onCallIssued();
            await new Promise((resolve) => setTimeout(resolve, 300));
            options.onResult({
                usage: {
                    inputTokens: 900,
                    outputTokens: 120,
                    usageFromProvider: true,
                },
                responseId: "resp-late",
            });
            return { text: JSON.stringify(ANSWER) };
        };
    await drive(run.id, ignoresSignal, { chunkTimeoutMs: 50 });
    // Give the ignored handler time to finish and try to land its result.
    await new Promise((resolve) => setTimeout(resolve, 500));

    assert.equal(
        await prisma.memoryItem.count({ where: { userId: user.id } }),
        0,
        "a result this slice already wrote off must never become candidates"
    );
});

test("a call issued before an abort keeps its operational cost (§3)", async () => {
    const { run } = await seedRun();
    await drive(run.id, fakeAdapter({ delayMs: 400 }), { chunkTimeoutMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 500));

    const call = await prisma.memoryExtractionProviderCall.findFirstOrThrow({
        where: { chunk: { runId: run.id } },
    });
    assert.equal(call.callIssued, true);
    // An abort does not promise the provider stopped billing, so the cost
    // stays. This is the line between best-effort cancellation and accounting.
    const budget = await prisma.chatUsageBucket.findFirst({
        where: { key: "provider:openai", period: "provider-cost-day" },
    });
    assert.ok(Number(budget?.count ?? 0) > 0);
});

test("a failure before any request gives the operational budget back (§3)", async () => {
    const { run } = await seedRun();
    await drive(run.id, fakeAdapter({ throwBefore: true, issue: false }));

    const call = await prisma.memoryExtractionProviderCall.findFirstOrThrow({
        where: { chunk: { runId: run.id } },
    });
    assert.equal(call.callIssued, false);
    assert.equal(Number(call.settledCostMicroUsd), 0);
    const budget = await prisma.chatUsageBucket.findFirst({
        where: { key: "provider:openai", period: "provider-cost-day" },
    });
    assert.equal(Number(budget?.count ?? 0), 0);
});

test("a fenced-out worker settles its cost and commits nothing (§11)", async () => {
    const { user, run } = await seedRun();
    const lease = await claimMemoryExtractionRun({
        runId: run.id,
        owner: "worker-a",
    });
    assert.ok(lease);
    const chunk = await claimNextExtractionChunk(lease);
    assert.ok(chunk);

    const handler = createExtractionChunkHandler({
        register: APPROVED_REGISTER,
        environment: ENV,
        adapterFactory: fakeAdapter({}) as never,
    });
    // Somebody else takes the run over while this worker is calling.
    await prisma.memoryExtractionRun.update({
        where: { id: run.id },
        data: { leaseGeneration: lease.leaseGeneration + 1 },
    });

    const outcome = await handler({
        lease,
        chunk,
        signal: new AbortController().signal,
    });
    assert.equal(outcome.outcome, "failed");
    assert.equal(
        await prisma.memoryItem.count({ where: { userId: user.id } }),
        0
    );
    // Money spent does not depend on the right to write.
    const call = await prisma.memoryExtractionProviderCall.findFirstOrThrow({
        where: { chunk: { runId: run.id } },
    });
    assert.ok(call.settledAt);
    assert.equal(call.failureCode, "fenced_out");
});

test("the durable dispatcher finishes a run nothing ever kicked (§11.1)", async () => {
    const { user, run } = await seedRun();
    const dispatched = await dispatchPendingMemoryExtractionRuns({
        register: APPROVED_REGISTER,
        environment: ENV,
        adapterFactory: fakeAdapter({}) as never,
    });
    assert.equal(dispatched.dispatched, 1);
    assert.equal(
        (
            await prisma.memoryExtractionRun.findUniqueOrThrow({
                where: { id: run.id },
            })
        ).status,
        "completed"
    );
    assert.equal(
        await prisma.memoryItem.count({ where: { userId: user.id } }),
        1
    );
});

test("the dispatcher does nothing while the rollout flag is off (§15)", async () => {
    await seedRun();
    await setFlag(false);
    const dispatched = await dispatchPendingMemoryExtractionRuns({
        register: APPROVED_REGISTER,
        environment: ENV,
        adapterFactory: fakeAdapter({}) as never,
    });
    assert.equal(dispatched.dispatched, 0);
    assert.equal(await prisma.memoryExtractionProviderCall.count(), 0);
});
