import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import {
  ACCOUNT_DELETION_SCHEDULED_TEMPLATE,
  ACCOUNT_WELCOME_TEMPLATE,
} from "@/lib/emailTemplateDefinitions";
import { enqueueStandardEmail } from "@/lib/standardEmailLane";
import {
  abandonedLegalEmailCount,
  emailDeliveryStatusCounts,
  listEmailDeliveries,
  listSuppressions,
} from "@/lib/adminEmailDeliveries";
import { parseDeliveryFilters } from "@/lib/adminEmailDeliveryFilters";
import { recordSuppression, removeSuppression } from "@/lib/emailSuppression";
import { enqueuedRow } from "../support/enqueuedEmail";

// Reading the outbox back, against a real database.
//
// Contract: docs/policy/email-notifications.md §9.5, §13.7, §10.3.
//
// §9.5 keeps abandoned rows in place rather than moving them to a dead-letter
// table, because moving them scatters the attempt count and the error. That
// only pays off if something reads them back with the context attached, and
// until this surface existed nothing did.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "EmailDelivery", "EmailEvent", "TemplateVersion", "EmailTemplate",
      "EmailPolicyVersion", "SuppressionEntry", "User"
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

const someone = () =>
  prisma.user.create({
    data: { email: `${randomUUID()}@example.com`, name: "Someone" },
  });

const queue = async (templateKey: string, status?: string) => {
  const user = await someone();
  const rows = enqueuedRow(await enqueueStandardEmail({
    templateKey,
    emailAddress: user.email,
    userId: user.id,
    payload:
      templateKey === ACCOUNT_DELETION_SCHEDULED_TEMPLATE
        ? { scheduledFor: new Date().toISOString() }
        : { name: "Someone" },
  }));
  assert.ok(rows);
  if (status) {
    await prisma.emailDelivery.update({
      where: { id: rows.deliveryId },
      data: { status, attempts: 9, lastErrorKind: "http_503" },
    });
  }
  return { user, deliveryId: rows.deliveryId };
};

test("the default view is the messages that did not arrive", async () => {
  await queue(ACCOUNT_WELCOME_TEMPLATE, "abandoned");
  await queue(ACCOUNT_WELCOME_TEMPLATE, "delivered");
  await queue(ACCOUNT_WELCOME_TEMPLATE); // pending

  const { rows } = await listEmailDeliveries(parseDeliveryFilters({}));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "abandoned");
  assert.equal(rows[0].attempts, 9);
  assert.equal(rows[0].lastErrorKind, "http_503");

  // The counts beside the filters are unfiltered, so the view can say what it
  // is leaving out rather than reading as a total.
  const counts = await emailDeliveryStatusCounts();
  assert.equal(counts.abandoned, 1);
  assert.equal(counts.delivered, 1);
  assert.equal(counts.pending, 1);
});

test("no row carries the personalisation snapshot or its attestation hash", async () => {
  // The failure this prevents: a history screen where an administrator reads
  // other people's mail. `renderDataSnapshot` holds the personalisation inputs,
  // and on the credential lane the inputs *are* the credential -- which is why
  // the lane stores none (§9.4a-3). `renderedHash` is keyed for the same reason
  // (§10.3-7): a plain hash of a body holding a six-digit code is the attack.
  await queue(ACCOUNT_WELCOME_TEMPLATE, "abandoned");
  const { rows } = await listEmailDeliveries(parseDeliveryFilters({}));
  const serialised = JSON.stringify(rows);

  for (const field of [
    "renderDataSnapshot",
    "renderedHash",
    "renderedHashKeyVersion",
    "idempotencyKey",
    "recipientKey",
  ]) {
    assert.equal(
      serialised.includes(field),
      false,
      `${field} reached the delivery list`
    );
  }
  // The subject does travel: written by us, identical for every recipient of
  // the version, and the only thing that makes a row identifiable as "the
  // deletion notice" rather than a cuid.
  assert.ok("renderedSubject" in rows[0]);
});

