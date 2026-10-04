import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, mock, test } from "node:test";

import { prisma } from "@/lib/prisma";
import {
  EMAIL_CONSENT_CONFIRMATION_FLAG_KEY,
  EMAIL_SIGNUP_CONSENT_FLAG_KEY,
} from "@/lib/emailFeatureFlags";
import { activatePolicyVersion, ensureJurisdictionPolicyDraft } from "@/lib/emailJurisdictionPolicy";
import {
  finalizeSignupConsentAttempt,
  issueSignupConsentAttempt,
  recordSignInEstimatedCountry,
} from "@/lib/signupConsent";
import { setEmailFeatureFlag } from "../support/emailFeatureFlag";

// The sign-up screen's consent choice, from the screen to the ledger (S4).
//
// Contract: docs/policy/email-product-news-redesign-draft.md sections 5.1 to 5.3.
//
// What only the database shows: that an existing account's sign-in never
// consumes a choice; that consumption, the estimated country, notice_shown, the
// objection and the confirmation request commit together; that a choice is
// consumed once; and that an estimate never replaces what the person declared.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "SignupConsentAttempt", "EmailPermissionEvent", "EmailLoginAttempt", "Account",
      "EmailDelivery", "EmailEvent", "TemplateVersion", "EmailTemplate",
      "ConsentRecord", "EmailPreference", "SuppressionCause", "SuppressionEntry",
      "JurisdictionCountryMap", "JurisdictionProfile", "EmailPolicyVersion",
      "AppSetting", "UserSettings", "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(async () => {
  await reset();
  mock.restoreAll();
  process.env.NEXTAUTH_SECRET = "test-secret";
  process.env.EMAIL_AUDIT_HASH_KEY = "test-audit-key";
  process.env.EMAIL_SNAPSHOT_KEYS = "v1:test-snapshot-key";
  process.env.EMAIL_SNAPSHOT_KEY_VERSION = "v1";
  process.env.EMAIL_UNSUBSCRIBE_KEYS = "v1:test-unsubscribe-key";
  process.env.EMAIL_CONSENT_KEYS = "v1:test-consent-key";
  process.env.RESEND_API_KEY = "test-key";
  process.env.TRANSACTIONAL_EMAIL_FROM = "Tomverse <no-reply@mail.tomverse.app>";
  await setEmailFeatureFlag(EMAIL_SIGNUP_CONSENT_FLAG_KEY, true);
  await setEmailFeatureFlag(EMAIL_CONSENT_CONFIRMATION_FLAG_KEY, true);
  // notice_shown records the active policy version.
  const draft = await ensureJurisdictionPolicyDraft();
  await activatePolicyVersion({
    versionId: draft.version.id,
    actorId: randomUUID(),
    actorEmail: "ops@example.test",
  });
});

after(async () => {
  mock.restoreAll();
  delete process.env.EMAIL_CONSENT_KEYS;
  await reset();
  await prisma.$disconnect();
});

const later = (from: Date, ms = 1_000) => new Date(from.getTime() + ms);

/** An OAuth sign-up: the account and its first Account row, after the choice. */
const oauthAccount = async (createdAt: Date, provider = "google") => {
  const user = await prisma.user.create({
    data: { email: `${randomUUID()}@example.test`, createdAt },
    select: { id: true, email: true },
  });
  await prisma.account.create({
    data: {
      userId: user.id,
      type: "oauth",
      provider,
      providerAccountId: randomUUID(),
    },
  });
  return user;
};

