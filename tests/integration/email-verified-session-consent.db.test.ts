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
  grantConsentWithVerifiedSession,
  prepareVerifiedSessionGrant,
  requestConsentConfirmation,
} from "@/lib/emailConsentConfirmation";
import { ensureDefaultPreferences, setPreference } from "@/lib/emailPreferences";
import { recordConsentNoticeAction } from "@/lib/inProductConsentNoticeSurface";
import { finalizeSignupConsentAttempt, issueSignupConsentAttempt } from "@/lib/signupConsent";
import { recordSuppression } from "@/lib/emailSuppression";
import { setEmailFeatureFlag } from "../support/emailFeatureFlag";

// A consent ticked in a session that proved the address is confirmed at once;
// anything else still takes the confirmation mail.
// Contract: docs/policy/email-double-opt-in.md section 14.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "SignupConsentAttempt", "EmailPermissionEvent", "ConsentRecord", "EmailPreference",
      "EmailPreferenceTransition", "EmailDelivery", "EmailEvent", "TemplateVersion",
      "EmailTemplate", "SuppressionCause", "SuppressionEntry", "Account", "EmailLoginAttempt",
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

/** Korea's processing-result notices queued for the account. */
const resultNotices = (userId: string) =>
  prisma.emailDelivery.count({
    where: { userId, templateVersion: { template: { key: "consent_result_notice" } } },
  });

/** An account that declared Australia. */
const australian = async () => {
  const user = await prisma.user.create({
    data: { email: `vsc-${randomUUID().slice(0, 8)}@example.test` },
    select: { id: true, email: true },
  });
  await prisma.userSettings.create({
    data: { userId: user.id, country: "AU", countrySource: "self_declared", countryUpdatedAt: new Date() },
  });
  return user as { id: string; email: string };
};

const proofFor = (
  email: string,
  method: "email_code" | "google_verified" | "microsoft_signin" = "google_verified"
) => ({
  method,
  address: email.toLowerCase(),
  provenAt: new Date().toISOString(),
});

const preference = (userId: string, purpose = "product_updates") =>
  prisma.emailPreference.findUniqueOrThrow({ where: { userId_purpose: { userId, purpose } } });

test("a proven session switches a purpose on at once, with its evidence and no mail", async () => {
  const user = await australian();
  const result = await grantConsentWithVerifiedSession({
    userId: user.id,
    purpose: "product_updates",
    proof: proofFor(user.email),
    capturedVia: "preference_center",
  });
  assert.deepEqual(result, { granted: true, alreadyConfirmed: false });

  const row = await preference(user.id);
  assert.equal(row.enabled, true);
  assert.ok(row.confirmedAt);
  assert.equal(row.confirmationRequestId, null);
  const granted = await prisma.consentRecord.findFirstOrThrow({
    where: { userId: user.id, action: "granted" },
  });
  const evidence = granted.evidence as Record<string, unknown>;
  assert.equal(evidence.confirmedVia, "verified_session");
  assert.equal(evidence.proof, "google_verified");
  // No confirmation mail; only the result notice, which asks nothing.
  const templates = await prisma.emailDelivery.findMany({
    where: { userId: user.id },
    select: { templateVersion: { select: { template: { select: { key: true } } } } },
  });
  assert.deepEqual(
    templates.map((row) => row.templateVersion.template.key),
    ["consent_result_notice"]
  );
});

test("a grant retires a confirmation link already in the inbox", async () => {
  const user = await australian();
  await ensureDefaultPreferences(user.id);
  const requested = await requestConsentConfirmation({
    userId: user.id,
    purpose: "product_updates",
    capturedVia: "preference_center",
    confirmedCountry: "AU",
    jurisdiction: "AU",
    jurisdictionSource: "self_declared",
  });
  assert.equal(requested.requested, true);
  assert.ok((await preference(user.id)).confirmationRequestId);

  await grantConsentWithVerifiedSession({
    userId: user.id,
    purpose: "product_updates",
    proof: proofFor(user.email, "email_code"),
    capturedVia: "preference_center",
  });
  const row = await preference(user.id);
  assert.equal(row.enabled, true);
  assert.equal(row.confirmationRequestId, null);
  assert.equal(row.confirmationRequestedAt, null);
});

