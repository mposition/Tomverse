import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { maskEmailAddress } from "@/lib/emailAddressMaskingCore";
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
import { recordSuppression } from "@/lib/emailSuppression";
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
      "EmailPolicyVersion", "SuppressionEntry", "SuppressionCause", "User"
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
  // The right row, and no address on it (D10). Searching by an address the
  // operator already has is not disclosure; returning it back is, and the list
  // read never does -- the field is gone from the type, not left empty.
  assert.equal(mine.rows[0].emailAddressMasked, maskEmailAddress(address));
  assert.ok(
    !JSON.stringify(mine.rows[0]).includes(address),
    "a list row must not carry the address it matched"
  );

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
  assert.equal(legal.rows[0].templateVersion.classification, "legal");
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

test("a selector's causes are never cut by the row limit", async () => {
  // The limit belongs to selectors, and it is applied in the database. Read a
  // multiple of it in causes and group in memory instead, and a selector at the
  // edge of the window comes back with *some* of its causes -- so a row whose
  // privacy_request will outlive the lift is drawn without it, and the operator
  // acts expecting an address that ends up clear.
  const crowded = "crowded@example.com";
  const reasons = [
    "hard_bounce",
    "complaint",
    "unsubscribe",
    "manual",
    "privacy_request",
  ] as const;
  for (const reason of reasons) {
    await recordSuppression({
      sourceEventKey: `test:${randomUUID()}`,
      emailAddress: crowded,
      reason,
      source:
        reason === "manual" || reason === "privacy_request"
          ? "admin"
          : reason === "unsubscribe"
            ? "unsubscribe_link"
            : "provider_webhook",
    });
  }

  // One row asked for, and five causes -- more than any per-row budget a
  // multiplied read would have used.
  const [row] = await listSuppressions({ emailAddress: null, limit: 1 });
  assert.ok(row);
  assert.equal(row.causes.length, reasons.length);
  assert.ok(
    row.causes.some((cause) => cause.reason === "privacy_request"),
    "the reason that will still be stopping this address afterwards was cut out of the row"
  );
});

test("a suppression created by a privacy request cannot be lifted from here", async () => {
  // It is the record of someone exercising a legal right. The process entitled
  // to lift it is the privacy process that created it, not a button on an
  // operations screen -- so this is a refusal rather than an approval gate.
  const created = await recordSuppression({
    sourceEventKey: `test:${randomUUID()}`,
    emailAddress: "someone@example.com",
    reason: "privacy_request",
    source: "admin",
  });

  // The refusal itself is the cause lift's, and
  // tests/integration/admin-suppression-lift-route.db.test.ts drives it through
  // the route. What this file is responsible for is the listing: the row is
  // there, and it says what makes it unliftable.
  const rows = await listSuppressions({ emailAddress: null, limit: 10 });
  assert.equal(rows.length, 1);
  assert.deepEqual(
    rows[0].causes.map((cause) => cause.reason),
    ["privacy_request"]
  );
  assert.equal(rows[0].id, created.id);
});

test("one row per suppressed selector, carrying every active cause on it", async () => {
  // The console reads causes now (docs/policy/email-notifications.md v25). A
  // selector can hold several at once and the block is their sum, so a row per
  // cause would show the same address three times and invite an operator to
  // lift a third of a block.
  const emailAddress = "stacked@example.com";
  for (const reason of ["hard_bounce", "complaint", "unsubscribe"] as const) {
    await recordSuppression({
      sourceEventKey: `test:${randomUUID()}`,
      emailAddress,
      reason,
      source: reason === "unsubscribe" ? "unsubscribe_link" : "provider_webhook",
    });
  }
  // A second selector, so grouping is proved rather than assumed from a table
  // that happens to hold one address.
  await recordSuppression({
    sourceEventKey: `test:${randomUUID()}`,
    emailAddress: "other@example.com",
    reason: "hard_bounce",
    source: "provider_webhook",
  });

  const rows = await listSuppressions({ emailAddress: null, limit: 10 });
  assert.equal(rows.length, 2);

  const stacked = rows.find(
    (row) => row.emailAddressMasked === maskEmailAddress(emailAddress)
  );
  assert.ok(stacked, "the stacked selector is missing");
  assert.deepEqual(
    [...stacked.causes.map((cause) => cause.reason)].sort(),
    ["complaint", "hard_bounce", "unsubscribe"]
  );

  // The row's handle is one of its own causes -- an entry id would be a handle
  // to the row the contraction stops writing.
  const causeIds = stacked.causes.map((cause) => cause.id);
  assert.ok(causeIds.includes(stacked.id));
  assert.equal(
    await prisma.suppressionCause.count({ where: { id: stacked.id } }),
    1
  );

  // And the same id is what the audited reveal resolves an address by.
  const { revealEmailAddresses } = await import("@/lib/adminEmailAddressReveal");
  assert.deepEqual(
    await revealEmailAddresses({ kind: "suppression", ids: [stacked.id] }),
    { [stacked.id]: emailAddress }
  );
});

