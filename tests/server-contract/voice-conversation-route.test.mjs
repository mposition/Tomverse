import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const mod = path => pathToFileURL(resolve(path)).href;
let w;
class SecurityError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
class BudgetError extends Error { constructor() { super("Budget reached"); this.status = 429; this.code = "VOICE_OPERATIONAL_LIMIT_REACHED"; } }
const settleCredits = async (id, seconds) => { if (w.settleError) throw new Error("Settlement unavailable"); w.refunds.push({ id, seconds }); return { credits: Math.ceil(seconds * 0.6) }; };
const reset = () => {
  process.env.VOICE_CONVERSATION_ENABLED = "true";
  process.env.VOICE_CONVERSATION_API_KEY = "test-key-never-used";
  delete process.env.VOICE_CONVERSATION_KILL_SWITCH;
  w = { user: "owner", owner: "owner", providerCalls: [], refunds: [], reserved: [], budgets: [], settlements: [], updates: [], results: [], hangs: [], creditError: false, operationalError: false, provider: "ok", socket: null };
};
mock.module("next-auth/next", { namedExports: { getServerSession: async () => w.user ? { user: { id: w.user } } : null } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/chatRouteSession.ts"), { namedExports: { resolveChatRouteSession: async () => ({ session: w.user ? { user: { id: w.user } } : null }) } });
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
  message: { findFirst: async () => ({ content: "Saved voice question" }), findMany: async () => [{ role: "assistant", content: "Existing answer" }, { role: "user", content: "Existing question" }] },
  chatCreditReservation: {
    findFirst: async ({ where }) => where.userId === w.owner ? { id: "reservation", providerRequestId: "live_test", status: "reserved", createdAt: new Date(0), expiresAt: new Date(Date.now() + 100_000), reservationPayload: { conversationId: "chat-1" } } : null,
    update: async args => { w.updates.push(args); if (w.linkError && args.data.providerRequestId) { w.linkError = false; throw new Error("Lost DB response"); } return {}; },
    updateMany: async args => { w.updates.push(args); return { count: 1 }; },
    findMany: async () => [],
  },
  chatResponseAttempt: { findFirst: async ({ where }) => { w.answerFilter = where; return w.answer === false ? null : { partialContent: "Verified stored answer with search sources" }; } },
  perplexityAsyncJob: { findFirst: async ({ where }) => { w.researchFilter = where; return w.researchAnswer ? { resultText: "Stored research answer" } : null; } },
} } });
mock.module(mod("lib/voiceConversationCredits.ts"), { namedExports: {
  reserveContinuousVoiceCredits: async input => { w.reserved.push(input); if (w.creditError) throw new SecurityError(402, "CREDIT_BALANCE_INSUFFICIENT", "Insufficient"); if (w.budgetError) throw new BudgetError(); return { id: "reservation", reservationPayload: { maxSeconds: 60, closeAt: new Date(Date.now()+30_000).toISOString() } }; },
  extendVoiceConversationCredits: async () => { if (w.renewError) throw w.renewError; w.renewals = (w.renewals ?? 0) + 1; return { maxSeconds: 60 + w.renewals * 30, closeAt: new Date(Date.now()+45_000).toISOString() }; },
  isVoiceCapacityRefusal: error => ['CREDIT_BALANCE_INSUFFICIENT', 'VOICE_OPERATIONAL_LIMIT_REACHED', 'PROVIDER_BUDGET_EXHAUSTED'].includes(error?.code),
  settleVoiceConversationCredits: settleCredits,
  readVoiceCreditPayload: value => value,
} });
mock.module(mod("lib/voiceConversationRecovery.ts"), { namedExports: {
  assertVoiceWatchdogReady: async () => { if (w.watchdogUnavailable) throw new SecurityError(503, "VOICE_RECOVERY_UNAVAILABLE", "Unavailable"); },
  finalizeVoiceReservation: settleCredits,
  recordVoiceUsage: async () => {},
  renewVoiceWebLease: async () => {},
} });
mock.module(mod("lib/voiceInputBudget.ts"), { namedExports: { VoiceBudgetError: BudgetError } });
mock.module(mod("lib/voiceConversationTasks.ts"), { namedExports: {
  registerVoiceTask: async (id, delegationId, text) => { (w.issued ??= []).push({ id, delegationId, text }); },
  queueVoiceTaskResult: async (id, input) => { if (w.taskMismatch) throw new SecurityError(403, "VOICE_RESULT_MISMATCH", "Mismatch"); w.results.push([id, input.delegationId, input.answer]); },
  dispatchVoiceTask: async () => { await w.dispatch?.(); },
} });
mock.module(mod("lib/voiceBudgetReservation.ts"), { namedExports: {
  reserveVoiceBudgets: async input => { w.budgets.push(input); if (w.budgetError) throw new BudgetError(); return { reserved: true }; },
  releaseVoiceBudgets: async () => w.settlements.push("released"),
  settleVoiceBudgets: async input => w.settlements.push(input.basis),
} });
mock.module(mod("lib/voiceConversationProvider.ts"), { namedExports: {
  createVoiceProviderSession: async (sdp, history) => { w.providerCalls.push({ sdp, history }); if (w.provider === "unknown") throw new Error("Network"); if (w.provider === "malformed-sdp") return { ok: false, rejected: false, sessionId: "live_known" }; if (w.provider === "rejected" || w.provider === "server-error") return { ok: false, rejected: w.provider === "rejected" }; return { ok: true, sessionId: "live_test", sdp: "answer" }; },
  attachVoiceProviderSession: () => { const socket = new EventEmitter(); socket.OPEN = 1; socket.readyState = 0; socket.send = value => (w.sent ??= []).push(JSON.parse(value)); socket.close = () => { socket.readyState = 3; socket.emit("close"); }; w.socket = socket; queueMicrotask(() => { socket.readyState = 1; socket.emit("open"); }); return socket; },
  hangupVoiceProviderSession: async id => { w.hangs.push(id); },
  closeVoiceProviderSession: async id => { assert.ok(w.updates.some(update => update.data.providerRequestId === id)); return w.closingSeconds ?? null; },
  sendVoiceProviderResult: async (...args) => w.results.push(args),
} });
const { POST } = await import(mod("app/api/chat/voice/route.ts"));
const request = body => new Request("http://localhost/api/chat/voice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const start = () => ({ action: "start", requestId: "91a27fea-6ceb-4c92-92e4-4fd77ac5a901", conversationId: "chat-1", sdp: "offer" });
test.beforeEach(reset);

test("malformed provider SDP is durably linked before collecting and settling final usage", async () => {
  w.provider = "malformed-sdp"; w.closingSeconds = 15;
  assert.equal((await POST(request(start()))).status, 502);
  assert.deepEqual(w.refunds, [{ id: "reservation", seconds: 15 }]);
  assert.equal(w.providerCalls.length, 1); assert.equal(w.hangs.length, 0);
});

test("sentence pauses and two queued delegations preserve both questions by audio offset", async () => {
  const response = await POST(request(start())); const text = response.text();
  const emit = event => w.socket.emit("message", JSON.stringify(event));
  try {
    emit({ type: "session.input_transcript.delta", event_id: "input-a", delta: "Tell me about", start_ms: 0, end_ms: 500 });
    emit({ type: "session.delegation.created", event_id: "task-a", offset_ms: 1600, delegation: { id: "delegation-a" } });
    await new Promise(resolve => setTimeout(resolve, 1000)); assert.equal(w.issued, undefined);
    emit({ type: "session.input_transcript.delta", event_id: "input-tail", delta: " cats.", start_ms: 600, end_ms: 1500 });
    emit({ type: "session.input_transcript.delta", event_id: "input-b", delta: "And dogs?", start_ms: 2000, end_ms: 2500 });
    emit({ type: "session.delegation.created", event_id: "task-b", offset_ms: 2600, delegation: { id: "delegation-b" } });
    await new Promise(resolve => setTimeout(resolve, 2100));
    assert.deepEqual(w.issued.map(task => [task.delegationId, task.text]), [["delegation-a", "Tell me about cats."], ["delegation-b", "And dogs?"]]);
  } finally { emit({ type: "session.closed", usage: { seconds: 4 } }); await text; }
});

test("later transcript remains available when its delegation arrives after the earlier quiet window", async () => {
  const response = await POST(request(start())); const text = response.text();
  const emit = event => w.socket.emit("message", JSON.stringify(event));
  try {
    emit({ type: "session.input_transcript.delta", event_id: "first", delta: "First question", start_ms: 0, end_ms: 1000 });
    emit({ type: "session.delegation.created", event_id: "first-task", offset_ms: 1000, delegation: { id: "first-delegation" } });
    emit({ type: "session.input_transcript.delta", event_id: "later", delta: "Later question", start_ms: 2000, end_ms: 2500 });
    await new Promise(resolve => setTimeout(resolve, 2100));
    assert.deepEqual(w.issued.map(task => task.text), ["First question"]);
    emit({ type: "session.delegation.created", event_id: "later-task", offset_ms: 2500, delegation: { id: "later-delegation" } });
    await new Promise(resolve => setTimeout(resolve, 2100));
    assert.deepEqual(w.issued.map(task => task.text), ["First question", "Later question"]);
  } finally { emit({ type: "session.closed", usage: { seconds: 5 } }); await text; }
});

test("a malformed delegation terminates with an explicit error instead of silently waiting", async () => {
  const response = await POST(request(start())); const text = response.text();
  w.socket.emit("message", JSON.stringify({ type: "session.delegation.created", delegation: { id: "missing-offset" } }));
  w.socket.emit("message", JSON.stringify({ type: "session.closed", usage: { seconds: 0 } }));
  assert.match(await text, /VOICE_DELEGATION_INVALID/); assert.equal(w.issued, undefined);
});

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
  assert.deepEqual(w.refunds.map(r => r.seconds), [0]);
  reset(); w.provider = "unknown"; assert.equal((await POST(request(start()))).status, 502);
  assert.equal(w.providerCalls.length, 1); assert.equal(w.refunds.length, 0);
  assert.equal(w.updates.at(-1).data.lastError, "VOICE_START_OUTCOME_UNKNOWN");
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
});

