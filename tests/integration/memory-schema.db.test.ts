import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { externalContentDigest } from "@/lib/externalImportDigest";
import {
    manualEvidenceDigest,
    verifyExternalMessageEvidence,
} from "@/lib/memoryEvidenceValidation";
import { prisma } from "@/lib/prisma";

/**
 * Release B storage invariants (slice B1) against a real database.
 *
 * docs/policy/external-conversation-import-and-memory.md §8, §20 and the
 * 2026-08-03 §23 amendment: the kind/status/sensitivity/mode allowlists, the
 * confidence range, the sourceType discriminator shape, the GIN retrieval
 * index and the deletion cascades only mean anything if the migration
 * actually creates them — so they are exercised as constraint violations
 * and cascades, plus the DB-bound half of the §8.4 validator.
 */

const resetMemoryData = async () => {
    await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "MemoryEvidence",
      "MemoryItem",
      "MemoryExtractionRun",
      "UserMemorySettings",
      "ExternalMessage",
      "ExternalConversation",
      "ExternalImport"
    RESTART IDENTITY CASCADE
  `);
};

const createUser = () =>
    prisma.user.create({
        data: { email: `memory-schema-${randomUUID()}@example.test` },
    });

const createMemoryItem = (
    userId: string,
    overrides: Record<string, unknown> = {}
) =>
    prisma.memoryItem.create({
        data: {
            userId,
            kind: "preference",
            statement: "사용자는 존댓말 답변을 선호한다",
            confidence: 0.9,
            ...overrides,
        },
    });

/** A finalized external message to hang evidence on. */
const createExternalMessage = async (userId: string, content = "hello") => {
    const importRow = await prisma.externalImport.create({
        data: {
            userId,
            provider: "chatgpt",
            status: "completed",
            parserVersion: "test-1",
            digestVersion: 1,
        },
    });
    const conversation = await prisma.externalConversation.create({
        data: {
            userId,
            importId: importRow.id,
            provider: "chatgpt",
            externalStableId: randomUUID().replaceAll("-", ""),
            title: "memory schema fixture",
            conversationDigest: randomUUID().replaceAll("-", "").repeat(2),
            digestVersion: 1,
            messageCount: 1,
            contentBytes: BigInt(content.length),
            finalized: true,
        },
    });
    return prisma.externalMessage.create({
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
};

beforeEach(resetMemoryData);

after(async () => {
    await resetMemoryData();
    await prisma.$disconnect();
});

test("the closed vocabularies are enforced by CHECK constraints", async () => {
    const user = await createUser();

    await assert.rejects(createMemoryItem(user.id, { kind: "vibe" }));
    await assert.rejects(createMemoryItem(user.id, { status: "pondering" }));
    await assert.rejects(createMemoryItem(user.id, { sensitivity: "secret" }));
    await assert.rejects(createMemoryItem(user.id, { confidence: 1.5 }));
    await assert.rejects(createMemoryItem(user.id, { confidence: -0.1 }));

    const valid = await createMemoryItem(user.id, {
        kind: "code_style",
        status: "manual_review_required",
        sensitivity: "sensitive",
        confidence: 1,
    });
    assert.equal(valid.status, "manual_review_required");
});

test("conversation memoryMode defaults to inherit and rejects unknown modes", async () => {
    const user = await createUser();
    const conversation = await prisma.conversation.create({
        data: { userId: user.id, title: "memory mode fixture" },
    });
    assert.equal(conversation.memoryMode, "inherit");

    await prisma.conversation.update({
        where: { id: conversation.id },
        data: { memoryMode: "off" },
    });
    await assert.rejects(
        prisma.conversation.update({
            where: { id: conversation.id },
            data: { memoryMode: "sometimes" },
        })
    );
});

test("the sourceType discriminator shape is a DB constraint (§8.5)", async () => {
    const user = await createUser();
    const item = await createMemoryItem(user.id);
    const message = await createExternalMessage(user.id);

    // external_message must carry exactly its FK.
    await assert.rejects(
        prisma.memoryEvidence.create({
            data: {
                memoryItemId: item.id,
                userId: user.id,
                sourceType: "external_message",
                evidenceDigest: message.contentDigest,
            },
        })
    );
    // manual must carry the grounds text and no FK.
    await assert.rejects(
        prisma.memoryEvidence.create({
            data: {
                memoryItemId: item.id,
                userId: user.id,
                sourceType: "manual",
                externalMessageId: message.id,
                manualContent: "사용자가 직접 입력한 근거",
                evidenceDigest: manualEvidenceDigest("사용자가 직접 입력한 근거"),
            },
        })
    );
    // unknown sourceType has no satisfiable shape.
    await assert.rejects(
        prisma.memoryEvidence.create({
            data: {
                memoryItemId: item.id,
                userId: user.id,
                sourceType: "carrier_pigeon",
                manualContent: "x",
                evidenceDigest: "d".repeat(64),
            },
        })
    );

    const external = await prisma.memoryEvidence.create({
        data: {
            memoryItemId: item.id,
            userId: user.id,
            sourceType: "external_message",
            externalMessageId: message.id,
            evidenceDigest: message.contentDigest,
        },
    });
    assert.equal(external.sourceType, "external_message");

    const manual = await prisma.memoryEvidence.create({
        data: {
            memoryItemId: item.id,
            userId: user.id,
            sourceType: "manual",
            manualContent: "사용자가 직접 입력한 근거",
            evidenceDigest: manualEvidenceDigest("사용자가 직접 입력한 근거"),
        },
    });
    assert.equal(manual.externalMessageId, null);
});

test("deletion cascades: user → items → evidence, and source message → evidence", async () => {
    const user = await createUser();
    const item = await createMemoryItem(user.id);
    const message = await createExternalMessage(user.id);
    await prisma.memoryEvidence.create({
        data: {
            memoryItemId: item.id,
            userId: user.id,
            sourceType: "external_message",
            externalMessageId: message.id,
            evidenceDigest: message.contentDigest,
        },
    });
    await prisma.userMemorySettings.create({ data: { userId: user.id } });
    await prisma.memoryExtractionRun.create({
        data: {
            userId: user.id,
            extractionModelId: "gpt-5-6-luna",
            promptVersion: "mem-extract-v1",
            sourceSelection: [],
            chunkTotal: 1,
        },
    });

    // Deleting the source message removes its evidence but not the item —
    // the §13.1 state transition is service/reconciliation work, and the
    // orphaned item must still be there for it to act on.
    await prisma.externalMessage.delete({ where: { id: message.id } });
    assert.equal(await prisma.memoryEvidence.count(), 0);
    assert.equal(await prisma.memoryItem.count(), 1);

    await prisma.user.delete({ where: { id: user.id } });
    assert.equal(await prisma.memoryItem.count(), 0);
    assert.equal(await prisma.memoryExtractionRun.count(), 0);
    assert.equal(await prisma.userMemorySettings.count(), 0);
});

test("the searchTerms GIN index exists (§9 retrieval v1)", async () => {
    const rows = await prisma.$queryRaw<Array<{ indexdef: string }>>`
        SELECT indexdef FROM pg_indexes
        WHERE tablename = 'MemoryItem'
          AND indexname = 'MemoryItem_searchTerms_gin_idx'
    `;
    assert.equal(rows.length, 1);
    assert.match(rows[0].indexdef, /USING gin/i);
});

test("memory settings defaults match the policy decision", async () => {
    const user = await createUser();
    const settings = await prisma.userMemorySettings.create({
        data: { userId: user.id },
    });
    assert.equal(settings.masterEnabled, true);
    assert.equal(settings.styleEnabled, true);
    assert.equal(settings.defaultConversationMode, "on");
    await assert.rejects(
        prisma.userMemorySettings.update({
            where: { userId: user.id },
            data: { defaultConversationMode: "inherit" },
        })
    );
});

test("evidence verification is owner-scoped and digest-checked (§8.4)", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const message = await createExternalMessage(owner.id, "the grounds text");

    const results = await verifyExternalMessageEvidence(owner.id, [
        { externalMessageId: message.id, evidenceDigest: message.contentDigest },
        { externalMessageId: message.id, evidenceDigest: "f".repeat(64) },
        { externalMessageId: "does-not-exist", evidenceDigest: "f".repeat(64) },
    ]);
    assert.deepEqual(
        results.map((result) => result.outcome),
        ["verified", "digest_mismatch", "not_found"]
    );
    assert.equal(results[0].role, "user");

    // A stranger probing the same ID learns nothing beyond not_found.
    const probe = await verifyExternalMessageEvidence(stranger.id, [
        { externalMessageId: message.id, evidenceDigest: message.contentDigest },
    ]);
    assert.equal(probe[0].outcome, "not_found");
});
