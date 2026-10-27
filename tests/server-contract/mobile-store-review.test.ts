import assert from "node:assert/strict";
import { before, beforeEach, test, mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hashMobileStoreReviewCode } from "../../lib/mobileStoreReviewCore";

const mod = (path: string) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
const credential = { submissionId: "play-closed-synthetic", userId: "review-user", email: "play-review-synthetic@tomverse.app", appId: "app.tomverse.shell" as const, buildNumber: 16, state: "prepared", validUntil: new Date(Date.now() + 86400000).toISOString(), salt: "a".repeat(64), codeHash: "" };
credential.codeHash = hashMobileStoreReviewCode(credential, "654321");
const input = { email: credential.email, code: "654321", appId: credential.appId, buildNumber: 16, platform: "android" };
let user: Record<string, unknown>;
let limited = false;
const calls: string[] = [];
mock.module(mod("lib/apiSecurity.ts"), { namedExports: { consumeApiRateLimit: async (_request: Request, id: string, scope: string, limits: { minute: number; day: number }) => {
  calls.push(scope); assert.equal(id, credential.userId); assert.ok(limits.minute <= 5 && limits.day <= 100); if (limited) throw Error("limited");
} } });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: { user: { findUnique: async () => { calls.push("account"); return user; } } } } });
let api: typeof import("../../lib/mobileStoreReview");
before(async () => { api = await import("../../lib/mobileStoreReview"); });
beforeEach(() => {
  process.env.MOBILE_STORE_REVIEW_ENABLED = "true";
  process.env.MOBILE_STORE_REVIEW_CREDENTIAL_JSON = JSON.stringify(credential);
  delete process.env.ADMIN_EMAILS; delete process.env.ADMIN_USER_IDS;
  user = { id: credential.userId, email: credential.email, plan: "Free", emailVerified: new Date(), emailLoginEnabled: true, accountStatus: "active" };
  limited = false; calls.length = 0;
});
const request = new Request("https://tomverse.app/api/auth/mobile/email");

test("ordinary accounts and default-off configuration never enter the review path", async () => {
  assert.equal(await api.verifyMobileStoreReviewCode(request, { ...input, email: "ordinary@example.invalid" }), null);
  assert.equal(await api.requestMobileStoreReviewCode(request, "ordinary@example.invalid"), false);
  delete process.env.MOBILE_STORE_REVIEW_ENABLED;
  assert.equal(await api.verifyMobileStoreReviewCode(request, input), null);
  assert.deepEqual(calls, []);
});
test("intended Free account uses existing session issuance proof and request reveals no code", async () => {
  assert.equal(await api.requestMobileStoreReviewCode(request, credential.email), true);
  assert.deepEqual(await api.verifyMobileStoreReviewCode(request, input), { ok: true, userId: credential.userId });
  assert.deepEqual(calls, ["mobile-store-review-request", "mobile-store-review-verify", "account"]);
});
test("attempt budget precedes code verification and cannot be bypassed by a correct code", async () => {
  limited = true;
  await assert.rejects(api.verifyMobileStoreReviewCode(request, input), /limited/);
  assert.deepEqual(calls, ["mobile-store-review-verify"]);
});
for (const changed of [{ plan: "Max" }, { accountStatus: "suspended" }, { accountStatus: "pending_deletion" }, { emailVerified: null }, { emailLoginEnabled: false }, { email: "other@example.invalid" }]) test(`account eligibility refusal ${JSON.stringify(changed)}`, async () => {
  Object.assign(user, changed);
  assert.equal((await api.verifyMobileStoreReviewCode(request, input))?.ok, false);
});
for (const admin of ["ADMIN_EMAILS", "ADMIN_USER_IDS"]) test(`${admin} account cannot use store credential`, async () => {
  process.env[admin] = admin === "ADMIN_EMAILS" ? credential.email : credential.userId;
  assert.equal((await api.verifyMobileStoreReviewCode(request, input))?.ok, false);
});
test("wrong build refuses before querying account data", async () => {
  assert.equal((await api.verifyMobileStoreReviewCode(request, { ...input, buildNumber: 15 }))?.ok, false);
  assert.deepEqual(calls, ["mobile-store-review-verify"]);
});
test("Max review access needs a separately granted, unexpired manual plan", async () => {
  const configured = { ...credential, plan: "Max" as const };
  configured.codeHash = hashMobileStoreReviewCode(configured, input.code);
  process.env.MOBILE_STORE_REVIEW_CREDENTIAL_JSON = JSON.stringify(configured);
  assert.equal((await api.verifyMobileStoreReviewCode(request, input))?.ok, false);
  user.plan = "Max";
  assert.equal((await api.verifyMobileStoreReviewCode(request, input))?.ok, false);
  user.subscriptionStatus = "active"; user.subscriptionCurrentPeriodEnd = new Date(Date.now() + 86400000);
  assert.equal((await api.verifyMobileStoreReviewCode(request, input))?.ok, false);
  user.subscriptionStatus = "mobile_store_review"; user.subscriptionCurrentPeriodEnd = null;
  assert.equal((await api.verifyMobileStoreReviewCode(request, input))?.ok, false);
  user.subscriptionCurrentPeriodEnd = new Date(Date.now() + 86400000);
  assert.equal((await api.verifyMobileStoreReviewCode(request, input))?.ok, true);
  user.subscriptionCurrentPeriodEnd = new Date(Date.now() - 1000);
  assert.equal((await api.verifyMobileStoreReviewCode(request, input))?.ok, false);
});
