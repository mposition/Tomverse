import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, mock, test } from "node:test";

import { recoverPermanentBounces } from "@/lib/emailPermanentBounceRecovery";
import { recordSuppression, suppressionCheck } from "@/lib/emailSuppression";
import { ACCOUNT_WELCOME_TEMPLATE } from "@/lib/emailTemplateDefinitions";
import { prisma } from "@/lib/prisma";
import { drainStandardEmailDeliveries, enqueueStandardEmail } from "@/lib/standardEmailLane";

// The recovery of permanent bounces that were handled as soft ones.
//
// Contract: docs/policy/email-notifications.md v21.

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

const DAY = 86_400_000;

/** A bounce event as the earlier handler left it: processed, no hard bounce cause. */
const storeBounce = (input: {
  address: string;
  type: string;
  daysAgo?: number;
  createdAt?: string | null;
  messageId?: string;
}) => {
  const at = new Date(Date.now() - (input.daysAgo ?? 3) * DAY);
  return prisma.providerWebhookEvent.create({
    data: {
      provider: "resend",
      providerAccount: "transactional",
      providerEventId: `msg_${randomUUID()}`,
      eventType: "email.bounced",
      receivedAt: at,
      processedAt: at,
      payload: {
        type: "email.bounced",
        ...(input.createdAt === null ? {} : { created_at: input.createdAt ?? at.toISOString() }),
        data: {
          email_id: input.messageId ?? `resend-${randomUUID()}`,
          to: [input.address],
          bounce: { type: input.type },
        },
      },
    },
  });
};

test("a dry run counts only Permanent bounces it can place in time, and writes nothing", async () => {
  await storeBounce({ address: `${randomUUID()}@example.com`, type: "Permanent" });
  await storeBounce({ address: `${randomUUID()}@example.com`, type: "Transient" });
  // `hard` was always handled as hard; not this recovery's to touch.
  await storeBounce({ address: `${randomUUID()}@example.com`, type: "hard" });
  await storeBounce({ address: `${randomUUID()}@example.com`, type: "Permanent", createdAt: null });

  const report = await recoverPermanentBounces({ apply: false });
  assert.equal(report.bounceEvents, 4);
  assert.equal(report.permanentEvents, 2);
  assert.equal(report.indeterminateTime, 1);
  assert.equal(report.missing, 1);
  assert.equal(report.missingAddresses, 1);
  assert.equal(report.recorded, 0);
  assert.equal(await prisma.suppressionCause.count(), 0);
  assert.equal(JSON.stringify(report).includes("@"), false, "the report names no address");
});

test("an apply records each missing hard bounce once, and a second run records nothing", async () => {
  const dead = `${randomUUID()}@example.com`;
  const event = await storeBounce({ address: dead, type: "Permanent" });

  const first = await recoverPermanentBounces({ apply: true });
  assert.equal(first.recorded, 1);
  assert.equal(first.entriesRaised, 1);
  const cause = await prisma.suppressionCause.findFirstOrThrow({ where: { emailAddress: dead } });
  assert.equal(cause.reason, "hard_bounce");
  assert.equal(cause.sourceEventKey, `webhook:${event.id}`);
  assert.equal(
    (await prisma.suppressionEntry.findFirstOrThrow({ where: { emailAddress: dead } })).reason,
    "hard_bounce"
  );
  assert.equal(
    (await suppressionCheck({ emailAddress: dead, classification: "transactional" })).allowed,
    false
  );

  const second = await recoverPermanentBounces({ apply: true });
  assert.equal(second.alreadyRecorded, 1);
  assert.equal(second.missing, 0);
  assert.equal(second.recorded, 0);
  assert.equal(await prisma.suppressionCause.count({ where: { emailAddress: dead } }), 1);
});

