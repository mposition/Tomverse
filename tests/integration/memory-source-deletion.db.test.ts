import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { externalContentDigest } from "@/lib/externalImportDigest";
import {
    deleteExternalConversationSnapshot,
    deleteExternalImport,
    previewExternalSourceDeletion,
} from "@/lib/externalImportService";
import { memoryRetrievalTerms } from "@/lib/memoryRetrievalTerms";
import { prisma } from "@/lib/prisma";

/**
 * §13.1 — deleting a source decides what happens to the memories made from it.
 *
 * The failure this suite exists for is silent: the foreign key cascade takes
 * the evidence rows with the messages, and a memory left behind stays
 * `active` and keeps being retrieved with nothing behind it. Every assertion
 * below is about state *after* a delete, because that is the only place the
 * bug is visible.
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
        data: { email: `memory-source-${randomUUID()}@example.test` },
    });

const seedImport = (userId: string) =>
    prisma.externalImport.create({
        data: {
            userId,
            provider: "chatgpt",
            status: "completed",
            parserVersion: "test-1",
            digestVersion: 1,
        },
    });

const seedConversation = (userId: string, importId: string) =>
    prisma.externalConversation.create({
        data: {
            userId,
            importId,
            provider: "chatgpt",
            externalStableId: randomUUID().replaceAll("-", ""),
            title: "source fixture",
            conversationDigest: randomUUID().replaceAll("-", "").repeat(2),
            digestVersion: 1,
            messageCount: 1,
            contentBytes: BigInt(10),
            finalized: true,
        },
    });

const seedMessage = (
    userId: string,
    conversationId: string,
    ordinal: number
) => {
    const content = `message ${conversationId} ${ordinal}`;
    return prisma.externalMessage.create({
        data: {
            userId,
            externalConversationId: conversationId,
            externalStableId: randomUUID().replaceAll("-", ""),
            role: "user",
            content,
            contentDigest: externalContentDigest(content),
            digestVersion: 1,
            ordinal,
        },
    });
};

/** A memory backed by the given messages, plus optional manual grounds. */
const seedMemory = async (
    userId: string,
    statement: string,
    options: {
        messageIds?: string[];
        manualGrounds?: string;
        userEdited?: boolean;
        status?: string;
    } = {}
) => {
    const item = await prisma.memoryItem.create({
        data: {
            userId,
            kind: "preference",
            statement,
            status: options.status ?? "active",
            confidence: 0.9,
            userEdited: options.userEdited ?? false,
            approvedAt: new Date("2026-08-01T00:00:00.000Z"),
            searchTerms: memoryRetrievalTerms(statement),
            retrievalVersion: 1,
        },
    });
    for (const messageId of options.messageIds ?? []) {
        await prisma.memoryEvidence.create({
            data: {
                memoryItemId: item.id,
                userId,
                sourceType: "external_message",
                externalMessageId: messageId,
                evidenceDigest: externalContentDigest(`${item.id}:${messageId}`),
            },
        });
    }
    if (options.manualGrounds) {
        await prisma.memoryEvidence.create({
            data: {
                memoryItemId: item.id,
                userId,
                sourceType: "manual",
                manualContent: options.manualGrounds,
                evidenceDigest: externalContentDigest(options.manualGrounds),
            },
        });
    }
    return item;
};

const statusOf = async (memoryId: string) =>
    (
        await prisma.memoryItem.findUnique({
            where: { id: memoryId },
            select: { status: true },
        })
    )?.status ?? null;

beforeEach(resetData);

after(async () => {
    await resetData();
    await prisma.$disconnect();
});

test("deleting a conversation removes the memory that only it backed", async () => {
    const user = await createUser();
    const importRow = await seedImport(user.id);
    const conversation = await seedConversation(user.id, importRow.id);
    const message = await seedMessage(user.id, conversation.id, 0);
    const memory = await seedMemory(user.id, "사용자는 커피를 좋아한다", {
        messageIds: [message.id],
    });

    const result = await deleteExternalConversationSnapshot(
        user.id,
        conversation.id
    );
    assert.equal(result.memory.deletedMemories, 1);
    assert.equal(await statusOf(memory.id), null, "the row is gone");
});