test("an OAuth sign-up consumes its choice, and everything it implies commits together", async () => {
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
  const user = await oauthAccount(later(issuedAt));

  const result = await finalizeSignupConsentAttempt({
    userId: user.id,
    createdBySignIn: true,
    attemptId: issued.attemptId,
    nonce: issued.nonce,
  });
  assert.deepEqual(result, { ok: true, confirmationRequested: true });

  const attempt = await prisma.signupConsentAttempt.findUniqueOrThrow({ where: { id: issued.attemptId } });
  assert.equal(attempt.userId, user.id);
  assert.ok(attempt.consumedAt);

  const settings = await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } });
  assert.deepEqual([settings.country, settings.countrySource], ["AU", "ip_estimated"]);

  const shown = await prisma.emailPermissionEvent.findFirstOrThrow({
    where: { userId: user.id, kind: "notice_shown" },
  });
  assert.equal(shown.capturedVia, "signup_form");
  assert.deepEqual([shown.jurisdiction, shown.jurisdictionSource], ["AU", "ip_estimated"]);
  assert.equal((shown.evidence as { surface: string }).surface, "signup");

  // Without a proof, one confirmation per purpose the box names
  // (docs/policy/email-double-opt-in.md §14.8).
  const requested = await prisma.consentRecord.findMany({
    where: { userId: user.id, action: "confirmation_requested" },
    orderBy: { purpose: "asc" },
  });
  assert.deepEqual(
    requested.map((row) => row.purpose),
    ["newsletter", "product_updates", "promotions"]
  );
  for (const row of requested) {
    assert.equal(row.capturedVia, "signup_form");
    assert.equal(row.jurisdictionSource, "ip_estimated");
  }
  assert.equal(await prisma.emailDelivery.count({ where: { userId: user.id } }), 3);

  // Once: the same account asking again is told it is consumed, and nothing
  // is written twice -- no second confirmation mail.
  const again = await finalizeSignupConsentAttempt({
    userId: user.id,
    createdBySignIn: true,
    attemptId: issued.attemptId,
    nonce: issued.nonce,
  });
  assert.equal(again.ok, true);
  assert.equal(await prisma.emailDelivery.count({ where: { userId: user.id } }), 3);
});

test("an existing account's sign-in never consumes a choice", async () => {
  const existing = await oauthAccount(new Date(Date.now() - 86_400_000));
  const issued = await issueSignupConsentAttempt({
    channel: "oauth",
    provider: "google",
    expressOptInRequested: true,
    objected: false,
    language: "en",
    ipCountry: "AU",
  });
  assert.ok(issued.ok);
  // Even a session claiming to have created the account is refused on its
  // age: the two checks are independent.
  const result = await finalizeSignupConsentAttempt({
    userId: existing.id,
    createdBySignIn: true,
    attemptId: issued.attemptId,
    nonce: issued.nonce,
  });
  assert.deepEqual(result, { ok: false, reason: "account_predates_attempt" });
  const attempt = await prisma.signupConsentAttempt.findUniqueOrThrow({ where: { id: issued.attemptId } });
  assert.equal(attempt.consumedAt, null);
  assert.equal(await prisma.emailPermissionEvent.count({ where: { userId: existing.id } }), 0);
});

test("an email-code sign-up is bound to its address and the code it consumed", async () => {
  const issuedAt = new Date();
  const email = `${randomUUID()}@example.test`;
  const issued = await issueSignupConsentAttempt({
    channel: "email_code",
    email,
    expressOptInRequested: false,
    objected: true,
    language: "en",
    ipCountry: "US",
    now: issuedAt,
  });
  assert.ok(issued.ok);
  const login = await prisma.emailLoginAttempt.create({
    data: {
      email,
      codeHash: "hash",
      linkTokenHash: randomUUID(),
      expiresAt: later(issuedAt, 600_000),
      consumedAt: later(issuedAt),
      createdAt: later(issuedAt),
    },
  });
  const user = await prisma.user.create({
    data: { email, createdAt: later(issuedAt, 2_000) },
    select: { id: true },
  });

  const result = await finalizeSignupConsentAttempt({
    userId: user.id,
    createdBySignIn: true,
    emailLoginAttemptId: login.id,
    attemptId: issued.attemptId,
    nonce: issued.nonce,
  });
  assert.deepEqual(result, { ok: true, confirmationRequested: false });
  const attempt = await prisma.signupConsentAttempt.findUniqueOrThrow({ where: { id: issued.attemptId } });
  assert.equal(attempt.bindingEmailLoginAttemptId, login.id);
  // The refusal is recorded; nothing was requested.
  assert.equal(
    await prisma.emailPermissionEvent.count({ where: { userId: user.id, kind: "objected" } }),
    1
  );
  assert.equal(await prisma.consentRecord.count({ where: { userId: user.id } }), 0);
});

test("a superseded choice is not consumed, and the replacing one is", async () => {
  const issuedAt = new Date();
  const first = await issueSignupConsentAttempt({
    channel: "oauth",
    provider: "google",
    expressOptInRequested: true,
    objected: false,
    language: "en",
    ipCountry: "AU",
    now: issuedAt,
  });
  assert.ok(first.ok);
  const second = await issueSignupConsentAttempt({
    channel: "oauth",
    provider: "google",
    expressOptInRequested: false,
    objected: false,
    language: "en",
    ipCountry: "AU",
    supersede: { attemptId: first.attemptId, nonce: first.nonce },
    now: issuedAt,
  });
  assert.ok(second.ok);
  const user = await oauthAccount(later(issuedAt));
  assert.deepEqual(
    await finalizeSignupConsentAttempt({ userId: user.id, createdBySignIn: true, attemptId: first.attemptId, nonce: first.nonce }),
    { ok: false, reason: "not_pending" }
  );
  assert.deepEqual(
    await finalizeSignupConsentAttempt({ userId: user.id, createdBySignIn: true, attemptId: second.attemptId, nonce: second.nonce }),
    { ok: true, confirmationRequested: false }
  );
});

