import assert from "node:assert/strict";
import test, { after, beforeEach, mock } from "node:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const mod = path => pathToFileURL(resolve(path)).href;
const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
const localFixture = url.hostname === "127.0.0.1" && url.port === "55439" && url.pathname === "/voice_test";
const isolatedRunner = ["127.0.0.1", "localhost", "::1"].includes(url.hostname) && process.env.DATABASE_URL === process.env.TEST_DATABASE_URL && /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i.test(url.pathname.slice(1));
if (!localFixture && !isolatedRunner) throw new Error("This suite requires the isolated local fixture or the dedicated loopback CI test database.");
mock.module(mod("lib/billingEntitlements.ts"), { namedExports: { getUserBillingPlan: async () => ({ monthlyMessageLimit: 300, dailyMessageLimit: 300 }) } });
const { prisma } = await import(mod("lib/prisma.ts"));
const { reserveVoiceConversationCredits, settleVoiceConversationCredits } = await import(mod("lib/voiceConversationCredits.ts"));
const { recordVoiceUsage, finalizeVoiceReservation, claimVoiceRecoveryLease, releaseVoiceRecoveryLease } = await import(mod("lib/voiceConversationRecovery.ts"));
const { registerVoiceTask, queueVoiceTaskResult, dispatchVoiceTask, abandonVoiceDispatch } = await import(mod("lib/voiceConversationTasks.ts"));
let userId;
beforeEach(async () => {
  await prisma.chatCreditReservation.deleteMany({}); await prisma.chatUsageBucket.deleteMany({});
  const user = await prisma.user.create({ data: { email: `voice-${randomUUID()}@example.test` } }); userId = user.id;
});
after(async () => { await prisma.$disconnect(); });
const reserve = () => reserveVoiceConversationCredits({ userId, requestId: randomUUID(), conversationId: null, creditsPerMinute: 36, maxSeconds: 60 });

test("real concurrent finalizers charge and refund wallet and voice budgets once", async () => {
  const row = await reserve();
  const budgetRows = await prisma.chatUsageBucket.findMany({ where: { period: { notIn: ["month", "day", "provider-cost-day", "provider-cost-month"] } } });
  assert.ok(budgetRows.length >= 3);
  await Promise.all(Array.from({ length: 6 }, () => finalizeVoiceReservation(row.id, 10)));
  const saved = await prisma.chatCreditReservation.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(saved.settledCredits, 6); assert.equal(saved.status, "settled");
  const retained = await prisma.chatUsageBucket.findMany({ where: { period: { notIn: ["month", "day", "provider-cost-day", "provider-cost-month"] } } });
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
  await recordVoiceUsage(row.id, 10);
  await settleVoiceConversationCredits(row.id, 10, true, "observed_minimum", false);
  const saved = await prisma.chatCreditReservation.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(saved.settledCredits, 6); assert.equal(saved.lastError, "VOICE_PROVIDER_STOP_PENDING");
  const providerBuckets = await prisma.chatUsageBucket.findMany({ where: { period: { notIn: ["month", "day", "provider-cost-day", "provider-cost-month"] } } });
  for (const bucket of providerBuckets) assert.equal(Number(bucket.count), 60);
});

test("a final receipt arriving before grace settlement retains the exact charge and evidence", async () => {
  const row = await reserve(); await recordVoiceUsage(row.id, 20, true);
  await settleVoiceConversationCredits(row.id, 5, true, "observed_minimum", false);
  const saved = await prisma.chatCreditReservation.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(saved.settledCredits, 12); assert.equal(saved.providerUsageSnapshot.seconds, 20);
  assert.equal(saved.providerUsageSnapshot.confirmed, true); assert.equal(saved.lastError, null);
});