test("continuous renewal keeps the same provider past 900 seconds with no fixed session timeout", async t => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: Date.now() });
  const response = await POST(request(start())); const text = response.text();
  try {
    for (let n = 0; n < 32; n++) {
      t.mock.timers.tick(n ? 30_000 : 15_000);
      for (let step=0; step<10; step++) await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(w.renewals, 32); assert.equal(w.providerCalls.length, 1); assert.equal(w.sent?.length ?? 0, 0);
  } finally { w.socket.emit("message", JSON.stringify({ type: "session.closed", usage: { seconds: 950 } })); }
  const body = await text;
  assert.match(body, /"continuous":true/); assert.match(body, /"maxSeconds":null/); assert.match(body, /"confirmed":true/);
  assert.equal(w.refunds[0].seconds, 950);
});

test("exhausted funding closes within its existing exposure without another paid start", async t => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: Date.now() });
  w.renewError = new SecurityError(402, "CREDIT_BALANCE_INSUFFICIENT", "Insufficient");
  const response = await POST(request(start())); const text = response.text();
  t.mock.timers.tick(15_000); for (let n=0;n<10;n++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(w.sent?.length ?? 0, 0);
  t.mock.timers.tick(15_000); for (let n=0;n<10;n++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(w.sent, [{ type: "session.close" }]);
  w.socket.emit("message", JSON.stringify({ type: "session.closed", usage: { seconds: 30 } }));
  assert.match(await text, /"type":"limit"/); assert.equal(w.providerCalls.length, 1); assert.equal(w.refunds[0].seconds, 30);
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
  assert.deepEqual(w.results, [["reservation", "delegation-1", "Verified stored answer with search sources"]]);
  w.taskMismatch = true; assert.equal((await POST(request(result))).status, 403);
});

