import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { setPreference } from "@/lib/emailPreferences";
import { recordSuppression, suppressionCheck } from "@/lib/emailSuppression";
import { processResendWebhook } from "@/lib/emailWebhookProcessing";
import { prisma } from "@/lib/prisma";

// Suppression causes: the record, now that nothing is written beside them.
//
// This file began as the shadow deploy's -- causes written beside entries, the
// trigger carrying an older build's writes, the merge rule the entry needed.
// Deploy C removed all three, and the tests that pinned them went with the
// thing they were pinning rather than being rewritten to assert something
// weaker.
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
  const first = await recordSuppression({
    ...input,
    occurredAt: new Date("2026-09-16T00:00:00.000Z"),
  });
  const replay = await recordSuppression({
    ...input,
    occurredAt: new Date("2026-09-16T01:00:00.000Z"),
    sourceMessageId: "a-retry",
  });
  assert.equal(replay.duplicate, true);
  // The same event, so the same identity: a retry is told about the cause that
  // is already there rather than being handed a second one.
  assert.equal(replay.id, first.id);

  const causes = await causesFor(emailAddress);
  assert.equal(causes.length, 1);
  assert.equal(causes[0].reason, "hard_bounce");
  assert.equal(causes[0].providerAccount, "transactional");
  // And the retry did not restamp it. The row keeps what the first event said,
  // which used to have to be asserted of the mirrored entry as well.
  assert.equal(causes[0].occurredAt.toISOString(), "2026-09-16T00:00:00.000Z");
  assert.equal(causes[0].sourceMessageId, null);

  // Nothing writes the mirror any more.
  assert.equal(await prisma.suppressionEntry.count({ where: { emailAddress } }), 0);
});

test("a later transient cause does not unseat a permanent one", async () => {
  // The safety property that let deploy C delete the entry's merge rules.
  //
  // Those rules existed because one row had to stand for several facts: a
  // `privacy_request` must not be overwritten, a permanent reason must not be
  // downgraded to a soft bounce. With a row per cause there is nothing to
  // overwrite -- but that is only *safe* if the verdict reads every active
  // cause rather than the newest one, and that is what this pins.
  //
  // Deliberately not a claim of full equivalence, and the difference is worth
  // naming. The old entry kept the last permanent reason written to it, so
  // `hard_bounce` then `complaint` left a row saying complaint; the verdict
  // ranks by reason and answers `hard_bounce`. Both refuse the send; the
  // `skipReason` differs. Likewise a long soft bounce followed by a short one:
  // one row was overwritten and could start allowing earlier, while the causes
  // keep both and the longer one still decides. Those differences arrived with
  // the read authority at deploy B. C-2 only stops maintaining the row that
  // used to disagree.
  const complained = address();
  await recordSuppression({
    emailAddress: complained,
    reason: "complaint",
    source: "provider_webhook",
    sourceStream: "marketing",
    sourceEventKey: `webhook:${randomUUID()}`,
  });
  const softExpiry = new Date(Date.now() + 60_000);
  await recordSuppression({
    emailAddress: complained,
    reason: "soft_bounce",
    source: "provider_webhook",
    expiresAt: softExpiry,
    sourceEventKey: `softbounce:${randomUUID()}`,
  });

  // Both stand. The old entry would have held one reason and had to choose.
  assert.deepEqual(
    (await causesFor(complained)).map((cause) => cause.reason).sort(),
    ["complaint", "soft_bounce"]
  );

  // And the complaint still decides after the soft bounce expires, which is
  // exactly what "a permanent reason is never downgraded" used to mean.
  assert.equal(
    (
      await suppressionCheck({
        emailAddress: complained,
        classification: "marketing",
        purpose: "promotions",
        now: new Date(softExpiry.getTime() + 60_000),
      })
    ).allowed,
    false
  );

  // A data-subject request outranks everything, including a must-reach class,
  // and a transient cause arriving afterwards changes nothing about it.
  const requested = address();
  await recordSuppression({
    emailAddress: requested,
    reason: "privacy_request",
    source: "admin",
    sourceEventKey: `privacy:${randomUUID()}`,
  });
  await recordSuppression({
    emailAddress: requested,
    reason: "soft_bounce",
    source: "provider_webhook",
    expiresAt: new Date(Date.now() + 60_000),
    sourceEventKey: `softbounce:${randomUUID()}`,
  });
  const verdict = await suppressionCheck({
    emailAddress: requested,
    classification: "transactional",
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.allowed === false && verdict.skipReason, "suppressed_complaint");
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
  await processResendWebhook({ providerAccount: "transactional", providerEventId, payload });
  await processResendWebhook({ providerAccount: "transactional", providerEventId, payload });

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
    () =>
      prisma.suppressionCause.update({ where: { id: cause.id }, data: { id: randomUUID() } }),
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
