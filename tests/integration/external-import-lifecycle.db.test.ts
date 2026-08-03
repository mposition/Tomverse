import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { ApiSecurityError } from "@/lib/apiSecurity";
import {
    appendExternalImportBatch,
    createExternalImport,
    deleteExternalImport,
    finalizeExternalImport,
    getExternalImportCapacity,
    getExternalImportStatus,
    reconcileExpiredExternalImportStaging,
} from "@/lib/externalImportService";
import {
    EXTERNAL_IMPORT_STORAGE_LIMITS,
    EXTERNAL_IMPORT_TRUNCATION_MARKER,
} from "@/lib/externalImportLimits";
import { prisma } from "@/lib/prisma";

/**
 * Release A staging/finalize lifecycle (A1b) against a real database:
 * the batch ledger, server-side digest/truncation, duplicate skips,
 * all-or-nothing finalize idempotency, deletion and the staging TTL sweep
 * (policy §5.3–§5.5, §18).
 */

const resetData = async () => {
    await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ExternalMessage",
      "ExternalConversation",
      "ExternalImport"
    RESTART IDENTITY CASCADE
  `);
};

const createUser = () =>
    prisma.user.create({
        data: { email: `external-lifecycle-${randomUUID()}@example.test` },
    });

const conversationPayload = (
    rawId: string,
    contents: string[] = ["hello", "world"]
) => ({
    rawExternalConversationId: rawId,
    title: `conversation ${rawId}`,
    sourceModelLabels: ["gpt-test"],
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    messages: contents.map((content, index) => ({
        rawExternalMessageId: `${rawId}-message-${index}`,
        role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        ordinal: index,
        content,
        sourceModelLabel: index % 2 === 1 ? "gpt-test" : null,
        sourceTimestamp: null,
    })),
});

const expectCode = (code: string) => (error: unknown) =>
    error instanceof ApiSecurityError && error.code === code;

beforeEach(resetData);

after(async () => {
    await resetData();
    await prisma.$disconnect();
});

test("the full staging to finalize lifecycle works end to end", async () => {
    const user = await createUser();
    const created = await createExternalImport({
        userId: user.id,
        provider: "chatgpt",
        parserVersion: "test-1",
    });

    const batch = await appendExternalImportBatch({
        userId: user.id,
        importId: created.id,
        sequence: 0,
        batchDigest: "batch-digest-0",
        conversations: [
            conversationPayload("conv-a"),
            conversationPayload("conv-b"),
        ],
    });
    assert.equal(batch.idempotentReplay, false);
    assert.equal(batch.results.length, 2);
    assert.ok(batch.results.every((result) => result.outcome === "staged"));

    // Staged rows are invisible to the finalized/viewer scope.
    const status = await getExternalImportStatus(user.id, created.id);
    assert.equal(status.conversations.length, 2);
    assert.ok(status.conversations.every((row) => row.finalized === false));

    // Select only conv-a; conv-b must be discarded, not half-kept.
    const selectedId = batch.results[0].stagedConversationId!;
    const finalized = await finalizeExternalImport({
        userId: user.id,
        importId: created.id,
        idempotencyKey: "finalize-key-1",
        selectedConversationIds: [selectedId],
    });
    assert.equal(finalized.idempotentReplay, false);
    assert.equal(finalized.finalizedConversations, 1);

    const conversations = await prisma.externalConversation.findMany({
        where: { userId: user.id },
    });
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0].finalized, true);

    const capacity = await getExternalImportCapacity(user.id);
    assert.equal(capacity.usage.externalConversations, 1);
    assert.equal(capacity.usage.externalMessages, 2);
    assert.ok(capacity.usage.normalizedTextBytes > 0);

    // Finalize idempotency (§5.5): same key replays the stored success…
    const replay = await finalizeExternalImport({
        userId: user.id,
        importId: created.id,
        idempotencyKey: "finalize-key-1",
        selectedConversationIds: [selectedId],
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.importDigest, finalized.importDigest);

    // …while a different key on a completed import is a state conflict.
    await assert.rejects(
        finalizeExternalImport({
            userId: user.id,
            importId: created.id,
            idempotencyKey: "finalize-key-2",
            selectedConversationIds: [selectedId],
        }),
        expectCode("EXTERNAL_IMPORT_ALREADY_FINALIZED")
    );
});

test("the batch ledger tells retries, conflicts and gaps apart", async () => {
    const user = await createUser();
    const created = await createExternalImport({
        userId: user.id,
        provider: "claude",
        parserVersion: "test-1",
    });

    await appendExternalImportBatch({
        userId: user.id,
        importId: created.id,
        sequence: 0,
        batchDigest: "digest-a",
        conversations: [conversationPayload("conv-1")],
    });

    // Byte-identical retry of the last batch: idempotent, nothing staged twice.
    const retry = await appendExternalImportBatch({
        userId: user.id,
        importId: created.id,
        sequence: 0,
        batchDigest: "digest-a",
        conversations: [conversationPayload("conv-1")],
    });
    assert.equal(retry.idempotentReplay, true);
    assert.equal(await prisma.externalConversation.count(), 1);

    await assert.rejects(
        appendExternalImportBatch({
            userId: user.id,
            importId: created.id,
            sequence: 0,
            batchDigest: "digest-b",
            conversations: [conversationPayload("conv-2")],
        }),
        expectCode("EXTERNAL_IMPORT_BATCH_CONFLICT")
    );

    await assert.rejects(
        appendExternalImportBatch({
            userId: user.id,
            importId: created.id,
            sequence: 5,
            batchDigest: "digest-c",
            conversations: [conversationPayload("conv-3")],
        }),
        expectCode("EXTERNAL_IMPORT_BATCH_OUT_OF_ORDER")
    );
});

test("an exact duplicate of an already-stored conversation is skipped", async () => {
    const user = await createUser();
    const first = await createExternalImport({
        userId: user.id,
        provider: "chatgpt",
        parserVersion: "test-1",
    });
    const firstBatch = await appendExternalImportBatch({
        userId: user.id,
        importId: first.id,
        sequence: 0,
        batchDigest: "digest-first",
        conversations: [conversationPayload("conv-dup")],
    });
    await finalizeExternalImport({
        userId: user.id,
        importId: first.id,
        idempotencyKey: "key-first",
        selectedConversationIds: [firstBatch.results[0].stagedConversationId!],
    });

    // Re-importing the identical export: the same content digests must be
    // recognised, skipped and reported — never stored a second time.
    const second = await createExternalImport({
        userId: user.id,
        provider: "chatgpt",
        parserVersion: "test-1",
    });
    const secondBatch = await appendExternalImportBatch({
        userId: user.id,
        importId: second.id,
        sequence: 0,
        batchDigest: "digest-second",
        conversations: [conversationPayload("conv-dup")],
    });
    assert.equal(secondBatch.results[0].outcome, "duplicate");
    assert.equal(await prisma.externalConversation.count(), 1);

    const status = await getExternalImportStatus(user.id, second.id);
    assert.equal(status.counts.duplicatesSkipped, 1);
});

test("oversized messages are truncated server-side with the original digested", async () => {
    const user = await createUser();
    const created = await createExternalImport({
        userId: user.id,
        provider: "chatgpt",
        parserVersion: "test-1",
    });

    const oversized = "가".repeat(
        EXTERNAL_IMPORT_STORAGE_LIMITS.maxStoredMessageCodePoints + 10_000
    );
    await appendExternalImportBatch({
        userId: user.id,
        importId: created.id,
        sequence: 0,
        batchDigest: "digest-oversized",
        conversations: [conversationPayload("conv-big", [oversized])],
    });

    const message = await prisma.externalMessage.findFirstOrThrow({
        where: { userId: user.id },
    });
    assert.equal(message.truncated, true);
    assert.ok(message.originalContentDigest);
    assert.notEqual(message.originalContentDigest, message.contentDigest);
    assert.ok(message.content.includes(EXTERNAL_IMPORT_TRUNCATION_MARKER));
    assert.ok(
        [...message.content].length <=
            EXTERNAL_IMPORT_STORAGE_LIMITS.maxStoredMessageCodePoints
    );
    assert.equal(
        message.originalCharacterCount,
        EXTERNAL_IMPORT_STORAGE_LIMITS.maxStoredMessageCodePoints + 10_000
    );

    // The unretained middle must not survive anywhere.
    assert.ok(!message.content.includes(oversized));
});

test("a message beyond the inbound hard limit rejects the batch", async () => {
    const user = await createUser();
    const created = await createExternalImport({
        userId: user.id,
        provider: "chatgpt",
        parserVersion: "test-1",
    });

    await assert.rejects(
        appendExternalImportBatch({
            userId: user.id,
            importId: created.id,
            sequence: 0,
            batchDigest: "digest-too-big",
            conversations: [
                conversationPayload("conv-huge", [
                    "x".repeat(
                        EXTERNAL_IMPORT_STORAGE_LIMITS.maxInboundMessageCodePoints +
                            1
                    ),
                ]),
            ],
        }),
        expectCode("EXTERNAL_IMPORT_PAYLOAD_UNSAFE")
    );
});

test("a stale selection is refused instead of partially finalized", async () => {
    const user = await createUser();
    const created = await createExternalImport({
        userId: user.id,
        provider: "chatgpt",
        parserVersion: "test-1",
    });
    const batch = await appendExternalImportBatch({
        userId: user.id,
        importId: created.id,
        sequence: 0,
        batchDigest: "digest-0",
        conversations: [conversationPayload("conv-a")],
    });

    await assert.rejects(
        finalizeExternalImport({
            userId: user.id,
            importId: created.id,
            idempotencyKey: "key-1",
            selectedConversationIds: [
                batch.results[0].stagedConversationId!,
                "nonexistent-conversation-id",
            ],
        }),
        expectCode("EXTERNAL_IMPORT_SELECTION_CHANGED")
    );
});

test("cross-user access reads as not-found", async () => {
    const [owner, intruder] = await Promise.all([createUser(), createUser()]);
    const created = await createExternalImport({
        userId: owner.id,
        provider: "chatgpt",
        parserVersion: "test-1",
    });

    await assert.rejects(
        getExternalImportStatus(intruder.id, created.id),
        expectCode("NOT_FOUND")
    );
    await assert.rejects(
        appendExternalImportBatch({
            userId: intruder.id,
            importId: created.id,
            sequence: 0,
            batchDigest: "digest-x",
            conversations: [conversationPayload("conv-x")],
        }),
        expectCode("NOT_FOUND")
    );
    await assert.rejects(
        deleteExternalImport(intruder.id, created.id),
        expectCode("NOT_FOUND")
    );
});

test("cancel clears staging; deleting a completed import cascades", async () => {
    const user = await createUser();

    const staging = await createExternalImport({
        userId: user.id,
        provider: "chatgpt",
        parserVersion: "test-1",
    });
    await appendExternalImportBatch({
        userId: user.id,
        importId: staging.id,
        sequence: 0,
        batchDigest: "digest-0",
        conversations: [conversationPayload("conv-cancel")],
    });
    const cancelled = await deleteExternalImport(user.id, staging.id);
    assert.equal(cancelled.outcome, "cancelled");
    assert.equal(await prisma.externalConversation.count(), 0);

    const completed = await createExternalImport({
        userId: user.id,
        provider: "chatgpt",
        parserVersion: "test-1",
    });
    const batch = await appendExternalImportBatch({
        userId: user.id,
        importId: completed.id,
        sequence: 0,
        batchDigest: "digest-1",
        conversations: [conversationPayload("conv-keep")],
    });
    await finalizeExternalImport({
        userId: user.id,
        importId: completed.id,
        idempotencyKey: "key-1",
        selectedConversationIds: [batch.results[0].stagedConversationId!],
    });
    const deleted = await deleteExternalImport(user.id, completed.id);
    assert.equal(deleted.outcome, "deleted");
    assert.equal(await prisma.externalImport.count({ where: { userId: user.id, status: "completed" } }), 0);
    assert.equal(await prisma.externalConversation.count(), 0);
    assert.equal(await prisma.externalMessage.count(), 0);
});

test("expired staging is swept and further activity gets 410", async () => {
    const user = await createUser();
    const created = await createExternalImport({
        userId: user.id,
        provider: "chatgpt",
        parserVersion: "test-1",
    });
    await appendExternalImportBatch({
        userId: user.id,
        importId: created.id,
        sequence: 0,
        batchDigest: "digest-0",
        conversations: [conversationPayload("conv-stale")],
    });

    // Backdate past the 24h idle TTL (§5.5).
    await prisma.$executeRaw`
      UPDATE "ExternalImport"
      SET "updatedAt" = NOW() - INTERVAL '25 hours'
      WHERE id = ${created.id}
    `;

    const sweep = await reconcileExpiredExternalImportStaging();
    assert.equal(sweep.expiredImports, 1);

    const row = await prisma.externalImport.findUniqueOrThrow({
        where: { id: created.id },
    });
    assert.equal(row.status, "failed");
    assert.equal(row.failureCode, "EXTERNAL_IMPORT_STAGING_EXPIRED");
    assert.equal(await prisma.externalConversation.count(), 0);

    await assert.rejects(
        appendExternalImportBatch({
            userId: user.id,
            importId: created.id,
            sequence: 1,
            batchDigest: "digest-late",
            conversations: [conversationPayload("conv-late")],
        }),
        expectCode("EXTERNAL_IMPORT_STAGING_EXPIRED")
    );
});
