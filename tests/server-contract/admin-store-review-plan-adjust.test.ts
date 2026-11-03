import assert from "node:assert/strict";
import { before, beforeEach, mock, test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const mod = (path: string) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
let email = "play-review-synthetic@tomverse.app";
let saved: Record<string, unknown> | null;
let approved = false;
class SecurityError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const initial = () => ({ id: "synthetic-user", email, plan: "Free", webSubscriptionPlan: "Free", subscriptionStatus: null,
  subscriptionCurrentPeriodEnd: null, storeSubscriptionPlan: null, storeSubscriptionExpiresAt: null, storeSubscriptionSnapshot: null });
const db = { user: {
  findUnique: async () => initial(), findUniqueOrThrow: async () => initial(),
  update: async ({ data }: { data: Record<string, unknown> }) => { assert.equal(approved, true); saved = data; return { ...initial(), ...data }; },
} };
mock.module("next-auth/next", { namedExports: { getServerSession: async () => ({ user: { id: "admin" } }) } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/adminAuth.ts"), { namedExports: { hasAdminPermission: () => true, isAdminSession: () => true } });
mock.module(mod("lib/adminApproval.ts"), { namedExports: { adminApprovalErrorResponse: () => null,
  runWithAdminApproval: async (_context: unknown, fn: () => unknown) => { approved = true; return fn(); } } });
mock.module(mod("lib/adminAudit.ts"), { namedExports: { writeAdminAuditLog: async () => {} } });
mock.module(mod("lib/subscriptionEntitlements.ts"), { namedExports: { lockSubscriptionAccount: async () => {} } });
mock.module(mod("lib/standardEmailLane.ts"), { namedExports: { enqueueStandardEmail: async () => {} } });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  ApiSecurityError: SecurityError, consumeApiRateLimit: async () => {}, readLimitedJson: async (request: Request) => request.json(),
  apiSecurityResponse: (error: unknown) => error instanceof SecurityError ? Response.json({ code: error.code }, { status: error.status }) : null,
} });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: { ...db, $transaction: async (fn: (tx: typeof db) => unknown) => fn(db) } } });
let route: typeof import("../../app/api/admin/users/[userId]/plan-adjust/route");
before(async () => { route = await import("../../app/api/admin/users/[userId]/plan-adjust/route"); });
beforeEach(() => { email = "play-review-synthetic@tomverse.app"; saved = null; approved = false; });
const adjust = (extra = {}) => route.PATCH(new Request("https://tomverse.app/api/admin/users/synthetic-user/plan-adjust", {
  method: "PATCH", body: JSON.stringify({ plan: "Max", subscriptionStatus: "manually_adjusted", reason: "Authorized Google review", confirmText: "ADJUST PLAN", ...extra }),
}), { params: Promise.resolve({ userId: "synthetic-user" }) });

test("a review Max grant uses the existing approval flow and an expiring entitlement status", async () => {
  const start = Date.now();
  assert.equal((await adjust()).status, 200);
  assert.equal(saved?.plan, "Max"); assert.equal(saved?.subscriptionStatus, "mobile_store_review");
  const end = saved?.subscriptionCurrentPeriodEnd as Date;
  assert.ok(end.getTime() >= start + 30 * 86400000 && end.getTime() <= Date.now() + 30 * 86400000);
});
for (const periodEnd of [null, new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 32 * 86400000).toISOString()]) {
  test(`review Max refuses an unbounded or invalid period: ${periodEnd}`, async () => {
    const result = await adjust({ periodEnd }); assert.equal(result.status, 400);
    assert.equal((await result.json()).code, "INVALID_REVIEW_PERIOD"); assert.equal(saved, null);
  });
}
test("ordinary manual plans keep their status and explicit unlimited period", async () => {
  email = "ordinary@example.invalid";
  assert.equal((await adjust({ periodEnd: null })).status, 200);
  assert.equal(saved?.subscriptionStatus, "manually_adjusted"); assert.equal(saved?.subscriptionCurrentPeriodEnd, null);
});
test("review Free downgrade clears the paid entitlement", async () => {
  assert.equal((await adjust({ plan: "Free" })).status, 200);
  assert.equal(saved?.plan, "Free"); assert.equal(saved?.subscriptionCurrentPeriodEnd, null);
});
