import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, mock, test } from "node:test";

import {
  ACCOUNT_WELCOME_TEMPLATE,
  emailTemplateDefinition,
  MODEL_LAUNCH_TEMPLATE,
} from "@/lib/emailTemplateDefinitions";
import { ensureTemplateVersion } from "@/lib/emailTemplateRegistry";
import { prisma } from "@/lib/prisma";
import {
  drainStandardEmailDeliveries,
  enqueueStandardEmail,
} from "@/lib/standardEmailLane";
import { enqueuedRow } from "../support/enqueuedEmail";

// The send metadata lives on the version, is written once, and is what the
// drain trusts.
//
// Contract: docs/policy/email-notifications.md §10.2.
//
// Before this, `ensureTemplateVersion()` upserted `EmailTemplate` with
// `update: {}` and the drain read `requiresUnsubscribe` from that row. A
// template reclassified in code kept its old row, so a template moved to
// marketing would have been sent without an unsubscribe link.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "EmailDelivery", "EmailEvent", "TemplateVersion", "EmailTemplate",
      "EmailPolicyVersion", "ScheduledJobRun", "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(async () => {
  await reset();
  mock.restoreAll();
  process.env.EMAIL_AUDIT_HASH_KEY = "test-audit-key";
  process.env.EMAIL_SNAPSHOT_KEYS = "v1:test-snapshot-key";
  process.env.EMAIL_SNAPSHOT_KEY_VERSION = "v1";
  process.env.RESEND_API_KEY = "test-key";
});

after(async () => {
  mock.restoreAll();
  await reset();
  await prisma.$disconnect();
});

const rejectsWith = async (pattern: RegExp, run: () => Promise<unknown>) => {
  await assert.rejects(run, (error: unknown) => {
    assert.match(String((error as Error)?.message ?? error), pattern);
    return true;
  });
};

test("a registered version carries the definition's send metadata", async () => {
  const definition = emailTemplateDefinition(MODEL_LAUNCH_TEMPLATE);
  const { templateVersionId } = await ensureTemplateVersion({
    templateKey: MODEL_LAUNCH_TEMPLATE,
    language: "en",
  });

  const version = await prisma.templateVersion.findUniqueOrThrow({
    where: { id: templateVersionId },
  });
  assert.equal(version.classification, definition.classification);
  assert.equal(version.purpose, definition.purpose);
  assert.equal(version.requiresUnsubscribe, definition.requiresUnsubscribe);
});

test("a template row that drifted from the code does not decide the version", async () => {
  // The row as it would look had this template once been registered as a
  // service notice. `update: {}` leaves it alone, which is fine now: it is
  // history, and the version is written from the definition.
  await prisma.emailTemplate.create({
    data: {
      key: ACCOUNT_WELCOME_TEMPLATE,
      classification: "service",
      purpose: "product_updates",
      requiresUnsubscribe: false,
    },
  });

  const { templateVersionId } = await ensureTemplateVersion({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    language: "en",
  });

  const version = await prisma.templateVersion.findUniqueOrThrow({
    where: { id: templateVersionId },
  });
  assert.equal(version.classification, "transactional");
  assert.equal(version.purpose, null);
  assert.equal(version.requiresUnsubscribe, false);
});

test("the same copy under different metadata is a new version, not the old one", async () => {
  const first = await ensureTemplateVersion({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    language: "en",
  });
  const original = await prisma.templateVersion.findUniqueOrThrow({
    where: { id: first.templateVersionId },
  });

  // A version with identical copy published under another classification --
  // the shape a reclassification in code leaves behind. The registry must not
  // resolve to it.
  await prisma.templateVersion.update({
    where: { id: original.id },
    data: { status: "retired" },
  });
  const stale = await prisma.templateVersion.create({
    data: {
      templateId: original.templateId,
      language: "en",
      version: original.version + 1,
      subject: original.subject,
      bodyHtml: original.bodyHtml,
      bodyText: original.bodyText,
      contentHash: original.contentHash,
      classification: "service",
      purpose: "product_updates",
      requiresUnsubscribe: false,
      status: "published",
      publishedAt: new Date(),
    },
  });

  const second = await ensureTemplateVersion({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    language: "en",
  });

  assert.notEqual(second.templateVersionId, stale.id);
  const current = await prisma.templateVersion.findUniqueOrThrow({
    where: { id: second.templateVersionId },
  });
  assert.equal(current.contentHash, original.contentHash);
  assert.equal(current.classification, "transactional");
  assert.equal(current.version, stale.version + 1);
});

