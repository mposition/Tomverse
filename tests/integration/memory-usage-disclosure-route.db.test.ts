import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * §13.4 — the memory disclosure survives reopening the conversation.
 *
 * The count was already durable (`Message.memoryUsedCount`, written by the
 * chat route) and already rendered, but only from the streaming response
 * header: the answer stated what it had been given while it was being
 * written, and said nothing the next time the conversation was opened. A
 * disclosure that a reload erases is not the one §13.4 describes.
 *
 * What a database can prove here is the half that was missing — the owner's
 * read reports the stored count, and reports it on exactly the condition the
 * streaming header uses. The other half of the contract is negative and is
 * asserted where it belongs: tests/memoryReleaseContracts.test.mjs pins that
 * the share and export queries do not name the column (§13.3).
 *
 * Its own process under scripts/run-db-integration-tests.mjs: mock.module is
 * process-global and this file replaces next-auth for every module that
 * imports it.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
    pathToFileURL(resolve(ROOT, relativePath)).href;

let sessionOverride: unknown = null;
mock.module("next-auth/next", {
    namedExports: { getServerSession: async () => sessionOverride },
});

type ConversationRoute = {
    GET: (request: Request, context: unknown) => Promise<Response>;
};

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let conversationRoute: ConversationRoute;

before(async () => {
    ({ prisma } = (await import(
        mod("lib/prisma.ts")
    )) as typeof import("@/lib/prisma"));
    conversationRoute = (await import(
        mod("app/api/conversations/[conversationId]/route.ts")
    )) as ConversationRoute;
});

const resetData = () =>
    prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "Message",
      "Conversation",
      "UserSettings",
      "ChatUsageBucket",
      "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(async () => {
    await resetData();
    sessionOverride = null;
});

after(async () => {
    await resetData();
    await prisma.$disconnect();
});

const seedOwner = async () => {
    const user = await prisma.user.create({
        data: { email: `disclosure-${randomUUID()}@example.test` },
    });
    const conversation = await prisma.conversation.create({
        data: { userId: user.id, title: "disclosure fixture" },
    });
    return { user, conversation };
};

const seedAnswer = (
    conversationId: string,
    memoryUsedCount: number | null,
    createdAt: Date,
    knowledgeChunkCount: number | null = null
) =>
    prisma.message.create({
        data: {
            conversationId,
            role: "assistant",
            content: "An answer.",
            createdAt,
            memoryUsedCount,
            memoryTokens: memoryUsedCount === null ? null : 120,
            knowledgeChunkCount,
        },
    });

const readConversation = async (userId: string, conversationId: string) => {
    sessionOverride = { user: { id: userId } };
    const response = await conversationRoute.GET(
        new Request(`https://tomverse.test/api/conversations/${conversationId}`),
        { params: Promise.resolve({ conversationId }) }
    );
    return { response, body: await response.json() };
};

test("reopening a conversation restates how many memories an answer was given", async () => {
    const { user, conversation } = await seedOwner();
    await seedAnswer(conversation.id, 3, new Date("2026-08-06T00:00:00.000Z"));

    const { response, body } = await readConversation(user.id, conversation.id);
    assert.equal(response.status, 200);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].memoryUsedCount, 3);
});

test("reopening a conversation restates the profile knowledge too", async () => {
    // docs/policy/external-conversation-import-and-memory.md §14.3. Two counts on one
    // answer, each restated as itself -- the point
    // of the pair is that a reader can tell an answer built from their own
    // uploaded files from one built from their stored memories.
    const { user, conversation } = await seedOwner();
    await seedAnswer(conversation.id, 2, new Date("2026-08-06T00:00:00.000Z"), 3);

    const { response, body } = await readConversation(user.id, conversation.id);
    assert.equal(response.status, 200);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].memoryUsedCount, 2);
    assert.equal(body.messages[0].knowledgeChunkCount, 3);
});

test("profile knowledge is restated even when no memory reached the answer", async () => {
    // The two are independent: a profile with knowledge files can answer an
    // account whose memory is off, and the disclosure has to say so without
    // inventing a memory count.
    const { user, conversation } = await seedOwner();
    await seedAnswer(conversation.id, null, new Date("2026-08-06T00:00:00.000Z"), 4);

    const { body } = await readConversation(user.id, conversation.id);
    assert.equal(body.messages.length, 1);
    assert.equal("memoryUsedCount" in body.messages[0], false);
    assert.equal(body.messages[0].knowledgeChunkCount, 4);
});

test("an answer that was given nothing carries no count at all", async () => {
    // `null` (the request could not inject) and `0` (retrieval chose nothing)
    // are different facts, and §13.4 forbids indicating either. The field is
    // absent for both rather than present and zero: a renderer that has to
    // know not to show a number it was sent is one edit away from showing it.
    const { user, conversation } = await seedOwner();
    await seedAnswer(conversation.id, null, new Date("2026-08-06T00:00:00.000Z"));
    await seedAnswer(conversation.id, 0, new Date("2026-08-06T00:00:01.000Z"));

    const { body } = await readConversation(user.id, conversation.id);
    assert.equal(body.messages.length, 2);
    for (const message of body.messages) {
        assert.equal(
            "memoryUsedCount" in message,
            false,
            "an answer with nothing to disclose must not carry the key"
        );
        // docs/policy/external-conversation-import-and-memory.md §14.3 reads `null` and
        // `0` the same way, and seedAnswer leaves the
        // knowledge column NULL here, so both answers must also be silent
        // about knowledge.
        assert.equal(
            "knowledgeChunkCount" in message,
            false,
            "an answer with no knowledge to disclose must not carry the key"
        );
    }
});

test("a knowledge count of zero is silence, not a zero on the wire", async () => {
    // The distinction the column exists to keep: 0 means a bundle was
    // verified and knowledge retrieval selected nothing, which
    // docs/policy/external-conversation-import-and-memory.md §14.3 forbids
    // indicating just as firmly as it forbids indicating NULL.
    const { user, conversation } = await seedOwner();
    await seedAnswer(conversation.id, null, new Date("2026-08-06T00:00:00.000Z"), 0);

    const { body } = await readConversation(user.id, conversation.id);
    assert.equal(body.messages.length, 1);
    assert.equal("knowledgeChunkCount" in body.messages[0], false);
});

test("the token figure is never part of the read", async () => {
    // §13.4 asks for a count. `memoryTokens` exists for §22's aggregates and
    // says something about the memories' length; selecting it here would put
    // it one spread away from the screen.
    const { user, conversation } = await seedOwner();
    await seedAnswer(conversation.id, 2, new Date("2026-08-06T00:00:00.000Z"));

    const { body } = await readConversation(user.id, conversation.id);
    assert.equal("memoryTokens" in body.messages[0], false);
    assert.ok(!JSON.stringify(body).includes("memoryTokens"));
});

test("someone else's conversation discloses nothing, count included", async () => {
    const { conversation } = await seedOwner();
    await seedAnswer(conversation.id, 5, new Date("2026-08-06T00:00:00.000Z"));
    const stranger = await prisma.user.create({
        data: { email: `stranger-${randomUUID()}@example.test` },
    });

    const { response, body } = await readConversation(
        stranger.id,
        conversation.id
    );
    assert.equal(response.status, 403);
    assert.ok(!JSON.stringify(body).includes("memoryUsedCount"));
});
