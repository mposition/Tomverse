import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, mock, test } from "node:test";

import { prisma } from "@/lib/prisma";
import {
  EMAIL_CONSENT_CONFIRMATION_FLAG_KEY,
  EMAIL_SIGNUP_CONSENT_FLAG_KEY,
} from "@/lib/emailFeatureFlags";
import { activatePolicyVersion, ensureJurisdictionPolicyDraft } from "@/lib/emailJurisdictionPolicy";
import { setEmailPolicyPublishedForTests } from "@/lib/emailPolicyPublication";
import { finalizeSignupConsentAttempt, issueSignupConsentAttempt } from "@/lib/signupConsent";
import { auRelationshipForSend, recordRelationshipEnded } from "@/lib/auRelationship";
import { scheduleTomverseAccountDeletion } from "@/lib/accountDeletion";
import { endDormantEmailRelationshipAtSignIn } from "@/lib/emailPreferences";
import { setEmailFeatureFlag } from "../support/emailFeatureFlag";

// The Australian relationship (S5b).
//
// Contract: docs/policy/email-product-news-redesign-draft.md section 4.4 and
// lib/auRelationshipCore.ts.
//
// What only the database shows: that no sign-up starts a relationship while
// every approved notice promises "only if you ask"; that a recorded start is
// read back as active only for the account and mailbox it was recorded for;
// and that a deletion request ends it in the same transaction, once.

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

let policyVersionId = "";
const MONTH_MS = 31 * 24 * 60 * 60 * 1_000;

beforeEach(async () => {
  await reset();
  mock.restoreAll();
  setEmailPolicyPublishedForTests(true);
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
  const draft = await ensureJurisdictionPolicyDraft();
  await activatePolicyVersion({
    versionId: draft.version.id,
    actorId: randomUUID(),
    actorEmail: "ops@example.test",
  });
  policyVersionId = draft.version.id;
});

after(async () => {
  mock.restoreAll();
  setEmailPolicyPublishedForTests(null);
  delete process.env.EMAIL_CONSENT_KEYS;
  await reset();
  await prisma.$disconnect();
});

const account = (lastLoginAt: Date | null = new Date()) =>
  prisma.user.create({
    data: { email: `rel-${randomUUID().slice(0, 8)}@example.test`, lastLoginAt },
    select: { id: true, email: true },
  });

const startedFor = (user: { id: string; email: string | null }) =>
  prisma.emailPermissionEvent.create({
    data: {
      userId: user.id,
      emailAddress: user.email!,
      addressNormalizationVersion: "v1",
      kind: "relationship_started",
      scopeKey: "marketing",
      occurredAt: new Date(Date.now() - 60_000),
      capturedVia: "signup_form",
      sourceEventKey: `relationship:started:${user.id}`,
      policyVersionId,
      evidence: { copyVersion: "fixture" },
    },
    select: { id: true },
  });

const standing = (user: { id: string; email: string | null }, deliveryAddress = user.email!) =>
  auRelationshipForSend({
    userId: user.id,
    deliveryAddress,
    consentWithdrawn: false,
    amendmentInForce: true,
    now: new Date(),
  });

test("no sign-up starts a relationship while every approved notice promises only-if-you-ask", async () => {
  // The amendment is forced published here; the copy is what refuses.
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
  const user = await prisma.user.create({
    data: { email: `${randomUUID()}@example.test`, createdAt: new Date(issuedAt.getTime() + 1_000) },
    select: { id: true },
  });
  await prisma.account.create({
    data: { userId: user.id, type: "oauth", provider: "google", providerAccountId: randomUUID() },
  });
  const result = await finalizeSignupConsentAttempt({
    userId: user.id,
    attemptId: issued.attemptId,
    nonce: issued.nonce,
  });
  assert.equal(result.ok, true);
  assert.equal(
    await prisma.emailPermissionEvent.count({
      where: { userId: user.id, kind: "relationship_started" },
    }),
    0
  );
});

