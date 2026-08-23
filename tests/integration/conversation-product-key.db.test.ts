import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import {
  CONVERSATION_PRODUCT_KEYS,
  conversationProductViolation,
} from "@/lib/conversationProduct";

/**
 * Product boundary decision record v1.2, decision 2 — Conversation.productKey.
 *
 * What is under test here is the **constraint**, not the application. So every
 * case writes straight to the database rather than through a service: the
 * question is what Postgres refuses when a migration, an admin console, a
 * support script or a future code path writes a row another way. An assertion
 * routed through application code would only prove the application agrees with
 * itself.
 *
 * The eight-combination matrix from the decision record, in order. Case 8 --
 * "NULL is refused after the strict transition" -- is deliberately NOT
 * executed here: NOT NULL is a later migration with its own evidence, and a
 * test that asserted it today would either fail or be quietly written to pass
 * on the wrong thing. It is pinned below as a requirement on that migration
 * instead.
 */

const resetData = () =>
  prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "Message", "Conversation" RESTART IDENTITY CASCADE`
  );

const createUser = () =>
  prisma.user.create({
    data: { email: `product-key-${randomUUID()}@example.test` },
  });

const seed = (userId: string, data: Record<string, unknown> = {}) =>
  prisma.conversation.create({
    data: { userId, title: "product key fixture", ...data },
  });

/** The constraint name Postgres reports, so a case cannot pass on the wrong refusal. */
const refusalConstraint = async (write: () => Promise<unknown>): Promise<string> => {
  try {
    await write();
  } catch (error) {
    const message = String(error);
    for (const name of [
      "Conversation_product_key_check",
      "Conversation_product_modality_check",
      "Conversation_auto_only_chat_check",
      "Conversation_manual_has_no_sticky_state_check",
    ]) {
      if (message.includes(name)) return name;
    }
    return `unrecognised refusal: ${message.slice(0, 300)}`;
  }
  return "accepted";
};

beforeEach(resetData);
after(async () => {
  await resetData();
  await prisma.$disconnect();
});

/* ------------------------------------------- the eight-combination matrix */

// 1. review + manual + chat kind
test("Review is a manual chat conversation", async () => {
  const user = await createUser();
  const conversation = await seed(user.id, {
    productKey: "review",
    selectionMode: "manual",
  });

  assert.equal(conversation.productKey, "review");
  assert.equal(conversation.kind, "chat");
});

// 2. review + auto
test("Review cannot be Auto: Auto is a Chat feature", async () => {
  const user = await createUser();
  assert.equal(
    await refusalConstraint(() =>
      seed(user.id, { productKey: "review", selectionMode: "auto" })
    ),
    "Conversation_auto_only_chat_check"
  );
});

// 3. studio + manual + image kind
test("Studio is a manual image conversation", async () => {
  const user = await createUser();
  const conversation = await seed(user.id, {
    productKey: "studio",
    kind: "image",
    selectionMode: "manual",
  });

  assert.equal(conversation.productKey, "studio");
  assert.equal(conversation.kind, "image");
});

// 4. studio + auto + image
test("Studio cannot be Auto either", async () => {
  // v1.1 forbade only `review + auto`, and this combination passed. The
  // constraint is written as one allowed product for exactly this reason.
  const user = await createUser();
  assert.equal(
    await refusalConstraint(() =>
      seed(user.id, { productKey: "studio", kind: "image", selectionMode: "auto" })
    ),
    "Conversation_auto_only_chat_check"
  );
});

// 5. studio + manual + chat kind
test("Studio cannot run in the chat modality", async () => {
  // productKey and kind are independent columns: without the cross constraint
  // this row -- an image product nothing in the image pipeline would open --
  // passes silently.
  const user = await createUser();
  assert.equal(
    await refusalConstraint(() =>
      seed(user.id, { productKey: "studio", kind: "chat", selectionMode: "manual" })
    ),
    "Conversation_product_modality_check"
  );
});

// 6. chat + auto + chat kind
test("Chat is the one product Auto may route", async () => {
  const user = await createUser();
  const conversation = await seed(user.id, {
    productKey: "chat",
    selectionMode: "auto",
  });

  assert.equal(conversation.productKey, "chat");
  assert.equal(conversation.selectionMode, "auto");
});

// 7. NULL during the transition
test("productKey is nullable while the transition runs", async () => {
  const user = await createUser();
  const conversation = await seed(user.id);

  assert.equal(conversation.productKey, null);
});

// 8. NULL after strict — a requirement on a later migration, not a test today.
test("the NOT NULL transition is a separate migration and has not happened", async () => {
  // Pinned rather than skipped. If somebody adds NOT NULL to the expand
  // migration, this fails and says why: strict is step 7 of the sequence, and
  // it needs the backfill report and the rollback rehearsal first.
  const [column] = await prisma.$queryRawUnsafe<{ is_nullable: string }[]>(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'Conversation' AND column_name = 'productKey'`
  );

  assert.equal(
    column?.is_nullable,
    "YES",
    "productKey must stay nullable until the backfill reports zero unclassified rows"
  );
});

