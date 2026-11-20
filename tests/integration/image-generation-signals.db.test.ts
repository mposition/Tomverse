import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import {
  clearImageGenerationSignal,
  recordImageGenerationSignal,
} from "@/lib/imageGenerationSignals";
import { prisma } from "@/lib/prisma";

// What a person did with a generated image, against a real database: the
// unique (user, generation, kind) row is the idempotence, a generation that
// is not the caller's writes nothing, helpful and not_helpful replace each
// other, a comparison keeps one chosen result per person, and the rows go with
// the generation and with the user.

const requireDedicatedTestDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  if (!testRaw) throw new Error("TEST_DATABASE_URL is required");
  if (process.env.DATABASE_URL?.trim() !== testRaw) {
    throw new Error("REFUSE: DATABASE_URL must equal TEST_DATABASE_URL for this DB test");
  }
};
requireDedicatedTestDatabase();

const resetData = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ImageGenerationSignal",
      "ImageGeneration",
      "ImageGenerationTarget",
      "ImageGenerationGroup",
      "Conversation",
      "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(resetData);
after(async () => {
  await resetData();
  await prisma.$disconnect();
});

const createUser = () =>
  prisma.user.create({ data: { email: `${randomUUID()}@image-signal-test.local`, plan: "Pro" } });

/** A group of one generation per model, the way a comparison writes it. */
const createGroup = async (userId: string, modelIds: string[]) => {
  const conversation = await prisma.conversation.create({
    data: { userId, title: "signals", kind: "image", selectedModels: "[]" },
  });
  const group = await prisma.imageGenerationGroup.create({
    data: { userId, conversationId: conversation.id, groupIdempotencyKey: randomUUID() },
  });
  const generations = [];
  for (const modelId of modelIds) {
    const target = await prisma.imageGenerationTarget.create({
      data: { groupId: group.id, provider: "openai", modelId },
    });
    const generation = await prisma.imageGeneration.create({
      data: {
        userId,
        conversationId: conversation.id,
        idempotencyKey: randomUUID(),
        prompt: "a lighthouse",
        preset: "draft",
        size: "1024x1024",
        quality: "low",
        groupId: group.id,
        targetId: target.id,
      },
    });
    generations.push(generation);
  }
  return generations;
};

const kindsOf = async (userId: string, generationId: string) =>
  (await prisma.imageGenerationSignal.findMany({ where: { userId, generationId }, select: { kind: true } }))
    .map((row) => row.kind)
    .sort();

test("a signal on the caller's own generation is stored once, however often it is sent", async () => {
  const user = await createUser();
  const [generation] = await createGroup(user.id, ["gpt-image-2"]);
  for (let i = 0; i < 3; i += 1) {
    assert.deepEqual(
      await recordImageGenerationSignal({ userId: user.id, generationId: generation.id, kind: "download" }),
      { ok: true }
    );
  }
  // Two presses racing each other end the same way.
  await Promise.all([
    recordImageGenerationSignal({ userId: user.id, generationId: generation.id, kind: "wanted_text" }),
    recordImageGenerationSignal({ userId: user.id, generationId: generation.id, kind: "wanted_text" }),
  ]);
  assert.deepEqual(await kindsOf(user.id, generation.id), ["download", "wanted_text"]);
});

test("another person's generation is refused and leaves no row", async () => {
  const owner = await createUser();
  const stranger = await createUser();
  const [generation] = await createGroup(owner.id, ["gpt-image-2"]);
  assert.deepEqual(
    await recordImageGenerationSignal({ userId: stranger.id, generationId: generation.id, kind: "helpful" }),
    { ok: false, reason: "not_found" }
  );
  assert.deepEqual(
    await recordImageGenerationSignal({ userId: owner.id, generationId: "no-such-generation", kind: "helpful" }),
    { ok: false, reason: "not_found" }
  );
  assert.deepEqual(
    await clearImageGenerationSignal({ userId: stranger.id, generationId: generation.id, kind: "helpful" }),
    { ok: false, reason: "not_found" }
  );
  assert.equal(await prisma.imageGenerationSignal.count(), 0);
});

test("helpful and not_helpful replace each other and the other kinds stay", async () => {
  const user = await createUser();
  const [generation] = await createGroup(user.id, ["gpt-image-2"]);
  const send = (kind: "helpful" | "not_helpful" | "wanted_text") =>
    recordImageGenerationSignal({ userId: user.id, generationId: generation.id, kind });
  await send("wanted_text");
  await send("helpful");
  await send("not_helpful");
  assert.deepEqual(await kindsOf(user.id, generation.id), ["not_helpful", "wanted_text"]);
  await send("helpful");
  assert.deepEqual(await kindsOf(user.id, generation.id), ["helpful", "wanted_text"]);
});

test("taking a signal back removes that kind only, and a missing one is not an error", async () => {
  const user = await createUser();
  const [generation] = await createGroup(user.id, ["gpt-image-2"]);
  await recordImageGenerationSignal({ userId: user.id, generationId: generation.id, kind: "helpful" });
  await recordImageGenerationSignal({ userId: user.id, generationId: generation.id, kind: "wanted_text" });
  for (let i = 0; i < 2; i += 1) {
    assert.deepEqual(
      await clearImageGenerationSignal({ userId: user.id, generationId: generation.id, kind: "helpful" }),
      { ok: true }
    );
  }
  assert.deepEqual(await kindsOf(user.id, generation.id), ["wanted_text"]);
});

test("a comparison keeps one chosen result per person, and one person's choice never moves another's", async () => {
  const user = await createUser();
  const [first, second] = await createGroup(user.id, ["gpt-image-2", "nano-banana-2"]);
  await recordImageGenerationSignal({ userId: user.id, generationId: first.id, kind: "selected" });
  await recordImageGenerationSignal({ userId: user.id, generationId: second.id, kind: "selected" });
  assert.deepEqual(await kindsOf(user.id, first.id), []);
  assert.deepEqual(await kindsOf(user.id, second.id), ["selected"]);
  // Choosing again is a no-op.
  await recordImageGenerationSignal({ userId: user.id, generationId: second.id, kind: "selected" });
  assert.deepEqual(await kindsOf(user.id, second.id), ["selected"]);
});

test("the rows go with the generation and with the user", async () => {
  const user = await createUser();
  const [first, second] = await createGroup(user.id, ["gpt-image-2", "nano-banana-2"]);
  await recordImageGenerationSignal({ userId: user.id, generationId: first.id, kind: "helpful" });
  await recordImageGenerationSignal({ userId: user.id, generationId: second.id, kind: "helpful" });
  await prisma.imageGeneration.delete({ where: { id: first.id } });
  assert.equal(await prisma.imageGenerationSignal.count(), 1);
  await prisma.user.delete({ where: { id: user.id } });
  assert.equal(await prisma.imageGenerationSignal.count(), 0);
});

test("the database refuses a kind the code does not know", async () => {
  const user = await createUser();
  const [generation] = await createGroup(user.id, ["gpt-image-2"]);
  await assert.rejects(
    prisma.imageGenerationSignal.create({
      data: { userId: user.id, generationId: generation.id, kind: "loved_it" },
    })
  );
});
