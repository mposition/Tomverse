import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const mod = path => pathToFileURL(resolve(path)).href;
let w;
class SecurityError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const tx = {
  $executeRaw: async (parts, ...values) => { if (parts.join("").startsWith('UPDATE "ChatUsageBucket"')) { w.buckets[values[2]] -= values[0]; w.refundedPeriods.push({ amount: values[0], period: values[2], start: values[3].toISOString() }); } return 1; },
  creditLot: { aggregate: async () => ({ _sum: { remainingCredits: w.purchased } }) },
  chatCreditReservation: {
    findUnique: async ({ where }) => w.row && (w.row.idempotencyKey === where.idempotencyKey || w.row.id === where.id) ? w.row : null,
    findUniqueOrThrow: async () => w.row,
    create: async ({ data }) => { w.row = { ...data, createdAt: new Date(), lastError: null, settledCredits: 0 }; return w.row; },
    updateMany: async ({ where, data }) => { if (w.row?.status !== where.status) return { count: 0 }; for (const [key,value] of Object.entries(data)) w.row[key] = value && typeof value === 'object' && 'increment' in value ? w.row[key] + value.increment : value; return { count: 1 }; },
    update: async ({ data }) => { Object.assign(w.row, data); return w.row; },
  },
};
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: { $transaction: async callback => {
  const { onWalletLock, onFunding, ...data } = w;
  const snapshot = { ...structuredClone(data), onWalletLock, onFunding }; try { return await callback(tx); } catch (error) { w = snapshot; throw error; }
} } } });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: { ApiSecurityError: SecurityError } });
mock.module(mod("lib/providerCostBudget.ts"), { namedExports: { getProviderCostGuardrailLimits: () => ({ day: 1000000, month: 10000000 }) } });
mock.module(mod("lib/billingEntitlements.ts"), { namedExports: { getUserBillingPlan: async () => ({ monthlyMessageLimit: w.monthlyLimit ?? 300, dailyMessageLimit: w.dailyLimit }) } });
mock.module(mod("lib/chatSecurity.ts"), { namedExports: {
  getUserChatUsageKey: id => `user:${id}`, usagePeriodStart: (period, now = new Date()) => new Date(period === 'month' ? Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1) : Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate())),
  readUsageBucketCount: async (_tx, _key, period) => w.buckets[period],
  incrementUsageBucket: async (_tx, _key, period, _start, limit, amount) => { if (period.startsWith("provider-cost") && w.providerBudgetBlocked || w.buckets[period] + amount > limit) return false; w.buckets[period] += amount; return true; },
} });
mock.module(mod("lib/userDailyUsage.ts"), { namedExports: { getUserDayWindow: async (_tx, _userId, now = new Date()) => ({ start: new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate())), end: new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1)) }) } });
mock.module(mod("lib/creditDebt.ts"), { namedExports: { lockCreditAccount: async () => { await w.onWalletLock?.(); }, offsetCreditDebt: async () => ({ offsetCredits: w.debt ?? 0 }) } });
mock.module(mod("lib/creditLedger.ts"), { namedExports: {
  reserveAddOnCredits: async (_tx, input) => { w.addOnReserved += input.credits; w.purchased -= input.credits; return [{ lotId: "lot", purchaseId: "purchase", credits: input.credits, fundedCostMicroUsd: input.fundedCostMicroUsd }]; },
  settleAddOnCredits: async (_tx, input) => { w.addOnSettlements.push(input); },
} });
mock.module(mod("lib/providerUsageAccounting.ts"), { namedExports: { recordInternalProviderUsage: async input => { w.providerCosts.push(input.estimatedCostMicroUsd); } } });
mock.module(mod("lib/voiceBudgetReservation.ts"), { namedExports: {
  reserveVoiceBudgets: async ({ subjectKey, seconds, client }) => {
    assert.equal(client, tx);
    await w.onFunding?.();
    if ((w.voiceHeld ?? 0) + seconds > (w.voiceLimit ?? Infinity)) throw new SecurityError(429, 'VOICE_OPERATIONAL_LIMIT_REACHED', 'Daily voice time exhausted');
    w.voiceHeld = (w.voiceHeld ?? 0) + seconds;
    if (w.budgetError) throw new Error("Provider budget exhausted");
    return { subject: { subjectKey, reservedSeconds: seconds, periodStart: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())), settled: false },
      provider: { reservedSeconds: seconds, settled: false, bookings: ["day", "month"].map(period => ({ period, seconds, periodStart: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())) })) } };
  },
  settleVoiceBudgets: async input => { assert.equal(input.client, tx); (w.voiceSettlements ??= []).push(input.basis); },
} });
const { reserveVoiceConversationCredits, reserveContinuousVoiceCredits, extendVoiceConversationCredits, settleVoiceConversationCredits, readVoiceCreditPayload } = await import(mod("lib/voiceConversationCredits.ts"));
test.beforeEach(() => { w = { buckets: { day: 0, month: 0, "provider-cost-day": 0, "provider-cost-month": 0 }, purchased: 0, dailyLimit: 300, row: null, addOnReserved: 0, addOnSettlements: [], providerCosts: [], refundedPeriods: [] }; });
const input = () => ({ userId: "owner", requestId: "request-1", conversationId: "chat-1", creditsPerMinute: 36, maxSeconds: 60 });

