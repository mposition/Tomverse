import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { estimateTextTokens } from "../../lib/chatTokenEstimate";
import { emptyContinuationSeedPlan } from "../../lib/externalContinuationSeedCore";

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL = "postgresql://e2e:e2e@127.0.0.1:1/e2e";
process.env.NEXTAUTH_SECRET = "handoff-preflight-test-secret";
const root = resolve(import.meta.dirname, "../..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const require = createRequire(import.meta.url);
const real = (path: string) => require(resolve(root, path));
const modelIds = ["gpt-5-6-luna", "gpt-5-4-mini"];
const registry = real("lib/modelRegistry.ts");
const { AVAILABLE_MODELS } = real("lib/models.ts");
mock.module(mod("lib/modelRegistry.ts"), { namedExports: { ...registry,
  getRuntimeModels: async () => AVAILABLE_MODELS.map((model: object) => ({ ...model, enabled: true, catalogDeleted: false })),
} });
let handoff = false;
let available = true;
let admissions: Array<Array<{ inputTokens: number }>> = [];
let reads = 0;
const native = "Tomverse replied: Option two uses Kyoto gardens within AUD 1,500. ".repeat(20);
mock.module("next-auth/next", { namedExports: { getServerSession: async () => ({ user: { id: "owner" } }) } });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  conversation: { findUnique: async () => ({ userId: "owner", password: null, kind: "chat", selectedModels: JSON.stringify(modelIds),
    messages: [], continuationBridge: handoff ? { reviewHandoff: {} } : null }) },
  conversationContinuationBridge: { findFirst: async () => handoff ? { reviewHandoff: {}, externalConversationId: "source",
    sourceConversationDigest: "digest", sourceDigestVersion: 1 } : null },
} } });
const settings = real("lib/appSettings.ts");
mock.module(mod("lib/appSettings.ts"), { namedExports: { ...settings,
  isExternalContinuationEnabled: async () => true, isExternalContinuationEnabledCached: async () => true,
  isImageGenerationEnabledCached: async () => false } });
mock.module(mod("lib/reviewContinuationHandoffService.ts"), { namedExports: {
  loadReviewContinuationReference: async () => {
    reads++;
    return available ? { status: "available", descriptor: { sourceMode: "recorded" },
      sourcePlan: emptyContinuationSeedPlan(), sourcePrompt: { rulesText: null, transcriptText: "Imported source: Kyoto / AUD 1,500." },
      nativeReferenceText: native } : { status: "unavailable", reason: "parent_locked" };
  },
} });
const security = real("lib/apiSecurity.ts");
mock.module(mod("lib/apiSecurity.ts"), { namedExports: { ...security, consumeApiRateLimit: async () => {} } });
const billing = real("lib/billingEntitlements.ts");
const { getDefaultBillingPlan } = real("lib/billingPlanDefaults.ts");
mock.module(mod("lib/billingEntitlements.ts"), { namedExports: { ...billing, getUserBillingPlan: async () => getDefaultBillingPlan("free") } });
mock.module(mod("lib/chatTurnContext.ts"), { namedExports: {
  buildChatTurnContext: async () => ({ systemPrompt: null, profileTokens: 0, memory: { decision: { allowed: false } } }),
} });
const chatSecurity = real("lib/chatSecurity.ts");
mock.module(mod("lib/chatSecurity.ts"), { namedExports: { ...chatSecurity,
  preflightChatComparisonAccess: async (_access: unknown, budgets: Array<{ inputTokens: number }>) => {
    admissions.push(budgets);
    return { modelCount: 2, requiredCredits: 2, admission: { admissionId: "test", token: "test", expiresAt: new Date().toISOString() } };
  },
} });
const request = () => new Request("http://localhost/api/chat/preflight", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ comparisonId: "1754000000000", conversationId: "target", modelIds, prompt: "Use the second option.", attachments: [] }) });

test("preflight prices imported and native references once per model through the actual shared loader", async () => {
  const { POST } = await import(mod("app/api/chat/preflight/route.ts"));
  handoff = false; admissions = [];
  const baseline = await POST(request());
  assert.equal(baseline.status, 200, await baseline.text());
  handoff = true; reads = 0;
  const response = await POST(request());
  assert.equal(response.status, 200, await response.text());
  assert.equal(reads, 1);
  const differences = admissions[1].map((budget, index) => budget.inputTokens - admissions[0][index].inputTokens);
  assert.equal(differences[0], differences[1]);
  assert.ok(differences[0] >= estimateTextTokens(native));
});

test("unavailable handoff context refuses preflight before any aggregate reservation", async () => {
  const { POST } = await import(mod("app/api/chat/preflight/route.ts"));
  handoff = true; available = false; admissions = [];
  const response = await POST(request());
  assert.equal(response.status, 423, await response.text());
  assert.equal(admissions.length, 0);
});
