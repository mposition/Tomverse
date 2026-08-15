import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { EXTERNAL_IMPORT_DIGEST_VERSION } from "@/lib/externalImportDigest";
import { prisma } from "@/lib/prisma";

/**
 * Release A storage invariants (A1a) against a real database.
 *
 * docs/policy/external-conversation-import-and-memory.md §4.2 and §20: the
 * duplicate backstop, the immutable-snapshot lineage model, the role/status/
 * truncation CHECK constraints and the deletion cascades only mean anything
 * if the migration actually creates them — so they are exercised here as
 * constraint violations and cascades, not as application logic.
 */

const resetExternalImportData = async () => {
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
        data: {
            email: `external-import-${randomUUID()}@example.test`,
        },
    });

const createImport = (userId: string) =>
    prisma.externalImport.create({
        data: {
            userId,
            provider: "chatgpt",
            digestVersion: EXTERNAL_IMPORT_DIGEST_VERSION,
            parserVersion: "test-1",
        },
    });

const conversationData = (
    userId: string,
    importId: string,
    overrides: Record<string, unknown> = {}
) => ({
    userId,
    importId,
    provider: "chatgpt",
    externalStableId: "lineage-1",
    title: "fixture conversation",
    conversationDigest: `digest-${randomUUID()}`,
    digestVersion: EXTERNAL_IMPORT_DIGEST_VERSION,
    messageCount: 1,
    contentBytes: BigInt(16),
    ...overrides,
});

const messageData = (
    userId: string,
    externalConversationId: string,
    overrides: Record<string, unknown> = {}
) => ({
    userId,
    externalConversationId,
    externalStableId: `message-${randomUUID()}`,
    role: "user",
    content: "hello",
    contentDigest: "content-digest",
    digestVersion: EXTERNAL_IMPORT_DIGEST_VERSION,
    ordinal: 0,
    ...overrides,
});

beforeEach(resetExternalImportData);

after(async () => {
    await resetExternalImportData();
    await prisma.$disconnect();
});

test("an exact duplicate conversation digest is a conflict, not a second copy", async () => {
    const user = await createUser();
    const externalImport = await createImport(user.id);
    const digest = `digest-${randomUUID()}`;

    await prisma.externalConversation.create({
        data: conversationData(user.id, externalImport.id, {
            conversationDigest: digest,
        }),
    });

    await assert.rejects(
        prisma.externalConversation.create({
            data: conversationData(user.id, externalImport.id, {
                conversationDigest: digest,
            }),
        }),
        (error: unknown) =>
            (error as { code?: string }).code === "P2002"
    );
});

test("the same lineage stores a changed export as a second immutable snapshot", async () => {
    const user = await createUser();
    const externalImport = await createImport(user.id);

    await prisma.externalConversation.create({
        data: conversationData(user.id, externalImport.id),
    });
    // Same externalStableId, different digest — §4.2's "new version of the
    // same source" case must be storable side by side.
    await prisma.externalConversation.create({
        data: conversationData(user.id, externalImport.id),
    });

    const snapshots = await prisma.externalConversation.findMany({
        where: { userId: user.id, externalStableId: "lineage-1" },
    });
    assert.equal(snapshots.length, 2);
});

test("two different accounts may store the same conversation digest", async () => {
    const [userA, userB] = await Promise.all([createUser(), createUser()]);
    const [importA, importB] = await Promise.all([
        createImport(userA.id),
        createImport(userB.id),
    ]);
    const digest = `digest-${randomUUID()}`;

    await prisma.externalConversation.create({
        data: conversationData(userA.id, importA.id, {
            conversationDigest: digest,
        }),
    });
    await prisma.externalConversation.create({
        data: conversationData(userB.id, importB.id, {
            conversationDigest: digest,
        }),
    });
});

test("one message per ordinal within a conversation", async () => {
    const user = await createUser();
    const externalImport = await createImport(user.id);
    const conversation = await prisma.externalConversation.create({
        data: conversationData(user.id, externalImport.id),
    });

    await prisma.externalMessage.create({
        data: messageData(user.id, conversation.id, { ordinal: 0 }),
    });
    await assert.rejects(
        prisma.externalMessage.create({
            data: messageData(user.id, conversation.id, { ordinal: 0 }),
        }),
        (error: unknown) =>
            (error as { code?: string }).code === "P2002"
    );
});

