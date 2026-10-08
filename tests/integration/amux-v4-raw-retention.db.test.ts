import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { Session } from "next-auth";

import { prisma } from "@/lib/prisma";
import { amuxContentUnitKeyId } from "@/lib/amux/ideaKeyStore";
import { commitAmuxDueRawIdeaPurge, readAmuxRawIdeaPurgeOutcome,
  retirePurgedAmuxRawIdeaKey } from "@/lib/amux/ideaRawRetentionService";
import { commitAmuxDueTransferPayloadPurge, commitAmuxDueFreeformPurge,
  commitAmuxDueDraftUnitPurge } from
  "@/lib/amux/ideaAnalysisContentPurgeService";
import { readAmuxContentPurgeOutcome, retireVerifiedAmuxContentKey } from
  "@/lib/amux/ideaContentKeyRetirementService";
import { amuxAnalysisFreeformSubjectId } from
  "@/lib/amux/ideaAnalysisDraftSealCore";
import { commitAmuxIdeaRetentionHold, commitAmuxIdeaRetentionHoldRelease,
  readAmuxIdeaRetentionHoldScope } from
  "@/lib/amux/ideaRetentionHoldService";
import { commitDueAmuxRetentionHoldNotice } from
  "@/lib/amux/ideaRetentionHoldNoticeService";

const testUrl = process.env.TEST_DATABASE_URL?.trim();
const url = testUrl ? new URL(testUrl) : null;
if (!url || !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !/^\/[A-Za-z0-9_-]+(?:[_-]test[0-9]*)$/i.test(url.pathname) ||
    url.search !== "" || url.hash !== "" ||
    process.env.DATABASE_URL !== testUrl ||
    (process.env.DIRECT_DATABASE_URL && process.env.DIRECT_DATABASE_URL !== testUrl)) {
  throw new Error("REFUSE: AMUX v4 retention DB test requires a dedicated loopback test database");
}

process.env.ADMIN_AUDIT_INTEGRITY_KEY = `synthetic-audit-${randomUUID()}`;
const actorUserId = `synthetic-hold-owner-${randomUUID()}`;
const actorEmail = "amux-retention-owner@example.test";
process.env.ADMIN_USER_IDS = actorUserId;
process.env.ADMIN_EMAILS = actorEmail;
process.env.ADMIN_OWNER_EMAILS = actorEmail;
const ownerSession = { user: { id: actorUserId, email: actorEmail,
  authenticatedAt: new Date().toISOString() },
expires: new Date(Date.now() + 60 * 60_000).toISOString() } as Session;
const ownerRequest = new Request("https://tomverse.test/api/admin/amux/ideas/retention-holds",
  { method: "POST" });
after(async () => { await prisma.$disconnect(); });

async function idea(input?: { due?: boolean; keyId?: string;
  submittedAgeDays?: number; completedAgeDays?: number }) {
  const id = randomUUID();
  const submittedAt = new Date(Date.now() - (input?.submittedAgeDays ?? 2) *
    24 * 60 * 60_000);
  const completedAt = new Date(Date.now() - (input?.completedAgeDays ?? 1) *
    24 * 60 * 60_000);
  const due = input?.due !== false;
  await prisma.amuxIdeaSubmission.create({ data: {
    id, requestId: randomUUID(), actorUserId: `synthetic-retention-${id}`,
    state: due ? "completed" : "submitted",
    rawCiphertext: Buffer.from("synthetic encrypted body"),
    rawKeyId: input?.keyId ?? amuxContentUnitKeyId({ ideaId: id,
      purpose: "idea_raw", subjectId: id }), rawKeyVersion: 1,
    rawDigest: "a".repeat(64), rawDigestKeyId: "synthetic-digest",
    submittedAt, analysisDeadlineAt: new Date(submittedAt.getTime() +
      7 * 24 * 60 * 60_000), analysisCompletedAt: due ? completedAt : null,
    rawPurgeAfter: due ? completedAt : new Date(submittedAt.getTime() +
      7 * 24 * 60 * 60_000),
  } });
  return id;
}

