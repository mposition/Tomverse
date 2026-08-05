import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import {
    ConversationLockError,
    createConversationUnlockCookie,
    createResourceUnlockCookie,
    hashConversationPassword,
} from "@/lib/conversationLock";
import {
    previewExternalConversationLock,
    reconcileSourceLockedMemories,
    setExternalConversationLock,
} from "@/lib/externalConversationLockService";
import { externalContentDigest } from "@/lib/externalImportDigest";
import {
    deleteExternalConversationSnapshot,
    getExternalConversation,
} from "@/lib/externalImportService";
import { retrieveMemoryContext } from "@/lib/memoryRetrievalService";
import { memoryRetrievalTerms } from "@/lib/memoryRetrievalTerms";
import { putMemorySettings } from "@/lib/memoryService";
import { prisma } from "@/lib/prisma";

/**
 * §7, §7.1 — locking an imported snapshot suspends the memories it is the
 * last reachable evidence for, and unlocking brings them back.
 *
 * The two halves are asserted separately on purpose. The status transition is
 * what the owner sees on the review screen; the retrieval exclusion is what
 * decides whether a locked conversation can still shape an answer. A change
 * that fixes one and breaks the other looks fine from either side alone.
 */

const PASSWORD = "lock-this-source-1";

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
        data: { email: `source-lock-${randomUUID()}@example.test` },
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