test("voice spends the same plan wallet and refunds unused duration exactly once", async () => {
  const row = await reserveVoiceConversationCredits(input());
  assert.equal(w.buckets.day, 36); assert.equal(w.buckets.month, 36);
  assert.equal(row.source, "voice_conversation");
  await settleVoiceConversationCredits(row.id, 10);
  assert.equal(w.buckets.day, 6); assert.equal(w.buckets.month, 6);
  assert.equal(w.row.settledCredits, 6); assert.equal(w.row.status, "settled");
  assert.equal(await settleVoiceConversationCredits(row.id, 10), null);
  assert.equal(w.providerCosts.length, 1); assert.equal(w.buckets.month, 6);
});

test("plan credits are consumed first and unused purchased credits are returned", async () => {
  w.buckets.day = w.buckets.month = 290; w.purchased = 100;
  const row = await reserveVoiceConversationCredits(input());
  assert.equal(row.planReservedCredits, 10); assert.equal(row.addOnReservedCredits, 26);
  await settleVoiceConversationCredits(row.id, 10);
  assert.equal(w.buckets.month, 296); assert.equal(w.addOnSettlements[0].settledCredits, 0);
});

test("an unlimited daily plan never refunds a daily bucket it did not reserve", async () => {
  w.dailyLimit = 0; w.buckets.day = 50;
  const row = await reserveVoiceConversationCredits(input());
  await settleVoiceConversationCredits(row.id, 10);
  assert.equal(w.buckets.day, 50); assert.equal(w.buckets.month, 6);
});

test("duplicate start identities and insufficient balances cannot create another hold", async () => {
  await reserveVoiceConversationCredits(input());
  await assert.rejects(reserveVoiceConversationCredits(input()), error => error.code === "VOICE_START_ALREADY_ATTEMPTED");
  assert.equal(w.buckets.month, 36);
  w.buckets.day = w.buckets.month = 299;
  await assert.rejects(reserveVoiceConversationCredits({ ...input(), requestId: "request-2" }), error => error.code === "CREDIT_BALANCE_INSUFFICIENT");
  assert.equal(w.buckets.month, 299);
});

test("a proven pre-dispatch refusal releases all credits; excess or malformed usage cannot settle", async () => {
  const row = await reserveVoiceConversationCredits(input());
  await assert.rejects(settleVoiceConversationCredits(row.id, 61));
  assert.equal(w.row.status, "reserved");
  await assert.rejects(settleVoiceConversationCredits(row.id, NaN));
  assert.equal(w.row.status, "reserved");
  await settleVoiceConversationCredits(row.id, 0);
  assert.equal(w.buckets.month, 0); assert.equal(w.providerCosts.length, 0);
});

test("provider initialization is counted once without inflating the user's active seconds", async () => {
  const row = await reserveVoiceConversationCredits(input());
  await settleVoiceConversationCredits(row.id, 10, true);
  assert.equal(w.row.settledCredits, 6);
  assert.equal(w.row.settledCostMicroUsd, 12_500n);
  assert.deepEqual(w.providerCosts, [12_500]);
});

test("settlement refunds only voice's hold and preserves the existing monthly debt offset", async () => {
  w.debt = 20;
  const row = await reserveVoiceConversationCredits(input());
  assert.equal(w.buckets.month, 56);
  await settleVoiceConversationCredits(row.id, 0);
  assert.equal(w.buckets.month, 20);
  assert.equal(w.buckets.day, 0);
});

