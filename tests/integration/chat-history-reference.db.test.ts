import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { createResourceUnlockCookie } from "@/lib/conversationLock";
import { searchConversationMessages } from "@/lib/conversationSearch";
import { CONTINUATION_SEED_VERSION } from "@/lib/externalContinuationSeedCore";
import { historyReferenceAllowed, searchPastChats } from "@/lib/chatHistoryReference";

/**
 * search_past_chats against a real database: what the model is never shown.
 *
 * The permission boundary is a query and a post-filter, so only a database can
 * say that a locked conversation (title included), the current one, an image
 * conversation, a project's conversation, another account's, an imported
 * transcript and a memory-off conversation all stay out, while an ordinary one
 * comes back. A control run with an unlock cookie shows the locked match IS
 * reachable by the user's own search, so its absence here is the tool's doing.
 */

const resetData = () =>
    prisma.$executeRawUnsafe(
        `TRUNCATE TABLE "ConversationContinuationBridge", "Message", "Conversation", "ConversationProject", ` +
            `"ExternalMessage", "ExternalConversation", "ExternalImport", "UserMemorySettings", "User" ` +
            `RESTART IDENTITY CASCADE`
    );

beforeEach(resetData);
after(async () => {
    await resetData();
    await prisma.$disconnect();
});

const createUser = () => prisma.user.create({ data: { email: `history-${randomUUID()}@example.test` } });

const seed = (
    userId: string,
    title: string,
    content: string,
    extra: { password?: string; kind?: string; projectId?: string; memoryMode?: string; assistantProfileVersionId?: string } = {}
) =>
    prisma.conversation.create({
        data: {
            selectedModels: '["gpt-6-luna"]',
            userId,
            title,
            // An image conversation is a Studio row (Conversation_product_modality_check).
            productKey: extra.kind === "image" ? "studio" : "chat",
            ...(extra.password ? { password: extra.password } : {}),
            ...(extra.kind ? { kind: extra.kind } : {}),
            ...(extra.projectId ? { projectId: extra.projectId } : {}),
            ...(extra.memoryMode ? { memoryMode: extra.memoryMode } : {}),
            messages: { create: [{ role: "user", content }] },
        },
    });

const ids = (answer: Awaited<ReturnType<typeof searchPastChats>>) => answer.conversations.map((c) => c.title).sort();

test("only an ordinary conversation of the account comes back; every excluded kind stays out, title included", async () => {
    const user = await createUser();
    const stranger = await createUser();
    const current = await seed(user.id, "Current", "marmot plan in the current conversation");
    await seed(user.id, "Ordinary", "marmot plan from last week");
    await seed(user.id, "Locked", "marmot plan that is locked", { password: "stored-hash" });
    await seed(user.id, "Image tool", "marmot plan for an image", { kind: "image" });
    const project = await prisma.conversationProject.create({ data: { userId: user.id, name: "Alpha" } });
    await seed(user.id, "In a project", "marmot plan in a project", { projectId: project.id });
    await seed(user.id, "Memory off", "marmot plan with memory off", { memoryMode: "off" });
    await seed(stranger.id, "Stranger", "marmot plan of another account");

    const answer = await searchPastChats({ userId: user.id, query: "marmot", currentConversationId: current.id });
    assert.deepEqual(ids(answer), ["Ordinary"]);
    assert.ok(!JSON.stringify(answer).includes("Locked"), "a locked conversation's title is never returned");
    assert.ok(answer.conversations[0]!.excerpts[0]!.excerpt.includes("marmot plan from last week"));
});

test("control: the account's own search does reach the locked conversation once it is unlocked, and the model's never does", async () => {
    const user = await createUser();
    const current = await seed(user.id, "Current", "nothing here");
    const locked = await seed(user.id, "Locked", "heron plan locked", { password: "stored-hash" });
    const request = new Request("https://tomverse.test/api/conversations/search", {
        headers: { cookie: createResourceUnlockCookie("conversation", user.id, locked.id, 0).split(";")[0]! },
    });
    const own = await searchConversationMessages({ request, userId: user.id, query: "heron", displayTimeZone: "UTC" });
    assert.deepEqual(own.results.map((r) => r.conversationId), [locked.id], "the user's own unlocked search finds it");

    const model = await searchPastChats({ userId: user.id, query: "heron", currentConversationId: current.id });
    assert.deepEqual(model.conversations, []);
});

