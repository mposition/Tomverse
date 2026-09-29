import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import {
  EMAIL_CONSENT_CONFIRMATION_FLAG_KEY,
  EMAIL_SIGNUP_CONSENT_FLAG_KEY,
} from "@/lib/emailFeatureFlags";
import { activatePolicyVersion, ensureJurisdictionPolicyDraft } from "@/lib/emailJurisdictionPolicy";
import { CURRENT_CONSENT_COPY_VERSION } from "@/lib/emailConsentCopy";
import {
  consentNoticeForViewer,
  recordConsentNoticeAction,
} from "@/lib/inProductConsentNoticeSurface";
import { setEmailFeatureFlag } from "../support/emailFeatureFlag";

// The in-product consent notice as a screen (S8).
//
// Contract: docs/policy/email-product-news-redesign-draft.md section 5.4.
//
// What only the database shows: that the render is recorded with the
// resolution and candidates the server resolved, that it is then not offered
// again, that a refusal becomes an objection on the mailbox, and that nothing
// is offered or recorded without a working confirmation.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "EmailPermissionEvent", "ConsentRecord", "EmailPreference",
      "EmailDelivery", "EmailEvent", "TemplateVersion", "EmailTemplate",
      "SuppressionCause", "SuppressionEntry",
      "JurisdictionCountryMap", "JurisdictionProfile", "EmailPolicyVersion",
      "AppSetting", "UserSettings", "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(async () => {
  await reset();
  process.env.EMAIL_CONSENT_KEYS = "v1:test-consent-key";
  process.env.NEXTAUTH_SECRET = "test-secret";
  process.env.EMAIL_AUDIT_HASH_KEY = "test-audit-key";
  process.env.EMAIL_SNAPSHOT_KEYS = "v1:test-snapshot-key";
  process.env.EMAIL_SNAPSHOT_KEY_VERSION = "v1";
  process.env.EMAIL_UNSUBSCRIBE_KEYS = "v1:test-unsubscribe-key";
  process.env.RESEND_API_KEY = "test-key";
  process.env.TRANSACTIONAL_EMAIL_FROM = "Tomverse <no-reply@mail.tomverse.app>";
  await setEmailFeatureFlag(EMAIL_SIGNUP_CONSENT_FLAG_KEY, true);
  await setEmailFeatureFlag(EMAIL_CONSENT_CONFIRMATION_FLAG_KEY, true);
  const draft = await ensureJurisdictionPolicyDraft();
  await activatePolicyVersion({
    versionId: draft.version.id,
    actorId: randomUUID(),
    actorEmail: "ops@example.test",
  });
});

after(async () => {
  delete process.env.EMAIL_CONSENT_KEYS;
  await reset();
  await prisma.$disconnect();
});

/** An existing account that declared Australia. */
const australian = async () => {
  const user = await prisma.user.create({
    data: { email: `notice-${randomUUID().slice(0, 8)}@example.test` },
    select: { id: true, email: true },
  });
  await prisma.userSettings.create({
    data: {
      userId: user.id,
      country: "AU",
      countrySource: "self_declared",
      countryUpdatedAt: new Date(),
    },
  });
  return user;
};

const action = (
  userId: string,
  kind: "shown" | "object" | "accept",
  copyVersion = CURRENT_CONSENT_COPY_VERSION
) =>
  recordConsentNoticeAction({ userId, action: kind, language: "en", copyVersion });

test("a render is recorded with the server's resolution, and the notice is not offered again", async () => {
  const user = await australian();
  assert.deepEqual(await consentNoticeForViewer(user.id), {
    offered: true,
    copyVersion: CURRENT_CONSENT_COPY_VERSION,
  });

  assert.deepEqual(await action(user.id, "shown"), { recorded: true });
  const shown = await prisma.emailPermissionEvent.findFirstOrThrow({
    where: { userId: user.id, kind: "notice_shown" },
  });
  assert.equal(shown.capturedVia, "in_product_notice");
  assert.deepEqual([shown.jurisdiction, shown.jurisdictionSource], ["AU", "self_declared"]);
  const evidence = shown.evidence as {
    surface: string;
    candidates: Array<{ country: string; signal: string }>;
  };
  assert.equal(evidence.surface, "in_product_notice");
  assert.deepEqual(
    evidence.candidates.map((candidate) => [candidate.country, candidate.signal]),
    [["AU", "self_declared"]]
  );

  assert.deepEqual(await consentNoticeForViewer(user.id), { offered: false });
  // A second render of a closed notice records nothing.
  assert.deepEqual(await action(user.id, "shown"), { recorded: false, reason: "not_offered" });
  assert.equal(await prisma.emailPermissionEvent.count({ where: { userId: user.id } }), 1);
});

