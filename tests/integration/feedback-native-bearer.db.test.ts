import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { after, before, beforeEach, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { resetTestFixture } from "./resetTestFixture";

// The mobile app reports a problem with one answer through /api/feedback with
// its own bearer, not a cookie (owner approval, 2026-10-24). This drives the
// real route with a real mobile session: the report is the bearer's, it is
// attributed only to an assistant message that bearer owns, and the parity
// flag still gates the whole path.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) => pathToFileURL(resolve(ROOT, relativePath)).href;

const ed25519 = () =>
  generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");

process.env.MOBILE_AUTH_SIGNING_KEYS = `sign-1:${ed25519()}`;
process.env.MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID = "sign-1";
process.env.MOBILE_AUTH_REFRESH_PEPPERS = `pep-1:${randomBytes(32).toString("base64url")}`;
process.env.MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID = "pep-1";
process.env.MOBILE_AUTH_TOKEN_ISSUER = "https://tomverse.test";
process.env.MOBILE_AUTH_TOKEN_AUDIENCE = "tomverse-mobile-api";
process.env.TOMVERSE_NATIVE_CHAT_ENABLED = "true";
process.env.ADMIN_AUDIT_INTEGRITY_KEY ||= "feedback-native-bearer-audit-test-key";
delete process.env.RESEND_API_KEY;

// A cookie must never be consulted on the bearer path; this one would be a
// different account if it were.
mock.module("next-auth/next", {
  namedExports: { getServerSession: async () => ({ user: { id: "cookie-account" } }) },
});
let guestChecks = 0;
mock.module(mod("lib/turnstile.ts"), {
  namedExports: { ensureGuestVerified: async () => { guestChecks++; return undefined; } },
});
globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let feedbackRoute: { POST: (request: Request) => Promise<Response> };
let issueMobileSession: (typeof import("@/lib/mobileAuthService"))["issueMobileSession"];

before(async () => {
  ({ prisma } = (await import(mod("lib/prisma.ts"))) as typeof import("@/lib/prisma"));
  ({ issueMobileSession } = (await import(mod("lib/mobileAuthService.ts"))) as typeof import("@/lib/mobileAuthService"));
  feedbackRoute = (await import(mod("app/api/feedback/route.ts"))) as typeof feedbackRoute;
});

const reset = async () => {
  await resetTestFixture(prisma, `
    TRUNCATE TABLE
      "MobileAuthEvent", "MobileRefreshRotation", "MobileTokenFamily", "MobileLoginGrant", "MobileDevice",
      "NotificationDelivery", "FeedbackLifecycleEvent", "Feedback", "Message", "Conversation",
      "ChatUsageBucket", "UserSettings", "User"
    RESTART IDENTITY CASCADE
  `);
  const { resetMobileSessionSnapshotsForTesting } = await import(mod("lib/mobileSessionAuthorization.ts"));
  resetMobileSessionSnapshotsForTesting();
  guestChecks = 0;
};
beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

const seedUserWithAnswer = async (label: string) => {
  const user = await prisma.user.create({ data: { email: `${label}-${randomUUID()}@example.test` } });
  const conversation = await prisma.conversation.create({
    data: { selectedModels: '["gpt-6-luna"]', userId: user.id, title: `${label} conversation` },
  });
  const answer = await prisma.message.create({
    data: { conversationId: conversation.id, role: "assistant", content: "An answer." },
  });
  return { user, answer };
};

const tokenFor = async (userId: string) => {
  const result = await issueMobileSession({
    request: new Request("https://tomverse.test/api/auth/mobile/exchange", { method: "POST" }),
    userId, deviceLabel: "Phone", platform: "ios", appVersion: "1.0.0",
  });
  return result.tokens.accessToken;
};

const report = (token: string | null, messageId: string) =>
  feedbackRoute.POST(new Request("https://tomverse.test/api/feedback", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      cookie: "next-auth.session-token=another-account",
    },
    body: JSON.stringify({ type: "bug", message: "The answer is wrong about caffeine.", messageId, answerSignal: "needs_improvement" }),
  }));

test("an app report is the bearer's and is attributed to the bearer's own answer", async () => {
  process.env.TOMVERSE_NATIVE_PARITY_ENABLED = "true";
  const { user, answer } = await seedUserWithAnswer("owner");

  const response = await report(await tokenFor(user.id), answer.id);
  assert.equal(response.status, 200, await response.clone().text());

  const saved = await prisma.feedback.findFirstOrThrow();
  assert.equal(saved.userId, user.id);
  assert.equal(saved.messageId, answer.id);
  assert.equal(saved.answerSignal, "needs_improvement");
  assert.equal(guestChecks, 0);
});

test("an app report naming another account's answer is kept but not linked to it", async () => {
  process.env.TOMVERSE_NATIVE_PARITY_ENABLED = "true";
  const { user } = await seedUserWithAnswer("reporter");
  const { answer: foreign } = await seedUserWithAnswer("stranger");

  const response = await report(await tokenFor(user.id), foreign.id);
  assert.equal(response.status, 200);
  const saved = await prisma.feedback.findFirstOrThrow();
  assert.equal(saved.userId, user.id);
  assert.equal(saved.messageId, null);
  assert.equal(saved.answerSignal, null);
});

test("without the parity flag, or with a bad bearer, nothing is stored and no cookie is used", async () => {
  const { user, answer } = await seedUserWithAnswer("owner");
  const token = await tokenFor(user.id);

  delete process.env.TOMVERSE_NATIVE_PARITY_ENABLED;
  assert.equal((await report(token, answer.id)).status, 503);

  process.env.TOMVERSE_NATIVE_PARITY_ENABLED = "true";
  assert.equal((await report("not-a-token", answer.id)).status, 401);

  assert.equal(await prisma.feedback.count(), 0);
  assert.equal(guestChecks, 0);
});
