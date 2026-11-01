import assert from "node:assert/strict";
import { before, beforeEach, test, mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CURRENT_CONSENT_COPY_VERSION } from "../../lib/emailConsentCopy";

const mod = (path: string) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
let available = true;
let proof: { ok: true; userId: string; isNewUser?: boolean; emailLoginAttemptId?: string } | { ok: false; reason: string } = { ok: true, userId: "verified-user" };
let intent = "signin";
let consentAvailable = true;
let finalizeOk = true;
let issuedChoice: unknown;
let status = "active";
let suspendedUntil: Date | null = null;
let delivered = true;
let limited = false;
let reviewHandled = false;
const calls: string[] = [];
mock.module(mod("lib/mobileAccessToken.ts"), { namedExports: { mobileAuthReady: () => available } });
mock.module(mod("lib/mobileAuthRoute.ts"), { namedExports: {
  enforceMobileAuthAdmission: async () => { calls.push("admission"); if (limited) throw Error("limit"); },
  mobileApiSecurityResponse: (error: Error & { status?: number }) => error.message === "limit" ? Response.json({ code: "MOBILE_RATE_LIMITED" }, { status: 429, headers: { "Retry-After": "60" } }) : error.status ? Response.json({ ok: false }, { status: error.status }) : null,
} });
mock.module(mod("lib/emailLogin.ts"), { namedExports: { verifyEmailLoginCode: async (_request: Request, email: string, code: string, actualIntent: string) => { calls.push("proof"); assert.equal(email, "user@example.com"); assert.equal(code, "123456"); assert.equal(actualIntent, intent); return proof; } } });
mock.module(mod("lib/signupConsent.ts"), { namedExports: {
  signupConsentAvailable: async () => { calls.push("options"); return consentAvailable; },
  issueSignupConsentAttempt: async (choice: unknown) => { calls.push("choice"); issuedChoice = choice; return { ok: true, attemptId: "signup-attempt", nonce: "synthetic-nonce", expiresAt: new Date(Date.now() + 60_000) }; },
  finalizeSignupConsentAttempt: async (input: { userId: string; createdBySignIn: boolean; emailLoginAttemptId: string; addressProof: { method: string; address: string }; attemptId: string; nonce: string }) => {
    calls.push("consent"); assert.equal(input.userId, "verified-user"); assert.equal(input.createdBySignIn, true); assert.equal(input.emailLoginAttemptId, "spent-row");
    assert.equal(input.attemptId, "signup-attempt"); assert.equal(input.nonce, "synthetic-nonce"); assert.equal(input.addressProof.method, "email_code"); assert.equal(input.addressProof.address, "user@example.com");
    return finalizeOk ? { ok: true } : { ok: false, reason: "confirmation_unavailable" };
  },
} });
mock.module(mod("lib/mobileStoreReview.ts"), { namedExports: {
  requestMobileStoreReviewCode: async () => reviewHandled,
  verifyMobileStoreReviewCode: async (_request: Request, input: { appId?: string; buildNumber?: number }) => {
    if (!reviewHandled) return null;
    assert.equal(input.appId, "app.tomverse.shell"); assert.equal(input.buildNumber, 16);
    calls.push("review-proof"); return proof;
  },
} });
mock.module(mod("lib/mobileAuthService.ts"), { namedExports: { issueMobileSession: async (input: { userId: string }) => { calls.push("issue"); assert.equal(input.userId, "verified-user"); return { tokens: { accessToken: "synthetic-access", refreshToken: "synthetic-native-only", expiresIn: 600, deviceId: "device" } }; } } });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: { user: {
  findUnique: async () => { calls.push("account"); return { accountStatus: status, accountSuspendedUntil: suspendedUntil }; },
  updateMany: async (input: { where: { id: string; accountStatus: string; accountSuspendedUntil: { lte: Date } } }) => {
    calls.push("reactivate"); assert.equal(input.where.id, "verified-user"); assert.equal(input.where.accountStatus, "suspended");
    assert.ok(suspendedUntil && suspendedUntil <= input.where.accountSuspendedUntil.lte); status = "active"; return { count: 1 };
  },
} } } });
mock.module(mod("app/api/auth/email-login/request/route.ts"), { namedExports: { POST: async (request: Request) => {
  calls.push("delivery");
  assert.deepEqual(await request.json(), { email: "user@example.com" });
  assert.equal(request.headers.get("accept-language"), "ko");
  assert.equal(request.headers.get("content-length"), null);
  assert.equal(request.headers.get("cookie"), null);
  return Response.json({ ok: delivered, ...(!delivered ? { code: "SEND_FAILED" } : {}) }, { status: delivered ? 200 : 502 });
} } });
let api: typeof import("../../app/api/auth/mobile/email/route");
before(async () => { api = await import("../../app/api/auth/mobile/email/route"); });
const POST = (request: Request) => api.POST(request);
const GET = () => api.GET(new Request("https://tomverse.app/api/auth/mobile/email", { headers: { "cf-ipcountry": "AU" } }));
beforeEach(() => { process.env.TOMVERSE_NATIVE_CHAT_ENABLED = "true"; delete process.env.TOMVERSE_NATIVE_EMAIL_SIGNUP_ENABLED; intent = "signin"; consentAvailable = true; finalizeOk = true; issuedChoice = undefined; available = true; status = "active"; suspendedUntil = null; delivered = true; limited = false; reviewHandled = false; proof = { ok: true, userId: "verified-user" }; calls.length = 0; });
const request = (body: object, origin?: string) => POST(new Request("https://tomverse.app/api/auth/mobile/email", {
  method: "POST", headers: { "content-type": "application/json", "accept-language": "ko", "cf-ipcountry": "AU", cookie: "forged-session", ...(origin ? { origin } : {}) }, body: JSON.stringify(body),
}));
const verify = { action: "verify", email: "USER@example.com", code: "123456", platform: "android" };
test("default-off or unready admission does not consume codes, deliver mail or issue a session", async () => {
  delete process.env.TOMVERSE_NATIVE_CHAT_ENABLED;
  assert.equal((await GET()).status, 503); assert.equal((await request(verify)).status, 503); assert.deepEqual(calls, []);
  process.env.TOMVERSE_NATIVE_CHAT_ENABLED = "true"; available = false;
  assert.equal((await request({ action: "request", email: "user@example.com" })).status, 503); assert.deepEqual(calls, []);
});
test("capability probe is no-store and performs no writes", async () => { const result = await GET(); assert.equal(result.status, 200); assert.equal(result.headers.get("cache-control"), "no-store"); assert.equal((await result.json()).emailCode, true); assert.deepEqual(calls, []); });
for (const origin of ["https://evil.invalid", "https://localhost", "capacitor://localhost", "https://tomverse.app", "null"]) test(origin + " cannot read native token responses or send mail", async () => {
  assert.equal((await request(verify, origin)).status, 403);
  assert.equal((await request({ action: "request", email: "user@example.com" }, origin)).status, 403);
  assert.deepEqual(calls, []);
});
test("preauth limit precedes proof and preserves retry-after", async () => { limited = true; const result = await request(verify); assert.equal(result.status, 429); assert.equal(result.headers.get("retry-after"), "60"); assert.deepEqual(calls, ["admission"]); });
test("existing request handler receives normalized email and language, with delivery failure preserved", async () => {
  const body = { action: "request", email: " USER@example.com " };
  assert.equal((await request(body)).status, 200);
  delivered = false; assert.equal((await request(body)).status, 502);
  assert.ok(!calls.includes("issue"));
});
test("wrong, expired, held or disabled proof cannot issue a session even with a cookie", async () => { proof = { ok: false, reason: "invalid_or_expired" }; const result = await request(verify); assert.equal(result.status, 401); assert.deepEqual(calls, ["admission", "proof"]); });
test("verified unknown address does not create an account", async () => { proof = { ok: false, reason: "account_not_found" }; const result = await request(verify); assert.equal((await result.json()).code, "EMAIL_ACCOUNT_NOT_FOUND"); assert.ok(!calls.includes("issue")); });
for (const state of ["suspended", "pending_deletion", "deletion_processing"]) test(state + " account cannot receive a session", async () => { status = state; assert.equal((await request(verify)).status, 403); assert.ok(!calls.includes("issue")); });
test("only origin-free verified active native identity receives tokens, no-store", async () => { const result = await request(verify); assert.equal(result.status, 200); assert.equal(result.headers.get("cache-control"), "no-store"); assert.equal((await result.json()).accessToken, "synthetic-access"); assert.deepEqual(calls, ["admission", "proof", "account", "issue"]); });
test("expired suspension is conditionally cleared and re-read before issuing", async () => { status = "suspended"; suspendedUntil = new Date(Date.now() - 1000); assert.equal((await request(verify)).status, 200); assert.deepEqual(calls, ["admission", "proof", "account", "reactivate", "account", "issue"]); });
test("a future suspension is not cleared", async () => { status = "suspended"; suspendedUntil = new Date(Date.now() + 60000); assert.equal((await request(verify)).status, 403); assert.ok(!calls.includes("reactivate")); });
test("delegating a smaller email body removes the outer content-length and cookie", async () => {
  const result = await POST(new Request("https://tomverse.app/api/auth/mobile/email", { method: "POST", headers: { "content-type": "application/json", "content-length": "3000", "accept-language": "ko", cookie: "untrusted" }, body: JSON.stringify({ action: "request", email: "user@example.com" }) }));
  assert.equal(result.status, 200); assert.ok(calls.includes("delivery"));
});
test("client cannot submit signup intent or substitute user identity", async () => { const result = await request({ ...verify, userId: "forged", intent: "signup" }); assert.equal(result.status, 400); assert.ok(!calls.includes("proof")); });
test("store reviewer follows the same active-account and native session boundary", async () => {
  reviewHandled = true;
  const make = () => POST(new Request("https://tomverse.app/api/auth/mobile/email", { method: "POST", headers: { "content-type": "application/json", "x-tomverse-app-id": "app.tomverse.shell", "x-tomverse-build": "16" }, body: JSON.stringify(verify) }));
  assert.equal((await make()).status, 200);
  assert.deepEqual(calls, ["admission", "review-proof", "account", "issue"]);
  calls.length = 0; status = "pending_deletion";
  assert.equal((await make()).status, 403); assert.ok(!calls.includes("issue"));
});
test("configured store reviewer request does not send mail or return the code", async () => {
  reviewHandled = true;
  const result = await request({ action: "request", email: "user@example.com" });
  assert.deepEqual(await result.json(), { ok: true }); assert.deepEqual(calls, ["admission"]);
});
test("a refused store credential never falls back to ordinary OTP proof", async () => {
  reviewHandled = true; proof = { ok: false, reason: "invalid_or_expired" };
  const result = await POST(new Request("https://tomverse.app/api/auth/mobile/email", { method: "POST", headers: { "content-type": "application/json", "x-tomverse-app-id": "app.tomverse.shell", "x-tomverse-build": "16" }, body: JSON.stringify(verify) }));
  assert.equal(result.status, 401); assert.deepEqual(calls, ["admission", "review-proof"]);
});

