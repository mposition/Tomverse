import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";

import type { Session } from "next-auth";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import { inspectAmuxIdeaSubmission } from "@/lib/amux/ideaSubmissionCore";
import { commitIdeaSubmission } from "@/lib/amux/ideaSubmissionService";
import { commitInitialIdeaSourcePlan } from
  "@/lib/amux/ideaInitialSourcePlanAccess";
import { commitIdeaOnlyTransferPreview } from
  "@/lib/amux/ideaTransferPreviewService";
import { commitIdeaTransferConfirmation } from
  "@/lib/amux/ideaTransferConfirmationService";
import { readLatestAmuxV20RegistrationRefusalInTx } from
  "@/lib/amux/ideaRegistrationRefusalReadService";
import { recordAmuxV20RegistrationRefusal,
  AmuxV20RegistrationRefusalStoreError } from
  "@/lib/amux/ideaRegistrationRefusalService";
import { prisma } from "@/lib/prisma";

const testUrl = process.env.TEST_DATABASE_URL?.trim();
const url = testUrl ? new URL(testUrl) : null;
if (!url || !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !/^\/[A-Za-z0-9_-]+(?:[_-]test[0-9]*)$/i.test(url.pathname) ||
    url.search !== "" || url.hash !== "" ||
    process.env.DATABASE_URL !== testUrl ||
    (process.env.DIRECT_DATABASE_URL && process.env.DIRECT_DATABASE_URL !== testUrl)) {
  throw new Error("REFUSE: AMUX v20 refusal DB test requires a dedicated loopback test database");
}

const actorUserId = `synthetic-v20-owner-${randomUUID()}`;
const actorEmail = "amux-v20-refusal-owner@example.test";
process.env.ADMIN_USER_IDS = actorUserId;
process.env.ADMIN_EMAILS = actorEmail;
process.env.ADMIN_OWNER_EMAILS = actorEmail;
// This suite shares the agents-lane database with the v19 operating-scope,
// session-submission and system-registration suites. Audit-chain verification
// therefore has to use the same synthetic integrity key across all four.
process.env.ADMIN_AUDIT_INTEGRITY_KEY =
  "synthetic-amux-intake-operating-scope-audit-key-2026";
const session = { user: { id: actorUserId, email: actorEmail,
  authenticatedAt: new Date().toISOString() },
expires: new Date(Date.now() + 60 * 60_000).toISOString() } as Session;
const request = new Request(
  "https://tomverse.test/api/admin/amux/ideas/unit-decisions/plan-approval",
  { method: "POST", headers: { "user-agent": "synthetic-v20-refusal-test" } },
);
const keys = { masterKeyId: "synthetic-master", masterKeyVersion: 1,
  masterKey: randomBytes(32), digestKeyId: "synthetic-digest",
  digestKey: randomBytes(32) };
const browserNonce = randomBytes(32).toString("base64url");
process.env.AMUX_V4_CONTENT_MASTER_KEY_ID = keys.masterKeyId;
process.env.AMUX_V4_CONTENT_MASTER_KEY_VERSION = String(keys.masterKeyVersion);
process.env.AMUX_V4_CONTENT_MASTER_KEY_B64 = keys.masterKey.toString("base64");
process.env.AMUX_V4_CONTENT_DIGEST_KEY_ID = keys.digestKeyId;
process.env.AMUX_V4_CONTENT_DIGEST_KEY_B64 = keys.digestKey.toString("base64");

after(async () => { await prisma.$disconnect(); });

type Fixture = { ideaId: string; unitId: string; previewId: string;
  sourcePlanRevisionId: string };

