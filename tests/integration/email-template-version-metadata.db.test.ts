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

test("an insert from the previous build, which omits the metadata, still succeeds", async () => {
  // Migrations run before the new build takes traffic. The previous build's
  // insert names none of the three columns; a compatibility trigger fills them
  // from the template row, which is what that build's drain would have read.
  const { templateId } = await ensureTemplateVersion({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    language: "en",
  });
  const id = `legacy-${randomUUID()}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO "TemplateVersion"
       ("id", "templateId", "version", "language", "subject", "bodyHtml", "bodyText",
        "contentHash", "status", "publishedAt", "updatedAt")
     VALUES ($1, $2, 1, 'de', 's', '<p>s</p>', 's', 'legacy-hash', 'published', NOW(), NOW())`,
    id,
    templateId
  );

  const version = await prisma.templateVersion.findUniqueOrThrow({ where: { id } });
  assert.equal(version.classification, "transactional");
  assert.equal(version.purpose, null);
  assert.equal(version.requiresUnsubscribe, false);
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

/** A sent delivery whose version says one thing and whose template row another. */
const reclassifiedSend = async (input: {
  classification: string;
  purpose: string | null;
  requiresUnsubscribe: boolean;
  sentAt: Date;
}) => {
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
  const delivery = await prisma.emailDelivery.update({
    where: { id: rows!.deliveryId },
    data: { status: "sent", sentAt: input.sentAt },
    select: { id: true, templateVersionId: true },
  });
  await prisma.$transaction([
    prisma.$executeRawUnsafe(
      `ALTER TABLE "TemplateVersion" DISABLE TRIGGER "template_version_send_metadata_is_immutable"`
    ),
    prisma.$executeRawUnsafe(
      `UPDATE "TemplateVersion" SET "classification" = $1, "purpose" = $2, "requiresUnsubscribe" = $3 WHERE "id" = $4`,
      input.classification,
      input.purpose,
      input.requiresUnsubscribe,
      delivery.templateVersionId
    ),
    prisma.$executeRawUnsafe(
      `ALTER TABLE "TemplateVersion" ENABLE TRIGGER "template_version_send_metadata_is_immutable"`
    ),
  ]);
  return delivery;
};

test("snapshot retention follows the version's classification, not the template row's", async () => {
  // The row says transactional (90 days); the version says legal (2,555 days).
  // Purging on the row's window would destroy a legal record irreversibly.
  const { purgeExpiredRenderSnapshots } = await import("@/lib/emailSnapshotRetention");
  const now = new Date();
  const delivery = await reclassifiedSend({
    classification: "legal",
    purpose: null,
    requiresUnsubscribe: false,
    sentAt: new Date(now.getTime() - 120 * 24 * 60 * 60 * 1_000),
  });

  await purgeExpiredRenderSnapshots(now);

  const after = await prisma.emailDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
  assert.notEqual(after.renderDataSnapshot, null);
  assert.equal(after.snapshotPurgedAt, null);
});

test("marketing send health counts by the version's classification", async () => {
  const { marketingSendCounts } = await import("@/lib/marketingSendHealth");
  const now = new Date();
  await reclassifiedSend({
    classification: "marketing",
    purpose: "product_updates",
    requiresUnsubscribe: true,
    sentAt: new Date(now.getTime() - 60 * 1_000),
  });

  const counts = await marketingSendCounts(now);
  assert.equal(counts.sent, 1);
});
