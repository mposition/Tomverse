import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { externalContentDigest } from "@/lib/externalImportDigest";
import {
    deleteExternalConversationSnapshot,
    deleteExternalImport,
    previewExternalSourceDeletion,
} from "@/lib/externalImportService";
import { verifyExternalMessageEvidence } from "@/lib/memoryEvidenceValidation";
import {
    approveMemory,
    bulkApproveMemories,
    createManualMemory,
    deleteMemory,
    editMemory,
    rejectMemory,
    setMemoryPinned,
} from "@/lib/memoryService";
import { reconcileExpiredMemories } from "@/lib/memoryExpiryService";
import {
    reconcileSourceLockedMemories,
    setExternalConversationLock,
} from "@/lib/externalConversationLockService";
import { lockAccountMemoryItems } from "@/lib/memoryItemLock";
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

/* ------------------------------ memory lock serialisation (MEM-SOURCE-DELETE-01) */

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolves once some session is waiting for THIS account's memory lock, and
 * fails if none does within the deadline. A barrier on the database's own
 * state, not a sleep: the transaction under test has provably reached the lock,
 * and without the lock it never waits, so the test fails rather than passing by
 * timing.
 *
 * The key is matched exactly. A bigint advisory key shows its high half in
 * `classid` and its low half in `objid`, with `objsubid` 1; any other
 * session waiting on any other advisory lock (credit account, import) is not
 * evidence that this one arrived.
 *
 * The deadline is under Prisma's default interactive-transaction timeout of
 * five seconds, which the writers under test run with: if the barrier cannot
 * see the waiter, it says so before the waiter is rolled back for a reason that
 * has nothing to do with the lock.
 */
const untilTheMemoryLockIsAwaited = async (userId: string, deadlineMs = 4_000) => {
    const key = "memory-items:" + userId;
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        const rows = await prisma.$queryRaw<Array<{ waiting: bigint }>>`
            SELECT count(*)::bigint AS waiting
            FROM pg_locks
            WHERE locktype = 'advisory'
              AND NOT granted
              AND objsubid = 1
              AND classid = ((hashtext(${key})::bigint >> 32) & 4294967295)::oid
              AND objid = (hashtext(${key})::bigint & 4294967295)::oid
        `;
        if (Number(rows[0]?.waiting ?? 0) > 0) return;
        await pause(20);
    }
    assert.fail("no transaction waited for this account's memory lock");
};

/**
 * Holds `userId`'s memory lock in an open transaction, running `body` inside
 * it first, until `release()` is called.
 */
const holdMemoryLock = <T>(
    userId: string,
    body: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>
) => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });
    let signalHeld!: (value: T) => void;
    const held = new Promise<T>((resolve) => {
        signalHeld = resolve;
    });
    const committed = prisma.$transaction(
        async (tx) => {
            await lockAccountMemoryItems(tx, userId);
            const value = await body(tx);
            signalHeld(value);
            await released;
            return value;
        },
        { timeout: 30_000 }
    );
    return { held, release, committed };
};

/** An extraction chunk's write: a candidate and its evidence, as persistence writes them. */
const writeCandidate = async (
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
    userId: string,
    messageId: string
) => {
    const statement = "사용자는 새벽에 일한다";
    const item = await tx.memoryItem.create({
        data: {
            userId,
            kind: "preference",
            statement,
            status: "candidate",
            confidence: 0.8,
            userEdited: false,
            searchTerms: memoryRetrievalTerms(statement),
            retrievalVersion: 1,
        },
    });
    await tx.memoryEvidence.create({
        data: {
            memoryItemId: item.id,
            userId,
            sourceType: "external_message",
            externalMessageId: messageId,
            evidenceDigest: externalContentDigest(`${item.id}:${messageId}`),
        },
    });
    return item.id;
};

