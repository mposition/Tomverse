import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { ensureJurisdictionPolicyDraft } from "@/lib/emailJurisdictionPolicy";
import { footerDisclosureReadiness } from "@/lib/emailFooterDisclosureReadiness";
import { subjectLabelReadiness } from "@/lib/emailSubjectLabelReadiness";

// Whether the statutory subject label and footer blocks are on the rows that
// send.
//
// Contract: docs/policy/email-product-news-redesign-draft.md sections 7.7, 7.8;
// docs/policy/email-notifications.md section 10.2.
//
// What needs a database: both checks ask which (policy version, profile) a
// message could still be composed under, and two readings of that were wrong in
// ways only rows show. The first read the active version alone, and the lane
// composes a queued message under the version that message carries. The second
// assumed `profileKey === countryCode`, which is true for the three countries
// with duties today and false in general -- the EEA is thirty countries and one
// profile. The declarations themselves are unit-tested in
// tests/emailFooterDisclosureReadiness.test.mjs and
// tests/emailSubjectLabelReadiness.test.mjs.

const IDENTITY = {
  EMAIL_BUSINESS_LEGAL_NAME: "Tomverse Pty Ltd",
  EMAIL_BUSINESS_POSTAL_ADDRESS: "1 Example Street, Brisbane QLD 4000",
  EMAIL_BUSINESS_CONTACT_EMAIL: "support@tomverse.app",
  EMAIL_BUSINESS_CONTACT_PHONE: "+61 7 0000 0000",
  MARKETING_EMAIL_FROM: "Tomverse <news@news.tomverse.app>",
};

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "EmailDelivery", "EmailEvent", "TemplateVersion", "EmailTemplate",
      "ReleaseNotesRuleObligation", "ReleaseNotesCountryRule", "ReleaseNotesRuleVersion",
      "JurisdictionCountryMap", "JurisdictionProfile",
      "EmailPolicyVersion", "User"
    RESTART IDENTITY CASCADE
  `);

/** An active policy version with the seeded profiles and country map. */
const activeVersion = async () => {
  const { version } = await ensureJurisdictionPolicyDraft({ version: `test-${randomUUID()}` });
  await prisma.emailPolicyVersion.update({
    where: { id: version.id },
    data: { status: "active", activatedAt: new Date("2026-09-01T00:00:00.000Z") },
  });
  return version.id;
};

/** A second, older version whose SG profile carries no label. */
const olderVersionWithoutLabel = async () => {
  const { version } = await ensureJurisdictionPolicyDraft({ version: `old-${randomUUID()}` });
  await prisma.jurisdictionProfile.update({
    where: { profileKey_policyVersionId: { profileKey: "SG", policyVersionId: version.id } },
    data: { subjectPrefix: "" },
  });
  await prisma.jurisdictionProfile.update({
    where: { profileKey_policyVersionId: { profileKey: "KR", policyVersionId: version.id } },
    data: { footerBlocks: ["legal_name"] },
  });
  return version.id;
};

const seedDelivery = async (input: {
  policyVersionId: string;
  jurisdictionCountry: string;
  jurisdictionProfileKey: string;
  status?: string;
}) => {
  const template = await prisma.emailTemplate.create({
    data: {
      key: `product_news_${randomUUID()}`,
      classification: "marketing",
      purpose: "product_updates",
      requiresUnsubscribe: true,
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
      contentHash: `hash-${randomUUID()}`,
      classification: "marketing",
      purpose: "product_updates",
      requiresUnsubscribe: true,
      status: "published",
      publishedAt: new Date("2026-09-01T00:00:00.000Z"),
    },
    select: { id: true },
  });
  const event = await prisma.emailEvent.create({
    data: { kind: "product.news", templateId: template.id, payload: {}, audienceKind: "single_user" },
    select: { id: true },
  });
  return prisma.emailDelivery.create({
    data: {
      eventId: event.id,
      recipientKey: `addr:${randomUUID()}@example.test`,
      lane: "standard",
      emailAddress: `to-${randomUUID()}@example.test`,
      language: "en",
      jurisdictionCountry: input.jurisdictionCountry,
      jurisdictionProfileKey: input.jurisdictionProfileKey,
      policyVersionId: input.policyVersionId,
      templateVersionId: version.id,
      idempotencyKey: randomUUID(),
      status: input.status ?? "pending",
    },
    select: { id: true },
  });
};

const originalEnv = { ...process.env };
beforeEach(async () => {
  await reset();
  for (const [key, value] of Object.entries(IDENTITY)) process.env[key] = value;
});
after(async () => {
  for (const key of Object.keys(IDENTITY)) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  await reset();
  await prisma.$disconnect();
});

test("a correct active version with nothing queued is ready", async () => {
  await activeVersion();
  const subject = await subjectLabelReadiness();
  assert.equal(subject.labelsPresent, true, JSON.stringify(subject.problems));
  assert.equal(subject.ready, true);
  const footer = await footerDisclosureReadiness();
  assert.equal(footer.disclosuresPresent, true, JSON.stringify(footer.problems));
  assert.equal(footer.ready, true);
});

test("a message queued under an older version is checked against that version", async () => {
  // Activating a corrected version does not reach a message already enqueued:
  // the lane composes it under the version it carries.
  const active = await activeVersion();
  const older = await olderVersionWithoutLabel();
  await seedDelivery({
    policyVersionId: older,
    jurisdictionCountry: "SG",
    jurisdictionProfileKey: "SG",
  });
  await seedDelivery({
    policyVersionId: older,
    jurisdictionCountry: "KR",
    jurisdictionProfileKey: "KR",
  });

  const subject = await subjectLabelReadiness();
  assert.equal(subject.labelsPresent, false);
  assert.ok(subject.policyVersionIds.includes(older));
  assert.ok(subject.policyVersionIds.includes(active));
  assert.match(subject.problems[0].message, /pending deliveries/);

  const footer = await footerDisclosureReadiness();
  assert.equal(footer.disclosuresPresent, false);
  assert.match(footer.problems[0].message, /contact_email|contact_phone|postal_address/);
});

test("a message whose profile key is not its country code is still checked", async () => {
  // `profileKey === countryCode` is true for today's three countries and false in
  // general, and the lane reads the pair the delivery carries. A check filtering
  // on the profile key missed this message entirely.
  const active = await activeVersion();
  await prisma.jurisdictionProfile.create({
    data: {
      profileKey: "SG-v2",
      policyVersionId: active,
      subjectPrefix: "",
      footerBlocks: ["legal_name"],
      unsubscribeSlaBusinessDays: 10,
      // `opt_in` or `opt_out`: the profile CHECK names those two, and
      // `express_consent` is the release-notes rule vocabulary, not this one.
      marketingBasis: "opt_in",
      notes: "A remapped Singaporean profile, for the test.",
    },
  });
  await seedDelivery({
    policyVersionId: active,
    jurisdictionCountry: "SG",
    jurisdictionProfileKey: "SG-v2",
  });

  const subject = await subjectLabelReadiness();
  assert.equal(subject.labelsPresent, false, JSON.stringify(subject.problems));
  assert.match(subject.problems[0].message, /SG-v2/);
});

test("a delivery that is not pending is not a message that can still be sent", async () => {
  // The status filter is the difference between "a version a message will be
  // composed under" and "a version one was composed under once".
  const active = await activeVersion();
  const older = await olderVersionWithoutLabel();
  await seedDelivery({
    policyVersionId: older,
    jurisdictionCountry: "SG",
    jurisdictionProfileKey: "SG",
    status: "sent",
  });
  const subject = await subjectLabelReadiness();
  assert.equal(subject.labelsPresent, true, JSON.stringify(subject.problems));
  assert.deepEqual(subject.policyVersionIds, [active]);
});

test("a country the active version maps to no profile is a problem, not a pass", async () => {
  // A message to that country would be composed from no profile at all, which
  // prints no footer and no prefix.
  const active = await activeVersion();
  await prisma.jurisdictionCountryMap.delete({
    where: { countryCode_policyVersionId: { countryCode: "SG", policyVersionId: active } },
  });
  const subject = await subjectLabelReadiness();
  assert.equal(subject.labelsPresent, false);
  assert.match(subject.problems[0].message, /maps no profile for SG/);
});

test("with marketing not configured the answer is reported and does not gate", async () => {
  // EM-10's shape: before `MARKETING_EMAIL_FROM` is set, a label no message needs
  // is not a reason to take a deployment down.
  delete process.env.MARKETING_EMAIL_FROM;
  const active = await activeVersion();
  await prisma.jurisdictionProfile.update({
    where: { profileKey_policyVersionId: { profileKey: "SG", policyVersionId: active } },
    data: { subjectPrefix: "" },
  });
  const subject = await subjectLabelReadiness();
  assert.equal(subject.labelsPresent, false);
  assert.equal(subject.required, false);
  assert.equal(subject.ready, true);
});
