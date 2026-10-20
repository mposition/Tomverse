import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const mod = (path) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
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
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: { user: { findUnique: async ({ where }) => ({ id: where.id, name: "Synthetic", email: "synthetic@example.invalid", image: null, accountStatus: account }) } } } });
const { resolveChatRouteSession } = await import("../../lib/chatRouteSession.ts");
const req = (headers = {}, path = "/api/chat", method = "POST") => new Request(`https://tomverse.app${path}`, { method, headers });

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
  for (const [path, method] of [["/api/chat", "DELETE"], ["/api/conversations/c1/share", "POST"], ["/api/products/review/conversations", "POST"]]) {
    assert.equal((await resolveChatRouteSession(req({ authorization: "Bearer valid-owner" }, path, method))).response?.status, 401);
  }
  delete process.env.TOMVERSE_NATIVE_CHAT_ENABLED;
});
