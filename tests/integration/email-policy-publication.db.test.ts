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

const facts = () =>
  noticeFactsFor(ACCOUNT_DELETION_SCHEDULED_TEMPLATE, EFFECTIVE, EFFECTIVE);

test("a notice the webhook moved on is still a notice the provider accepted", async () => {
  // `sent` is not where a successful message ends. The first version counted
  // only `sent`, so a campaign the webhook had moved to `delivered` read as never
  // sent.
  for (const status of ["sent", "delivered", "bounced", "complained"]) {
    const user = await account(daysBefore(90));
    await delivery(user.id, status, daysBefore(40), daysBefore(40));
  }
  const result = await facts();
  assert.equal(result.owed, 4);
  assert.equal(result.told, 4);
  assert.equal(result.untold, 0);
  assert.equal(result.firstSentAt?.getTime(), daysBefore(40).getTime());
  assert.equal(result.classification, "legal");
});

test("a row the lane wrote without calling the provider is not a notice", async () => {
  // `failed` and `abandoned` are our failures: the notice was never handed over,
  // so those accounts are untold. `suppressed` is the lane refusing the address,
  // which is a fact about the mailbox: unreachable, reported, not blocking.
  const failed = await account(daysBefore(90));
  await delivery(failed.id, "failed", daysBefore(40), null);
  const abandoned = await account(daysBefore(90));
  await delivery(abandoned.id, "abandoned", daysBefore(40), null);
  const suppressed = await account(daysBefore(90));
  await delivery(suppressed.id, "suppressed", daysBefore(40), null);

  const result = await facts();
  assert.equal(result.told, 0);
  assert.equal(result.untold, 2);
  assert.equal(result.unreachable, 1);
});

test("each account is told in time on its own, not by the earliest send", async () => {
  // The second version measured the period from one `MIN(sentAt)`, so one early
  // send made every later one count.
  const early = await account(daysBefore(90));
  await delivery(early.id, "sent", daysBefore(40), daysBefore(40));
  const lateComer = await account(daysBefore(90));
  await delivery(lateComer.id, "sent", daysBefore(5), daysBefore(5));

  const result = await facts();
  assert.equal(result.told, 1);
  assert.equal(result.late, 1);
});

test("the notice period is counted in calendar days", async () => {
  // Effective 15 November: any time on 16 October is thirty days. Measured to the
  // millisecond from midnight, 00:00:01 on 16 October was late for ever.
  const onTheDay = await account(daysBefore(90));
  await delivery(
    onTheDay.id,
    "sent",
    daysBefore(30),
    new Date(daysBefore(30).getTime() + 23 * 3_600_000)
  );
  const dayAfter = await account(daysBefore(90));
  await delivery(dayAfter.id, "sent", daysBefore(29), daysBefore(29));

  const result = await facts();
  assert.equal(result.told, 1);
  assert.equal(result.late, 1);
});

test("an account that joined during the notice period is told if told before it applies", async () => {
  // Thirty days were never available to it, so it has until the effective date.
  const joinedLate = await account(daysBefore(10));
  await delivery(joinedLate.id, "sent", daysBefore(5), daysBefore(5));
  const joinedLateUntold = await account(daysBefore(10));

  const result = await facts();
  assert.equal(result.owed, 2);
  assert.equal(result.told, 1);
  assert.equal(result.untold, 1);
  assert.ok(joinedLateUntold.id);
});

test("a notice after the effective date is no notice", async () => {
  const user = await account(daysBefore(90));
  await delivery(user.id, "sent", EFFECTIVE, new Date(EFFECTIVE.getTime() + 3_600_000));
  const result = await facts();
  assert.equal(result.told, 0);
  assert.equal(result.late, 0);
  assert.equal(result.untold, 1);
});

test("an account whose age is unknown is owed, and one created after is not", async () => {
  await prisma.user.create({ data: { email: "unknown-age@example.test", createdAt: null } });
  await account(EFFECTIVE);
  const result = await facts();
  assert.equal(result.owed, 1);
  assert.equal(result.untold, 1);
});

test("an account with no address is unreachable, not untold", async () => {
  await account(daysBefore(90), null);
  const result = await facts();
  assert.equal(result.owed, 1);
  assert.equal(result.unreachable, 1);
  assert.equal(result.untold, 0);
});

test("a delivery older than the notice window is not this notice", async () => {
  const old = await account(daysBefore(400));
  await delivery(old.id, "sent", daysBefore(200), daysBefore(200));
  const result = await facts();
  assert.equal(result.told, 0);
  assert.equal(result.untold, 1);
  assert.equal(result.firstSentAt, null);
});

test("pending and skipped deliveries tell nobody", async () => {
  const pending = await account(daysBefore(90));
  await delivery(pending.id, "pending", daysBefore(40), null);
  const skipped = await account(daysBefore(90));
  await delivery(skipped.id, "skipped", daysBefore(40), null);
  const result = await facts();
  assert.equal(result.untold, 2);
});

test("one account's extra deliveries do not stand in for another's missing one", async () => {
  const told = await account(daysBefore(90));
  await delivery(told.id, "sent", daysBefore(40), daysBefore(40));
  await delivery(told.id, "delivered", daysBefore(39), daysBefore(39));
  await account(daysBefore(90));
  const result = await facts();
  assert.equal(result.owed, 2);
  assert.equal(result.told, 1);
  assert.equal(result.untold, 1);
});
