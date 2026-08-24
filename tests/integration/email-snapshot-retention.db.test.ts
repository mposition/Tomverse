import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import {
  ACCOUNT_DELETION_SCHEDULED_TEMPLATE,
  ACCOUNT_WELCOME_TEMPLATE,
} from "@/lib/emailTemplateDefinitions";
import { prisma } from "@/lib/prisma";
import { enqueueStandardEmail } from "@/lib/standardEmailLane";
import { purgeExpiredRenderSnapshots } from "@/lib/emailSnapshotRetention";
import { enqueuedRow } from "../support/enqueuedEmail";

// Clearing the personalisation snapshot once its window has passed (EM-08).
//
// Contract: docs/policy/email-notifications.md §10.3 rule 3, §13.2.
//
// The column and its `snapshotPurgedAt` companion existed and nothing wrote
// them, so envelope-encrypted personal data accumulated with no end. What has
// to hold is narrower than "old rows go": the row survives, the hash survives,
// and the fact that a legal notice was delivered survives -- a deletion request
// clears the snapshot and leaves the proof of notice.
//
// Classification decides the window, so the interesting assertion is the one
// where two deliveries of the same age part company.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "EmailDelivery", "EmailEvent", "TemplateVersion", "EmailTemplate",
      "EmailPolicyVersion", "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(async () => {
  await reset();
  process.env.EMAIL_AUDIT_HASH_KEY = "test-audit-key";
  process.env.EMAIL_SNAPSHOT_KEYS = "v1:test-snapshot-key";
  process.env.EMAIL_SNAPSHOT_KEY_VERSION = "v1";
});

after(async () => {
  await reset();
  await prisma.$disconnect();
});

const DAY_MS = 86_400_000;

const someone = () =>
  prisma.user.create({
    data: { email: `${randomUUID()}@example.test`, name: "Someone" },
  });

/** A delivery of the given template, aged by backdating its send. */
const aged = async (templateKey: string, daysOld: number) => {
  const user = await someone();
  const rows = enqueuedRow(await enqueueStandardEmail({
    templateKey,
    emailAddress: user.email,
    userId: user.id,
    language: "en",
    payload:
      templateKey === ACCOUNT_DELETION_SCHEDULED_TEMPLATE
        ? { scheduledFor: "2026-09-15T09:00:00.000Z" }
        : { name: user.name },
  }));
  assert.ok(rows);
  const sentAt = new Date(Date.now() - daysOld * DAY_MS);
  await prisma.emailDelivery.update({
    where: { id: rows.deliveryId },
    data: {
      status: "sent",
      sentAt,
      renderedSubject: "subject",
      // The hash and its key version travel together; a CHECK says so.
      renderedHash: "hash",
      renderedHashKeyVersion: "v1",
    },
  });
  return rows.deliveryId;
};

const snapshotOf = (id: string) =>
  prisma.emailDelivery.findUniqueOrThrow({
    where: { id },
    select: {
      renderDataSnapshot: true,
      snapshotPurgedAt: true,
      renderedHash: true,
      status: true,
      sentAt: true,
    },
  });

test("a transactional snapshot past ninety days is cleared, and the row is not", async () => {
  const id = await aged(ACCOUNT_WELCOME_TEMPLATE, 91);

  await purgeExpiredRenderSnapshots();

  const row = await snapshotOf(id);
  assert.equal(row.renderDataSnapshot, null);
  assert.ok(row.snapshotPurgedAt, "the purge is recorded, not silent");
  // What a verify-only window keeps: the delivery, its hash, and the fact that
  // it was sent.
  assert.equal(row.status, "sent");
  assert.equal(row.renderedHash, "hash");
  assert.ok(row.sentAt);
});

test("a transactional snapshot inside the window is left alone", async () => {
  const id = await aged(ACCOUNT_WELCOME_TEMPLATE, 89);

  await purgeExpiredRenderSnapshots();

  const row = await snapshotOf(id);
  assert.ok(row.renderDataSnapshot, "still reproducible");
  assert.equal(row.snapshotPurgedAt, null);
});

test("a legal notice of the same age keeps its snapshot", async () => {
  // The pair that makes the classification split visible: same day, same
  // sweep, different answer. A legal notice is the notice itself, and it stays
  // reproducible for seven years.
  const welcome = await aged(ACCOUNT_WELCOME_TEMPLATE, 200);
  const deletion = await aged(ACCOUNT_DELETION_SCHEDULED_TEMPLATE, 200);

  await purgeExpiredRenderSnapshots();

  assert.equal((await snapshotOf(welcome)).renderDataSnapshot, null);
  assert.ok((await snapshotOf(deletion)).renderDataSnapshot);
  assert.equal((await snapshotOf(deletion)).snapshotPurgedAt, null);
});

test("a second sweep does not re-stamp an already purged row", async () => {
  const id = await aged(ACCOUNT_WELCOME_TEMPLATE, 120);

  await purgeExpiredRenderSnapshots();
  const first = await snapshotOf(id);
  await purgeExpiredRenderSnapshots();
  const second = await snapshotOf(id);

  assert.ok(first.snapshotPurgedAt);
  assert.equal(
    second.snapshotPurgedAt?.getTime(),
    first.snapshotPurgedAt?.getTime(),
    "the purge time is when it happened, not when it was last looked at"
  );
});

test("a delivery that never sent is aged from when it was written", async () => {
  const user = await someone();
  const rows = enqueuedRow(await enqueueStandardEmail({
    templateKey: ACCOUNT_WELCOME_TEMPLATE,
    emailAddress: user.email,
    userId: user.id,
    payload: { name: user.name },
  }));
  assert.ok(rows);
  // Still pending, never sent, and holding the same personal data. Leaving it
  // forever because the send failed would be the wrong way round.
  await prisma.emailDelivery.update({
    where: { id: rows.deliveryId },
    data: { createdAt: new Date(Date.now() - 100 * DAY_MS) },
  });

  await purgeExpiredRenderSnapshots();

  const row = await snapshotOf(rows.deliveryId);
  assert.equal(row.renderDataSnapshot, null);
  assert.ok(row.snapshotPurgedAt);
  assert.equal(row.status, "pending");
});
