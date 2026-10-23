import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { EventEmitter } from "node:events";
const mod = path => pathToFileURL(resolve(path)).href;
let w;
class SecurityError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
mock.module(mod("lib/apiSecurity.ts"), { namedExports: { ApiSecurityError: SecurityError } });
mock.module(mod("lib/voiceConversationTasks.ts"), { namedExports: { abandonVoiceDispatch: async () => Boolean(w.unknownDispatch), dispatchVoiceTask: async () => { w.dispatches = (w.dispatches ?? 0) + 1; } } });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  chatUsageBucket: { findUnique: async () => w.heartbeat ? { updatedAt: new Date(w.heartbeat) } : null, upsert: async () => { w.heartbeat = Date.now(); } },
  $executeRaw: async (parts, ...values) => {
    const sql = parts.join("");
    if (sql.includes("jsonb_build_object('token'")) {
      const [token, until, id] = values; const row = w.rows.find(row => row.id === id);
      if (!row || Date.parse(row.reservationPayload.webLeaseUntil ?? "") > Date.now() || Date.parse(row.reservationPayload.recoveryLease?.until ?? "") > Date.now()) return 0;
      row.reservationPayload.recoveryLease = { token, until }; return 1;
    }
    if (sql.includes("- 'recoveryLease'")) {
      const [id, token] = values; const row = w.rows.find(row => row.id === id);
      if (row?.reservationPayload.recoveryLease?.token === token) delete row.reservationPayload.recoveryLease;
      return 1;
    }
    const [seconds, confirmed, id] = values;
    const row = w.rows.find(row => row.id === id); const saved = row.providerUsageSnapshot;
    if (row.status !== "reserved" || saved?.confirmed || (saved?.seconds ?? 0) > seconds || seconds > row.reservationPayload.maxSeconds) return 0;
    row.providerUsageSnapshot = { seconds, confirmed }; return 1;
  },
  chatCreditReservation: {
    findMany: async () => w.rows,
    findFirst: async ({ where }) => w.rows.find(row => row.userId === where.userId && row.lastError === "VOICE_PROVIDER_STOP_PENDING") ?? null,
    findUniqueOrThrow: async ({ where }) => { if (w.finalLookupGate) await w.finalLookupGate; return w.rows.find(row => row.id === where.id); },
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
  attachVoiceProviderSession: () => { if (!w.allowReceiver) assert.fail("No sideband should be opened here"); const socket = new EventEmitter(); socket.OPEN = 1; socket.readyState = 1; socket.send = value => w.commands.push(JSON.parse(value)); socket.close = () => socket.emit("close"); w.socket = socket; return socket; },
  closeVoiceProviderSession: async id => { w.closes.push(id); return w.finalSeconds; },
  hangupVoiceProviderSession: async id => { w.hangs.push(id); if (w.hangFailure) throw new Error("Provider unreachable"); },
} });
const { assertVoiceWatchdogReady, touchVoiceWatchdog, recordVoiceUsage, finalizeVoiceReservation, reconcileVoiceConversations, observeActiveVoiceConversations, stopVoiceRecoveryReceivers } = await import(mod("lib/voiceConversationRecovery.ts"));
const row = () => ({ id: "voice-1", userId: "owner", status: "reserved", providerRequestId: "live_1", lastError: null, settledCredits: 0,
  expiresAt: new Date(Date.now() - 1_000), reservationPayload: { maxSeconds: 330, closeAt: new Date(Date.now() - 30_000).toISOString(), dispatchStartedAt: new Date().toISOString() }, providerUsageSnapshot: { seconds: 10, confirmed: false } });
test.beforeEach(() => { w = { heartbeat: 0, rows: [row()], charges: [], closes: [], hangs: [], finalSeconds: null }; });
test.afterEach(() => { stopVoiceRecoveryReceivers(); delete process.env.VOICE_CONVERSATION_KILL_SWITCH; });

