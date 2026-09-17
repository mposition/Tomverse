import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, mock, test } from "node:test";

import { recoverPermanentBounces } from "@/lib/emailPermanentBounceRecovery";
import { suppressionCheck } from "@/lib/emailSuppression";
import { ACCOUNT_WELCOME_TEMPLATE } from "@/lib/emailTemplateDefinitions";
import { prisma } from "@/lib/prisma";
import { drainStandardEmailDeliveries, enqueueStandardEmail } from "@/lib/standardEmailLane";

// The recovery of permanent bounces that were handled as soft ones.
//
// Contract: docs/policy/email-notifications.md v18 item 7 and v21.

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
  await reset();
  await prisma.$disconnect();
});

/** A bounce event as the earlier handler left it: processed, no hard bounce cause. */
const storeBounce = (input: { address: string; type: string; receivedAt?: Date }) =>
  prisma.providerWebhookEvent.create({
    data: {
      provider: "resend",
      providerAccount: "transactional",
      providerEventId: `msg_${randomUUID()}`,
      eventType: "email.bounced",
      receivedAt: input.receivedAt ?? new Date(Date.now() - 3 * 86_400_000),
      processedAt: new Date(),
      payload: {
        type: "email.bounced",
        data: { email_id: `resend-${randomUUID()}`, to: [input.address], bounce: { type: input.type } },
      },
    },
  });

test("a dry run counts the missing hard bounces and writes nothing", async () => {
  const dead = `${randomUUID()}@example.com`;
  await storeBounce({ address: dead, type: "Permanent" });
  await storeBounce({ address: `${randomUUID()}@example.com`, type: "Transient" });

  const report = await recoverPermanentBounces({ apply: false });
  assert.equal(report.bounceEvents, 2);
  assert.equal(report.permanentEvents, 1);
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
  const cause = await prisma.suppressionCause.findFirstOrThrow({ where: { emailAddress: dead } });
  assert.equal(cause.reason, "hard_bounce");
  assert.equal(cause.sourceEventKey, `webhook:${event.id}`);
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

test("an address that has taken a delivery since the bounce is left alone", async () => {
  const revived = `${randomUUID()}@example.com`;
  await storeBounce({ address: revived, type: "Permanent", receivedAt: new Date(Date.now() - 10 * 86_400_000) });
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
    data: { status: "delivered", deliveredAt: new Date(Date.now() - 86_400_000) },
  });

  const report = await recoverPermanentBounces({ apply: true });
  assert.equal(report.deliveredSince, 1);
  assert.equal(report.missing, 0);
  assert.equal(report.recorded, 0);
  assert.equal(await prisma.suppressionCause.count({ where: { emailAddress: revived } }), 0);
});