test("due idea body purge and external key retirement are distinct audited steps", async () => {
  const id = await idea();
  assert.equal(await prisma.$transaction((tx) => commitAmuxDueRawIdeaPurge(tx, id)), "purged");
  assert.equal(await readAmuxRawIdeaPurgeOutcome(id), "purged");
  const purged = await prisma.amuxIdeaSubmission.findUniqueOrThrow({ where: { id } });
  assert.equal(purged.rawCiphertext, null);
  assert.equal(purged.rawKeyId, null);
  await assert.rejects(prisma.amuxIdeaSubmission.update({ where: { id },
    data: { rawPurgedAt: null, rawCiphertext: Buffer.from("restored"),
      rawKeyId: amuxContentUnitKeyId({ ideaId: id, purpose: "idea_raw",
        subjectId: id }), rawKeyVersion: 1 } }), /cannot be restored/);
  const queued = await prisma.amuxIdeaContentKeyRetirement.findUniqueOrThrow({
    where: { ideaId_purpose_subjectId: { ideaId: id,
      purpose: "idea_raw", subjectId: id } },
  });
  assert.equal(queued.keyDeletedAt, null);
  assert.ok(queued.purgeAuditLogId);
  let deleted = 0;
  const deleteKey = async (target: { ideaId: string; purpose: string; subjectId: string }) => {
    assert.deepEqual(target, { ideaId: id, purpose: "idea_raw", subjectId: id });
    deleted += 1;
  };
  assert.equal(await retirePurgedAmuxRawIdeaKey(id, deleteKey), "deleted");
  assert.equal(await retirePurgedAmuxRawIdeaKey(id, deleteKey), "already_deleted");
  assert.equal(deleted, 1);
  const complete = await prisma.amuxIdeaContentKeyRetirement.findUniqueOrThrow({
    where: { ideaId_purpose_subjectId: { ideaId: id,
      purpose: "idea_raw", subjectId: id } },
  });
  assert.ok(complete.keyDeletedAt);
  assert.ok(complete.keyDeleteAuditLogId);
  await assert.rejects(prisma.amuxIdeaContentKeyRetirement.delete({
    where: { ideaId_purpose_subjectId: { ideaId: id,
      purpose: "idea_raw", subjectId: id } },
  }), /content key retirement cannot be deleted/);
});

test("payload and freeform bodies retire their different external keys", async () => {
  const ideaId = await idea();
  const previewId = randomUUID();
  const actorUserId = `synthetic-retention-${ideaId}`;
  await prisma.amuxIdeaAnalysisChunk.create({ data: { ideaId, actorUserId,
    chunkIndex: 0, state: "pending", attempt: 0, leaseGeneration: 0 } });
  const payloadTarget = { ideaId, purpose: "transfer_payload" as const,
    subjectId: previewId };
  await prisma.amuxIdeaTransferPreview.create({ data: { id: previewId, ideaId,
    chunkIndex: 0, attempt: 1, state: "prepared", modelId: "synthetic-model",
    templateVersion: "synthetic-template", payloadCiphertext: Buffer.from("encrypted"),
    payloadKeyId: amuxContentUnitKeyId(payloadTarget), payloadKeyVersion: 1,
    payloadDigest: "b".repeat(64), payloadDigestKeyId: "synthetic-digest",
    expiresAt: new Date(Date.now() - 25 * 60 * 60_000),
    payloadPurgeAfter: new Date(Date.now() - 60 * 60_000) } });
  const freeformTarget = { ideaId, purpose: "analysis_freeform" as const,
    subjectId: amuxAnalysisFreeformSubjectId(ideaId, previewId) };
  await prisma.amuxIdeaAnalysisChunk.update({ where: { ideaId_chunkIndex: {
    ideaId, chunkIndex: 0 } }, data: { state: "draft_ready",
    currentPreviewId: previewId, analysisCompletedAt: new Date(Date.now() -
      60 * 60_000), freeformCiphertext: Buffer.from("encrypted freeform"),
    freeformKeyId: amuxContentUnitKeyId(freeformTarget), freeformKeyVersion: 1,
    freeformPurgeAfter: new Date(Date.now() - 1000) } });
  assert.equal(await prisma.$transaction((tx) =>
    commitAmuxDueTransferPayloadPurge(tx, previewId)), "purged");
  assert.equal(await prisma.$transaction((tx) =>
    commitAmuxDueFreeformPurge(tx, ideaId, 0)), "purged");
  assert.equal(await readAmuxContentPurgeOutcome(payloadTarget), "purged");
  assert.equal(await readAmuxContentPurgeOutcome(freeformTarget), "purged");
  await assert.rejects(prisma.amuxIdeaTransferPreview.update({
    where: { id: previewId }, data: { payloadPurgedAt: null,
      payloadCiphertext: Buffer.from("restored"),
      payloadKeyId: amuxContentUnitKeyId(payloadTarget),
      payloadKeyVersion: 1 } }), /cannot be restored/);
  await assert.rejects(prisma.amuxIdeaAnalysisChunk.update({
    where: { ideaId_chunkIndex: { ideaId, chunkIndex: 0 } },
    data: { freeformPurgedAt: null,
      freeformCiphertext: Buffer.from("restored"),
      freeformKeyId: amuxContentUnitKeyId(freeformTarget),
      freeformKeyVersion: 1 } }), /cannot be restored/);
  const deleted: string[] = [];
  const deleteKey = async (target: { purpose: string }) => {
    deleted.push(target.purpose);
  };
  assert.equal(await retireVerifiedAmuxContentKey(payloadTarget, deleteKey), "deleted");
  assert.equal(await retireVerifiedAmuxContentKey(freeformTarget, deleteKey), "deleted");
  assert.deepEqual(deleted, ["transfer_payload", "analysis_freeform"]);
});