test("durable voice tasks bind exact questions and dispatch once over the existing receiver", async () => {
  const row = await reserve(); await registerVoiceTask(row.id, "delegation-1", "Question");
  const input = { delegationId: "delegation-1", conversationId: "chat-1", sourceId: randomUUID(), sourceText: "Question", answer: "Verified answer" };
  await assert.rejects(queueVoiceTaskResult(row.id, { ...input, delegationId: "forged" }), e => e.code === "VOICE_RESULT_MISMATCH");
  await assert.rejects(queueVoiceTaskResult(row.id, { ...input, sourceText: "Different question" }), e => e.code === "VOICE_RESULT_MISMATCH");
  await queueVoiceTaskResult(row.id, input); await queueVoiceTaskResult(row.id, input);
  const socket = new EventEmitter(); socket.OPEN = 1; socket.readyState = 1; let appends = 0;
  socket.send = value => { appends++; const command = JSON.parse(value); queueMicrotask(() => socket.emit("message", JSON.stringify({ type: "session.commentary.appended", client_event_id: command.event_id }))); };
  await dispatchVoiceTask(row.id, socket); await dispatchVoiceTask(row.id, socket);
  assert.equal(appends, 1);
  const stored = await prisma.chatCreditReservation.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(stored.reservationPayload.tasks[0].state, "sent"); assert.equal(stored.reservationPayload.conversationId, "chat-1");
  assert.equal(stored.reservationPayload.tasks[0].textHash.length, 64);
  assert.equal(stored.reservationPayload.tasks[0].text, undefined); assert.equal(stored.reservationPayload.tasks[0].answer, undefined);
  assert.ok(stored.reservationPayload.budgets); assert.ok(stored.reservationPayload.providerCostHold);
});

test("the research migration allows existing jobs and links new jobs to their durable source", async () => {
  const data = { perplexityJobId: randomUUID(), conversationId: "synthetic-chat", assistantMessageId: randomUUID(), modelId: "fixture", reservationId: randomUUID(), traceId: randomUUID() };
  const legacy = await prisma.perplexityAsyncJob.create({ data }); assert.equal(legacy.sourceUserMessageId, null);
  const linked = await prisma.perplexityAsyncJob.create({ data: { ...data, perplexityJobId: randomUUID(), assistantMessageId: randomUUID(), sourceUserMessageId: randomUUID() } });
  assert.ok(linked.sourceUserMessageId);
});

test("settlement removes undelivered answer content while preserving accounting references", async () => {
  const row = await reserve(); await registerVoiceTask(row.id, "queued-task", "Question");
  await queueVoiceTaskResult(row.id, { delegationId: "queued-task", conversationId: "chat-1", sourceId: randomUUID(), sourceText: "Question", answer: "Transient answer" });
  await settleVoiceConversationCredits(row.id, 10, true);
  const saved = await prisma.chatCreditReservation.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(saved.reservationPayload.tasks[0].answer, undefined);
  assert.equal(saved.reservationPayload.tasks[0].id, "queued-task");
  assert.ok(saved.reservationPayload.providerCostHold);
});

test("database ownership excludes competing recovery processes and fences stale releases", async () => {
  const row = await reserve();
  const claims = await Promise.all(Array.from({ length: 6 }, () => claimVoiceRecoveryLease(row.id)));
  const winner = claims.find(Boolean); assert.ok(winner); assert.equal(claims.filter(Boolean).length, 1);
  await releaseVoiceRecoveryLease(row.id, "stale-token"); assert.equal(await claimVoiceRecoveryLease(row.id), null);
  await releaseVoiceRecoveryLease(row.id, winner); assert.ok(await claimVoiceRecoveryLease(row.id));
});

test("recovery abandons an unknown append instead of replaying it", async () => {
  const row = await reserve(); await registerVoiceTask(row.id, "unknown-task", "Question");
  await queueVoiceTaskResult(row.id, { delegationId: "unknown-task", conversationId: "chat-1", sourceId: randomUUID(), sourceText: "Question", answer: "Transient answer" });
  const saved = await prisma.chatCreditReservation.findUniqueOrThrow({ where: { id: row.id } });
  saved.reservationPayload.tasks[0].state = "dispatching";
  await prisma.chatCreditReservation.update({ where: { id: row.id }, data: { reservationPayload: saved.reservationPayload } });
  assert.equal(await abandonVoiceDispatch(row.id), true); assert.equal(await abandonVoiceDispatch(row.id), false);
  const socket = new EventEmitter(); socket.OPEN = 1; socket.readyState = 1; socket.send = () => assert.fail("Unknown appends must not replay");
  await dispatchVoiceTask(row.id, socket);
  const ended = await prisma.chatCreditReservation.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(ended.reservationPayload.tasks[0].state, "failed"); assert.equal(ended.reservationPayload.tasks[0].answer, undefined);
});

