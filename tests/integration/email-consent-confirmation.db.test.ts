import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, mock, test } from "node:test";

import { prisma } from "@/lib/prisma";
import {
  confirmConsent,
  requestConsentConfirmation,
} from "@/lib/emailConsentConfirmation";
import {
  CONSENT_CONFIRMATION_TTL_MS,
  consentAddressDigest,
  createConsentToken,
  readConsentKeyring,
} from "@/lib/emailConsentToken";
import { EMAIL_CONSENT_CONFIRMATION_FLAG_KEY } from "@/lib/emailFeatureFlags";
import {
  activatePolicyVersion,
  ensureJurisdictionPolicyDraft,
} from "@/lib/emailJurisdictionPolicy";
import { decryptSnapshot, readSnapshotKeyring } from "@/lib/emailSnapshotCrypto";
import { MARKETING_CONSENT_CONFIRMATION_TEMPLATE } from "@/lib/emailTemplateDefinitions";
import { readPreferences, setPreference } from "@/lib/emailPreferences";
import { createUnsubscribeToken, readUnsubscribeKeyring } from "@/lib/unsubscribeToken";
import { drainStandardEmailDeliveries } from "@/lib/standardEmailLane";
import { setEmailFeatureFlag } from "../support/emailFeatureFlag";

// The double opt-in, end to end against the tables.
//
// Contract: docs/policy/email-double-opt-in.md §3, §5, §8, §11 tests, §13.
//
// What only the database can show: that the request, its consent history entry
// and the queued confirmation mail commit together or not at all; that the
// mail is a transactional delivery and its link is never stored; that the click
// is what turns the preference on, under the policy the request was made
// under; and that a superseded, cancelled, expired, foreign or doubled click
// turns nothing on twice.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "EmailDelivery", "EmailEvent", "TemplateVersion", "EmailTemplate",
      "ConsentRecord", "EmailPreference", "SuppressionEntry",
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
  delete process.env.EMAIL_CONSENT_KEY_VERSION;
  process.env.RESEND_API_KEY = "test-key";
  process.env.TRANSACTIONAL_EMAIL_FROM = "Tomverse <no-reply@mail.tomverse.app>";
  delete process.env.MARKETING_EMAIL_FROM;
  await setEmailFeatureFlag(EMAIL_CONSENT_CONFIRMATION_FLAG_KEY, true);
});

after(async () => {
  mock.restoreAll();
  delete process.env.EMAIL_CONSENT_KEYS;
  await reset();
  await prisma.$disconnect();
});

const someone = () =>
  prisma.user.create({
    data: { email: `${randomUUID()}@example.test`, name: "Someone" },
  });

const request = (userId: string, now?: Date) =>
  requestConsentConfirmation({
    userId,
    purpose: "product_updates",
    capturedVia: "preference_center",
    confirmedCountry: "DE",
    jurisdiction: "DE",
    jurisdictionSource: "self_declared",
    ip: "203.0.113.7",
    ...(now ? { now } : {}),
  });

const preference = (userId: string) =>
  prisma.emailPreference.findUniqueOrThrow({
    where: { userId_purpose: { userId, purpose: "product_updates" } },
  });

/** The token the mailed link would carry for the row's current request. */
const currentToken = async (userId: string) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const row = await preference(userId);
  const requested = await prisma.consentRecord.findFirstOrThrow({
    where: { userId, action: "confirmation_requested" },
    orderBy: { occurredAt: "desc" },
  });
  return createConsentToken(
    {
      userId,
      purpose: "product_updates",
      requestedAt: row.confirmationRequestedAt!.toISOString(),
      requestId: row.confirmationRequestId!,
      policyVersionId: requested.policyVersionId,
      addressDigest: consentAddressDigest(user.email!),
    },
    readConsentKeyring(process.env)!,
    "v1"
  );
};

