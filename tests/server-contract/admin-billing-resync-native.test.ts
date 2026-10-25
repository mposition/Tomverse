import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
let authorized = true; let locks = 0;
const baseline = {
  id: "target", email: "fixture@example.test", plan: "Max", webSubscriptionPlan: "Pro",
  stripeCustomerId: "cus_test", stripeSubscriptionId: "sub_test",
  subscriptionStatus: "active", subscriptionSyncedAt: null as Date | null,
  subscriptionStore: "app_store", storeSubscriptionPlan: "Max", storeSubscriptionExpiresAt: new Date("2099-01-01"),
};
const account = { ...baseline };
let status = "canceled"; let targetPlan = "pro";
const table = {
  findUnique: async () => ({ ...account }), findUniqueOrThrow: async () => ({ ...account }),
  update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(account, data),
};
const tx = { user: table, $executeRaw: async () => { locks++; return 1; } };
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: { user: table,
  $transaction: async (work: (client: typeof tx) => unknown) => work(tx),
} } });
mock.module("next-auth/next", { namedExports: { getServerSession: async () => authorized ? { user: { id: "admin" } } : null } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/adminAuth.ts"), { namedExports: { hasAdminPermission: () => true, isAdminSession: () => true } });
mock.module(mod("lib/adminAudit.ts"), { namedExports: { writeAdminAuditLog: async () => {} } });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: { consumeApiRateLimit: async () => {}, apiSecurityResponse: () => null } });
mock.module(mod("lib/billingConfig.ts"), { namedExports: {
  getBillingPlans: async () => [{ id: "pro", stripePriceId: "price_pro" }, { id: "max", stripePriceId: "price_max" }],
  tierForPlanId: (id: string) => id === "max" ? "Max" : id === "pro" ? "Pro" : "Free",
} });
mock.module(mod("lib/stripe.ts"), { namedExports: { isStripeConfigured: () => true, getStripe: () => ({ subscriptions: {
  retrieve: async () => ({ id: "sub_test", customer: "cus_test", status, metadata: { planId: targetPlan },
    current_period_end: Math.floor(Date.now() / 1000) + 86400, cancel_at_period_end: false,
    items: { data: [{ price: { id: `price_${targetPlan}`, recurring: { interval: "month" } } }] } }),
} }) } });
const require = createRequire(import.meta.url);
const { POST } = require(resolve(root, "app/api/admin/users/[userId]/billing-resync/route.ts")) as typeof import("../../app/api/admin/users/[userId]/billing-resync/route");
const run = () => POST(new Request("https://tomverse.app/api/admin/users/target/billing-resync", { method: "POST" }), { params: Promise.resolve({ userId: "target" }) });
test("admin resync clears cancelled web entitlement while preserving paid native access", async () => {
  Object.assign(account, baseline); locks = 0; status = "canceled"; targetPlan = "pro";
  const response = await run();
  assert.equal(response.status, 200); assert.equal(account.webSubscriptionPlan, "Free"); assert.equal(account.plan, "Max");
  assert.ok(locks > 0);
});
test("admin resync applies a web upgrade after native expiry through the same entitlement writer", async () => {
  Object.assign(account, baseline, { storeSubscriptionExpiresAt: new Date("2000-01-01") }); status = "active"; targetPlan = "max";
  const response = await run();
  assert.equal(response.status, 200); assert.equal(account.webSubscriptionPlan, "Max"); assert.equal(account.plan, "Max");
});
test("an unauthenticated resync cannot alter either source", async () => {
  authorized = false; const before = { ...account }; const response = await run();
  assert.equal(response.status, 404); assert.deepEqual(account, before);
});
