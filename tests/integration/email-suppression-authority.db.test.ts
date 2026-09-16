import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { setPreference } from "@/lib/emailPreferences";
import {
  activeCausesForEntry,
  liftSuppressionCauses,
  recordSuppression,
  suppressionCheck,
} from "@/lib/emailSuppression";
import { SUPPRESSION_READ_AUTHORITY_KEY } from "@/lib/emailSuppressionAuthorityCore";
import { runSuppressionCutover } from "@/lib/emailSuppressionCutover";
import { prisma } from "@/lib/prisma";

// Deploy B: the read authority, the cutover under the fence, and lifting by
// the release matrix.
//
// Contract: docs/policy/email-product-news-redesign-draft.md, section 7.4.

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

const setAuthority = (value: "entry" | "causes") =>
  prisma.appSetting.upsert({
    where: { key: SUPPRESSION_READ_AUTHORITY_KEY },
    create: { key: SUPPRESSION_READ_AUTHORITY_KEY, value },
    update: { value },
  });

const suppress = (emailAddress: string, reason: "manual" | "complaint" | "hard_bounce" | "privacy_request", extra: Record<string, unknown> = {}) =>
  recordSuppression({
    emailAddress,
    reason,
    source: reason === "manual" || reason === "privacy_request" ? "admin" : "provider_webhook",
    sourceEventKey: `test:${randomUUID()}`,
    ...extra,
  });

/** An audit row written in the lift's transaction, standing in for the route's. */
const auditInTx = async (tx: Parameters<Parameters<typeof liftSuppressionCauses>[0]["writeReleaseAudit"]>[0]) => {
  const row = await tx.adminAuditLog.create({
    data: { action: "email_suppression.removed", targetType: "SuppressionEntry", summary: "test" },
    select: { id: true },
  });
  return row.id;
};

test("the send decision follows the setting, read on every call", async () => {
  const emailAddress = address();
  // A manual hold overwritten on the entry by a marketing complaint.
  await suppress(emailAddress, "manual");
  await suppress(emailAddress, "complaint", { sourceStream: "marketing" });

  const byEntry = await suppressionCheck({ emailAddress, classification: "transactional" });
  assert.equal(byEntry.allowed, true, "the entry kept only the complaint");

  await setAuthority("causes");
  const byCauses = await suppressionCheck({ emailAddress, classification: "transactional" });
  assert.equal(byCauses.allowed, false, "the manual hold is still a cause");
});

test("a classification cause stops marketing only, once causes decide", async () => {
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
  await setAuthority("causes");
  assert.equal(
    (await suppressionCheck({ emailAddress, classification: "marketing", purpose: "newsletter" })).allowed,
    false
  );
  assert.equal(
    (await suppressionCheck({ emailAddress, classification: "transactional" })).allowed,
    true
  );
});

test("the cutover refuses while causes would let through what an entry stops, and repair fixes it", async () => {
  const emailAddress = address();
  // An entry with no cause behind it: written in a transaction marked as a
  // cause writer, so the trigger does not carry it.
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.suppression_writer', 'causes', true)`;
    await tx.suppressionEntry.create({
      data: { emailAddress, scope: "global", purposeKey: "*", reason: "hard_bounce", source: "provider_webhook" },
    });
  });

  const dry = await runSuppressionCutover({ apply: false, repair: false });
  assert.equal(dry.unsafe.length > 0, true);
  assert.equal(dry.switched, false);

  const refused = await runSuppressionCutover({ apply: true, repair: false });
  assert.equal(refused.refusal, "unsafe_mismatches");
  assert.equal(await prisma.appSetting.count({ where: { key: SUPPRESSION_READ_AUTHORITY_KEY } }), 0);

  const applied = await runSuppressionCutover({ apply: true, repair: true });
  assert.equal(applied.repairedCauses, 1);
  assert.equal(applied.switched, true);
  assert.equal(applied.authorityAfter, "causes");
});

test("a lift releases only what its action may, and keeps the entry while a cause remains", async () => {
  const emailAddress = address();
  const entry = await suppress(emailAddress, "manual");
  await suppress(emailAddress, "privacy_request");
  await setAuthority("causes");

  const active = await activeCausesForEntry(entry.id!);
  assert.ok(active);
  assert.equal(active.needsApproval, false);

  const lifted = await liftSuppressionCauses({
    entryId: entry.id!,
    approvedCauseIds: active.causeIds,
    action: "admin",
    evidence: { kind: "admin" },
    writeReleaseAudit: auditInTx,
  });
  assert.equal(lifted.removed, true);
  assert.ok(lifted.removed && lifted.released.every((cause) => cause.reason === "manual"));
  assert.ok(lifted.removed && lifted.remaining.some((cause) => cause.reason === "privacy_request"));
  assert.equal(await prisma.suppressionEntry.count({ where: { emailAddress } }), 1);

  const released = await prisma.suppressionCause.findFirstOrThrow({
    where: { emailAddress, reason: "manual" },
  });
  const evidence = released.releaseEvidence as { kind: string; releaseAuditLogId: string };
  assert.equal(evidence.kind, "admin");
  assert.ok(await prisma.adminAuditLog.findUnique({ where: { id: evidence.releaseAuditLogId } }));
});

test("an approval for one cause set does not lift a set that changed since", async () => {
  const emailAddress = address();
  const entry = await suppress(emailAddress, "complaint", { sourceStream: "marketing" });
  await setAuthority("causes");
  const active = await activeCausesForEntry(entry.id!);
  assert.ok(active?.needsApproval);

  await suppress(emailAddress, "hard_bounce");

  const lifted = await liftSuppressionCauses({
    entryId: entry.id!,
    approvedCauseIds: active!.causeIds,
    action: "approved_admin",
    evidence: { kind: "sole_admin", authorizationAuditLogId: "audit-start" },
    writeReleaseAudit: auditInTx,
  });
  assert.deepEqual(lifted, { removed: false, refusal: "approval_stale" });
  assert.equal(await prisma.adminAuditLog.count(), 0, "no release, no release audit");
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
  await setAuthority("causes");

  const result = await setPreference({
    userId: user.id,
    purpose: "service_status",
    enabled: true,
    capturedVia: "preference_center",
    source: "preference_center",
  });
  assert.deepEqual(result, { changed: false, reason: "suppressed" });
});
