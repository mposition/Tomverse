import assert from "node:assert/strict";
import { before, beforeEach, test, mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const mod = (path: string) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
let available = true;
let proof: { ok: true; userId: string } | { ok: false; reason: string } = { ok: true, userId: "verified-user" };
let status = "active";
let suspendedUntil: Date | null = null;
let delivered = true;
let limited = false;
const calls: string[] = [];
mock.module(mod("lib/mobileAccessToken.ts"), { namedExports: { mobileAuthReady: () => available } });
mock.module(mod("lib/mobileAuthRoute.ts"), { namedExports: {
  enforceMobileAuthAdmission: async () => { calls.push("admission"); if (limited) throw Error("limit"); },
  mobileApiSecurityResponse: (error: Error & { status?: number }) => error.message === "limit" ? Response.json({ code: "MOBILE_RATE_LIMITED" }, { status: 429, headers: { "Retry-After": "60" } }) : error.status ? Response.json({ ok: false }, { status: error.status }) : null,
} });
mock.module(mod("lib/emailLogin.ts"), { namedExports: { verifyEmailLoginCode: async (_request: Request, email: string, code: string, intent: string) => { calls.push("proof"); assert.equal(email, "user@example.com"); assert.equal(code, "123456"); assert.equal(intent, "signin"); return proof; } } });
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
const GET = () => api.GET();
beforeEach(() => { process.env.TOMVERSE_NATIVE_CHAT_ENABLED = "true"; available = true; status = "active"; suspendedUntil = null; delivered = true; limited = false; proof = { ok: true, userId: "verified-user" }; calls.length = 0; });
const request = (body: object, origin?: string) => POST(new Request("https://tomverse.app/api/auth/mobile/email", {
  method: "POST", headers: { "content-type": "application/json", "accept-language": "ko", cookie: "forged-session", ...(origin ? { origin } : {}) }, body: JSON.stringify(body),
}));
const verify = { action: "verify", email: "USER@example.com", code: "123456", platform: "android" };
test("default-off or unready admission does not consume codes, deliver mail or issue a session", async () => {
  delete process.env.TOMVERSE_NATIVE_CHAT_ENABLED;
  assert.equal(GET().status, 503); assert.equal((await request(verify)).status, 503); assert.deepEqual(calls, []);
  process.env.TOMVERSE_NATIVE_CHAT_ENABLED = "true"; available = false;
  assert.equal((await request({ action: "request", email: "user@example.com" })).status, 503); assert.deepEqual(calls, []);
});
test("capability probe is no-store and performs no writes", async () => { const result = GET(); assert.equal(result.status, 200); assert.equal(result.headers.get("cache-control"), "no-store"); assert.equal((await result.json()).emailCode, true); assert.deepEqual(calls, []); });
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