test("only legal abandonments reach the badge", async () => {
  // §9.5 asks for this one count. An abandoned legal notice is work -- §9.4
  // asks for follow-up on an alternate channel -- and an abandoned welcome is
  // not.
  await queue(ACCOUNT_WELCOME_TEMPLATE, "abandoned");
  assert.equal(await abandonedLegalEmailCount(), 0);

  await queue(ACCOUNT_DELETION_SCHEDULED_TEMPLATE, "abandoned");
  assert.equal(await abandonedLegalEmailCount(), 1);

  // A legal notice that failed rather than exhausted its curve is a different
  // state, and §9.5's badge is about the dead letter.
  await queue(ACCOUNT_DELETION_SCHEDULED_TEMPLATE, "failed");
  assert.equal(await abandonedLegalEmailCount(), 1);
});

test("the address filter matches one address and not its neighbours", async () => {
  const { user } = await queue(ACCOUNT_WELCOME_TEMPLATE, "abandoned");
  await queue(ACCOUNT_WELCOME_TEMPLATE, "abandoned");
  const address = user.email!;

  const mine = await listEmailDeliveries(
    parseDeliveryFilters({ address: address.toUpperCase() })
  );
  assert.equal(mine.rows.length, 1);
  assert.equal(mine.rows[0].emailAddress, address);

  // A prefix is not a match. The alternative -- a LIKE over every address we
  // have mailed -- is the query that turns a support lookup into a way to
  // enumerate users.
  const prefix = await listEmailDeliveries(
    parseDeliveryFilters({ address: `${address.split("@")[0]}@example.co` })
  );
  assert.equal(prefix.rows.length, 0);
});

test("classification narrows without needing to know template keys", async () => {
  await queue(ACCOUNT_WELCOME_TEMPLATE, "abandoned");
  await queue(ACCOUNT_DELETION_SCHEDULED_TEMPLATE, "abandoned");

  const legal = await listEmailDeliveries(
    parseDeliveryFilters({ classification: "legal" })
  );
  assert.equal(legal.rows.length, 1);
  assert.equal(legal.rows[0].templateVersion.template.classification, "legal");
});

test("paging walks the whole list without repeating a row", async () => {
  for (let index = 0; index < 5; index += 1) {
    await queue(ACCOUNT_WELCOME_TEMPLATE, "abandoned");
  }

  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 5; page += 1) {
    const result = await listEmailDeliveries(
      parseDeliveryFilters({ limit: "2", ...(cursor ? { cursor } : {}) })
    );
    for (const row of result.rows) {
      assert.equal(seen.has(row.id), false, "a row appeared on two pages");
      seen.add(row.id);
    }
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  assert.equal(seen.size, 5);
  assert.equal(cursor, null, "the last page still offered another");
});

// ---------------------------------------------------------------------------
// Suppressions (§13.7)
// ---------------------------------------------------------------------------

test("a suppression created by a privacy request cannot be lifted from here", async () => {
  // It is the record of someone exercising a legal right. The process entitled
  // to lift it is the privacy process that created it, not a button on an
  // operations screen -- so this is a refusal rather than an approval gate.
  const created = await recordSuppression({
    emailAddress: "someone@example.com",
    reason: "privacy_request",
    source: "admin",
  });

  const result = await removeSuppression({ id: created.id });
  assert.equal(result.removed, false);
  if (!result.removed) assert.equal(result.refusal, "unliftable");

  const rows = await listSuppressions({ emailAddress: null, limit: 10 });
  assert.equal(rows.length, 1, "the entry was removed anyway");
});

test("lifting returns what it removed, so the audit entry can hold it", async () => {
  // The row is read and deleted in one transaction. An audit entry describing
  // a row a concurrent lift already removed would be a record of something
  // that did not happen.
  const created = await recordSuppression({
    emailAddress: "bounced@example.com",
    reason: "hard_bounce",
    source: "provider_webhook",
    sourceClassification: "transactional",
  });

  const result = await removeSuppression({ id: created.id });
  assert.equal(result.removed, true);
  if (result.removed) {
    assert.equal(result.entry.emailAddress, "bounced@example.com");
    assert.equal(result.entry.reason, "hard_bounce");
    assert.equal(result.entry.source, "provider_webhook");
  }
  assert.equal((await listSuppressions({ emailAddress: null, limit: 10 })).length, 0);

  // A second lift of the same id is not found, rather than a second audit
  // entry for one removal.
  const again = await removeSuppression({ id: created.id });
  assert.equal(again.removed, false);
  if (!again.removed) assert.equal(again.refusal, "not_found");
});
