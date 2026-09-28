import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { ensureJurisdictionPolicyDraft } from "@/lib/emailJurisdictionPolicy";
import { noticeFactsFor } from "@/lib/emailPolicyPublication";
import { ACCOUNT_DELETION_SCHEDULED_TEMPLATE } from "@/lib/emailTemplateDefinitions";

// The amendment notice's reach, counted the way S10 needs it counted.
//
// Contract: docs/policy/email-product-news-redesign-draft.md sections 10, 11
// approval E and 12 (S10).
//
// The first version counted only `sent`, so a notice the webhook had moved on to
// `delivered` stopped counting, and it compared two sizes, so one account's
// extra delivery could stand in for another's missing one. What needs a
// database is the statement that replaced both: which owed accounts have no
// attempt at all. The pure rules are in tests/emailPolicyPublication.test.mjs.
//
// The notice template here is `account_deletion_scheduled`, the one registered
// legal template -- borrowed only because it is legal. No real amendment notice
// exists yet, and that is `CHANGE_NOTICE_TEMPLATE_KEY`'s business, not this
// statement's.

const EFFECTIVE = new Date("2026-11-15T00:00:00.000Z");
const DAY = 86_400_000;
const daysBefore = (days: number) => new Date(EFFECTIVE.getTime() - days * DAY);