const seedConversation = (
    userId: string,
    importId: string,
    finalized = true
) =>
    prisma.externalConversation.create({
        data: {
            userId,
            importId,
            provider: "chatgpt",
            externalStableId: randomUUID().replaceAll("-", ""),
            title: "lock fixture",
            conversationDigest: randomUUID().replaceAll("-", "").repeat(2),
            digestVersion: 1,
            messageCount: 1,
            contentBytes: BigInt(10),
            finalized,
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

const seedMemory = async (
    userId: string,
    statement: string,
    options: {
        messageIds?: string[];
        manualGrounds?: string;
        status?: string;
        expiresAt?: Date;
        kind?: string;
    } = {}
) => {
    const item = await prisma.memoryItem.create({
        data: {
            userId,
            kind: options.kind ?? "preference",
            statement,
            status: options.status ?? "active",
            confidence: 0.9,
            approvedAt: new Date("2026-08-01T00:00:00.000Z"),
            expiresAt: options.expiresAt ?? null,
            suspendedReason:
                options.status === "suspended_by_source_lock"
                    ? "suspended_by_source_lock"
                    : null,
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

const memoryRow = async (memoryId: string) =>
    prisma.memoryItem.findUnique({
        where: { id: memoryId },
        select: { status: true, suspendedReason: true },
    });

const enableMemory = (userId: string) =>
    putMemorySettings(userId, {
        masterEnabled: true,
        styleEnabled: true,
        defaultConversationMode: "on",
    });

/** A user with one finalized snapshot holding one message. */
const seedSource = async () => {
    const user = await createUser();
    const importRow = await seedImport(user.id);
    const conversation = await seedConversation(user.id, importRow.id);
    const message = await seedMessage(user.id, conversation.id, 0);
    return { user, importRow, conversation, message };
};

beforeEach(resetData);

after(async () => {
    await resetData();
    await prisma.$disconnect();
});

/* ------------------------------------------------------------------ locking */

test("locking a snapshot suspends the memory only it backed", async () => {
    const { user, conversation, message } = await seedSource();
    const memory = await seedMemory(user.id, "사용자는 커피를 좋아한다", {
        messageIds: [message.id],
    });

    const result = await setExternalConversationLock({
        userId: user.id,
        conversationId: conversation.id,
        passwordHash: await hashConversationPassword(PASSWORD),
    });

    assert.equal(result.locked, true);
    assert.equal(result.memoriesSuspended, 1);
    assert.deepEqual(await memoryRow(memory.id), {
        status: "suspended_by_source_lock",
        suspendedReason: "suspended_by_source_lock",
    });
});

test("a memory with another unlocked source stays active", async () => {
    const { user, importRow, conversation, message } = await seedSource();
    const other = await seedConversation(user.id, importRow.id);
    const otherMessage = await seedMessage(user.id, other.id, 0);
    const memory = await seedMemory(user.id, "사용자는 서울에 산다", {
        messageIds: [message.id, otherMessage.id],
    });

    const result = await setExternalConversationLock({
        userId: user.id,
        conversationId: conversation.id,
        passwordHash: await hashConversationPassword(PASSWORD),
    });

    assert.equal(result.memoriesSuspended, 0);
    assert.equal((await memoryRow(memory.id))?.status, "active");

    // Locking the second one takes the last reachable source with it.
    const second = await setExternalConversationLock({
        userId: user.id,
        conversationId: other.id,
        passwordHash: await hashConversationPassword(PASSWORD),
    });
    assert.equal(second.memoriesSuspended, 1);
    assert.equal(
        (await memoryRow(memory.id))?.status,
        "suspended_by_source_lock"
    );
});

test("manual grounds keep a memory active however many imports are locked", async () => {
    const { user, conversation, message } = await seedSource();
    const memory = await seedMemory(user.id, "사용자는 채식을 한다", {
        messageIds: [message.id],
        manualGrounds: "직접 적은 근거",
    });

    const result = await setExternalConversationLock({
        userId: user.id,
        conversationId: conversation.id,
        passwordHash: await hashConversationPassword(PASSWORD),
    });
    assert.equal(result.memoriesSuspended, 0);
    assert.equal((await memoryRow(memory.id))?.status, "active");
});

test("a candidate is not suspended by a lock", async () => {
    const { user, conversation, message } = await seedSource();
    const memory = await seedMemory(user.id, "검토 대기 중인 기억", {
        messageIds: [message.id],
        status: "candidate",
    });

    await setExternalConversationLock({
        userId: user.id,
        conversationId: conversation.id,
        passwordHash: await hashConversationPassword(PASSWORD),
    });
    assert.equal(
        (await memoryRow(memory.id))?.status,
        "candidate",
        "a restore must never promote something the user did not approve"
    );
});

test("another account's memory is untouched by this account's lock", async () => {
    const mine = await seedSource();
    const theirs = await seedSource();
    const theirMemory = await seedMemory(theirs.user.id, "다른 계정의 기억", {
        messageIds: [theirs.message.id],
    });

    await setExternalConversationLock({
        userId: mine.user.id,
        conversationId: mine.conversation.id,
        passwordHash: await hashConversationPassword(PASSWORD),
    });
    assert.equal((await memoryRow(theirMemory.id))?.status, "active");
});

test("a non-owner cannot lock a snapshot", async () => {
    const { conversation } = await seedSource();
    const stranger = await createUser();

    await assert.rejects(
        setExternalConversationLock({
            userId: stranger.id,
            conversationId: conversation.id,
            passwordHash: await hashConversationPassword(PASSWORD),
        }),
        /not found/i
    );
    const row = await prisma.externalConversation.findUnique({
        where: { id: conversation.id },
        select: { password: true },
    });
    assert.equal(row?.password, null);
});

test("an unfinalized snapshot cannot be locked", async () => {
    const user = await createUser();
    const importRow = await seedImport(user.id);
    const staging = await seedConversation(user.id, importRow.id, false);

    await assert.rejects(
        setExternalConversationLock({
            userId: user.id,
            conversationId: staging.id,
            passwordHash: await hashConversationPassword(PASSWORD),
        }),
        /not found/i
    );
});

/* ---------------------------------------------------------------- unlocking */

test("unlocking restores the memories the lock suspended", async () => {
    const { user, conversation, message } = await seedSource();
    const memory = await seedMemory(user.id, "사용자는 커피를 좋아한다", {
        messageIds: [message.id],
    });

    await setExternalConversationLock({
        userId: user.id,
        conversationId: conversation.id,
        passwordHash: await hashConversationPassword(PASSWORD),
    });
    const result = await setExternalConversationLock({
        userId: user.id,
        conversationId: conversation.id,
        passwordHash: null,
    });

    assert.equal(result.locked, false);
    assert.equal(result.memoriesRestored, 1);
    assert.deepEqual(await memoryRow(memory.id), {
        status: "active",
        suspendedReason: null,
    });
});

test("unlocking does not resurrect a memory suspended by a source delete", async () => {
    const { user, conversation, message } = await seedSource();
    const memory = await seedMemory(user.id, "삭제된 출처의 기억", {
        messageIds: [message.id],
        status: "suspended_by_source_delete",
    });

    await setExternalConversationLock({
        userId: user.id,
        conversationId: conversation.id,
        passwordHash: await hashConversationPassword(PASSWORD),
    });
    const result = await setExternalConversationLock({
        userId: user.id,
        conversationId: conversation.id,
        passwordHash: null,
    });

    assert.equal(result.memoriesRestored, 0);
    assert.equal(
        (await memoryRow(memory.id))?.status,
        "suspended_by_source_delete",
        "§8.3 gives that status no automatic way back"
    );
});

test("a memory that expired while suspended is expired rather than restored", async () => {
    const { user, conversation, message } = await seedSource();
    const memory = await seedMemory(user.id, "기간이 지난 기억", {
        messageIds: [message.id],
        expiresAt: new Date("2026-08-02T00:00:00.000Z"),
    });

    await setExternalConversationLock({
        userId: user.id,
        conversationId: conversation.id,
        passwordHash: await hashConversationPassword(PASSWORD),
        now: new Date("2026-08-01T00:00:00.000Z"),
    });
    const result = await setExternalConversationLock({
        userId: user.id,
        conversationId: conversation.id,
        passwordHash: null,
        now: new Date("2026-08-03T00:00:00.000Z"),
    });

    assert.equal(result.memoriesExpired, 1);
    assert.equal(result.memoriesRestored, 0);
    assert.equal((await memoryRow(memory.id))?.status, "expired");
});

test("changing the password of a locked snapshot leaves memories suspended", async () => {
    const { user, conversation, message } = await seedSource();
    const memory = await seedMemory(user.id, "잠금 상태 유지", {
        messageIds: [message.id],
    });

    await setExternalConversationLock({
        userId: user.id,
        conversationId: conversation.id,
        passwordHash: await hashConversationPassword(PASSWORD),
    });
    const result = await setExternalConversationLock({
        userId: user.id,
        conversationId: conversation.id,
        passwordHash: await hashConversationPassword("a-different-password"),
    });

    assert.equal(result.memoriesSuspended, 0);
    assert.equal(result.memoriesRestored, 0);
    assert.equal(
        (await memoryRow(memory.id))?.status,
        "suspended_by_source_lock"
    );
});

/* ---------------------------------------------------------------- retrieval */

test("a locked source's memory is excluded from retrieval even if its status was missed", async () => {
    const { user, conversation, message } = await seedSource();
    await enableMemory(user.id);
    const memory = await seedMemory(user.id, "사용자는 커피를 좋아한다", {
        messageIds: [message.id],
    });

    const before = await retrieveMemoryContext({
        userId: user.id,
        query: "커피 추천해줘",
    });
    assert.ok(
        before.selected.some((item) => item.memory.id === memory.id),
        "the fixture has to be retrievable before the lock for this to prove anything"
    );

    // The lock is written directly, without the service, so the memory keeps
    // its `active` status: this is the drift case the query filter exists for.
    await prisma.externalConversation.update({
        where: { id: conversation.id },
        data: { password: await hashConversationPassword(PASSWORD) },
    });

    const after = await retrieveMemoryContext({
        userId: user.id,
        query: "커피 추천해줘",
    });
    assert.equal((await memoryRow(memory.id))?.status, "active");
    assert.equal(
        after.selected.some((item) => item.memory.id === memory.id),
        false,
        "a locked conversation must not shape an answer"
    );
});

test("retrieval keeps a memory whose evidence is only partly locked", async () => {
    const { user, importRow, conversation, message } = await seedSource();
    await enableMemory(user.id);
    const other = await seedConversation(user.id, importRow.id);
    const otherMessage = await seedMessage(user.id, other.id, 0);
    const memory = await seedMemory(user.id, "사용자는 커피를 좋아한다", {
        messageIds: [message.id, otherMessage.id],
    });

    await setExternalConversationLock({
        userId: user.id,
        conversationId: conversation.id,
        passwordHash: await hashConversationPassword(PASSWORD),
    });

    const result = await retrieveMemoryContext({
        userId: user.id,
        query: "커피 추천해줘",
    });
    assert.ok(result.selected.some((item) => item.memory.id === memory.id));
});

test("retrieval keeps a memory with no evidence rows at all", async () => {
    // The §13.1 shape. Its fate belongs to the source-delete path, and a lock
    // elsewhere in the account must not take it out of retrieval as a side
    // effect of a filter written for locks.
    const user = await createUser();
    await enableMemory(user.id);
    const memory = await seedMemory(user.id, "사용자는 커피를 좋아한다");

    const result = await retrieveMemoryContext({
        userId: user.id,
        query: "커피 추천해줘",
    });
    assert.ok(result.selected.some((item) => item.memory.id === memory.id));
});

/* ------------------------------------------------------------- reading it */

test("a locked snapshot's content is refused without a grant", async () => {
    const { user, conversation } = await seedSource();
    await setExternalConversationLock({
        userId: user.id,
        conversationId: conversation.id,
        passwordHash: await hashConversationPassword(PASSWORD),
    });

    await assert.rejects(
        getExternalConversation(user.id, conversation.id, {
            request: new Request("https://tomverse.test/"),
        }),
        (error: unknown) =>
            error instanceof ConversationLockError &&
            error.status === 423 &&
            error.code === "CONVERSATION_LOCKED"
    );
});

test("the owner's unlock grant opens their own locked snapshot", async () => {
    const { user, conversation } = await seedSource();
    const passwordHash = await hashConversationPassword(PASSWORD);
    await setExternalConversationLock({
        userId: user.id,
        conversationId: conversation.id,
        passwordHash,
    });

    const cookie = createResourceUnlockCookie(
        "external_conversation",
        user.id,
        conversation.id,
        passwordHash
    ).split(";")[0];
    const view = await getExternalConversation(user.id, conversation.id, {
        request: new Request("https://tomverse.test/", {
            headers: { cookie },
        }),
    });
    assert.equal(view.messages.length, 1);
});

test("a grant for the native conversation namespace does not open a snapshot", async () => {
    // The ids come from different tables and can collide. Asserted here as
    // well as in the unit suite because this is the call that would leak.
    const { user, conversation } = await seedSource();
    const passwordHash = await hashConversationPassword(PASSWORD);
    await setExternalConversationLock({
        userId: user.id,
        conversationId: conversation.id,
        passwordHash,
    });

    const cookie = createConversationUnlockCookie(
        user.id,
        conversation.id,
        passwordHash
    ).split(";")[0];
    await assert.rejects(
        getExternalConversation(user.id, conversation.id, {
            request: new Request("https://tomverse.test/", {
                headers: { cookie },
            }),
        }),
        (error: unknown) => error instanceof ConversationLockError
    );
});

test("an unlocked snapshot needs no grant at all", async () => {
    const { user, conversation } = await seedSource();
    const view = await getExternalConversation(user.id, conversation.id, {
        request: new Request("https://tomverse.test/"),
    });
    assert.equal(view.messages.length, 1);
});

test("the owner can still delete a locked snapshot", async () => {
    // §13.1 and §15: the lock protects content, not the owner's right to
    // remove their own imported data. Gating this would make a forgotten
    // password permanent.
    const { user, conversation, message } = await seedSource();
    await seedMemory(user.id, "잠긴 출처의 기억", {
        messageIds: [message.id],
    });
    await setExternalConversationLock({
        userId: user.id,
        conversationId: conversation.id,
        passwordHash: await hashConversationPassword(PASSWORD),
    });

    await deleteExternalConversationSnapshot(user.id, conversation.id);
    assert.equal(
        await prisma.externalConversation.findUnique({
            where: { id: conversation.id },
        }),
        null
    );
});

/* ----------------------------------------------------------- reconciliation */

test("reconciliation suspends an active memory whose sources are all locked", async () => {
    const { user, conversation, message } = await seedSource();
    const memory = await seedMemory(user.id, "표류 상태의 기억", {
        messageIds: [message.id],
    });
    // Lock written behind the service's back: exactly the partial failure §7.1
    // asks reconciliation to detect.
    await prisma.externalConversation.update({
        where: { id: conversation.id },
        data: { password: await hashConversationPassword(PASSWORD) },
    });

    const result = await reconcileSourceLockedMemories();
    assert.equal(result.memoriesSuspended, 1);
    assert.equal(
        (await memoryRow(memory.id))?.status,
        "suspended_by_source_lock"
    );
});

test("reconciliation restores a memory left suspended after its source came back", async () => {
    const { user, conversation, message } = await seedSource();
    await prisma.externalConversation.update({
        where: { id: conversation.id },
        data: { password: await hashConversationPassword(PASSWORD) },
    });
    const memory = await seedMemory(user.id, "복구되어야 하는 기억", {
        messageIds: [message.id],
        status: "suspended_by_source_lock",
    });
    await prisma.externalConversation.update({
        where: { id: conversation.id },
        data: { password: null },
    });

    const result = await reconcileSourceLockedMemories();
    assert.equal(result.memoriesRestored, 1);
    assert.deepEqual(await memoryRow(memory.id), {
        status: "active",
        suspendedReason: null,
    });
});

test("reconciliation is idempotent and leaves a consistent account alone", async () => {
    const { user, conversation, message } = await seedSource();
    const memory = await seedMemory(user.id, "일관된 기억", {
        messageIds: [message.id],
    });
    await setExternalConversationLock({
        userId: user.id,
        conversationId: conversation.id,
        passwordHash: await hashConversationPassword(PASSWORD),
    });

    const first = await reconcileSourceLockedMemories();
    assert.deepEqual(
        {
            suspended: first.memoriesSuspended,
            restored: first.memoriesRestored,
            expired: first.memoriesExpired,
        },
        { suspended: 0, restored: 0, expired: 0 }
    );
    const second = await reconcileSourceLockedMemories();
    assert.equal(second.memoriesSuspended, 0);
    assert.equal(
        (await memoryRow(memory.id))?.status,
        "suspended_by_source_lock"
    );
});

test("reconciliation converges two accounts in opposite directions in one sweep", async () => {
    const drifting = await seedSource();
    const stuck = await seedSource();
    const driftingMemory = await seedMemory(drifting.user.id, "잠겨야 하는 기억", {
        messageIds: [drifting.message.id],
    });
    await prisma.externalConversation.update({
        where: { id: drifting.conversation.id },
        data: { password: await hashConversationPassword(PASSWORD) },
    });
    const stuckMemory = await seedMemory(stuck.user.id, "풀려야 하는 기억", {
        messageIds: [stuck.message.id],
        status: "suspended_by_source_lock",
    });

    const result = await reconcileSourceLockedMemories();
    assert.equal(result.memoriesSuspended, 1);
    assert.equal(result.memoriesRestored, 1);
    assert.equal(
        (await memoryRow(driftingMemory.id))?.status,
        "suspended_by_source_lock"
    );
    assert.equal((await memoryRow(stuckMemory.id))?.status, "active");
});

/* -------------------------------------------------------------------preview */

test("the preview counts what locking would take before it is locked", async () => {
    const { user, importRow, conversation, message } = await seedSource();
    const other = await seedConversation(user.id, importRow.id);
    const otherMessage = await seedMessage(user.id, other.id, 0);
    await seedMemory(user.id, "이 출처만 있는 기억", {
        messageIds: [message.id],
    });
    await seedMemory(user.id, "다른 출처도 있는 기억", {
        messageIds: [message.id, otherMessage.id],
    });
    await seedMemory(user.id, "직접 쓴 근거가 있는 기억", {
        messageIds: [message.id],
        manualGrounds: "직접 적은 근거",
    });

    const impact = await previewExternalConversationLock(
        user.id,
        conversation.id
    );
    assert.deepEqual(impact, { blockedCount: 1, backedCount: 2 });

    // A preview must not be a write.
    const row = await prisma.externalConversation.findUnique({
        where: { id: conversation.id },
        select: { password: true },
    });
    assert.equal(row?.password, null);
});

test("the preview tells a non-owner nothing", async () => {
    const { conversation, message, user } = await seedSource();
    await seedMemory(user.id, "이 출처만 있는 기억", {
        messageIds: [message.id],
    });
    const stranger = await createUser();

    assert.deepEqual(
        await previewExternalConversationLock(stranger.id, conversation.id),
        { blockedCount: 0, backedCount: 0 }
    );
});
