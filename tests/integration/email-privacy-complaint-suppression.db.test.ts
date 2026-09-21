import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { recordProviderComplaint } from "@/lib/emailComplaintSuppression";
import { ensureDefaultPreferences, setPreference } from "@/lib/emailPreferences";
import { consentAddressDigest } from "@/lib/emailConsentToken";
import {
  lockPrivacyIntake,
  preparePrivacyIntake,
  recordPrivacyCompletion,
  recordPrivacyIntake,
} from "@/lib/emailPrivacySuppression";
import { recordSuppression, suppressionCheck } from "@/lib/emailSuppression";
import { SUPPRESSION_READ_AUTHORITY_KEY } from "@/lib/emailSuppressionAuthorityCore";
import { ensureBootstrapPolicyVersion } from "@/lib/emailTemplateRegistry";
import { prisma } from "@/lib/prisma";

// The suppressions a deletion request and a spam complaint write, and the
// preference changes that commit with them.
//
// Contract: docs/policy/email-product-news-redesign-draft.md, section 7.4.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "SuppressionCause", "SuppressionEntry", "AppSetting", "PrivacyRequest",
      "EmailPreferenceTransition", "ConsentRecord", "EmailPreference",
      "EmailPolicyVersion", "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(reset);

after(async () => {
  await reset();
  await prisma.$disconnect();
});

const address = () => `${randomUUID()}@example.com`;

const setAuthority = (value: "entry" | "causes") =>
  prisma.appSetting.upsert({
    where: { key: SUPPRESSION_READ_AUTHORITY_KEY },
    create: { key: SUPPRESSION_READ_AUTHORITY_KEY, value },
    update: { value },
  });

/** An account with a confirmed newsletter subscription. */
const subscriber = async (email = address()) => {
  const user = await prisma.user.create({ data: { email } });
  await ensureDefaultPreferences(user.id);
  await prisma.emailPreference.update({
    where: { userId_purpose: { userId: user.id, purpose: "newsletter" } },
    data: { enabled: true, confirmedAt: new Date(), grantedAt: new Date() },
  });
  return user;
};

/** The route's intake, without the route. */
const intake = async (input: { userId: string | null; email: string }) => {
  const prepared = await preparePrivacyIntake({ userId: input.userId });
  return prisma.$transaction(
    async (tx) => {
      await lockPrivacyIntake(tx, { userId: input.userId });
      const request = await tx.privacyRequest.create({
        data: {
          userId: input.userId,
          email: input.email,
          requestType: "deletion",
          dueAt: new Date(Date.now() + 86_400_000),
        },
      });
      await recordPrivacyIntake(tx, {
        requestId: request.id,
        userId: input.userId,
        emailAddress: request.email,
        policyVersionId: prepared.policyVersionId,
        now: new Date(),
      });
      return request;
    },
    { timeout: 20_000 }
  );
};

test("a deletion intake stops marketing under either authority and withdraws the subscription", async () => {
  const user = await subscriber();
  const request = await intake({ userId: user.id, email: user.email! });

  const classification = await prisma.suppressionCause.findMany({
    where: { emailAddress: user.email!, scope: "classification" },
  });
  assert.equal(classification.length, 1);
  assert.equal(classification[0].sourceEventKey, `privacy:${request.id}:intake`);
  assert.equal(classification[0].sourceRequestId, request.id);

  // Entries decide by default here: the purpose entries are what stop the mail.
  for (const purpose of ["newsletter", "promotions", "product_updates"]) {
    const verdict = await suppressionCheck({
      emailAddress: user.email!,
      classification: "marketing",
      purpose,
    });
    assert.equal(verdict.allowed, false, `${purpose} under entries`);
  }
  assert.equal(
    (await suppressionCheck({ emailAddress: user.email!, classification: "transactional" })).allowed,
    true
  );

  await setAuthority("causes");
  assert.equal(
    (await suppressionCheck({ emailAddress: user.email!, classification: "marketing", purpose: "newsletter" })).allowed,
    false
  );

  const newsletter = await prisma.emailPreference.findUniqueOrThrow({
    where: { userId_purpose: { userId: user.id, purpose: "newsletter" } },
  });
  assert.equal(newsletter.enabled, false);
  assert.equal(newsletter.source, "privacy_request");
  const transition = await prisma.emailPreferenceTransition.findFirstOrThrow({
    where: { userId: user.id, purpose: "newsletter" },
  });
  assert.equal(transition.source, "privacy_request");
  const consent = await prisma.consentRecord.findFirstOrThrow({
    where: { userId: user.id, purpose: "newsletter" },
  });
  assert.equal(consent.action, "withdrawn");
  assert.equal(consent.capturedVia, "admin");
});