test("no proof, another address's proof, or the flag off: no grant", async () => {
  const user = await australian();
  const base = { userId: user.id, purposes: ["product_updates"] };
  assert.deepEqual(await prepareVerifiedSessionGrant({ ...base, proof: null }), { ok: false, reason: "no_proof" });
  assert.deepEqual(
    await prepareVerifiedSessionGrant({ ...base, proof: proofFor("someone-else@example.test") }),
    { ok: false, reason: "no_proof" }
  );
  assert.deepEqual(
    await prepareVerifiedSessionGrant({ ...base, proof: { method: "azure_ad", address: user.email, provenAt: new Date().toISOString() } }),
    { ok: false, reason: "no_proof" }
  );
  await setEmailFeatureFlag(EMAIL_CONSENT_CONFIRMATION_FLAG_KEY, false);
  assert.deepEqual(await prepareVerifiedSessionGrant({ ...base, proof: proofFor(user.email) }), {
    ok: false,
    reason: "disabled",
  });
  assert.equal((await preference(user.id).catch(() => null))?.enabled ?? false, false);
});

test("a session confirmation not sealed by the server is refused", async () => {
  const user = await australian();
  await ensureDefaultPreferences(user.id);
  await assert.rejects(
    setPreference({
      userId: user.id,
      purpose: "product_updates",
      enabled: true,
      capturedVia: "preference_center",
      source: "preference_center",
      confirmation: {
        kind: "verified_session",
        proof: "google_verified",
        provenAt: new Date(),
        addressDigest: "forged",
        purposes: ["product_updates"],
        countryCode: "AU",
      },
    })
  );
  assert.equal((await preference(user.id)).enabled, false);
});

test("an address changed after the proof grants nothing", async () => {
  const user = await australian();
  const prepared = await prepareVerifiedSessionGrant({
    userId: user.id,
    proof: proofFor(user.email),
    purposes: ["product_updates"],
  });
  assert.ok(prepared.ok);
  if (!prepared.ok) return;
  await prisma.user.update({ where: { id: user.id }, data: { email: `moved-${randomUUID()}@example.test` } });
  const result = await setPreference({
    userId: user.id,
    purpose: "product_updates",
    enabled: true,
    capturedVia: "preference_center",
    source: "preference_center",
    // The country the seal was made under: the write must name it.
    jurisdiction: prepared.grant.jurisdiction.countryCode,
    confirmation: prepared.grant.confirmation,
  });
  assert.deepEqual(result, { changed: false, reason: "address_changed" });
});

test("a sign-up from a proven session is consented in the consumption, without a confirmation mail", async () => {
  const issuedAt = new Date();
  const issued = await issueSignupConsentAttempt({
    channel: "oauth",
    provider: "google",
    expressOptInRequested: true,
    objected: false,
    language: "en",
    ipCountry: "AU",
    now: issuedAt,
  });
  assert.ok(issued.ok);
  if (!issued.ok) return;
  const user = await prisma.user.create({
    data: { email: `signup-${randomUUID()}@example.test`, createdAt: new Date(issuedAt.getTime() + 1_000) },
    select: { id: true, email: true },
  });
  await prisma.account.create({
    data: { userId: user.id, type: "oauth", provider: "google", providerAccountId: randomUUID() },
  });

  const result = await finalizeSignupConsentAttempt({
    userId: user.id,
    createdBySignIn: true,
    addressProof: proofFor(user.email as string),
    attemptId: issued.attemptId,
    nonce: issued.nonce,
  });
  assert.deepEqual(result, { ok: true, confirmationRequested: false, consentGranted: true });
  // The three purposes the box names, at once (owner decision 2026-10-01,
  // docs/policy/email-double-opt-in.md §14.8).
  const granted = await prisma.consentRecord.findMany({
    where: { userId: user.id, action: "granted" },
    orderBy: { purpose: "asc" },
  });
  assert.deepEqual(
    granted.map((row) => row.purpose),
    ["newsletter", "product_updates", "promotions"]
  );
  for (const row of granted) {
    assert.equal(row.capturedVia, "signup_form");
    assert.deepEqual([row.jurisdiction, row.jurisdictionSource], ["AU", "ip_estimated"]);
  }
  assert.equal(
    await prisma.consentRecord.count({ where: { userId: user.id, action: "confirmation_requested" } }),
    0
  );
  for (const purpose of ["product_updates", "newsletter", "promotions"]) {
    const row = await preference(user.id, purpose);
    assert.equal(row.enabled, true, purpose);
    assert.ok(row.confirmedAt, purpose);
  }
  // One answer, one result notice -- not one per purpose.
  assert.equal(await resultNotices(user.id), 1);
});