test("without a country, or a confirmation that can be sent, there is no choice to store", async () => {
  // The page shows no devices then (signupConsentAvailable), and the issue
  // route refuses the same way: a ticked box must end in a confirmation mail.
  for (const ipCountry of ["XX", "T1", null]) {
    assert.deepEqual(
      await issueSignupConsentAttempt({
        channel: "oauth",
        provider: "google",
        expressOptInRequested: true,
        objected: false,
        language: "ko",
        ipCountry,
        now: new Date(),
      }),
      { ok: false, reason: "disabled" },
      String(ipCountry)
    );
  }
  await setEmailFeatureFlag(EMAIL_CONSENT_CONFIRMATION_FLAG_KEY, false);
  assert.deepEqual(
    await issueSignupConsentAttempt({
      channel: "oauth",
      provider: "google",
      expressOptInRequested: true,
      objected: false,
      language: "ko",
      ipCountry: "AU",
      now: new Date(),
    }),
    { ok: false, reason: "disabled" }
  );
  assert.equal(await prisma.signupConsentAttempt.count(), 0);
});

test("an opt-in whose confirmation cannot be requested rolls back, and can be finalized later", async () => {
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
  const user = await oauthAccount(later(issuedAt));

  // The confirmation lane goes away between the screen and the landing.
  await setEmailFeatureFlag(EMAIL_CONSENT_CONFIRMATION_FLAG_KEY, false);
  assert.deepEqual(
    await finalizeSignupConsentAttempt({ userId: user.id, createdBySignIn: true, attemptId: issued.attemptId, nonce: issued.nonce }),
    { ok: false, reason: "confirmation_unavailable" }
  );
  // Nothing of it committed: the attempt is still pending, and no notice, no
  // estimate and no consent history exist.
  const pending = await prisma.signupConsentAttempt.findUniqueOrThrow({ where: { id: issued.attemptId } });
  assert.equal(pending.consumedAt, null);
  assert.equal(pending.userId, null);
  assert.equal(await prisma.emailPermissionEvent.count({ where: { userId: user.id } }), 0);
  assert.equal(await prisma.userSettings.count({ where: { userId: user.id } }), 0);
  assert.equal(await prisma.consentRecord.count({ where: { userId: user.id } }), 0);
  // Not even the default preference rows: seeding happens only on the path
  // that goes on to request.
  assert.equal(await prisma.emailPreference.count({ where: { userId: user.id } }), 0);

  await setEmailFeatureFlag(EMAIL_CONSENT_CONFIRMATION_FLAG_KEY, true);
  assert.deepEqual(
    await finalizeSignupConsentAttempt({ userId: user.id, createdBySignIn: true, attemptId: issued.attemptId, nonce: issued.nonce }),
    { ok: true, confirmationRequested: true }
  );
});

test("only the row the sign-up spent binds, not any row for the address (v25)", async () => {
  // docs/policy/email-product-news-redesign-draft.md section 5.2a. A
  // reactivation or an earlier sign-in's code, consumed after the choice, used
  // to satisfy "consumed since". The binding is now the one row the sign-in
  // that created the account names in its token.
  const issuedAt = new Date();
  const email = `${randomUUID()}@example.test`;
  const issued = await issueSignupConsentAttempt({
    channel: "email_code",
    email,
    expressOptInRequested: false,
    objected: false,
    language: "en",
    ipCountry: "US",
    now: issuedAt,
  });
  assert.ok(issued.ok);
  const other = await prisma.emailLoginAttempt.create({
    data: {
      email,
      codeHash: "hash",
      linkTokenHash: randomUUID(),
      expiresAt: later(issuedAt, 600_000),
      createdAt: new Date(issuedAt.getTime() - 1_000),
      consumedAt: new Date(issuedAt.getTime() - 500),
    },
  });
  const user = await prisma.user.create({
    data: { email, createdAt: later(issuedAt, 2_000) },
    select: { id: true },
  });
  // The session named no row.
  assert.deepEqual(
    await finalizeSignupConsentAttempt({ userId: user.id, createdBySignIn: true, attemptId: issued.attemptId, nonce: issued.nonce }),
    { ok: false, reason: "binding_mismatch" }
  );
  // The row it names was spent before the choice.
  assert.deepEqual(
    await finalizeSignupConsentAttempt({
      userId: user.id,
      createdBySignIn: true,
      emailLoginAttemptId: other.id,
      attemptId: issued.attemptId,
      nonce: issued.nonce,
    }),
    { ok: false, reason: "binding_mismatch" }
  );
});