test("the reveal answers for an active cause and not for a dead one", async () => {
  // An entry stopped resolving to an address the moment its suppression was
  // lifted, because the row was deleted. Causes are append-only, so every id
  // this screen ever printed -- and every id sitting in an audit entry -- would
  // otherwise be a permanent handle for turning a masked address back into an
  // address.
  const { revealEmailAddresses } = await import("@/lib/adminEmailAddressReveal");
  const emailAddress = "revealed@example.com";
  await recordSuppression({
    sourceEventKey: `test:${randomUUID()}`,
    emailAddress,
    reason: "hard_bounce",
    source: "provider_webhook",
  });
  const live = await prisma.suppressionCause.findFirstOrThrow({
    where: { emailAddress },
    select: { id: true },
  });
  assert.deepEqual(
    await revealEmailAddresses({ kind: "suppression", ids: [live.id] }),
    { [live.id]: emailAddress }
  );

  // Expired: asked as of a later moment, so the clock is not part of the test.
  const expiring = "expiring@example.com";
  await recordSuppression({
    sourceEventKey: `test:${randomUUID()}`,
    emailAddress: expiring,
    reason: "soft_bounce",
    source: "provider_webhook",
    expiresAt: new Date(Date.now() + 60_000),
  });
  const soft = await prisma.suppressionCause.findFirstOrThrow({
    where: { emailAddress: expiring },
    select: { id: true },
  });
  assert.deepEqual(
    await revealEmailAddresses({
      kind: "suppression",
      ids: [soft.id],
      now: new Date(Date.now() + 120_000),
    }),
    {}
  );

  // Released.
  await prisma.suppressionCause.update({
    where: { id: live.id },
    data: { releasedAt: new Date(), releaseKind: "admin" },
  });
  assert.deepEqual(
    await revealEmailAddresses({ kind: "suppression", ids: [live.id] }),
    {}
  );
});

test("a cause that has expired, or been released, stops being listed", async () => {
  // A soft bounce whose window has passed stops mail nowhere, and a screen that
  // still lists it asks somebody to lift something that is not there.
  const emailAddress = "expired@example.com";
  await recordSuppression({
    sourceEventKey: `test:${randomUUID()}`,
    emailAddress,
    reason: "soft_bounce",
    source: "provider_webhook",
    expiresAt: new Date(Date.now() + 60_000),
  });

  assert.equal(
    (await listSuppressions({ emailAddress: null, limit: 10 })).length,
    1
  );

  // Asked as of a later moment rather than by waiting: the expiry is applied by
  // the reader, and this proves which reader.
  assert.equal(
    (
      await listSuppressions({
        emailAddress: null,
        limit: 10,
        now: new Date(Date.now() + 120_000),
      })
    ).length,
    0
  );

  await prisma.suppressionCause.updateMany({
    where: { emailAddress },
    data: { releasedAt: new Date(), releaseKind: "admin" },
  });
  assert.equal(
    (await listSuppressions({ emailAddress: null, limit: 10 })).length,
    0
  );
});

test("a released cause leaves the listing", async () => {
  // What the console shows after a lift. The lift itself is the cause path's
  // and is driven through the route elsewhere; here the release is written
  // directly, because the claim under test is what the *listing* does with it.
  const created = await recordSuppression({
    sourceEventKey: `test:${randomUUID()}`,
    emailAddress: "bounced@example.com",
    reason: "hard_bounce",
    source: "provider_webhook",
    sourceClassification: "transactional",
  });
  assert.equal((await listSuppressions({ emailAddress: null, limit: 10 })).length, 1);

  await prisma.suppressionCause.update({
    where: { id: created.id },
    data: { releasedAt: new Date(), releaseKind: "admin" },
  });
  assert.equal((await listSuppressions({ emailAddress: null, limit: 10 })).length, 0);
});
