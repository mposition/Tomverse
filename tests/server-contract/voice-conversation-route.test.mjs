import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const mod = path => pathToFileURL(resolve(path)).href;
let w;
class SecurityError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const reset = () => {
  process.env.VOICE_CONVERSATION_ENABLED = "true";
  process.env.VOICE_CONVERSATION_API_KEY = "test-key-never-used";
  delete process.env.VOICE_CONVERSATION_KILL_SWITCH;
  w = { user: "owner", owner: "owner", providerCalls: [], refunds: [], reserved: [], budgets: [], settlements: [], updates: [], results: [], hangs: [], creditError: false, operationalError: false, provider: "ok", socket: null };
};
mock.module("next-auth/next", { namedExports: { getServerSession: async () => w.user ? { user: { id: w.user } } : null } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  ApiSecurityError: SecurityError, consumeApiRateLimit: async () => {},
  apiSecurityResponse: error => error instanceof SecurityError ? Response.json({ code: error.code }, { status: error.status }) : null,
  readLimitedJson: async (request, _limit, schema) => { const p = schema.safeParse(await request.json()); if (!p.success) throw new SecurityError(400, "INVALID_BODY", "Invalid body"); return p.data; },
} });
mock.module(mod("lib/chatSecurity.ts"), { namedExports: {
  assertUserOperationalAccess: async () => { if (w.operationalError) throw new SecurityError(403, "ACCOUNT_BLOCKED", "Blocked"); }, getUserChatUsageKey: user => `user:${user}`,
} });
mock.module(mod("lib/conversationLock.ts"), { namedExports: { hasConversationUnlockGrant: () => !w.locked } });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  conversation: { findFirst: async ({ where }) => where.userId === w.owner ? { id: where.id, productKey: "chat", password: null } : null },
  message: { findMany: async () => [{ role: "assistant", content: "Existing answer" }, { role: "user", content: "Existing question" }] },
  chatCreditReservation: {
    findFirst: async ({ where }) => where.userId === w.owner ? { id: "reservation", providerRequestId: "live_test", status: "reserved", createdAt: new Date(0), expiresAt: new Date(Date.now() + 100_000), reservationPayload: { conversationId: "chat-1" } } : null,
    update: async args => { w.updates.push(args); return {}; },
  },
  chatResponseAttempt: { findFirst: async ({ where }) => { w.answerFilter = where; return w.answer === false ? null : { partialContent: "Verified stored answer with search sources" }; } },
} } });
mock.module(mod("lib/voiceConversationCredits.ts"), { namedExports: {
  reserveVoiceConversationCredits: async input => { w.reserved.push(input); if (w.creditError) throw new SecurityError(402, "CREDIT_BALANCE_INSUFFICIENT", "Insufficient"); return { id: "reservation" }; },
  settleVoiceConversationCredits: async (id, seconds) => { w.refunds.push({ id, seconds }); return { credits: Math.ceil(seconds * 0.6) }; },
  readVoiceCreditPayload: value => value,
} });
mock.module(mod("lib/voiceBudgetReservation.ts"), { namedExports: {
  reserveVoiceBudgets: async input => { w.budgets.push(input); return { reserved: true }; },
  releaseVoiceBudgets: async () => w.settlements.push("released"),
  settleVoiceBudgets: async input => w.settlements.push(input.basis),
} });
mock.module(mod("lib/voiceConversationProvider.ts"), { namedExports: {
  createVoiceProviderSession: async (sdp, history) => { w.providerCalls.push({ sdp, history }); if (w.provider === "unknown") throw new Error("Network"); if (w.provider === "rejected") return { ok: false, rejected: true }; return { ok: true, sessionId: "live_test", sdp: "answer" }; },
  attachVoiceProviderSession: () => { const socket = new EventEmitter(); socket.OPEN = 1; socket.readyState = 0; socket.send = () => {}; socket.close = () => { socket.readyState = 3; socket.emit("close"); }; w.socket = socket; queueMicrotask(() => { socket.readyState = 1; socket.emit("open"); }); return socket; },
  hangupVoiceProviderSession: async id => { w.hangs.push(id); },
  sendVoiceProviderResult: async (...args) => w.results.push(args),
} });
const { POST } = await import(mod("app/api/chat/voice/route.ts"));
const request = body => new Request("http://localhost/api/chat/voice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const start = () => ({ action: "start", requestId: "91a27fea-6ceb-4c92-92e4-4fd77ac5a901", conversationId: "chat-1", sdp: "offer" });
test.beforeEach(reset);

test("disabled, unauthenticated, foreign and locked starts never call a paid provider", async () => {
  delete process.env.VOICE_CONVERSATION_ENABLED; assert.equal((await POST(request(start()))).status, 503);
  process.env.VOICE_CONVERSATION_ENABLED = "true"; w.user = null; assert.equal((await POST(request(start()))).status, 401);
  w.user = "stranger"; assert.equal((await POST(request(start()))).status, 403);
  w.user = "owner"; w.locked = true; assert.equal((await POST(request(start()))).status, 423);
  assert.equal(w.providerCalls.length, 0); assert.equal(w.reserved.length, 0);
});

test("insufficient credits prevents provider initialization", async () => {
  w.creditError = true; assert.equal((await POST(request(start()))).status, 402);
  assert.equal(w.providerCalls.length, 0);
});

test("known refusal refunds the hold, but an unknown start does not retry or invent zero usage", async () => {
  w.provider = "rejected"; assert.equal((await POST(request(start()))).status, 502);
  assert.deepEqual(w.refunds.map(r => r.seconds), [0]); assert.deepEqual(w.settlements, ["released"]);
  reset(); w.provider = "unknown"; assert.equal((await POST(request(start()))).status, 502);
  assert.equal(w.providerCalls.length, 1); assert.equal(w.refunds.length, 0);
  assert.equal(w.updates[0].data.lastError, "VOICE_START_OUTCOME_UNKNOWN");
});

test("trusted provider final duration settles once and existing Chat history seeds the session", async () => {
  const response = await POST(request(start()));
  assert.equal(response.status, 200);
  assert.deepEqual(w.providerCalls[0].history.map(m => m.content), ["Existing question", "Existing answer"]);
  const text = response.text();
  w.socket.emit("message", Buffer.from(JSON.stringify({ type: "session.usage.updated", event_id: "usage-1", usage: { seconds: 10 } })));
  w.socket.emit("message", Buffer.from(JSON.stringify({ type: "session.closed", event_id: "end-1", usage: { seconds: 10 } })));
  const body = await text;
  assert.match(body, /"confirmed":true/); assert.match(body, /"credits":6/);
  assert.deepEqual(w.refunds.map(r => r.seconds), [10]);
  assert.deepEqual(w.settlements, [{ kind: "provider_seconds", seconds: 15 }]);
});

test("lost connection retains an unconfirmed reservation and requests hangup", async () => {
  const response = await POST(request(start())); const text = response.text();
  w.socket.emit("close"); assert.match(await text, /"confirmed":false/);
  assert.equal(w.refunds.length, 0); assert.deepEqual(w.hangs, ["live_test"]);
  assert.equal(w.updates.at(-1).data.lastError, "VOICE_FINAL_USAGE_UNCONFIRMED");
});

test("only owned saved answers are forwarded and browser-supplied content is refused", async () => {
  const result = { action: "result", reservationId: "reservation", delegationId: "delegation-1", conversationId: "chat-1", sourceUserMessageId: start().requestId };
  assert.equal((await POST(request({ ...result, content: "Untrusted answer" }))).status, 400);
  w.user = "stranger"; assert.equal((await POST(request(result))).status, 404);
  w.user = "owner"; w.answer = false; assert.equal((await POST(request(result))).status, 409);
  w.answer = true; assert.equal((await POST(request(result))).status, 200);
  assert.equal(w.answerFilter.sourceUserMessageId, result.sourceUserMessageId);
  assert.equal(w.answerFilter.userId, "owner");
  assert.equal(w.answerFilter.conversationId, "chat-1");
  assert.deepEqual(w.results, [["live_test", "delegation-1", "Verified stored answer with search sources"]]);
});

test("the session owner can stop after the kill switch or account block", async () => {
  process.env.VOICE_CONVERSATION_KILL_SWITCH = "stop"; w.operationalError = true;
  assert.equal((await POST(request({ action: "stop", reservationId: "reservation" }))).status, 200);
  assert.deepEqual(w.hangs, ["live_test"]);
});