test("failed provider delivery discards its queued answer and cannot be dispatched twice", async () => {
  const row = await reserve(); await registerVoiceTask(row.id, "failed-task", "Question");
  await queueVoiceTaskResult(row.id, { delegationId: "failed-task", conversationId: "chat-1", sourceId: randomUUID(), sourceText: "Question", answer: "Transient answer" });
  const socket = new EventEmitter(); socket.OPEN = 1; socket.readyState = 1; let sends = 0;
  socket.send = () => { sends++; throw Error("Synthetic send failure"); };
  await assert.rejects(dispatchVoiceTask(row.id, socket), /Synthetic send failure/);
  await dispatchVoiceTask(row.id, socket); assert.equal(sends, 1);
  const failed = await prisma.chatCreditReservation.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(failed.reservationPayload.tasks[0].state, "failed"); assert.equal(failed.reservationPayload.tasks[0].answer, undefined);
});

test("a killed primary process is recovered by an independent receiver with one durable charge", { timeout: 25000 }, async () => {
  const row = await reserve();
  await registerVoiceTask(row.id, "recovered-task", "Question");
  await queueVoiceTaskResult(row.id, { delegationId: "recovered-task", conversationId: "chat-1", sourceId: randomUUID(), sourceText: "Question", answer: "Saved answer after primary loss" });
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(server, "listening");
  const children = [];
  let appends = 0;
  server.on("connection", socket => socket.on("message", data => {
    const event = JSON.parse(data.toString());
    if (event.type === "session.commentary.append") {
      appends++; assert.equal(event.content, "Saved answer after primary loss");
      setTimeout(() => socket.send(JSON.stringify({ type: "session.closed", usage: { seconds: 15 } })), 100);
    } else if (event.type === "session.close") {
      socket.send(JSON.stringify({ type: "session.closed", usage: { seconds: 15 } }));
    }
  }));
  async function child(mode) {
    const processChild = spawn(process.execPath, ["--conditions=react-server", "--experimental-test-module-mocks", "--no-warnings=ExperimentalWarning", "--import", "tsx", "tests/fixtures/voice-recovery-process.mjs"], {
      env: { ...process.env, VOICE_FIXTURE_MODE: mode, VOICE_FIXTURE_ID: row.id, VOICE_FIXTURE_SOCKET: `ws://127.0.0.1:${server.address().port}` },
      stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true,
    });
    children.push(processChild); let errors = ""; processChild.stderr.on("data", data => { errors += data.toString(); });
    await Promise.race([once(processChild, "message"), once(processChild, "exit").then(() => { throw Error(errors || "Recovery child exited before readiness"); }), new Promise((_, reject) => { const timer = setTimeout(() => reject(Error("Child readiness timeout")), 10000); timer.unref(); })]);
    return processChild;
  }
  try {
    const primary = await child("primary"); const exit = once(primary, "exit"); primary.kill("SIGKILL"); await exit;
    const durable = await prisma.chatCreditReservation.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(durable.providerUsageSnapshot.seconds, 10);
    // Advance the persisted lease/deadline after the actual process kill.
    await prisma.chatCreditReservation.update({ where: { id: row.id }, data: { reservationPayload: { ...durable.reservationPayload, webLeaseUntil: new Date(0).toISOString(), closeAt: new Date(Date.now() + 15000).toISOString() }, providerRequestId: "fixture-session" } });
    await child("worker");
    let settled;
    for (let attempt = 0; attempt < 80; attempt++) {
      settled = await prisma.chatCreditReservation.findUniqueOrThrow({ where: { id: row.id } });
      if (settled.status === "settled") break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(settled.status, "settled"); assert.equal(settled.settledCredits, 9);
    assert.equal(appends, 1);
    assert.equal(settled.providerUsageSnapshot.confirmed, true);
    await finalizeVoiceReservation(row.id, 15);
    assert.equal((await prisma.chatCreditReservation.findUniqueOrThrow({ where: { id: row.id } })).settledCredits, 9);
  } finally {
    for (const processChild of children) if (processChild.exitCode === null && processChild.signalCode === null) { const done = once(processChild, "exit"); processChild.kill("SIGKILL"); await done; }
    for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve));
  }
});