for (const [label, runDelete] of [
    [
        "single-snapshot",
        (userId: string, _importId: string, conversationId: string) =>
            deleteExternalConversationSnapshot(userId, conversationId),
    ],
    [
        "whole-import",
        (userId: string, importId: string) => deleteExternalImport(userId, importId),
    ],
] as const) {
    test(`a ${label} delete waits for an in-flight extraction write, then removes what it wrote`, async () => {
        /*
          Before the shared memory lock, the deletion classified the source's
          memories without waiting: this candidate was not yet committed, so it
          was not classified; the extraction then committed it; and the cascade
          took only its evidence. A source-derived statement stayed behind with
          nothing grounding it and no sweep to find it.
        */
        const user = await createUser();
        const importRow = await seedImport(user.id);
        const conversation = await seedConversation(user.id, importRow.id);
        const message = await seedMessage(user.id, conversation.id, 0);

        const extraction = holdMemoryLock(user.id, (tx) =>
            writeCandidate(tx, user.id, message.id)
        );
        const candidateId = await extraction.held;

        const deletion = runDelete(user.id, importRow.id, conversation.id);
        await untilTheMemoryLockIsAwaited(user.id);

        extraction.release();
        await extraction.committed;
        const result = await deletion;

        assert.equal(result.memory.deletedMemories, 1, "the late candidate was classified");
        assert.equal(await statusOf(candidateId), null, "a derived candidate is deleted by default");
        assert.equal(
            await prisma.memoryItem.count({ where: { userId: user.id } }),
            0,
            "no source-derived statement remains"
        );
    });
}

test("an edit committed while a deletion waits is seen as user-touched and suspended, not deleted", async () => {
    // The stale-plan failure: a deletion that classified this memory as derived
    // and then acted after an edit would delete the user's own words.
    const user = await createUser();
    const importRow = await seedImport(user.id);
    const conversation = await seedConversation(user.id, importRow.id);
    const message = await seedMessage(user.id, conversation.id, 0);
    const memory = await seedMemory(user.id, "사용자는 아침형이다", {
        messageIds: [message.id],
    });

    const edit = holdMemoryLock(user.id, (tx) =>
        tx.memoryItem.update({
            where: { id: memory.id },
            data: { statement: "사용자는 저녁형이다", userEdited: true },
        })
    );
    await edit.held;
    const deletion = deleteExternalConversationSnapshot(user.id, conversation.id);
    await untilTheMemoryLockIsAwaited(user.id);
    edit.release();
    await edit.committed;
    const result = await deletion;

    assert.equal(result.memory.deletedMemories, 0);
    assert.equal(await statusOf(memory.id), "suspended_by_source_delete");
});

for (const [label, runWriter] of [
    [
        "editMemory",
        (userId: string, memoryId: string) =>
            editMemory({ userId, memoryId, statement: "사용자는 차를 좋아한다" }),
    ],
    ["rejectMemory", (userId: string, memoryId: string) => rejectMemory(userId, memoryId)],
    ["setMemoryPinned", (userId: string, memoryId: string) => setMemoryPinned(userId, memoryId, true)],
    ["deleteMemory", (userId: string, memoryId: string) => deleteMemory(userId, memoryId)],
    ["reconcileExpiredMemories", () => reconcileExpiredMemories(new Date("2030-01-01T00:00:00.000Z"))],
    ["approveMemory", (userId: string, memoryId: string) => approveMemory({ userId, memoryId })],
    ["bulkApproveMemories", (userId: string) => bulkApproveMemories(userId)],
    [
        "createManualMemory",
        (userId: string) =>
            createManualMemory({
                userId,
                kind: "preference",
                statement: "사용자는 녹차를 좋아한다",
                groundsText: "사용자가 직접 말함",
            }),
    ],
    ["reconcileSourceLockedMemories", () => reconcileSourceLockedMemories()],
] as const) {
    test(`${label} waits for the account memory lock`, async () => {
        const user = await createUser();
        const status = ["rejectMemory", "approveMemory", "bulkApproveMemories"].includes(label)
            ? "candidate"
            : label === "reconcileSourceLockedMemories"
              ? "suspended_by_source_lock"
              : "active";
        const memory = await seedMemory(user.id, "사용자는 커피를 좋아한다", {
            manualGrounds: "사용자가 직접 말함",
            status,
        });
        if (label === "reconcileExpiredMemories") {
            await prisma.memoryItem.update({
                where: { id: memory.id },
                data: { expiresAt: new Date("2029-01-01T00:00:00.000Z") },
            });
        }
        const holder = holdMemoryLock(user.id, async () => null);
        await holder.held;
        const writer = runWriter(user.id, memory.id);
        await untilTheMemoryLockIsAwaited(user.id);
        holder.release();
        await holder.committed;
        await writer;
    });
}