test("an in-flight payload waits for its live analysis, then purges after cancellation", async () => {
  const ideaId = await idea({ due: false, submittedAgeDays: 1 });
  const previewId = randomUUID();
  const actorUserId = `synthetic-retention-${ideaId}`;
  await prisma.amuxIdeaSubmission.update({ where: { id: ideaId },
    data: { state: "analyzing" } });
  await prisma.amuxIdeaAnalysisChunk.create({ data: { ideaId, actorUserId,
    chunkIndex: 0, state: "pending", attempt: 0, leaseGeneration: 0 } });
  const confirmedAt = new Date(Date.now() - 3 * 60_000);
  const expiresAt = new Date(Date.now() - 60_000);
  await prisma.amuxIdeaTransferPreview.create({ data: {
    id: previewId, ideaId, chunkIndex: 0, attempt: 1, state: "in_flight",
    modelId: "synthetic-model", templateVersion: "synthetic-template",
    payloadCiphertext: Buffer.from("synthetic encrypted payload"),
    payloadKeyId: amuxContentUnitKeyId({ ideaId,
      purpose: "transfer_payload", subjectId: previewId }),
    payloadKeyVersion: 1, payloadDigest: "b".repeat(64),
    payloadDigestKeyId: "synthetic-digest",
    confirmedAt, confirmExpiresAt: expiresAt,
    confirmedByUserId: actorUserId, confirmationAuditLogId: randomUUID(),
    consumedAt: new Date(confirmedAt.getTime() + 30_000),
    expiresAt, payloadPurgeAfter: expiresAt,
  } });
  await prisma.amuxIdeaAnalysisChunk.update({ where: { ideaId_chunkIndex: {
    ideaId, chunkIndex: 0 } }, data: { state: "in_flight", attempt: 1,
    leaseGeneration: 1, currentPreviewId: previewId } });
  assert.equal(await prisma.$transaction((tx) =>
    commitAmuxDueTransferPayloadPurge(tx, previewId)), "skipped");
  const cancelledAt = new Date();
  await prisma.amuxIdeaSubmission.update({ where: { id: ideaId },
    data: { state: "cancelled", cancelledAt, rawPurgeAfter: cancelledAt } });
  assert.equal(await prisma.$transaction((tx) =>
    commitAmuxDueTransferPayloadPurge(tx, previewId)), "purged");
});