test("budget refusal rolls the wallet reservation back in the same transaction", async () => {
  w.budgetError = true;
  await assert.rejects(reserveVoiceConversationCredits(input()), /budget exhausted/);
  assert.equal(w.buckets.month, 0); assert.equal(w.row, null);
});

test("incomplete finalization bills only observed seconds and retains conservative provider exposure once", async () => {
  const row = await reserveVoiceConversationCredits(input());
  w.row.providerUsageSnapshot = { seconds: 10, confirmed: false };
  await settleVoiceConversationCredits(row.id, 10, true, "observed_minimum");
  assert.equal(w.row.settledCredits, 6);
  assert.equal(w.buckets.month, 6);
  assert.equal(w.row.providerUsageSnapshot.confirmed, false);
  assert.equal(w.row.providerUsageSnapshot.providerCostEstimated, true);
  assert.deepEqual(w.voiceSettlements, [{ kind: "reservation" }]);
  await settleVoiceConversationCredits(row.id, 10, true, "observed_minimum");
  assert.equal(w.voiceSettlements.length, 1);
});

test("grace settlement uses the latest durable evidence after its atomic claim", async () => {
  const row = await reserveVoiceConversationCredits(input());
  w.row.providerUsageSnapshot = { seconds: 20, confirmed: true };
  await settleVoiceConversationCredits(row.id, 5, true, "observed_minimum", false);
  assert.equal(w.row.settledCredits, 12); assert.equal(w.row.providerUsageSnapshot.confirmed, true);
  assert.equal(w.row.providerUsageSnapshot.seconds, 20); assert.equal(w.row.lastError, null);
});

test("voice shares OpenAI cost buckets and a refusal rolls back the wallet", async () => {
  w.providerBudgetBlocked = true;
  await assert.rejects(reserveVoiceConversationCredits(input()), e => e.code === "PROVIDER_BUDGET_EXHAUSTED");
  assert.equal(w.buckets.month, 0); assert.equal(w.row, null);
  w.providerBudgetBlocked = false; const row = await reserveVoiceConversationCredits(input());
  assert.equal(w.buckets["provider-cost-day"], 50000);
  await settleVoiceConversationCredits(row.id, 10, true);
  assert.equal(w.buckets["provider-cost-day"], 12500); assert.equal(w.buckets["provider-cost-month"], 12500);
});

const continuousInput = () => ({ userId: "owner", requestId: "rolling-1", conversationId: "chat-1", creditsPerMinute: 36 });
const lease = () => { w.row.reservationPayload.webLeaseUntil = new Date(Date.now() + 30_000).toISOString(); };

test("wallet-lock and funding delays do not consume the initial or renewed session window", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  w.onWalletLock = () => { t.mock.timers.tick(20_000); };
  w.onFunding = () => { t.mock.timers.tick(20_000); };
  const row = await reserveContinuousVoiceCredits(continuousInput());
  assert.equal(Date.parse(row.reservationPayload.closeAt) - Date.now(), 30_000);
  assert.equal(row.createdAt.getTime(), Date.now());
  delete w.onWalletLock; delete w.onFunding;
  t.mock.timers.tick(15_000); lease();
  const renewed = await extendVoiceConversationCredits(row.id, "owner");
  assert.equal(Date.parse(renewed.closeAt) - Date.now(), 45_000);
});

test("nullable purchase references remain settleable and malformed references are refused", async () => {
  w.monthlyLimit = w.dailyLimit = 10; w.purchased = 100;
  const row = await reserveContinuousVoiceCredits(continuousInput());
  row.reservationPayload.funding[0].addOnEntries[0].purchaseId = null;
  assert.equal(readVoiceCreditPayload(row.reservationPayload).funding[0].addOnEntries[0].purchaseId, null);
  const invalid = structuredClone(row.reservationPayload);
  invalid.funding[0].addOnEntries[0].purchaseId = 0;
  assert.throws(() => readVoiceCreditPayload(invalid), /Invalid voice funding/);
  await settleVoiceConversationCredits(row.id, 5, true);
  assert.equal(w.row.status, "settled"); assert.equal(w.row.settledCredits, 3);
  assert.equal(w.addOnSettlements[0].entries[0].purchaseId, null);
});

