import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { createConversation } from "@/lib/conversationCreation";
import { REVIEW_PRODUCT_KEY, STUDIO_PRODUCT_KEY } from "@/lib/conversationProduct";
import { prisma } from "@/lib/prisma";
import { beginInstrumentedDispatch } from "@/lib/routingDispatchInstrumentation";

/**
 * Product boundary decision record v1.2, §5 — RoutingRun product attribution.
 *
 * Decision record: docs/policy/routing-run-product-attribution.md.
 *
 * Two things only a database can establish: that deleting a conversation
 * breaks the join without taking the snapshot, and that deleting the account
 * still takes the run. Both are the reason SetNull was chosen over Cascade,
 * and both are invisible to any assertion made in application code.
 */

const reset = () =>
  prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "ContextManifest", "RoutingAttempt", "RoutingRun", "Message", "Conversation" RESTART IDENTITY CASCADE`
  );

const createUser = () =>
  prisma.user.create({ data: { email: `routing-product-${randomUUID()}@example.test` } });

const messages = [
  { role: "system", parts: [{ type: "text" as const, text: "You are Tomverse." }] },
  { role: "user", parts: [{ type: "text" as const, text: "hello" }] },
];

const begin = (overrides: Record<string, unknown> = {}) =>
  beginInstrumentedDispatch({
    traceId: `trace-${randomUUID()}`,
    userId: null,
    subjectKey: `subject-${randomUUID()}`,
    plan: "Pro",
    modelId: "gpt-5-6-luna",
    provider: "openai",
    messages,
    tokenizerVersion: "generic_multilingual_v1",
    tokenCount: 1_200,
    contextWindowTokens: 128_000,
    estimatedInputTokens: 1_000,
    reservedInputTokens: 1_200,
    requestOutputCapTokens: 4_000,
    ...overrides,
  });

beforeEach(async () => {
  process.env.ROUTING_DISPATCH_INSTRUMENTATION = "observe";
  await reset();
});
after(async () => {
  delete process.env.ROUTING_DISPATCH_INSTRUMENTATION;
  await reset();
  await prisma.$disconnect();
});

test("a manual run stores the conversation it belongs to", async () => {
  // It was accepted and dropped before. `assistantMessageId` is set on success
  // only, so without this a failed run named nothing at all.
  const user = await createUser();
  const conversation = await prisma.$transaction((tx) =>
    createConversation(tx, {
      userId: user.id,
      title: "review",
      productKey: REVIEW_PRODUCT_KEY,
    })
  );

  const draft = await begin({
    userId: user.id,
    conversationId: conversation.id,
    productKey: conversation.productKey,
  });
  assert.ok(draft);

  const stored = await prisma.routingRun.findUniqueOrThrow({
    where: { id: draft.runId },
    select: { conversationId: true, productKey: true, assistantMessageId: true },
  });
  assert.deepEqual(stored, {
    conversationId: conversation.id,
    productKey: "review",
    // Nothing has answered yet: this is precisely the state that used to be
    // unattributable.
    assistantMessageId: null,
  });
});

test("deleting the conversation breaks the join and keeps the snapshot", async () => {
  // Cascade here would delete evaluation data every time a user tidies up,
  // and ROUTE-01's sample would shrink with user behaviour.
  const user = await createUser();
  const conversation = await prisma.$transaction((tx) =>
    createConversation(tx, {
      userId: user.id,
      title: "studio",
      productKey: STUDIO_PRODUCT_KEY,
    })
  );

  const draft = await begin({
    userId: user.id,
    conversationId: conversation.id,
    productKey: conversation.productKey,
  });
  assert.ok(draft);

  await prisma.conversation.delete({ where: { id: conversation.id } });

  const stored = await prisma.routingRun.findUniqueOrThrow({
    where: { id: draft.runId },
    select: { conversationId: true, productKey: true },
  });
  assert.deepEqual(stored, { conversationId: null, productKey: "studio" });
});

test("deleting the account still takes the run: userId stays Cascade", async () => {
  // The data-domain policy decided this and §5 does not revisit it. Product
  // attribution is protected from conversation deletion, not from account
  // deletion.
  const user = await createUser();
  const conversation = await prisma.$transaction((tx) =>
    createConversation(tx, {
      userId: user.id,
      title: "review",
      productKey: REVIEW_PRODUCT_KEY,
    })
  );
  const draft = await begin({
    userId: user.id,
    conversationId: conversation.id,
    productKey: conversation.productKey,
  });
  assert.ok(draft);

  await prisma.user.delete({ where: { id: user.id } });

  assert.equal(
    await prisma.routingRun.count({ where: { id: draft.runId } }),
    0
  );
});

test("a turn with no conversation records no product rather than guessing one", async () => {
  // A guest turn has no row to read a product from. Writing one anyway would
  // be a claim about a conversation that does not exist.
  const draft = await begin();
  assert.ok(draft);

  const stored = await prisma.routingRun.findUniqueOrThrow({
    where: { id: draft.runId },
    select: { conversationId: true, productKey: true },
  });
  assert.deepEqual(stored, { conversationId: null, productKey: null });
});

test("the database refuses a product nobody enumerated", async () => {
  // The allowlist is the same as Conversation.productKey's, so `insight` and
  // `code` cannot arrive here either.
  //
  // The refusal surfaces as a null draft and an operational incident rather
  // than a thrown error: instrumentation must never take a chat turn down with
  // it, which is the contract `dispatchInstrumentationMode` exists to keep. So
  // what is asserted is that no row was written -- a test that only checked
  // for a throw would pass if the constraint were dropped.
  const before = await prisma.routingRun.count();
  const draft = await begin({ productKey: "insight" });

  assert.equal(draft, null);
  assert.equal(await prisma.routingRun.count(), before);
});

test("both indexes exist, and the conversationId one is not optional", async () => {
  // PostgreSQL does not index a referencing column for you, and ON DELETE SET
  // NULL has to find the referencing rows -- without it every conversation
  // delete scans the whole table.
  const rows = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
    `SELECT indexname FROM pg_indexes
      WHERE tablename = 'RoutingRun'
        AND indexname IN (
          'RoutingRun_conversationId_idx',
          'RoutingRun_productKey_createdAt_idx'
        )
      ORDER BY indexname`
  );

  assert.deepEqual(
    rows.map((row) => row.indexname),
    ["RoutingRun_conversationId_idx", "RoutingRun_productKey_createdAt_idx"]
  );
});

test("the foreign key is SET NULL, stated by the catalogue rather than inferred", async () => {
  const [row] = await prisma.$queryRawUnsafe<{ confdeltype: string }[]>(
    `SELECT confdeltype::text AS confdeltype FROM pg_constraint
      WHERE conname = 'RoutingRun_conversationId_fkey'`
  );

  // 'n' = SET NULL, 'c' = CASCADE. A test that asserted behaviour only would
  // pass if somebody swapped this for a trigger.
  assert.equal(row?.confdeltype, "n");
});
