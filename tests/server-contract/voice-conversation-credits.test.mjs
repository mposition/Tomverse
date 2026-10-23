import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const mod = path => pathToFileURL(resolve(path)).href;
let w;
class SecurityError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const tx = {
  $executeRaw: async (parts, ...values) => { if (parts.join("").startsWith('UPDATE "ChatUsageBucket"')) w.buckets[values[2]] -= values[0]; return 1; },
  creditLot: { aggregate: async () => ({ _sum: { remainingCredits: w.purchased } }) },
  chatCreditReservation: {
    findUnique: async ({ where }) => w.row && (w.row.idempotencyKey === where.idempotencyKey || w.row.id === where.id) ? w.row : null,
    findUniqueOrThrow: async () => w.row,
    create: async ({ data }) => { w.row = { ...data, createdAt: new Date(), settledCredits: 0 }; return w.row; },
    updateMany: async ({ where, data }) => { if (w.row?.status !== where.status) return { count: 0 }; Object.assign(w.row, data); return { count: 1 }; },
    update: async ({ data }) => { Object.assign(w.row, data); return w.row; },
  },
};
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: { $transaction: async callback => {
  const snapshot = structuredClone(w); try { return await callback(tx); } catch (error) { w = snapshot; throw error; }
} } } });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: { ApiSecurityError: SecurityError } });
mock.module(mod("lib/billingEntitlements.ts"), { namedExports: { getUserBillingPlan: async () => ({ monthlyMessageLimit: 300, dailyMessageLimit: w.dailyLimit }) } });
mock.module(mod("lib/chatSecurity.ts"), { namedExports: {
  getUserChatUsageKey: id => `user:${id}`, usagePeriodStart: () => new Date("2026-10-01T00:00:00Z"),
  readUsageBucketCount: async (_tx, _key, period) => w.buckets[period],
  incrementUsageBucket: async (_tx, _key, period, _start, limit, amount) => { if (w.buckets[period] + amount > limit) return false; w.buckets[period] += amount; return true; },
} });
mock.module(mod("lib/userDailyUsage.ts"), { namedExports: { getUserDayWindow: async () => ({ start: new Date("2026-10-23T00:00:00Z"), end: new Date("2026-10-24T00:00:00Z") }) } });
mock.module(mod("lib/creditDebt.ts"), { namedExports: { lockCreditAccount: async () => {}, offsetCreditDebt: async () => ({ offsetCredits: w.debt ?? 0 }) } });
mock.module(mod("lib/creditLedger.ts"), { namedExports: {
  reserveAddOnCredits: async (_tx, input) => { w.addOnReserved += input.credits; return [{ lotId: "lot", purchaseId: "purchase", credits: input.credits, fundedCostMicroUsd: input.fundedCostMicroUsd }]; },
  settleAddOnCredits: async (_tx, input) => { w.addOnSettlements.push(input); },
} });
mock.module(mod("lib/providerUsageAccounting.ts"), { namedExports: { recordInternalProviderUsage: async input => { w.providerCosts.push(input.estimatedCostMicroUsd); } } });
const { reserveVoiceConversationCredits, settleVoiceConversationCredits } = await import(mod("lib/voiceConversationCredits.ts"));
test.beforeEach(() => { w = { buckets: { day: 0, month: 0 }, purchased: 0, dailyLimit: 300, row: null, addOnReserved: 0, addOnSettlements: [], providerCosts: [] }; });
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