async function fixture(): Promise<Fixture> {
  const ideaId = randomUUID();
  const inspected = inspectAmuxIdeaSubmission(JSON.stringify({ version: 1,
    requestId: randomUUID(), input: { version: 1,
      idea: `SYNTHETIC_V20_REFUSAL_${randomUUID()}`,
      repositories: [], pullRequests: [] } }));
  if (!inspected.ok) throw new Error(inspected.code);
  await prisma.$transaction((tx) => commitIdeaSubmission(tx,
    { session, request, inspected, ideaId, keys }));
  const plan = await prisma.$transaction((tx) =>
    commitInitialIdeaSourcePlan(tx, { session, request, ideaId, keys }));
  const previewId = randomUUID();
  const prepared = await prisma.$transaction((tx) =>
    commitIdeaOnlyTransferPreview(tx, { session, request, keys, browserNonce,
      choice: { previewId, ideaId, provider: "openai",
        modelId: "gpt-frontier-synthetic", reasoningEffort: "high",
        approvalId: randomUUID(), approvalVersion: 1 } }));
  await prisma.$transaction((tx) => commitIdeaTransferConfirmation(tx,
    { session, request, browserNonce, keys, choice: { previewId, ideaId,
      payloadDigest: prepared.payloadDigest,
      payloadDigestKeyId: prepared.payloadDigestKeyId } }));
  const completedAt = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.amuxIdeaTransferPreview.update({ where: { id: previewId }, data: {
      state: "completed", consumedAt: completedAt,
    } });
    await tx.amuxIdeaAnalysisChunk.update({
      where: { ideaId_chunkIndex: { ideaId, chunkIndex: 0 } },
      data: { state: "draft_ready", analysisCompletedAt: completedAt },
    });
  });
  const unitId = randomUUID();
  await prisma.amuxIdeaDraftUnit.create({ data: { id: unitId, ideaId,
    actorUserId, chunkIndex: 0, unitIndex: 0, localRef: "c0:card-0",
    unitKind: "card", state: "proposed",
    expiresAt: new Date(completedAt.getTime() + 30 * 24 * 60 * 60_000),
    bodyCiphertext: Buffer.from("synthetic encrypted Task"),
    bodyKeyId: "synthetic-key", bodyKeyVersion: 1,
    bodyDigest: "a".repeat(64), bodyDigestKeyId: "synthetic-digest" } });
  return { ideaId, unitId, previewId,
    sourcePlanRevisionId: plan.revisionId };
}

const metadata = (input: Fixture & { requestId: string; id: string;
  attemptedAt: Date; refusalCode?: string }) => ({
  policyVersion: "20", state: "awaiting_operator",
  requestId: input.requestId, attemptKind: "whole_plan",
  refusalCode: input.refusalCode ?? "task_expected_paths_mixed",
  ideaId: input.ideaId, draftUnitId: input.unitId,
  analysisPreviewId: input.previewId,
  sourcePlanRevisionId: input.sourcePlanRevisionId,
  proposedExecutionGrade: "routine", finalExecutionGrade: null,
  attemptedAt: input.attemptedAt.toISOString(),
});

