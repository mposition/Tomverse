import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { createConversation, ConversationProductError } from "@/lib/conversationCreation";
import {
  CHAT_PRODUCT_KEY,
  REVIEW_PRODUCT_KEY,
  STUDIO_PRODUCT_KEY,
} from "@/lib/conversationProduct";
import { prisma } from "@/lib/prisma";

/**
 * Product boundary decision record v1.2, §6 — writer coverage.
 *
 * The static check (scripts/check-conversation-writers.mjs) proves no other
 * file calls `conversation.create` directly. This proves the one that does
 * writes the product, composes with the caller's transaction, and refuses the
 * combinations the CHECKs refuse before the database has to.
 */

const resetData = () =>
  prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "Message", "Conversation" RESTART IDENTITY CASCADE`
  );

const createUser = () =>
  prisma.user.create({ data: { email: `writer-${randomUUID()}@example.test` } });

beforeEach(resetData);
after(async () => {
  await resetData();
  await prisma.$disconnect();
});

test("every product the service creates lands with its productKey set", async () => {
  const user = await createUser();

  const rows = await prisma.$transaction(async (tx) => [
    await createConversation(tx, {
      userId: user.id,
      title: "review",
      productKey: REVIEW_PRODUCT_KEY,
    }),
    await createConversation(tx, {
      userId: user.id,
      title: "chat",
      productKey: CHAT_PRODUCT_KEY,
    }),
    await createConversation(tx, {
      userId: user.id,
      title: "studio",
      productKey: STUDIO_PRODUCT_KEY,
    }),
  ]);

  assert.deepEqual(
    rows.map((row) => [row.productKey, row.kind]),
    [
      ["review", "chat"],
      ["chat", "chat"],
      ["studio", "image"],
    ]
  );
  // The point of the required argument: no path through the service leaves it
  // NULL, which is what the CHECKs cannot establish.
  assert.equal(
    await prisma.conversation.count({ where: { productKey: null } }),
    0
  );
});

test("the modality comes from the product, so a caller cannot forget it", async () => {
  const user = await createUser();
  const row = await prisma.$transaction((tx) =>
    createConversation(tx, {
      userId: user.id,
      title: "studio default",
      productKey: STUDIO_PRODUCT_KEY,
    })
  );

  assert.equal(row.kind, "image");
});

test("a product and modality that disagree are refused before the database", async () => {
  // Refused in application code as well as by the CHECK, because the database's
  // message names a constraint and this one names the call site.
  const user = await createUser();

  await assert.rejects(
    prisma.$transaction((tx) =>
      createConversation(tx, {
        userId: user.id,
        title: "studio in chat",
        productKey: STUDIO_PRODUCT_KEY,
        kind: "chat",
      })
    ),
    (error: unknown) =>
      error instanceof ConversationProductError && error.violation === "product_modality"
  );

  assert.equal(await prisma.conversation.count(), 0);
});

test("Auto outside Chat is refused before the database", async () => {
  const user = await createUser();

  await assert.rejects(
    prisma.$transaction((tx) =>
      createConversation(tx, {
        userId: user.id,
        title: "auto review",
        productKey: REVIEW_PRODUCT_KEY,
        selectionMode: "auto",
      })
    ),
    (error: unknown) =>
      error instanceof ConversationProductError && error.violation === "auto_not_chat"
  );
});

test("the service opens no transaction of its own, so a caller's rollback takes the row", async () => {
  // The reason it takes a TransactionClient. All three production writers have
  // work that must land with the conversation or not at all -- a capacity
  // assertion, the imported messages, the image reservation -- and a service
  // with its own transaction would leave an orphan behind.
  const user = await createUser();

  await assert.rejects(
    prisma.$transaction(async (tx) => {
      await createConversation(tx, {
        userId: user.id,
        title: "rolled back",
        productKey: REVIEW_PRODUCT_KEY,
      });
      throw new Error("caller failed after the create");
    })
  );

  assert.equal(await prisma.conversation.count(), 0);
});

test("a selected narrower row still gets its product written", async () => {
  // The image path asks for `{ id: true }`. What it does not select is still
  // stored.
  const user = await createUser();
  const created = await prisma.$transaction((tx) =>
    createConversation(
      tx,
      { userId: user.id, title: "image", productKey: STUDIO_PRODUCT_KEY },
      { id: true }
    )
  );

  const stored = await prisma.conversation.findUniqueOrThrow({
    where: { id: created.id },
    select: { productKey: true, kind: true },
  });
  assert.deepEqual(stored, { productKey: "studio", kind: "image" });
});