test("a code proved on the sign-in screen binds when its hold is spent after the choice (v25)", async () => {
  // Requested and proved before the choice existed; the row is consumed and
  // held. The sign-up step stores the choice, then spends the hold.
  const email = `${randomUUID()}@example.test`;
  const requestedAt = new Date(Date.now() - 60_000);
  const held = await prisma.emailLoginAttempt.create({
    data: {
      email,
      codeHash: "hash",
      linkTokenHash: randomUUID(),
      createdAt: requestedAt,
      expiresAt: later(requestedAt, 600_000),
      consumedAt: later(requestedAt, 1_000),
      signupHoldUntil: later(requestedAt, 600_000),
    },
  });
  const issuedAt = new Date();
  const issued = await issueSignupConsentAttempt({
    channel: "email_code",
    email,
    expressOptInRequested: false,
    objected: false,
    language: "en",
    ipCountry: "US",
    now: issuedAt,
  });
  assert.ok(issued.ok);
  await prisma.emailLoginAttempt.update({
    where: { id: held.id },
    data: { signupHoldUsedAt: later(issuedAt, 1_000) },
  });
  const user = await prisma.user.create({
    data: { email, createdAt: later(issuedAt, 2_000) },
    select: { id: true },
  });
  assert.deepEqual(
    await finalizeSignupConsentAttempt({
      userId: user.id,
      createdBySignIn: true,
      emailLoginAttemptId: held.id,
      attemptId: issued.attemptId,
      nonce: issued.nonce,
    }),
    { ok: true, confirmationRequested: false }
  );
});

test("the database refuses a hold on an unconsumed row and a use without a hold", async () => {
  const base = {
    email: `${randomUUID()}@example.test`,
    codeHash: "hash",
    expiresAt: later(new Date(), 600_000),
  };
  await assert.rejects(
    prisma.emailLoginAttempt.create({
      data: { ...base, linkTokenHash: randomUUID(), signupHoldUntil: later(new Date(), 600_000) },
    })
  );
  await assert.rejects(
    prisma.emailLoginAttempt.create({
      data: { ...base, linkTokenHash: randomUUID(), consumedAt: new Date(), signupHoldUsedAt: new Date() },
    })
  );
});

test("an estimate whose country has no profile is recorded on the notice as unresolved", async () => {
  // Japan has no jurisdiction profile: the send verdicts hold it back, and
  // the permanent notice row must not record it as settled.
  const issuedAt = new Date();
  const issued = await issueSignupConsentAttempt({
    channel: "oauth",
    provider: "google",
    expressOptInRequested: false,
    objected: false,
    language: "en",
    ipCountry: "JP",
    now: issuedAt,
  });
  assert.ok(issued.ok);
  const user = await oauthAccount(later(issuedAt));
  assert.deepEqual(
    await finalizeSignupConsentAttempt({ userId: user.id, createdBySignIn: true, attemptId: issued.attemptId, nonce: issued.nonce }),
    { ok: true, confirmationRequested: false }
  );
  const shown = await prisma.emailPermissionEvent.findFirstOrThrow({
    where: { userId: user.id, kind: "notice_shown" },
  });
  assert.deepEqual([shown.jurisdiction, shown.jurisdictionSource], ["ZZ", "unresolved"]);
});

test("a wrong nonce, and a switched-off gate, consume nothing", async () => {
  const issuedAt = new Date();
  const issued = await issueSignupConsentAttempt({
    channel: "oauth",
    provider: "google",
    expressOptInRequested: false,
    objected: false,
    language: "en",
    ipCountry: "AU",
    now: issuedAt,
  });
  assert.ok(issued.ok);
  const user = await oauthAccount(later(issuedAt));
  assert.deepEqual(
    await finalizeSignupConsentAttempt({ userId: user.id, createdBySignIn: true, attemptId: issued.attemptId, nonce: "wrong" }),
    { ok: false, reason: "not_found" }
  );
  await setEmailFeatureFlag(EMAIL_SIGNUP_CONSENT_FLAG_KEY, false);
  assert.deepEqual(
    await finalizeSignupConsentAttempt({ userId: user.id, createdBySignIn: true, attemptId: issued.attemptId, nonce: issued.nonce }),
    { ok: false, reason: "disabled" }
  );
  assert.deepEqual(
    await issueSignupConsentAttempt({
      channel: "oauth",
      provider: "google",
      expressOptInRequested: false,
      objected: false,
      ipCountry: "AU",
    }),
    { ok: false, reason: "disabled" }
  );
});

