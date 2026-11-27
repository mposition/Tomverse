import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { buildAccountDataExport } from "@/lib/accountDataExport";
import { saveUserPersonalization } from "@/lib/chatPersonalization";
import { buildChatTurnContext } from "@/lib/chatTurnContext";
import { deleteOwnedConversations } from "@/lib/conversationDeletion";
import { prisma } from "@/lib/prisma";
import { TEMPORARY_CHAT_SWEEP_GRACE_MS, temporarySweepCutoff } from "@/lib/temporaryChatAccess";
import { sweepExpiredTemporaryConversations } from "@/lib/temporaryConversationSweep";

/**
 * Personal instructions, temporary Chat and answer ratings against real rows
 * (migration 20261127100000_chat_personalization_privacy).
 *
 * The part that matters most is the deletion boundary: the temporary Chat
 * sweep deletes user data on its own, so these scenarios pin that an
 * ordinary conversation -- however old -- is never chosen, that an answer
 * still running holds its conversation, and that the database itself keeps
 * a temporary row out of projects and memory.
 */

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ChatAnswerRating",
      "UserPersonalization",
      "ChatResponseAttempt",
      "Message",
      "Conversation",
      "ConversationProject",
      "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

const MODELS = '["gpt-6-luna"]';
const FINGERPRINT = "a".repeat(64);

const seedUser = () => prisma.user.create({ data: { email: `${randomUUID()}@example.test`, plan: "Pro" } });

const seedConversation = async (
  userId: string,
  options: { temporaryExpiresAt?: Date; createdAt?: Date } = {}
) => {
  const conversation = await prisma.conversation.create({
    data: {
      userId,
      title: "t",
      productKey: "chat",
      selectedModels: MODELS,
      ...(options.temporaryExpiresAt ? { memoryMode: "off", temporaryExpiresAt: options.temporaryExpiresAt } : {}),
      ...(options.createdAt ? { createdAt: options.createdAt, updatedAt: options.createdAt } : {}),
    },
  });
  const question = await prisma.message.create({
    data: { conversationId: conversation.id, role: "user", content: "question" },
  });
  const answer = await prisma.message.create({
    data: { conversationId: conversation.id, role: "assistant", content: "answer", modelId: "gpt-6-luna" },
  });
  return { conversation, question, answer };
};

const seedAttempt = (input: {
  userId: string;
  conversationId: string;
  sourceUserMessageId: string;
  updatedAt: Date;
  leaseExpiresAt: Date;
}) =>
  prisma.chatResponseAttempt.create({
    data: {
      assistantMessageId: randomUUID(),
      userId: input.userId,
      conversationId: input.conversationId,
      sourceUserMessageId: input.sourceUserMessageId,
      fingerprint: FINGERPRINT,
      requestedModelId: "gpt-6-luna",
      ownerId: "worker-1",
      status: "streaming",
      leaseExpiresAt: input.leaseExpiresAt,
      updatedAt: input.updatedAt,
    },
  });

const exists = async (conversationId: string) =>
  (await prisma.conversation.count({ where: { id: conversationId } })) === 1;

/* ------------------------------------------------------------- the sweep -- */

test("the sweep deletes only expired temporary Chats and never an ordinary conversation", async () => {
  const now = new Date();
  const owner = await seedUser();
  const other = await seedUser();
  const ancient = new Date(now.getTime() - 3 * 365 * 24 * 60 * 60 * 1000);

  const ordinary = await seedConversation(owner.id, { createdAt: ancient });
  const othersOrdinary = await seedConversation(other.id, { createdAt: ancient });
  const expired = await seedConversation(owner.id, { temporaryExpiresAt: new Date(now.getTime() - 60 * 60 * 1000) });
  const othersExpired = await seedConversation(other.id, { temporaryExpiresAt: new Date(now.getTime() - 60 * 60 * 1000) });
  const withinGrace = await seedConversation(owner.id, {
    temporaryExpiresAt: new Date(now.getTime() - TEMPORARY_CHAT_SWEEP_GRACE_MS / 2),
  });
  const live = await seedConversation(owner.id, { temporaryExpiresAt: new Date(now.getTime() + 60 * 60 * 1000) });
  await prisma.chatAnswerRating.create({
    data: {
      userId: owner.id,
      messageId: expired.answer.id,
      conversationId: expired.conversation.id,
      modelId: "gpt-6-luna",
      rating: "up",
    },
  });

  const result = await sweepExpiredTemporaryConversations(now);
  assert.deepEqual(result, { examined: 2, deleted: 2, deferred: 0, failed: 0 });

  assert.equal(await exists(expired.conversation.id), false);
  assert.equal(await exists(othersExpired.conversation.id), false);
  // Gone with it, by cascade: its messages and the rating on its answer.
  assert.equal(await prisma.message.count({ where: { conversationId: expired.conversation.id } }), 0);
  assert.equal(await prisma.chatAnswerRating.count(), 0);

  // Untouched: ordinary conversations of any age and owner, a temporary Chat
  // inside its grace period, and one that has not expired.
  for (const kept of [ordinary, othersOrdinary, withinGrace, live]) {
    assert.equal(await exists(kept.conversation.id), true);
    assert.equal(await prisma.message.count({ where: { conversationId: kept.conversation.id } }), 2);
  }

  // A second pass finds nothing more to do.
  assert.deepEqual(await sweepExpiredTemporaryConversations(now), { examined: 0, deleted: 0, deferred: 0, failed: 0 });
});

