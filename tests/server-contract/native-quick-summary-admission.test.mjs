import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const mod = path => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
let refused = null, grants = 0, generated = 0, providerFailures = 0, modelFailures = 0, refunds = 0;
let owner = "owner", unlocked = true;
const stop = () => { throw Error("Unexpected write"); };
class AccessRefusal extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
mock.module(mod("lib/chatRouteSession.ts"), { namedExports: { resolveChatRouteSession: async () => ({ session: { user: { id: "owner" } } }) } });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  conversation: { findUnique: async () => ({ userId: owner, password: null, kind: "CHAT", title: "Comparison" }) },
  comparisonReview: { findUnique: async () => null, upsert: stop },
  userSettings: { findUnique: async () => ({ language: "en" }) },
} } });
mock.module(mod("lib/chatSecurity.ts"), { namedExports: {
  ChatAccessError: AccessRefusal, identifyChatCaller: (_request, userId) => ({ kind: "user", userId }),
  createChatBudget: () => ({ maxOutputTokens: 1200, usageCredits: 1 }),
  acquireChatAccess: async () => { grants++; if (refused) throw refused; return { leaseId: "lease", usageReservation: { reservationId: "reservation" } }; },
  releaseChatAccess: async () => {}, linkChatReservationProviderRequest: async () => {},
  settleChatUsage: async () => { refunds++; },
  chatErrorResponse: error => error instanceof AccessRefusal ? Response.json({ code: error.code }, { status: error.status, headers: { "Retry-After": "12" } }) : null,
} });
mock.module(mod("lib/providerMonitoring.ts"), { namedExports: {
  recordProviderFailure: async () => { providerFailures++; }, recordModelFailure: async () => { modelFailures++; },
  recordProviderSuccess: async () => {}, recordModelSuccess: async () => {},
} });
mock.module(mod("lib/comparisonReview.ts"), { namedExports: {
  accessibleQuickReviewers: async () => [{ id: "first", provider: "openai" }, { id: "second", provider: "google" }],
  buildQuickComparisonSummaryPrompt: () => ({ system: "Compare", prompt: "Question", responseMap: [] }),
  createQuickComparisonSummaryHash: () => "hash", estimateComparisonReviewTokens: () => ({ tokens: 10 }),
  QUICK_COMPARISON_PROMPT_VERSION: "test", quickComparisonSummaryResultSchema: {},
  validateComparisonReviewInputSize: () => {}, verifyQuickComparisonSummaryResult: stop,
  verifiedQuickComparisonSummaryResultSchema: { safeParse: () => ({ success: false }) },
} });
mock.module(mod("lib/comparisonReviewTurn.ts"), { namedExports: { latestComparableConversationTurn: async () => ({ prompt: { id: "question", content: "Question" }, responses: [{ messageId: "a", content: "A" }, { messageId: "b", content: "B" }] }) } });
mock.module(mod("lib/billingEntitlements.ts"), { namedExports: { getUserBillingPlan: async () => ({ tier: "Free" }) } });
mock.module(mod("lib/conversationLock.ts"), { namedExports: { hasConversationUnlockGrant: () => unlocked, conversationLockedResponse: () => Response.json({ code: "LOCKED" }, { status: 423 }) } });
mock.module(mod("lib/conversationKindGuard.ts"), { namedExports: { isChatConversationKind: () => true, conversationKindNotSupportedResponse: stop } });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: { consumeApiRateLimit: async () => {}, apiSecurityResponse: () => null } });
mock.module(mod("lib/activeAiModel.ts"), { namedExports: { getActiveAiModel: () => ({}) } });
mock.module(mod("lib/modelGenerationCompatibility.ts"), { namedExports: { getModelGenerationSettings: () => ({}) } });
mock.module(mod("lib/perplexityUsageCapture.ts"), { namedExports: { consumePerplexityUsage: async () => null, discardPerplexityUsage: () => {}, perplexityUsageHeaders: () => ({}) } });
mock.module(mod("lib/providerErrorClassification.ts"), { namedExports: { safeErrorMetadata: () => ({ name: "SyntheticProviderFailure" }) } });
mock.module("ai", { namedExports: { generateText: async () => { generated++; throw Error("Provider unavailable"); }, Output: { object: () => ({}) } } });
const { POST } = await import("../../app/api/conversations/[conversationId]/compare-summary/route.ts");
const run = () => POST(new Request("https://tomverse.app/api/conversations/review-1/compare-summary", { method: "POST", headers: { authorization: "Bearer owner" } }), { params: Promise.resolve({ conversationId: "review-1" }) });

for (const [status, code] of [[402, "CREDIT_BALANCE_INSUFFICIENT"], [429, "CHAT_RATE_LIMITED"], [403, "MODEL_ACCESS_DENIED"]]) {
  test(`admission ${code} preserves its status without provider execution or fallback`, async () => {
    refused = new AccessRefusal(status, code); grants = generated = providerFailures = modelFailures = refunds = 0;
    const response = await run();
    assert.equal(response.status, status); assert.equal((await response.json()).code, code); assert.equal(response.headers.get("Retry-After"), "12");
    assert.equal(grants, 1); assert.equal(generated, 0); assert.equal(providerFailures, 0); assert.equal(modelFailures, 0); assert.equal(refunds, 0);
  });
}
test("a real provider failure still tries fallback and refunds each admitted attempt", async () => {
  refused = null; grants = generated = providerFailures = modelFailures = refunds = 0;
  const response = await run();
  assert.equal(response.status, 502); assert.equal(grants, 2); assert.equal(generated, 4);
  assert.equal(providerFailures, 2); assert.equal(modelFailures, 2); assert.equal(refunds, 2);
});
test("foreign and locked comparisons are denied before admission", async () => {
  grants = 0; owner = "another-account"; assert.equal((await run()).status, 404);
  owner = "owner"; unlocked = false; assert.equal((await run()).status, 423); unlocked = true;
  assert.equal(grants, 0);
});
