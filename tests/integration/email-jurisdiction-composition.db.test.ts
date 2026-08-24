import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, mock, test } from "node:test";

import { ACCOUNT_WELCOME_TEMPLATE } from "@/lib/emailTemplateDefinitions";
import {
  activatePolicyVersion,
  ensureJurisdictionPolicyDraft,
} from "@/lib/emailJurisdictionPolicy";
import { prisma } from "@/lib/prisma";
import {
  drainStandardEmailDeliveries,
  enqueueStandardEmail,
} from "@/lib/standardEmailLane";

// The subject prefix and the jurisdiction footer, applied at send time (EM-04).
//
// Contract: docs/policy/email-notifications.md §5.2 E1-E3, §8.5, §12.5.
//
// The pure cases live in tests/emailJurisdictionComposition.test.mjs. What only
// a database can answer is which profile a message is composed against: the row
// pins a policy version at enqueue, and the point of that pin is that
// activating a new policy afterwards must not change what an already-queued
// message says. Everything else about the pin is decoration if this does not
// hold.
//
// Assertions are made against the body actually handed to the provider rather
// than against a return value, because that is the artefact the recipient sees.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "EmailDelivery", "EmailEvent", "TemplateVersion", "EmailTemplate",
      "JurisdictionCountryMap", "JurisdictionProfile", "EmailPolicyVersion",
      "User"
    RESTART IDENTITY CASCADE
  `);

type SentBody = { subject: string; html: string; text: string };

const stubProvider = () => {
  const bodies: SentBody[] = [];
  mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as SentBody);
    return new Response(JSON.stringify({ id: `resend-${randomUUID()}` }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return bodies;
};

const IDENTITY_ENV = {
  EMAIL_BUSINESS_LEGAL_NAME: "Tomverse Pty Ltd",
  EMAIL_BUSINESS_POSTAL_ADDRESS: "1 Example Street, Brisbane QLD 4000",
  EMAIL_BUSINESS_CONTACT_EMAIL: "support@tomverse.app",
  EMAIL_BUSINESS_REGISTRATION_NUMBER: "000-00-00000",
  EMAIL_BUSINESS_MAIL_ORDER_REGISTRATION_NUMBER: "2026-Seoul-00000",
  EMAIL_BUSINESS_ABN: "00 000 000 000",
};

const setIdentity = () => {
  for (const [key, value] of Object.entries(IDENTITY_ENV)) process.env[key] = value;
};
const clearIdentity = () => {
  for (const key of Object.keys(IDENTITY_ENV)) delete process.env[key];
};

beforeEach(async () => {
  await reset();
  mock.restoreAll();
  process.env.EMAIL_AUDIT_HASH_KEY = "test-audit-key";
  process.env.EMAIL_SNAPSHOT_KEYS = "v1:test-snapshot-key";
  process.env.EMAIL_SNAPSHOT_KEY_VERSION = "v1";
  process.env.RESEND_API_KEY = "test-key";
  setIdentity();
});

after(async () => {
  mock.restoreAll();
  clearIdentity();
  await reset();
  await prisma.$disconnect();
});

const someone = () =>
  prisma.user.create({
    data: { email: `${randomUUID()}@example.com`, name: "Someone" },
  });

/** The eight seeded profiles, activated the way a human would activate them. */
const activateSeededPolicy = async () => {
  const draft = await ensureJurisdictionPolicyDraft();
  await activatePolicyVersion({
    versionId: draft.version.id,
    actorId: randomUUID(),
    actorEmail: "ops@example.test",
  });
  return draft.version.id;
};

const queueWelcome = async (profileKey?: string) => {
  const user = await someone();
  const rows = await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress: user.email,
    userId: user.id,
    language: "en",
    payload: { name: user.name },
  });
  assert.ok(rows);
  if (profileKey) {
    // The resolver decides this from the account's own signals, and this suite
    // is not testing the resolver. Setting the pinned key directly is how the
    // profile branch gets exercised without inventing a billing country.
    await prisma.emailDelivery.update({
      where: { id: rows.deliveryId },
      data: { jurisdictionProfileKey: profileKey },
    });
  }
  return rows.deliveryId;
};

test("a transactional message carries the business identity footer", async () => {
  await activateSeededPolicy();
  const bodies = stubProvider();
  await queueWelcome("ZZ");

  await drainStandardEmailDeliveries({ limit: 1 });

  assert.equal(bodies.length, 1);
  assert.ok(bodies[0].text.includes(IDENTITY_ENV.EMAIL_BUSINESS_LEGAL_NAME));
  assert.ok(bodies[0].text.includes(IDENTITY_ENV.EMAIL_BUSINESS_POSTAL_ADDRESS));
  assert.ok(bodies[0].html.includes(IDENTITY_ENV.EMAIL_BUSINESS_LEGAL_NAME));
});

test("it carries no advertising label, even under the Korean profile", async () => {
  await activateSeededPolicy();
  const bodies = stubProvider();
  await queueWelcome("KR");

  await drainStandardEmailDeliveries({ limit: 1 });

  assert.equal(bodies.length, 1);
  assert.doesNotMatch(bodies[0].subject, /광고/);
  // The Korean profile's own blocks do reach it: this is the footer set that
  // 정보통신망법 asks for, minus the parts that belong to advertising.
  assert.ok(bodies[0].text.includes(IDENTITY_ENV.EMAIL_BUSINESS_REGISTRATION_NUMBER));
  assert.ok(
    bodies[0].text.includes(IDENTITY_ENV.EMAIL_BUSINESS_MAIL_ORDER_REGISTRATION_NUMBER)
  );
});

test("and no unsubscribe link, though the profile names one", async () => {
  await activateSeededPolicy();
  const bodies = stubProvider();
  await queueWelcome("KR");

  await drainStandardEmailDeliveries({ limit: 1 });

  assert.doesNotMatch(bodies[0].text, /\/unsubscribe\?t=/);
  assert.doesNotMatch(bodies[0].html, /\/unsubscribe\?t=/);
});

test("the message is composed against the pinned version, not the active one", async () => {
  const pinnedVersionId = await activateSeededPolicy();
  const deliveryId = await queueWelcome("KR");
  const pinned = await prisma.emailDelivery.findUniqueOrThrow({
    where: { id: deliveryId },
    select: { policyVersionId: true },
  });
  assert.equal(pinned.policyVersionId, pinnedVersionId);

  // A second policy version, activated after the message was queued, whose KR
  // footer says less. The queued message must not acquire it.
  const successor = await prisma.emailPolicyVersion.create({
    data: {
      version: `2026-08-23.successor.${randomUUID().slice(0, 8)}`,
      status: "draft",
      changeSummary: "A later policy the queued message was not enqueued under.",
    },
    select: { id: true },
  });
  await prisma.jurisdictionProfile.create({
    data: {
      policyVersionId: successor.id,
      profileKey: "KR",
      marketingBasis: "opt_in",
      subjectPrefix: "(광고)",
      footerBlocks: ["legal_name"],
      unsubscribeSlaBusinessDays: 1,
      notes: "Successor profile for the pinning test.",
    },
  });
  await activatePolicyVersion({
    versionId: successor.id,
    actorId: randomUUID(),
    actorEmail: "ops@example.test",
  });

  const bodies = stubProvider();
  await drainStandardEmailDeliveries({ limit: 1 });

  assert.equal(bodies.length, 1);
  // The successor names legal_name alone. The registration numbers prove the
  // pinned version was the one read.
  assert.ok(bodies[0].text.includes(IDENTITY_ENV.EMAIL_BUSINESS_REGISTRATION_NUMBER));
});

test("an unconfigured identity costs the footer, not the message", async () => {
  await activateSeededPolicy();
  clearIdentity();
  const bodies = stubProvider();
  const deliveryId = await queueWelcome("ZZ");

  await drainStandardEmailDeliveries({ limit: 1 });

  assert.equal(bodies.length, 1, "the message still went out");
  assert.doesNotMatch(bodies[0].text, /Pty Ltd/);
  const delivery = await prisma.emailDelivery.findUniqueOrThrow({
    where: { id: deliveryId },
    select: { status: true, skipReason: true },
  });
  assert.equal(delivery.status, "sent");
  assert.equal(delivery.skipReason, null);
});

test("with no jurisdiction policy activated at all, the message still sends", async () => {
  // The bootstrap policy version carries no profiles until a human activates
  // the seeded one (§12.5). Transactional mail predates that activation and
  // must not wait for it.
  const bodies = stubProvider();
  const deliveryId = await queueWelcome();

  await drainStandardEmailDeliveries({ limit: 1 });

  assert.equal(bodies.length, 1);
  const delivery = await prisma.emailDelivery.findUniqueOrThrow({
    where: { id: deliveryId },
    select: { status: true },
  });
  assert.equal(delivery.status, "sent");
});

test("the database accepts the two labelling skip reasons", async () => {
  // The refusal path is marketing-only and no marketing template is registered,
  // so the branch cannot be reached end to end here. What can be checked is
  // that the column will hold the values the composition step produces -- a
  // CHECK that had not been extended would turn a correct refusal into a crash.
  await activateSeededPolicy();
  const deliveryId = await queueWelcome("ZZ");
  for (const reason of ["jurisdiction_profile_missing", "jurisdiction_footer_incomplete"]) {
    await prisma.emailDelivery.update({
      where: { id: deliveryId },
      data: { status: "skipped", skipReason: reason },
    });
    const row = await prisma.emailDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
      select: { skipReason: true },
    });
    assert.equal(row.skipReason, reason);
  }
});
