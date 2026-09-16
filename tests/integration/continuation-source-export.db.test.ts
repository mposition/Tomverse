import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { createResourceUnlockCookie } from "@/lib/conversationLock";
import { CONTINUATION_SEED_VERSION } from "@/lib/externalContinuationSeedCore";
import { continuationProviderDisplay } from "@/lib/externalContinuationSeedPrompt";
import {
    buildContinuationSourceExport,
    type ContinuationSourceExportLimits,
    continuationSourceExportStillPermitted,
} from "@/lib/continuationSourceExport";

/**
 * CONT-EXPORT-01B (docs/policy/external-conversation-continuation.md §9.1):
 * the claims only a database settles -- that the file is one snapshot of two
 * halves, that a source which is gone or locked is refused rather than
 * silently dropped, and that permission is decided after the bytes exist.
 */

const resetData = () =>
    prisma.$executeRawUnsafe(
        `TRUNCATE TABLE "ConversationContinuationBridge", "Message", "Conversation", ` +
            `"ExternalMessage", "ExternalConversation", "ExternalImport", "User" ` +
            `RESTART IDENTITY CASCADE`
    );

beforeEach(resetData);
after(async () => {
    await resetData();
    await prisma.$disconnect();
});

const createUser = () =>
    prisma.user.create({ data: { email: `export-${randomUUID()}@example.test` } });

const seed = async (
    userId: string,
    options: {
        importedContents?: string[];
        nativeContents?: string[];
        snapshotPassword?: string;
        conversationPassword?: string;
        finalized?: boolean;
    } = {}
) => {
    const importedContents = options.importedContents ?? ["imported one", "imported two"];
    const importRow = await prisma.externalImport.create({
        data: { userId, provider: "chatgpt", status: "completed", digestVersion: 1, parserVersion: "test" },
    });
    const snapshot = await prisma.externalConversation.create({
        data: {
            userId,
            importId: importRow.id,
            provider: "chatgpt",
            externalStableId: `stable-${randomUUID()}`,
            title: "Imported original",
            conversationDigest: `digest-${randomUUID()}`,
            digestVersion: 1,
            messageCount: importedContents.length,
            contentBytes: BigInt(64 * importedContents.length),
            finalized: options.finalized ?? true,
            ...(options.snapshotPassword ? { password: options.snapshotPassword } : {}),
        },
    });
    await prisma.externalMessage.createMany({
        data: importedContents.map((content, index) => ({
            userId,
            externalConversationId: snapshot.id,
            externalStableId: snapshot.externalStableId,
            role: index % 2 === 0 ? "user" : "assistant",
            content,
            contentDigest: `c-${index}-${snapshot.id}`,
            digestVersion: 1,
            ordinal: index * 2,
            sourceModelLabel: index % 2 === 0 ? null : "gpt-4-turbo",
            // A truncated row carries what it was cut from, as the schema requires.
            ...(index === 1
                ? {
                      truncated: true,
                      originalContentDigest: `o-${index}-${snapshot.id}`,
                      originalCharacterCount: content.length + 10,
                      retainedCharacterCount: content.length,
                  }
                : { truncated: false }),
        })),
    });
    const conversation = await prisma.conversation.create({
        data: {
            userId,
            title: "A continued conversation",
            productKey: "review",
            kind: "chat",
            ...(options.conversationPassword ? { password: options.conversationPassword } : {}),
            messages: {
                create: (options.nativeContents ?? ["tomverse answer"]).map((content) => ({
                    role: "assistant",
                    content,
                })),
            },
        },
    });
    const bridge = await prisma.conversationContinuationBridge.create({
        data: {
            userId,
            conversationId: conversation.id,
            externalConversationId: snapshot.id,
            provider: "chatgpt",
            sourceImportedAt: new Date("2026-07-02T00:00:00.000Z"),
            sourceConversationDigest: `d-${randomUUID()}`,
            sourceDigestVersion: 1,
            sourceMessageCount: importedContents.length,
            seedFromOrdinal: 0,
            seedToOrdinal: 1,
            seedMessageCount: importedContents.length,
            seedTruncatedMessageCount: 0,
            seedOmittedMessageCount: 0,
            contextSeedVersion: CONTINUATION_SEED_VERSION,
            idempotencyKey: randomUUID(),
        },
    });
    return { snapshot, conversation, bridge };
};

