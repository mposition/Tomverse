import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
let cookies = 0;
let verifications = 0;
let valid = false;
let account: { id: string; email: string; name: string } | null = null;
mock.module("next-auth/next", { namedExports: { getServerSession: async () => { cookies++; return { user: { id: "cookie-user" } }; } } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: { user: { findUnique: async (query: { where: { id: string } }) => {
  assert.equal(query.where.id, "verified-user"); return account;
} } } } });
mock.module(mod("lib/mobileAuthRoute.ts"), { namedExports: { requireMobileBearer: async () => {
  verifications++;
  return valid ? { ok: true, identity: { userId: "verified-user" } } : { ok: false, response: Response.json({ code: "MOBILE_ACCESS_REJECTED" }, { status: 401 }) };
} } });
const require = createRequire(import.meta.url);
const { resolveChatRequestSession } = require(resolve(root, "lib/chatRequestSession.ts")) as typeof import("../../lib/chatRequestSession");

test("native chat fails closed by default and never falls back to cookies or internal headers", async () => {
  const prior = process.env.MOBILE_CHAT_ENABLED;
  const request = new Request("https://tomverse.app/api/mobile/chat", { headers: { cookie: "signed-in", "x-tomverse-user-id": "forged" } });
  try {
    delete process.env.MOBILE_CHAT_ENABLED;
    const off = await resolveChatRequestSession(request);
    assert.equal(off.ok, false);
    if (!off.ok) assert.equal(off.response.status, 503);
    assert.equal(verifications, 0); assert.equal(cookies, 0);
    process.env.MOBILE_CHAT_ENABLED = "true";
    const rejected = await resolveChatRequestSession(request);
    if (rejected.ok) assert.fail("invalid bearer accepted");
    assert.equal(rejected.response.status, 401); assert.equal(cookies, 0);
    valid = true; account = { id: "verified-user", email: "native@example.test", name: "Native" };
    const accepted = await resolveChatRequestSession(request);
    if (!accepted.ok) assert.fail("verified account refused");
    assert.equal(accepted.session?.user.id, "verified-user"); assert.equal(cookies, 0);
    account = null;
    const deleted = await resolveChatRequestSession(request);
    if (deleted.ok) assert.fail("deleted account accepted");
    assert.equal(deleted.response.status, 401);
    const web = await resolveChatRequestSession(new Request("https://tomverse.app/api/chat"));
    if (!web.ok) assert.fail("web session refused");
    assert.equal(web.session?.user.id, "cookie-user"); assert.equal(cookies, 1);
  } finally { if (prior === undefined) delete process.env.MOBILE_CHAT_ENABLED; else process.env.MOBILE_CHAT_ENABLED = prior; }
});
