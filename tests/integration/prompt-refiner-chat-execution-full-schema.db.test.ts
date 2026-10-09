import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const rawUrl = process.env.TEST_DATABASE_URL?.trim();
test("Refiner execution with migrated schema, canonical audit and durable recovery", { skip: !rawUrl }, async t => {
  if (!rawUrl) return;
  const url = new URL(rawUrl);
  assert.match(decodeURIComponent(url.pathname), /(?:^|[_-])test(?:[_-]|$)/);
  process.env.DATABASE_URL = rawUrl;
  Object.assign(process.env, { NODE_ENV: "test" });
  process.env.NEXTAUTH_SECRET ||= "refiner-full-schema-synthetic-secret";
  const root = resolve(import.meta.dirname, "..", "..");
  const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
  mock.module(mod("lib/promptRefinerChatExecutionRelease.ts"), { namedExports: {
    promptRefinerChatExecutionRelease: () => ({ explicitEnabled: true, autoEnabled: false }),
  } });
  const { prisma } = await import("@/lib/prisma");
  const store = await import("@/lib/promptRefinerChatExecutionStore");
  const { consumeChatDraftForMessage } = await import("@/lib/chatDraftMessageConsume");
  const { claimChatResponseAttempt, readChatResponseAttempt } = await import("@/lib/chatResponseAttemptPersistence");
  const { chatResponseAttemptRequestPayloadDigest } = await import("@/lib/chatResponseAttemptCore");
  const { verifyAdminAuditIntegrity } = await import("@/lib/adminAuditIntegrity");
  const userId = randomUUID(); const conversationId = randomUUID();
  const original = "  authored Cafe\u0301 🙂\r\nunchanged  ";
  try {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.invalid` } });
    await prisma.conversation.create({ data: { id: conversationId, userId, title: "Synthetic Refiner", kind: "chat", productKey: "chat" } });
    const scope = await store.advancePromptRefinerChatScope({ userId, conversationId, mountId: randomUUID(), surface: "chat" });
    await prisma.chatComposerDraft.create({ data: { userId, scopeKey: conversationId, conversationId, text: original, attachmentReferences: [] } });
    const snapshot = await store.capturePromptRefinerChatDraft({ userId, conversationId, scopeId: scope.id, epoch: scope.epoch });
    const held = await store.holdPromptRefinerChatSuggestion({ snapshot, mode: "explicit", response: {
      requestId: snapshot.requestId, suggestionId: randomUUID(), refinedPrompt: "Exact server-held execution prompt.",
      refinerVersion: "suggest-v2", inputScope: "current_user_turn_text_only",
    } });
    await t.test("real draft consume and source save preserve the proposal until commit", async () => {
      await prisma.$transaction(async tx => {
        await consumeChatDraftForMessage(tx, { userId, conversationId,
          draftConsume: { scopeKey: conversationId, expectedRevision: snapshot.draftRevision, messageId: snapshot.sourceMessageId },
          message: { id: snapshot.sourceMessageId, content: original, attachmentReferences: [] } });
        await tx.message.create({ data: { id: snapshot.sourceMessageId, conversationId, role: "user", content: original } });
      });
      const row = await prisma.promptRefinerChatSuggestion.findUniqueOrThrow({ where: { id: held.suggestionId } });
      assert.equal(row.state, "ready");
      assert.equal(row.sourcePrompt, original);
    });
    const input = { userId, conversationId, sourceMessageId: snapshot.sourceMessageId,
      messages: [{ id: snapshot.sourceMessageId, role: "user" as const, content: original }],
      decision: { suggestionId: held.suggestionId, scopeId: held.scopeId, epoch: held.epoch, decision: "accepted" } };
    const view = await store.consumePromptRefinerChatExecution(input);
    await t.test("real canonical audit and body purge are atomic with consumption", async () => {
      assert.equal(view.executionMessages.at(-1)?.content, "Exact server-held execution prompt.");
      assert.equal((await prisma.message.findUniqueOrThrow({ where: { id: snapshot.sourceMessageId } })).content, original);
      const row = await prisma.promptRefinerChatSuggestion.findUniqueOrThrow({ where: { id: held.suggestionId } });
      assert.equal(row.state, "consumed"); assert.equal(row.sourcePrompt, null); assert.equal(row.refinedPrompt, null);
      const audits = await prisma.adminAuditLog.findMany({ where: { targetId: held.suggestionId }, orderBy: { createdAt: "asc" } });
      assert.deepEqual(audits.map(row => row.action), ["prompt_refiner.chat_suggestion_held", "prompt_refiner.chat_decision_consumed"]);
      assert.equal(JSON.stringify(audits).includes(original), false);
      assert.equal((await verifyAdminAuditIntegrity()).valid, true);
      await assert.rejects(store.consumePromptRefinerChatExecution(input), /no longer available/);
    });
    await t.test("durable reattach uses execution identity without consuming or sending again", async () => {
      const assistantMessageId = randomUUID();
      const attemptInput = { userId, conversationId, assistantMessageId, sourceUserMessageId: snapshot.sourceMessageId,
        requestedModelId: "gpt-5-4-mini", requestPayloadDigest: chatResponseAttemptRequestPayloadDigest({ messages: [...view.executionMessages], requestedModelId: "gpt-5-4-mini", webSearchMode: "off", context: null }),
        expectedRecoveryEpoch: snapshot.recoveryEpoch, ownerId: randomUUID(), leaseExpiresAt: new Date(Date.now() + 120_000) };
      assert.equal((await claimChatResponseAttempt(attemptInput)).disposition, "claimed");
      assert.equal((await claimChatResponseAttempt({ ...attemptInput, ownerId: randomUUID() })).disposition, "reattach");
      const readback = await readChatResponseAttempt(userId, assistantMessageId, conversationId);
      assert.equal(readback?.sourceUserMessageId, snapshot.sourceMessageId);
      assert.equal((await prisma.chatResponseAttempt.count({ where: { userId } })), 1);
    });
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } }); await prisma.$disconnect();
  }
});