test("one continuously funded session passes 900 seconds with cumulative rounding and one settlement", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  w.monthlyLimit = w.dailyLimit = 10_000;
  const row = await reserveContinuousVoiceCredits(continuousInput()); lease();
  assert.equal(row.reservedCredits, 36); assert.equal(row.reservationPayload.maxSeconds, 60);
  for (let n = 0; n < 32; n++) {
    t.mock.timers.tick(n ? 30_000 : 15_000); lease();
    await extendVoiceConversationCredits(row.id, "owner");
  }
  assert.equal(w.row.reservationPayload.maxSeconds, 1020);
  assert.equal(w.row.reservationPayload.funding.length, 1);
  assert.equal(w.row.reservedCredits, 612); assert.equal(w.row.reservedCostMicroUsd, 850_000n);
  await settleVoiceConversationCredits(row.id, 961.25, true);
  assert.equal(w.row.settledCredits, 577); assert.equal(w.buckets.month, 577);
  assert.equal(w.row.settledCostMicroUsd, 801_042n);
  assert.equal(await settleVoiceConversationCredits(row.id, 961.25, true), null);
});

test("renewal is idempotent while funded and cannot revive expired, closing, recovered or foreign sessions", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const row = await reserveContinuousVoiceCredits(continuousInput()); lease();
  await extendVoiceConversationCredits(row.id, "owner");
  assert.equal(w.row.reservedCredits, 36);
  t.mock.timers.tick(15_000); lease();
  await extendVoiceConversationCredits(row.id, "owner");
  await extendVoiceConversationCredits(row.id, "owner");
  assert.equal(w.row.reservedCredits, 54);
  const snapshot = structuredClone(w);
  for (const change of [() => { w.row.lastError = "VOICE_CLOSE_REQUESTED"; }, () => { w.row.status = "settled"; }, () => { w.row.reservationPayload.recoveryLease = { until: new Date(Date.now()+30_000).toISOString() }; }, () => { w.row.reservationPayload.closeAt = new Date(Date.now()).toISOString(); }]) {
    w = structuredClone(snapshot); change();
    await assert.rejects(extendVoiceConversationCredits(row.id, "owner"), e => e.code === "VOICE_SESSION_ENDED");
    assert.equal(w.row.reservedCredits, 54);
  }
  w = snapshot;
  await assert.rejects(extendVoiceConversationCredits(row.id, "foreign"), e => e.code === "VOICE_SESSION_ENDED");
});

test("small available balances can start without reserving the entire old session maximum", async () => {
  w.monthlyLimit = 33; w.dailyLimit = 33;
  const row = await reserveContinuousVoiceCredits(continuousInput());
  assert.equal(row.reservedCredits, 33); assert.equal(row.reservationPayload.maxSeconds, 55);
  await settleVoiceConversationCredits(row.id, 10, true);
  assert.equal(w.buckets.month, 6); assert.equal(w.providerCosts[0], 12_500);
});

test("a balance without viable startup headroom is refused without retaining any hold", async () => {
  w.monthlyLimit = w.dailyLimit = 32;
  await assert.rejects(reserveContinuousVoiceCredits(continuousInput()), e => e.code === "CREDIT_BALANCE_INSUFFICIENT");
  assert.equal(w.row, null); assert.equal(w.buckets.month, 0); assert.equal(w.voiceHeld ?? 0, 0);
});

for (const limit of ["wallet", "daily", "voice", "provider"]) test(`${limit} exhaustion refuses additional funding without losing the existing hold`, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const row = await reserveContinuousVoiceCredits(continuousInput());
  t.mock.timers.tick(15_000); lease();
  if (limit === "wallet") w.monthlyLimit = 36;
  if (limit === "daily") w.dailyLimit = 36;
  if (limit === "voice") w.voiceLimit = 60;
  if (limit === "provider") w.providerBudgetBlocked = true;
  await assert.rejects(extendVoiceConversationCredits(row.id, "owner"), e => /INSUFFICIENT|LIMIT|BUDGET/.test(e.code));
  assert.equal(w.row.reservedCredits, 36); assert.equal(w.row.reservationPayload.maxSeconds, 60);
  assert.equal(w.buckets.month, 36);
  await settleVoiceConversationCredits(row.id, 29, true);
  assert.equal(w.row.settledCredits, 18); assert.equal(w.buckets.month, 18);
});