test("bulk approval decides on the evidence as it is after the lock, not as it was before", async () => {
    // The race the confirmation review found: bulk approval validated a
    // candidate's evidence without the lock, a source deletion then removed
    // that evidence, and the approval committed anyway on its stale reading.
    // Here the holder removes the evidence while bulk approval waits.
    const user = await createUser();
    const importRow = await seedImport(user.id);
    const conversation = await seedConversation(user.id, importRow.id);
    const message = await seedMessage(user.id, conversation.id, 0);
    const memory = await seedMemory(user.id, "사용자는 커피를 좋아한다", {
        messageIds: [message.id],
        status: "candidate",
    });

    const holder = holdMemoryLock(user.id, (tx) =>
        tx.memoryEvidence.deleteMany({ where: { memoryItemId: memory.id } })
    );
    await holder.held;
    const approval = bulkApproveMemories(user.id);
    await untilTheMemoryLockIsAwaited(user.id);
    holder.release();
    await holder.committed;
    const result = await approval;

    assert.deepEqual(result, { approved: 0, skipped: 1 });
    assert.equal(await statusOf(memory.id), "candidate", "no evidence, so not approved");
});

test("setExternalConversationLock waits for the account memory lock", async () => {
    const user = await createUser();
    const importRow = await seedImport(user.id);
    const conversation = await seedConversation(user.id, importRow.id);
    const holder = holdMemoryLock(user.id, async () => null);
    await holder.held;
    const locking = setExternalConversationLock({
        userId: user.id,
        conversationId: conversation.id,
        passwordHash: "hash-for-test",
    });
    await untilTheMemoryLockIsAwaited(user.id);
    holder.release();
    await holder.committed;
    const result = await locking;
    assert.equal(result.locked, true);
});

test("deleting a locked source moves its lock-suspended memory to source-delete, and the lock sweep leaves it there", async () => {
    // Before, the lock suspension was not a suspendable status: the delete left
    // it as `suspended_by_source_lock` with no evidence, and the next lock
    // reconciliation -- which treats no evidence as not blocked -- restored it
    // to `active` with nothing behind it.
    const user = await createUser();
    const importRow = await seedImport(user.id);
    const conversation = await seedConversation(user.id, importRow.id);
    const message = await seedMessage(user.id, conversation.id, 0);
    const memory = await seedMemory(user.id, "사용자는 주말에 등산한다", {
        messageIds: [message.id],
        userEdited: true,
        status: "suspended_by_source_lock",
    });
    await prisma.externalConversation.update({
        where: { id: conversation.id },
        data: { password: "hash-for-test" },
    });

    const result = await deleteExternalConversationSnapshot(user.id, conversation.id);
    assert.equal(result.memory.suspendedMemories, 1);
    assert.equal(await statusOf(memory.id), "suspended_by_source_delete");

    await reconcileSourceLockedMemories();
    assert.equal(await statusOf(memory.id), "suspended_by_source_delete");
});

test("an extraction that reaches the memory lock after a deletion stores nothing from the deleted source", async () => {
    const user = await createUser();
    const importRow = await seedImport(user.id);
    const conversation = await seedConversation(user.id, importRow.id);
    const message = await seedMessage(user.id, conversation.id, 0);

    await deleteExternalConversationSnapshot(user.id, conversation.id);

    // The persistence step re-verifies evidence under the same lock; the
    // message is gone, so there is nothing to ground a candidate in.
    const outcomes = await prisma.$transaction(async (tx) => {
        await lockAccountMemoryItems(tx, user.id);
        return verifyExternalMessageEvidence(
            user.id,
            [{ externalMessageId: message.id, evidenceDigest: message.contentDigest }],
            tx
        );
    });
    assert.equal(outcomes[0]?.outcome, "not_found");
});

test("a deletion does not wait on an unrelated account's memory lock", async () => {
    const owner = await createUser();
    const other = await createUser();
    const importRow = await seedImport(owner.id);
    const conversation = await seedConversation(owner.id, importRow.id);
    await seedMessage(owner.id, conversation.id, 0);

    const holder = holdMemoryLock(other.id, async () => null);
    await holder.held;
    try {
        const result = await Promise.race([
            deleteExternalConversationSnapshot(owner.id, conversation.id),
            pause(5_000).then(() => "timed out" as const),
        ]);
        assert.notEqual(result, "timed out", "another account's lock is not this deletion's");
    } finally {
        holder.release();
        await holder.committed;
    }
});