test("a memory backed by another conversation survives untouched", async () => {
    const user = await createUser();
    const importRow = await seedImport(user.id);
    const doomed = await seedConversation(user.id, importRow.id);
    const surviving = await seedConversation(user.id, importRow.id);
    const doomedMessage = await seedMessage(user.id, doomed.id, 0);
    const survivingMessage = await seedMessage(user.id, surviving.id, 0);
    const memory = await seedMemory(user.id, "사용자는 커피를 좋아한다", {
        messageIds: [doomedMessage.id, survivingMessage.id],
    });

    const result = await deleteExternalConversationSnapshot(user.id, doomed.id);
    assert.equal(result.memory.keptCount, 1);
    assert.equal(result.memory.deletedMemories, 0);
    assert.equal(await statusOf(memory.id), "active");
    assert.equal(
        await prisma.memoryEvidence.count({ where: { memoryItemId: memory.id } }),
        1,
        "only the evidence from the deleted conversation goes"
    );
});

test("a hand-written memory is never disturbed by deleting an import", async () => {
    const user = await createUser();
    const importRow = await seedImport(user.id);
    const conversation = await seedConversation(user.id, importRow.id);
    const message = await seedMessage(user.id, conversation.id, 0);
    const memory = await seedMemory(user.id, "사용자는 커피를 좋아한다", {
        messageIds: [message.id],
        manualGrounds: "직접 입력한 근거",
        userEdited: true,
    });

    const result = await deleteExternalImport(user.id, importRow.id);
    assert.equal(result.memory.keptCount, 1);
    assert.equal(await statusOf(memory.id), "active");
});

test("an edited memory is suspended rather than deleted", async () => {
    const user = await createUser();
    const importRow = await seedImport(user.id);
    const conversation = await seedConversation(user.id, importRow.id);
    const message = await seedMessage(user.id, conversation.id, 0);
    const memory = await seedMemory(user.id, "사용자는 커피를 좋아한다", {
        messageIds: [message.id],
        userEdited: true,
    });

    const result = await deleteExternalImport(user.id, importRow.id);
    assert.equal(result.memory.suspendedMemories, 1);
    assert.equal(result.memory.deletedMemories, 0);
    assert.equal(await statusOf(memory.id), "suspended_by_source_delete");
    assert.equal(
        (
            await prisma.memoryItem.findUniqueOrThrow({
                where: { id: memory.id },
                select: { suspendedReason: true },
            })
        ).suspendedReason,
        "suspended_by_source_delete"
    );
});

test("choosing to keep derived memories suspends them instead", async () => {
    const user = await createUser();
    const importRow = await seedImport(user.id);
    const conversation = await seedConversation(user.id, importRow.id);
    const message = await seedMessage(user.id, conversation.id, 0);
    const memory = await seedMemory(user.id, "사용자는 커피를 좋아한다", {
        messageIds: [message.id],
    });

    const result = await deleteExternalImport(user.id, importRow.id, {
        derived: "suspend",
    });
    assert.equal(result.memory.suspendedMemories, 1);
    assert.equal(await statusOf(memory.id), "suspended_by_source_delete");
});

test("deleting a whole import covers every conversation under it", async () => {
    const user = await createUser();
    const importRow = await seedImport(user.id);
    const first = await seedConversation(user.id, importRow.id);
    const second = await seedConversation(user.id, importRow.id);
    const firstMessage = await seedMessage(user.id, first.id, 0);
    const secondMessage = await seedMessage(user.id, second.id, 0);
    await seedMemory(user.id, "첫 번째 기억", { messageIds: [firstMessage.id] });
    await seedMemory(user.id, "두 번째 기억", { messageIds: [secondMessage.id] });

    const result = await deleteExternalImport(user.id, importRow.id);
    assert.equal(result.memory.deletedMemories, 2);
    assert.equal(await prisma.memoryItem.count({ where: { userId: user.id } }), 0);
});