/* ---------------------------------------------------- the allowlist itself */

test("the database refuses a product nobody enumerated", async () => {
  const user = await createUser();
  assert.equal(
    await refusalConstraint(() => seed(user.id, { productKey: "insight" })),
    "Conversation_product_key_check"
  );
});

test("code is not a value this column admits", async () => {
  // The brand axis has four products; this column has three. Tomverse Code
  // writes no conversations, so a `code` row would be one nothing can open.
  const user = await createUser();
  assert.equal(
    await refusalConstraint(() => seed(user.id, { productKey: "code" })),
    "Conversation_product_key_check"
  );
  assert.ok(!(CONVERSATION_PRODUCT_KEYS as readonly string[]).includes("code"));
});

test("there is no default: an omitted productKey stays unknown", async () => {
  // The point of the nullability. A `review` default would make a writer that
  // forgot the column look like one that meant Review.
  const user = await createUser();
  const conversation = await seed(user.id);
  const [column] = await prisma.$queryRawUnsafe<{ column_default: string | null }[]>(
    `SELECT column_default FROM information_schema.columns
      WHERE table_name = 'Conversation' AND column_name = 'productKey'`
  );

  assert.equal(conversation.productKey, null);
  assert.equal(column?.column_default, null);
});

/* --------------------------------------------------- update, not just insert */

test("the same rules hold on update", async () => {
  const user = await createUser();
  const conversation = await seed(user.id, { productKey: "review" });

  assert.equal(
    await refusalConstraint(() =>
      prisma.conversation.update({
        where: { id: conversation.id },
        data: { selectionMode: "auto" },
      })
    ),
    "Conversation_auto_only_chat_check"
  );

  assert.equal(
    await refusalConstraint(() =>
      prisma.conversation.update({
        where: { id: conversation.id },
        data: { productKey: "studio" },
      })
    ),
    "Conversation_product_modality_check"
  );
});

/* ------------------------------------- the constraints are NOT VALID on purpose */

test("all three constraints are present and NOT VALID", async () => {
  const rows = await prisma.$queryRawUnsafe<{ conname: string; convalidated: boolean }[]>(
    `SELECT conname, convalidated FROM pg_constraint
      WHERE conrelid = '"Conversation"'::regclass
        AND conname IN (
          'Conversation_product_key_check',
          'Conversation_product_modality_check',
          'Conversation_auto_only_chat_check'
        )
      ORDER BY conname`
  );

  assert.equal(rows.length, 3, "all three constraints exist");
  for (const row of rows) {
    assert.equal(
      row.convalidated,
      false,
      `${row.conname} must stay NOT VALID until the backfill report reads zero`
    );
  }
});

test("a NOT VALID constraint does not stop a writer that omits the column", async () => {
  // The reason the shared creation service, the direct-create static check and
  // the writer coverage tests all stay necessary after this migration: every
  // constraint above passes `productKey IS NULL`, so an omission is stored as
  // a legal row.
  const user = await createUser();
  const conversation = await seed(user.id, { selectionMode: "manual" });

  assert.equal(conversation.productKey, null);
});

/* --------------------------------- the application copy agrees with the database */

test("the application predicate refuses exactly what the database refuses", async () => {
  const user = await createUser();
  const cases = [
    { productKey: "review", kind: "chat", selectionMode: "manual" },
    { productKey: "review", kind: "chat", selectionMode: "auto" },
    { productKey: "studio", kind: "image", selectionMode: "manual" },
    { productKey: "studio", kind: "image", selectionMode: "auto" },
    { productKey: "studio", kind: "chat", selectionMode: "manual" },
    { productKey: "chat", kind: "chat", selectionMode: "auto" },
    { productKey: null, kind: "chat", selectionMode: "manual" },
  ] as const;

  for (const row of cases) {
    const applicationRefuses = conversationProductViolation(row) !== null;
    const databaseVerdict = await refusalConstraint(() =>
      seed(user.id, { ...row })
    );
    assert.equal(
      applicationRefuses,
      databaseVerdict !== "accepted",
      `${JSON.stringify(row)}: application said ${applicationRefuses}, database said ${databaseVerdict}`
    );
  }
});