test("an imported transcript's text is never searched for the model", async () => {
    const user = await createUser();
    const current = await seed(user.id, "Current", "nothing here");
    const importRow = await prisma.externalImport.create({
        data: { userId: user.id, provider: "chatgpt", status: "completed", digestVersion: 1, parserVersion: "test" },
    });
    const snapshot = await prisma.externalConversation.create({
        data: {
            userId: user.id, importId: importRow.id, provider: "chatgpt", externalStableId: `stable-${randomUUID()}`, title: "Imported",
            conversationDigest: `digest-${randomUUID()}`, digestVersion: 1, messageCount: 1, contentBytes: BigInt(64), finalized: true,
        },
    });
    await prisma.externalMessage.create({
        data: {
            userId: user.id, externalConversationId: snapshot.id, externalStableId: snapshot.externalStableId, role: "user",
            content: "ibex plan from ChatGPT", contentDigest: "c-0", digestVersion: 1, ordinal: 0,
        },
    });
    const continuation = await seed(user.id, "Continuation", "unrelated words");
    await prisma.conversationContinuationBridge.create({
        data: {
            userId: user.id, conversationId: continuation.id, externalConversationId: snapshot.id, provider: "chatgpt",
            sourceImportedAt: new Date(), sourceConversationDigest: `d-${randomUUID()}`, sourceDigestVersion: 1, sourceMessageCount: 1,
            seedFromOrdinal: 0, seedToOrdinal: 0, seedMessageCount: 1, seedTruncatedMessageCount: 0, seedOmittedMessageCount: 0,
            contextSeedVersion: CONTINUATION_SEED_VERSION, idempotencyKey: randomUUID(),
        },
    });
    const own = await searchConversationMessages({ request: new Request("https://tomverse.test/"), userId: user.id, query: "ibex", displayTimeZone: "UTC" });
    assert.equal(own.results.length, 1, "the user's own search finds the imported text");
    const model = await searchPastChats({ userId: user.id, query: "ibex", currentConversationId: current.id });
    assert.deepEqual(model.conversations, []);
});

test("memory defaults: a conversation inheriting an account default of off is not referenced, an explicit on is", async () => {
    const user = await createUser();
    const current = await seed(user.id, "Current", "nothing here");
    await seed(user.id, "Inherits", "lynx plan inherits");
    await seed(user.id, "Explicit on", "lynx plan explicit", { memoryMode: "on" });
    await prisma.userMemorySettings.create({ data: { userId: user.id, masterEnabled: true, styleEnabled: true, defaultConversationMode: "off" } });
    const answer = await searchPastChats({ userId: user.id, query: "lynx", currentConversationId: current.id });
    assert.deepEqual(ids(answer), ["Explicit on"]);
});

test("the tool is offered by the conversation's real memory state", async () => {
    const user = await createUser();
    const on = await seed(user.id, "On", "x");
    const off = await seed(user.id, "Off", "x", { memoryMode: "off" });
    const locked = await seed(user.id, "Locked", "x", { password: "stored-hash" });
    const stranger = await createUser();
    const others = await seed(stranger.id, "Others", "x");
    const project = await prisma.conversationProject.create({ data: { userId: user.id, name: "Beta" } });
    const inProject = await seed(user.id, "Project chat", "x", { projectId: project.id });
    assert.equal(await historyReferenceAllowed({ userId: user.id, conversationId: on.id }), true);
    assert.equal(await historyReferenceAllowed({ userId: user.id, conversationId: off.id }), false);
    assert.equal(await historyReferenceAllowed({ userId: user.id, conversationId: locked.id }), false);
    assert.equal(await historyReferenceAllowed({ userId: user.id, conversationId: others.id }), false, "another account's conversation is not this account's");
    assert.equal(await historyReferenceAllowed({ userId: user.id, conversationId: inProject.id }), false, "a project conversation never gets account-wide history, even with project tools off");
    await prisma.userMemorySettings.create({ data: { userId: user.id, masterEnabled: false, styleEnabled: true, defaultConversationMode: "on" } });
    assert.equal(await historyReferenceAllowed({ userId: user.id, conversationId: on.id }), false, "the account's master switch");
});

test("excluded conversations cannot take the candidate slots an eligible one needs", async () => {
  const user = await createUser();
  const current = await seed(user.id, "Current", "nothing here");
  const project = await prisma.conversationProject.create({ data: { userId: user.id, name: "Crowd" } });
  // The eligible conversation is the OLDEST; newer excluded ones fill every candidate row (31 groups x 6 rows = the limit).
  await seed(user.id, "Only eligible", "wombat plan");
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (let index = 0; index < 34; index++) {
    const kind = index % 3;
    await prisma.conversation.create({
      data: {
        selectedModels: "[\"gpt-6-luna\"]", userId: user.id, title: `Excluded ${index}`, productKey: "chat",
        ...(kind === 0 ? { password: "stored-hash" } : kind === 1 ? { projectId: project.id } : { memoryMode: "off" }),
        messages: { create: Array.from({ length: 6 }, (_, n) => ({ role: "user", content: `wombat plan ${index} ${n}` })) },
      },
    });
  }
  const answer = await searchPastChats({ userId: user.id, query: "wombat", currentConversationId: current.id });
  assert.deepEqual(ids(answer), ["Only eligible"]);
});