test("a request records itself and queues a transactional mail, and turns nothing on", async () => {
  const user = await someone();
  const result = await request(user.id);
  assert.equal(result.requested, true);

  const row = await preference(user.id);
  assert.equal(row.enabled, false, "the request must not be the consent");
  assert.equal(row.confirmedAt, null);
  assert.ok(row.confirmationRequestedAt);
  assert.ok(row.confirmationRequestId);

  const records = await prisma.consentRecord.findMany({
    select: { action: true, ipHash: true },
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].action, "confirmation_requested");
  assert.ok(records[0].ipHash, "the request's IP evidence is kept, hashed");
  assert.equal(records[0].ipHash!.includes("203.0.113.7"), false);

  const delivery = await prisma.emailDelivery.findFirstOrThrow({
    include: { templateVersion: { include: { template: true } } },
  });
  assert.equal(delivery.templateVersion.template.key, MARKETING_CONSENT_CONFIRMATION_TEMPLATE);
  assert.equal(delivery.templateVersion.template.classification, "transactional");
  assert.equal(delivery.templateVersion.template.requiresUnsubscribe, false);

  // The link is a capability and is never stored: the snapshot holds the
  // request's fields and no token or URL.
  const stored = decryptSnapshot(delivery.renderDataSnapshot, readSnapshotKeyring(process.env)!);
  const serialised = JSON.stringify(stored);
  assert.equal(serialised.includes("c1."), false);
  assert.equal(serialised.includes("/consent/confirm"), false);

  const state = await readPreferences(user.id);
  assert.equal(
    state.find((entry) => entry.purpose === "product_updates")?.confirmation,
    "pending"
  );
});

test("the mail carries the link in the fragment, and the audit record does not keep it", async () => {
  const user = await someone();
  await request(user.id);
  const calls: Array<{ from?: string; subject: string; text: string }> = [];
  mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ id: `resend-${randomUUID()}` }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const drain = await drainStandardEmailDeliveries({ limit: 5 });
  assert.equal(drain.sent, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].from ?? "", /mail\.tomverse\.app/);
  const link = calls[0].text.match(/https?:\/\/\S+\/consent\/confirm#t=(\S+)/);
  assert.ok(link, "the sent mail must carry a fragment link");
  assert.equal(decodeURIComponent(link[1]), await currentToken(user.id));

  // A retry renders the same bytes: the token is deterministic.
  assert.equal(decodeURIComponent(link[1]), await currentToken(user.id));
});

test("the click turns it on under the request's policy, and a second click grants nothing more", async () => {
  const user = await someone();
  const now = new Date();
  await request(user.id, now);
  const requestedUnder = (await prisma.consentRecord.findFirstOrThrow()).policyVersionId;
  const token = await currentToken(user.id);

  // A new policy becomes active between the request and the click.
  const draft = await ensureJurisdictionPolicyDraft();
  await activatePolicyVersion({
    versionId: draft.version.id,
    actorId: randomUUID(),
    actorEmail: "ops@example.test",
  });
  assert.notEqual(draft.version.id, requestedUnder);

  // Two clicks at once.
  const [first, second] = await Promise.all([
    confirmConsent({ token, ip: "203.0.113.8" }),
    confirmConsent({ token, ip: "203.0.113.8" }),
  ]);
  assert.equal(first.confirmed, true);
  assert.equal(second.confirmed, true);

  const row = await preference(user.id);
  assert.equal(row.enabled, true);
  assert.ok(row.confirmedAt);
  const grants = await prisma.consentRecord.findMany({ where: { action: "granted" } });
  assert.equal(grants.length, 1, "one grant for two clicks");
  // The person agreed under the policy they were shown, not the one active now.
  assert.equal(grants[0].policyVersionId, requestedUnder);
  assert.ok(grants[0].ipHash);
});

test("a key rotation between request and send does not change the link", async () => {
  const user = await someone();
  await request(user.id);
  const before = await currentToken(user.id);
  // v2 becomes active; v1 stays listed, as the rotation procedure requires.
  process.env.EMAIL_CONSENT_KEYS = "v2:rotated-consent-key,v1:test-consent-key";
  process.env.EMAIL_CONSENT_KEY_VERSION = "v2";
  const calls: Array<{ text: string }> = [];
  mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ id: `resend-${randomUUID()}` }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  await drainStandardEmailDeliveries({ limit: 5 });
  const link = calls[0]?.text.match(/\/consent\/confirm#t=(\S+)/);
  assert.ok(link);
  assert.equal(decodeURIComponent(link[1]), before);
  assert.match(before, /^c1\.v1\./);
  assert.equal((await confirmConsent({ token: before })).confirmed, true);
  delete process.env.EMAIL_CONSENT_KEY_VERSION;
});

test("a withdrawal right after a confirmation leaves the purpose off and suppressed", async () => {
  const user = await someone();
  await request(user.id);
  assert.equal((await confirmConsent({ token: await currentToken(user.id) })).confirmed, true);
  await setPreference({
    userId: user.id,
    purpose: "product_updates",
    enabled: false,
    capturedVia: "unsubscribe_page",
    source: "unsubscribe_link",
    viaToken: true,
  });
  assert.equal((await preference(user.id)).enabled, false);
  assert.equal(
    await prisma.suppressionEntry.count({
      where: { scope: "purpose", purposeKey: "product_updates", reason: "unsubscribe" },
    }),
    1
  );
});