const signupChoice = { shown: true, optIn: false, objected: false, copyVersion: CURRENT_CONSENT_COPY_VERSION, language: "ko" };
const signup = (choice = signupChoice) => ({ ...verify, action: "signup", signupConsent: choice });
const enableSignup = () => { process.env.TOMVERSE_NATIVE_EMAIL_SIGNUP_ENABLED = "true"; intent = "signup"; proof = { ok: true, userId: "verified-user", isNewUser: true, emailLoginAttemptId: "spent-row" }; };

test("native signup is separately default-off and never consumes an OTP", async () => {
  assert.equal((await GET()).status, 200); assert.equal((await (await GET()).json()).emailSignup, undefined);
  assert.equal((await request(signup())).status, 503); assert.deepEqual(calls, ["admission"]);
});
test("enabled signup advertises public consent capabilities without account lookup", async () => {
  enableSignup(); const response = await GET(); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual((await response.json()).emailSignup, { consentEnabled: true, copyVersion: CURRENT_CONSENT_COPY_VERSION }); assert.deepEqual(calls, ["options"]);
});
for (const origin of ["https://localhost", "https://evil.invalid", "https://tomverse.app"]) test(origin + " cannot create a native email account", async () => {
  enableSignup(); assert.equal((await request(signup(), origin)).status, 403); assert.deepEqual(calls, []);
});
for (const choice of [{ ...signupChoice, copyVersion: "old" }, { ...signupChoice, shown: false }, { ...signupChoice, optIn: true, objected: true }]) test("stale or contradictory signup choice cannot consume mailbox proof: " + JSON.stringify(choice), async () => {
  enableSignup(); const result = await request(signup(choice)); assert.equal(result.status, 409); assert.ok(!calls.includes("proof")); assert.ok(!calls.includes("choice"));
});
test("invalid signup proof cannot record consent or issue a session", async () => {
  enableSignup(); proof = { ok: false, reason: "invalid_or_expired" }; assert.equal((await request(signup())).status, 401);
  assert.ok(!calls.includes("consent")); assert.ok(!calls.includes("issue"));
});
for (const choice of [signupChoice, { ...signupChoice, optIn: true }, { ...signupChoice, objected: true }]) test("new native account finalizes only its presented choice: " + JSON.stringify(choice), async () => {
  enableSignup(); const response = await request(signup(choice)); assert.equal(response.status, 200);
  assert.deepEqual(calls, ["admission", "options", "choice", "proof", "account", "consent", "issue"]);
  assert.deepEqual(issuedChoice, { channel: "email_code", email: "user@example.com", expressOptInRequested: choice.optIn, objected: choice.objected, language: "ko", ipCountry: "AU" });
});
test("unavailable consent devices create no consent evidence", async () => {
  enableSignup(); consentAvailable = false; assert.equal((await request(signup({ ...signupChoice, shown: false }))).status, 200);
  assert.deepEqual(calls, ["admission", "options", "proof", "account", "issue"]);
});
test("an existing account never consumes a signup choice", async () => {
  enableSignup(); proof = { ok: true, userId: "verified-user", isNewUser: false }; assert.equal((await request(signup())).status, 200); assert.ok(!calls.includes("consent"));
});
test("a failed consent finalization cannot falsely report signup completion", async () => {
  enableSignup(); finalizeOk = false; const response = await request(signup()); assert.equal(response.status, 503); assert.equal((await response.json()).code, "EMAIL_SIGNUP_INCOMPLETE"); assert.ok(!calls.includes("issue"));
});
test("store-review credentials are never a signup proof", async () => {
  enableSignup(); reviewHandled = true; proof = { ok: false, reason: "invalid_or_expired" }; assert.equal((await request(signup())).status, 401); assert.ok(!calls.includes("review-proof")); assert.ok(!calls.includes("issue"));
});
