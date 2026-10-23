import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const mod = path => pathToFileURL(resolve(path)).href;
let w;
class SecurityError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
mock.module(mod("lib/apiSecurity.ts"), { namedExports: { ApiSecurityError: SecurityError } });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  chatUsageBucket: { findUnique: async () => w.heartbeat ? { updatedAt: new Date(w.heartbeat) } : null, upsert: async () => { w.heartbeat = Date.now(); } },
  $executeRaw: async (_parts, seconds, confirmed, id) => {
    const row = w.rows.find(row => row.id === id); const saved = row.providerUsageSnapshot;
    if (row.status !== "reserved" || saved?.confirmed || (saved?.seconds ?? 0) > seconds) return 0;
    row.providerUsageSnapshot = { seconds, confirmed }; return 1;
  },
  chatCreditReservation: {
    findMany: async () => w.rows,
    findFirst: async () => w.rows.find(row => row.lastError === "VOICE_PROVIDER_STOP_PENDING") ?? null,
    findUniqueOrThrow: async ({ where }) => w.rows.find(row => row.id === where.id),
    updateMany: async ({ where, data }) => { const row = w.rows.find(row => row.id === where.id && (!where.status || row.status === where.status) && (!where.lastError || row.lastError === where.lastError)); if (row) Object.assign(row, data); return { count: row ? 1 : 0 }; },
  },
} } });
mock.module(mod("lib/voiceConversationCredits.ts"), { namedExports: {
  readVoiceCreditPayload: p => p,
  settleVoiceConversationCredits: async (id, seconds, initialized, evidence = "final", stopped = true) => {
    const row = w.rows.find(row => row.id === id); if (row.status === "settled") return null;
    w.charges.push({ seconds, initialized, evidence, stopped }); row.status = "settled"; row.settledCredits = Math.ceil(seconds * .6);
    row.lastError = stopped ? null : "VOICE_PROVIDER_STOP_PENDING";
    return { credits: row.settledCredits };
  },
} });
mock.module(mod("lib/voiceConversationProvider.ts"), { namedExports: {
  attachVoiceProviderSession: () => { assert.fail("No new session should be created by the reconciliation sweep"); },
  closeVoiceProviderSession: async id => { w.closes.push(id); return w.finalSeconds; },
  hangupVoiceProviderSession: async id => { w.hangs.push(id); if (w.hangFailure) throw new Error("Provider unreachable"); },
} });
const { assertVoiceWatchdogReady, touchVoiceWatchdog, recordVoiceUsage, finalizeVoiceReservation, reconcileVoiceConversations } = await import(mod("lib/voiceConversationRecovery.ts"));
const row = () => ({ id: "voice-1", status: "reserved", providerRequestId: "live_1", lastError: null, settledCredits: 0,
  expiresAt: new Date(Date.now() - 1_000), reservationPayload: { maxSeconds: 330, closeAt: new Date(Date.now() - 30_000).toISOString(), dispatchStartedAt: new Date().toISOString() }, providerUsageSnapshot: { seconds: 10, confirmed: false } });
test.beforeEach(() => { w = { heartbeat: 0, rows: [row()], charges: [], closes: [], hangs: [], finalSeconds: null }; });

test("new sessions require a fresh independent worker and no unresolved provider stop", async () => {
  await assert.rejects(assertVoiceWatchdogReady(), e => e.code === "VOICE_RECOVERY_UNAVAILABLE");
  await touchVoiceWatchdog(); await assertVoiceWatchdogReady();
  w.rows[0].lastError = "VOICE_PROVIDER_STOP_PENDING";
  await assert.rejects(assertVoiceWatchdogReady(), e => e.status === 503);
});
test("durable usage is monotonic and final receipts survive late interim events", async () => {
  await recordVoiceUsage("voice-1", 12); await recordVoiceUsage("voice-1", 11);
  assert.equal(w.rows[0].providerUsageSnapshot.seconds, 12);
  await recordVoiceUsage("voice-1", 15, true); await recordVoiceUsage("voice-1", 20);
  assert.deepEqual(w.rows[0].providerUsageSnapshot, { seconds: 15, confirmed: true });
});
test("restart reconciliation settles a persisted final receipt without contacting the provider twice", async () => {
  w.rows[0].providerUsageSnapshot = { seconds: 12, confirmed: true };
  await reconcileVoiceConversations(); await reconcileVoiceConversations();
  assert.equal(w.charges.length, 1); assert.equal(w.charges[0].seconds, 12); assert.equal(w.closes.length, 0);
});
test("an expired session is reattached and settled from a late trusted final event", async () => {
  w.finalSeconds = 15;
  assert.equal((await reconcileVoiceConversations()).settled, 1);
  assert.deepEqual(w.closes, ["live_1"]); assert.equal(w.charges[0].seconds, 15);
});
test("missing final usage charges only the observed minimum and preserves a failed hangup for retry", async () => {
  w.hangFailure = true;
  await reconcileVoiceConversations();
  assert.deepEqual(w.charges, [{ seconds: 10, initialized: true, evidence: "observed_minimum", stopped: false }]);
  assert.equal(w.rows[0].lastError, "VOICE_PROVIDER_STOP_PENDING");
  w.hangFailure = false; await reconcileVoiceConversations();
  assert.equal(w.charges.length, 1); assert.notEqual(w.rows[0].lastError, "VOICE_PROVIDER_STOP_PENDING");
});
test("a provider-unknown start never invents usage or retries paid creation", async () => {
  w.rows[0].providerRequestId = null; w.rows[0].providerUsageSnapshot = null;
  await reconcileVoiceConversations();
  assert.equal(w.charges[0].seconds, 0); assert.equal(w.charges[0].stopped, false);
});
test("a final duration below durable observed usage is refused", async () => {
  await assert.rejects(finalizeVoiceReservation("voice-1", 5), /inconsistent/);
  assert.equal(w.charges.length, 0);
});

test("an excessive final never poisons durable evidence or prevents expired-hold recovery", async () => {
  await assert.rejects(finalizeVoiceReservation("voice-1", 331), /authorized reservation/);
  assert.deepEqual(w.rows[0].providerUsageSnapshot, { seconds: 10, confirmed: false });
  await reconcileVoiceConversations();
  assert.equal(w.charges[0].seconds, 10);
  assert.equal(w.rows[0].status, "settled");
});

test("a previously persisted invalid final cannot retain a customer hold indefinitely", async () => {
  w.rows[0].providerUsageSnapshot = { seconds: 400, confirmed: true };
  await reconcileVoiceConversations();
  assert.equal(w.rows[0].status, "settled");
  assert.equal(w.charges[0].seconds, 0);
});