test("a deletion intake for an address with no account still stops marketing", async () => {
  const emailAddress = address();
  await setAuthority("causes");
  await intake({ userId: null, email: emailAddress });
  assert.equal(
    (await suppressionCheck({ emailAddress, classification: "marketing", purpose: "promotions" })).allowed,
    false
  );
  // The stop is written against the marketing classification rather than each
  // marketing purpose, which is what lets it cover a purpose added later.
  assert.equal(
    await prisma.suppressionCause.count({
      where: { emailAddress, scope: "classification", purposeKey: "marketing" },
    }),
    1
  );
});

test("completion suppresses everything only once no legal hold stands, and only once", async () => {
  const emailAddress = address();
  const request = await intake({ userId: null, email: emailAddress });
  const complete = (legalHold: boolean) =>
    prisma.$transaction(async (tx) => {
      const updated = await tx.privacyRequest.update({
        where: { id: request.id },
        data: { status: "completed", legalHold, completedAt: new Date() },
      });
      return recordPrivacyCompletion(tx, updated, new Date());
    });

  assert.equal(await complete(true), false);
  assert.equal(
    await prisma.suppressionCause.count({ where: { emailAddress, scope: "global" } }),
    0
  );

  assert.equal(await complete(false), true);
  assert.equal(await complete(false), true);
  const global = await prisma.suppressionCause.findMany({ where: { emailAddress, scope: "global" } });
  assert.equal(global.length, 1, "saving the same state again records nothing new");
  assert.equal(global[0].sourceEventKey, `privacy:${request.id}:completed`);
  assert.equal(
    (await suppressionCheck({ emailAddress, classification: "transactional" })).allowed,
    false
  );
});

test("a later hard bounce neither releases nor replaces a privacy request", async () => {
  const emailAddress = address();
  await recordSuppression({
    emailAddress,
    reason: "privacy_request",
    source: "admin",
    sourceEventKey: `privacy:${randomUUID()}:completed`,
  });
  await recordSuppression({
    emailAddress,
    reason: "hard_bounce",
    source: "provider_webhook",
    sourceEventKey: `webhook:${randomUUID()}`,
  });
  // Deploy A had one row per selector, so "does not overwrite" was a merge rule
  // the entry had to be told and could be told wrongly. Causes are one row per
  // event: the privacy request is still its own record and still active, so an
  // operator lifting this address releases the hard bounce -- with a second
  // administrator, which that reason needs -- and the privacy request stays.
  // The address is suppressed afterwards, by the cause that was never theirs
  // to release.
  assert.deepEqual(
    await prisma.suppressionCause.findMany({
      where: { emailAddress },
      orderBy: { reason: "asc" },
      select: { reason: true, releasedAt: true },
    }),
    [
      { reason: "hard_bounce", releasedAt: null },
      { reason: "privacy_request", releasedAt: null },
    ]
  );
});

const complaint = (input: {
  emailAddress: string;
  userId: string | null;
  purpose: string | null;
  policyVersionId: string;
  webhookEventId?: string;
}) => {
  const webhookEventId = input.webhookEventId ?? randomUUID();
  return recordProviderComplaint({
    suppression: {
      emailAddress: input.emailAddress,
      reason: "complaint",
      source: "provider_webhook",
      sourceStream: "marketing",
      sourceClassification: "marketing",
      sourceEventKey: `webhook:${webhookEventId}`,
    },
    delivery: {
      id: `delivery-${randomUUID()}`,
      userId: input.userId,
      emailAddress: input.emailAddress,
      purpose: input.purpose,
      policyVersionId: input.policyVersionId,
      jurisdictionCountry: "DE",
    },
    webhookEventId,
    occurredAt: new Date(),
  });
};