test("purchased credits still fund renewals after the plan daily guardrail is exhausted", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const row = await reserveContinuousVoiceCredits(continuousInput());
  w.dailyLimit = 36; w.purchased = 20;
  t.mock.timers.tick(15_000); lease();
  await extendVoiceConversationCredits(row.id, "owner");
  assert.equal(w.row.reservedCredits, 54); assert.equal(w.row.addOnReservedCredits, 18);
  assert.equal(w.buckets.day, 36); assert.equal(w.purchased, 2);
  await settleVoiceConversationCredits(row.id, 65, true);
  assert.equal(w.row.settledCredits, 39); assert.equal(w.addOnSettlements[0].settledCredits, 3);
});

test("small purchased-credit renewals fund both time and cost allowance and never issue free deltas", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  w.monthlyLimit = w.dailyLimit = 36; w.purchased = 3;
  const row = await reserveContinuousVoiceCredits(continuousInput());
  t.mock.timers.tick(15_000); lease(); await extendVoiceConversationCredits(row.id, "owner");
  assert.equal(w.row.reservationPayload.maxSeconds, 65); assert.equal(w.row.reservedCredits, 39);
  assert.equal(w.row.addOnReservedCredits, 3); assert.equal(w.purchased, 0);
  const part = w.row.reservationPayload.funding[0];
  assert.equal(part.addOnEntries[0].fundedCostMicroUsd, 4_167);
  t.mock.timers.tick(5_000); lease();
  await assert.rejects(extendVoiceConversationCredits(row.id, "owner"), e => e.code === "CREDIT_BALANCE_INSUFFICIENT");
  assert.equal(w.row.reservedCredits, 39);
});

test("unknown final usage retains all funded provider exposure but bills only observed seconds", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const row = await reserveContinuousVoiceCredits(continuousInput());
  t.mock.timers.tick(15_000); lease(); await extendVoiceConversationCredits(row.id, "owner");
  w.row.providerUsageSnapshot = { seconds: 20, confirmed: false };
  await settleVoiceConversationCredits(row.id, 20, true, "observed_minimum", false);
  assert.equal(w.row.settledCredits, 12); assert.equal(w.row.settledCostMicroUsd, 75_000n);
  assert.equal(w.buckets["provider-cost-day"], 75_000); assert.equal(w.row.lastError, "VOICE_PROVIDER_STOP_PENDING");
  assert.deepEqual(w.voiceSettlements, [{ kind: "reservation" }]);
});

test("invalid funding receipts cannot refund another window", async () => {
  const row = await reserveContinuousVoiceCredits(continuousInput());
  for (const change of [p => { p.funding[0].startSeconds = 1; }, p => { p.funding[0].planCredits++; }, p => { p.funding[0].providerCostHold.amount++; }, p => { p.maxSeconds++; }]) {
    const payload = structuredClone(row.reservationPayload); change(payload);
    assert.throws(() => readVoiceCreditPayload(payload), /Invalid voice/);
  }
});

test("funding across midnight and month end refunds each original bucket without rerounding the session", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-31T23:59:40Z") });
  const row = await reserveContinuousVoiceCredits(continuousInput());
  t.mock.timers.tick(20_000); lease(); await extendVoiceConversationCredits(row.id, "owner");
  const parts = w.row.reservationPayload.funding;
  assert.equal(parts.length, 2); assert.equal(parts[0].dayStart, "2026-10-31T00:00:00.000Z");
  assert.equal(parts[1].dayStart, "2026-11-01T00:00:00.000Z"); assert.equal(parts[1].monthStart, "2026-11-01T00:00:00.000Z");
  await settleVoiceConversationCredits(row.id, 65, true);
  assert.equal(w.row.settledCredits, 39); assert.equal(w.buckets.month, 39);
  assert.deepEqual(w.refundedPeriods.filter(refund => ["month", "day"].includes(refund.period)), [
    { amount: 15, period: "day", start: "2026-11-01T00:00:00.000Z" },
    { amount: 15, period: "month", start: "2026-11-01T00:00:00.000Z" },
  ]);
  assert.deepEqual(w.providerCosts, [50_000, 4_167]);
  assert.deepEqual(w.voiceSettlements, [{ kind: "provider_seconds", seconds: 60 }, { kind: "provider_seconds", seconds: 5 }]);
});