test("new sessions require a fresh independent worker and no unresolved provider stop", async () => {
  await assert.rejects(assertVoiceWatchdogReady("owner"), e => e.code === "VOICE_RECOVERY_UNAVAILABLE");
  await touchVoiceWatchdog(); await assertVoiceWatchdogReady("owner");
  w.rows[0].lastError = "VOICE_PROVIDER_STOP_PENDING";
  await assert.rejects(assertVoiceWatchdogReady("owner"), e => e.status === 503);
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

test("a contradictory closing final cannot prevent grace settlement of observed usage", async () => {
  w.finalSeconds = 5;
  await reconcileVoiceConversations();
  assert.equal(w.rows[0].status, "settled"); assert.equal(w.charges[0].seconds, 10);
});

test("an uncertain provider stop blocks its account without blocking another account", async () => {
  await touchVoiceWatchdog(); w.rows[0].lastError = "VOICE_PROVIDER_STOP_PENDING";
  await assertVoiceWatchdogReady("another-owner");
  await assert.rejects(assertVoiceWatchdogReady("owner"), e => e.status === 503);
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

test("the watchdog never opens a competing sideband while the web receiver lease is healthy", async () => {
  w.rows[0].reservationPayload.webLeaseUntil = new Date(Date.now() + 30_000).toISOString();
  w.rows[0].reservationPayload.closeAt = new Date(Date.now() + 300_000).toISOString();
  await observeActiveVoiceConversations(); await reconcileVoiceConversations();
  assert.equal(w.closes.length, 0); assert.equal(w.charges.length, 0);
});

test("a kill switch closes an already attached independent receiver on the next cycle", async () => {
  w.allowReceiver = true; w.commands = []; w.rows[0].expiresAt = new Date(Date.now() + 300_000);
  w.rows[0].reservationPayload.closeAt = new Date(Date.now() + 200_000).toISOString();
  await observeActiveVoiceConversations();
  process.env.VOICE_CONVERSATION_KILL_SWITCH = "stop";
  await observeActiveVoiceConversations();
  assert.deepEqual(w.commands, [{ type: "session.close" }]);
});

test("an unknown dispatched answer closes recovery without replaying the append", async () => {
  w.allowReceiver = true; w.unknownDispatch = true; w.commands = [];
  w.rows[0].expiresAt = new Date(Date.now() + 300000); w.rows[0].reservationPayload.closeAt = new Date(Date.now() + 200000).toISOString();
  await observeActiveVoiceConversations(); w.socket.emit("open");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(w.commands, [{ type: "session.close" }]); assert.equal(w.dispatches, undefined);
});

test("socket errors and expiry retain ownership until an observed final receipt commits", async () => {
  w.allowReceiver = true; w.commands = []; let releaseFinal;
  w.finalLookupGate = new Promise(resolve => { releaseFinal = resolve; });
  w.rows[0].expiresAt = new Date(Date.now() + 40); w.rows[0].reservationPayload.closeAt = new Date(Date.now() + 200000).toISOString();
  await observeActiveVoiceConversations();
  w.socket.emit("message", JSON.stringify({ type: "session.closed", usage: { seconds: 15 } }));
  try {
    w.socket.emit("error", new Error("Connection closed after final receipt")); w.socket.emit("close");
    await new Promise(resolve => setTimeout(resolve, 65));
    assert.ok(w.rows[0].reservationPayload.recoveryLease); assert.equal(w.charges.length, 0); assert.equal(w.hangs.length, 0);
  } finally { releaseFinal(); }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(w.charges.length, 1); assert.equal(w.charges[0].seconds, 15);
});

test("a finalization that never returns releases ownership so grace settlement can finish without restarting", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  w.allowReceiver = true; w.commands = []; w.finalLookupGate = new Promise(() => {});
  w.rows[0].expiresAt = new Date(Date.now() + 40); w.rows[0].reservationPayload.closeAt = new Date(Date.now() + 200000).toISOString();
  try {
    await observeActiveVoiceConversations();
    w.socket.emit("message", JSON.stringify({ type: "session.closed", usage: { seconds: 15 } }));
    mock.timers.tick(10000); await new Promise(resolve => setImmediate(resolve));
    assert.ok(w.rows[0].reservationPayload.recoveryLease); assert.equal(w.charges.length, 0);
    mock.timers.tick(5001); await new Promise(resolve => setImmediate(resolve));
    assert.equal(w.rows[0].reservationPayload.recoveryLease, undefined);
    w.rows[0].expiresAt = new Date(Date.now() - 1);
    await reconcileVoiceConversations();
    assert.equal(w.rows[0].status, "settled"); assert.equal(w.charges.length, 1);
    assert.equal(w.charges[0].evidence, "observed_minimum"); assert.equal(w.charges[0].seconds, 10);
  } finally { mock.timers.reset(); }
});
