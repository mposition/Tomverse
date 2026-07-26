import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { applyGeneratedTitle } from "@/lib/conversationTitle";
import { prisma } from "@/lib/prisma";

const resetConversationTitleTestData = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "Message",
      "Conversation",
      "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(resetConversationTitleTestData);
after(async () => {
  await resetConversationTitleTestData();
  await prisma.$disconnect();
});

const createUser = () =>
  prisma.user.create({
    data: { email: `conversation-title-${randomUUID()}@example.test` },
  });

const createConversation = (userId: string, title: string) =>
  prisma.conversation.create({
    data: { userId, title },
  });

test("applyGeneratedTitle updates the title when it still matches expectedTitle", async () => {
  const user = await createUser();
  const conversation = await createConversation(user.id, "Plan a weekend trip");

  const result = await applyGeneratedTitle({
    conversationId: conversation.id,
    userId: user.id,
    expectedTitle: "Plan a weekend trip",
    newTitle: "Weekend Trip Planning",
  });

  assert.equal(result.updated, true);
  const stored = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversation.id },
  });
  assert.equal(stored.title, "Weekend Trip Planning");
});

test("applyGeneratedTitle no-ops when the title already changed (manual rename won the race)", async () => {
  const user = await createUser();
  const conversation = await createConversation(user.id, "Plan a weekend trip");

  // Simulates the user manually renaming the conversation while generation
  // was still in flight.
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { title: "My Renamed Chat" },
  });

  const result = await applyGeneratedTitle({
    conversationId: conversation.id,
    userId: user.id,
    expectedTitle: "Plan a weekend trip",
    newTitle: "Weekend Trip Planning",
  });

  assert.equal(result.updated, false);
  const stored = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversation.id },
  });
  assert.equal(stored.title, "My Renamed Chat");
});

test("applyGeneratedTitle is scoped to the owning user and cannot touch another user's conversation", async () => {
  const owner = await createUser();
  const attacker = await createUser();
  const conversation = await createConversation(owner.id, "Plan a weekend trip");

  const result = await applyGeneratedTitle({
    conversationId: conversation.id,
    userId: attacker.id,
    expectedTitle: "Plan a weekend trip",
    newTitle: "Hijacked Title",
  });

  assert.equal(result.updated, false);
  const stored = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversation.id },
  });
  assert.equal(stored.title, "Plan a weekend trip");
});

test("applyGeneratedTitle is idempotent -- a duplicate call after success is a no-op", async () => {
  const user = await createUser();
  const conversation = await createConversation(user.id, "Plan a weekend trip");

  const first = await applyGeneratedTitle({
    conversationId: conversation.id,
    userId: user.id,
    expectedTitle: "Plan a weekend trip",
    newTitle: "Weekend Trip Planning",
  });
  assert.equal(first.updated, true);

  // A second concurrent/duplicate request racing on the same expectedTitle
  // must not re-apply (or reapply) the update, since the stored title no
  // longer equals the original expectedTitle.
  const second = await applyGeneratedTitle({
    conversationId: conversation.id,
    userId: user.id,
    expectedTitle: "Plan a weekend trip",
    newTitle: "Weekend Trip Planning",
  });
  assert.equal(second.updated, false);

  const stored = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversation.id },
  });
  assert.equal(stored.title, "Weekend Trip Planning");
});

test("applyGeneratedTitle returns updated:false for a nonexistent conversation without throwing", async () => {
  const user = await createUser();

  const result = await applyGeneratedTitle({
    conversationId: "does-not-exist",
    userId: user.id,
    expectedTitle: "Plan a weekend trip",
    newTitle: "Weekend Trip Planning",
  });

  assert.equal(result.updated, false);
});