test("the refusal after the render is an objection on the mailbox", async () => {
  const user = await australian();
  await action(user.id, "shown");
  assert.deepEqual(await action(user.id, "object"), { recorded: true });
  const kinds = (
    await prisma.emailPermissionEvent.findMany({
      where: { emailAddress: user.email!.toLowerCase() },
      select: { kind: true },
      orderBy: { createdAt: "asc" },
    })
  ).map((row) => row.kind);
  assert.deepEqual(kinds, ["notice_shown", "objected"]);
});

test("a refusal whose render was never recorded records both, together", async () => {
  const user = await australian();
  assert.deepEqual(await action(user.id, "object"), { recorded: true });
  assert.equal(
    await prisma.emailPermissionEvent.count({ where: { userId: user.id, kind: "notice_shown" } }),
    1
  );
  assert.equal(
    await prisma.emailPermissionEvent.count({ where: { userId: user.id, kind: "objected" } }),
    1
  );
});

test("without a working confirmation nothing is offered or recorded", async () => {
  const user = await australian();
  await setEmailFeatureFlag(EMAIL_CONSENT_CONFIRMATION_FLAG_KEY, false);
  assert.deepEqual(await consentNoticeForViewer(user.id), { offered: false });
  assert.deepEqual(await action(user.id, "shown"), { recorded: false, reason: "disabled" });

  await setEmailFeatureFlag(EMAIL_CONSENT_CONFIRMATION_FLAG_KEY, true);
  delete process.env.EMAIL_CONSENT_KEYS;
  assert.deepEqual(await consentNoticeForViewer(user.id), { offered: false });
  process.env.EMAIL_CONSENT_KEYS = "v1:test-consent-key";

  assert.deepEqual(await action(user.id, "shown", "1999-01-01"), {
    recorded: false,
    reason: "unknown_version",
  });
  assert.equal(await prisma.emailPermissionEvent.count(), 0);
});

test("Yes requests a confirmation for each purpose the wording names, and records no consent", async () => {
  const user = await australian();
  await action(user.id, "shown");
  const result = await action(user.id, "accept");
  assert.equal(result.recorded, true);
  assert.deepEqual(
    [...((result as { requested?: string[] }).requested ?? [])].sort(),
    ["newsletter", "product_updates", "promotions"]
  );
  const records = await prisma.consentRecord.findMany({
    where: { userId: user.id },
    select: { purpose: true, action: true, evidence: true },
  });
  assert.deepEqual(
    records.map((row) => row.action),
    ["confirmation_requested", "confirmation_requested", "confirmation_requested"]
  );
  for (const row of records) {
    assert.equal((row.evidence as { via: string }).via, "in_product_notice");
  }
  // Nothing is on until each link is used.
  assert.equal(
    await prisma.emailPreference.count({ where: { userId: user.id, confirmedAt: { not: null } } }),
    0
  );
  // The resolved country is not rewritten as something else.
  const settings = await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } });
  assert.deepEqual([settings.country, settings.countrySource], ["AU", "self_declared"]);
});

test("an account whose country marketing may not reach is not asked", async () => {
  const user = await prisma.user.create({
    data: { email: `notice-${randomUUID().slice(0, 8)}@example.test` },
    select: { id: true },
  });
  await prisma.userSettings.create({
    data: { userId: user.id, country: "NL", countrySource: "self_declared", countryUpdatedAt: new Date() },
  });
  assert.deepEqual(await consentNoticeForViewer(user.id), { offered: false });
});
