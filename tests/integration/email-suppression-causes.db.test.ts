import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { setPreference } from "@/lib/emailPreferences";
import { recordSuppression, removeSuppression } from "@/lib/emailSuppression";
import { processResendWebhook } from "@/lib/emailWebhookProcessing";
import { prisma } from "@/lib/prisma";

// Suppression causes written beside entries -- the shadow deploy.
//
// Contract: docs/policy/email-product-news-redesign-draft.md, section 7.4.
//
// Nothing decides a send from a cause yet. What has to hold now is that the
// causes never fall behind the entries: this build writes its own cause in the
// same transaction, a build that does not is carried by a trigger, and a cause
// is never edited or deleted once written. All of that lives in the database,
// so it is checked against one.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "SuppressionCause", "SuppressionEntry", "ProviderWebhookEvent",
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

const causesFor = (emailAddress: string) =>
  prisma.suppressionCause.findMany({
    where: { emailAddress },
    orderBy: { createdAt: "asc" },
  });

test("a suppression writes its cause once, however often the event is replayed", async () => {
  const emailAddress = address();
  const input = {
    emailAddress,
    reason: "hard_bounce" as const,
    source: "provider_webhook" as const,
    sourceStream: "transactional",
    sourceEventKey: `webhook:${randomUUID()}`,
  };
  await recordSuppression(input);
  await recordSuppression(input);

  const causes = await causesFor(emailAddress);
  assert.equal(causes.length, 1, "the marked write must not also be carried by the trigger");
  assert.equal(causes[0].reason, "hard_bounce");
  assert.equal(causes[0].providerAccount, "transactional");
  assert.equal(await prisma.suppressionEntry.count({ where: { emailAddress } }), 1);
});

test("an event the entry's merge rule declines is still recorded as a cause", async () => {
  const emailAddress = address();
  await recordSuppression({
    emailAddress,
    reason: "complaint",
    source: "provider_webhook",
    sourceEventKey: `webhook:${randomUUID()}`,
  });
  const softer = await recordSuppression({
    emailAddress,
    reason: "soft_bounce",
    source: "provider_webhook",
    expiresAt: new Date(Date.now() + 60_000),
    sourceEventKey: `softbounce:${randomUUID()}`,
  });

  assert.equal(softer.changed, false, "the entry keeps the complaint");
  const reasons = (await causesFor(emailAddress)).map((cause) => cause.reason).sort();
  assert.deepEqual(reasons, ["complaint", "soft_bounce"]);
});

test("a write from a build that does not write causes is carried by the trigger", async () => {
  const emailAddress = address();
  const id = randomUUID();

  // The previous build: a plain insert, then a strengthening update, then a
  // no-op update, then a lift -- none marking its transaction.
  await prisma.$executeRawUnsafe(
    `INSERT INTO "SuppressionEntry" ("id", "emailAddress", "scope", "purposeKey", "reason", "source", "occurredAt", "updatedAt")
     VALUES ($1, $2, 'global', '*', 'soft_bounce', 'provider_webhook', NOW(), NOW())`,
    id,
    emailAddress
  );
  await prisma.$executeRawUnsafe(
    `UPDATE "SuppressionEntry" SET "reason" = 'hard_bounce', "sourceMessageId" = 'm-2' WHERE "id" = $1`,
    id
  );
  await prisma.$executeRawUnsafe(
    `UPDATE "SuppressionEntry" SET "updatedAt" = NOW() WHERE "id" = $1`,
    id
  );

  let causes = await causesFor(emailAddress);
  assert.deepEqual(
    causes.map((cause) => cause.reason),
    ["soft_bounce", "hard_bounce"],
    "an insert and a provenance change each become a cause; a no-op update does not"
  );
  assert.ok(causes.every((cause) => cause.sourceEventKey.startsWith(`legacy-trigger:${id}:`)));

  await prisma.$executeRawUnsafe(`DELETE FROM "SuppressionEntry" WHERE "id" = $1`, id);
  causes = await causesFor(emailAddress);
  assert.ok(causes.every((cause) => cause.releasedAt && cause.releaseKind === "legacy_delete"));
});