test("an unused preview purges at expiry without waiting for the analysis deadline", async () => {
  const ideaId = await idea({ due: false, submittedAgeDays: 1 });
  const previewId = randomUUID();
  const actorUserId = `synthetic-retention-${ideaId}`;
  await prisma.amuxIdeaAnalysisChunk.create({ data: { ideaId, actorUserId,
    chunkIndex: 0, state: "pending", attempt: 0, leaseGeneration: 0 } });
  await prisma.amuxIdeaTransferPreview.create({ data: {
    id: previewId, ideaId, chunkIndex: 0, attempt: 1, state: "prepared",
    modelId: "synthetic-model", templateVersion: "synthetic-template",
    payloadCiphertext: Buffer.from("synthetic encrypted payload"),
    payloadKeyId: amuxContentUnitKeyId({ ideaId,
      purpose: "transfer_payload", subjectId: previewId }),
    payloadKeyVersion: 1, payloadDigest: "b".repeat(64),
    payloadDigestKeyId: "synthetic-digest",
    expiresAt: new Date(Date.now() - 60_000),
    payloadPurgeAfter: new Date(Date.now() + 24 * 60 * 60_000),
  } });
  assert.equal(await prisma.$transaction((tx) =>
    commitAmuxDueTransferPayloadPurge(tx, previewId)), "purged");
});

test("an expired proposal unit purges only its own body and key", async () => {
  const ideaId = await idea({ submittedAgeDays: 32, completedAgeDays: 31 });
  const actorUserId = `synthetic-retention-${ideaId}`;
  const completedAt = new Date(Date.now() - 31 * 24 * 60 * 60_000);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE "AmuxIdeaAnalysisChunk" DISABLE TRIGGER "AmuxIdeaAnalysisChunk_completion_immutable"');
    await tx.amuxIdeaAnalysisChunk.create({ data: { ideaId, actorUserId,
      chunkIndex: 0, state: "draft_ready", attempt: 1, leaseGeneration: 1,
      analysisCompletedAt: completedAt } });
    await tx.$executeRawUnsafe('ALTER TABLE "AmuxIdeaAnalysisChunk" ENABLE TRIGGER "AmuxIdeaAnalysisChunk_completion_immutable"');
  });
  const unitId = randomUUID();
  const target = { ideaId, purpose: "analysis_draft" as const,
    subjectId: unitId };
  // The production trigger correctly refuses creating an already-expired
  // draft. Disable it only within this synthetic fixture transaction, then
  // restore it before exercising the real expiry/purge trigger.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE "AmuxIdeaDraftUnit" DISABLE TRIGGER "AmuxIdeaDraftUnit_guard"');
    await tx.$executeRawUnsafe('ALTER TABLE "AmuxIdeaDraftUnit" DISABLE TRIGGER "AmuxIdeaDraftUnit_z_first_expiry_guard"');
    await tx.amuxIdeaDraftUnit.create({ data: { id: unitId, ideaId,
      actorUserId, chunkIndex: 0, unitIndex: 0, localRef: "c0:card-0",
      unitKind: "card", state: "proposed",
      expiresAt: new Date(completedAt.getTime() + 30 * 24 * 60 * 60_000),
      bodyCiphertext: Buffer.from("encrypted draft"),
      bodyKeyId: amuxContentUnitKeyId(target), bodyKeyVersion: 1,
      bodyDigest: "c".repeat(64), bodyDigestKeyId: "synthetic-digest" } });
    await tx.$executeRawUnsafe('ALTER TABLE "AmuxIdeaDraftUnit" ENABLE TRIGGER "AmuxIdeaDraftUnit_guard"');
    await tx.$executeRawUnsafe('ALTER TABLE "AmuxIdeaDraftUnit" ENABLE TRIGGER "AmuxIdeaDraftUnit_z_first_expiry_guard"');
  });
  assert.equal(await prisma.$transaction((tx) =>
    commitAmuxDueDraftUnitPurge(tx, unitId)), "purged");
  const unit = await prisma.amuxIdeaDraftUnit.findUniqueOrThrow({ where: { id: unitId } });
  assert.equal(unit.state, "expired");
  assert.equal(unit.bodyCiphertext, null);
  assert.ok(unit.bodyPurgedAt);
  assert.equal(await readAmuxContentPurgeOutcome(target), "purged");
  assert.equal(await retireVerifiedAmuxContentKey(target, async () => {}), "deleted");
});

