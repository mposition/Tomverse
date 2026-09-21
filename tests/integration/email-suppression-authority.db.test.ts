import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { setPreference } from "@/lib/emailPreferences";
import {
  activeCausesForSelector,
  causeSetDigest,
  liftSuppressionCauses,
  recordSuppression,
  suppressionCheck,
} from "@/lib/emailSuppression";
import { prisma } from "@/lib/prisma";

// Lifting by the release matrix, and the locking that makes a lift safe.
//
// Deploy B put the read authority and its cutover here too. Deploy D removed
// both; what is left is the part that was never about which record decides.
//
// Contract: docs/policy/email-product-news-redesign-draft.md, section 7.4.

/**
 * The setting that used to choose the record, written by its literal key.
 *
 * Spelled out rather than imported because the constant is gone: the point of
 * the one test that still writes it is that a row left behind in a database
 * this build has not been told about changes nothing. That is what lets the row
 * be deleted in a later deploy instead of this one.
 */
const RETIRED_AUTHORITY_KEY = "email.suppressionReadAuthority";

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "SuppressionCause", "SuppressionEntry", "AppSetting", "AdminAuditLog",
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

const suppress = (emailAddress: string, reason: "manual" | "complaint" | "hard_bounce" | "privacy_request", extra: Record<string, unknown> = {}) =>
  recordSuppression({
    emailAddress,
    reason,
    source: reason === "manual" || reason === "privacy_request" ? "admin" : "provider_webhook",
    sourceEventKey: `test:${randomUUID()}`,
    ...extra,
  });

/** The live set behind a handle, or a failure naming which kind it was. */
const liveSet = async (causeId: string, now?: Date) => {
  const active = await activeCausesForSelector(causeId, now);
  assert.equal(active.found, true, "the handle did not resolve");
  assert.equal(
    active.found && active.stale,
    false,
    "the handle resolved but is not active"
  );
  if (!active.found || active.stale) throw new Error("unreachable");
  return active;
};

/**
 * A cause id for an address, which is the handle the console hands out.
 *
 * The lift is reached by a cause and acts on its whole selector, so which cause
 * this is does not matter -- only that it is not an entry id.
 */
const causeFor = async (emailAddress: string, reason: string) =>
  (
    await prisma.suppressionCause.findFirstOrThrow({
      where: { emailAddress, reason },
      select: { id: true },
    })
  ).id;

/** An audit row written in the lift's transaction, standing in for the route's. */
const auditInTx = async (tx: Parameters<Parameters<typeof liftSuppressionCauses>[0]["writeReleaseAudit"]>[0]) => {
  const row = await tx.adminAuditLog.create({
    // The same target type the route writes: the set of causes, not the
    // mirror row. A stand-in that files the audit somewhere the real one never
    // does is a stand-in for something else.
    data: { action: "email_suppression.removed", targetType: "SuppressionCauseSet", summary: "test" },
    select: { id: true },
  });
  return row.id;
};

test("a hold the entry's merge would have overwritten still decides", async () => {
  const emailAddress = address();
  // Deploy A merged these into one row and the complaint won, so transactional
  // mail went out to somebody an administrator had put a hold on. Two causes,
  // and the hold is still one of them.
  await suppress(emailAddress, "manual");
  await suppress(emailAddress, "complaint", { sourceStream: "marketing" });

  const verdict = await suppressionCheck({ emailAddress, classification: "transactional" });
  assert.equal(verdict.allowed, false, "the manual hold is still a cause");
});

test("a classification cause stops marketing only", async () => {
  const emailAddress = address();
  await prisma.suppressionCause.create({
    data: {
      emailAddress,
      scope: "classification",
      purposeKey: "marketing",
      reason: "privacy_request",
      source: "admin",
      sourceEventKey: `test:${randomUUID()}`,
      occurredAt: new Date(),
    },
  });
  assert.equal(
    (await suppressionCheck({ emailAddress, classification: "marketing", purpose: "newsletter" })).allowed,
    false
  );
  assert.equal(
    (await suppressionCheck({ emailAddress, classification: "transactional" })).allowed,
    true
  );
});

