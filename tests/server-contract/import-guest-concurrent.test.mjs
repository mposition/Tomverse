import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const mod = (path) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;

let transactionOutcome;
let winnerRow;
let finds = [];

mock.module("next-auth/next", { namedExports: { getServerSession: async () => ({ user: { id: "owner" } }) } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  apiSecurityResponse: () => null,
  assertConversationCapacity: async () => {},
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
mock.module(mod("lib/conversationCreation.ts"), { namedExports: { createConversation: async () => ({ id: "unused" }) } });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  conversation: { findFirst: async ({ where }) => { finds.push(where); return winnerRow; } },
  $transaction: async () => transactionOutcome(),
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
const uniqueViolation = () => Object.assign(new Error("Unique constraint failed"), { code: "P2002" });

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

test("a unique violation with no winner row, and any other failure, still fail loudly", async () => {
  winnerRow = null;
  transactionOutcome = async () => { throw uniqueViolation(); };
  assert.equal((await POST(request())).status, 500);
  transactionOutcome = async () => { throw Object.assign(new Error("fk"), { code: "P2003" }); };
  assert.equal((await POST(request())).status, 500);
});