test("a complaint opts the account out of the purpose, pinned to the delivery", async () => {
  const user = await subscriber();
  const policyVersionId = await ensureBootstrapPolicyVersion();
  const webhookEventId = randomUUID();
  const result = await complaint({
    emailAddress: user.email!,
    userId: user.id,
    purpose: "newsletter",
    policyVersionId,
    webhookEventId,
  });
  assert.deepEqual(result, { purpose: "newsletter", attributed: true });

  const preference = await prisma.emailPreference.findUniqueOrThrow({
    where: { userId_purpose: { userId: user.id, purpose: "newsletter" } },
  });
  assert.equal(preference.enabled, false);
  assert.equal(preference.source, "provider_complaint");

  const consent = await prisma.consentRecord.findFirstOrThrow({
    where: { userId: user.id, purpose: "newsletter" },
  });
  assert.equal(consent.action, "withdrawn");
  assert.equal(consent.capturedVia, "provider_complaint");
  assert.equal(consent.jurisdiction, "DE");
  assert.equal(consent.jurisdictionSource, "delivery_pinned");
  assert.equal(consent.policyVersionId, policyVersionId);

  const purposeCauses = await prisma.suppressionCause.findMany({
    where: { emailAddress: user.email!, scope: "purpose", purposeKey: "newsletter" },
  });
  assert.deepEqual(
    purposeCauses.map((cause) => [cause.reason, cause.sourceEventKey]),
    [["unsubscribe", `webhook:${webhookEventId}:purpose`]]
  );
  assert.equal(
    await prisma.suppressionCause.count({
      where: { emailAddress: user.email!, scope: "global", reason: "complaint" },
    }),
    1
  );

  // The same event again records nothing new.
  await complaint({
    emailAddress: user.email!,
    userId: user.id,
    purpose: "newsletter",
    policyVersionId,
    webhookEventId,
  });
  assert.equal(await prisma.suppressionCause.count({ where: { emailAddress: user.email! } }), 2);
  assert.equal(await prisma.consentRecord.count({ where: { userId: user.id } }), 1);
});

test("a complaint about an address the account no longer has changes nobody's preferences", async () => {
  const user = await subscriber();
  const policyVersionId = await ensureBootstrapPolicyVersion();
  const oldAddress = address();
  const result = await complaint({
    emailAddress: oldAddress,
    userId: user.id,
    purpose: "newsletter",
    policyVersionId,
  });
  assert.deepEqual(result, { purpose: "newsletter", attributed: false });
  const preference = await prisma.emailPreference.findUniqueOrThrow({
    where: { userId_purpose: { userId: user.id, purpose: "newsletter" } },
  });
  assert.equal(preference.enabled, true);
  assert.equal(await prisma.consentRecord.count({ where: { userId: user.id } }), 0);
  // The mailbox still stops receiving that purpose.
  assert.equal(
    await prisma.suppressionCause.count({
      where: { emailAddress: oldAddress, scope: "purpose", purposeKey: "newsletter" },
    }),
    1
  );
});

test("a complaint about mail that cannot be switched off records only the complaint", async () => {
  const user = await subscriber();
  const policyVersionId = await ensureBootstrapPolicyVersion();
  const result = await complaint({
    emailAddress: user.email!,
    userId: user.id,
    purpose: "security",
    policyVersionId,
  });
  assert.deepEqual(result, { purpose: null, attributed: false });
  const causes = await prisma.suppressionCause.findMany({ where: { emailAddress: user.email! } });
  assert.deepEqual(causes.map((cause) => [cause.scope, cause.reason]), [["global", "complaint"]]);
});

test("while entries decide, confirming a subscription again does not lift a deletion request", async () => {
  const user = await subscriber();
  const policyVersionId = await ensureBootstrapPolicyVersion();
  await intake({ userId: user.id, email: user.email! });
  await prisma.emailPreference.update({
    where: { userId_purpose: { userId: user.id, purpose: "newsletter" } },
    data: { confirmationRequestId: "req-again", confirmationRequestedAt: new Date() },
  });

  const result = await setPreference({
    userId: user.id,
    purpose: "newsletter",
    enabled: true,
    capturedVia: "preference_center",
    source: "preference_center",
    confirmation: {
      tokenVersion: "v1",
      requestedAt: new Date(),
      requestId: "req-again",
      policyVersionId,
      addressDigest: consentAddressDigest(user.email!),
    },
  });
  assert.deepEqual(result, { changed: false, reason: "suppressed" });
  assert.equal(
    (await suppressionCheck({ emailAddress: user.email!, classification: "marketing", purpose: "newsletter" })).allowed,
    false
  );
});

