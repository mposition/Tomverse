import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { externalContentDigest } from "@/lib/externalImportDigest";
import { retrieveMemoryContext } from "@/lib/memoryRetrievalService";
import { memoryRetrievalTerms } from "@/lib/memoryRetrievalTerms";
import { putMemorySettings } from "@/lib/memoryService";
import { prisma } from "@/lib/prisma";

/**
 * Retrieval v1 against a real database (§9).
 *
 * The pure scorer is covered by tests/memoryRetrievalScoring.test.mjs. What
 * only a database can show is whether the *query* agrees with the scorer:
 * a memory the scorer would never relevance-gate is useless if the SQL that
 * fetches candidates filters it out first, and that failure is silent —
 * retrieval simply returns less, which is indistinguishable from the account
 * having less.
 */

const resetData = async () => {
    await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "MemoryEvidence",
      "MemoryItem",
      "UserMemorySettings",
      "ExternalMessage",
      "ExternalConversation",
      "ExternalImport"
    RESTART IDENTITY CASCADE
  `);
};

const createUser = () =>
    prisma.user.create({
        data: { email: `memory-retrieval-${randomUUID()}@example.test` },
    });

/** One imported conversation that memories can point at as their source. */
const seedConversation = async (userId: string) => {
    const importRow = await prisma.externalImport.create({
        data: {
            userId,
            provider: "chatgpt",
            status: "completed",
            parserVersion: "test-1",
            digestVersion: 1,
        },
    });
    return prisma.externalConversation.create({
        data: {
            userId,
            importId: importRow.id,
            provider: "chatgpt",
            externalStableId: randomUUID().replaceAll("-", ""),
            title: "retrieval fixture",
            conversationDigest: randomUUID().replaceAll("-", "").repeat(2),
            digestVersion: 1,
            messageCount: 1,
            contentBytes: BigInt(10),
            finalized: true,
        },
    });
};

const seedMemory = async (
    userId: string,
    statement: string,
    overrides: {
        kind?: string;
        status?: string;
        pinned?: boolean;
        expiresAt?: Date | null;
        conversationId?: string;
        /** Unique within a conversation; the message table enforces it. */
        ordinal?: number;
    } = {}
) => {
    const item = await prisma.memoryItem.create({
        data: {
            userId,
            kind: overrides.kind ?? "preference",
            statement,
            status: overrides.status ?? "active",
            confidence: 0.9,
            pinned: overrides.pinned ?? false,
            expiresAt: overrides.expiresAt ?? null,
            approvedAt: new Date("2026-08-01T00:00:00.000Z"),
            searchTerms: memoryRetrievalTerms(statement),
            retrievalVersion: 1,
        },
    });
    if (overrides.conversationId) {
        const content = `source for ${statement}`;
        const message = await prisma.externalMessage.create({
            data: {
                userId,
                externalConversationId: overrides.conversationId,
                externalStableId: randomUUID().replaceAll("-", ""),
                role: "user",
                content,
                contentDigest: externalContentDigest(content),
                digestVersion: 1,
                ordinal: overrides.ordinal ?? 0,
            },
        });
        await prisma.memoryEvidence.create({
            data: {
                memoryItemId: item.id,
                userId,
                sourceType: "external_message",
                externalMessageId: message.id,
                evidenceDigest: message.contentDigest,
            },
        });
    }
    return item;
};

const statementsOf = (result: { selected: { memory: { statement: string } }[] }) =>
    result.selected.map((row) => row.memory.statement);

beforeEach(resetData);

after(async () => {
    await resetData();
    await prisma.$disconnect();
});

test("a term query selects the relevant memory and leaves the rest", async () => {
    const user = await createUser();
    await seedMemory(user.id, "사용자는 커피를 좋아한다");
    await seedMemory(user.id, "사용자는 등산을 좋아한다");

    const result = await retrieveMemoryContext({
        userId: user.id,
        query: "커피 추천해줘",
    });
    assert.deepEqual(statementsOf(result), ["사용자는 커피를 좋아한다"]);
    assert.ok(result.resultHash.length > 0);
});

test("core and style memories are fetched even when no term matches", async () => {
    // The query/scorer agreement this file exists for: neither of these shares
    // a term with the request, and the scorer would keep both, so the SQL must
    // return both.
    const user = await createUser();
    await seedMemory(user.id, "사용자는 백엔드 엔지니어로 일한다", {
        kind: "occupation",
    });
    await seedMemory(user.id, "사용자는 존댓말을 선호한다", { kind: "tone" });
    await seedMemory(user.id, "사용자는 등산을 좋아한다");

    const result = await retrieveMemoryContext({
        userId: user.id,
        query: "quantum computing",
    });
    assert.deepEqual(statementsOf(result).sort(), [
        "사용자는 백엔드 엔지니어로 일한다",
        "사용자는 존댓말을 선호한다",
    ]);
});

test("a pinned memory is retrieved for any request", async () => {
    const user = await createUser();
    await seedMemory(user.id, "사용자는 등산을 좋아한다", { pinned: true });

    const result = await retrieveMemoryContext({
        userId: user.id,
        query: "완전히 다른 주제",
    });
    assert.deepEqual(statementsOf(result), ["사용자는 등산을 좋아한다"]);
});

test("only active memories reach a prompt", async () => {
    const user = await createUser();
    for (const status of [
        "candidate",
        "rejected",
        "superseded",
        "manual_review_required",
        "suspended_by_source_lock",
        "suspended_by_source_delete",
    ]) {
        await seedMemory(user.id, `사용자는 커피를 좋아한다 ${status}`, {
            status,
            pinned: true,
        });
    }

    const result = await retrieveMemoryContext({
        userId: user.id,
        query: "커피",
    });
    assert.deepEqual(statementsOf(result), []);
});

test("an expired memory is not even fetched", async () => {
    const user = await createUser();
    await seedMemory(user.id, "사용자는 커피를 좋아한다", {
        pinned: true,
        expiresAt: new Date("2020-01-01T00:00:00.000Z"),
    });

    const result = await retrieveMemoryContext({
        userId: user.id,
        query: "커피",
    });
    assert.deepEqual(statementsOf(result), []);
    assert.equal(result.consideredCount, 0, "filtered in SQL, not after");
});

test("the master toggle stops retrieval without touching stored memories", async () => {
    const user = await createUser();
    await seedMemory(user.id, "사용자는 커피를 좋아한다", { pinned: true });
    await putMemorySettings(user.id, {
        masterEnabled: false,
        styleEnabled: true,
        defaultConversationMode: "on",
    });

    const result = await retrieveMemoryContext({
        userId: user.id,
        query: "커피",
    });
    assert.deepEqual(statementsOf(result), []);
    assert.equal(await prisma.memoryItem.count(), 1, "nothing was deleted");
});

test("the style toggle removes style memories and keeps facts", async () => {
    const user = await createUser();
    await seedMemory(user.id, "사용자는 존댓말을 선호한다", { kind: "tone" });
    await seedMemory(user.id, "사용자는 서울에 산다", { kind: "identity" });
    await putMemorySettings(user.id, {
        masterEnabled: true,
        styleEnabled: false,
        defaultConversationMode: "on",
    });

    const result = await retrieveMemoryContext({
        userId: user.id,
        query: "무엇이든",
    });
    assert.deepEqual(statementsOf(result), ["사용자는 서울에 산다"]);
});

test("one imported conversation cannot supply the whole context", async () => {
    const user = await createUser();
    const conversation = await seedConversation(user.id);
    for (let index = 0; index < 6; index += 1) {
        await seedMemory(user.id, `사용자는 커피 취향 ${index} 를 가진다`, {
            conversationId: conversation.id,
            ordinal: index,
        });
    }

    const result = await retrieveMemoryContext({
        userId: user.id,
        query: "커피",
    });
    assert.equal(result.selected.length, 3);
    assert.equal(result.omitted.source_cap, 3);
});

test("another account's memories are never retrieved", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    await seedMemory(stranger.id, "사용자는 커피를 좋아한다", { pinned: true });

    const result = await retrieveMemoryContext({
        userId: owner.id,
        query: "커피",
    });
    assert.deepEqual(statementsOf(result), []);
});

test("the same request twice produces the same hash, and a change moves it", async () => {
    const user = await createUser();
    await seedMemory(user.id, "사용자는 커피를 좋아한다");

    const first = await retrieveMemoryContext({ userId: user.id, query: "커피" });
    const second = await retrieveMemoryContext({ userId: user.id, query: "커피" });
    assert.equal(first.resultHash, second.resultHash);

    await seedMemory(user.id, "사용자는 커피를 하루 세 잔 마신다");
    const third = await retrieveMemoryContext({ userId: user.id, query: "커피" });
    assert.notEqual(first.resultHash, third.resultHash);
});

test("retrieval never writes — a stale index stays stale until the backfill", async () => {
    // A read path that re-indexes on read turns a question into a write and
    // makes the same query non-idempotent. Fixing this row is the backfill's
    // job, not retrieval's.
    const user = await createUser();
    const item = await seedMemory(user.id, "사용자는 커피를 좋아한다", {
        pinned: true,
    });
    await prisma.memoryItem.update({
        where: { id: item.id },
        data: { searchTerms: [], retrievalVersion: 0 },
    });

    await retrieveMemoryContext({ userId: user.id, query: "커피" });
    const after = await prisma.memoryItem.findUniqueOrThrow({
        where: { id: item.id },
        select: { searchTerms: true, retrievalVersion: true, updatedAt: true },
    });
    assert.deepEqual(after.searchTerms, []);
    assert.equal(after.retrievalVersion, 0);
});