type Grant = { type: "conversation" | "external_conversation"; userId: string; id: string; password: string };

const requestWith = (grants: Grant[] = []) =>
    new Request("https://tomverse.test/api/conversations/x/export?include=source", {
        headers: grants.length
            ? {
                  cookie: grants
                      .map((grant) =>
                          createResourceUnlockCookie(grant.type, grant.userId, grant.id, grant.password).split(";")[0]
                      )
                      .join("; "),
              }
            : {},
    });

const build = (
    userId: string,
    conversationId: string,
    grants: Grant[] = [],
    options: {
        afterSnapshot?: () => Promise<void>;
        limits?: Partial<ContinuationSourceExportLimits>;
    } = {}
) =>
    buildContinuationSourceExport({
        request: requestWith(grants),
        userId,
        conversationId,
        providerLabel: continuationProviderDisplay,
        afterSnapshot: options.afterSnapshot,
        limits: options.limits,
        header: ({ conversation }) => ({
            title: conversation.title,
            text: `Tomverse Review Export\nConversation: ${conversation.title}\n\n`,
        }),
    });

const textOf = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

test("the file carries the stored original, the divider and the conversation's own turns", async () => {
    const user = await createUser();
    const { conversation } = await seed(user.id, {
        importedContents: ["imported one", "imported two"],
        nativeContents: ["tomverse answer one", "tomverse answer two"],
    });

    const built = await build(user.id, conversation.id);
    assert.ok(built.ok);
    const text = textOf(built.document.bytes);
    // Order: original, then the divider, then this conversation.
    const first = text.indexOf("imported one");
    const divider = text.indexOf("===== Continued in Tomverse =====");
    const native = text.indexOf("tomverse answer one");
    assert.ok(first > 0 && divider > first && native > divider);
    // The provider label the product renders, not a shortened one. Compared as
    // a string: the label itself contains parentheses.
    assert.ok(
        text.includes(`[Imported · ${continuationProviderDisplay("chatgpt")} · gpt-4-turbo]`),
        text.slice(0, 400)
    );
    assert.match(text, /shortened when it was imported/);
    assert.match(text, /===== End of export \(2 imported, 2 Tomverse messages\) =====/);
    assert.equal(built.document.importedMessageCount, 2);
    assert.equal(built.document.nativeMessageCount, 2);
    // The digest and byte count the browser verifies are of these exact bytes.
    assert.equal(
        built.document.sha256,
        createHash("sha256").update(built.document.bytes).digest("hex")
    );
});

test("a deleted, unfinalized or foreign source is refused, never quietly dropped", async () => {
    const user = await createUser();
    const stranger = await createUser();

    const deleted = await seed(user.id);
    await prisma.conversationContinuationBridge.update({
        where: { id: deleted.bridge.id },
        data: { externalConversationId: null, sourceDeletedAt: new Date() },
    });
    assert.equal(
        await build(user.id, deleted.conversation.id).then((r) => (r.ok ? null : "refusal" in r ? r.refusal.code : null)),
        "EXPORT_SOURCE_DELETED"
    );

    const staging = await seed(user.id, { finalized: false });
    assert.equal(
        await build(user.id, staging.conversation.id).then((r) => (r.ok ? null : "refusal" in r ? r.refusal.code : null)),
        "EXPORT_SOURCE_DELETED"
    );

    // Another account's conversation reads as absent, not as refused.
    const mine = await seed(user.id);
    const foreign = await build(stranger.id, mine.conversation.id);
    assert.ok(!foreign.ok && "notFound" in foreign);

    // And a bridge that really points at the stranger's snapshot -- nothing in
    // the schema forbids the row -- yields no file and no stranger's text.
    const strangers = await seed(stranger.id, { importedContents: ["stranger's private turn"] });
    const crossed = await seed(user.id);
    await prisma.conversationContinuationBridge.update({
        where: { id: crossed.bridge.id },
        data: { externalConversationId: strangers.snapshot.id },
    });
    const crossedBuild = await build(user.id, crossed.conversation.id);
    assert.equal(
        crossedBuild.ok ? null : "refusal" in crossedBuild ? crossedBuild.refusal.code : null,
        "EXPORT_SOURCE_DELETED"
    );
    assert.ok(!JSON.stringify(crossedBuild).includes("private turn"));

    const ordinary = await prisma.conversation.create({
        data: { userId: user.id, title: "no bridge", productKey: "chat", kind: "chat" },
    });
    assert.equal(
        await build(user.id, ordinary.id).then((r) => (r.ok ? null : "refusal" in r ? r.refusal.code : null)),
        "EXPORT_SOURCE_NOT_CONTINUATION"
    );
});