test("a later privacy request is its own cause and does not restamp the earlier one", async () => {
  const emailAddress = address();
  const first = await recordSuppression({
    emailAddress,
    reason: "privacy_request",
    source: "admin",
    sourceEventKey: "privacy:first:completed",
    sourceRequestId: "first",
    occurredAt: new Date("2026-01-01T00:00:00Z"),
  });
  const second = await recordSuppression({
    emailAddress,
    reason: "privacy_request",
    source: "admin",
    sourceEventKey: "privacy:second:completed",
    sourceRequestId: "second",
  });
  // Two requests are two events. The entry merged them into one row and had to
  // be told to keep the earlier timestamp; here the earlier cause simply still
  // says what it said, and answering "when did they ask" does not depend on a
  // merge rule having been written correctly.
  assert.equal(second.changed, true);
  assert.notEqual(second.id, first.id);
  const causes = await prisma.suppressionCause.findMany({
    where: { emailAddress },
    orderBy: { occurredAt: "asc" },
    select: { occurredAt: true, sourceRequestId: true },
  });
  assert.equal(causes.length, 2);
  assert.equal(causes[0].occurredAt.toISOString(), "2026-01-01T00:00:00.000Z");
  assert.equal(causes[0].sourceRequestId, "first");
  assert.equal(causes[1].sourceRequestId, "second");
});

test("a replayed complaint does not switch off a preference turned back on since", async () => {
  const user = await subscriber();
  const policyVersionId = await ensureBootstrapPolicyVersion();
  const webhookEventId = randomUUID();
  await complaint({ emailAddress: user.email!, userId: user.id, purpose: "newsletter", policyVersionId, webhookEventId });
  // Somebody switched it back on by whatever route; the replay must leave it.
  await prisma.emailPreference.update({
    where: { userId_purpose: { userId: user.id, purpose: "newsletter" } },
    data: { enabled: true, confirmedAt: new Date() },
  });
  const replay = await complaint({
    emailAddress: user.email!,
    userId: user.id,
    purpose: "newsletter",
    policyVersionId,
    webhookEventId,
  });
  assert.deepEqual(replay, { purpose: "newsletter", attributed: true, duplicate: true });
  const preference = await prisma.emailPreference.findUniqueOrThrow({
    where: { userId_purpose: { userId: user.id, purpose: "newsletter" } },
  });
  assert.equal(preference.enabled, true);
  assert.equal(await prisma.consentRecord.count({ where: { userId: user.id } }), 1);
});

test("a complaint naming a deleted account still records both stops", async () => {
  const emailAddress = address();
  const policyVersionId = await ensureBootstrapPolicyVersion();
  const result = await complaint({
    emailAddress,
    userId: "deleted-account",
    purpose: "newsletter",
    policyVersionId,
  });
  assert.deepEqual(result, { purpose: "newsletter", attributed: false });
  const causes = await prisma.suppressionCause.findMany({ where: { emailAddress } });
  assert.deepEqual(
    causes.map((cause) => [cause.scope, cause.reason]).sort(),
    [["global", "complaint"], ["purpose", "unsubscribe"]]
  );
});

test("switching off a subscription that was never confirmed records no withdrawal", async () => {
  const user = await prisma.user.create({ data: { email: address() } });
  await ensureDefaultPreferences(user.id);
  // On without a confirmation: from before the confirmation step.
  await prisma.emailPreference.update({
    where: { userId_purpose: { userId: user.id, purpose: "newsletter" } },
    data: { enabled: true, confirmedAt: null },
  });
  await intake({ userId: user.id, email: user.email! });
  const preference = await prisma.emailPreference.findUniqueOrThrow({
    where: { userId_purpose: { userId: user.id, purpose: "newsletter" } },
  });
  assert.equal(preference.enabled, false);
  assert.equal(await prisma.consentRecord.count({ where: { userId: user.id } }), 0);
  assert.equal(
    await prisma.emailPreferenceTransition.count({ where: { userId: user.id, purpose: "newsletter" } }),
    1
  );
});