let policyVersionId = "";
let templateVersionId = "";
let eventId = "";

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "EmailDelivery", "EmailEvent", "TemplateVersion", "EmailTemplate",
      "JurisdictionCountryMap", "JurisdictionProfile", "EmailPolicyVersion", "User"
    RESTART IDENTITY CASCADE
  `);

const account = (createdAt: Date, email: string | null = `p-${randomUUID().slice(0, 8)}@example.test`) =>
  prisma.user.create({ data: { email, createdAt }, select: { id: true } });

const delivery = (
  userId: string,
  status: string,
  createdAt: Date,
  sentAt: Date | null = status === "sent" || status === "delivered" ? createdAt : null
) =>
  prisma.emailDelivery.create({
    data: {
      eventId,
      userId,
      recipientKey: `user:${userId}:${randomUUID()}`,
      lane: "standard",
      emailAddress: "p@example.test",
      language: "en",
      jurisdictionCountry: "AU",
      jurisdictionProfileKey: "AU",
      policyVersionId,
      templateVersionId,
      idempotencyKey: randomUUID(),
      status,
      createdAt,
      sentAt,
    },
  });

before(async () => {
  await reset();
  ({ version: { id: policyVersionId } } = await ensureJurisdictionPolicyDraft({
    version: `test-${randomUUID()}`,
  }));
  const template = await prisma.emailTemplate.create({
    data: {
      key: ACCOUNT_DELETION_SCHEDULED_TEMPLATE,
      classification: "legal",
      purpose: null,
      requiresUnsubscribe: false,
    },
  });
  const version = await prisma.templateVersion.create({
    data: {
      templateId: template.id,
      version: 1,
      language: "en",
      subject: "s",
      bodyHtml: "<p>s</p>",
      bodyText: "s",
      contentHash: "hash",
      classification: "legal",
      purpose: null,
      requiresUnsubscribe: false,
      status: "published",
      publishedAt: daysBefore(200),
    },
    select: { id: true },
  });
  templateVersionId = version.id;
  const event = await prisma.emailEvent.create({
    data: {
      kind: "policy.notice",
      templateId: template.id,
      payload: {},
      audienceKind: "single_user",
    },
    select: { id: true },
  });
  eventId = event.id;
});
beforeEach(() =>
  prisma.$executeRawUnsafe(`TRUNCATE TABLE "EmailDelivery", "User" CASCADE`)
);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

test("a notice the webhook moved on to delivered still counts as reached", async () => {
  const first = await account(daysBefore(90));
  const second = await account(daysBefore(90));
  await delivery(first.id, "sent", daysBefore(40));
  await delivery(second.id, "delivered", daysBefore(35));

  const facts = await noticeFactsFor(ACCOUNT_DELETION_SCHEDULED_TEMPLATE, EFFECTIVE, EFFECTIVE);
  assert.equal(facts.owed, 2);
  assert.equal(facts.reached, 2);
  assert.equal(facts.notAttempted, 0);
  assert.equal(facts.firstSentAt?.getTime(), daysBefore(40).getTime());
  assert.equal(facts.classification, "legal");
});

test("an unreachable mailbox is attempted, reported, and not blocking", async () => {
  const bounced = await account(daysBefore(90));
  await delivery(bounced.id, "bounced", daysBefore(40), daysBefore(40));
  const suppressed = await account(daysBefore(90));
  await delivery(suppressed.id, "suppressed", daysBefore(40), null);

  const facts = await noticeFactsFor(ACCOUNT_DELETION_SCHEDULED_TEMPLATE, EFFECTIVE, EFFECTIVE);
  assert.equal(facts.owed, 2);
  assert.equal(facts.reached, 0);
  assert.equal(facts.unreachable, 2);
  assert.equal(facts.notAttempted, 0);
});

test("one account's extra deliveries do not stand in for another's missing one", async () => {
  // The size comparison this replaced: two deliveries, two owed, one untold.
  const told = await account(daysBefore(90));
  const untold = await account(daysBefore(90));
  await delivery(told.id, "sent", daysBefore(40));
  await delivery(told.id, "delivered", daysBefore(39));

  const facts = await noticeFactsFor(ACCOUNT_DELETION_SCHEDULED_TEMPLATE, EFFECTIVE, EFFECTIVE);
  assert.equal(facts.owed, 2);
  assert.equal(facts.reached, 1);
  assert.equal(facts.notAttempted, 1);
  assert.ok(untold.id);
});

test("an account that joins during the notice period is owed a notice too", async () => {
  // Anchored on the effective date, not on the first send: someone who signed up
  // after the first wave went out and before the amendment took effect has not
  // been told, and a later wave has to reach them.
  const early = await account(daysBefore(90));
  await delivery(early.id, "sent", daysBefore(40));
  await account(daysBefore(10));

  const facts = await noticeFactsFor(ACCOUNT_DELETION_SCHEDULED_TEMPLATE, EFFECTIVE, EFFECTIVE);
  assert.equal(facts.owed, 2);
  assert.equal(facts.notAttempted, 1);

  // An account created on or after the effective date is not owed one.
  await account(EFFECTIVE);
  const later = await noticeFactsFor(ACCOUNT_DELETION_SCHEDULED_TEMPLATE, EFFECTIVE, EFFECTIVE);
  assert.equal(later.owed, 2);
});

test("a delivery older than the notice window is not this notice", async () => {
  // A key pointed at a template that has been sending for a year must not supply
  // last year's deliveries as the amendment notice.
  const old = await account(daysBefore(400));
  await delivery(old.id, "sent", daysBefore(200));

  const facts = await noticeFactsFor(ACCOUNT_DELETION_SCHEDULED_TEMPLATE, EFFECTIVE, EFFECTIVE);
  assert.equal(facts.reached, 0);
  assert.equal(facts.notAttempted, 1);
  assert.equal(facts.firstSentAt, null);
});

test("pending and skipped deliveries are not attempts", async () => {
  // In flight, or a dry run, or cancelled: none of them told anybody anything.
  const pending = await account(daysBefore(90));
  await delivery(pending.id, "pending", daysBefore(40), null);
  const skipped = await account(daysBefore(90));
  await delivery(skipped.id, "skipped", daysBefore(40), null);

  const facts = await noticeFactsFor(ACCOUNT_DELETION_SCHEDULED_TEMPLATE, EFFECTIVE, EFFECTIVE);
  assert.equal(facts.notAttempted, 2);
});

test("an account without an address is not owed a mail it cannot receive", async () => {
  await account(daysBefore(90), null);
  const facts = await noticeFactsFor(ACCOUNT_DELETION_SCHEDULED_TEMPLATE, EFFECTIVE, EFFECTIVE);
  assert.equal(facts.owed, 0);
});