test("the role allowlist rejects non-conversation roles at the database", async () => {
    const user = await createUser();
    const externalImport = await createImport(user.id);
    const conversation = await prisma.externalConversation.create({
        data: conversationData(user.id, externalImport.id),
    });

    for (const role of ["system", "developer", "tool"]) {
        await assert.rejects(
            prisma.externalMessage.create({
                data: messageData(user.id, conversation.id, { role }),
            }),
            /ExternalMessage_role_check/
        );
    }
});

test("the provider and status allowlists hold", async () => {
    const user = await createUser();

    // This used to name Gemini as the provider outside the allowlist, which is
    // what it was for Release A. A2 added it (2026-08-15), so the example moves
    // to one that genuinely has no parser. Which providers *are* allowed is
    // checked against the canonical list in
    // tests/integration/external-import-provider-canon.db.test.ts; what this
    // asserts is only that the constraint still refuses something.
    await assert.rejects(
        prisma.externalImport.create({
            data: {
                userId: user.id,
                provider: "copilot",
                digestVersion: EXTERNAL_IMPORT_DIGEST_VERSION,
                parserVersion: "test-1",
            },
        }),
        /ExternalImport_provider_check/
    );

    await assert.rejects(
        prisma.externalImport.create({
            data: {
                userId: user.id,
                provider: "chatgpt",
                status: "half-finished",
                digestVersion: EXTERNAL_IMPORT_DIGEST_VERSION,
                parserVersion: "test-1",
            },
        }),
        /ExternalImport_status_check/
    );
});

test("truncation metadata is all-or-nothing", async () => {
    const user = await createUser();
    const externalImport = await createImport(user.id);
    const conversation = await prisma.externalConversation.create({
        data: conversationData(user.id, externalImport.id),
    });

    // Truncated without the pre-truncation digest: the unretained content
    // would have no trace at all (§5.4).
    await assert.rejects(
        prisma.externalMessage.create({
            data: messageData(user.id, conversation.id, { truncated: true }),
        }),
        /ExternalMessage_truncation_check/
    );

    // Not truncated but carrying an original digest: a contradiction that
    // would poison dedup.
    await assert.rejects(
        prisma.externalMessage.create({
            data: messageData(user.id, conversation.id, {
                originalContentDigest: "orphan-digest",
            }),
        }),
        /ExternalMessage_truncation_check/
    );

    // Retained larger than original: impossible by construction.
    await assert.rejects(
        prisma.externalMessage.create({
            data: messageData(user.id, conversation.id, {
                truncated: true,
                originalContentDigest: "digest",
                originalCharacterCount: 10,
                retainedCharacterCount: 11,
            }),
        }),
        /ExternalMessage_truncation_check/
    );

    await prisma.externalMessage.create({
        data: messageData(user.id, conversation.id, {
            truncated: true,
            originalContentDigest: "digest",
            originalCharacterCount: 200_000,
            retainedCharacterCount: 100_000,
        }),
    });
});

test("deleting an import removes its conversations and messages", async () => {
    const user = await createUser();
    const externalImport = await createImport(user.id);
    const conversation = await prisma.externalConversation.create({
        data: conversationData(user.id, externalImport.id),
    });
    await prisma.externalMessage.create({
        data: messageData(user.id, conversation.id),
    });

    await prisma.externalImport.delete({ where: { id: externalImport.id } });

    assert.equal(await prisma.externalConversation.count(), 0);
    assert.equal(await prisma.externalMessage.count(), 0);
});

test("account deletion cascades through imports to every external row", async () => {
    const user = await createUser();
    const externalImport = await createImport(user.id);
    const conversation = await prisma.externalConversation.create({
        data: conversationData(user.id, externalImport.id),
    });
    await prisma.externalMessage.create({
        data: messageData(user.id, conversation.id),
    });

    await prisma.user.delete({ where: { id: user.id } });

    assert.equal(await prisma.externalImport.count(), 0);
    assert.equal(await prisma.externalConversation.count(), 0);
    assert.equal(await prisma.externalMessage.count(), 0);
});
