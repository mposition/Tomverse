import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const mod = (path) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
let requestedProfile, defaults, offered, capacityCalls, clampCalls, transactions, writes;
mock.module("next-auth/next", { namedExports: { getServerSession: async () => ({ user: { id: "owner" } }) } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/autoAvailability.ts"), { namedExports: { autoAvailabilityFor: async () => ({ offered }) } });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  apiSecurityResponse: () => null,
  consumeApiRateLimit: async () => {},
  assertConversationCapacity: async () => { capacityCalls++; },
  readLimitedJson: async (req, _limit, schema) => schema.parse(await req.json()),
} });
mock.module(mod("lib/billingEntitlements.ts"), { namedExports: {
  effectivePlanModelLimit: () => 3,
  getUserBillingPlan: async () => ({ tier: "pro" }),
  modelLimitResponse: () => new Response(null, { status: 409 }),
} });
mock.module(mod("lib/newConversationSelectedModels.ts"), { namedExports: {
  resolveNewConversationSelectedModels: async () => [...defaults],
} });
mock.module(mod("lib/modelRegistry.ts"), { namedExports: {
  clampRuntimeSelectedModels: async (models) => { clampCalls.push([...models]); return [...models]; },
} });
mock.module(mod("lib/conversationProfileService.ts"), { namedExports: {
  ConversationProfileError: class extends Error {},
  readConversationProfile: async () => null,
  resolveProfileBinding: async () => requestedProfile
    ? { outcome: "bind", profileVersionId: "version-1", modelIds: [...requestedProfile] }
    : { outcome: "none" },
} });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  userSettings: { findUnique: async () => ({ defaultModel: "model-a", newConversationModelIds: defaults }) },
  $transaction: async (callback) => { transactions++; return callback({}); },
} } });
mock.module(mod("lib/conversationCreation.ts"), { namedExports: {
  createConversation: async (_tx, data) => {
    writes.push(data);
    return { id: "created", password: null, ...data };
  },
} });
const { createConversationForProduct } = await import(mod("lib/conversationCreateHandler.ts"));
const { POST } = await import(mod("app/api/products/chat/conversations/route.ts"));
const request = (body) => new Request("https://chat.example/api/products/chat/conversations", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
test.beforeEach(() => {
  requestedProfile = null;
  defaults = ["model-a", "model-b"];
  offered = true;
  capacityCalls = 0;
  clampCalls = [];
  transactions = 0;
  writes = [];
});
const assertNoWrite = () => {
  assert.equal(capacityCalls, 0);
  assert.equal(transactions, 0);
  assert.equal(writes.length, 0);
};

test("actual Chat endpoint refuses multiple models before clamp, capacity or transaction", async () => {
  const response = await POST(request({ selectedModels: ["model-a", "model-b"] }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "CHAT_SINGLE_MODEL_REQUIRED");
  assert.equal(clampCalls.length, 0);
  assertNoWrite();
});
test("Chat refuses an empty selection and duplicate slots rather than shrinking either", async () => {
  for (const selectedModels of [[], ["model-a", "model-a"]]) {
    const response = await POST(request({ selectedModels }));
    assert.equal(response.status, 400);
  }
  assert.equal(clampCalls.length, 0);
  assertNoWrite();
});
test("account multi-model defaults remain unchanged and cannot silently become singleton Chat", async () => {
  const response = await POST(request({}));
  assert.equal(response.status, 400);
  assert.deepEqual(defaults, ["model-a", "model-b"]);
  assertNoWrite();
});
test("multi-model profile cannot fan out or silently shrink despite a singleton body selection", async () => {
  requestedProfile = ["profile-a", "profile-b"];
  const response = await POST(request({ selectedModels: ["model-a"], assistantProfileId: "profile" }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "CHAT_PROFILE_SINGLE_MODEL_REQUIRED");
  assert.deepEqual(requestedProfile, ["profile-a", "profile-b"]);
  assert.equal(clampCalls.length, 0);
  assertNoWrite();
});
test("one explicit model creates Chat and returns the server surface without changing defaults", async () => {
  const response = await POST(request({ selectedModels: ["model-b"] }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.selectedModels, ["model-b"]);
  assert.equal(body.surface, "chat");
  assert.equal(writes[0].productKey, "chat");
  assert.equal(capacityCalls, 1);
  assert.equal(transactions, 1);
  assert.deepEqual(defaults, ["model-a", "model-b"]);
});
test("single-model profile remains the authoritative creation selection", async () => {
  requestedProfile = ["profile-a"];
  const response = await POST(request({ selectedModels: ["model-a"], assistantProfileId: "profile" }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).selectedModels, ["profile-a"]);
  assert.equal(writes[0].assistantProfileVersionId, "version-1");
});
test("the existing offered gate still refuses Chat creation before any handler work", async () => {
  offered = false;
  const response = await POST(request({ selectedModels: ["model-a"] }));
  assert.equal(response.status, 404);
  assert.equal(clampCalls.length, 0);
  assertNoWrite();
});
test("Review creation retains multiple selected models and its existing surface", async () => {
  const response = await createConversationForProduct(request({ selectedModels: ["model-a", "model-b"] }), "review");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.surface, "workspace");
  assert.deepEqual(body.selectedModels, ["model-a", "model-b"]);
  assert.equal(writes[0].productKey, "review");
});