test("an answer still running holds an expired temporary Chat until its lease lapses", async () => {
  const now = new Date();
  const owner = await seedUser();
  const running = await seedConversation(owner.id, { temporaryExpiresAt: new Date(now.getTime() - 60 * 60 * 1000) });
  const abandoned = await seedConversation(owner.id, { temporaryExpiresAt: new Date(now.getTime() - 60 * 60 * 1000) });
  await seedAttempt({
    userId: owner.id,
    conversationId: running.conversation.id,
    sourceUserMessageId: running.question.id,
    updatedAt: now,
    leaseExpiresAt: new Date(now.getTime() + 4 * 60 * 1000),
  });
  // A worker that died: its lease ran out six minutes ago.
  await seedAttempt({
    userId: owner.id,
    conversationId: abandoned.conversation.id,
    sourceUserMessageId: abandoned.question.id,
    updatedAt: new Date(now.getTime() - 10 * 60 * 1000),
    leaseExpiresAt: new Date(now.getTime() - 6 * 60 * 1000),
  });

  assert.deepEqual(await sweepExpiredTemporaryConversations(now), { examined: 2, deleted: 1, deferred: 1, failed: 0 });
  assert.equal(await exists(running.conversation.id), true);
  assert.equal(await exists(abandoned.conversation.id), false);

  // Once the running answer's lease has lapsed, the next pass deletes it.
  const later = new Date(now.getTime() + 5 * 60 * 1000);
  assert.deepEqual(await sweepExpiredTemporaryConversations(later), { examined: 1, deleted: 1, deferred: 0, failed: 0 });
  assert.equal(await exists(running.conversation.id), false);
});

test("the sweep's deletion scope drops an ordinary or foreign id before anything is touched", async () => {
  const now = new Date();
  const owner = await seedUser();
  const other = await seedUser();
  const ordinary = await seedConversation(owner.id);
  const foreignTemporary = await seedConversation(other.id, { temporaryExpiresAt: new Date(now.getTime() - 60 * 60 * 1000) });
  const cutoff = temporarySweepCutoff(now);

  const deleted = await prisma.$transaction((tx) =>
    deleteOwnedConversations(tx, {
      userId: owner.id,
      conversationIds: [ordinary.conversation.id, foreignTemporary.conversation.id],
      temporaryExpiredBefore: cutoff,
    })
  );
  assert.deepEqual(deleted, { count: 0, conversationIds: [] });
  assert.equal(await exists(ordinary.conversation.id), true);
  assert.equal(await exists(foreignTemporary.conversation.id), true);

  // The owner's own delete still removes an ordinary conversation.
  const own = await prisma.$transaction((tx) =>
    deleteOwnedConversations(tx, { userId: owner.id, conversationIds: [ordinary.conversation.id] })
  );
  assert.equal(own.count, 1);
  assert.equal(await exists(ordinary.conversation.id), false);
});

/* ------------------------------------------------------ database guards -- */

test("the database keeps a temporary Chat out of projects and with memory off", async () => {
  const owner = await seedUser();
  const project = await prisma.conversationProject.create({ data: { userId: owner.id, name: "p" } });
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const temporary = (data: Record<string, unknown>) =>
    prisma.conversation.create({
      data: { userId: owner.id, title: "t", productKey: "chat", selectedModels: MODELS, temporaryExpiresAt: expiresAt, ...data },
    });

  await assert.rejects(temporary({ memoryMode: "off", projectId: project.id }), /Conversation_temporary_scope_check/);
  await assert.rejects(temporary({}), /Conversation_temporary_scope_check/);
  await assert.rejects(temporary({ memoryMode: "on" }), /Conversation_temporary_scope_check/);
  const ok = await temporary({ memoryMode: "off" });
  await assert.rejects(
    prisma.conversation.update({ where: { id: ok.id }, data: { projectId: project.id } }),
    /Conversation_temporary_scope_check/
  );
  await assert.rejects(
    prisma.conversation.update({ where: { id: ok.id }, data: { memoryMode: "inherit" } }),
    /Conversation_temporary_scope_check/
  );
  // An ordinary conversation is unaffected by the new constraint.
  await prisma.conversation.create({
    data: { userId: owner.id, title: "t", productKey: "chat", selectedModels: MODELS, projectId: project.id },
  });
});

