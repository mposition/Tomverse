import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, mock, test } from "node:test";

import { ACCOUNT_WELCOME_TEMPLATE } from "@/lib/emailTemplateDefinitions";
import {
  AWAITING_DELIVERY,
  WEBHOOK_SILENCE_MIN_SENDS,
  silentProviderAccounts,
  WEBHOOK_EVENT_RETENTION_DAYS,
  purgeExpiredWebhookEvents,
  WEBHOOK_MAX_ATTEMPTS,
  processResendWebhook,
  sweepProviderWebhookEvents,
} from "@/lib/emailWebhookProcessing";
import { prisma } from "@/lib/prisma";
import {
  drainStandardEmailDeliveries,
  enqueueStandardEmail,
} from "@/lib/standardEmailLane";

// The processing state machine of stored provider events: claims under a
// lease, retries on redelivery and by the sweeper, waiting for a delivery that
// is not recorded yet, and abandonment after ten attempts.
//
// Contract: docs/policy/email-product-news-redesign-draft.md, section 7.4
// (webhook reprocessing).

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ProviderWebhookEvent", "SuppressionCause", "SuppressionEntry", "AppSetting",
      "EmailDelivery", "EmailEvent", "TemplateVersion", "EmailTemplate",
      "EmailPolicyVersion", "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(async () => {
  await reset();
  mock.restoreAll();
  process.env.EMAIL_AUDIT_HASH_KEY = "test-audit-key";
  process.env.EMAIL_SNAPSHOT_KEYS = "v1:test-snapshot-key";
  process.env.EMAIL_SNAPSHOT_KEY_VERSION = "v1";
  process.env.RESEND_API_KEY = "test-key";
});

after(async () => {
  mock.restoreAll();
  await reset();
  await prisma.$disconnect();
});

const deliverOne = async (emailAddress: string, providerMessageId = `resend-${randomUUID()}`) => {
  await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress,
    payload: { name: "Someone" },
  });
  mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ id: providerMessageId }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
  await drainStandardEmailDeliveries();
  mock.restoreAll();
  return providerMessageId;
};

const deliveredPayload = (messageId: string, address: string) => ({
  type: "email.delivered",
  data: { email_id: messageId, to: [address] },
});

/** A stored, unprocessed event as a failed earlier attempt left it. */
const storeUnprocessed = (input: {
  providerEventId: string;
  payload: object;
  attempts: number;
  lease?: { id: string; startedAt: Date };
  receivedAt?: Date;
}) =>
  prisma.providerWebhookEvent.create({
    data: {
      provider: "resend",
      providerAccount: "transactional",
      providerEventId: input.providerEventId,
      eventType: (input.payload as { type: string }).type,
      payload: input.payload,
      processingAttempts: input.attempts,
      processingError: "Error",
      receivedAt: input.receivedAt ?? new Date(),
      ...(input.lease
        ? { processingLeaseId: input.lease.id, processingStartedAt: input.lease.startedAt }
        : {}),
    },
  });

test("a redelivery of a failed event applies it instead of answering duplicate", async () => {
  const address = `${randomUUID()}@example.com`;
  const messageId = await deliverOne(address);
  const providerEventId = `msg_${randomUUID()}`;
  await storeUnprocessed({ providerEventId, payload: deliveredPayload(messageId, address), attempts: 3 });

  const result = await processResendWebhook({ providerAccount: "transactional", providerEventId, payload: deliveredPayload(messageId, address) });
  assert.equal(result.handled, true);
  const row = await prisma.providerWebhookEvent.findFirstOrThrow();
  assert.ok(row.processedAt);
  assert.equal(row.processingAttempts, 4);
  assert.equal(row.processingLeaseId, null);
  assert.equal(row.processingError, null);
  assert.equal((await prisma.emailDelivery.findFirstOrThrow()).status, "delivered");

  const again = await processResendWebhook({ providerAccount: "transactional", providerEventId, payload: deliveredPayload(messageId, address) });
  assert.deepEqual(again, { handled: false, reason: "duplicate" });
});