test("a hard bounce already recorded for the message under another key is not recorded again", async () => {
  const dead = `${randomUUID()}@example.com`;
  const messageId = `resend-${randomUUID()}`;
  await storeBounce({ address: dead, type: "Permanent", messageId });
  await recordSuppression({
    emailAddress: dead,
    reason: "hard_bounce",
    source: "provider_webhook",
    sourceMessageId: messageId,
    sourceEventKey: `legacy-trigger:${randomUUID()}`,
  });
  const report = await recoverPermanentBounces({ apply: true });
  assert.equal(report.alreadyRecorded, 1);
  assert.equal(report.recorded, 0);
});

test("an existing permanent entry keeps its reason; the cause is still added", async () => {
  const address = `${randomUUID()}@example.com`;
  await recordSuppression({
    emailAddress: address,
    reason: "complaint",
    source: "provider_webhook",
    sourceStream: "marketing",
    sourceEventKey: `webhook:${randomUUID()}`,
  });
  await storeBounce({ address, type: "Permanent" });

  const report = await recoverPermanentBounces({ apply: true });
  assert.equal(report.recorded, 1);
  assert.equal(report.entriesRaised, 0);
  assert.equal(
    (await prisma.suppressionEntry.findFirstOrThrow({ where: { emailAddress: address } })).reason,
    "complaint"
  );
  assert.equal(
    await prisma.suppressionCause.count({ where: { emailAddress: address, reason: "hard_bounce" } }),
    1
  );
});

test("an address that has taken a delivery since the bounce is left alone", async () => {
  const revived = `${randomUUID()}@example.com`;
  await storeBounce({ address: revived, type: "Permanent", daysAgo: 10 });
  assert.equal((await recoverPermanentBounces({ apply: false })).missing, 1);

  // A later message to the same address, reported delivered after the bounce.
  await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress: revived,
    payload: { name: "Someone" },
  });
  mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ id: `resend-${randomUUID()}` }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
  await drainStandardEmailDeliveries();
  mock.restoreAll();
  await prisma.emailDelivery.updateMany({
    where: { emailAddress: revived },
    data: { status: "delivered", deliveredAt: new Date(Date.now() - DAY) },
  });

  const report = await recoverPermanentBounces({ apply: true });
  assert.equal(report.deliveredSince, 1);
  assert.equal(report.missing, 0);
  assert.equal(report.recorded, 0);
  assert.equal(await prisma.suppressionCause.count({ where: { emailAddress: revived } }), 0);
});

test("two bounces for one address leave two causes and the newest on the entry", async () => {
  const dead = `${randomUUID()}@example.com`;
  await storeBounce({ address: dead, type: "Permanent", daysAgo: 8 });
  const newest = await storeBounce({ address: dead, type: "Permanent", daysAgo: 2 });
  const report = await recoverPermanentBounces({ apply: true });
  assert.equal(report.recorded, 2);
  assert.equal(report.entriesRaised, 1);
  assert.equal(await prisma.suppressionCause.count({ where: { emailAddress: dead, reason: "hard_bounce" } }), 2);
  const entry = await prisma.suppressionEntry.findFirstOrThrow({ where: { emailAddress: dead } });
  const newestMessage = (newest.payload as { data: { email_id: string } }).data.email_id;
  assert.equal(entry.sourceMessageId, newestMessage);
});

test("two events naming one message in a run record one cause", async () => {
  const dead = `${randomUUID()}@example.com`;
  const messageId = `resend-${randomUUID()}`;
  await storeBounce({ address: dead, type: "Permanent", messageId, daysAgo: 4 });
  await storeBounce({ address: dead, type: "Permanent", messageId, daysAgo: 3 });
  const report = await recoverPermanentBounces({ apply: true });
  assert.equal(report.missing, 2, "both looked missing before the run wrote anything");
  assert.equal(report.recorded, 1);
  assert.equal(report.duplicatesInRun, 1);
  assert.equal(await prisma.suppressionCause.count({ where: { emailAddress: dead, reason: "hard_bounce" } }), 1);
});