test("a sign-up whose session carries no proof still takes the confirmation mail", async () => {
  const issuedAt = new Date();
  const issued = await issueSignupConsentAttempt({
    channel: "oauth",
    provider: "azure-ad",
    expressOptInRequested: true,
    objected: false,
    language: "en",
    ipCountry: "AU",
    now: issuedAt,
  });
  assert.ok(issued.ok);
  if (!issued.ok) return;
  const user = await prisma.user.create({
    data: { email: `ms-${randomUUID()}@example.test`, createdAt: new Date(issuedAt.getTime() + 1_000) },
    select: { id: true },
  });
  await prisma.account.create({
    data: { userId: user.id, type: "oauth", provider: "azure-ad", providerAccountId: randomUUID() },
  });
  const result = await finalizeSignupConsentAttempt({
    userId: user.id,
    createdBySignIn: true,
    addressProof: null,
    attemptId: issued.attemptId,
    nonce: issued.nonce,
  });
  assert.deepEqual(result, { ok: true, confirmationRequested: true });
  assert.equal(await prisma.consentRecord.count({ where: { userId: user.id, action: "granted" } }), 0);
  assert.equal(
    await prisma.consentRecord.count({ where: { userId: user.id, action: "confirmation_requested" } }),
    3
  );
});

test("a sign-up from a country marketing cannot reach mails nothing, even with a proof", async () => {
  // Only a missing proof falls back to the confirmation mail. A country the
  // jurisdiction verdict refuses would refuse the link too, so the consumption
  // rolls back rather than queue three mails that can never become consent.
  const issuedAt = new Date();
  const issued = await issueSignupConsentAttempt({
    channel: "oauth",
    provider: "google",
    expressOptInRequested: true,
    objected: false,
    language: "en",
    ipCountry: "NL",
    now: issuedAt,
  });
  assert.ok(issued.ok);
  if (!issued.ok) return;
  const user = await prisma.user.create({
    data: { email: `nl-${randomUUID()}@example.test`, createdAt: new Date(issuedAt.getTime() + 1_000) },
    select: { id: true, email: true },
  });
  await prisma.account.create({
    data: { userId: user.id, type: "oauth", provider: "google", providerAccountId: randomUUID() },
  });
  const result = await finalizeSignupConsentAttempt({
    userId: user.id,
    createdBySignIn: true,
    addressProof: proofFor(user.email as string),
    attemptId: issued.attemptId,
    nonce: issued.nonce,
  });
  assert.deepEqual(result, { ok: false, reason: "confirmation_unavailable" });
  assert.equal(await prisma.consentRecord.count({ where: { userId: user.id } }), 0);
  assert.equal(await prisma.emailDelivery.count({ where: { userId: user.id } }), 0);
  assert.equal(await prisma.emailPreference.count({ where: { userId: user.id } }), 0);
  const pending = await prisma.signupConsentAttempt.findUniqueOrThrow({ where: { id: issued.attemptId } });
  assert.equal(pending.consumedAt, null);
});

test("the notice's Yes from a proven session consents to all three purposes at once", async () => {
  const user = await australian();
  const result = await recordConsentNoticeAction({
    userId: user.id,
    action: "accept",
    language: "en",
    copyVersion: CURRENT_CONSENT_COPY_VERSION,
    addressProof: proofFor(user.email, "email_code"),
  });
  assert.deepEqual(result, {
    recorded: true,
    granted: ["newsletter", "product_updates", "promotions"],
  });
  for (const purpose of ["product_updates", "newsletter", "promotions"]) {
    const row = await preference(user.id, purpose);
    assert.equal(row.enabled, true, purpose);
    assert.ok(row.confirmedAt, purpose);
  }
  const records = await prisma.consentRecord.findMany({
    where: { userId: user.id, action: "granted" },
    select: { capturedVia: true, evidence: true },
  });
  assert.equal(records.length, 3);
  for (const record of records) {
    assert.equal(record.capturedVia, "preference_center");
    assert.equal((record.evidence as Record<string, unknown>).via, "in_product_notice");
  }
  assert.equal(
    await prisma.consentRecord.count({ where: { userId: user.id, action: "confirmation_requested" } }),
    0
  );
  assert.equal(await resultNotices(user.id), 1);
});

