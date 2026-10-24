import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const mod = (path) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
let familyCreatedAt = new Date(); let familyAvailable = true;
let cookies = 0; let bearerChecks = 0; let account = "active"; let tokenState = "valid";
mock.module("next-auth/next", { namedExports: { getServerSession: async () => { cookies++; return { user: { id: "cookie-owner" } }; } } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/mobileAuthRoute.ts"), { namedExports: {
  mobileAuthRefusal: (code) => Response.json({ code }, { status: 401 }),
  requireMobileBearer: async (request) => {
    bearerChecks++;
    if (tokenState !== "valid" || request.headers.get("authorization") !== "Bearer valid-owner") return { ok: false, response: Response.json({ code: tokenState }, { status: 401 }) };
    return { ok: true, identity: { userId: "bearer-owner", deviceId: "device", familyId: "family" } };
  },
} });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: { mobileTokenFamily: { findFirst: async ({ where }) => { assert.equal(where.id, "family"); assert.equal(where.userId, "bearer-owner"); assert.equal(where.deviceId, "device"); assert.equal(where.revokedAt, null); return familyAvailable ? { createdAt: familyCreatedAt } : null; } }, user: { findUnique: async ({ where }) => ({ id: where.id, name: "Synthetic", email: "synthetic@example.invalid", image: null, accountStatus: account }) } } } });
const { resolveChatRouteSession, resolveAccountRouteSession } = await import("../../lib/chatRouteSession.ts");
const req = (headers = {}, path = "/api/chat", method = "POST") => new Request(`https://tomverse.app${path}`, { method, headers });

test("native voice independently verifies the bearer, account and exact method without cookie fallback", async () => {
  const before = cookies; delete process.env.TOMVERSE_NATIVE_CHAT_ENABLED;
  const request = req({ authorization: "Bearer valid-owner", origin: "https://localhost" }, "/api/chat/voice");
  assert.equal((await resolveChatRouteSession(request)).response.status, 401);
  process.env.TOMVERSE_NATIVE_CHAT_ENABLED = "true";
  assert.equal((await resolveChatRouteSession(request)).session.user.id, "bearer-owner");
  tokenState = "revoked";
  assert.equal((await resolveChatRouteSession(request)).response.status, 401);
  tokenState = "valid";
  assert.equal((await resolveChatRouteSession(req({ authorization: "Bearer valid-owner" }, "/api/chat/voice/extra"))).response.status, 401);
  assert.equal((await resolveChatRouteSession(req({ authorization: "Bearer valid-owner" }, "/api/chat/voice", "DELETE"))).response.status, 401);
  assert.equal(cookies, before); delete process.env.TOMVERSE_NATIVE_CHAT_ENABLED;
});

test("an answer report from the app needs the parity flag, POST only, and the bearer's identity", async () => {
  process.env.TOMVERSE_NATIVE_CHAT_ENABLED = "true";
  const before = cookies;
  delete process.env.TOMVERSE_NATIVE_PARITY_ENABLED;
  assert.equal((await resolveChatRouteSession(req({ authorization: "Bearer valid-owner" }, "/api/feedback"))).response.status, 503);
  process.env.TOMVERSE_NATIVE_PARITY_ENABLED = "true";
  const result = await resolveChatRouteSession(req({ authorization: "Bearer valid-owner", origin: "capacitor://localhost", cookie: "another-account" }, "/api/feedback"));
  assert.equal(result.session.user.id, "bearer-owner");
  for (const [path, method] of [["/api/feedback", "GET"], ["/api/feedback/export", "POST"], ["/api/admin/feedback", "POST"]]) {
    assert.equal((await resolveChatRouteSession(req({ authorization: "Bearer valid-owner" }, path, method))).response.status, 401);
  }
  assert.equal(cookies, before);
  delete process.env.TOMVERSE_NATIVE_PARITY_ENABLED; delete process.env.TOMVERSE_NATIVE_CHAT_ENABLED;
});

test("cookie path is unchanged and does not consult bearer verification", async () => {
  delete process.env.TOMVERSE_NATIVE_CHAT_ENABLED;
  const before = bearerChecks;
  const result = await resolveChatRouteSession(req());
  assert.equal(result.session?.user.id, "cookie-owner"); assert.equal(bearerChecks, before);
});
test("default-off and hostile origin fail closed without cookie fallback", async () => {
  const before = cookies;
  let result = await resolveChatRouteSession(req({ authorization: "Bearer valid-owner", origin: "https://localhost" }));
  assert.equal(result.response?.status, 401);
  process.env.TOMVERSE_NATIVE_CHAT_ENABLED = "true";
  result = await resolveChatRouteSession(req({ authorization: "Bearer valid-owner", origin: "https://attacker.invalid" }));
  assert.equal(result.response?.status, 401); assert.equal(cookies, before);
});
test("bearer identity replaces cookie identity and forged internal identity is ignored", async () => {
  process.env.TOMVERSE_NATIVE_CHAT_ENABLED = "true";
  const before = cookies;
  const result = await resolveChatRouteSession(req({ authorization: "Bearer valid-owner", origin: "capacitor://localhost", "x-tomverse-auth-subject": "another-owner", cookie: "synthetic-cookie" }));
  assert.equal(result.session?.user.id, "bearer-owner"); assert.equal(cookies, before);
});
test("invalid, expired and revoked session responses never fall back to a cookie", async () => {
  const before = cookies;
  for (tokenState of ["invalid", "expired", "family_revoked", "device_revoked", "sessions_revoked"]) {
    assert.equal((await resolveChatRouteSession(req({ authorization: "Bearer valid-owner" }))).response?.status, 401);
  }
  tokenState = "valid"; account = "suspended";
  assert.equal((await resolveChatRouteSession(req({ authorization: "Bearer valid-owner" }))).response?.status, 401);
  account = "active"; assert.equal(cookies, before);
});
test("unregistered operations cannot borrow an enrolled credential", async () => {
  for (const [path, method] of [["/api/chat", "DELETE"], ["/api/conversations/c1/share", "GET"], ["/api/user/settings/extra", "POST"]]) {
    assert.equal((await resolveChatRouteSession(req({ authorization: "Bearer valid-owner" }, path, method))).response?.status, 401);
  }
  delete process.env.TOMVERSE_NATIVE_CHAT_ENABLED;
});

