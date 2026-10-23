import assert from "node:assert/strict";
import test, { after, beforeEach, mock } from "node:test";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const mod = path => pathToFileURL(resolve(path)).href;
const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
if (url.hostname !== "127.0.0.1" || url.port !== "55439" || url.pathname !== "/voice_test") throw new Error("This suite requires the isolated local voice_test cluster.");
mock.module(mod("lib/billingEntitlements.ts"), { namedExports: { getUserBillingPlan: async () => ({ monthlyMessageLimit: 300, dailyMessageLimit: 300 }) } });
const { prisma } = await import(mod("lib/prisma.ts"));
const { reserveVoiceConversationCredits, settleVoiceConversationCredits } = await import(mod("lib/voiceConversationCredits.ts"));
const { recordVoiceUsage, finalizeVoiceReservation } = await import(mod("lib/voiceConversationRecovery.ts"));
let userId;
beforeEach(async () => {
  await prisma.chatCreditReservation.deleteMany({}); await prisma.chatUsageBucket.deleteMany({});
  const user = await prisma.user.create({ data: { email: `voice-${randomUUID()}@example.test` } }); userId = user.id;
});
after(async () => { await prisma.$disconnect(); });
const reserve = () => reserveVoiceConversationCredits({ userId, requestId: randomUUID(), conversationId: null, creditsPerMinute: 36, maxSeconds: 60 });

test("real concurrent finalizers charge and refund wallet and voice budgets once", async () => {
  const row = await reserve();
  const budgetRows = await prisma.chatUsageBucket.findMany({ where: { period: { notIn: ["month", "day"] } } });
  assert.ok(budgetRows.length >= 3);
  await Promise.all(Array.from({ length: 6 }, () => finalizeVoiceReservation(row.id, 10)));
  const saved = await prisma.chatCreditReservation.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(saved.settledCredits, 6); assert.equal(saved.status, "settled");
  const retained = await prisma.chatUsageBucket.findMany({ where: { period: { notIn: ["month", "day"] } } });
  for (const bucket of retained) assert.equal(Number(bucket.count), 15);
  // The canonical subject key is opaque; read it back from the reservation.
  const month = await prisma.chatUsageBucket.findFirst({ where: { key: saved.subjectKey, period: "month" } });
  assert.equal(Number(month.count), 6);
});

test("a provider-budget refusal rolls back every wallet and subject write", async () => {
  const old = process.env.VOICE_PROVIDER_SECONDS_PER_DAY;
  process.env.VOICE_PROVIDER_SECONDS_PER_DAY = "1";
  try { await assert.rejects(reserve(), e => e.code === "VOICE_OPERATIONAL_LIMIT_REACHED"); }
  finally { if (old === undefined) delete process.env.VOICE_PROVIDER_SECONDS_PER_DAY; else process.env.VOICE_PROVIDER_SECONDS_PER_DAY = old; }
  assert.equal(await prisma.chatCreditReservation.count(), 0);
  assert.equal(await prisma.chatUsageBucket.count(), 0);
});

test("real durable evidence preserves final usage across a simulated lost response", async () => {
  const row = await reserve();
  await recordVoiceUsage(row.id, 10); await recordVoiceUsage(row.id, 20, true); await recordVoiceUsage(row.id, 30);
  const saved = await prisma.chatCreditReservation.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(saved.providerUsageSnapshot.seconds, 20); assert.equal(saved.providerUsageSnapshot.confirmed, true);
  await finalizeVoiceReservation(row.id, 20);
  await assert.rejects(finalizeVoiceReservation((await reserve()).id, -1));
});

test("an uncertain close returns unused wallet credits but retains provider exposure", async () => {
  const row = await reserve();
  await settleVoiceConversationCredits(row.id, 10, true, "observed_minimum", false);
  const saved = await prisma.chatCreditReservation.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(saved.settledCredits, 6); assert.equal(saved.lastError, "VOICE_PROVIDER_STOP_PENDING");
  const providerBuckets = await prisma.chatUsageBucket.findMany({ where: { period: { notIn: ["month", "day"] } } });
  for (const bucket of providerBuckets) assert.equal(Number(bucket.count), 60);
});