test("the session owner can stop after the kill switch or account block", async () => {
  process.env.VOICE_CONVERSATION_KILL_SWITCH = "stop"; w.operationalError = true;
  assert.equal((await POST(request({ action: "stop", reservationId: "reservation" }))).status, 200);
  assert.deepEqual(w.hangs, []);
  assert.equal(w.updates.at(-1).data.lastError, "VOICE_CLOSE_REQUESTED");
});

test("a persisted stop request closes without reporting a result delivery failure", async () => {
  const response = await POST(request(start())); const text = response.text();
  await POST(request({ action: "stop", reservationId: "reservation" }));
  w.dispatch = async () => {
    assert.equal(w.updates.at(-1).data.lastError, "VOICE_CLOSE_REQUESTED");
    throw new SecurityError(409, "VOICE_SESSION_ENDED", "This voice session ended.");
  };
  await new Promise(resolve => setTimeout(resolve, 650));
  w.socket.emit("message", JSON.stringify({ type: "session.closed", usage: { seconds: 5 } }));
  const body = await text;
  assert.doesNotMatch(body, /VOICE_RESULT_DELIVERY_FAILED/);
  assert.match(body, /"confirmed":true/);
  assert.deepEqual(w.sent, [{ type: "session.close" }]);
  assert.deepEqual(w.refunds.map(r => r.seconds), [5]);
});

test("a genuine result delivery failure still reports an error and stops the session", async () => {
  w.dispatch = async () => { throw new Error("Provider delivery failed"); };
  const response = await POST(request(start())); const text = response.text();
  await new Promise(resolve => setTimeout(resolve, 650));
  w.socket.emit("message", JSON.stringify({ type: "session.closed", usage: { seconds: 5 } }));
  assert.match(await text, /VOICE_RESULT_DELIVERY_FAILED/);
  assert.deepEqual(w.sent, [{ type: "session.close" }]);
  assert.deepEqual(w.refunds.map(r => r.seconds), [5]);
});