test("additional mobile routes require their own flag and always use bearer identity", async () => {
  process.env.TOMVERSE_NATIVE_CHAT_ENABLED = "true";
  const before = cookies;
  for (const [path, method] of [["/api/user/usage", "GET"], ["/api/conversations/c1/generate-title", "POST"], ["/api/chat/preflight", "POST"], ["/api/images/generations?requestKey=synthetic", "GET"], ["/api/conversations/c1", "DELETE"], ["/api/conversations/c1/share", "POST"], ["/api/conversations/c1/share", "DELETE"], ["/api/conversations/c1/pin", "PUT"], ["/api/conversations/c1/export", "GET"], ["/api/conversations/c1/verify", "POST"], ["/api/conversations/search?q=fixture", "GET"], ["/api/projects", "GET"], ["/api/projects", "POST"], ["/api/projects/p1", "PATCH"], ["/api/projects/p1", "DELETE"]]) {
    delete process.env.TOMVERSE_NATIVE_PARITY_ENABLED;
    assert.equal((await resolveChatRouteSession(req({ authorization: "Bearer valid-owner" }, path, method))).response.status, 503);
    process.env.TOMVERSE_NATIVE_PARITY_ENABLED = "true";
    assert.equal((await resolveChatRouteSession(req({ authorization: "Bearer valid-owner", cookie: "another-account" }, path, method))).session.user.id, "bearer-owner");
  }
  assert.equal(cookies, before); delete process.env.TOMVERSE_NATIVE_PARITY_ENABLED;
});

const { hasRecentAccountAuthentication } = await import("../../lib/adminReauthentication.ts");
test("native sensitive account actions stay default-off without using a cookie", async () => {
  process.env.TOMVERSE_NATIVE_CHAT_ENABLED = "true";
  delete process.env.TOMVERSE_NATIVE_ACCOUNT_ENABLED;
  const before = cookies;
  const result = await resolveAccountRouteSession(req({ authorization: "Bearer valid-owner" }, "/api/user/account", "DELETE"));
  assert.equal(result.response.status, 503); assert.equal(cookies, before);
});
test("only the actual family sign-in time can satisfy account reauthentication", async () => {
  process.env.TOMVERSE_NATIVE_ACCOUNT_ENABLED = "true";
  familyCreatedAt = new Date(Date.now() - 3600000);
  const request = req({ authorization: "Bearer valid-owner" }, "/api/user/account", "DELETE");
  let result = await resolveAccountRouteSession(request);
  assert.equal(hasRecentAccountAuthentication(result.session), false);
  familyCreatedAt = new Date(); result = await resolveAccountRouteSession(request);
  assert.equal(hasRecentAccountAuthentication(result.session), true);
  familyAvailable = false; result = await resolveAccountRouteSession(request);
  assert.equal(result.response.status, 401); familyAvailable = true;
  delete process.env.TOMVERSE_NATIVE_CHAT_ENABLED; delete process.env.TOMVERSE_NATIVE_ACCOUNT_ENABLED;
});


test("parity additions stay unavailable until both flags are enabled; account actions keep their own gate", async () => {
  const before = cookies;
  process.env.TOMVERSE_NATIVE_CHAT_ENABLED = "true";
  delete process.env.TOMVERSE_NATIVE_PARITY_ENABLED;
  const request = req({ authorization: "Bearer valid-owner", origin: "https://localhost" }, "/api/user/settings", "POST");
  assert.equal((await resolveChatRouteSession(request)).response.status, 503);
  process.env.TOMVERSE_NATIVE_PARITY_ENABLED = "true";
  assert.equal((await resolveChatRouteSession(request)).session.user.id, "bearer-owner");
  tokenState = "revoked";
  assert.equal((await resolveChatRouteSession(request)).response.status, 401);
  tokenState = "valid";
  assert.equal((await resolveChatRouteSession(req({ authorization: "Bearer valid-owner", origin: "https://evil.invalid" }, "/api/images/generations", "POST"))).response.status, 401);
  assert.equal(cookies, before);
  delete process.env.TOMVERSE_NATIVE_CHAT_ENABLED; delete process.env.TOMVERSE_NATIVE_PARITY_ENABLED;
});
