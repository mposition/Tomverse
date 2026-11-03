import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mock, test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

// Run against an isolated test database. Only this test's synthetic rows are removed.
const root = resolve(import.meta.dirname, "../..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const require = createRequire(import.meta.url);
let userId = "";
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module("next-auth/next", { namedExports: { getServerSession: async () => assert.fail("No cookie fallback") } });
mock.module(mod("lib/mobileAuthRoute.ts"), { namedExports: {
  requireMobileBearer: async () => ({ ok: true, identity: { userId } }),
  mobileAuthRefusal: (code: string) => Response.json({ code }, { status: 401 }),
} });
mock.module(mod("lib/stripe.ts"), { namedExports: { getStripe: () => assert.fail("A pass must never call Stripe"), isStripeConfigured: () => false } });
mock.module(mod("lib/standardEmailLane.ts"), { namedExports: { enqueueStandardEmail: async () => undefined } });
const security = require(resolve(root, "lib/apiSecurity.ts"));
mock.module(mod("lib/apiSecurity.ts"), { namedExports: { ...security, consumeApiRateLimit: async () => undefined } });

test("native redemption grants one existing pass with its real expiry and rejects reuse without adding credits", async () => {
  process.env.TOMVERSE_NATIVE_CHAT_ENABLED = "true";
  process.env.TOMVERSE_NATIVE_PARITY_ENABLED = "true";
  const { prisma } = await import("../../lib/prisma");
  const { POST } = await import("../../app/api/billing/checkout/route");
  const code = `NATIVE-PASS-${randomUUID().slice(0, 8).toUpperCase()}`;
  const user = await prisma.user.create({ data: { email: `native-pass-${randomUUID()}@example.test`, plan: "Free" } });
  userId = user.id;
  const promotion = await prisma.billingPromotion.create({ data: {
    code, discountPercent: 100, durationMonths: 2, fulfillmentType: "internal_pass", accessDurationDays: 60,
    maxRedemptions: 10, endsAt: new Date(Date.now() + 86400_000), appliesToPlanIds: JSON.stringify(["pro"]),
  } });
  const post = () => POST(new Request("http://127.0.0.1:3100/api/billing/checkout", {
    method: "POST", headers: { authorization: "Bearer synthetic", origin: "https://localhost", "content-type": "application/json", "x-forwarded-for": "127.0.0.1" },
    body: JSON.stringify({ planId: "pro", billingInterval: "monthly", promoCode: code, language: "ko" }),
  }));
  try {
    const started = Date.now();
    const response = await post();
    const receipt = await response.json();
    assert.equal(response.status, 200, JSON.stringify(receipt));
    const current = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    assert.equal(current.plan, "Pro");
    assert.equal(current.subscriptionStatus, "founding_tester_pass");
    assert.equal(current.subscriptionCancelAtPeriodEnd, true);
    assert.equal(current.stripeSubscriptionId, null);
    assert.ok(current.subscriptionCurrentPeriodEnd!.getTime() >= started + 60 * 86400_000);
    assert.equal(current.subscriptionCurrentPeriodEnd!.toISOString(), receipt.periodEnd);
    assert.equal(await prisma.creditLot.count({ where: { userId } }), 0);
    assert.equal(await prisma.billingPromotionRedemption.count({ where: { userId } }), 1);
    // Once the same account returns to Free, prior use still prevents another pass.
    await prisma.user.update({ where: { id: userId }, data: { plan: "Free", webSubscriptionPlan: "Free", subscriptionCurrentPeriodEnd: new Date(Date.now() - 1000) } });
    const replay = await post();
    assert.equal(replay.status, 409);
    assert.equal((await replay.json()).code, "PROMOTION_ALREADY_USED");
    assert.equal((await prisma.billingPromotion.findUniqueOrThrow({ where: { id: promotion.id } })).redeemedCount, 1);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).plan, "Free");
  } finally {
    await prisma.billingPromotion.delete({ where: { id: promotion.id } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  }
});