test("a live lease answers in progress; an expired one is claimed again", async () => {
  const address = `${randomUUID()}@example.com`;
  const messageId = await deliverOne(address);
  const providerEventId = `msg_${randomUUID()}`;
  const payload = deliveredPayload(messageId, address);
  const row = await storeUnprocessed({
    providerEventId,
    payload,
    attempts: 1,
    lease: { id: "someone-else", startedAt: new Date() },
  });

  assert.deepEqual(await processResendWebhook({ providerAccount: "transactional", providerEventId, payload }), {
    handled: false,
    reason: "in_progress",
  });

  await prisma.providerWebhookEvent.update({
    where: { id: row.id },
    data: { processingStartedAt: new Date(Date.now() - 2 * 60_000) },
  });
  const sweep = await sweepProviderWebhookEvents();
  assert.equal(sweep.processed, 1);
  const done = await prisma.providerWebhookEvent.findUniqueOrThrow({ where: { id: row.id } });
  assert.ok(done.processedAt);
  assert.equal(done.processingLeaseId, null);
});

test("an event that arrives before its delivery is recorded waits, then binds", async () => {
  const address = `${randomUUID()}@example.com`;
  const messageId = `resend-${randomUUID()}`;
  const providerEventId = `msg_${randomUUID()}`;

  const early = await processResendWebhook({ providerAccount: "transactional", providerEventId, payload: deliveredPayload(messageId, address) });
  assert.deepEqual(early, { handled: true, effect: AWAITING_DELIVERY, deliveryId: null });
  const waiting = await prisma.providerWebhookEvent.findFirstOrThrow();
  assert.equal(waiting.processedAt, null);
  assert.equal(waiting.processingLeaseId, null);
  assert.equal(waiting.processingAttempts, 0, "waiting is not a failed attempt");

  // Still nothing to bind to: waiting again costs no attempt.
  assert.equal((await sweepProviderWebhookEvents()).awaiting, 1);
  assert.equal((await prisma.providerWebhookEvent.findFirstOrThrow()).processingAttempts, 0);

  await deliverOne(address, messageId);
  const sweep = await sweepProviderWebhookEvents();
  assert.equal(sweep.processed, 1);
  assert.ok((await prisma.providerWebhookEvent.findFirstOrThrow()).processedAt);
  assert.equal((await prisma.emailDelivery.findFirstOrThrow()).status, "delivered");
});

test("after fifteen minutes an unbound event settles on its address alone", async () => {
  const address = `${randomUUID()}@example.com`;
  const providerEventId = `msg_${randomUUID()}`;
  await storeUnprocessed({
    providerEventId,
    payload: {
      type: "email.bounced",
      data: { email_id: `resend-${randomUUID()}`, to: [address], bounce: { type: "Permanent" } },
    },
    attempts: 0,
    receivedAt: new Date(Date.now() - 16 * 60_000),
  });
  await prisma.providerWebhookEvent.updateMany({ data: { processingError: null } });

  const sweep = await sweepProviderWebhookEvents();
  assert.equal(sweep.processed, 1);
  assert.equal(
    await prisma.suppressionCause.count({ where: { emailAddress: address, reason: "hard_bounce" } }),
    1
  );
});

test("an event out of attempts is abandoned by the sweeper and absorbed afterwards", async () => {
  const address = `${randomUUID()}@example.com`;
  const messageId = await deliverOne(address);
  const providerEventId = `msg_${randomUUID()}`;
  const payload = deliveredPayload(messageId, address);
  await storeUnprocessed({ providerEventId, payload, attempts: WEBHOOK_MAX_ATTEMPTS });

  const sweep = await sweepProviderWebhookEvents();
  assert.equal(sweep.abandoned, 1);
  assert.equal(sweep.claimed, 0);
  const row = await prisma.providerWebhookEvent.findFirstOrThrow();
  assert.ok(row.abandonedAt);
  assert.equal(row.processedAt, null);

  assert.deepEqual(await processResendWebhook({ providerAccount: "transactional", providerEventId, payload }), {
    handled: false,
    reason: "duplicate",
  });
});