test("an in-flight delivery rejection after closing does not overwrite normal termination", async () => {
  let rejectDispatch; let started;
  const dispatchStarted = new Promise(resolve => { started = resolve; });
  w.dispatch = () => new Promise((_, reject) => { rejectDispatch = reject; started(); });
  const controller = new AbortController();
  const response = await POST(new Request("http://localhost/api/chat/voice", { method: "POST", body: JSON.stringify(start()), signal: controller.signal }));
  const text = response.text();
  await dispatchStarted;
  controller.abort();
  rejectDispatch(new Error("Delivery stopped"));
  await new Promise(resolve => setImmediate(resolve));
  w.socket.emit("message", JSON.stringify({ type: "session.closed", usage: { seconds: 5 } }));
  assert.doesNotMatch(await text, /VOICE_RESULT_DELIVERY_FAILED/);
  assert.deepEqual(w.sent, [{ type: "session.close" }]);
});

test("voice accepts a completed research answer only through its saved source-message link", async () => {
  w.answer = false; w.researchAnswer = true;
  const sourceUserMessageId = start().requestId;
  assert.equal((await POST(request({ action: "result", reservationId: "reservation", delegationId: "delegation-1", conversationId: "chat-1", sourceUserMessageId }))).status, 200);
  assert.equal(w.researchFilter.sourceUserMessageId, sourceUserMessageId);
  assert.equal(w.results[0][2], "Stored research answer");
});

test("a delegation arriving before transcript fragments is retained and sent after the fragments arrive", async () => {
  const response = await POST(request(start())); const text = response.text();
  w.socket.emit("message", JSON.stringify({ type: "session.delegation.created", event_id: "delegate-late", offset_ms: 1000, delegation: { id: "delegation-late" } }));
  w.socket.emit("message", JSON.stringify({ type: "session.input_transcript.delta", event_id: "input-late", delta: "The late question", start_ms: 0, end_ms: 1000 }));
  await new Promise(resolve => setTimeout(resolve, 2100));
  assert.deepEqual(w.issued, [{ id: "reservation", delegationId: "delegation-late", text: "The late question" }]);
  w.socket.emit("message", JSON.stringify({ type: "session.closed", usage: { seconds: 1 } }));
  assert.match(await text, /delegation-late/);
});

test("a voice budget refusal returns its actionable status and refunds the pre-dispatch credit hold", async () => {
  w.budgetError = true;
  const response = await POST(request(start()));
  assert.equal(response.status, 429);
  assert.equal((await response.json()).code, "VOICE_OPERATIONAL_LIMIT_REACHED");
  assert.equal(w.refunds.length, 0);
  assert.equal(w.providerCalls.length, 0);
});

test("indeterminate provider starts and transient link failures retain an explicit reconciliation marker", async () => {
  w.provider = "server-error";
  assert.equal((await POST(request(start()))).status, 502);
  assert.equal(w.updates.at(-1).data.lastError, "VOICE_START_OUTCOME_UNKNOWN");
  assert.equal(w.refunds.length, 0);
  reset(); w.linkError = true;
  assert.equal((await POST(request(start()))).status, 502);
  assert.deepEqual(w.updates.at(-1).data, { providerRequestId: "live_test", lastError: "VOICE_START_OUTCOME_UNKNOWN" });
  assert.deepEqual(w.hangs, ["live_test"]);
});

test("a failed final settlement leaves an explicit pending marker instead of reporting success", async () => {
  const response = await POST(request(start())); const text = response.text();
  w.settleError = true;
  w.socket.emit("message", Buffer.from(JSON.stringify({ type: "session.closed", event_id: "end-1", usage: { seconds: 10 } })));
  const body = await text;
  assert.match(body, /VOICE_SETTLEMENT_PENDING/);
  assert.doesNotMatch(body, /"confirmed":true/);
  assert.equal(w.updates.at(-1).data.lastError, "VOICE_SETTLEMENT_PENDING");
});

test("new paid sessions require a fresh independent recovery worker", async () => {
  w.watchdogUnavailable = true;
  assert.equal((await POST(request(start()))).status, 503);
  assert.equal(w.providerCalls.length, 0); assert.equal(w.reserved.length, 0);
});

test("usage status and history require the owning account even after new starts are disabled", async () => {
  delete process.env.VOICE_CONVERSATION_ENABLED;
  assert.equal((await POST(request({ action: "status", reservationId: "reservation" }))).status, 200);
  w.user = "stranger";
  assert.equal((await POST(request({ action: "status", reservationId: "reservation" }))).status, 404);
  assert.equal((await POST(request({ action: "history", conversationId: "chat-1" }))).status, 403);
});