test("an estimate never replaces a declaration, and replaces an earlier estimate", async () => {
  const declared = await prisma.user.create({ data: { email: `${randomUUID()}@example.test` } });
  await prisma.userSettings.create({
    data: { userId: declared.id, country: "KR", countrySource: "self_declared", countryUpdatedAt: new Date() },
  });
  assert.deepEqual(await recordSignInEstimatedCountry({ userId: declared.id, ipCountry: "AU" }), {
    recorded: false,
  });
  const kept = await prisma.userSettings.findUniqueOrThrow({ where: { userId: declared.id } });
  assert.deepEqual([kept.country, kept.countrySource], ["KR", "self_declared"]);

  const estimated = await prisma.user.create({ data: { email: `${randomUUID()}@example.test` } });
  assert.deepEqual(await recordSignInEstimatedCountry({ userId: estimated.id, ipCountry: "AU" }), {
    recorded: true,
  });
  assert.deepEqual(await recordSignInEstimatedCountry({ userId: estimated.id, ipCountry: "NZ" }), {
    recorded: true,
  });
  const moved = await prisma.userSettings.findUniqueOrThrow({ where: { userId: estimated.id } });
  assert.deepEqual([moved.country, moved.countrySource], ["NZ", "ip_estimated"]);
});

test("an account another tab's sign-up created is not this sign-in's to consume", async () => {
  // Tab A stores a choice; tab B signs up and creates the account; tab A then
  // signs into it with the marker. The account is new and matches the binding,
  // but tab A's session did not create it.
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
  const user = await oauthAccount(later(issuedAt));
  assert.deepEqual(
    await finalizeSignupConsentAttempt({
      userId: user.id,
      createdBySignIn: false,
      attemptId: issued.attemptId,
      nonce: issued.nonce,
    }),
    { ok: false, reason: "not_created_by_this_sign_in" }
  );
  assert.equal(await prisma.emailPermissionEvent.count({ where: { userId: user.id } }), 0);
});

test("the attempt is stamped with the clock the account rows are stamped with", async () => {
  // No \`now\`: the attempt takes LOCALTIMESTAMP, the value the column default
  // stores, and an account the database then creates by its own default is
  // created at or after it.
  const issued = await issueSignupConsentAttempt({
    channel: "oauth",
    provider: "google",
    expressOptInRequested: false,
    objected: false,
    language: "en",
    ipCountry: "AU",
  });
  assert.ok(issued.ok);
  const user = await prisma.user.create({
    data: { email: `${randomUUID()}@example.test` },
    select: { id: true },
  });
  await prisma.account.create({
    data: { userId: user.id, type: "oauth", provider: "google", providerAccountId: randomUUID() },
  });
  const [attempt, account] = await Promise.all([
    prisma.signupConsentAttempt.findUniqueOrThrow({ where: { id: issued.attemptId } }),
    prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { createdAt: true } }),
  ]);
  assert.ok(account.createdAt!.getTime() >= attempt.createdAt.getTime());
  assert.deepEqual(
    await finalizeSignupConsentAttempt({
      userId: user.id,
      createdBySignIn: true,
      attemptId: issued.attemptId,
      nonce: issued.nonce,
    }),
    { ok: true, confirmationRequested: false }
  );
});

test("a retry after a consumed answer was lost is answered as consumed", async () => {
  const issuedAt = new Date();
  const issued = await issueSignupConsentAttempt({
    channel: "oauth",
    provider: "google",
    expressOptInRequested: false,
    objected: false,
    language: "en",
    ipCountry: "AU",
    now: issuedAt,
  });
  assert.ok(issued.ok);
  const user = await oauthAccount(later(issuedAt));
  const finalize = () =>
    finalizeSignupConsentAttempt({
      userId: user.id,
      createdBySignIn: true,
      attemptId: issued.attemptId,
      nonce: issued.nonce,
    });
  assert.equal((await finalize()).ok, true);
  // The same account again: consumed, not refused -- and nothing written twice.
  assert.equal((await finalize()).ok, true);
  assert.equal(
    await prisma.emailPermissionEvent.count({ where: { userId: user.id, kind: "notice_shown" } }),
    1
  );
});