test("each lock refuses the file until its own grant is presented", async () => {
    const user = await createUser();
    const { conversation, snapshot } = await seed(user.id, {
        snapshotPassword: "source-hash",
        conversationPassword: "conversation-hash",
    });

    const none = await build(user.id, conversation.id);
    assert.ok(!none.ok && "locked" in none, "the conversation's own lock answers first");

    const conversationGrant: Grant = {
        type: "conversation",
        userId: user.id,
        id: conversation.id,
        password: "conversation-hash",
    };
    const sourceOnly = await build(user.id, conversation.id, [conversationGrant]);
    assert.equal(sourceOnly.ok ? null : "refusal" in sourceOnly ? sourceOnly.refusal.code : null, "EXPORT_SOURCE_LOCKED");

    const both = await build(user.id, conversation.id, [
        conversationGrant,
        { type: "external_conversation", userId: user.id, id: snapshot.id, password: "source-hash" },
    ]);
    assert.ok(both.ok);
    assert.match(textOf(both.document.bytes), /imported one/);
});

test("a file too large to be one document is refused rather than shortened", async () => {
    // The cap is lowered rather than the fixture raised: this asserts the
    // comparison, and a ten-megabyte fixture would cost the shared lane
    // minutes to assert the same thing. The real numbers are pinned in
    // tests/continuationSourceExport.test.mjs.
    const user = await createUser();
    const { conversation } = await seed(user.id, {
        importedContents: Array.from({ length: 4 }, (_, index) => `${index} `.repeat(200)),
    });
    const built = await build(user.id, conversation.id, [], { limits: { maxBytes: 1_000 } });
    assert.equal(built.ok ? null : "refusal" in built ? built.refusal.code : null, "EXPORT_TOO_LARGE");
});

test("the original is read past one page, in ordinal order", async () => {
    const user = await createUser();
    // The page size is lowered for the same reason the caps are: what is being
    // asserted is that the walk continues, not that 500 rows fit in one query.
    const contents = Array.from({ length: 37 }, (_, index) => `imported turn ${index}`);
    const { conversation } = await seed(user.id, { importedContents: contents });
    const built = await build(user.id, conversation.id, [], { limits: { pageSize: 10 } });
    assert.ok(built.ok);
    assert.equal(built.document.importedMessageCount, contents.length);
    const text = textOf(built.document.bytes);
    assert.ok(text.indexOf("imported turn 0") < text.indexOf(`imported turn ${contents.length - 1}`));
});

test("the size cap is refused from the counts, before the text is assembled", async () => {
    const user = await createUser();
    // Few messages, each far past the byte cap: the message-count cap cannot
    // see this, and the refusal comes from the summed lengths.
    const { conversation } = await seed(user.id, {
        importedContents: Array.from({ length: 4 }, () => "x".repeat(600)),
    });
    const built = await build(user.id, conversation.id, [], {
        limits: { maxBytes: 1_000, maxMessages: 1_000 },
    });
    assert.equal(built.ok ? null : "refusal" in built ? built.refusal.code : null, "EXPORT_TOO_LARGE");
});

test("the message cap counts both halves together", async () => {
    const user = await createUser();
    // Neither half exceeds the cap alone; together they do.
    const { conversation } = await seed(user.id, {
        importedContents: Array.from({ length: 6 }, (_, index) => `i${index}`),
        nativeContents: Array.from({ length: 6 }, (_, index) => `n${index}`),
    });
    assert.ok((await build(user.id, conversation.id, [], { limits: { maxMessages: 12 } })).ok);
    const built = await build(user.id, conversation.id, [], { limits: { maxMessages: 11 } });
    assert.equal(built.ok ? null : "refusal" in built ? built.refusal.code : null, "EXPORT_TOO_LARGE");
});

