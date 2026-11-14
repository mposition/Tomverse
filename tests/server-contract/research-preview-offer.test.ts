import assert from "node:assert/strict";
import { before, beforeEach, mock, test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AVAILABLE_MODELS } from "@/lib/models";

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL = "postgresql://fixture@127.0.0.1:1/research_test";
process.env.NEXTAUTH_SECRET = "research-offer-local-fixture";
const mod = (path: string) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
let userId: string | null = "owner";
let owned = true;
let unlocked = true;
let active = true;
let accountActive = true;
let tier = "Pro";
let selectionMode = "manual";
let productKey = "chat";
let profileId: string | null = null;
let policy = { webSearch: true, deepResearch: true };
let modelId = "gemini-3-1-pro";
let reads = 0;
let budgetCalls = 0;

mock.module(mod("lib/chatRouteSession.ts"), { namedExports: { resolveChatRouteSession: async () => ({ session: userId ? { user: { id: userId } } : null }) } });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  user: { findUnique: async () => ({ accountStatus: accountActive ? "active" : "suspended" }) },
  conversation: { findFirst: async (input: { where: { userId: string } }) => {
    reads++;
    assert.equal(input.where.userId, "owner");
    return owned ? { id: "conversation", password: "protected", kind: "chat", productKey, selectionMode, selectedModels: JSON.stringify([modelId]), assistantProfileVersionId: profileId } : null;
  } },
  assistantProfileVersion: { findFirst: async () => ({ toolPolicy: policy }) },
} } });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  consumeApiRateLimit: async () => {}, apiSecurityResponse: () => null,
  readLimitedJson: async (request: Request, _limit: number, schema: { parse: (value: unknown) => unknown }) => schema.parse(await request.json()),
} });
mock.module(mod("lib/billingEntitlements.ts"), { namedExports: { getUserBillingPlan: async () => ({ tier }) } });
mock.module(mod("lib/conversationLock.ts"), { namedExports: { hasConversationUnlockGrant: () => unlocked } });
mock.module(mod("lib/modelRegistry.ts"), { namedExports: { getRuntimeModels: async () => AVAILABLE_MODELS } });
mock.module(mod("lib/appSettings.ts"), { namedExports: { getOperationalFeatureFlags: async () => ({ aiChatEnabled: active }) } });
mock.module(mod("lib/webSearchBackendRuntime.ts"), { namedExports: { resolveWebSearchBackendReadiness: () => ({ brave: true }) } });
mock.module(mod("lib/webSearchCeilingBreachStore.ts"), { namedExports: { refreshSearchQueryCeilingBreaches: async () => {} } });
mock.module(mod("lib/researchPreviewBudget.ts"), { namedExports: { createResearchPreviewBudget: () => { budgetCalls++; return { usageCredits: 24 }; } } });

let POST: (request: Request) => Promise<Response>;
before(async () => { ({ POST } = await import(mod("app/api/chat/research-preview/offer/route.ts"))); });
const offer = () => POST(new Request("http://localhost/api/chat/research-preview/offer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId: "conversation", modelId, question: "Compare public documentation" }) }));

beforeEach(() => {
  process.env.RESEARCH_PREVIEW_ENABLED = "true";
  process.env.RESEARCH_PREVIEW_MODEL_IDS = "gemini-3-1-pro";
  userId = "owner"; owned = unlocked = active = accountActive = true; tier = "Pro";
  selectionMode = "manual"; productKey = "chat"; profileId = null;
  policy = { webSearch: true, deepResearch: true }; modelId = "gemini-3-1-pro";
  reads = budgetCalls = 0;
});

test("the default-off offer reads no private context or budgets", async () => {
  delete process.env.RESEARCH_PREVIEW_ENABLED;
  assert.deepEqual(await (await offer()).json(), { offered: false, reason: "disabled" });
  assert.equal(reads, 0); assert.equal(budgetCalls, 0);
});

test("a signed-in eligible offer returns the shared bounded contract and estimate", async () => {
  const response = await offer();
  assert.equal(response.headers.get("cache-control"), "no-store");
  const result = await response.json();
  assert.equal(result.offered, true); assert.equal(result.reason, "ready");
  assert.equal(result.estimatedCredits, 24); assert.equal(result.limits.modelSteps, 3);
  assert.equal(result.limits.totalOutputTokens, 4096); assert.equal(budgetCalls, 1);
});

test("owner, lock, manual Chat, entitlement and the operational switch narrow the offer", async () => {
  const variants = [
    () => { owned = false; }, () => { unlocked = false; },
    () => { selectionMode = "auto"; }, () => { productKey = "review"; },
    () => { tier = "Free"; }, () => { active = false; },
  ];
  for (const narrow of variants) {
    owned = unlocked = active = true; selectionMode = "manual"; productKey = "chat"; tier = "Pro";
    narrow();
    assert.equal((await (await offer()).json()).offered, false);
  }
  assert.equal(budgetCalls, 0);
});

test("profile search and Research prohibitions are honored without loading profile text", async () => {
  profileId = "profile-version";
  for (const restriction of [{ webSearch: false, deepResearch: true }, { webSearch: true, deepResearch: false }]) {
    policy = restriction;
    assert.equal((await (await offer()).json()).reason, "profile_restricted");
  }
  assert.equal(budgetCalls, 0);
});

test("guests and models outside the pinned shortlist are never offered", async () => {
  userId = null;
  assert.equal((await (await offer()).json()).reason, "authentication_required");
  userId = "owner"; accountActive = false;
  assert.equal((await (await offer()).json()).offered, false);
  accountActive = true;
  userId = "owner"; modelId = "gpt-5-5";
  process.env.RESEARCH_PREVIEW_MODEL_IDS = modelId;
  assert.equal((await (await offer()).json()).offered, false);
  assert.equal(budgetCalls, 0);
});