test("a newer request supersedes the older link, even within the same millisecond", async () => {
  const user = await someone();
  const at = new Date();
  await request(user.id, at);
  const older = await currentToken(user.id);
  await request(user.id, at);

  const result = await confirmConsent({ token: older });
  assert.deepEqual(result, { confirmed: false, reason: "superseded" });
  assert.equal((await preference(user.id)).enabled, false);
});

test("cancelling while pending invalidates the link and writes no withdrawal", async () => {
  const user = await someone();
  await request(user.id);
  const token = await currentToken(user.id);
  const cancelled = await setPreference({
    userId: user.id,
    purpose: "product_updates",
    enabled: false,
    capturedVia: "preference_center",
    source: "preference_center",
  });
  assert.equal(cancelled.changed, true);

  const result = await confirmConsent({ token });
  assert.equal(result.confirmed, false);
  const row = await preference(user.id);
  assert.equal(row.enabled, false);
  assert.equal(row.confirmationRequestId, null);
  assert.equal(await prisma.consentRecord.count({ where: { action: "withdrawn" } }), 0);
});

test("a link mailed before the flag was switched off confirms nothing while it is off", async () => {
  const user = await someone();
  await request(user.id);
  const token = await currentToken(user.id);
  await setEmailFeatureFlag(EMAIL_CONSENT_CONFIRMATION_FLAG_KEY, false);

  assert.deepEqual(await confirmConsent({ token }), { confirmed: false, reason: "disabled" });
  assert.equal((await preference(user.id)).enabled, false);
});

test("an expired link confirms nothing", async () => {
  const user = await someone();
  const then = new Date(Date.now() - CONSENT_CONFIRMATION_TTL_MS - 60_000);
  await request(user.id, then);

  const result = await confirmConsent({ token: await currentToken(user.id) });
  assert.equal(result.confirmed, false);
  assert.equal(result.confirmed === false && result.reason, "expired");
  assert.equal((await preference(user.id)).enabled, false);
});

test("an unsubscribe token cannot confirm, and another person's request cannot reach this one", async () => {
  const owner = await someone();
  const other = await someone();
  await request(owner.id);
  await request(other.id);

  const unsubscribe = createUnsubscribeToken(
    { userId: owner.id, purpose: "product_updates" },
    readUnsubscribeKeyring(process.env)!
  );
  assert.deepEqual(await confirmConsent({ token: unsubscribe }), {
    confirmed: false,
    reason: "invalid",
    tokenReason: { valid: false, reason: "malformed" },
  });

  // The other account's token names the other account; confirming it changes
  // only that account.
  assert.equal((await confirmConsent({ token: await currentToken(other.id) })).confirmed, true);
  assert.equal((await preference(owner.id)).enabled, false);
});

test("a changed address invalidates the link", async () => {
  const user = await someone();
  await request(user.id);
  const token = await currentToken(user.id);
  await prisma.user.update({
    where: { id: user.id },
    data: { email: `${randomUUID()}@example.test` },
  });

  assert.deepEqual(await confirmConsent({ token }), {
    confirmed: false,
    reason: "address_changed",
  });
});

test("if the mail cannot be queued, the request and its history roll back with it", async () => {
  const user = await someone();
  // The snapshot cannot be sealed, so the enqueue inside the transaction throws.
  delete process.env.EMAIL_SNAPSHOT_KEYS;
  delete process.env.EMAIL_SNAPSHOT_KEY_VERSION;

  await assert.rejects(request(user.id));
  const row = await preference(user.id);
  assert.equal(row.confirmationRequestId, null);
  assert.equal(await prisma.consentRecord.count(), 0);
  assert.equal(await prisma.emailDelivery.count(), 0);
});

test("with the flag off nothing is requested and nothing is recorded", async () => {
  await setEmailFeatureFlag(EMAIL_CONSENT_CONFIRMATION_FLAG_KEY, false);
  const user = await someone();

  assert.deepEqual(await request(user.id), { requested: false, reason: "disabled" });
  assert.equal(await prisma.emailDelivery.count(), 0);
  assert.equal(await prisma.consentRecord.count(), 0);
});
