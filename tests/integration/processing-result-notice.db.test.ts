import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { ensureDefaultPreferences, withdrawAllMarketing } from "@/lib/emailPreferences";
import { ensureBootstrapPolicyVersion } from "@/lib/emailTemplateRegistry";
import {
  CONSENT_RESULT_NOTICE_TEMPLATE,
  UNSUBSCRIBE_RESULT_NOTICE_TEMPLATE,
} from "@/lib/emailTemplateDefinitions";
import { prepareProcessingResultNotice } from "@/lib/processingResultNotice";

// Korea's 14-day processing-result notices (S6b).
//
// Contract: docs/policy/email-product-news-redesign-draft.md 7.7 and
// docs/policy/email-consent-copy-draft.md 4.1-4.2.
//
// What only the database shows: that the notice is queued in the transaction
// that records the change, once per request, and for the result it reports.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "EmailDelivery", "EmailEvent", "TemplateVersion", "EmailTemplate",
      "ConsentRecord", "EmailPreference", "EmailPreferenceTransition",
      "SuppressionCause", "SuppressionEntry",
      "JurisdictionCountryMap", "JurisdictionProfile", "EmailPolicyVersion",
      "AppSetting", "UserSettings", "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(async () => {
  await reset();
  process.env.NEXTAUTH_SECRET = "test-secret";
  process.env.EMAIL_AUDIT_HASH_KEY = "test-audit-key";
  process.env.EMAIL_SNAPSHOT_KEYS = "v1:test-snapshot-key";
  process.env.EMAIL_SNAPSHOT_KEY_VERSION = "v1";
  process.env.EMAIL_UNSUBSCRIBE_KEYS = "v1:test-unsubscribe-key";
  process.env.RESEND_API_KEY = "test-key";
  process.env.TRANSACTIONAL_EMAIL_FROM = "Tomverse <no-reply@mail.tomverse.app>";
});

after(async () => {
  await reset();
  await prisma.$disconnect();
});

/** An account that confirmed all three marketing purposes. */
const subscribed = async (language = "ko") => {
  const user = await prisma.user.create({
    data: { email: `result-${randomUUID().slice(0, 8)}@example.test` },
    select: { id: true, email: true },
  });
  await prisma.userSettings.create({ data: { userId: user.id, language } });
  await ensureDefaultPreferences(user.id);
  const policyVersionId = await ensureBootstrapPolicyVersion();
  const now = new Date();
  for (const purpose of ["product_updates", "newsletter", "promotions"]) {
    await prisma.emailPreference.update({
      where: { userId_purpose: { userId: user.id, purpose } },
      data: { enabled: true, confirmedAt: now },
    });
    await prisma.consentRecord.create({
      data: {
        userId: user.id,
        emailAddress: user.email!,
        purpose,
        action: "granted",
        occurredAt: now,
        jurisdiction: "KR",
        jurisdictionSource: "self_declared",
        policyVersionId,
        capturedVia: "preference_center",
        evidence: { via: "fixture" },
      },
    });
  }
  return user;
};

const noticesFor = (userId: string, templateKey: string) =>
  prisma.emailDelivery.findMany({
    where: { userId, event: { template: { key: templateKey } } },
    select: { id: true, language: true, event: { select: { referenceType: true, referenceId: true } } },
  });

test("unsubscribing from everything answers with one result notice", async () => {
  const user = await subscribed();
  await withdrawAllMarketing({
    userId: user.id,
    capturedVia: "unsubscribe_page",
    source: "unsubscribe_link",
    onConsentRecorded: await prepareProcessingResultNotice(user.id),
  });
  const withdrawals = await prisma.consentRecord.findMany({
    where: { userId: user.id, action: "withdrawn" },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  assert.equal(withdrawals.length, 3);
  const notices = await noticesFor(user.id, UNSUBSCRIBE_RESULT_NOTICE_TEMPLATE);
  assert.equal(notices.length, 1, "one request, one result");
  assert.equal(notices[0]!.language, "ko");
  assert.deepEqual(notices[0]!.event, {
    referenceType: "consent_record",
    referenceId: withdrawals[0]!.id,
  });
});

test("a consent answers with the consent notice, in the transaction that records it", async () => {
  const user = await subscribed("en");
  const hook = await prepareProcessingResultNotice(user.id);
  const record = await prisma.consentRecord.findFirstOrThrow({
    where: { userId: user.id, purpose: "product_updates" },
    select: { id: true, emailAddress: true, action: true, occurredAt: true },
  });
  // Rolled back: nothing queued.
  await assert.rejects(
    prisma.$transaction(async (tx) => {
      await hook(tx, { ...record, userId: user.id });
      throw new Error("rollback");
    }),
    /rollback/
  );
  assert.equal((await noticesFor(user.id, CONSENT_RESULT_NOTICE_TEMPLATE)).length, 0);

  await prisma.$transaction((tx) => hook(tx, { ...record, userId: user.id }));
  const notices = await noticesFor(user.id, CONSENT_RESULT_NOTICE_TEMPLATE);
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.language, "en");
});

test("a request or a lapse is not a processing result", async () => {
  const user = await subscribed();
  const hook = await prepareProcessingResultNotice(user.id);
  for (const action of ["confirmation_requested", "confirmation_notice_sent", "lapsed"]) {
    await prisma.$transaction((tx) =>
      hook(tx, {
        id: randomUUID(),
        userId: user.id,
        emailAddress: user.email!,
        action,
        occurredAt: new Date(),
      })
    );
  }
  assert.equal(await prisma.emailDelivery.count({ where: { userId: user.id } }), 0);
});
