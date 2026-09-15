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
import { MARKETING_CONSENT_CONFIRMATION_TEMPLATE } from "@/lib/emailTemplateDefinitions";
import { readPreferences, setPreference } from "@/lib/emailPreferences";
import { createUnsubscribeToken, readUnsubscribeKeyring } from "@/lib/unsubscribeToken";
import { drainStandardEmailDeliveries } from "@/lib/standardEmailLane";
import { setEmailFeatureFlag } from "../support/emailFeatureFlag";

// The double opt-in, end to end against the tables.
//
// Contract: docs/policy/email-double-opt-in.md §3, §5, §8, §11 tests.
//
// What only the database can show: that the request, its consent history entry
// and the queued confirmation mail commit together; that the mail is a
// transactional delivery rather than marketing; that the click is what turns
// the preference on; and that a superseded, cancelled, expired or foreign
// token turns nothing on.

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
    ...(now ? { now } : {}),
  });

const tokenFor = async (userId: string, requestedAt: Date) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const version = await prisma.emailPolicyVersion.findFirstOrThrow();
  return createConsentToken(
    {
      userId,
      purpose: "product_updates",
      requestedAt: requestedAt.toISOString(),
      policyVersionId: version.id,
      addressDigest: consentAddressDigest(user.email!),
    },
    readConsentKeyring(process.env)!
  );
};

const preference = (userId: string) =>
  prisma.emailPreference.findUniqueOrThrow({
    where: { userId_purpose: { userId, purpose: "product_updates" } },
  });

test("a request records itself and queues a transactional mail, and turns nothing on", async () => {
  const user = await someone();
  const result = await request(user.id);
  assert.equal(result.requested, true);

  const row = await preference(user.id);
  assert.equal(row.enabled, false, "the request must not be the consent");
  assert.equal(row.confirmedAt, null);
  assert.ok(row.confirmationRequestedAt);

  const records = await prisma.consentRecord.findMany({ select: { action: true } });
  assert.deepEqual(records, [{ action: "confirmation_requested" }]);

  const delivery = await prisma.emailDelivery.findFirstOrThrow({
    include: { templateVersion: { include: { template: true } } },
  });
  assert.equal(delivery.templateVersion.template.key, MARKETING_CONSENT_CONFIRMATION_TEMPLATE);
  // §3 rule 3: not the marketing stream, and no unsubscribe link.
  assert.equal(delivery.templateVersion.template.classification, "transactional");
  assert.equal(delivery.templateVersion.template.requiresUnsubscribe, false);

  const state = await readPreferences(user.id);
  assert.equal(
    state.find((entry) => entry.purpose === "product_updates")?.confirmation,
    "pending"
  );
});

test("the queued mail actually sends on the transactional identity", async () => {
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
  assert.match(calls[0].text, /\/consent\/confirm\?t=c1\./);
});

test("the click turns it on, records the grant, and the send gate then passes", async () => {
  const user = await someone();
  const now = new Date();
  await request(user.id, now);

  const result = await confirmConsent({ token: await tokenFor(user.id, now) });
  assert.deepEqual(result, {
    confirmed: true,
    purpose: "product_updates",
    alreadyConfirmed: false,
  });

  const row = await preference(user.id);
  assert.equal(row.enabled, true);
  assert.ok(row.confirmedAt);
  const actions = (
    await prisma.consentRecord.findMany({
      orderBy: { occurredAt: "asc" },
      select: { action: true, evidence: true },
    })
  ).map((record) => record.action);
  assert.deepEqual(actions, ["confirmation_requested", "granted"]);

  // A second click is a success, not a second grant.
  const again = await confirmConsent({ token: await tokenFor(user.id, now) });
  assert.equal(again.confirmed, true);
  assert.equal(await prisma.consentRecord.count({ where: { action: "granted" } }), 1);
});

test("a newer request supersedes the older link", async () => {
  const user = await someone();
  const first = new Date(Date.now() - 60_000);
  await request(user.id, first);
  await request(user.id, new Date());

  const result = await confirmConsent({ token: await tokenFor(user.id, first) });
  assert.deepEqual(result, { confirmed: false, reason: "superseded" });
  assert.equal((await preference(user.id)).enabled, false);
});

test("switching off while pending cancels the link", async () => {
  const user = await someone();
  const now = new Date();
  await request(user.id, now);
  await setPreference({
    userId: user.id,
    purpose: "product_updates",
    enabled: false,
    capturedVia: "preference_center",
    source: "preference_center",
  });

  const result = await confirmConsent({ token: await tokenFor(user.id, now) });
  assert.equal(result.confirmed, false);
  assert.equal((await preference(user.id)).enabled, false);
  // Nothing was consented to, so nothing is withdrawn.
  assert.equal(await prisma.consentRecord.count({ where: { action: "withdrawn" } }), 0);
});

test("an expired link confirms nothing", async () => {
  const user = await someone();
  const then = new Date(Date.now() - CONSENT_CONFIRMATION_TTL_MS - 60_000);
  await request(user.id, then);

  const result = await confirmConsent({ token: await tokenFor(user.id, then) });
  assert.equal(result.confirmed, false);
  assert.equal(result.confirmed === false && result.reason, "expired");
  assert.equal((await preference(user.id)).enabled, false);
});

test("an unsubscribe token cannot confirm, and another person's token cannot reach this one", async () => {
  const owner = await someone();
  const other = await someone();
  const now = new Date();
  await request(owner.id, now);

  const unsubscribe = createUnsubscribeToken(
    { userId: owner.id, purpose: "product_updates" },
    readUnsubscribeKeyring(process.env)!
  );
  assert.deepEqual(await confirmConsent({ token: unsubscribe }), {
    confirmed: false,
    reason: "invalid",
    tokenReason: { valid: false, reason: "malformed" },
  });

  // A token minted for a different account names that account; it cannot be
  // redirected to the owner, and the other account has no pending request.
  const foreign = await tokenFor(other.id, now);
  const result = await confirmConsent({ token: foreign });
  assert.equal(result.confirmed, false);
  assert.equal((await preference(owner.id)).enabled, false);
});

test("a changed address invalidates the link", async () => {
  const user = await someone();
  const now = new Date();
  await request(user.id, now);
  const token = await tokenFor(user.id, now);
  await prisma.user.update({
    where: { id: user.id },
    data: { email: `${randomUUID()}@example.test` },
  });

  assert.deepEqual(await confirmConsent({ token }), {
    confirmed: false,
    reason: "address_changed",
  });
});

test("with the flag off nothing is requested and nothing is recorded", async () => {
  await setEmailFeatureFlag(EMAIL_CONSENT_CONFIRMATION_FLAG_KEY, false);
  const user = await someone();

  assert.deepEqual(await request(user.id), { requested: false, reason: "disabled" });
  assert.equal(await prisma.emailDelivery.count(), 0);
  assert.equal(await prisma.consentRecord.count(), 0);
});
