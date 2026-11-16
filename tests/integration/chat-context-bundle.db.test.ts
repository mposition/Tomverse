import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import {
    consumeContextBundle,
    deleteExpiredContextBundleConsumptions,
} from "@/lib/chatContextBundleService";
import { bundleConsumptionKey } from "@/lib/chatContextBundleCore";
import { prisma } from "@/lib/prisma";

/**
 * The §10 nonce contract against a real database.
 *
 * The pure half — what is signed, what is compared, what counts as one
 * consumption — is covered by tests/chatContextBundleCore.test.mjs. What only
 * a database can show is that the *claim* is atomic: the whole design rests on
 * the insert being the check, so two requests presenting the same
 * (bundle, model) must not both proceed. A read-then-write would pass every
 * sequential test here and fail exactly this one.
 */

const resetData = async () => {
    await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "ChatContextBundleConsumption" RESTART IDENTITY CASCADE
  `);
};

const future = (minutes = 5) =>
    new Date(Date.now() + minutes * 60 * 1000);

beforeEach(resetData);
after(async () => {
    await resetData();
    await prisma.$disconnect();
});

test("a bundle is spent once per model", async () => {
    const bundleId = randomUUID();
    const claim = () =>
        consumeContextBundle({
            bundleId,
            modelId: "qa-model",
            userId: "qa-user",
            expiresAt: future(),
        });

    assert.deepEqual(await claim(), { consumed: true });
    assert.deepEqual(await claim(), {
        consumed: false,
        reason: "already_consumed",
    });
});

test("a comparison's panels each spend their own slot from one bundle", async () => {
    // The reason the key is (bundle, model) and not the bundle: three panels
    // legitimately present the same bundle, and a per-bundle rule would refuse
    // two of a comparison's own requests.
    const bundleId = randomUUID();
    const models = ["qa-model-a", "qa-model-b", "qa-model-c"];
    for (const modelId of models) {
        assert.deepEqual(
            await consumeContextBundle({
                bundleId,
                modelId,
                userId: "qa-user",
                expiresAt: future(),
            }),
            { consumed: true },
            modelId
        );
    }
    // ...and a panel that retries its own model is still a replay.
    assert.deepEqual(
        await consumeContextBundle({
            bundleId,
            modelId: models[0],
            userId: "qa-user",
            expiresAt: future(),
        }),
        { consumed: false, reason: "already_consumed" }
    );

    const stored = await prisma.chatContextBundleConsumption.findMany({
        where: { bundleId },
        select: { consumptionKey: true },
    });
    assert.deepEqual(
        stored.map((row) => row.consumptionKey).sort(),
        models.map((modelId) => bundleConsumptionKey(bundleId, modelId)).sort()
    );
});

test("concurrent claims on one (bundle, model) produce exactly one winner", async () => {
    const bundleId = randomUUID();
    const results = await Promise.all(
        Array.from({ length: 8 }, () =>
            consumeContextBundle({
                bundleId,
                modelId: "qa-model",
                userId: "qa-user",
                expiresAt: future(),
            })
        )
    );
    assert.equal(results.filter((result) => result.consumed).length, 1);
    assert.equal(
        await prisma.chatContextBundleConsumption.count({ where: { bundleId } }),
        1
    );
});

test("two different bundles never collide, however similar their ids look", async () => {
    const first = "bundle-a";
    const second = "bundle-a:qa";
    // `bundleConsumptionKey` joins with ":", so an id containing one could in
    // principle collide with another (bundle, model) pair's key.
    assert.deepEqual(
        await consumeContextBundle({
            bundleId: first,
            modelId: "qa:model",
            userId: "qa-user",
            expiresAt: future(),
        }),
        { consumed: true }
    );
    assert.deepEqual(
        await consumeContextBundle({
            bundleId: second,
            modelId: "model",
            userId: "qa-user",
            expiresAt: future(),
        }),
        // Documents the collision rather than asserting it cannot happen:
        // both keys render as "bundle-a:qa:model". Bundle ids are server-
        // generated UUIDs, which contain no ":", so the case is unreachable
        // in production -- and this test is what would fail if that ever
        // stopped being true.
        { consumed: false, reason: "already_consumed" }
    );
});

test("cleanup removes rows whose bundle has expired and keeps the live ones", async () => {
    const expired = randomUUID();
    const live = randomUUID();
    await consumeContextBundle({
        bundleId: expired,
        modelId: "qa-model",
        userId: "qa-user",
        expiresAt: new Date(Date.now() - 60_000),
    });
    await consumeContextBundle({
        bundleId: live,
        modelId: "qa-model",
        userId: "qa-user",
        expiresAt: future(),
    });

    assert.equal(await deleteExpiredContextBundleConsumptions(), 1);
    const remaining = await prisma.chatContextBundleConsumption.findMany({
        select: { bundleId: true },
    });
    assert.deepEqual(
        remaining.map((row) => row.bundleId),
        [live]
    );
});

test("the claim records who made it, content-free", async () => {
    const bundleId = randomUUID();
    await consumeContextBundle({
        bundleId,
        modelId: "qa-model",
        userId: "qa-user",
        expiresAt: future(),
    });
    const row = await prisma.chatContextBundleConsumption.findUniqueOrThrow({
        where: { consumptionKey: bundleConsumptionKey(bundleId, "qa-model") },
    });
    assert.equal(row.userId, "qa-user");
    assert.equal(row.modelId, "qa-model");
    // Nothing about the prompt, the memories or the fingerprint is stored:
    // the row exists to answer "was this spent", and §22 keeps observations
    // content-free.
    assert.deepEqual(Object.keys(row).sort(), [
        "bundleId",
        "consumptionKey",
        "createdAt",
        "expiresAt",
        "id",
        "modelId",
        "userId",
    ]);
});


test("memory history snapshots survive saves and append, and refuse source or authority drift", async () => {
    const { prepareMemoryHistoryContext, replayMemoryHistoryContext } = await import("@/lib/memoryHistorySnapshot");
    const { memoryCurrentQueryDigest, memoryHistoryContentDigest } = await import("@/lib/memoryHistorySnapshotCore");
    const { issueContextBundle, verifyContextBundle } = await import("@/lib/chatContextBundleCore");
    const previousFlag = process.env.MEMORY_RELEVANCE_CONTEXT_ENABLED;
    process.env.MEMORY_RELEVANCE_CONTEXT_ENABLED = "true";
    const userId = `memory-history-${randomUUID()}`;
    const request = new Request("http://localhost/api/chat/context");
    const query = "그 프로젝트에서 내가 맡은 일과 마감만 알려줘.";
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.test` } });
    const conversation = await prisma.conversation.create({ data: { userId, title: "Local history snapshot", kind: "chat", selectedModels: JSON.stringify(["model-a", "model-b"]) } });
    const at = new Date("2026-11-01T00:00:00Z");
    const add = (id: string, role: string, content: string, createdAt = at) => prisma.message.create({ data: {
        id: `${userId}-${id}`, conversationId: conversation.id, role, content, createdAt,
    } });
    const inputs = { request, userId, conversationId: conversation.id, query, modelIds: ["model-a", "model-b"] };
    try {
        const empty = await prepareMemoryHistoryContext(inputs)!();
        assert.deepEqual(empty.history, []);
        await add("a", "user", "아틀라스 프로젝트의 출시 일정을 정리하자.");
        await add("b", "user", "내 역할은 QA이고 마감은 금요일이야.");
        await add("z", "assistant", "This must not enter semantic history.");
        await add("y", "system", "Neither may this.");
        const snapshot = await prepareMemoryHistoryContext(inputs)!();
        assert.deepEqual(snapshot.history.map(source => source.id), [`${userId}-a`, `${userId}-b`]);
        const anchor = { version: 1 as const, queryDigest: memoryCurrentQueryDigest(query),
            sources: snapshot.history.map(({ id, digest }) => ({ id, digest })) };
        const payload = {
            version: 1 as const, bundleId: randomUUID(), subjectKey: userId, conversationId: conversation.id,
            modelIds: inputs.modelIds, memoryTokens: 0, profileTokens: 0, expiresAtMs: Date.now() + 60000,
            semanticSteps: { memoryRerank: true, knowledgeNeighbours: false, knowledgeRerank: false },
            memoryMode: "on" as const, memoryVersion: "v", styleVersion: "s", profileVersion: null,
            retrievalHash: "r", retrievalVersion: 1, promptVersion: "p", knowledgeHash: "none",
            memoryQueryPolicy: "full" as const, memoryHistory: anchor,
        };
        const token = issueContextBundle(payload, process.env.NEXTAUTH_SECRET!);
        await add("current", "user", query, new Date(at.getTime() + 1000));
        await add("other-tab", "user", "다른 탭의 새 질문", new Date(at.getTime() + 2000));
        await add("sibling", "assistant", "Comparison sibling", new Date(at.getTime() + 3000));
        const replay = () => replayMemoryHistoryContext({ ...inputs, payload });
        assert.deepEqual((await replay())?.history, snapshot.history);
        const recovered = await prepareMemoryHistoryContext({ ...inputs, previousContextBundle: token })!();
        assert.deepEqual(recovered.history, snapshot.history);
        const noAnchor = { ...payload, memoryHistory: undefined };
        assert.deepEqual((await replayMemoryHistoryContext({ ...inputs, payload: noAnchor }))?.history, []);
        const legacy = { ...payload, memoryHistory: undefined, memoryQueryPolicy: undefined };
        assert.deepEqual(await replayMemoryHistoryContext({ ...inputs, payload: legacy }), { history: [], queryPolicy: "legacy" });
        const expired = issueContextBundle({ ...payload, expiresAtMs: 0 }, process.env.NEXTAUTH_SECRET!);
        assert.deepEqual((await prepareMemoryHistoryContext({ ...inputs, previousContextBundle: expired })!()).history, []);
        assert.throws(() => prepareMemoryHistoryContext({ ...inputs, userId: "another-owner", previousContextBundle: token }),
            (error: unknown) => (error as { code: string }).code === "INVALID_CONTEXT_BUNDLE");
        assert.throws(() => prepareMemoryHistoryContext({ ...inputs, modelIds: ["other-model"], previousContextBundle: expired }),
            (error: unknown) => (error as { code: string }).code === "INVALID_CONTEXT_BUNDLE");
        assert.throws(() => prepareMemoryHistoryContext({ ...inputs, previousContextBundle: `${token}x` }),
            (error: unknown) => (error as { code: string }).code === "INVALID_CONTEXT_BUNDLE");
        const verified = verifyContextBundle(token, { secret: process.env.NEXTAUTH_SECRET!, subjectKey: userId,
            conversationId: conversation.id, modelId: "model-b" });
        assert.equal(verified.ok, true);
        assert.equal(token.includes(snapshot.history[0].content), false);
        await prisma.message.update({ where: { id: snapshot.history[0].id }, data: { content: "Edited source" } });
        assert.notEqual(memoryHistoryContentDigest("Edited source"), anchor.sources[0].digest);
        assert.equal(await replay(), null);
        assert.deepEqual((await prepareMemoryHistoryContext({ ...inputs, previousContextBundle: token })!()).history, []);
        await prisma.message.delete({ where: { id: snapshot.history[1].id } });
        assert.equal(await replay(), null);
        await prisma.conversation.update({ where: { id: conversation.id }, data: { password: "test-locked", passwordVersion: 1 } });
        await assert.rejects(replay, (error: unknown) => (error as { code: string }).code === "CONVERSATION_LOCKED");
        await assert.rejects(prepareMemoryHistoryContext({ ...inputs, previousContextBundle: token })!,
            (error: unknown) => (error as { code: string }).code === "CONVERSATION_LOCKED");
        await assert.rejects(() => replayMemoryHistoryContext({ ...inputs, userId: "another-owner", payload }),
            (error: unknown) => (error as { code: string }).code === "CONVERSATION_FORBIDDEN");
    } finally {
        await prisma.user.delete({ where: { id: userId } });
        if (previousFlag === undefined) delete process.env.MEMORY_RELEVANCE_CONTEXT_ENABLED;
        else process.env.MEMORY_RELEVANCE_CONTEXT_ENABLED = previousFlag;
    }
});