test("a lift releases only what its action may", async () => {
  const emailAddress = address();
  await suppress(emailAddress, "manual");
  await suppress(emailAddress, "privacy_request");

  const handle = await causeFor(emailAddress, "manual");
  const active = await liveSet(handle);
  assert.equal(active.needsApproval, false);

  const lifted = await liftSuppressionCauses({
    causeId: handle,
    approvedDigest: active.digest,
    action: "admin",
    evidence: { kind: "admin" },
    writeReleaseAudit: auditInTx,
  });
  assert.equal(lifted.removed, true);
  assert.ok(lifted.removed && lifted.released.every((cause) => cause.reason === "manual"));
  assert.ok(lifted.removed && lifted.remaining.some((cause) => cause.reason === "privacy_request"));

  const released = await prisma.suppressionCause.findFirstOrThrow({
    where: { emailAddress, reason: "manual" },
  });
  const evidence = released.releaseEvidence as { kind: string; releaseAuditLogId: string };
  assert.equal(evidence.kind, "admin");
  assert.ok(await prisma.adminAuditLog.findUnique({ where: { id: evidence.releaseAuditLogId } }));
});

test("an approval for one cause set does not lift a set that changed since", async () => {
  const emailAddress = address();
  await suppress(emailAddress, "complaint", { sourceStream: "marketing" });
  const handle = await causeFor(emailAddress, "complaint");
  const active = await liveSet(handle);
  assert.ok(active.needsApproval);

  await suppress(emailAddress, "hard_bounce");

  const lifted = await liftSuppressionCauses({
    causeId: handle,
    approvedDigest: active.digest,
    action: "approved_admin",
    evidence: { kind: "sole_admin", authorizationAuditLogId: "audit-start" },
    writeReleaseAudit: auditInTx,
  });
  assert.deepEqual(lifted, { removed: false, refusal: "approval_stale" });
  assert.equal(await prisma.adminAuditLog.count(), 0, "no release, no release audit");
});