test("processed and abandoned cannot both hold", async () => {
  const row = await storeUnprocessed({
    providerEventId: `msg_${randomUUID()}`,
    payload: { type: "email.sent", data: {} },
    attempts: 1,
  });
  await assert.rejects(
    prisma.providerWebhookEvent.update({
      where: { id: row.id },
      data: { processedAt: new Date(), abandonedAt: new Date() },
    })
  );
});

test("a live lease is in progress even on the last attempt", async () => {
  const providerEventId = `msg_${randomUUID()}`;
  const payload = { type: "email.sent", data: { email_id: `resend-${randomUUID()}`, to: ["a@example.com"] } };
  await storeUnprocessed({
    providerEventId,
    payload,
    attempts: WEBHOOK_MAX_ATTEMPTS,
    lease: { id: "last-worker", startedAt: new Date() },
  });
  assert.deepEqual(await processResendWebhook({ providerAccount: "transactional", providerEventId, payload }), {
    handled: false,
    reason: "in_progress",
  });
  // Nor does the sweeper abandon it while the lease is live.
  assert.equal((await sweepProviderWebhookEvents()).abandoned, 0);
});

test("waiting for a delivery gives back the attempt, even the ninth", async () => {
  const providerEventId = `msg_${randomUUID()}`;
  const payload = {
    type: "email.delivered",
    data: { email_id: `resend-${randomUUID()}`, to: ["someone@example.com"] },
  };
  await storeUnprocessed({ providerEventId, payload, attempts: WEBHOOK_MAX_ATTEMPTS - 1 });
  const result = await processResendWebhook({ providerAccount: "transactional", providerEventId, payload });
  assert.deepEqual(result, { handled: true, effect: AWAITING_DELIVERY, deliveryId: null });
  const row = await prisma.providerWebhookEvent.findFirstOrThrow();
  assert.equal(row.processingAttempts, WEBHOOK_MAX_ATTEMPTS - 1);
  assert.equal(row.processingLeaseId, null);
  assert.equal(row.abandonedAt, null);
});

test("a new event is dated by the database, so a slow application clock does not age it", async () => {
  // The application clock runs twenty minutes slow. Dated by it, the event
  // would already be past its fifteen-minute wait and settle as unmatched; dated
  // by the database, it waits for its delivery.
  mock.timers.enable({ apis: ["Date"], now: Date.now() - 20 * 60_000 });
  let result;
  try {
    result = await processResendWebhook({ providerAccount: "transactional",
      providerEventId: `msg_${randomUUID()}`,
      payload: { type: "email.delivered", data: { email_id: `resend-${randomUUID()}`, to: ["x@example.com"] } },
    });
  } finally {
    mock.timers.reset();
  }
  assert.deepEqual(result, { handled: true, effect: AWAITING_DELIVERY, deliveryId: null });
  const [{ lag }] = await prisma.$queryRaw<Array<{ lag: number }>>`
    SELECT EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'UTC') - "receivedAt"))::float8 AS "lag"
      FROM "ProviderWebhookEvent"
  `;
  assert.ok(lag >= 0 && lag < 60, `received ${lag}s before the database's now`);
});

test("purging past retention leaves a row a worker holds", async () => {
  const old = new Date(Date.now() - (WEBHOOK_EVENT_RETENTION_DAYS + 1) * 86_400_000);
  await storeUnprocessed({
    providerEventId: `msg_${randomUUID()}`,
    payload: { type: "email.sent", data: {} },
    attempts: 1,
    receivedAt: old,
    lease: { id: "busy", startedAt: new Date() },
  });
  await storeUnprocessed({
    providerEventId: `msg_${randomUUID()}`,
    payload: { type: "email.sent", data: {} },
    attempts: 2,
    receivedAt: old,
  });
  const result = await purgeExpiredWebhookEvents();
  assert.equal(result.purged, 1);
  const left = await prisma.providerWebhookEvent.findFirstOrThrow();
  assert.equal(left.processingLeaseId, "busy");
});