test("lifting an entry releases every cause behind it", async () => {
  const emailAddress = address();
  const entry = await recordSuppression({
    emailAddress,
    reason: "manual",
    source: "admin",
    sourceEventKey: `admin:${randomUUID()}`,
  });
  await recordSuppression({
    emailAddress,
    reason: "soft_bounce",
    source: "provider_webhook",
    expiresAt: new Date(Date.now() + 60_000),
    sourceEventKey: `softbounce:${randomUUID()}`,
  });

  const result = await removeSuppression({ id: entry.id });
  assert.equal(result.removed, true);

  const causes = await causesFor(emailAddress);
  assert.equal(causes.length, 2);
  assert.ok(causes.every((cause) => cause.releaseKind === "entry_removed"));
});

test("a preference switched off and on leaves transitions and a released cause", async () => {
  const user = await prisma.user.create({ data: { email: address() } });

  await setPreference({
    userId: user.id,
    purpose: "service_status",
    enabled: false,
    capturedVia: "preference_center",
    source: "preference_center",
  });
  await setPreference({
    userId: user.id,
    purpose: "service_status",
    enabled: false,
    capturedVia: "preference_center",
    source: "preference_center",
  });

  const transitions = await prisma.emailPreferenceTransition.findMany({
    where: { userId: user.id },
  });
  assert.equal(transitions.length, 1, "a repeated switch-off is not a second transition");
  assert.equal(transitions[0].consentRecordId, null, "service_status records no consent");

  const [cause] = await causesFor(user.email!);
  assert.equal(cause.sourceEventKey, `preference:${transitions[0].id}`);
  assert.equal(cause.scope, "purpose");

  await setPreference({
    userId: user.id,
    purpose: "service_status",
    enabled: true,
    capturedVia: "preference_center",
    source: "preference_center",
  });
  const [released] = await causesFor(user.email!);
  assert.equal(released.releaseKind, "preference_enabled");
  assert.equal(await prisma.emailPreferenceTransition.count({ where: { userId: user.id } }), 2);
});

test("a replayed webhook adds no second cause", async () => {
  const emailAddress = address();
  const payload = { type: "email.bounced", data: { to: [emailAddress], bounce: { type: "Hard" } } };
  const providerEventId = `msg_${randomUUID()}`;
  await processResendWebhook({ providerEventId, payload });
  await processResendWebhook({ providerEventId, payload });

  const causes = await causesFor(emailAddress);
  assert.equal(causes.length, 1);
  assert.match(causes[0].sourceEventKey, /^webhook:/);
});

test("a cause is append-only: no edit, no delete, one release", async () => {
  const emailAddress = address();
  await recordSuppression({
    emailAddress,
    reason: "manual",
    source: "admin",
    sourceEventKey: `admin:${randomUUID()}`,
  });
  const [cause] = await causesFor(emailAddress);

  await assert.rejects(
    () =>
      prisma.suppressionCause.update({ where: { id: cause.id }, data: { reason: "complaint" } }),
    /append-only/
  );
  await assert.rejects(
    () => prisma.suppressionCause.delete({ where: { id: cause.id } }),
    /append-only/
  );

  await prisma.suppressionCause.update({
    where: { id: cause.id },
    data: { releasedAt: new Date(), releaseKind: "test", releaseEvidence: { kind: "test" } },
  });
  await assert.rejects(
    () =>
      prisma.suppressionCause.update({
        where: { id: cause.id },
        data: { releaseKind: "again" },
      }),
    /append-only/
  );
});

test("classification scope accepts only marketing", async () => {
  await assert.rejects(
    () =>
      prisma.suppressionCause.create({
        data: {
          emailAddress: address(),
          scope: "classification",
          purposeKey: "transactional",
          reason: "privacy_request",
          source: "admin",
          sourceEventKey: `test:${randomUUID()}`,
          occurredAt: new Date(),
        },
      }),
    /SuppressionCause_scope_check/
  );
});