test("a recorded start stands for its own account and mailbox, and a stale sign-in ends it", async () => {
  const user = await account();
  const started = await startedFor(user);
  assert.deepEqual(await standing(user), { active: true, eventId: started.id });
  assert.deepEqual(await standing(user, "other@example.test"), {
    active: false,
    reason: "address_changed",
  });

  const other = await account();
  assert.deepEqual(await standing(other), { active: false, reason: "no_relationship" });

  const dormant = await account(new Date(Date.now() - 25 * MONTH_MS));
  await startedFor(dormant);
  assert.deepEqual(await standing(dormant), { active: false, reason: "dormant" });
});

test("a deletion request ends the relationship in its own transaction, once", async () => {
  const user = await account();
  const started = await startedFor(user);

  const scheduled = await scheduleTomverseAccountDeletion(user.id);
  assert.equal(scheduled.scheduled, true);

  const ended = await prisma.emailPermissionEvent.findMany({
    where: { userId: user.id, kind: "relationship_ended" },
    select: { sourceEventKey: true, capturedVia: true, scopeKey: true, emailAddress: true },
  });
  assert.deepEqual(ended, [
    {
      sourceEventKey: `relationship:ended:${started.id}`,
      capturedVia: "system",
      scopeKey: "marketing",
      emailAddress: user.email,
    },
  ]);
  assert.deepEqual(await standing(user), { active: false, reason: "relationship_ended" });

  // Final: restoring the account does not restart it, and a second end is a no-op.
  await prisma.user.update({
    where: { id: user.id },
    data: {
      accountStatus: "active",
      accountDeletionRequestedAt: null,
      accountDeletionScheduledFor: null,
    },
  });
  assert.deepEqual(await standing(user), { active: false, reason: "relationship_ended" });
  const again = await prisma.$transaction((tx) =>
    recordRelationshipEnded(tx, {
      userId: user.id,
      reason: "account_deletion_requested",
      occurredAt: new Date(),
    })
  );
  assert.deepEqual(again, { recorded: false });
});

test("an account without a relationship is scheduled for deletion without writing one", async () => {
  const user = await account();
  await scheduleTomverseAccountDeletion(user.id);
  assert.equal(await prisma.emailPermissionEvent.count({ where: { userId: user.id } }), 0);
});

test("the dormancy clock never runs from before the relationship started", async () => {
  // A last sign-in older than the relationship does not make it dormant: the
  // relationship began a minute ago.
  const lastLoginAt = new Date(Date.now() - 25 * MONTH_MS);
  const user = await account(lastLoginAt);
  await startedFor(user);
  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const ended = await endDormantEmailRelationshipAtSignIn(tx, {
      userId: user.id,
      previousLastLoginAt: lastLoginAt,
      now,
    });
    await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: now } });
    return ended;
  });
  assert.deepEqual(result, { ended: false });
});

test("a relationship older than 24 months ends at the sign-in, once", async () => {
  const user = await account(null);
  const old = new Date(Date.now() - 26 * MONTH_MS);
  const started = await prisma.emailPermissionEvent.create({
    data: {
      userId: user.id,
      emailAddress: user.email!,
      addressNormalizationVersion: "v1",
      kind: "relationship_started",
      scopeKey: "marketing",
      occurredAt: old,
      capturedVia: "signup_form",
      sourceEventKey: `relationship:started:${user.id}`,
      policyVersionId,
      evidence: { copyVersion: "fixture" },
    },
    select: { id: true },
  });
  const now = new Date();
  const signIn = () =>
    prisma.$transaction(async (tx) => {
      const ended = await endDormantEmailRelationshipAtSignIn(tx, {
        userId: user.id,
        previousLastLoginAt: new Date(old.getTime() + 60_000),
        now,
      });
      await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: now } });
      return ended;
    });
  assert.deepEqual(await signIn(), { ended: true });
  assert.deepEqual(await signIn(), { ended: false });
  const ended = await prisma.emailPermissionEvent.findMany({
    where: { userId: user.id, kind: "relationship_ended" },
    select: { sourceEventKey: true, evidence: true },
  });
  assert.equal(ended.length, 1);
  assert.equal(ended[0]!.sourceEventKey, `relationship:ended:${started.id}`);
  assert.equal((ended[0]!.evidence as { reason: string }).reason, "dormant");
  // lastLoginAt is fresh now, and the relationship stays ended.
  assert.deepEqual(await standing(user), { active: false, reason: "relationship_ended" });
});