test("a sign-up's result notice is addressed under the country the sign-up recorded", async () => {
  const issuedAt = new Date();
  const issued = await issueSignupConsentAttempt({
    channel: "email_code",
    email: `kr-${randomUUID()}@example.test`,
    expressOptInRequested: true,
    objected: false,
    language: "en",
    ipCountry: "AU",
    now: issuedAt,
  });
  assert.ok(issued.ok);
  if (!issued.ok) return;
  const attempt = await prisma.signupConsentAttempt.findUniqueOrThrow({ where: { id: issued.attemptId } });
  const email = attempt.bindingEmail as string;
  const login = await prisma.emailLoginAttempt.create({
    data: {
      email,
      codeHash: "hash",
      linkTokenHash: randomUUID(),
      expiresAt: new Date(issuedAt.getTime() + 600_000),
      consumedAt: new Date(issuedAt.getTime() + 1_000),
    },
  });
  const user = await prisma.user.create({
    data: { email, createdAt: new Date(issuedAt.getTime() + 2_000) },
    select: { id: true },
  });
  const finalize = () =>
    finalizeSignupConsentAttempt({
      userId: user.id,
      createdBySignIn: true,
      emailLoginAttemptId: login.id,
      addressProof: proofFor(email, "email_code"),
      attemptId: issued.attemptId,
      nonce: issued.nonce,
    });
  assert.deepEqual(await finalize(), { ok: true, confirmationRequested: false, consentGranted: true });

  const notice = await prisma.emailDelivery.findFirstOrThrow({
    where: { userId: user.id },
    select: { jurisdictionCountry: true, templateVersion: { select: { template: { select: { key: true } } } } },
  });
  assert.equal(notice.templateVersion.template.key, "consent_result_notice");
  assert.equal(notice.jurisdictionCountry, "AU");

  // A retry whose first answer was lost says the same thing.
  assert.deepEqual(await finalize(), { ok: true, confirmationRequested: false, consentGranted: true });
});

test("a proven session cannot consent to a suppressed address through the notice", async () => {
  const user = await australian();
  // A hard bounce on the address: the notice is not offered to it, and a Yes
  // sent anyway grants nothing. (A refusal of one purpose mid-transaction rolls
  // the others back; the transaction throws on any outcome but changed or
  // already_set.)
  await recordSuppression({
    sourceEventKey: `test:${randomUUID()}`,
    emailAddress: user.email,
    reason: "hard_bounce",
    source: "admin",
  });
  const result = await recordConsentNoticeAction({
    userId: user.id,
    action: "accept",
    language: "en",
    copyVersion: CURRENT_CONSENT_COPY_VERSION,
    addressProof: proofFor(user.email, "email_code"),
  });
  assert.equal(result.recorded, false);
  assert.equal(await prisma.consentRecord.count({ where: { userId: user.id, action: "granted" } }), 0);
});

test("a Microsoft sign-up is consented at once (owner decision, DOI section 14.7)", async () => {
  const issuedAt = new Date();
  const issued = await issueSignupConsentAttempt({
    channel: "oauth",
    provider: "azure-ad",
    expressOptInRequested: true,
    objected: false,
    language: "en",
    ipCountry: "AU",
    now: issuedAt,
  });
  assert.ok(issued.ok);
  if (!issued.ok) return;
  const user = await prisma.user.create({
    data: { email: `ms-proof-${randomUUID()}@example.test`, createdAt: new Date(issuedAt.getTime() + 1_000) },
    select: { id: true, email: true },
  });
  await prisma.account.create({
    data: { userId: user.id, type: "oauth", provider: "azure-ad", providerAccountId: randomUUID() },
  });
  const result = await finalizeSignupConsentAttempt({
    userId: user.id,
    createdBySignIn: true,
    addressProof: proofFor(user.email as string, "microsoft_signin"),
    attemptId: issued.attemptId,
    nonce: issued.nonce,
  });
  assert.deepEqual(result, { ok: true, confirmationRequested: false, consentGranted: true });
  const granted = await prisma.consentRecord.findFirstOrThrow({
    where: { userId: user.id, action: "granted" },
  });
  assert.equal((granted.evidence as Record<string, unknown>).proof, "microsoft_signin");
});