test("a refusal and human audit are durable, path-free and idempotent by request", async () => {
  const seeded = await fixture();
  const requestId = randomUUID();
  const input = { session, request, requestId, attemptKind: "whole_plan" as const,
    refusalCode: "task_expected_paths_mixed" as const,
    ideaId: seeded.ideaId, draftUnitId: seeded.unitId,
    analysisPreviewId: seeded.previewId,
    proposedExecutionGrade: "routine" as const, finalExecutionGrade: null };
  const first = await recordAmuxV20RegistrationRefusal(input);
  const retry = await recordAmuxV20RegistrationRefusal(input);
  assert.deepEqual(retry, first);
  assert.equal(first.sourcePlanRevisionId, seeded.sourcePlanRevisionId);
  const row = await prisma.amuxIdeaRegistrationRefusal.findUniqueOrThrow({
    where: { requestId }, include: { auditLog: true } });
  assert.equal(row.state, "awaiting_operator");
  assert.equal(row.actorUserId, actorUserId);
  assert.equal(row.auditLog.actorUserId, actorUserId);
  assert.equal(row.auditLog.action, "amux.v20.registration.refuse");
  assert.deepEqual(Object.keys(row.auditLog.metadata as object).sort(), [
    "analysisPreviewId", "attemptKind", "attemptedAt", "draftUnitId",
    "finalExecutionGrade", "ideaId", "policyVersion",
    "proposedExecutionGrade", "refusalCode", "requestId",
    "sourcePlanRevisionId", "state",
  ]);
  assert.equal(JSON.stringify(row.auditLog.metadata).includes("expectedPaths"), false);
  assert.equal(JSON.stringify(row.auditLog.metadata).includes("lib/amux"), false);
  assert.equal(await prisma.amuxIdeaRegistrationRefusal.count({ where: { requestId } }), 1);
  assert.equal(await prisma.adminAuditLog.count({ where: {
    action: "amux.v20.registration.refuse", targetId: row.id } }), 1);
  assert.deepEqual(await prisma.$transaction((tx) =>
    readLatestAmuxV20RegistrationRefusalInTx(tx, seeded.ideaId, actorUserId,
      seeded.previewId, seeded.sourcePlanRevisionId)), first);
  assert.equal(await prisma.$transaction((tx) =>
    readLatestAmuxV20RegistrationRefusalInTx(tx, seeded.ideaId, actorUserId,
      randomUUID(), seeded.sourcePlanRevisionId)), null);
  assert.equal(await prisma.$transaction((tx) =>
    readLatestAmuxV20RegistrationRefusalInTx(tx, seeded.ideaId, actorUserId,
      seeded.previewId, randomUUID())), null);
  const planRequestId = randomUUID();
  await assert.rejects(recordAmuxV20RegistrationRefusal({ ...input,
    requestId: planRequestId, refusalCode: "plan_schema_invalid" }),
  (error: unknown) => error instanceof AmuxV20RegistrationRefusalStoreError &&
    error.code === "integrity_unavailable");
  assert.equal(await prisma.amuxIdeaRegistrationRefusal.count({
    where: { requestId: planRequestId },
  }), 0);
  await prisma.amuxIdeaDraftUnit.update({ where: { id: seeded.unitId },
    data: { state: "approved" } });
  assert.equal(await prisma.$transaction((tx) =>
    readLatestAmuxV20RegistrationRefusalInTx(tx, seeded.ideaId, actorUserId,
      seeded.previewId, seeded.sourcePlanRevisionId)), null);
  await assert.rejects(recordAmuxV20RegistrationRefusal({ ...input,
    refusalCode: "task_role_review_refused" }),
  (error: unknown) => error instanceof AmuxV20RegistrationRefusalStoreError &&
    error.code === "integrity_unavailable");
});

