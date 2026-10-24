import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const mod = path => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
let cookies = 0; let generationCalls = 0; let usageReads = 0;
let title = "Interim"; let owner = "bearer-owner"; let password = null; let renameDuringGeneration = false;
mock.module("next-auth/next", { namedExports: { getServerSession: async () => { cookies++; return { user: { id: "cookie-owner" } }; } } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/mobileAuthRoute.ts"), { namedExports: {
  mobileAuthRefusal: code => Response.json({ code }, { status: 401 }),
  requireMobileBearer: async request => request.headers.get("authorization") === "Bearer valid"
    ? { ok: true, identity: { userId: "bearer-owner" } }
    : { ok: false, response: Response.json({ code: "INVALID" }, { status: 401 }) },
} });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  user: { findUnique: async ({ where, select }) => {
    if (select.accountStatus) return { id: where.id, accountStatus: "active" };
    usageReads++; assert.equal(where.id, "bearer-owner"); return { plan: "Free", settings: { timeZone: "UTC" } };
  } },
  conversation: { findUnique: async () => ({ userId: owner, password, kind: "chat", continuationBridge: null }) },
  message: { findFirst: async () => ({ content: "First question" }) },
  chatUsageBucket: { findMany: async ({ where }) => {
    assert.equal(where.key, "usage:bearer-owner"); return typeof where.period === "string" ? [] : [{ period: "month", count: 25n }];
  } }, creditPurchase: { count: async () => 0 },
} } });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  consumeApiRateLimit: async () => {}, apiSecurityResponse: () => null,
  readLimitedJson: async (request, _limit, schema) => schema.parse(await request.json()),
} });
mock.module(mod("lib/conversationLock.ts"), { namedExports: {
  hasConversationUnlockGrant: () => false,
  conversationLockedResponse: () => Response.json({ code: "CONVERSATION_LOCKED" }, { status: 423 }),
} });
mock.module(mod("lib/conversationTitle.ts"), { namedExports: {
  generateConversationTitle: async () => { generationCalls++; if (renameDuringGeneration) title = "Manual web rename"; return { ok: true, title: "Generated" }; },
  applyGeneratedTitle: async input => {
    assert.equal(input.userId, "bearer-owner"); assert.equal(input.conversationId, "c1");
    const updated = title === input.expectedTitle; if (updated) title = input.newTitle; return { updated };
  }, recordTitleGenerationUsage: async () => {},
} });
mock.module(mod("lib/chatSecurity.ts"), { namedExports: { getUserChatUsageKey: id => `usage:${id}`, getChatCostGuardrails: () => ({ planDay: 1, planMonth: 10 }) } });
mock.module(mod("lib/billingConfig.ts"), { namedExports: { getBillingPlanByTier: async () => ({ dailyMessageLimit: 20, monthlyMessageLimit: 100 }) } });
mock.module(mod("lib/billingEntitlements.ts"), { namedExports: { effectivePlanModelLimit: () => 1 } });
mock.module(mod("lib/creditLedger.ts"), { namedExports: { getPurchasedCreditSummary: async id => { assert.equal(id, "bearer-owner"); return { remainingCredits: 0, remainingFundedCostMicroUsd: 0 }; } } });
mock.module(mod("lib/creditPacks.ts"), { namedExports: { recommendCreditAction: () => null } });
const { POST } = await import("../../app/api/conversations/[conversationId]/generate-title/route.ts");
const { GET } = await import("../../app/api/user/usage/route.ts");
const context = { params: Promise.resolve({ conversationId: "c1" }) };
const request = (kind, bearer = "valid", origin = "https://localhost") => new Request(
  `https://tomverse.app${kind === "title" ? "/api/conversations/c1/generate-title" : "/api/user/usage"}`,
  { method: kind === "title" ? "POST" : "GET", headers: { authorization: `Bearer ${bearer}`, origin, cookie: "another-user", "content-type": "application/json" }, ...(kind === "title" ? { body: JSON.stringify({ expectedTitle: "Interim" }) } : {}) },
);

test("title and usage routes refuse inactive rollout, invalid bearer and hostile origin before any work", async () => {
  for (const kind of ["title", "usage"]) {
    const run = req => kind === "title" ? POST(req, context) : GET(req);
    process.env.TOMVERSE_NATIVE_CHAT_ENABLED = "true"; delete process.env.TOMVERSE_NATIVE_PARITY_ENABLED;
    assert.equal((await run(request(kind))).status, 503);
    process.env.TOMVERSE_NATIVE_PARITY_ENABLED = "true";
    assert.equal((await run(request(kind, "revoked"))).status, 401);
    assert.equal((await run(request(kind, "valid", "https://hostile.invalid"))).status, 401);
  }
  assert.equal(cookies, 0); assert.equal(generationCalls, 0); assert.equal(usageReads, 0);
});

test("native title generation enforces ownership and lock and preserves a simultaneous manual rename", async () => {
  owner = "another-owner"; assert.equal((await POST(request("title"), context)).status, 403);
  owner = "bearer-owner"; password = "locked"; assert.equal((await POST(request("title"), context)).status, 423);
  assert.equal(generationCalls, 0); password = null;
  renameDuringGeneration = true;
  let result = await (await POST(request("title"), context)).json();
  assert.equal(result.updated, false); assert.equal(title, "Manual web rename");
  renameDuringGeneration = false; title = "Interim";
  result = await (await POST(request("title"), context)).json();
  assert.equal(result.updated, true); assert.equal(title, "Generated"); assert.equal(cookies, 0);
});

test("native usage uses bearer account totals even when another web session cookie is present", async () => {
  const response = await GET(request("usage")); assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.usage.creditsMonth, 25); assert.equal(body.limits.creditsMonth, 100);
  assert.equal(body.entitlement.planCreditsRemaining, 75); assert.equal(cookies, 0);
});