test("the Tomverse half is read past one page too", async () => {
    const user = await createUser();
    const nativeContents = Array.from({ length: 23 }, (_, index) => `tomverse turn ${index}`);
    const { conversation } = await seed(user.id, { nativeContents });
    const built = await build(user.id, conversation.id, [], { limits: { pageSize: 10 } });
    assert.ok(built.ok);
    assert.equal(built.document.nativeMessageCount, nativeContents.length);
    const text = textOf(built.document.bytes);
    assert.ok(text.includes(`tomverse turn ${nativeContents.length - 1}`));
});

test("the file carries the snapshot this bridge names, not another the account owns", async () => {
    const user = await createUser();
    const { conversation, bridge } = await seed(user.id, { importedContents: ["first snapshot text"] });
    const other = await seed(user.id, { importedContents: ["second snapshot text"] });
    const built = await build(user.id, conversation.id);
    assert.ok(built.ok);
    const text = textOf(built.document.bytes);
    assert.match(text, /first snapshot text/);
    assert.doesNotMatch(text, /second snapshot text/);
    assert.equal(built.permission.externalConversationId, bridge.externalConversationId);
    assert.notEqual(built.permission.externalConversationId, other.snapshot.id);
});

test("writes landing while the file is built leave it internally coherent", async () => {
    const user = await createUser();
    const { conversation } = await seed(user.id, {
        importedContents: Array.from({ length: 40 }, (_, index) => `imported ${index}`),
        nativeContents: Array.from({ length: 40 }, (_, index) => `native ${index}`),
    });

    // Committed after the snapshot is fixed, and before a single message has
    // been read: the file must show the conversation as it was, not a mixture.
    const built = await build(user.id, conversation.id, [], {
        afterSnapshot: async () => {
            await prisma.message.create({
                data: { conversationId: conversation.id, role: "user", content: "arrived mid-export" },
            });
            await prisma.conversation.update({
                where: { id: conversation.id },
                data: { title: "renamed mid-export" },
            });
        },
    });
    assert.ok(built.ok);
    const text = textOf(built.document.bytes);
    assert.doesNotMatch(text, /arrived mid-export/);
    assert.doesNotMatch(text, /renamed mid-export/);
    assert.equal(built.document.nativeMessageCount, 40);
    assert.equal(built.document.importedMessageCount, 40);
    // And the document agrees with itself: the footer counts the blocks it has.
    const blocks = text.split("==================================================").length - 1;
    assert.equal(blocks, built.document.importedMessageCount + built.document.nativeMessageCount);
    assert.match(text, /End of export \(40 imported, 40 Tomverse messages\)/);
    // The write really did land; it is simply not in this file.
    assert.equal(
        await prisma.message.count({ where: { conversationId: conversation.id } }),
        41
    );
});

test("permission is decided after the bytes exist: a source deleted since is refused", async () => {
    const user = await createUser();
    const { conversation, bridge, snapshot } = await seed(user.id);
    const built = await build(user.id, conversation.id);
    assert.ok(built.ok);

    // Still permitted a moment ago...
    assert.equal(
        await continuationSourceExportStillPermitted({
            request: requestWith(),
            userId: user.id,
            conversationId: conversation.id,
            ...built.permission,
        }),
        null
    );

    // ...and not after the source is deleted or re-locked.
    await prisma.externalConversation.update({
        where: { id: snapshot.id },
        data: { password: "locked-since" },
    });
    assert.equal(
        await continuationSourceExportStillPermitted({
            request: requestWith(),
            userId: user.id,
            conversationId: conversation.id,
            ...built.permission,
        }).then((refusal) => refusal?.code),
        "EXPORT_SOURCE_LOCKED"
    );

    await prisma.conversationContinuationBridge.update({
        where: { id: bridge.id },
        data: { externalConversationId: null },
    });
    assert.equal(
        await continuationSourceExportStillPermitted({
            request: requestWith(),
            userId: user.id,
            conversationId: conversation.id,
            ...built.permission,
        }).then((refusal) => refusal?.code),
        "EXPORT_SOURCE_DELETED"
    );
});
