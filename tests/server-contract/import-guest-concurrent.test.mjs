import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const mod = (path) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;

let transactionOutcome;
let winnerRow;
let finds = [];
let txBody = null;
let capacityError = null;
let txFinds = [];
let created = [];

mock.module("next-auth/next", { namedExports: { getServerSession: async () => ({ user: { id: "owner" } }) } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  apiSecurityResponse: () => null,
  assertConversationCapacity: async () => { if (capacityError) throw capacityError; },
  assertMessageCapacity: async () => {},
  consumeApiRateLimit: async () => {},
  readLimitedJson: async (request, _limit, schema) => schema.parse(await request.json()),
  STORAGE_LIMITS: { messagesPerConversation: () => 10_000 },
} });
mock.module(mod("lib/modelRegistry.ts"), { namedExports: {
  clampRuntimeSelectedModels: async (models) => models,
  isEnabledRuntimeModelId: async () => true,
} });
mock.module(mod("lib/billingEntitlements.ts"), { namedExports: {
  effectivePlanModelLimit: () => 3,
  getUserBillingPlan: async () => ({ tier: "pro" }),
  modelLimitResponse: () => new Response(null, { status: 409 }),
} });
mock.module(mod("lib/conversationCreation.ts"), { namedExports: { createConversation: async () => { created.push("conversation"); return { id: "new-conversation" }; } } });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  conversation: { findFirst: async ({ where }) => { finds.push(where); return winnerRow; } },
  $transaction: async (run) => (txBody ? run(txBody) : transactionOutcome()),
} } });

const { POST } = await import("../../app/api/conversations/import-guest/route.ts");
const request = () => new Request("https://tomverse.app/api/conversations/import-guest", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    guestConversationId: "guest-abc",
    title: "Imported",
    selectedModels: ["model-a"],
    createdAt: "2026-11-28T00:00:00.000Z",
    messages: [{ role: "user", content: "hi", createdAt: "2026-11-28T00:00:00.000Z" }],
  }),
});
const uniqueViolation = (meta = { target: ["userId", "importedGuestKey"] }) =>
  Object.assign(new Error("Unique constraint failed"), { code: "P2002", meta });

test("the loser of two concurrent imports gets the winner's conversation as alreadyImported, not a 500", async () => {
  finds = [];
  winnerRow = { id: "winner-conversation" };
  transactionOutcome = async () => { throw uniqueViolation(); };
  const response = await POST(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, conversationId: "winner-conversation", alreadyImported: true });
  assert.deepEqual(finds, [{ userId: "owner", importedGuestKey: "guest-abc" }]);
});

test("a normal import is unchanged", async () => {
  finds = [];
  transactionOutcome = async () => ({ conversationId: "new-conversation", alreadyImported: false });
  const response = await POST(request());
  assert.deepEqual(await response.json(), { success: true, conversationId: "new-conversation", alreadyImported: false });
  assert.deepEqual(finds, []);
});

test("the conversation's unique key is recognised in each shape Prisma and its driver adapter report it", async () => {
  winnerRow = { id: "winner-conversation" };
  for (const meta of [
    { target: ["userId", "importedGuestKey"] },
    { target: "Conversation_userId_importedGuestKey_key" },
    { driverAdapterError: { cause: { kind: "UniqueConstraintViolation", constraint: { fields: ["userId", "importedGuestKey"] } } } },
  ]) {
    transactionOutcome = async () => { throw uniqueViolation(meta); };
    const response = await POST(request());
    assert.equal(response.status, 200, JSON.stringify(meta));
    assert.equal((await response.json()).alreadyImported, true);
  }
});

test("a different unique violation inside the import is a failure, never 'already imported'", async () => {
  winnerRow = { id: "some-other-conversation" };
  finds = [];
  for (const meta of [
    { target: ["id"] },
    { target: ["conversationId", "ordinal"] },
    { target: "Message_pkey" },
    { driverAdapterError: { cause: { kind: "UniqueConstraintViolation", constraint: { fields: ["id"] } } } },
    null,
    {},
  ]) {
    transactionOutcome = async () => { throw uniqueViolation(meta); };
    assert.equal((await POST(request())).status, 500, JSON.stringify(meta));
  }
  // It never even looked for a winner: nothing says the conflict was the guest key.
  assert.deepEqual(finds, []);
});

test("a unique violation with no winner row, and any other failure, still fail loudly", async () => {
  winnerRow = null;
  transactionOutcome = async () => { throw uniqueViolation(); };
  assert.equal((await POST(request())).status, 500);
  transactionOutcome = async () => { throw Object.assign(new Error("fk"), { code: "P2003" }); };
  assert.equal((await POST(request())).status, 500);
});

// The body of the transaction, run for real: what is read before and after the account's conversation lock.
const bodyTx = (rows) => ({
  conversation: { findFirst: async ({ where }) => { txFinds.push(where); return rows.shift() ?? null; } },
  message: { createMany: async () => { created.push("messages"); } },
});
const quotaExceeded = () => Object.assign(new Error("Conversation storage quota exceeded."), { status: 409, code: "CONVERSATION_STORAGE_QUOTA_EXCEEDED" });

test("a concurrent import that waited on the lock answers already imported even when the winner took the last place", async () => {
  txFinds = [];
  created = [];
  // Before the lock nothing exists; the winner commits while this one waits; after the lock it is there,
  // and the account is now at its limit.
  txBody = bodyTx([null, { id: "winner-conversation" }]);
  capacityError = quotaExceeded();
  try {
    const response = await POST(request());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, conversationId: "winner-conversation", alreadyImported: true });
    assert.equal(txFinds.length, 2);
    assert.deepEqual(created, []);
  } finally { txBody = null; capacityError = null; }
});

test("a real quota failure with no existing import is still refused, and nothing is created", async () => {
  txFinds = [];
  created = [];
  txBody = bodyTx([null, null]);
  capacityError = quotaExceeded();
  try {
    const response = await POST(request());
    assert.equal(response.status, 500);
    assert.deepEqual(created, []);
  } finally { txBody = null; capacityError = null; }
});

test("with room and no winner the import proceeds under the lock", async () => {
  txFinds = [];
  created = [];
  txBody = bodyTx([null, null]);
  try {
    const response = await POST(request());
    assert.deepEqual(await response.json(), { success: true, conversationId: "new-conversation", alreadyImported: false });
    assert.deepEqual(created, ["conversation", "messages"]);
  } finally { txBody = null; }
});
