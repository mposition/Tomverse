import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, mock, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { ACCOUNT_WELCOME_TEMPLATE } from "@/lib/emailTemplateDefinitions";
import {
  drainStandardEmailDeliveries,
  enqueueStandardEmail,
} from "@/lib/standardEmailLane";
import {
  WEBHOOK_EVENT_RETENTION_DAYS,
  processResendWebhook,
  purgeExpiredWebhookEvents,
} from "@/lib/emailWebhookProcessing";
import { recordSuppression, suppressionCheck } from "@/lib/emailSuppression";
import { SOFT_BOUNCE_SUPPRESSION_THRESHOLD } from "@/lib/emailSuppressionCore";

// Provider webhooks and the suppression list they feed, against a real
// database.
//
// Contract: .github/audits/email-notification-architecture-2026-08-21.md §9.6, §13.3.
//
// The asymmetry in §13.3 is what most of this establishes: a complaint about a
// promotion stops promotions and does not stop a login code, because refusing
// to send a login code to someone who reported a newsletter locks them out of
// the account they were trying to leave.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ProviderWebhookEvent", "SuppressionEntry", "EmailDelivery", "EmailEvent",
      "TemplateVersion", "EmailTemplate", "EmailPolicyVersion", "User"
    RESTART IDENTITY CASCADE
  `);

const stubFetch = (responses: Array<Response>) => {
  let index = 0;
  mock.method(globalThis, "fetch", async () => {
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return next;
  });
  return { count: () => index };
};

const accepted = (id: string) =>
  new Response(JSON.stringify({ id }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

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

/** Enqueues and delivers one message, returning the provider's message id. */
const deliverOne = async (emailAddress: string) => {
  const providerMessageId = `resend-${randomUUID()}`;
  await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress,
    payload: { name: "Someone" },
  });
  stubFetch([accepted(providerMessageId)]);
  await drainStandardEmailDeliveries();
  mock.restoreAll();
  return providerMessageId;
};

const webhook = (type: string, data: Record<string, unknown>) =>
  processResendWebhook({
    providerEventId: `msg_${randomUUID()}`,
    payload: { type, data },
  });

test("a delivered event marks the message delivered", async () => {
  const address = `${randomUUID()}@example.com`;
  const messageId = await deliverOne(address);

  const result = await webhook("email.delivered", {
    email_id: messageId,
    to: [address],
  });

  assert.deepEqual(result, {
    handled: true,
    effect: "delivered",
    deliveryId: (await prisma.emailDelivery.findFirstOrThrow()).id,
  });
  const row = await prisma.emailDelivery.findFirstOrThrow();
  assert.equal(row.status, "delivered");
  assert.ok(row.deliveredAt);
});

test("a redelivered webhook changes nothing the second time", async () => {
  const address = `${randomUUID()}@example.com`;
  const messageId = await deliverOne(address);
  const providerEventId = `msg_${randomUUID()}`;

  const payload = {
    type: "email.bounced",
    data: { email_id: messageId, to: [address], bounce: { type: "Hard" } },
  };

  const first = await processResendWebhook({ providerEventId, payload });
  assert.equal(first.handled, true);

  // Providers redeliver. The svix-id is stable across retries, so the second
  // one has to stop before touching anything -- otherwise every retry
  // re-applies a state change.
  const second = await processResendWebhook({ providerEventId, payload });
  assert.deepEqual(second, { handled: false, reason: "duplicate" });

  assert.equal(await prisma.providerWebhookEvent.count(), 1);
  assert.equal(await prisma.suppressionEntry.count(), 1);
});

test("a hard bounce suppresses the address permanently", async () => {
  const address = `${randomUUID()}@example.com`;
  const messageId = await deliverOne(address);

  await webhook("email.bounced", {
    email_id: messageId,
    to: [address],
    bounce: { type: "Hard" },
  });

  const entry = await prisma.suppressionEntry.findFirstOrThrow();
  assert.equal(entry.reason, "hard_bounce");
  assert.equal(entry.scope, "global");
  assert.equal(entry.purposeKey, "*");
  assert.equal(entry.expiresAt, null, "a hard bounce does not expire");
  assert.equal(entry.source, "provider_webhook");
  assert.ok(entry.sourceMessageId);

  const row = await prisma.emailDelivery.findFirstOrThrow();
  assert.equal(row.status, "bounced");
});

test("a soft bounce does not suppress on its own", async () => {
  const address = `${randomUUID()}@example.com`;
  const messageId = await deliverOne(address);

  // One deferral is a full mailbox or a greylisting pass. Treating it as
  // permanent throws away a real recipient.
  await webhook("email.bounced", {
    email_id: messageId,
    to: [address],
    bounce: { type: "Transient" },
  });

  assert.equal(await prisma.suppressionEntry.count(), 0);
  const row = await prisma.emailDelivery.findFirstOrThrow();
  assert.equal(row.status, "bounced");
  assert.equal(row.lastErrorKind, "soft_bounce");
});

test("a run of soft bounces does suppress, and the hold expires", async () => {
  const address = `${randomUUID()}@example.com`;

  let last = "";
  for (let i = 0; i < SOFT_BOUNCE_SUPPRESSION_THRESHOLD; i += 1) {
    const messageId = await deliverOne(address);
    last = messageId;
    await webhook("email.bounced", {
      email_id: messageId,
      to: [address],
      bounce: { type: "Transient" },
    });
  }

  assert.ok(last);
  const entry = await prisma.suppressionEntry.findFirstOrThrow();
  assert.equal(entry.reason, "soft_bounce");
  // The one reason that expires: the address may start accepting mail again,
  // and only a bounce or a complaint that is permanent should be permanent.
  assert.ok(entry.expiresAt);
  assert.ok(entry.expiresAt.getTime() > Date.now());
});

test("a complaint about marketing does not stop transactional mail", async () => {
  const address = `${randomUUID()}@example.com`;

  await recordSuppression({
    emailAddress: address,
    reason: "complaint",
    source: "provider_webhook",
    sourceStream: "marketing",
    sourceClassification: "marketing",
  });

  // The verdict the two lanes both consult.
  assert.deepEqual(
    await suppressionCheck({ emailAddress: address, classification: "transactional" }),
    { allowed: true }
  );
  assert.deepEqual(
    await suppressionCheck({ emailAddress: address, classification: "marketing" }),
    { allowed: false, skipReason: "suppressed_complaint" }
  );

  // And the lane acts on it: the welcome email still goes out.
  await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress: address,
    payload: { name: "Someone" },
  });
  const fetches = stubFetch([accepted(`resend-${randomUUID()}`)]);
  const drain = await drainStandardEmailDeliveries();

  assert.equal(drain.sent, 1);
  assert.equal(fetches.count(), 1);
});

test("a hard-bounced address stops receiving even transactional mail", async () => {
  const address = `${randomUUID()}@example.com`;
  await recordSuppression({
    emailAddress: address,
    reason: "hard_bounce",
    source: "provider_webhook",
  });

  await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress: address,
    payload: { name: "Someone" },
  });
  const fetches = stubFetch([accepted(`resend-${randomUUID()}`)]);
  const drain = await drainStandardEmailDeliveries();

  // The mailbox does not exist. Section 3.2 asks for a different channel here,
  // not a louder attempt at this one.
  assert.equal(drain.suppressed, 1);
  assert.equal(fetches.count(), 0);

  const row = await prisma.emailDelivery.findFirstOrThrow();
  assert.equal(row.status, "suppressed");
  assert.equal(row.skipReason, "hard_bounce");
});

test("suppression is checked at send time, not at enqueue time", async () => {
  const address = `${randomUUID()}@example.com`;

  await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress: address,
    payload: { name: "Someone" },
  });

  // The address bounces after the message was queued. The decision that
  // matters is the one true when it goes out.
  await recordSuppression({
    emailAddress: address,
    reason: "hard_bounce",
    source: "provider_webhook",
  });

  const fetches = stubFetch([accepted(`resend-${randomUUID()}`)]);
  const drain = await drainStandardEmailDeliveries();

  assert.equal(drain.suppressed, 1);
  assert.equal(fetches.count(), 0);
});

test("a permanent entry is not downgraded by a later transient one", async () => {
  const address = `${randomUUID()}@example.com`;

  await recordSuppression({
    emailAddress: address,
    reason: "hard_bounce",
    source: "provider_webhook",
  });
  const downgrade = await recordSuppression({
    emailAddress: address,
    reason: "soft_bounce",
    source: "provider_webhook",
    expiresAt: new Date(Date.now() + 60_000),
  });

  // A permanent suppression a transient event can replace is not a permanent
  // suppression.
  assert.equal(downgrade.changed, false);
  const entry = await prisma.suppressionEntry.findFirstOrThrow();
  assert.equal(entry.reason, "hard_bounce");
  assert.equal(entry.expiresAt, null);
});

test("addresses are matched case-insensitively", async () => {
  const address = `${randomUUID()}@Example.COM`;
  await recordSuppression({
    emailAddress: address,
    reason: "hard_bounce",
    source: "admin",
  });

  const verdict = await suppressionCheck({
    emailAddress: address.toUpperCase(),
    classification: "transactional",
  });
  assert.deepEqual(verdict, { allowed: false, skipReason: "hard_bounce" });
});

test("an event we do not collect is recorded and does nothing", async () => {
  const address = `${randomUUID()}@example.com`;
  const messageId = await deliverOne(address);

  const result = await webhook("email.opened", {
    email_id: messageId,
    to: [address],
  });

  // Open and click tracking is deliberately not collected (section 8.4). An
  // event we choose not to act on is not an error.
  assert.deepEqual(result, { handled: true, effect: "ignored", deliveryId: null });
  assert.equal(await prisma.suppressionEntry.count(), 0);
  const row = await prisma.emailDelivery.findFirstOrThrow();
  assert.equal(row.status, "sent");
});

test("an event for a message we never sent is handled, not retried forever", async () => {
  const result = await webhook("email.delivered", {
    email_id: "resend-unknown",
    to: ["stranger@example.com"],
  });

  assert.deepEqual(result, { handled: true, effect: "unmatched", deliveryId: null });
  const stored = await prisma.providerWebhookEvent.findFirstOrThrow();
  assert.ok(stored.processedAt);
  assert.equal(stored.processingError, null);
});

test("the raw event is kept so an operator can see what arrived", async () => {
  const address = `${randomUUID()}@example.com`;
  const messageId = await deliverOne(address);

  await webhook("email.complained", { email_id: messageId, to: [address] });

  const stored = await prisma.providerWebhookEvent.findFirstOrThrow();
  assert.equal(stored.provider, "resend");
  assert.equal(stored.eventType, "email.complained");
  assert.ok(stored.processedAt);

  const entry = await prisma.suppressionEntry.findFirstOrThrow();
  assert.equal(entry.reason, "complaint");
  // Which stream drew it is what section 13.3 decides on, so it is recorded
  // from the message rather than guessed at later.
  assert.equal(entry.sourceStream, "transactional");
  assert.equal(entry.sourceClassification, "transactional");
});

test("raw events are purged once they are past their retention", async () => {
  const address = `${randomUUID()}@example.com`;
  const messageId = await deliverOne(address);
  await webhook("email.delivered", { email_id: messageId, to: [address] });

  const fresh = await purgeExpiredWebhookEvents();
  assert.equal(fresh.purged, 0, "a recent event is still needed as a replay guard");

  await prisma.providerWebhookEvent.updateMany({
    data: {
      receivedAt: new Date(
        Date.now() - (WEBHOOK_EVENT_RETENTION_DAYS + 1) * 24 * 60 * 60_000
      ),
    },
  });

  // These carry the recipient's address. Keeping them indefinitely would build
  // a second, unmanaged copy of who we mail.
  const old = await purgeExpiredWebhookEvents();
  assert.equal(old.purged, 1);
  assert.equal(await prisma.providerWebhookEvent.count(), 0);

  // The suppression it produced is not retention-bound and stays.
  const row = await prisma.emailDelivery.findFirstOrThrow();
  assert.equal(row.status, "delivered");
});