test("a handle that is no longer active cannot reach what replaced it", async () => {
  // The dangerous shape, because it ends with us mailing somebody who asked us
  // to stop: a screen shows one soft bounce, it expires while the page sits
  // open, an unsubscribe arrives on the same address, and the operator clicks
  // lift on what they can see. Following the dead handle to its selector would
  // release the unsubscribe they never saw.
  const emailAddress = address();
  await recordSuppression({
    emailAddress,
    reason: "soft_bounce",
    source: "provider_webhook",
    sourceEventKey: `test:${randomUUID()}`,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const stale = await causeFor(emailAddress, "soft_bounce");

  // Both the read and the lift are asked as of a moment past the expiry, so the
  // test does not wait on a clock.
  const later = new Date(Date.now() + 120_000);
  // Resolved, and stale: a handle that never existed is a different answer,
  // and the route says different things about them.
  assert.deepEqual(await activeCausesForSelector(stale, later), {
    found: true,
    stale: true,
  });
  assert.deepEqual(await activeCausesForSelector("no-such-cause", later), {
    found: false,
  });

  await recordSuppression({
    emailAddress,
    reason: "unsubscribe",
    source: "unsubscribe_link",
    sourceEventKey: `test:${randomUUID()}`,
  });

  const lifted = await liftSuppressionCauses({
    causeId: stale,
    // The set the stale screen showed, which is the only set an operator could
    // have approved.
    approvedDigest: causeSetDigest([stale]),
    action: "admin",
    evidence: { kind: "admin" },
    writeReleaseAudit: auditInTx,
    now: later,
  });
  assert.deepEqual(lifted, { removed: false, refusal: "approval_stale" });

  const unsubscribe = await prisma.suppressionCause.findFirstOrThrow({
    where: { emailAddress, reason: "unsubscribe" },
  });
  assert.equal(unsubscribe.releasedAt, null, "the unsubscribe was released");
  assert.equal(await prisma.adminAuditLog.count(), 0, "no release, no release audit");
});

test("a lift works with no SuppressionEntry behind it", async () => {
  // What C-2 leaves: causes and no mirror. The entry delete goes by selector
  // and deleting none of them is not a failure, so this path has to keep
  // working across that change rather than start returning not_found.
  const emailAddress = address();
  await suppress(emailAddress, "manual");

  // No fixture work is needed any more: with the mirroring trigger dropped and
  // nothing writing the entry, causes-and-no-entry is simply what a suppression
  // is. Asserted rather than assumed, because the shape of the row this runs
  // against is the whole point of the test.
  assert.equal(await prisma.suppressionEntry.count({ where: { emailAddress } }), 0);

  const handle = await causeFor(emailAddress, "manual");
  const active = await liveSet(handle);

  const lifted = await liftSuppressionCauses({
    causeId: handle,
    approvedDigest: active.digest,
    action: "admin",
    evidence: { kind: "admin" },
    writeReleaseAudit: auditInTx,
  });
  assert.equal(lifted.removed, true);
  assert.ok(lifted.removed && lifted.released.some((c) => c.reason === "manual"));
  assert.equal(lifted.removed && lifted.selector.emailAddress, emailAddress);
});

test("switching a purpose back on is refused while another cause still stops it", async () => {
  const user = await prisma.user.create({ data: { email: address() } });
  await setPreference({
    userId: user.id,
    purpose: "service_status",
    enabled: false,
    capturedVia: "preference_center",
    source: "preference_center",
  });
  await suppress(user.email!, "manual", { purposeKey: "service_status" });

  const result = await setPreference({
    userId: user.id,
    purpose: "service_status",
    enabled: true,
    capturedVia: "preference_center",
    source: "preference_center",
  });
  assert.deepEqual(result, { changed: false, reason: "suppressed" });
});

test("a setting row left behind by an earlier deploy changes nothing", async () => {
  // Deploy D removes the read authority from the code; the row it used to read
  // is deleted in a later deploy. Not because the send would be wrong without
  // it -- the send has ignored the setting since deploy C -- but because the
  // build serving during the migration still consults it in three other places,
  // and an absent row reads as "entry" there: the console's lift refuses, a
  // preference can be switched back on that a hold should have refused, and a
  // deletion intake writes its per-purpose duplicates again.
  //
  // This is the test for that order and only that order: with this build
  // serving, the row can be there and say the worst thing it could say, and
  // nothing reads it. It says nothing about the reverse.
  const emailAddress = address();
  // A hard bounce, because it is the one reason that stops transactional mail
  // as well: a complaint about marketing never did, so it could not tell a
  // build reading the wrong table from one reading the right one.
  await suppress(emailAddress, "hard_bounce");
  await prisma.appSetting.create({ data: { key: RETIRED_AUTHORITY_KEY, value: "entry" } });

  assert.equal(
    await prisma.suppressionEntry.count({ where: { emailAddress } }),
    0,
    "the fixture is only meaningful if nothing mirrored the cause"
  );
  const verdict = await suppressionCheck({ emailAddress, classification: "transactional" });
  assert.equal(verdict.allowed, false, "the retired setting was read and the hard bounce was missed");
});

test("a cause written while a lift waits for the address is seen by the lift", async () => {
  const emailAddress = address();
  await suppress(emailAddress, "manual");
  const handle = await causeFor(emailAddress, "manual");
  const active = await liveSet(handle);

  const { lockSuppressionAddress } = await import("@/lib/emailSuppressionAuthority");

  let holding!: () => void;
  const held = new Promise<void>((resolve) => (holding = resolve));
  let finish!: () => void;
  const release = new Promise<void>((resolve) => (finish = resolve));

  // A writer that holds the address, then adds a hard bounce and commits.
  const writer = prisma.$transaction(
    async (tx) => {
      await lockSuppressionAddress(tx, emailAddress);
      holding();
      await release;
      await tx.$queryRaw`SELECT set_config('app.suppression_writer', 'causes', true)`;
      await tx.suppressionCause.create({
        data: {
          emailAddress,
          scope: "global",
          purposeKey: "*",
          reason: "hard_bounce",
          source: "provider_webhook",
          sourceEventKey: `test:${randomUUID()}`,
          occurredAt: new Date(),
        },
      });
    },
    { timeout: 20_000 }
  );

  await held;
  const lift = liftSuppressionCauses({
    causeId: handle,
    approvedDigest: active.digest,
    action: "admin",
    evidence: { kind: "admin" },
    writeReleaseAudit: auditInTx,
  });
  // Release the writer only once the lift is observed waiting on an advisory
  // lock -- a fixed delay would let the test pass with no lock at all if the
  // lift happened to start after the writer committed.
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [row] = await prisma.$queryRaw<Array<{ waiting: bigint }>>`
      SELECT count(*) AS waiting FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
    `;
    if (Number(row.waiting) > 0) break;
    if (Date.now() > deadline) throw new Error("the lift never waited on the address lock");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  finish();
  await writer;

  const lifted = await lift;
  assert.deepEqual(lifted, { removed: false, refusal: "approval_stale" });
});