test("the DB requires same-transaction exact audit evidence and append-only rows", async () => {
  const seeded = await fixture();
  const attemptedAt = new Date();
  const requestId = randomUUID();
  const id = randomUUID();
  const auditId = await prisma.$transaction((tx) => writeAdminAuditLog({ tx,
    session, request, action: "amux.v20.registration.refuse",
    targetType: "AmuxIdeaRegistrationRefusal", targetId: id,
    summary: "Recorded one deterministic AMUX v20 Task registration refusal for operator review.",
    metadata: metadata({ ...seeded, requestId, id, attemptedAt }) }));
  await assert.rejects(prisma.amuxIdeaRegistrationRefusal.create({ data: {
    id, requestId, attemptKind: "whole_plan", state: "awaiting_operator",
    refusalCode: "task_expected_paths_mixed", ideaId: seeded.ideaId,
    draftUnitId: seeded.unitId, actorUserId,
    analysisPreviewId: seeded.previewId,
    sourcePlanRevisionId: seeded.sourcePlanRevisionId,
    proposedExecutionGrade: "routine", finalExecutionGrade: null,
    attemptedAt, auditLogId: auditId,
  } }), /AmuxIdeaRegistrationRefusal_evidence_check|evidence mismatch/);

  await assert.rejects(prisma.$transaction(async (tx) => {
    const forgedId = randomUUID();
    const forgedRequestId = randomUUID();
    const forgedAt = new Date();
    const forgedAuditId = await writeAdminAuditLog({ tx, session, request,
      action: "amux.v20.registration.refuse",
      targetType: "AmuxIdeaRegistrationRefusal", targetId: forgedId,
      summary: "Recorded one deterministic AMUX v20 Task registration refusal for operator review.",
      metadata: { ...metadata({ ...seeded, requestId: forgedRequestId,
        id: forgedId, attemptedAt: forgedAt }),
      expectedPaths: ["lib/amux/private.ts"] } });
    await tx.amuxIdeaRegistrationRefusal.create({ data: {
      id: forgedId, requestId: forgedRequestId, attemptKind: "whole_plan",
      state: "awaiting_operator", refusalCode: "task_expected_paths_mixed",
      ideaId: seeded.ideaId, draftUnitId: seeded.unitId, actorUserId,
      analysisPreviewId: seeded.previewId,
      sourcePlanRevisionId: seeded.sourcePlanRevisionId,
      proposedExecutionGrade: "routine", finalExecutionGrade: null,
      attemptedAt: forgedAt, auditLogId: forgedAuditId,
    } });
  }), /AmuxIdeaRegistrationRefusal_evidence_check|evidence mismatch/);

  await assert.rejects(prisma.$transaction(async (tx) => {
    const forgedId = randomUUID();
    const forgedRequestId = randomUUID();
    const forgedAt = new Date();
    const fullMetadata = metadata({
      ...seeded, requestId: forgedRequestId, id: forgedId,
      attemptedAt: forgedAt,
    });
    const missingNullableKey = Object.fromEntries(
      Object.entries(fullMetadata).filter(([key]) => key !== "finalExecutionGrade"),
    );
    const forgedAuditId = await writeAdminAuditLog({ tx, session, request,
      action: "amux.v20.registration.refuse",
      targetType: "AmuxIdeaRegistrationRefusal", targetId: forgedId,
      summary: "Recorded one deterministic AMUX v20 Task registration refusal for operator review.",
      metadata: missingNullableKey });
    await tx.amuxIdeaRegistrationRefusal.create({ data: {
      id: forgedId, requestId: forgedRequestId, attemptKind: "whole_plan",
      state: "awaiting_operator", refusalCode: "task_expected_paths_mixed",
      ideaId: seeded.ideaId, draftUnitId: seeded.unitId, actorUserId,
      analysisPreviewId: seeded.previewId,
      sourcePlanRevisionId: seeded.sourcePlanRevisionId,
      proposedExecutionGrade: "routine", finalExecutionGrade: null,
      attemptedAt: forgedAt, auditLogId: forgedAuditId,
    } });
  }), /AmuxIdeaRegistrationRefusal_evidence_check|evidence mismatch/);

  const committed = await recordAmuxV20RegistrationRefusal({ session, request,
    requestId: randomUUID(), attemptKind: "whole_plan",
    refusalCode: "task_expected_paths_mixed", ideaId: seeded.ideaId,
    draftUnitId: seeded.unitId, analysisPreviewId: seeded.previewId,
    proposedExecutionGrade: "routine", finalExecutionGrade: null });
  for (const operation of [
    () => prisma.amuxIdeaRegistrationRefusal.update({
      where: { requestId: committed.requestId },
      data: { state: "awaiting_operator" } }),
    () => prisma.amuxIdeaRegistrationRefusal.delete({
      where: { requestId: committed.requestId } }),
    () => prisma.$executeRawUnsafe('TRUNCATE "AmuxIdeaRegistrationRefusal" CASCADE'),
  ]) await assert.rejects(operation(), /append-only|append_only/);
  assert.equal(await prisma.amuxIdeaRegistrationRefusal.count({
    where: { requestId: committed.requestId } }), 1);
});