test("ratings: one per person per answer, closed values, a reason only on down", async () => {
  const owner = await seedUser();
  const { conversation, answer } = await seedConversation(owner.id);
  const rate = (data: Record<string, unknown>) =>
    prisma.chatAnswerRating.create({
      data: { userId: owner.id, messageId: answer.id, conversationId: conversation.id, modelId: "gpt-6-luna", ...data } as never,
    });
  await assert.rejects(rate({ rating: "meh" }), /ChatAnswerRating_rating_check/);
  await assert.rejects(rate({ rating: "up", reason: "inaccurate" }), /ChatAnswerRating_reason_rating_check/);
  await assert.rejects(rate({ rating: "down", reason: "rude" }), /ChatAnswerRating_reason_check/);
  await rate({ rating: "down", reason: "incomplete" });
  await assert.rejects(rate({ rating: "up" }), /Unique constraint|P2002/);
  // Deleting the answer takes its rating.
  await prisma.message.delete({ where: { id: answer.id } });
  assert.equal(await prisma.chatAnswerRating.count(), 0);
});

test("personal instructions: closed style list, length limit, deleted with the account", async () => {
  const owner = await seedUser();
  await assert.rejects(
    prisma.userPersonalization.create({ data: { userId: owner.id, responseStyle: "loud" } }),
    /UserPersonalization_responseStyle_check/
  );
  await assert.rejects(
    prisma.userPersonalization.create({ data: { userId: owner.id, aboutMe: "x".repeat(1501) } }),
    /UserPersonalization_aboutMe_length_check/
  );
  await saveUserPersonalization(owner.id, { aboutMe: "a", responsePreferences: "b", responseStyle: "formal" });
  await prisma.user.delete({ where: { id: owner.id } });
  assert.equal(await prisma.userPersonalization.count(), 0);
});

/* ------------------------------------------------- turn context & export -- */

test("saved instructions reach the turn's context block, priced, and an edit changes the fingerprint", async () => {
  const owner = await seedUser();
  const before = await buildChatTurnContext({ userId: owner.id, query: "hello" });
  assert.equal(before.preferenceTokens, 0);
  assert.equal(before.fingerprintInput.preferencesHash, undefined);

  await saveUserPersonalization(owner.id, {
    aboutMe: "I write TypeScript in Brisbane.",
    responsePreferences: "Show code first.",
    responseStyle: "concise",
  });
  const first = await buildChatTurnContext({ userId: owner.id, query: "hello" });
  assert.ok(first.systemPrompt?.includes("I write TypeScript in Brisbane."));
  assert.ok(first.systemPrompt?.includes("Answer style: Keep answers brief"));
  assert.ok((first.preferenceTokens ?? 0) > 0);
  assert.notEqual(first.fingerprint, before.fingerprint);

  // Stable while unchanged -- the cached prompt prefix depends on it.
  const again = await buildChatTurnContext({ userId: owner.id, query: "a different question" });
  assert.equal(again.fingerprintInput.preferencesHash, first.fingerprintInput.preferencesHash);

  await saveUserPersonalization(owner.id, {
    aboutMe: "I write Rust in Brisbane.",
    responsePreferences: "Show code first.",
    responseStyle: "concise",
  });
  const edited = await buildChatTurnContext({ userId: owner.id, query: "hello" });
  assert.notEqual(edited.fingerprint, first.fingerprint);

  // A guest has none.
  const guest = await buildChatTurnContext({ userId: null, query: "hello" });
  assert.equal(guest.preferenceTokens, 0);
});

test("the account export carries instructions, ratings and a temporary Chat's expiry", async () => {
  const owner = await seedUser();
  await saveUserPersonalization(owner.id, { aboutMe: "about", responsePreferences: "", responseStyle: "detailed" });
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const temporary = await seedConversation(owner.id, { temporaryExpiresAt: expiresAt });
  await prisma.chatAnswerRating.create({
    data: {
      userId: owner.id,
      messageId: temporary.answer.id,
      conversationId: temporary.conversation.id,
      modelId: "gpt-6-luna",
      rating: "down",
      reason: "unhelpful",
    },
  });
  const exported = (await buildAccountDataExport(owner.id)) as unknown as { data: Record<string, unknown[]> };
  assert.deepEqual(
    (exported.data.personal_instructions as Array<Record<string, unknown>>).map((row) => row.responseStyle),
    ["detailed"]
  );
  const ratings = exported.data.answer_ratings as Array<Record<string, unknown>>;
  assert.equal(ratings.length, 1);
  assert.equal(ratings[0].reason, "unhelpful");
  assert.equal(ratings[0].modelId, "gpt-6-luna");
  const conversations = exported.data.conversations as Array<Record<string, unknown>>;
  assert.equal((conversations[0].temporaryExpiresAt as Date).getTime(), expiresAt.getTime());
});
