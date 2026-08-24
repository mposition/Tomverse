import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import {
  FOUNDING_TESTER_PASS_ENDED_TEMPLATE,
  FOUNDING_TESTER_PASS_REMINDER_TEMPLATE,
} from "@/lib/emailTemplateDefinitions";
import {
  sendFoundingTesterPassEndedNotices,
  sendFoundingTesterPassReminders,
} from "@/lib/maintenance";
import { prisma } from "@/lib/prisma";

// The two Founding Tester Pass sweeps, after EM-07 moved them onto the queue.
//
// Contract: docs/policy/email-notifications.md §2.4,
// .github/audits/model-lifecycle-email-2026-08-22.md EM-07.
//
// What is worth a database for is not "an email was built" -- the unit tests
// cover the copy. It is that the redemption's own bookkeeping column and the
// outbox row now commit together. The old shape wrote one and then the other,
// so a crash in between either sent a notice twice or marked one sent that
// never existed, and neither is visible from a single-process unit test.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "EmailDelivery", "EmailEvent", "TemplateVersion", "EmailTemplate",
      "EmailPolicyVersion", "BillingPromotionRedemption", "BillingPromotion",
      "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(async () => {
  await reset();
  process.env.EMAIL_AUDIT_HASH_KEY = "test-audit-key";
  process.env.EMAIL_SNAPSHOT_KEYS = "v1:test-snapshot-key";
  process.env.EMAIL_SNAPSHOT_KEY_VERSION = "v1";
});

after(async () => {
  await reset();
  await prisma.$disconnect();
});

const DAY_MS = 86_400_000;

const internalPassPromotion = () =>
  prisma.billingPromotion.create({
    data: {
      code: `PASS-${randomUUID().slice(0, 8)}`,
      discountPercent: 100,
      durationMonths: 2,
      fulfillmentType: "internal_pass",
      accessDurationDays: 60,
    },
  });

const redemption = async (input: {
  accessEndsAt: Date;
  expiredAt?: Date | null;
  language?: string;
}) => {
  const user = await prisma.user.create({
    data: {
      email: `${randomUUID()}@example.test`,
      name: "Tester",
      ...(input.language
        ? { settings: { create: { language: input.language } } }
        : {}),
    },
  });
  const promotion = await internalPassPromotion();
  return prisma.billingPromotionRedemption.create({
    data: {
      promotionId: promotion.id,
      userId: user.id,
      planId: "pro",
      billingInterval: "monthly",
      accessStartsAt: new Date(input.accessEndsAt.getTime() - 60 * DAY_MS),
      accessEndsAt: input.accessEndsAt,
      expiredAt: input.expiredAt ?? null,
    },
  });
};

const deliveriesFor = (templateKey: string) =>
  prisma.emailDelivery.findMany({
    where: { templateVersion: { template: { key: templateKey } } },
    select: {
      id: true,
      status: true,
      language: true,
      userId: true,
      event: { select: { referenceType: true, referenceId: true } },
    },
  });

test("a pass ending inside the window queues one reminder", async () => {
  const now = new Date();
  const row = await redemption({
    accessEndsAt: new Date(now.getTime() + 3 * DAY_MS),
    language: "ko",
  });

  const sent = await sendFoundingTesterPassReminders(now);
  assert.equal(sent, 1);

  const queued = await deliveriesFor(FOUNDING_TESTER_PASS_REMINDER_TEMPLATE);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].status, "pending");
  // The account's own language, not the lane's default -- the copy exists in
  // all seven and reaching none of them would be the half-fix.
  assert.equal(queued[0].language, "ko");
  // The redemption, not the user: the notice is about this pass, and a person
  // may hold more than one over time.
  assert.equal(queued[0].event.referenceType, "BillingPromotionRedemption");
  assert.equal(queued[0].event.referenceId, row.id);
});

test("the claim and the outbox row are written together", async () => {
  const now = new Date();
  await redemption({ accessEndsAt: new Date(now.getTime() + DAY_MS) });

  await sendFoundingTesterPassReminders(now);

  const claimed = await prisma.billingPromotionRedemption.findFirstOrThrow({
    select: { reminderSentAt: true },
  });
  assert.notEqual(claimed.reminderSentAt, null);
  assert.equal(
    (await deliveriesFor(FOUNDING_TESTER_PASS_REMINDER_TEMPLATE)).length,
    1,
    "the column says a reminder was sent, so a row has to exist for it"
  );
});

test("a second sweep queues nothing more", async () => {
  const now = new Date();
  await redemption({ accessEndsAt: new Date(now.getTime() + DAY_MS) });

  assert.equal(await sendFoundingTesterPassReminders(now), 1);
  assert.equal(await sendFoundingTesterPassReminders(new Date()), 0);
  assert.equal(
    (await deliveriesFor(FOUNDING_TESTER_PASS_REMINDER_TEMPLATE)).length,
    1
  );
});

test("a pass ending beyond the window is left alone", async () => {
  const now = new Date();
  await redemption({ accessEndsAt: new Date(now.getTime() + 30 * DAY_MS) });

  assert.equal(await sendFoundingTesterPassReminders(now), 0);
  assert.equal(
    (await deliveriesFor(FOUNDING_TESTER_PASS_REMINDER_TEMPLATE)).length,
    0
  );
});

test("an expired pass queues its ended notice once", async () => {
  const now = new Date();
  const row = await redemption({
    accessEndsAt: new Date(now.getTime() - DAY_MS),
    expiredAt: new Date(now.getTime() - DAY_MS),
  });

  assert.equal(await sendFoundingTesterPassEndedNotices(now), 1);
  assert.equal(await sendFoundingTesterPassEndedNotices(new Date()), 0);

  const queued = await deliveriesFor(FOUNDING_TESTER_PASS_ENDED_TEMPLATE);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].event.referenceId, row.id);

  const marked = await prisma.billingPromotionRedemption.findUniqueOrThrow({
    where: { id: row.id },
    select: { expiryNoticeSentAt: true },
  });
  assert.notEqual(marked.expiryNoticeSentAt, null);
});

test("a pass that has not expired yet gets no ended notice", async () => {
  const now = new Date();
  await redemption({ accessEndsAt: new Date(now.getTime() + 5 * DAY_MS) });

  assert.equal(await sendFoundingTesterPassEndedNotices(now), 0);
  assert.equal(
    (await deliveriesFor(FOUNDING_TESTER_PASS_ENDED_TEMPLATE)).length,
    0
  );
});

test("the queued notice carries the snapshot the drain will render from", async () => {
  const now = new Date();
  await redemption({ accessEndsAt: new Date(now.getTime() + 2 * DAY_MS) });

  await sendFoundingTesterPassReminders(now);

  const delivery = await prisma.emailDelivery.findFirstOrThrow({
    select: { renderDataSnapshot: true, idempotencyKey: true },
  });
  assert.notEqual(delivery.renderDataSnapshot, null);
  assert.ok(delivery.idempotencyKey.length > 0);
});