test("send metadata cannot be edited after the version is written", async () => {
  const { templateVersionId } = await ensureTemplateVersion({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    language: "en",
  });

  await rejectsWith(/immutable/, () =>
    prisma.templateVersion.update({
      where: { id: templateVersionId },
      data: { classification: "service", purpose: "product_updates" },
    })
  );
  await rejectsWith(/immutable/, () =>
    prisma.templateVersion.update({
      where: { id: templateVersionId },
      data: { requiresUnsubscribe: true, classification: "service", purpose: "x" },
    })
  );

  // Status is not send metadata and stays editable.
  await prisma.templateVersion.update({
    where: { id: templateVersionId },
    data: { status: "retired" },
  });
});

test("the version holds the same classification rules as the template", async () => {
  const { templateId } = await ensureTemplateVersion({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    language: "en",
  });
  const base = {
    templateId,
    language: "fr",
    subject: "s",
    bodyHtml: "<p>s</p>",
    bodyText: "s",
    contentHash: `hash-${randomUUID()}`,
    status: "published",
    publishedAt: new Date(),
  };

  await rejectsWith(/TemplateVersion_unsubscribe_check/, () =>
    prisma.templateVersion.create({
      data: {
        ...base,
        version: 101,
        classification: "marketing",
        purpose: "product_updates",
        requiresUnsubscribe: false,
      },
    })
  );
  await rejectsWith(/TemplateVersion_purpose_check/, () =>
    prisma.templateVersion.create({
      data: {
        ...base,
        version: 102,
        classification: "transactional",
        purpose: "billing",
        requiresUnsubscribe: false,
      },
    })
  );
});

test("the drain refuses a queued message whose version no longer matches the code", async () => {
  const user = await prisma.user.create({
    data: { email: `${randomUUID()}@example.com`, name: "Someone" },
  });
  const rows = enqueuedRow(
    await enqueueStandardEmail({
      templateKey: ACCOUNT_WELCOME_TEMPLATE,
      emailAddress: user.email,
      userId: user.id,
      payload: { name: "Someone" },
    })
  );
  const delivery = await prisma.emailDelivery.findUniqueOrThrow({
    where: { id: rows!.deliveryId },
    select: { templateVersionId: true },
  });

  // Only a migration or a manual repair could do this, which is the point: the
  // drain must not trust that neither ever happened.
  await prisma.$transaction([
    prisma.$executeRawUnsafe(
      `ALTER TABLE "TemplateVersion" DISABLE TRIGGER "template_version_send_metadata_is_immutable"`
    ),
    prisma.$executeRawUnsafe(
      `UPDATE "TemplateVersion" SET "classification" = 'service', "purpose" = 'product_updates' WHERE "id" = $1`,
      delivery.templateVersionId
    ),
    prisma.$executeRawUnsafe(
      `ALTER TABLE "TemplateVersion" ENABLE TRIGGER "template_version_send_metadata_is_immutable"`
    ),
  ]);

  let fetches = 0;
  mock.method(globalThis, "fetch", async () => {
    fetches += 1;
    return new Response(JSON.stringify({ id: "never" }), { status: 200 });
  });

  const result = await drainStandardEmailDeliveries();

  assert.equal(result.claimed, 1);
  assert.equal(result.failed, 1);
  assert.equal(fetches, 0, "a mismatched version must not reach the provider");
  const after = await prisma.emailDelivery.findUniqueOrThrow({
    where: { id: rows!.deliveryId },
  });
  assert.equal(after.status, "failed");
  assert.equal(after.lastErrorKind, "template_metadata_mismatch");
  assert.equal(after.claimedAt, null);
});