test("a message id is matched only within the account that sent it", async () => {
  const address = `${randomUUID()}@example.com`;
  const messageId = await deliverOne(address);
  const payload = deliveredPayload(messageId, address);

  const transactional = await processResendWebhook({
    providerAccount: "transactional",
    providerEventId: `msg_${randomUUID()}`,
    payload,
  });
  assert.equal(transactional.handled && transactional.effect, "delivered");

  // The welcome mail went out on the transactional account. The same message
  // id reported by the marketing account is not that delivery.
  const marketing = await processResendWebhook({
    providerAccount: "marketing",
    providerEventId: `msg_${randomUUID()}`,
    payload,
  });
  assert.deepEqual(marketing, { handled: true, effect: AWAITING_DELIVERY, deliveryId: null });
  assert.equal(await prisma.providerWebhookEvent.count(), 2);
});

test("two deliveries sharing a message id in one account are matched to neither", async () => {
  const address = `${randomUUID()}@example.com`;
  const messageId = await deliverOne(address);
  await deliverOne(address);
  // A second row claiming the same provider message id.
  await prisma.emailDelivery.updateMany({ data: { providerMessageId: messageId } });
  const result = await processResendWebhook({
    providerAccount: "transactional",
    providerEventId: `msg_${randomUUID()}`,
    payload: {
      type: "email.bounced",
      data: { email_id: messageId, to: [address], bounce: { type: "Permanent" } },
    },
  });
  assert.equal(result.handled && result.deliveryId, null);
  const statuses = (await prisma.emailDelivery.findMany({ select: { status: true } })).map((row) => row.status);
  assert.ok(statuses.every((status) => status !== "bounced"), "neither delivery was updated");
  assert.equal(
    await prisma.suppressionCause.count({ where: { emailAddress: address, reason: "hard_bounce" } }),
    1,
    "the address is still suppressed"
  );
});

test("an account that sent mail and heard nothing for a day is silent", async () => {
  const env = {
    RESEND_API_KEY: "key",
    RESEND_WEBHOOK_SECRET: "whsec_x",
  };
  for (let i = 0; i < WEBHOOK_SILENCE_MIN_SENDS; i += 1) {
    await deliverOne(`${randomUUID()}@example.com`);
  }
  assert.deepEqual(
    (await silentProviderAccounts(env)).map((account) => account.stream),
    ["transactional"]
  );
  // Marketing has no key or secret here, so it is not judged.

  // One event from that account in the window is enough.
  await processResendWebhook({
    providerAccount: "transactional",
    providerEventId: `msg_${randomUUID()}`,
    payload: { type: "email.opened", data: {} },
  });
  assert.deepEqual(await silentProviderAccounts(env), []);

  // Without a webhook secret the account is not judged at all.
  await prisma.providerWebhookEvent.deleteMany();
  assert.deepEqual(await silentProviderAccounts({ RESEND_API_KEY: "key" }), []);
});

test("the same new event arriving twice at once is recorded once and applied once", async () => {
  const address = `${randomUUID()}@example.com`;
  const messageId = await deliverOne(address);
  const providerEventId = `msg_${randomUUID()}`;
  const payload = deliveredPayload(messageId, address);
  const results = await Promise.all([
    processResendWebhook({ providerAccount: "transactional", providerEventId, payload }),
    processResendWebhook({ providerAccount: "transactional", providerEventId, payload }),
  ]);
  assert.equal(results.filter((result) => result.handled).length, 1, JSON.stringify(results));
  assert.ok(
    results.every(
      (result) => result.handled || result.reason === "in_progress" || result.reason === "duplicate"
    )
  );
  assert.equal(await prisma.providerWebhookEvent.count(), 1);
});

test("an event id already recorded for the other account fails rather than being acknowledged", async () => {
  const providerEventId = `msg_${randomUUID()}`;
  const payload = { type: "email.sent", data: { email_id: `resend-${randomUUID()}`, to: ["c@example.com"] } };
  await processResendWebhook({ providerAccount: "transactional", providerEventId, payload });
  await assert.rejects(
    processResendWebhook({ providerAccount: "marketing", providerEventId, payload }),
    /other account/
  );
  assert.equal(await prisma.providerWebhookEvent.count(), 1);
});