test("early purge and a mismatched external key fail without erasing the body", async () => {
  const earlyId = await idea({ due: false });
  assert.equal(await prisma.$transaction((tx) => commitAmuxDueRawIdeaPurge(tx,
    earlyId)), "skipped");
  assert.equal(await readAmuxRawIdeaPurgeOutcome(earlyId), "not_purged");

  const wrongId = await idea({ keyId: "not-the-external-key" });
  await assert.rejects(prisma.$transaction((tx) => commitAmuxDueRawIdeaPurge(tx,
    wrongId)), /integrity_unavailable/);
  const wrong = await prisma.amuxIdeaSubmission.findUniqueOrThrow({ where: { id: wrongId } });
  assert.ok(wrong.rawCiphertext);
  assert.equal(wrong.rawPurgedAt, null);
});

test("failed object deletion leaves a durable retirement to retry after read-back", async () => {
  const id = await idea();
  await prisma.$transaction((tx) => commitAmuxDueRawIdeaPurge(tx, id));
  await assert.rejects(retirePurgedAmuxRawIdeaKey(id, async () => {
    throw new Error("synthetic object-store outage");
  }), /key_store_unavailable/);
  const pending = await prisma.amuxIdeaContentKeyRetirement.findUniqueOrThrow({
    where: { ideaId_purpose_subjectId: { ideaId: id,
      purpose: "idea_raw", subjectId: id } },
  });
  assert.equal(pending.keyDeletedAt, null);
  assert.equal(await readAmuxRawIdeaPurgeOutcome(id), "purged");
  assert.equal(await retirePurgedAmuxRawIdeaKey(id, async () => {}), "deleted");
});

test("owner hold pauses the original purge clock and release makes it due again", async () => {
  const id = await idea();
  const holdId = randomUUID();
  const scope = await prisma.$transaction((tx) =>
    readAmuxIdeaRetentionHoldScope(tx, id));
  assert.deepEqual(scope, { remainingBodies: 1, alreadyPurgedBodies: 0 });
  const saved = await prisma.$transaction((tx) =>
    commitAmuxIdeaRetentionHold(tx, { session: ownerSession,
      request: ownerRequest, id: holdId, ideaId: id,
      reasonCode: "legal_request", days: 1,
      expectedRemainingBodies: 1, expectedAlreadyPurgedBodies: 0 }));
  assert.equal(saved.holdId, holdId);
  assert.equal(await prisma.$transaction((tx) =>
    commitDueAmuxRetentionHoldNotice(tx, holdId)), "sent");
  assert.equal(await prisma.$transaction((tx) =>
    commitDueAmuxRetentionHoldNotice(tx, holdId)), "skipped");
  const noticed = await prisma.amuxIdeaRetentionHold.findUniqueOrThrow({
    where: { id: holdId } });
  assert.ok(noticed.noticeSentAt);
  assert.ok(noticed.noticeAuditLogId);
  const notification = await prisma.adminNotificationLog.findFirstOrThrow({
    where: { targetType: "AmuxIdeaRetentionHold", targetId: holdId } });
  assert.equal(notification.channel, "in_app");
  assert.equal(await prisma.$transaction((tx) =>
    commitAmuxDueRawIdeaPurge(tx, id)), "skipped");
  const paused = await prisma.amuxIdeaSubmission.findUniqueOrThrow({ where: { id } });
  assert.ok(paused.rawCiphertext);
  const renewedId = randomUUID();
  await prisma.$transaction((tx) => commitAmuxIdeaRetentionHold(tx,
    { session: ownerSession, request: ownerRequest, id: renewedId,
      ideaId: id, reasonCode: "legal_request", days: 2,
      expectedRemainingBodies: 1, expectedAlreadyPurgedBodies: 0,
      replacesHoldId: holdId }));
  const prior = await prisma.amuxIdeaRetentionHold.findUniqueOrThrow({
    where: { id: holdId } });
  assert.ok(prior.releasedAt);
  assert.ok(prior.releaseAuditLogId);
  assert.equal(await prisma.$transaction((tx) =>
    commitAmuxDueRawIdeaPurge(tx, id)), "skipped");
  await prisma.$transaction((tx) => commitAmuxIdeaRetentionHoldRelease(tx,
    { session: ownerSession, request: ownerRequest,
      holdId: renewedId, ideaId: id }));
  assert.equal(await prisma.$transaction((tx) =>
    commitAmuxDueRawIdeaPurge(tx, id)), "purged");
  assert.equal(await readAmuxRawIdeaPurgeOutcome(id), "purged");
});