test("an archived memory keeps the status that says why it left", async () => {
    // Overwriting `rejected` with `suspended_by_source_delete` would replace
    // the true reason with a different one, and the row is out of retrieval
    // either way.
    const user = await createUser();
    const importRow = await seedImport(user.id);
    const conversation = await seedConversation(user.id, importRow.id);
    const message = await seedMessage(user.id, conversation.id, 0);
    const memory = await seedMemory(user.id, "거절된 기억", {
        messageIds: [message.id],
        userEdited: true,
        status: "rejected",
    });

    await deleteExternalImport(user.id, importRow.id);
    assert.equal(await statusOf(memory.id), "rejected");
});

test("another account's memories are never touched", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const ownerImport = await seedImport(owner.id);
    const ownerConversation = await seedConversation(owner.id, ownerImport.id);
    const ownerMessage = await seedMessage(owner.id, ownerConversation.id, 0);
    await seedMemory(owner.id, "소유자 기억", { messageIds: [ownerMessage.id] });
    const strangerMemory = await seedMemory(stranger.id, "다른 계정 기억");

    await deleteExternalImport(owner.id, ownerImport.id);
    assert.equal(await statusOf(strangerMemory.id), "active");
});

test("the preview reports what the delete will do, before it does it", async () => {
    const user = await createUser();
    const importRow = await seedImport(user.id);
    const conversation = await seedConversation(user.id, importRow.id);
    const derivedMessage = await seedMessage(user.id, conversation.id, 0);
    const editedMessage = await seedMessage(user.id, conversation.id, 1);
    const backedMessage = await seedMessage(user.id, conversation.id, 2);
    await seedMemory(user.id, "파생 기억", { messageIds: [derivedMessage.id] });
    await seedMemory(user.id, "편집한 기억", {
        messageIds: [editedMessage.id],
        userEdited: true,
    });
    await seedMemory(user.id, "근거가 남는 기억", {
        messageIds: [backedMessage.id],
        manualGrounds: "직접 입력",
    });

    const preview = await previewExternalSourceDeletion(user.id, {
        importId: importRow.id,
    });
    assert.deepEqual(preview, {
        derivedCount: 1,
        userTouchedCount: 1,
        keptCount: 1,
    });

    const result = await deleteExternalImport(user.id, importRow.id);
    assert.equal(result.memory.derivedCount, preview.derivedCount);
    assert.equal(result.memory.userTouchedCount, preview.userTouchedCount);
    assert.equal(result.memory.keptCount, preview.keptCount);
});

test("the preview reads nothing when a source has no memories", async () => {
    const user = await createUser();
    const importRow = await seedImport(user.id);
    await seedConversation(user.id, importRow.id);

    assert.deepEqual(
        await previewExternalSourceDeletion(user.id, { importId: importRow.id }),
        { derivedCount: 0, userTouchedCount: 0, keptCount: 0 }
    );
});

test("cancelling an unfinished import touches no memory", async () => {
    const user = await createUser();
    const importRow = await prisma.externalImport.create({
        data: {
            userId: user.id,
            provider: "chatgpt",
            status: "staging",
            parserVersion: "test-1",
            digestVersion: 1,
        },
    });
    const finalized = await seedConversation(user.id, importRow.id);
    const message = await seedMessage(user.id, finalized.id, 0);
    const memory = await seedMemory(user.id, "완료된 대화의 기억", {
        messageIds: [message.id],
    });

    const result = await deleteExternalImport(user.id, importRow.id);
    assert.equal(result.outcome, "cancelled");
    assert.equal(
        await statusOf(memory.id),
        "active",
        "cancelling an upload is not deleting the account's imported data"
    );
});
