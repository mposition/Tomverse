import assert from "node:assert/strict";
import { before, beforeEach, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
let cookieReads = 0, bearerReads = 0, valid = true;
mock.module("next-auth/next", { namedExports: { getServerSession: async () => {
  cookieReads++; return { user: { id: "cookie-person", email: "cookie@example.invalid" } };
} } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/mobileAuthRoute.ts"), { namedExports: {
  requireMobileBearer: async () => {
    bearerReads++;
    return valid ? { ok: true, identity: { userId: "bearer-person", deviceId: "device", familyId: "family" } }
      : { ok: false, response: Response.json({ code: "INVALID_TOKEN" }, { status: 401 }) };
  },
  mobileAuthRefusal: () => Response.json({ code: "INVALID_TOKEN" }, { status: 401 }),
} });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  user: { findUnique: async ({ where }: { where: { id: string } }) => ({
    id: where.id, name: "Bearer", email: "bearer@example.invalid", image: null, accountStatus: "active",
  }) },
} } });
let resolveChatRouteSession: typeof import("@/lib/chatRouteSession").resolveChatRouteSession;
before(async () => { ({ resolveChatRouteSession } = await import("@/lib/chatRouteSession")); });
beforeEach(() => {
  cookieReads = 0; bearerReads = 0; valid = true;
  process.env.TOMVERSE_NATIVE_CHAT_ENABLED = "true";
  process.env.TOMVERSE_NATIVE_PARITY_ENABLED = "true";
  process.env.GENERATED_ARTIFACT_REVISION_ENABLED = "true";
});

for (const [path, method] of [["/api/chat", "DELETE"], ["/api/artifacts/file-1/versions", "GET"]]) {
  test(`Native ${method} ${path} uses the verified bearer identity and never ambient cookies`, async () => {
    const response = await resolveChatRouteSession(new Request(`http://localhost${path}`, { method,
      headers: { authorization: "Bearer opaque-fixture" } }));
    assert.equal(response.session?.user?.id, "bearer-person");
    assert.equal(cookieReads, 0); assert.equal(bearerReads, 1);
  });
  test(`Native ${method} ${path} remains off behind every existing activation switch`, async () => {
    for (const flag of ["TOMVERSE_NATIVE_CHAT_ENABLED", "TOMVERSE_NATIVE_PARITY_ENABLED", "GENERATED_ARTIFACT_REVISION_ENABLED"]) {
      process.env[flag] = "false";
      const response = await resolveChatRouteSession(new Request(`http://localhost${path}`, { method,
        headers: { authorization: "Bearer opaque-fixture" } }));
      assert.ok(response.response && response.response.status >= 400);
      assert.equal(cookieReads, 0); assert.equal(bearerReads, 0);
      process.env[flag] = "true";
    }
  });
}

test("bad Native revision credentials do not fall back to a valid cookie", async () => {
  valid = false;
  const response = await resolveChatRouteSession(new Request("http://localhost/api/chat", { method: "DELETE",
    headers: { authorization: "Bearer invalid", cookie: "next-auth.session-token=valid-cookie" } }));
  assert.equal(response.response?.status, 401); assert.equal(cookieReads, 0);
});

test("the existing web input cleanup continues to resolve its cookie identity", async () => {
  delete process.env.GENERATED_ARTIFACT_REVISION_ENABLED;
  const response = await resolveChatRouteSession(new Request("http://localhost/api/chat", { method: "DELETE" }));
  assert.equal(response.session?.user?.id, "cookie-person"); assert.equal(cookieReads, 1); assert.equal(bearerReads, 0);
});
