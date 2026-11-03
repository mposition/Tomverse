import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { nativeParityBearerRoute } from "../../lib/nativeBearerGate.ts";
import { createApiTransport } from "../../apps/mobile/src/apiTransport.ts";

const mod = path => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
process.env.TOMVERSE_NATIVE_CHAT_ENABLED = "true";
process.env.TOMVERSE_NATIVE_PARITY_ENABLED = "true";
let cookieUser = null;
let locked = false;
let timelineReads = 0;
mock.module("next-auth/next", { namedExports: { getServerSession: async () => cookieUser && ({ user: { id: cookieUser } }) } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/mobileAuthRoute.ts"), { namedExports: {
  mobileAuthRefusal: code => Response.json({ code }, { status: 401 }),
  requireMobileBearer: async request => request.headers.get("authorization") === "Bearer valid-native" ?
    { ok: true, identity: { userId: "native-owner" } } :
    { ok: false, response: Response.json({ code: "MOBILE_TOKEN_INVALID" }, { status: 401 }) },
} });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  user: { findUnique: async () => ({ id: "native-owner", accountStatus: "active" }) },
  conversation: { findFirst: async ({ where }) => where.id === "continued-chat" && where.userId === "native-owner" ? { id: where.id, password: locked ? "hash" : null } : null },
} } });
mock.module(mod("lib/conversationLock.ts"), { namedExports: {
  conversationLockedResponse: () => Response.json({ code: "CONVERSATION_LOCKED" }, { status: 423 }),
  hasConversationUnlockGrant: (_req, _owner, _id, password) => password === null,
} });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: { consumeApiRateLimit: async () => {}, apiSecurityResponse: () => null } });
mock.module(mod("lib/externalContinuationService.ts"), { namedExports: {
  getContinuationTimeline: async (userId, conversationId, input) => {
    assert.equal(userId, "native-owner");
    assert.equal(conversationId, "continued-chat");
    assert.equal(input.fromEnd, true);
    timelineReads++;
    return { provider: "chatgpt", importedAt: "2026-10-27T00:00:00Z", source: { status: "available", offset: 0, limit: 100,
      messages: [{ id: "source-question", role: "user", content: "An imported question" }] } };
  },
} });
const { GET } = await import("../../app/api/conversations/[conversationId]/continuation/route.ts");
const request = (id = "continued-chat", headers = { authorization: "Bearer valid-native" }) => new Request(`https://tomverse.app/api/conversations/${id}/continuation?offset=end`, { headers });
const read = req => GET(req, { params: Promise.resolve({ conversationId: new URL(req.url).pathname.split("/")[3] }) });

test("only the exact read-only continuation endpoint is enrolled behind native parity", () => {
  const path = "/api/conversations/continued-chat/continuation";
  assert.equal(nativeParityBearerRoute(path, "GET", true), true);
  for (const method of ["POST", "PATCH", "DELETE"]) assert.equal(nativeParityBearerRoute(path, method, true), false);
  assert.equal(nativeParityBearerRoute(path, "GET", false), false);
  assert.equal(nativeParityBearerRoute(path + "/review", "POST", true), false);
});
test("an owned native continuation loads its original without reporting session loss", async () => {
  let lost = 0;
  const transport = createApiTransport(async path => {
    if (path === "/api/conversations/continued-chat") return Response.json({ id: "continued-chat", title: "Trip plan", surface: "continuation", selectedModels: ["fixture"], messages: [] });
    return read(new Request(`https://tomverse.app${path}`, { headers: { authorization: "Bearer valid-native" } }));
  });
  transport.onSessionLost(() => lost++);
  const conversation = await transport.load("continued-chat");
  assert.equal(conversation.imported.messages[0].content, "An imported question");
  assert.equal(lost, 0);
});
test("foreign ownership and locks are refused before reading any imported words", async () => {
  const before = timelineReads;
  assert.equal((await read(request("someone-elses-chat"))).status, 404);
  locked = true;
  try { assert.equal((await read(request())).status, 423); } finally { locked = false; }
  assert.equal(timelineReads, before);
});
test("an invalid bearer never falls back to an ambient web cookie", async () => {
  cookieUser = "native-owner";
  try { assert.equal((await read(request("continued-chat", { authorization: "Bearer invalid" }))).status, 401); }
  finally { cookieUser = null; }
});
test("web sessions keep the same ownership checks and native activation stays default off", async () => {
  cookieUser = "native-owner";
  try { assert.equal((await read(request("continued-chat", {}))).status, 200); } finally { cookieUser = null; }
  process.env.TOMVERSE_NATIVE_PARITY_ENABLED = "false";
  try { assert.equal((await read(request())).status, 503); }
  finally { process.env.TOMVERSE_NATIVE_PARITY_ENABLED = "true"; }
});
