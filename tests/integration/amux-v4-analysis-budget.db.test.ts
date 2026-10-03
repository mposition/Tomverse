import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";

import type { Session } from "next-auth";
import { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeAdminAuditLog,
  writeSystemAuditLog } from "@/lib/adminAudit";
import { auditRowActorKind,
  AMUX_V4_ANALYSIS_BUDGET_EXPIRE_SCOPE,
  AMUX_V4_ANALYSIS_BUDGET_SETTLE_SCOPE,
  AMUX_V4_ANALYSIS_OUTCOME_UNKNOWN_SCOPE,
  AMUX_V4_FIRST_DRAFT_SAVED_ACTION,
  AMUX_V4_FIRST_DRAFT_SAVED_SCOPE,
  AMUX_V4_FIRST_DRAFT_SAVED_TARGET,
  AMUX_V4_SECOND_DRAFT_SAVED_ACTION,
  AMUX_V4_SECOND_DRAFT_SAVED_SCOPE,
  AMUX_V4_IDEA_SYSTEM_ACTOR, AMUX_SYSTEM_AUDIT_ACTOR } from
  "@/lib/adminAuditSystemActors";
import { isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { inspectAmuxIdeaSubmission } from "@/lib/amux/ideaSubmissionCore";
import { commitIdeaSubmission } from "@/lib/amux/ideaSubmissionService";
import { commitInitialIdeaSourcePlan } from "@/lib/amux/ideaInitialSourcePlanAccess";
import { commitFirstOutputContinuationTransferPreview,
  commitIdeaOnlyTransferPreview, readIdeaOnlyTransferPreview } from
  "@/lib/amux/ideaTransferPreviewService";
import { commitIdeaTransferConfirmation, readIdeaTransferConfirmation } from
  "@/lib/amux/ideaTransferConfirmationService";
import { commitAmuxIdeaAnalysisBudgetReservation,
  AmuxIdeaAnalysisReservationError } from "@/lib/amux/ideaAnalysisBudgetReservationService";
import { listAmuxV4AnalysisCandidates } from "@/lib/amux/ideaAnalysisQueueService";
import { parseAmuxV4AnalysisQueueCursor,
  type AmuxV4AnalysisQueueCursor } from "@/lib/amux/ideaAnalysisQueueCursorCore";
import { commitAmuxIdeaAnalysisUnusedReservationCancellation,
  AmuxIdeaAnalysisCancellationError } from "@/lib/amux/ideaAnalysisBudgetCancellationService";
import { commitAmuxExpiredIdeaAnalysisReservationRelease } from
  "@/lib/amux/ideaAnalysisBudgetExpiryService";
import { commitAmuxKnownIdeaAnalysisSettlement,
  AmuxIdeaAnalysisSettlementError } from "@/lib/amux/ideaAnalysisBudgetSettlementService";
import { commitAmuxIdeaAnalysisUnknownOutcome,
  AmuxIdeaAnalysisUnknownOutcomeError } from "@/lib/amux/ideaAnalysisUnknownOutcomeService";
import { commitAmuxFirstIdeaAnalysisDraft,
  AmuxFirstAnalysisDraftError } from "@/lib/amux/ideaFirstAnalysisDraftService";
import { commitAmuxSecondIdeaAnalysisDraft,
  AmuxSecondAnalysisDraftError } from "@/lib/amux/ideaSecondAnalysisDraftService";
import { readAmuxFirstIdeaAnalysisResult,
  AmuxIdeaAnalysisResultReadError } from "@/lib/amux/ideaAnalysisResultReadService";
import { readAmuxIdeaAnalysisResult,
  readAmuxIdeaAnalysisResultInTransaction } from
  "@/lib/amux/ideaContinuedAnalysisResultReadService";
import { commitAmuxUnitRejectPrepare, commitAmuxUnitRejectConsume,
  commitAmuxUnitRejectUnknown,
  readAmuxUnitRejectDecision, AmuxUnitRejectError } from
  "@/lib/amux/ideaUnitRejectService";
import { commitAmuxRootNodePrepare, commitAmuxRootNodeConsume,
  commitAmuxRootNodeUnknown, commitAmuxRootNodeNoCommitConfirmed,
  AmuxNodeCreateError } from "@/lib/amux/ideaNodeCreateService";
import { readAmuxRootNodeDecision,
  readAmuxRootNodeDecisionInTransaction } from
  "@/lib/amux/ideaNodeDecisionReadService";
import { resolveApprovedAmuxRootParent,
  AmuxNodeParentResolutionError } from
  "@/lib/amux/ideaNodeParentResolutionService";
import { sealAmuxNodeText } from "@/lib/amux/ideaNodeContentCore";
import { openAmuxContent } from "@/lib/amux/ideaCrypto";
import { commitAmuxIdeaAnalysisPriceApproval,
  commitAmuxIdeaAnalysisPriceRevocation,
  AmuxIdeaAnalysisPriceApprovalError } from "@/lib/amux/ideaAnalysisPriceVersionWrite";
import { readApprovedAmuxIdeaAnalysisPriceVersion } from "@/lib/amux/ideaAnalysisPriceVersionRead";
import { prisma } from "@/lib/prisma";

const testUrl = process.env.TEST_DATABASE_URL?.trim();
const url = testUrl ? new URL(testUrl) : null;
if (!url || !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !/^\/[A-Za-z0-9_-]+(?:[_-]test[0-9]*)$/i.test(url.pathname) ||
    url.search !== "" || url.hash !== "" ||
    process.env.DATABASE_URL !== testUrl ||
    (process.env.DIRECT_DATABASE_URL && process.env.DIRECT_DATABASE_URL !== testUrl)) {
  throw new Error("REFUSE: AMUX v4 budget DB test requires one dedicated loopback test database");
}

const actorUserId = `synthetic-amux-budget-owner-${randomUUID()}`;
const actorEmail = "amux-v4-budget-owner@example.test";
process.env.ADMIN_USER_IDS = actorUserId;
process.env.ADMIN_EMAILS = actorEmail;
process.env.ADMIN_OWNER_EMAILS = actorEmail;
process.env.ADMIN_AUDIT_INTEGRITY_KEY = `synthetic-audit-${randomUUID()}`;
const session = { user: { id: actorUserId, email: actorEmail,
  authenticatedAt: new Date().toISOString() },
expires: new Date(Date.now() + 60 * 60_000).toISOString() } as Session;
const request = new Request("https://tomverse.test/api/admin/amux/ideas/submissions",
  { method: "POST" });
const keys = { masterKeyId: "synthetic-master", masterKeyVersion: 1,
  masterKey: randomBytes(32), digestKeyId: "synthetic-digest", digestKey: randomBytes(32) };
const browserNonce = randomBytes(32).toString("base64url");
process.env.AMUX_V4_CONTENT_MASTER_KEY_ID = keys.masterKeyId;
process.env.AMUX_V4_CONTENT_MASTER_KEY_VERSION = String(keys.masterKeyVersion);
process.env.AMUX_V4_CONTENT_MASTER_KEY_B64 = keys.masterKey.toString("base64");
process.env.AMUX_V4_CONTENT_DIGEST_KEY_ID = keys.digestKeyId;
process.env.AMUX_V4_CONTENT_DIGEST_KEY_B64 = keys.digestKey.toString("base64");

after(async () => { await prisma.$disconnect(); });

async function confirmedPreviewId(modelId: string): Promise<string> {
  const ideaId = randomUUID();
  const inspected = inspectAmuxIdeaSubmission(JSON.stringify({
    version: 1, requestId: randomUUID(), input: { version: 1,
      idea: `SYNTHETIC_BUDGET_${randomUUID()}`, repositories: [], pullRequests: [] },
  }));
  if (!inspected.ok) throw new Error(inspected.code);
  await prisma.$transaction((tx) => commitIdeaSubmission(tx,
    { session, request, inspected, ideaId, keys }));
  await prisma.$transaction((tx) => commitInitialIdeaSourcePlan(tx,
    { session, request, ideaId, keys }));
  const choice = { previewId: randomUUID(), ideaId, provider: "openai" as const,
    modelId, reasoningEffort: "high" as const,
    approvalId: randomUUID(), approvalVersion: 1 };
  const prepared = await prisma.$transaction((tx) => commitIdeaOnlyTransferPreview(tx,
    { session, request, choice, keys, browserNonce }));
  await prisma.$transaction((tx) => commitIdeaTransferConfirmation(tx,
    { session, request, choice: { previewId: choice.previewId, ideaId,
      payloadDigest: prepared.payloadDigest,
      payloadDigestKeyId: prepared.payloadDigestKeyId }, browserNonce, keys }));
  return choice.previewId;
}

test("analysis queue lists confirmed preview metadata without exposing payload", async () => {
  const previewId = await confirmedPreviewId(`gpt-frontier-synthetic-${randomUUID()}`);
  let cursor: AmuxV4AnalysisQueueCursor | null = null;
  let found = false;
  for (let page = 0; page < 10; page += 1) {
    const result = await listAmuxV4AnalysisCandidates(cursor);
    assert.equal(Object.keys(result).sort().join(","),
      "candidates,hasMore,nextCursor");
    for (const candidate of result.candidates) {
      assert.deepEqual(Object.keys(candidate).sort(),
        ["attempt", "chunkIndex", "expiresAt", "ideaId", "modelId", "previewId"]);
      if (candidate.previewId === previewId) found = true;
    }
    if (found || !result.hasMore) break;
    assert.ok(result.nextCursor);
    cursor = parseAmuxV4AnalysisQueueCursor(result.nextCursor);
    assert.ok(cursor);
  }
  assert.equal(found, true);
});

const namespace = "agent/amux-intake";
const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(),
  new Date().getUTCMonth(), 1));
const runner = { tokenCapsEnforceable: true, billableToolsDisabled: true };
const modelId = () => `gpt-frontier-synthetic-${randomUUID()}`;

async function approvedPriceVersionId(provider: "openai" | "anthropic",
  selectedModelId: string, expiresInMs = 24 * 60 * 60_000): Promise<string> {
  const id = randomUUID();
  const verifiedAt = new Date(Date.now() - 24 * 60 * 60_000);
  const expiresAt = new Date(Date.now() + expiresInMs);
  const evidenceDigest = randomBytes(32).toString("hex");
  const approval = { id, provider, modelId: selectedModelId,
    mode: "subscription_cli" as const, expectedPreviousVersion: 0,
    inputTokensCap: 1_000, outputTokensCap: 2_000,
    inputMicroUsdPerMillion: 1_000_000,
    outputMicroUsdPerMillion: 2_000_000, evidenceDigest,
    ownerConfirmedWorstTier: true as const, verifiedAt, expiresAt };
  const result = await prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisPriceApproval(tx, { session, request, approval }));
  assert.equal(result.priceVersionId, id);
  assert.equal(result.version, 1);
  return id;
}

test("price evidence needs an owner and current version before it can authorize a hold", async () => {
  const selectedModelId = modelId();
  const id = await approvedPriceVersionId("openai", selectedModelId);
  const row = await prisma.amuxIdeaAnalysisPriceVersion.findUniqueOrThrow({
    where: { id },
  });
  const attempted = { id: randomUUID(), provider: "openai" as const,
    modelId: selectedModelId, mode: "subscription_cli" as const,
    expectedPreviousVersion: 0, inputTokensCap: 1_000,
    outputTokensCap: 2_000, inputMicroUsdPerMillion: 1_000_000,
    outputMicroUsdPerMillion: 2_000_000,
    evidenceDigest: randomBytes(32).toString("hex"),
    ownerConfirmedWorstTier: true as const,
    verifiedAt: new Date(Date.now() - 1_000),
    expiresAt: new Date(Date.now() + 60_000) };
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisPriceApproval(tx, { session, request,
      approval: attempted })), (error: unknown) =>
    error instanceof AmuxIdeaAnalysisPriceApprovalError &&
    error.code === "price_revision_changed");
  const notOwner = { ...session, user: { ...session.user,
    id: `other-${randomUUID()}`, email: "other@example.test" } } as Session;
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisPriceApproval(tx, { session: notOwner, request,
      approval: { ...attempted, modelId: modelId() } })), (error: unknown) =>
    error instanceof AmuxIdeaAnalysisPriceApprovalError &&
    error.code === "forbidden");
  assert.equal(await prisma.amuxIdeaAnalysisPriceVersion.count({
    where: { provider: "openai", modelId: selectedModelId,
      mode: "subscription_cli" },
  }), 1);
  assert.equal(row.status, "approved");
  assert.ok(Math.abs(row.approvedAt.getTime() - Date.now()) < 60_000);
  assert.ok(Math.abs(row.expiresAt.getTime() - Date.now() - 24 * 60 * 60_000) < 60_000);
  const expired = await prisma.$transaction((tx) =>
    readApprovedAmuxIdeaAnalysisPriceVersion(tx, {
      priceVersionId: id, provider: "openai", modelId: selectedModelId,
      now: new Date(row.expiresAt.getTime() + 1),
    }));
  assert.deepEqual(expired, { decision: "hold", reason: "price_unverified" });
});

test("confirmed preview reserves one agent-only budget hold and one system audit atomically", async () => {
  const selectedModelId = modelId();
  const previewId = await confirmedPreviewId(selectedModelId);
  const priceVersionId = await approvedPriceVersionId("openai", selectedModelId);
  await prisma.amuxIdeaAnalysisBudgetWindow.upsert({
    where: { namespace_monthStart: { namespace, monthStart } },
    create: { namespace, monthStart, limitMicroUsd: BigInt(50_000_000) },
    update: { spentMicroUsd: BigInt(0), reservedMicroUsd: BigInt(0) },
  });
  const holdId = randomUUID();
  const result = await prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisBudgetReservation(tx,
      { holdId, previewId, priceVersionId, runner, keys }));
  assert.equal(result.reservedMicroUsd, "5000");
  const created = await prisma.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({
    where: { id: holdId },
  });
  assert.equal(created.previewId, previewId);
  assert.equal(created.priceVersionId, priceVersionId);
  for (const refusedId of [holdId, "not a valid hold ID"]) {
    await assert.rejects(prisma.$transaction((tx) =>
      commitAmuxKnownIdeaAnalysisSettlement(tx, {
        holdId: refusedId, outcome: "verified_success",
        inputTokens: 10, outputTokens: 10,
      })), (error: unknown) =>
      error instanceof AmuxIdeaAnalysisSettlementError &&
      error.code === "not_settleable");
  }
  await assert.rejects(prisma.amuxIdeaAnalysisPriceVersion.update({
    where: { id: priceVersionId },
    data: { inputMicroUsdPerMillion: 1 },
  }), /price version may only be revoked once/);
  assert.equal(created.settledMicroUsd, null);
  assert.equal((await prisma.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
    where: { namespace_monthStart: { namespace, monthStart } },
  })).reservedMicroUsd, BigInt(5_000));
  await assert.rejects(prisma.amuxIdeaAnalysisBudgetWindow.update({
    where: { namespace_monthStart: { namespace, monthStart } },
    data: { spentMicroUsd: BigInt(49_995_001) },
  }), /AmuxIdeaAnalysisBudgetWindow_total_check/);
  const audit = await prisma.adminAuditLog.findUniqueOrThrow({
    where: { id: result.auditId },
  });
  assert.equal(audit.action, "AMUX_V4_ANALYSIS_BUDGET_RESERVED");
  assert.equal(audit.targetId, holdId);
  assert.equal((audit.metadata as Record<string, unknown>).modelCallStarted, false);
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisBudgetReservation(tx,
      { holdId: randomUUID(), previewId, priceVersionId, runner, keys })),
  (error: unknown) => error instanceof AmuxIdeaAnalysisReservationError &&
    error.code === "already_reserved");
  assert.equal(await prisma.adminAuditLog.count({ where: {
    action: "AMUX_V4_ANALYSIS_BUDGET_RESERVED", targetType: "AmuxIdeaAnalysisBudgetHold",
    metadata: { path: ["previewId"], equals: previewId },
  } }), 1);
  await assert.rejects(prisma.amuxIdeaAnalysisBudgetHold.create({
    data: { ...created, id: randomUUID() },
  }), (error: unknown) => error !== null && typeof error === "object" &&
    "code" in error && error.code === "P2002");
  await assert.rejects(prisma.amuxIdeaAnalysisBudgetHold.update({
    where: { id: holdId }, data: { status: "released", settledMicroUsd: BigInt(0) },
  }), /AmuxIdeaAnalysisBudgetHold_lifecycle_check/);
  const stillReserved = await prisma.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({
    where: { id: holdId },
  });
  assert.equal(stillReserved.status, "reserved");
  assert.equal(stillReserved.settledMicroUsd, null);
  // Exercise unknown-state constraints without leaving a global halt behind
  // that would make the next isolated test run fail admission.
  for (const forbiddenStatus of ["owner_consumed", "released"] as const) {
    await assert.rejects(prisma.$transaction(async (tx) => {
      const dispatchedAt = new Date();
      await tx.amuxIdeaAnalysisBudgetHold.update({ where: { id: holdId },
        data: { status: "outcome_unknown", dispatchedAt } });
      await tx.amuxIdeaAnalysisBudgetHold.update({
        where: { id: holdId }, data: { status: forbiddenStatus,
        closedAt: dispatchedAt, settledMicroUsd: BigInt(0) },
      });
    }), /AmuxIdeaAnalysisBudgetHold_lifecycle_check/);
  }
  assert.equal((await prisma.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({
    where: { id: holdId },
  })).status, "reserved");
});

test("a price expiring in one minute still reserves under the DB UTC clock", async () => {
  const selectedModelId = modelId();
  const previewId = await confirmedPreviewId(selectedModelId);
  const priceVersionId = await approvedPriceVersionId("openai", selectedModelId, 60_000);
  await prisma.amuxIdeaAnalysisBudgetWindow.upsert({
    where: { namespace_monthStart: { namespace, monthStart } },
    create: { namespace, monthStart, limitMicroUsd: BigInt(50_000_000) },
    update: {},
  });
  const result = await prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisBudgetReservation(tx, {
      holdId: randomUUID(), previewId, priceVersionId, runner, keys,
    }));
  assert.equal(result.reservedMicroUsd, "5000");
});

test("owner cancels only an unused hold, releasing the reservation with one audit", async () => {
  const selectedModelId = modelId();
  const previewId = await confirmedPreviewId(selectedModelId);
  const priceVersionId = await approvedPriceVersionId("openai", selectedModelId);
  await prisma.amuxIdeaAnalysisBudgetWindow.upsert({
    where: { namespace_monthStart: { namespace, monthStart } },
    create: { namespace, monthStart, limitMicroUsd: BigInt(50_000_000) },
    update: {},
  });
  const reservedBefore = (await prisma.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
    where: { namespace_monthStart: { namespace, monthStart } },
  })).reservedMicroUsd;
  const holdId = randomUUID();
  await prisma.$transaction((tx) => commitAmuxIdeaAnalysisBudgetReservation(tx,
    { holdId, previewId, priceVersionId, runner, keys }));
  const nonOwnerId = `synthetic-amux-budget-ops-${randomUUID()}`;
  const nonOwnerEmail = "amux-v4-budget-ops@example.test";
  const previousOpsEmails = process.env.ADMIN_OPS_EMAILS;
  process.env.ADMIN_USER_IDS = `${actorUserId},${nonOwnerId}`;
  process.env.ADMIN_EMAILS = `${actorEmail},${nonOwnerEmail}`;
  process.env.ADMIN_OPS_EMAILS = nonOwnerEmail;
  try {
    const notOwner = { ...session, user: { ...session.user,
      id: nonOwnerId, email: nonOwnerEmail } } as Session;
    await assert.rejects(prisma.$transaction((tx) =>
      commitAmuxIdeaAnalysisUnusedReservationCancellation(tx,
        { session: notOwner, request, holdId })), (error: unknown) =>
      error instanceof AmuxIdeaAnalysisCancellationError &&
      error.code === "forbidden");
  } finally {
    process.env.ADMIN_USER_IDS = actorUserId;
    process.env.ADMIN_EMAILS = actorEmail;
    if (previousOpsEmails === undefined) delete process.env.ADMIN_OPS_EMAILS;
    else process.env.ADMIN_OPS_EMAILS = previousOpsEmails;
  }
  const staleOwner = { ...session, user: { ...session.user,
    authenticatedAt: new Date(Date.now() - 60 * 60_000).toISOString() } } as Session;
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisUnusedReservationCancellation(tx,
      { session: staleOwner, request, holdId })), isAdminReauthenticationError);
  const cancelled = await prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisUnusedReservationCancellation(tx,
      { session, request, holdId }));
  assert.equal(cancelled.releasedMicroUsd, "5000");
  const [hold, window, audit] = await Promise.all([
    prisma.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({ where: { id: holdId } }),
    prisma.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
      where: { namespace_monthStart: { namespace, monthStart } },
    }),
    prisma.adminAuditLog.findUniqueOrThrow({ where: { id: cancelled.auditId } }),
  ]);
  assert.equal(hold.status, "released");
  assert.equal(hold.settledMicroUsd, BigInt(0));
  assert.equal(window.reservedMicroUsd, reservedBefore);
  assert.equal(audit.action, "amux.v4.analysis_budget.unused_reservation_cancelled");
  assert.equal(audit.actorUserId, actorUserId);
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisUnusedReservationCancellation(tx,
      { session, request, holdId })), (error: unknown) =>
    error instanceof AmuxIdeaAnalysisCancellationError &&
    error.code === "not_cancellable");
  assert.equal(await prisma.adminAuditLog.count({ where: {
    action: "amux.v4.analysis_budget.unused_reservation_cancelled",
    targetId: holdId,
  } }), 1);
});

test("system expiry releases only a never-dispatched hold after its DB deadline", async () => {
  const selectedModelId = modelId();
  const previewId = await confirmedPreviewId(selectedModelId);
  const priceVersionId = await approvedPriceVersionId("openai", selectedModelId);
  await prisma.amuxIdeaAnalysisBudgetWindow.upsert({
    where: { namespace_monthStart: { namespace, monthStart } },
    create: { namespace, monthStart, limitMicroUsd: BigInt(50_000_000) },
    update: {},
  });
  const reservedBefore = (await prisma.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
    where: { namespace_monthStart: { namespace, monthStart } },
  })).reservedMicroUsd;
  const holdId = randomUUID();
  await prisma.$transaction((tx) => commitAmuxIdeaAnalysisBudgetReservation(tx,
    { holdId, previewId, priceVersionId, runner, keys }));
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxExpiredIdeaAnalysisReservationRelease(tx, holdId)),
  (error: unknown) => error instanceof AmuxIdeaAnalysisCancellationError &&
    error.code === "not_cancellable");
  assert.equal(await prisma.adminAuditLog.count({ where: {
    action: "AMUX_V4_ANALYSIS_UNUSED_RESERVATION_EXPIRED", targetId: holdId,
  } }), 0);

  const preview = await prisma.amuxIdeaTransferPreview.findUniqueOrThrow({
    where: { id: previewId }, select: { confirmedAt: true, ideaId: true },
  });
  const expiresAt = new Date(preview.confirmedAt!.getTime() + 1);
  await prisma.amuxIdeaTransferPreview.update({
    where: { id: previewId }, data: { expiresAt, confirmExpiresAt: expiresAt },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(prisma.$transaction(async (tx) => {
    await tx.amuxIdeaAnalysisBudgetHold.update({ where: { id: holdId },
      data: { status: "in_flight", dispatchedAt: new Date() } });
    await assert.rejects(commitAmuxExpiredIdeaAnalysisReservationRelease(tx, holdId),
      (error: unknown) => error instanceof AmuxIdeaAnalysisCancellationError &&
        error.code === "not_cancellable");
    throw new Error("rollback synthetic dispatch");
  }), /rollback synthetic dispatch/);
  for (const unsafePreview of [
    { consumedAt: preview.confirmedAt! },
    { outcomeUnknownAt: new Date() },
    { state: "provider_failed" },
  ]) {
    await assert.rejects(prisma.$transaction(async (tx) => {
      await tx.amuxIdeaTransferPreview.update({
        where: { id: previewId }, data: unsafePreview,
      });
      await assert.rejects(commitAmuxExpiredIdeaAnalysisReservationRelease(tx, holdId),
        (error: unknown) => error instanceof AmuxIdeaAnalysisCancellationError &&
          error.code === "not_cancellable");
      throw new Error("rollback synthetic unsafe preview");
    }), /rollback synthetic unsafe preview/);
  }

  const released = await prisma.$transaction((tx) =>
    commitAmuxExpiredIdeaAnalysisReservationRelease(tx, holdId));
  assert.equal(released.releasedMicroUsd, "5000");
  const [hold, window, audit, idea] = await Promise.all([
    prisma.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({ where: { id: holdId } }),
    prisma.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
      where: { namespace_monthStart: { namespace, monthStart } },
    }),
    prisma.adminAuditLog.findUniqueOrThrow({ where: { id: released.auditId } }),
    prisma.amuxIdeaSubmission.findUniqueOrThrow({ where: { id: preview.ideaId } }),
  ]);
  assert.equal(hold.status, "released");
  assert.equal(hold.dispatchedAt, null);
  assert.equal(window.reservedMicroUsd, reservedBefore);
  assert.equal(auditRowActorKind(audit), "system");
  assert.equal((audit.metadata as Record<string, unknown>).actorScope,
    AMUX_V4_ANALYSIS_BUDGET_EXPIRE_SCOPE);
  assert.equal(idea.state, "submitted", "budget release does not claim to cancel analysis");
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxExpiredIdeaAnalysisReservationRelease(tx, holdId)),
  (error: unknown) => error instanceof AmuxIdeaAnalysisCancellationError &&
    error.code === "not_cancellable");
  assert.equal(await prisma.adminAuditLog.count({ where: {
    action: "AMUX_V4_ANALYSIS_UNUSED_RESERVATION_EXPIRED", targetId: holdId,
  } }), 1);
});

test("owner cancellation and system expiry cannot release one reservation twice", async () => {
  const selectedModelId = modelId();
  const previewId = await confirmedPreviewId(selectedModelId);
  const priceVersionId = await approvedPriceVersionId("openai", selectedModelId);
  await prisma.amuxIdeaAnalysisBudgetWindow.upsert({
    where: { namespace_monthStart: { namespace, monthStart } },
    create: { namespace, monthStart, limitMicroUsd: BigInt(50_000_000) },
    update: {},
  });
  const reservedBefore = (await prisma.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
    where: { namespace_monthStart: { namespace, monthStart } },
  })).reservedMicroUsd;
  const holdId = randomUUID();
  await prisma.$transaction((tx) => commitAmuxIdeaAnalysisBudgetReservation(tx,
    { holdId, previewId, priceVersionId, runner, keys }));
  const preview = await prisma.amuxIdeaTransferPreview.findUniqueOrThrow({
    where: { id: previewId }, select: { confirmedAt: true },
  });
  const expiresAt = new Date(preview.confirmedAt!.getTime() + 1);
  await prisma.amuxIdeaTransferPreview.update({
    where: { id: previewId }, data: { expiresAt, confirmExpiresAt: expiresAt },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const results = await Promise.allSettled([
    prisma.$transaction((tx) => commitAmuxIdeaAnalysisUnusedReservationCancellation(tx,
      { session, request, holdId })),
    prisma.$transaction((tx) => commitAmuxExpiredIdeaAnalysisReservationRelease(tx, holdId)),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const loser = results.find((result) => result.status === "rejected");
  assert.ok(loser?.status === "rejected" &&
    loser.reason instanceof AmuxIdeaAnalysisCancellationError &&
    loser.reason.code === "not_cancellable");
  assert.equal((await prisma.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
    where: { namespace_monthStart: { namespace, monthStart } },
  })).reservedMicroUsd, reservedBefore);
  assert.equal((await prisma.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({
    where: { id: holdId },
  })).status, "released");
  assert.equal(await prisma.adminAuditLog.count({ where: { targetId: holdId,
    action: { in: ["AMUX_V4_ANALYSIS_UNUSED_RESERVATION_EXPIRED",
      "amux.v4.analysis_budget.unused_reservation_cancelled"] } } }), 1);
});

test("unused holds remain cancellable after their confirmed preview expires", async () => {
  const selectedModelId = modelId();
  const previewId = await confirmedPreviewId(selectedModelId);
  const priceVersionId = await approvedPriceVersionId("openai", selectedModelId);
  await prisma.amuxIdeaAnalysisBudgetWindow.upsert({
    where: { namespace_monthStart: { namespace, monthStart } },
    create: { namespace, monthStart, limitMicroUsd: BigInt(50_000_000) },
    update: {},
  });
  const reservedBefore = (await prisma.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
    where: { namespace_monthStart: { namespace, monthStart } },
  })).reservedMicroUsd;
  const holdId = randomUUID();
  await prisma.$transaction((tx) => commitAmuxIdeaAnalysisBudgetReservation(tx,
    { holdId, previewId, priceVersionId, runner, keys }));
  const confirmed = await prisma.amuxIdeaTransferPreview.findUniqueOrThrow({
    where: { id: previewId }, select: { confirmedAt: true },
  });
  await assert.rejects(prisma.$transaction(async (tx) => {
    await tx.amuxIdeaTransferPreview.update({
      where: { id: previewId }, data: { state: "in_flight",
        consumedAt: new Date(confirmed.confirmedAt!.getTime() + 1) },
    });
    await assert.rejects(
      commitAmuxIdeaAnalysisUnusedReservationCancellation(tx,
        { session, request, holdId }),
      (error: unknown) => error instanceof AmuxIdeaAnalysisCancellationError &&
        error.code === "not_cancellable");
    throw new Error("rollback synthetic consumed preview");
  }), /rollback synthetic consumed preview/);
  await prisma.amuxIdeaTransferPreview.update({
    where: { id: previewId }, data: { state: "expired" },
  });
  await prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisUnusedReservationCancellation(tx,
      { session, request, holdId }));
  assert.equal((await prisma.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
    where: { namespace_monthStart: { namespace, monthStart } },
  })).reservedMicroUsd, reservedBefore);
  assert.equal((await prisma.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({
    where: { id: holdId },
  })).status, "released");
});

test("an in-flight hold cannot be cancelled or remove its budget", async () => {
  const selectedModelId = modelId();
  const previewId = await confirmedPreviewId(selectedModelId);
  const priceVersionId = await approvedPriceVersionId("openai", selectedModelId);
  await prisma.amuxIdeaAnalysisBudgetWindow.upsert({
    where: { namespace_monthStart: { namespace, monthStart } },
    create: { namespace, monthStart, limitMicroUsd: BigInt(50_000_000) },
    update: {},
  });
  const reservedBefore = (await prisma.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
    where: { namespace_monthStart: { namespace, monthStart } },
  })).reservedMicroUsd;
  const holdId = randomUUID();
  await prisma.$transaction((tx) => commitAmuxIdeaAnalysisBudgetReservation(tx,
    { holdId, previewId, priceVersionId, runner, keys }));
  await prisma.amuxIdeaAnalysisBudgetHold.update({
    where: { id: holdId },
    data: { status: "in_flight", dispatchedAt: new Date() },
  });
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisUnusedReservationCancellation(tx,
      { session, request, holdId })), (error: unknown) =>
    error instanceof AmuxIdeaAnalysisCancellationError &&
    error.code === "not_cancellable");
  await assert.rejects(prisma.$transaction(async (tx) => {
    await tx.amuxIdeaAnalysisBudgetHold.update({
      where: { id: holdId }, data: { status: "outcome_unknown" },
    });
    await assert.rejects(
      commitAmuxIdeaAnalysisUnusedReservationCancellation(tx,
        { session, request, holdId }),
      (error: unknown) => error instanceof AmuxIdeaAnalysisCancellationError &&
        error.code === "not_cancellable");
    throw new Error("rollback synthetic unknown outcome");
  }), /rollback synthetic unknown outcome/);
  assert.equal((await prisma.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
    where: { namespace_monthStart: { namespace, monthStart } },
  })).reservedMicroUsd, reservedBefore + BigInt(5_000));
  assert.equal(await prisma.adminAuditLog.count({ where: {
    action: "amux.v4.analysis_budget.unused_reservation_cancelled",
    targetId: holdId,
  } }), 0);
});

async function syntheticDispatchedHold(): Promise<{ holdId: string; previewId: string }> {
  const selectedModelId = modelId();
  const previewId = await confirmedPreviewId(selectedModelId);
  const priceVersionId = await approvedPriceVersionId("openai", selectedModelId);
  await prisma.amuxIdeaAnalysisBudgetWindow.upsert({
    where: { namespace_monthStart: { namespace, monthStart } },
    create: { namespace, monthStart, limitMicroUsd: BigInt(50_000_000) },
    update: {},
  });
  const holdId = randomUUID();
  await prisma.$transaction((tx) => commitAmuxIdeaAnalysisBudgetReservation(tx,
    { holdId, previewId, priceVersionId, runner, keys }));
  const preview = await prisma.amuxIdeaTransferPreview.findUniqueOrThrow({
    where: { id: previewId }, select: { confirmedAt: true },
  });
  await prisma.amuxIdeaTransferPreview.update({
    where: { id: previewId },
    data: { state: "in_flight", consumedAt: preview.confirmedAt },
  });
  const clock = await prisma.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  await prisma.amuxIdeaAnalysisBudgetHold.update({
    where: { id: holdId },
    data: { status: "in_flight", dispatchedAt: clock[0]!.now },
  });
  return { holdId, previewId };
}

test("known CLI usage settles an in-flight Agent hold once and releases the remainder", async () => {
  const { holdId, previewId } = await syntheticDispatchedHold();
  const afterReservation = await prisma.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
    where: { namespace_monthStart: { namespace, monthStart } },
  });
  const reservedBefore = afterReservation.reservedMicroUsd - BigInt(5_000);
  const spentBefore = afterReservation.spentMicroUsd;
  for (const { input, reason } of [
    { input: { holdId, outcome: "outcome_unknown" as const,
      inputTokens: null, outputTokens: null }, reason: "usage_unknown" },
    { input: { holdId, outcome: "verified_success" as const,
      inputTokens: 1_001, outputTokens: 1 }, reason: "usage_exceeds_cap" },
    { input: { holdId, outcome: "verified_success" as const,
      inputTokens: 1, outputTokens: 2_001 }, reason: "usage_exceeds_cap" },
    { input: { holdId, outcome: "invocation_failed" as const,
      inputTokens: 0, outputTokens: 0 }, reason: "basis_invalid" },
  ]) {
    await assert.rejects(prisma.$transaction((tx) =>
      commitAmuxKnownIdeaAnalysisSettlement(tx, input)), (error: unknown) =>
      error instanceof AmuxIdeaAnalysisSettlementError && error.code === "usage_hold" &&
      error.reason === reason);
  }
  assert.equal((await prisma.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
    where: { namespace_monthStart: { namespace, monthStart } },
  })).reservedMicroUsd, afterReservation.reservedMicroUsd);
  assert.equal(await prisma.adminAuditLog.count({ where: {
    action: "AMUX_V4_ANALYSIS_BUDGET_SETTLED", targetId: holdId,
  } }), 0);
  const input = { holdId, outcome: "verified_success" as const,
    inputTokens: 100, outputTokens: 50 };
  const settled = await prisma.$transaction((tx) =>
    commitAmuxKnownIdeaAnalysisSettlement(tx, input));
  assert.equal(settled.status, "succeeded");
  assert.equal(settled.settledMicroUsd, "200");
  assert.equal(settled.releasedMicroUsd, "4800");
  const [hold, window, audit] = await Promise.all([
    prisma.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({ where: { id: holdId } }),
    prisma.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
      where: { namespace_monthStart: { namespace, monthStart } },
    }),
    prisma.adminAuditLog.findUniqueOrThrow({ where: { id: settled.auditId } }),
  ]);
  assert.equal(hold.status, "succeeded");
  assert.equal(hold.settledMicroUsd, BigInt(200));
  assert.equal(hold.inputTokens, 100);
  assert.equal(hold.outputTokens, 50);
  assert.equal((await prisma.amuxIdeaTransferPreview.findUniqueOrThrow({
    where: { id: previewId },
  })).state, "in_flight", "the later result writer owns successful preview completion");
  assert.equal(window.spentMicroUsd, spentBefore + BigInt(200));
  assert.equal(window.reservedMicroUsd, reservedBefore);
  assert.equal(auditRowActorKind(audit), "system");
  assert.equal((audit.metadata as Record<string, unknown>).actorScope,
    AMUX_V4_ANALYSIS_BUDGET_SETTLE_SCOPE);
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxKnownIdeaAnalysisSettlement(tx, input)), (error: unknown) =>
    error instanceof AmuxIdeaAnalysisSettlementError && error.code === "not_settleable");
  assert.equal(await prisma.adminAuditLog.count({ where: {
    action: "AMUX_V4_ANALYSIS_BUDGET_SETTLED", targetId: holdId,
  } }), 1);
});

test("a failed CLI invocation with known usage still records Agent provider cost", async () => {
  const { holdId, previewId } = await syntheticDispatchedHold();
  const result = await prisma.$transaction((tx) =>
    commitAmuxKnownIdeaAnalysisSettlement(tx,
      { holdId, outcome: "invocation_failed", inputTokens: 12, outputTokens: 0 }));
  assert.equal(result.status, "failed");
  assert.equal(result.settledMicroUsd, "12");
  assert.equal((await prisma.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({
    where: { id: holdId },
  })).settledMicroUsd, BigInt(12));
  assert.equal((await prisma.amuxIdeaTransferPreview.findUniqueOrThrow({
    where: { id: previewId },
  })).state, "provider_failed");
});

test("unknown CLI outcome holds the full budget and refuses admission and settlement", async () => {
  const { holdId, previewId } = await syntheticDispatchedHold();
  const nextModelId = modelId();
  const nextPreviewId = await confirmedPreviewId(nextModelId);
  const nextPriceVersionId = await approvedPriceVersionId("openai", nextModelId);
  const before = await prisma.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
    where: { namespace_monthStart: { namespace, monthStart } },
  });
  await assert.rejects(prisma.$transaction(async (tx) => {
    const marked = await commitAmuxIdeaAnalysisUnknownOutcome(tx,
      { holdId, reason: "usage_unverified" });
    assert.equal(marked.previewId, previewId);
    const hold = await tx.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({
      where: { id: holdId },
    });
    const preview = await tx.amuxIdeaTransferPreview.findUniqueOrThrow({
      where: { id: previewId },
    });
    const window = await tx.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
      where: { namespace_monthStart: { namespace, monthStart } },
    });
    const audit = await tx.adminAuditLog.findUniqueOrThrow({
      where: { id: marked.auditId },
    });
    assert.equal(hold.status, "outcome_unknown");
    assert.equal(hold.settledMicroUsd, null);
    assert.equal(preview.state, "outcome_unknown");
    assert.ok(preview.outcomeUnknownAt);
    assert.equal(window.reservedMicroUsd, before.reservedMicroUsd);
    assert.equal(window.spentMicroUsd, before.spentMicroUsd);
    assert.equal(auditRowActorKind(audit), "system");
    assert.equal((audit.metadata as Record<string, unknown>).actorScope,
      AMUX_V4_ANALYSIS_OUTCOME_UNKNOWN_SCOPE);
    await assert.rejects(commitAmuxIdeaAnalysisUnknownOutcome(tx,
      { holdId, reason: "usage_unverified" }), (error: unknown) =>
      error instanceof AmuxIdeaAnalysisUnknownOutcomeError &&
      error.code === "not_markable");
    await assert.rejects(commitAmuxKnownIdeaAnalysisSettlement(tx,
      { holdId, outcome: "verified_success", inputTokens: 100,
        outputTokens: 50 }), (error: unknown) =>
      error instanceof AmuxIdeaAnalysisSettlementError &&
      error.code === "not_settleable");
    await assert.rejects(commitAmuxIdeaAnalysisBudgetReservation(tx,
      { holdId: randomUUID(), previewId: nextPreviewId,
        priceVersionId: nextPriceVersionId, runner, keys }),
    (error: unknown) => error instanceof AmuxIdeaAnalysisReservationError &&
      error.code === "budget_hold" && error.reason === "usage_unknown");
    throw new Error("rollback synthetic unknown outcome");
  }), /rollback synthetic unknown outcome/);
  assert.equal((await prisma.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({
    where: { id: holdId },
  })).status, "in_flight");
  assert.equal(await prisma.adminAuditLog.count({ where: {
    action: "AMUX_V4_ANALYSIS_OUTCOME_UNKNOWN", targetId: holdId,
  } }), 0);
});

test("an output-continuable first result retains its first page without completing the idea", async () => {
  const workItemsBefore = await prisma.amuxWorkItem.count({
    where: { sourceSystem: "admin-idea-v4" },
  });
  const { holdId, previewId } = await syntheticDispatchedHold();
  const preview = await prisma.amuxIdeaTransferPreview.findUniqueOrThrow({
    where: { id: previewId }, select: { ideaId: true, modelId: true },
  });
  const ideaId = preview.ideaId;
  await prisma.amuxIdeaSubmission.update({
    where: { id: ideaId }, data: { state: "analyzing" },
  });
  await prisma.amuxIdeaAnalysisChunk.update({
    where: { ideaId_chunkIndex: { ideaId, chunkIndex: 0 } },
    data: { state: "in_flight", leaseGeneration: 1 },
  });
  await prisma.$transaction((tx) => commitAmuxKnownIdeaAnalysisSettlement(tx,
    { holdId, outcome: "verified_success", inputTokens: 100, outputTokens: 50 }));
  assert.deepEqual(await readAmuxFirstIdeaAnalysisResult(session, ideaId, keys),
    { state: "pending" });
  const units = [
    { kind: "node", localId: "c0:node-0", level: "initiative", parentRef: null,
      title: "Improve intake", description: "An operator idea.",
      sourceRefIds: ["operator_idea"] },
    { kind: "node", localId: "c0:node-1", level: "epic", parentRef: "c0:node-0",
      title: "Analyze ideas", description: "A bounded proposal.",
      sourceRefIds: ["operator_idea"] },
    { kind: "node", localId: "c0:node-2", level: "feature", parentRef: "c0:node-1",
      title: "Review proposals", description: "A bounded proposal.",
      sourceRefIds: ["operator_idea"] },
    { kind: "card", localId: "c0:card-0", cardType: "story", storyKind: "general",
      title: "Review a first card", problem: "The owner needs a proposal.",
      scopeIn: ["Show the first page"], scopeOut: ["Do not register cards"],
      completionCriteria: ["The first page is visible"], featureRef: "c0:node-2",
      parentStoryRef: null, dependencyRefs: [], duplicateCandidateRefs: [],
      taskRole: null, executionGrade: null, executionBrief: null,
      sourceRefIds: ["operator_idea"] },
  ];
  const saved = await prisma.$transaction((tx) => commitAmuxFirstIdeaAnalysisDraft(tx, {
    ideaId, previewId, holdId, leaseGeneration: 1, keys,
    rawModelOutput: JSON.stringify({ schemaVersion: 2, previewId, chunkIndex: 0,
      outcome: "propose", coverageStatus: "more", continuationKind: "output",
      ownerQuestion: null, coveredScope: "First page", remainingScope: "More cards remain",
      units }),
  }));
  assert.equal(saved.coverageStatus, "more");
  assert.equal(saved.analysisCompletedAt, null);
  assert.equal(saved.nextChunkIndex, 1);
  const [idea, chunk, nextChunk, visible] = await Promise.all([
    prisma.amuxIdeaSubmission.findUniqueOrThrow({ where: { id: ideaId } }),
    prisma.amuxIdeaAnalysisChunk.findUniqueOrThrow({
      where: { ideaId_chunkIndex: { ideaId, chunkIndex: 0 } },
    }),
    prisma.amuxIdeaAnalysisChunk.findUniqueOrThrow({
      where: { ideaId_chunkIndex: { ideaId, chunkIndex: 1 } },
    }),
    readAmuxFirstIdeaAnalysisResult(session, ideaId, keys),
  ]);
  assert.equal(idea.state, "analyzing");
  assert.equal(idea.analysisCompletedAt, null);
  assert.equal(chunk.state, "draft_ready");
  assert.equal(chunk.outputPending, true);
  const deadline = await prisma.amuxIdeaSubmission.findUniqueOrThrow({
    where: { id: ideaId }, select: { analysisDeadlineAt: true },
  });
  assert.equal(chunk.freeformPurgeAfter?.getTime(),
    deadline.analysisDeadlineAt.getTime() + 24 * 60 * 60_000);
  assert.deepEqual([chunk.remainingStartOrdinal, chunk.remainingEndOrdinal], [0, 0]);
  assert.equal(nextChunk.state, "pending");
  assert.equal(nextChunk.currentPreviewId, null);
  assert.equal(nextChunk.sourcePlanRevisionId, chunk.sourcePlanRevisionId);
  assert.equal(nextChunk.revisionChunkIndex, 1);
  assert.equal(visible.state, "partial");
  if (visible.state !== "partial") throw new Error("first page unavailable");
  assert.equal(visible.remainingScope, "More cards remain");
  assert.equal(visible.units.length, 4);
  assert.equal(visible.units[3]?.proposal?.kind, "card");
  assert.equal(await prisma.amuxWorkItem.count({
    where: { sourceSystem: "admin-idea-v4" },
  }), workItemsBefore);
  const nextPreviewId = randomUUID();
  const choice = { previewId: nextPreviewId, ideaId, provider: "openai" as const,
    modelId: preview.modelId, reasoningEffort: "high" as const,
    approvalId: randomUUID(), approvalVersion: 1 };
  const continued = await prisma.$transaction((tx) =>
    commitFirstOutputContinuationTransferPreview(tx, {
      session, request, choice, keys, browserNonce,
    }));
  assert.equal(continued.previewId, nextPreviewId);
  assert.match(continued.payload.prompt, /"chunkIndex":1/);
  assert.match(continued.payload.prompt, /"previousChunkDigest":"[a-f0-9]{64}"/);
  assert.match(continued.payload.prompt, /"ref":"c0:node-2"/);
  const nextPreview = await prisma.amuxIdeaTransferPreview.findUniqueOrThrow({
    where: { id: nextPreviewId },
  });
  assert.deepEqual([nextPreview.chunkIndex, nextPreview.attempt,
    nextPreview.state, nextPreview.sourceUnitOrdinal], [1, 1, "prepared", 0]);
  const continuedChunk = await prisma.amuxIdeaAnalysisChunk.findUniqueOrThrow({
    where: { ideaId_chunkIndex: { ideaId, chunkIndex: 1 } },
  });
  assert.equal(continuedChunk.state, "awaiting_preview");
  assert.equal(continuedChunk.currentPreviewId, nextPreviewId);
  const readback = await readIdeaOnlyTransferPreview(session, nextPreviewId);
  assert.equal(readback.state, "prepared");
  if (readback.state !== "prepared") throw new Error("continuation preview unavailable");
  assert.equal(readback.transferAuthorized, false);
  assert.equal(readback.payloadDigest, continued.payloadDigest);
  await assert.rejects(prisma.$transaction((tx) =>
    commitIdeaTransferConfirmation(tx, { session, request,
      choice: { previewId: nextPreviewId, ideaId,
        payloadDigest: continued.payloadDigest,
        payloadDigestKeyId: continued.payloadDigestKeyId },
      browserNonce: randomBytes(32).toString("base64url"), keys,
    })), /browser_mismatch/);
  const confirmed = await prisma.$transaction((tx) =>
    commitIdeaTransferConfirmation(tx, { session, request,
      choice: { previewId: nextPreviewId, ideaId,
        payloadDigest: continued.payloadDigest,
        payloadDigestKeyId: continued.payloadDigestKeyId },
      browserNonce, keys,
    }));
  assert.equal(confirmed.previewId, nextPreviewId);
  assert.equal((await prisma.amuxIdeaTransferPreview.findUniqueOrThrow({
    where: { id: nextPreviewId },
  })).state, "confirmed");
  await assert.rejects(prisma.$transaction((tx) =>
    commitFirstOutputContinuationTransferPreview(tx, {
      session, request, choice: { ...choice, previewId: randomUUID(),
        replacesPreviewId: nextPreviewId }, keys, browserNonce,
    })), /not_ready/, "a live confirmation cannot be replaced");
  await prisma.amuxIdeaTransferPreview.update({
    where: { id: nextPreviewId },
    data: { confirmedAt: new Date(Date.now() - 120_000),
      expiresAt: new Date(Date.now() - 60_000),
      confirmExpiresAt: new Date(Date.now() - 60_000) },
  });
  const replacementId = randomUUID();
  const replacement = await prisma.$transaction((tx) =>
    commitFirstOutputContinuationTransferPreview(tx, {
      session, request, choice: { ...choice, previewId: replacementId,
        replacesPreviewId: nextPreviewId }, keys, browserNonce,
    }));
  assert.equal(replacement.previewId, replacementId);
  assert.equal((await prisma.amuxIdeaTransferPreview.findUniqueOrThrow({
    where: { id: nextPreviewId },
  })).state, "expired");
  assert.deepEqual(await readIdeaTransferConfirmation(session, nextPreviewId),
    { state: "expired", previewId: nextPreviewId, ideaId,
      confirmationRecorded: true, modelCallStarted: false });
  const confirmedReplacementAudit = await prisma.adminAuditLog.findFirstOrThrow({ where: {
    action: "amux.v4.transfer_preview.expired_for_replacement",
    targetId: nextPreviewId,
  } });
  assert.deepEqual(confirmedReplacementAudit.metadata, {
    ideaId, chunkIndex: 1, replacementPreviewId: replacementId,
    priorState: "confirmed", confirmationRecorded: true,
  });
  assert.equal((await prisma.amuxIdeaTransferPreview.findUniqueOrThrow({
    where: { id: replacementId },
  })).attempt, 2);
  assert.equal((await prisma.amuxIdeaAnalysisChunk.findUniqueOrThrow({
    where: { ideaId_chunkIndex: { ideaId, chunkIndex: 1 } },
  })).currentPreviewId, replacementId);
  await prisma.amuxIdeaTransferPreview.update({
    where: { id: replacementId },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });
  const finalPreviewId = randomUUID();
  const finalPreview = await prisma.$transaction((tx) =>
    commitFirstOutputContinuationTransferPreview(tx, {
      session, request, choice: { ...choice, previewId: finalPreviewId,
        replacesPreviewId: replacementId }, keys, browserNonce,
    }));
  assert.deepEqual(await readIdeaTransferConfirmation(session, replacementId),
    { state: "expired", previewId: replacementId, ideaId,
      confirmationRecorded: false, modelCallStarted: false });
  const preparedReplacementAudit = await prisma.adminAuditLog.findFirstOrThrow({ where: {
    action: "amux.v4.transfer_preview.expired_for_replacement",
    targetId: replacementId,
  } });
  assert.deepEqual(preparedReplacementAudit.metadata, {
    ideaId, chunkIndex: 1, replacementPreviewId: finalPreviewId,
    priorState: "prepared", confirmationRecorded: false,
  });
  assert.equal((await prisma.amuxIdeaTransferPreview.findUniqueOrThrow({
    where: { id: finalPreviewId },
  })).attempt, 3);
  await prisma.$transaction((tx) => commitIdeaTransferConfirmation(tx, {
    session, request, choice: { previewId: finalPreviewId, ideaId,
      payloadDigest: finalPreview.payloadDigest,
      payloadDigestKeyId: finalPreview.payloadDigestKeyId },
    browserNonce, keys,
  }));
  const firstHold = await prisma.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({
    where: { id: holdId }, select: { priceVersionId: true },
  });
  assert.ok(firstHold.priceVersionId);
  const nextHoldId = randomUUID();
  const nextReservation = await prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisBudgetReservation(tx, {
      holdId: nextHoldId, previewId: finalPreviewId,
      priceVersionId: firstHold.priceVersionId!, runner, keys,
    }));
  assert.equal(nextReservation.previewId, finalPreviewId);
  assert.equal((await prisma.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({
    where: { id: nextHoldId },
  })).status, "reserved");
  await prisma.amuxIdeaTransferPreview.update({
    where: { id: finalPreviewId },
    data: { confirmedAt: new Date(Date.now() - 120_000),
      expiresAt: new Date(Date.now() - 60_000),
      confirmExpiresAt: new Date(Date.now() - 60_000) },
  });
  await assert.rejects(prisma.$transaction((tx) =>
    commitFirstOutputContinuationTransferPreview(tx, {
      session, request, choice: { ...choice, previewId: randomUUID(),
        replacesPreviewId: finalPreviewId }, keys, browserNonce,
    })), /not_ready/, "a preview with any budget hold cannot be replaced");
  assert.equal(await prisma.adminAuditLog.count({ where: {
    action: "amux.v4.transfer_preview.expired_for_replacement",
    targetId: finalPreviewId,
  } }), 0);
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisBudgetReservation(tx, {
      holdId: randomUUID(), previewId: nextPreviewId,
      priceVersionId: firstHold.priceVersionId!, runner, keys,
    })), /not_ready/, "the expired predecessor cannot reserve budget");
  await assert.rejects(prisma.$transaction((tx) =>
    commitFirstOutputContinuationTransferPreview(tx, {
      session, request, choice: { ...choice, previewId: randomUUID() },
      keys, browserNonce,
    })), /not_ready/);
  await prisma.amuxIdeaAnalysisChunk.update({
    where: { ideaId_chunkIndex: { ideaId, chunkIndex: 0 } },
    data: { freeformPurgeAfter: new Date(Date.now() - 60_000) },
  });
  const afterDeadline = await readAmuxFirstIdeaAnalysisResult(session, ideaId, keys);
  assert.equal(afterDeadline.state, "partial");
  if (afterDeadline.state !== "partial") throw new Error("expired scope unavailable");
  assert.equal(afterDeadline.remainingScope, null);
  assert.equal(afterDeadline.units.length, 4);
  await prisma.amuxIdeaAnalysisChunk.update({
    where: { ideaId_chunkIndex: { ideaId, chunkIndex: 0 } },
    data: { freeformCiphertext: null, freeformKeyId: null,
      freeformKeyVersion: null, freeformPurgedAt: new Date() },
  });
  const afterPurge = await readAmuxFirstIdeaAnalysisResult(session, ideaId, keys);
  assert.equal(afterPurge.state, "partial");
  if (afterPurge.state !== "partial") throw new Error("retained page unavailable");
  assert.equal(afterPurge.remainingScope, null);
  assert.equal(afterPurge.units.length, 4);
});

test("a complete first result saves independent encrypted units and closes only its preview", async () => {
  const { holdId, previewId } = await syntheticDispatchedHold();
  const preview = await prisma.amuxIdeaTransferPreview.findUniqueOrThrow({
    where: { id: previewId }, select: { ideaId: true, payloadPurgeAfter: true },
  });
  const ideaId = preview.ideaId;
  await prisma.amuxIdeaSubmission.update({
    where: { id: ideaId }, data: { state: "analyzing" },
  });
  await prisma.amuxIdeaAnalysisChunk.update({
    where: { ideaId_chunkIndex: { ideaId, chunkIndex: 0 } },
    data: { state: "in_flight", leaseGeneration: 1 },
  });
  await prisma.$transaction((tx) => commitAmuxKnownIdeaAnalysisSettlement(tx,
    { holdId, outcome: "verified_success", inputTokens: 100, outputTokens: 50 }));
  const nodes = [
    { level: "initiative", parentRef: null, title: "Improve operator intake" },
    { level: "epic", parentRef: "c0:node-0", title: "Analyze operator ideas" },
    { level: "feature", parentRef: "c0:node-1", title: "Review analysis proposals" },
  ].map((node, index) => ({ kind: "node", localId: `c0:node-${index}`,
    description: "A bounded operator proposal.", sourceRefIds: ["operator_idea"], ...node }));
  const card = {
    kind: "card", localId: "c0:card-0", cardType: "story", storyKind: "general",
    title: "Review a suggested card", problem: "The owner needs a verified proposal.",
    scopeIn: ["Show the proposal"], scopeOut: ["Do not execute it"],
    completionCriteria: ["The owner can inspect the draft"],
    featureRef: "c0:node-2", parentStoryRef: null,
    dependencyRefs: [], duplicateCandidateRefs: [], taskRole: null,
    executionGrade: null, executionBrief: null, sourceRefIds: ["operator_idea"],
  };
  const result = {
    schemaVersion: 2, previewId, chunkIndex: 0,
    outcome: "propose", coverageStatus: "complete", continuationKind: null,
    ownerQuestion: null, coveredScope: "The operator idea was analyzed.",
    remainingScope: null, units: [...nodes, card],
  };
  const input = { ideaId, previewId, holdId, leaseGeneration: 1,
    rawModelOutput: JSON.stringify(result), keys };
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxFirstIdeaAnalysisDraft(tx, { ...input, leaseGeneration: 0 })),
  (error: unknown) => error instanceof AmuxFirstAnalysisDraftError &&
    error.code === "not_ready");
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxFirstIdeaAnalysisDraft(tx, { ...input,
      rawModelOutput: JSON.stringify({ ...result,
        units: [...nodes, { ...card, sourceRefIds: ["unapproved_source"] }] }) })),
  (error: unknown) => error instanceof AmuxFirstAnalysisDraftError &&
    error.code === "invalid_result");
  await assert.rejects(prisma.$transaction(async (tx) => {
    await tx.amuxIdeaTransferPreview.update({ where: { id: previewId },
      data: { payloadDigest: randomBytes(32).toString("hex") } });
    await assert.rejects(commitAmuxFirstIdeaAnalysisDraft(tx, input),
      (error: unknown) => error instanceof AmuxFirstAnalysisDraftError &&
        error.code === "integrity_unavailable");
    throw new Error("rollback synthetic payload tamper");
  }), /rollback synthetic payload tamper/);
  assert.equal(await prisma.amuxIdeaDraftUnit.count({ where: { ideaId } }), 0);

  const saved = await prisma.$transaction((tx) =>
    commitAmuxFirstIdeaAnalysisDraft(tx, input));
  assert.equal(saved.unitCount, 4);
  const [idea, chunk, completedPreview, units, audit] = await Promise.all([
    prisma.amuxIdeaSubmission.findUniqueOrThrow({ where: { id: ideaId } }),
    prisma.amuxIdeaAnalysisChunk.findUniqueOrThrow({
      where: { ideaId_chunkIndex: { ideaId, chunkIndex: 0 } },
    }),
    prisma.amuxIdeaTransferPreview.findUniqueOrThrow({ where: { id: previewId } }),
    prisma.amuxIdeaDraftUnit.findMany({ where: { ideaId }, orderBy: { unitIndex: "asc" } }),
    prisma.adminAuditLog.findUniqueOrThrow({ where: { id: saved.auditId } }),
  ]);
  assert.equal(idea.state, "awaiting_owner");
  assert.equal(idea.analysisCompletedAt?.toISOString(), saved.analysisCompletedAt);
  assert.equal(chunk.state, "draft_ready");
  assert.equal(chunk.draftCiphertext, null, "no monolithic draft copy");
  assert.ok(chunk.freeformCiphertext);
  assert.equal(completedPreview.state, "completed");
  assert.ok(preview.payloadPurgeAfter && completedPreview.payloadPurgeAfter &&
    completedPreview.payloadPurgeAfter <= preview.payloadPurgeAfter,
  "finishing analysis cannot postpone the original payload purge deadline");
  assert.equal(units.length, 4);
  assert.deepEqual(units.map((unit) => unit.localRef),
    ["c0:node-0", "c0:node-1", "c0:node-2", "c0:card-0"]);
  const cardUnit = units[3]!;
  const cardBody = openAmuxContent({ ciphertext: Buffer.from(cardUnit.bodyCiphertext!),
    keyId: cardUnit.bodyKeyId!, keyVersion: cardUnit.bodyKeyVersion! },
  "analysis_draft", cardUnit.id, keys);
  try {
    assert.equal(JSON.parse(cardBody.toString("utf8")).title, card.title);
  } finally { cardBody.fill(0); }
  assert.equal(auditRowActorKind(audit), "system");
  assert.equal((audit.metadata as Record<string, unknown>).actorScope,
    AMUX_V4_FIRST_DRAFT_SAVED_SCOPE);
  assert.deepEqual((audit.metadata as Record<string, unknown>).unitCommitments,
    units.map((unit) => ({ id: unit.id, localRef: unit.localRef,
      kind: unit.unitKind, digest: unit.bodyDigest,
      digestKeyId: unit.bodyDigestKeyId })));
  assert.equal(JSON.stringify(audit.metadata).includes(card.title), false);
  const visible = await readAmuxFirstIdeaAnalysisResult(session, ideaId, keys);
  assert.equal(visible.state, "ready");
  if (visible.state !== "ready") throw new Error("analysis result not ready");
  assert.equal(visible.outcome, "propose");
  assert.equal(visible.coveredScope, result.coveredScope);
  assert.equal(visible.units.length, 4);
  assert.equal(visible.units[3]?.proposal?.kind, "card");
  if (visible.units[3]?.proposal?.kind !== "card") throw new Error("card unavailable");
  assert.equal(visible.units[3].proposal.title, card.title);
  await assert.rejects(readAmuxFirstIdeaAnalysisResult({ ...session,
    user: { ...session.user, id: randomUUID() } } as Session, ideaId, keys),
  (error: unknown) => error instanceof AmuxIdeaAnalysisResultReadError &&
    error.code === "not_found");
  await prisma.amuxIdeaAnalysisChunk.update({
    where: { ideaId_chunkIndex: { ideaId, chunkIndex: 0 } },
    data: { freeformCiphertext: null, freeformKeyId: null,
      freeformKeyVersion: null, freeformPurgedAt: new Date() },
  });
  const afterFreeformPurge = await readAmuxFirstIdeaAnalysisResult(session, ideaId, keys);
  assert.equal(afterFreeformPurge.state, "ready");
  if (afterFreeformPurge.state !== "ready") throw new Error("retained units not visible");
  assert.equal(afterFreeformPurge.coveredScope, null);
  if (afterFreeformPurge.units[3]?.proposal?.kind !== "card") {
    throw new Error("retained card unavailable");
  }
  assert.equal(afterFreeformPurge.units[3].proposal.title, card.title);
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxFirstIdeaAnalysisDraft(tx, input)),
  (error: unknown) => error instanceof AmuxFirstAnalysisDraftError &&
    error.code === "not_ready");
  assert.equal(await prisma.amuxIdeaDraftUnit.count({ where: { ideaId } }), 4);

  async function addSyntheticRival(tx: Prisma.TransactionClient) {
    const rivalId = randomUUID();
    const rivalAuditId = await writeAdminAuditLog({ tx, session, request,
      action: "amux.v4.synthetic.rival", targetType: "AmuxPortfolioNode",
      targetId: rivalId, summary: "Synthetic duplicate candidate" });
    const sealedRival = sealAmuxNodeText(rivalId,
      { title: nodes[0]!.title, description: "Synthetic rival" }, keys);
    await tx.amuxPortfolioNode.create({ data: {
      id: rivalId, level: "initiative", parentId: null,
      state: "active", revision: 0,
      titleCiphertext: Uint8Array.from(sealedRival.titleCiphertext),
      descriptionCiphertext: Uint8Array.from(sealedRival.descriptionCiphertext),
      contentKeyId: sealedRival.contentKeyId,
      contentKeyVersion: sealedRival.contentKeyVersion,
      contentDigest: sealedRival.contentDigest,
      contentDigestKeyId: sealedRival.contentDigestKeyId,
      approvedByUserId: actorUserId,
      authorizationAuditLogId: rivalAuditId,
    } });
  }

  const rootChoice = { ideaId, draftUnitId: units[0]!.id,
    decisionId: randomUUID(), prepareRequestId: randomUUID(),
    nodeId: randomUUID(), reason: "" };
  await assert.rejects(prisma.$transaction(async (tx) => {
    await assert.rejects(resolveApprovedAmuxRootParent(tx, session,
      { ideaId, parentRef: units[0]!.localRef! }),
    (error: unknown) => error instanceof AmuxNodeParentResolutionError &&
      error.code === "not_ready");
    const prepared = await commitAmuxRootNodePrepare(tx,
      { session, request, choice: rootChoice, keys });
    assert.equal(prepared.decisionId, rootChoice.decisionId);
    assert.equal((await readAmuxRootNodeDecisionInTransaction(tx, session,
      rootChoice.decisionId, rootChoice.prepareRequestId)).state, "prepared");
    assert.equal((await readAmuxRootNodeDecisionInTransaction(tx,
      { ...session, user: { ...session.user, id: randomUUID() } } as Session,
      rootChoice.decisionId, rootChoice.prepareRequestId)).state,
    "not_visible");
    await assert.rejects(commitAmuxRootNodePrepare(tx, { session, request,
      choice: { ...rootChoice, decisionId: randomUUID(),
        prepareRequestId: randomUUID(), nodeId: randomUUID() }, keys }),
    (error: unknown) => error instanceof AmuxNodeCreateError &&
      error.code === "already_prepared");
    await assert.rejects(commitAmuxUnitRejectPrepare(tx, { session, request,
      choice: { ideaId, draftUnitId: rootChoice.draftUnitId,
        decisionId: randomUUID(), prepareRequestId: randomUUID(),
        reason: "The proposed node is not in scope." }, keys }),
    (error: unknown) => error instanceof AmuxUnitRejectError &&
      error.code === "already_prepared");
    await assert.rejects(commitAmuxRootNodeConsume(tx, { session, request,
      choice: { ...rootChoice, consumeRequestId: randomUUID(),
        confirmationDigest: randomBytes(32).toString("hex") }, keys }),
    (error: unknown) => error instanceof AmuxNodeCreateError &&
      error.code === "reconfirm");
    const registered = await commitAmuxRootNodeConsume(tx, { session, request,
      choice: { ...rootChoice, consumeRequestId: randomUUID(),
        confirmationDigest: prepared.confirmationDigest }, keys });
    assert.equal(registered.state, "created");
    assert.equal(registered.nodeId, rootChoice.nodeId);
    assert.equal(await commitAmuxRootNodeUnknown(tx, { actorUserId,
      decisionId: rootChoice.decisionId,
      prepareRequestId: rootChoice.prepareRequestId,
      consumeRequestId: randomUUID() }), false,
    "a committed node cannot be marked outcome-unknown");
    const readBack = await readAmuxRootNodeDecisionInTransaction(tx, session,
      rootChoice.decisionId, rootChoice.prepareRequestId);
    assert.equal(readBack.state, "created");
    if (readBack.state !== "created") throw new Error("node read-back unavailable");
    assert.equal(readBack.nodeId, rootChoice.nodeId);
    const node = await tx.amuxPortfolioNode.findUniqueOrThrow({
      where: { id: rootChoice.nodeId },
    });
    const revision = await tx.amuxPortfolioNodeRevision.findFirstOrThrow({
      where: { nodeId: rootChoice.nodeId },
    });
    const decision = await tx.amuxIdeaUnitDecision.findUniqueOrThrow({
      where: { id: rootChoice.decisionId },
    });
    const unit = await tx.amuxIdeaDraftUnit.findUniqueOrThrow({
      where: { id: units[0]!.id },
    });
    assert.equal(node.level, "initiative");
    assert.equal(node.parentId, null);
    assert.equal(revision.decisionId, decision.id);
    assert.equal(revision.contentDigest, node.contentDigest);
    assert.equal(decision.state, "consumed");
    assert.equal(unit.state, "approved");
    const parent = await resolveApprovedAmuxRootParent(tx, session,
      { ideaId, parentRef: unit.localRef! });
    assert.equal(parent.id, rootChoice.nodeId);
    assert.equal(parent.level, "initiative");
    assert.equal(parent.approvedDecisionId, rootChoice.decisionId);
    assert.equal(parent.content.digest, node.contentDigest);
    await assert.rejects(resolveApprovedAmuxRootParent(tx, session,
      { ideaId, parentRef: units[1]!.localRef! }),
    (error: unknown) => error instanceof AmuxNodeParentResolutionError &&
      error.code === "not_ready");
    assert.equal(await tx.amuxWorkItem.count({
      where: { sourceSystem: "admin-idea-v4" } }), 0);
    throw new Error("rollback synthetic root node decision");
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 5_000, timeout: 30_000 }),
  /rollback synthetic root node decision/);
  assert.equal(await prisma.amuxPortfolioNode.count({
    where: { id: rootChoice.nodeId } }), 0);
  assert.equal((await readAmuxRootNodeDecision(session,
    rootChoice.decisionId, rootChoice.prepareRequestId)).state, "absent");
  await assert.rejects(prisma.$transaction(async (tx) => {
    const unknownChoice = { ...rootChoice, decisionId: randomUUID(),
      prepareRequestId: randomUUID(), nodeId: randomUUID() };
    const prepared = await commitAmuxRootNodePrepare(tx,
      { session, request, choice: unknownChoice, keys });
    const consumeRequestId = randomUUID();
    assert.equal(await commitAmuxRootNodeUnknown(tx, {
      actorUserId: randomUUID(), decisionId: unknownChoice.decisionId,
      prepareRequestId: unknownChoice.prepareRequestId,
      consumeRequestId }), false,
    "another actor cannot freeze a prepared decision");
    assert.equal(await commitAmuxRootNodeUnknown(tx, { actorUserId,
      decisionId: unknownChoice.decisionId,
      prepareRequestId: unknownChoice.prepareRequestId,
      consumeRequestId }), true);
    assert.equal((await readAmuxRootNodeDecisionInTransaction(tx, session,
      unknownChoice.decisionId, unknownChoice.prepareRequestId)).state,
    "outcome_unknown");
    assert.equal(await commitAmuxRootNodeUnknown(tx, { actorUserId,
      decisionId: unknownChoice.decisionId,
      prepareRequestId: unknownChoice.prepareRequestId,
      consumeRequestId }), false);
    await assert.rejects(commitAmuxRootNodeConsume(tx, { session, request,
      choice: { ...unknownChoice, consumeRequestId,
        confirmationDigest: prepared.confirmationDigest }, keys }),
    (error: unknown) => error instanceof AmuxNodeCreateError &&
      error.code === "integrity_unavailable");
    await assert.rejects(commitAmuxRootNodePrepare(tx, { session, request,
      choice: { ...unknownChoice, decisionId: randomUUID(),
        prepareRequestId: randomUUID(), nodeId: randomUUID() }, keys }),
    (error: unknown) => error instanceof AmuxNodeCreateError &&
      error.code === "already_prepared");
    const noCommit = await commitAmuxRootNodeNoCommitConfirmed(tx,
      { session, request, decisionId: unknownChoice.decisionId,
        prepareRequestId: unknownChoice.prepareRequestId });
    assert.equal(noCommit.state, "no_commit_confirmed");
    assert.equal((await readAmuxRootNodeDecisionInTransaction(tx, session,
      unknownChoice.decisionId, unknownChoice.prepareRequestId)).state,
    "no_commit_confirmed");
    // Simulate only the 15-minute DB-clock edge; the actual approval and
    // canonical audit rows remain real transaction writes.
    const expiryAuditId = await writeSystemAuditLog({ tx,
      systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
      action: "amux.v4.unit.expire", targetType: "AmuxIdeaUnitDecision",
      targetId: unknownChoice.decisionId,
      summary: "Synthetic expiry read-back after confirmed no-commit.",
      metadata: { ideaId, draftUnitId: unknownChoice.draftUnitId,
        prepareRequestId: unknownChoice.prepareRequestId,
        expiredAt: new Date().toISOString(), action: "create_node",
        registered: false, noCommitAuditId: noCommit.auditId },
    });
    const currentDecision = await tx.amuxIdeaUnitDecision.findUniqueOrThrow({
      where: { id: unknownChoice.decisionId },
    });
    const expiryView = {
      amuxIdeaUnitDecision: { findUnique: async () => ({ ...currentDecision,
        state: "expired", finalAuditLogId: expiryAuditId }) },
      adminAuditLog: tx.adminAuditLog,
    } as unknown as Prisma.TransactionClient;
    assert.equal((await readAmuxRootNodeDecisionInTransaction(expiryView,
      session, unknownChoice.decisionId,
      unknownChoice.prepareRequestId)).state, "expired");
    await assert.rejects(commitAmuxRootNodeNoCommitConfirmed(tx,
      { session, request, decisionId: unknownChoice.decisionId,
        prepareRequestId: unknownChoice.prepareRequestId }),
    (error: unknown) => error instanceof AmuxNodeCreateError &&
      error.code === "reconfirm");
    throw new Error("rollback synthetic unknown root node decision");
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 5_000, timeout: 30_000 }),
  /rollback synthetic unknown root node decision/);
  await assert.rejects(prisma.$transaction(async (tx) => {
    const changedChoice = { ...rootChoice, decisionId: randomUUID(),
      prepareRequestId: randomUUID(), nodeId: randomUUID() };
    const prepared = await commitAmuxRootNodePrepare(tx,
      { session, request, choice: changedChoice, keys });
    await addSyntheticRival(tx);
    await assert.rejects(commitAmuxRootNodeConsume(tx, { session, request,
      choice: { ...changedChoice, consumeRequestId: randomUUID(),
        confirmationDigest: prepared.confirmationDigest }, keys }),
    (error: unknown) => error instanceof AmuxNodeCreateError &&
      error.code === "reconfirm");
    assert.equal((await tx.amuxIdeaUnitDecision.findUniqueOrThrow({
      where: { id: changedChoice.decisionId },
    })).state, "prepared");
    throw new Error("rollback synthetic changed duplicate scan");
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 5_000, timeout: 30_000 }),
  /rollback synthetic changed duplicate scan/);
  await assert.rejects(prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
             set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
    `;
    await takeAuditChainLock(tx);
    await addSyntheticRival(tx);
    const duplicateChoice = { ...rootChoice, decisionId: randomUUID(),
      prepareRequestId: randomUUID(), nodeId: randomUUID() };
    await assert.rejects(commitAmuxRootNodePrepare(tx,
      { session, request, choice: duplicateChoice, keys }),
    (error: unknown) => error instanceof AmuxNodeCreateError &&
      error.code === "not_ready");
    const explained = { ...duplicateChoice,
      reason: "This node covers a separate approved operator scope." };
    const prepared = await commitAmuxRootNodePrepare(tx,
      { session, request, choice: explained, keys });
    const consumed = await commitAmuxRootNodeConsume(tx,
      { session, request, choice: { ...explained,
        consumeRequestId: randomUUID(),
        confirmationDigest: prepared.confirmationDigest }, keys });
    assert.equal(consumed.state, "created");
    throw new Error("rollback synthetic duplicate reason decision");
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 5_000, timeout: 30_000 }),
  /rollback synthetic duplicate reason decision/);

  const decisionId = randomUUID();
  const prepareRequestId = randomUUID();
  const reason = "This card is outside the agreed first release.";
  const rejection = { ideaId, draftUnitId: cardUnit.id, decisionId,
    prepareRequestId, reason };
  const uncertainUnitId = units[2]!.id;
  const uncertainChoice = { ideaId, draftUnitId: uncertainUnitId,
    decisionId: randomUUID(), prepareRequestId: randomUUID(),
    reason: "The response to this decision could not be verified." };
  await assert.rejects(prisma.$transaction(async (tx) => {
    const prepared = await commitAmuxUnitRejectPrepare(tx,
      { session, request, choice: rejection, keys });
    assert.equal(prepared.decisionId, decisionId);
    await assert.rejects(commitAmuxUnitRejectPrepare(tx, { session, request,
      choice: { ...rejection, decisionId: randomUUID(),
        prepareRequestId: randomUUID() }, keys }),
    (error: unknown) => error instanceof AmuxUnitRejectError &&
      error.code === "already_prepared");
    assert.equal(await tx.amuxIdeaUnitDecision.count({
      where: { draftUnitId: cardUnit.id, state: "prepared" },
    }), 1, "a live confirmation cannot be replaced");
    await assert.rejects(commitAmuxUnitRejectConsume(tx, { session, request,
      choice: { ...rejection, consumeRequestId: randomUUID(),
        confirmationDigest: randomBytes(32).toString("hex") }, keys }),
    (error: unknown) => error instanceof AmuxUnitRejectError &&
      error.code === "reconfirm");
    const consumed = await commitAmuxUnitRejectConsume(tx, { session, request,
      choice: { ...rejection, consumeRequestId: randomUUID(),
        confirmationDigest: prepared.confirmationDigest }, keys });
    assert.equal(consumed.state, "rejected");
    const rejectedUnit = await tx.amuxIdeaDraftUnit.findUniqueOrThrow({
      where: { id: cardUnit.id },
    });
    assert.equal(rejectedUnit.state, "rejected");
    assert.ok(rejectedUnit.finalDecisionAt && rejectedUnit.bodyPurgeAfter &&
      rejectedUnit.bodyPurgeAfter.getTime() - rejectedUnit.finalDecisionAt.getTime() ===
        30 * 24 * 60 * 60_000);
    assert.equal(await tx.amuxWorkItem.count({
      where: { v4SourceApprovalId: decisionId },
    }), 0, "rejecting a proposal cannot register a card");

    const uncertainPrepared = await commitAmuxUnitRejectPrepare(tx,
      { session, request, choice: uncertainChoice, keys });
    const uncertainConsumeRequestId = randomUUID();
    assert.equal(await commitAmuxUnitRejectUnknown(tx, { actorUserId,
      decisionId: uncertainChoice.decisionId,
      prepareRequestId: uncertainChoice.prepareRequestId,
      consumeRequestId: uncertainConsumeRequestId }), true);
    assert.ok((await tx.amuxIdeaUnitDecision.findUniqueOrThrow({
      where: { id: uncertainChoice.decisionId },
    })).outcomeUnknownAt);
    await assert.rejects(commitAmuxUnitRejectConsume(tx, { session, request,
      choice: { ...uncertainChoice,
        consumeRequestId: uncertainConsumeRequestId,
        confirmationDigest: uncertainPrepared.confirmationDigest }, keys }),
    (error: unknown) => error instanceof AmuxUnitRejectError &&
      error.code === "integrity_unavailable");
    await assert.rejects(commitAmuxUnitRejectPrepare(tx, { session, request,
      choice: { ...uncertainChoice, decisionId: randomUUID(),
        prepareRequestId: randomUUID() }, keys }),
    (error: unknown) => error instanceof AmuxUnitRejectError &&
      error.code === "already_prepared");
    assert.equal((await tx.amuxIdeaDraftUnit.findUniqueOrThrow({
      where: { id: uncertainUnitId }, select: { state: true },
    })).state, "proposed");
    throw new Error("rollback synthetic unit decisions");
  }, { maxWait: 5_000, timeout: 30_000 }), /rollback synthetic unit decisions/);
  assert.equal(await prisma.amuxIdeaUnitDecision.count({
    where: { ideaId },
  }), 0, "synthetic decision rows must not block later schema truncation");
  assert.equal((await readAmuxUnitRejectDecision(session,
    decisionId, prepareRequestId)).state, "absent");

  const duplicateMetadata = Object.fromEntries(Object.entries(
    audit.metadata as Record<string, Prisma.InputJsonValue>,
  ).filter(([key]) => key !== "systemActor" && key !== "actorScope")) as
    Prisma.InputJsonObject;
  await prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    await writeSystemAuditLog({ tx, systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
      action: AMUX_V4_FIRST_DRAFT_SAVED_ACTION,
      targetType: AMUX_V4_FIRST_DRAFT_SAVED_TARGET,
      targetId: `${ideaId}:0`,
      summary: "Synthetic duplicate completion record for readback regression test.",
      metadata: duplicateMetadata });
  });
  await assert.rejects(readAmuxFirstIdeaAnalysisResult(session, ideaId, keys),
    (error: unknown) => error instanceof AmuxIdeaAnalysisResultReadError &&
      error.code === "integrity_unavailable");
});

test("a complete rejection closes analysis without creating proposal cards", async () => {
  const { holdId, previewId } = await syntheticDispatchedHold();
  const preview = await prisma.amuxIdeaTransferPreview.findUniqueOrThrow({
    where: { id: previewId }, select: { ideaId: true },
  });
  const ideaId = preview.ideaId;
  await prisma.amuxIdeaSubmission.update({
    where: { id: ideaId }, data: { state: "analyzing" },
  });
  await prisma.amuxIdeaAnalysisChunk.update({
    where: { ideaId_chunkIndex: { ideaId, chunkIndex: 0 } },
    data: { state: "in_flight", leaseGeneration: 1 },
  });
  await prisma.$transaction((tx) => commitAmuxKnownIdeaAnalysisSettlement(tx,
    { holdId, outcome: "verified_success", inputTokens: 40, outputTokens: 20 }));
  const result = await prisma.$transaction((tx) => commitAmuxFirstIdeaAnalysisDraft(tx, {
    ideaId, previewId, holdId, leaseGeneration: 1, keys,
    rawModelOutput: JSON.stringify({
      schemaVersion: 2, previewId, chunkIndex: 0,
      outcome: "reject", coverageStatus: "complete", continuationKind: null,
      ownerQuestion: null, coveredScope: "The idea cannot yield an actionable card.",
      remainingScope: null, units: [],
    }),
  }));
  assert.equal(result.unitCount, 0);
  assert.equal(await prisma.amuxIdeaDraftUnit.count({ where: { ideaId } }), 0);
  assert.equal((await prisma.amuxIdeaSubmission.findUniqueOrThrow({
    where: { id: ideaId },
  })).state, "awaiting_owner");
  assert.equal((await prisma.amuxIdeaTransferPreview.findUniqueOrThrow({
    where: { id: previewId },
  })).state, "completed");
});

test("a price for another provider cannot reserve the confirmed model payload", async () => {
  const selectedModelId = modelId();
  const previewId = await confirmedPreviewId(selectedModelId);
  const priceVersionId = await approvedPriceVersionId("anthropic", selectedModelId);
  const holdId = randomUUID();
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisBudgetReservation(tx,
      { holdId, previewId, priceVersionId, runner, keys })),
  (error: unknown) => error instanceof AmuxIdeaAnalysisReservationError &&
    error.code === "budget_hold" && error.reason === "price_unverified");
  assert.equal(await prisma.amuxIdeaAnalysisBudgetHold.count({
    where: { id: holdId },
  }), 0);
  assert.equal(await prisma.adminAuditLog.count({
    where: { action: "AMUX_V4_ANALYSIS_BUDGET_RESERVED", targetId: holdId },
  }), 0);
});

test("new holds cannot bypass the server-owned price version", async () => {
  const selectedModelId = modelId();
  const previewId = await confirmedPreviewId(selectedModelId);
  await assert.rejects(prisma.amuxIdeaAnalysisBudgetHold.create({ data: {
    id: randomUUID(), previewId, namespace, monthStart,
    mode: "subscription_cli", provider: "openai", modelId: selectedModelId,
    pricingVersion: "caller-supplied", inputTokensCap: 1_000,
    outputTokensCap: 2_000, inputMicroUsdPerMillion: 1_000_000,
    outputMicroUsdPerMillion: 2_000_000,
    reservedMicroUsd: BigInt(5_000), status: "reserved",
  } }), /AmuxIdeaAnalysisBudgetHold_new_price_required_check/);
});

test("revoked price evidence cannot authorize another reservation", async () => {
  const selectedModelId = modelId();
  const previewId = await confirmedPreviewId(selectedModelId);
  const priceVersionId = await approvedPriceVersionId("openai", selectedModelId);
  const revoked = await prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisPriceRevocation(tx, { session, request,
      priceVersionId, expectedVersion: 1 }));
  assert.equal(revoked.priceVersionId, priceVersionId);
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisPriceRevocation(tx, { session, request,
      priceVersionId, expectedVersion: 1 })), (error: unknown) =>
    error instanceof AmuxIdeaAnalysisPriceApprovalError &&
    error.code === "price_revision_changed");
  const holdId = randomUUID();
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisBudgetReservation(tx,
      { holdId, previewId, priceVersionId, runner, keys })),
  (error: unknown) => error instanceof AmuxIdeaAnalysisReservationError &&
    error.code === "budget_hold" && error.reason === "price_unverified");
  assert.equal(await prisma.amuxIdeaAnalysisBudgetHold.count({
    where: { id: holdId },
  }), 0);
});

test("two confirmed previews cannot reserve the last monthly allowance twice", async () => {
  const selectedModelId = modelId();
  const priceVersionId = await approvedPriceVersionId("openai", selectedModelId);
  const previews = await Promise.all([
    confirmedPreviewId(selectedModelId), confirmedPreviewId(selectedModelId),
  ]);
  const previousWindow = await prisma.amuxIdeaAnalysisBudgetWindow.upsert({
    where: { namespace_monthStart: { namespace, monthStart } },
    create: { namespace, monthStart, limitMicroUsd: BigInt(50_000_000) },
    update: {},
  });
  const holds = previews.map(() => randomUUID());
  try {
    await prisma.amuxIdeaAnalysisBudgetWindow.update({
      where: { namespace_monthStart: { namespace, monthStart } },
      data: { spentMicroUsd: previousWindow.limitMicroUsd -
        previousWindow.reservedMicroUsd - BigInt(5_000) },
    });
    const results = await Promise.allSettled(previews.map((previewId, index) =>
      prisma.$transaction((tx) => commitAmuxIdeaAnalysisBudgetReservation(tx,
        { holdId: holds[index]!, previewId, priceVersionId, runner, keys }))));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert(rejected?.status === "rejected" &&
      rejected.reason instanceof AmuxIdeaAnalysisReservationError &&
      rejected.reason.code === "budget_hold" &&
      rejected.reason.reason === "monthly_cap_exceeded");
    assert.equal((await prisma.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
      where: { namespace_monthStart: { namespace, monthStart } },
    })).reservedMicroUsd, previousWindow.reservedMicroUsd + BigInt(5_000));
    assert.equal(await prisma.amuxIdeaAnalysisBudgetHold.count({
      where: { id: { in: holds } },
    }), 1);
    assert.equal(await prisma.adminAuditLog.count({
      where: { action: "AMUX_V4_ANALYSIS_BUDGET_RESERVED", targetId: { in: holds } },
    }), 1);
  } finally {
    const reservedHolds = await prisma.amuxIdeaAnalysisBudgetHold.findMany({
      where: { id: { in: holds }, status: "reserved" }, select: { id: true },
    });
    for (const hold of reservedHolds) {
      await prisma.$transaction((tx) =>
        commitAmuxIdeaAnalysisUnusedReservationCancellation(tx,
          { session, request, holdId: hold.id }));
    }
    await prisma.amuxIdeaAnalysisBudgetWindow.update({
      where: { namespace_monthStart: { namespace, monthStart } },
      data: { spentMicroUsd: previousWindow.spentMicroUsd },
    });
  }
});

test("budget window rejects another namespace or a larger monthly cap", async () => {
  const invalidMonth = new Date("2026-11-01T00:00:00.000Z");
  await assert.rejects(prisma.amuxIdeaAnalysisBudgetWindow.create({
    data: { namespace: "user-credit", monthStart: invalidMonth,
      limitMicroUsd: BigInt(50_000_000) },
  }), /AmuxIdeaAnalysisBudgetWindow_namespace_check/);
  await assert.rejects(prisma.amuxIdeaAnalysisBudgetWindow.create({
    data: { namespace, monthStart: invalidMonth,
      limitMicroUsd: BigInt(50_000_001) },
  }), /AmuxIdeaAnalysisBudgetWindow_amount_check/);
});

test("a verified second page closes the idea without admitting a card or restarting draft expiry", async () => {
  const workItemsBefore = await prisma.amuxWorkItem.count({
    where: { sourceSystem: "admin-idea-v4" },
  });
  const { holdId, previewId } = await syntheticDispatchedHold();
  const firstPreview = await prisma.amuxIdeaTransferPreview.findUniqueOrThrow({
    where: { id: previewId }, select: { ideaId: true, modelId: true },
  });
  const ideaId = firstPreview.ideaId;
  await prisma.amuxIdeaSubmission.update({
    where: { id: ideaId }, data: { state: "analyzing" },
  });
  await prisma.amuxIdeaAnalysisChunk.update({
    where: { ideaId_chunkIndex: { ideaId, chunkIndex: 0 } },
    data: { state: "in_flight", leaseGeneration: 1 },
  });
  await prisma.$transaction((tx) => commitAmuxKnownIdeaAnalysisSettlement(tx,
    { holdId, outcome: "verified_success", inputTokens: 100, outputTokens: 50 }));
  const firstUnits = [
    { kind: "node", localId: "c0:node-0", level: "initiative", parentRef: null,
      title: "Improve intake", description: "An operator idea.",
      sourceRefIds: ["operator_idea"] },
    { kind: "node", localId: "c0:node-1", level: "epic", parentRef: "c0:node-0",
      title: "Analyze ideas", description: "A bounded proposal.",
      sourceRefIds: ["operator_idea"] },
    { kind: "node", localId: "c0:node-2", level: "feature", parentRef: "c0:node-1",
      title: "Review proposals", description: "A bounded proposal.",
      sourceRefIds: ["operator_idea"] },
    { kind: "card", localId: "c0:card-0", cardType: "story", storyKind: "general",
      title: "Review a first card", problem: "The owner needs a proposal.",
      scopeIn: ["Show the first page"], scopeOut: ["Do not register cards"],
      completionCriteria: ["The first page is visible"], featureRef: "c0:node-2",
      parentStoryRef: null, dependencyRefs: [], duplicateCandidateRefs: [],
      taskRole: null, executionGrade: null, executionBrief: null,
      sourceRefIds: ["operator_idea"] },
  ];
  await prisma.$transaction((tx) => commitAmuxFirstIdeaAnalysisDraft(tx, {
    ideaId, previewId, holdId, leaseGeneration: 1, keys,
    rawModelOutput: JSON.stringify({ schemaVersion: 2, previewId, chunkIndex: 0,
      outcome: "propose", coverageStatus: "more", continuationKind: "output",
      ownerQuestion: null, coveredScope: "First page", remainingScope: "More cards remain",
      units: firstUnits }),
  }));
  const firstCompletedAt = (await prisma.amuxIdeaAnalysisChunk.findUniqueOrThrow({
    where: { ideaId_chunkIndex: { ideaId, chunkIndex: 0 } },
  })).analysisCompletedAt!;
  const nextPreviewId = randomUUID();
  const choice = { previewId: nextPreviewId, ideaId, provider: "openai" as const,
    modelId: firstPreview.modelId, reasoningEffort: "high" as const,
    approvalId: randomUUID(), approvalVersion: 1 };
  const nextPreview = await prisma.$transaction((tx) =>
    commitFirstOutputContinuationTransferPreview(tx, {
      session, request, choice, keys, browserNonce,
    }));
  await prisma.$transaction((tx) => commitIdeaTransferConfirmation(tx, {
    session, request, choice: { previewId: nextPreviewId, ideaId,
      payloadDigest: nextPreview.payloadDigest,
      payloadDigestKeyId: nextPreview.payloadDigestKeyId }, browserNonce, keys,
  }));
  const firstHold = await prisma.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({
    where: { id: holdId }, select: { priceVersionId: true },
  });
  assert.ok(firstHold.priceVersionId);
  const nextHoldId = randomUUID();
  await prisma.$transaction((tx) => commitAmuxIdeaAnalysisBudgetReservation(tx, {
    holdId: nextHoldId, previewId: nextPreviewId,
    priceVersionId: firstHold.priceVersionId!, runner, keys,
  }));
  const confirmed = await prisma.amuxIdeaTransferPreview.findUniqueOrThrow({
    where: { id: nextPreviewId }, select: { confirmedAt: true },
  });
  await prisma.amuxIdeaTransferPreview.update({
    where: { id: nextPreviewId },
    data: { state: "in_flight", consumedAt: confirmed.confirmedAt },
  });
  await prisma.amuxIdeaAnalysisBudgetHold.update({
    where: { id: nextHoldId },
    data: { status: "in_flight", dispatchedAt: new Date() },
  });
  await prisma.amuxIdeaAnalysisChunk.update({
    where: { ideaId_chunkIndex: { ideaId, chunkIndex: 1 } },
    data: { state: "in_flight", leaseGeneration: 1 },
  });
  await prisma.$transaction((tx) => commitAmuxKnownIdeaAnalysisSettlement(tx,
    { holdId: nextHoldId, outcome: "verified_success",
      inputTokens: 100, outputTokens: 50 }));
  const secondOutput = JSON.stringify({ schemaVersion: 2,
    previewId: nextPreviewId, chunkIndex: 1, outcome: "propose",
    coverageStatus: "complete", continuationKind: null,
    ownerQuestion: null, coveredScope: "Remaining cards", remainingScope: null,
    units: [{ kind: "card", localId: "c1:card-0", cardType: "story",
      storyKind: "general", title: "Review another card",
      problem: "The first page was bounded.", scopeIn: ["Show the second page"],
      scopeOut: ["Do not register cards"],
      completionCriteria: ["The second page is visible"],
      featureRef: "c0:node-2", parentStoryRef: null,
      dependencyRefs: [], duplicateCandidateRefs: [],
      taskRole: null, executionGrade: null, executionBrief: null,
      sourceRefIds: ["operator_idea"] }],
  });
  const input = { ideaId, previewId: nextPreviewId, holdId: nextHoldId,
    leaseGeneration: 1, rawModelOutput: secondOutput, keys };
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxSecondIdeaAnalysisDraft(tx, { ...input, leaseGeneration: 0 })),
  (error: unknown) => error instanceof AmuxSecondAnalysisDraftError &&
    error.code === "not_ready");
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxSecondIdeaAnalysisDraft(tx, { ...input,
      rawModelOutput: secondOutput.replace("c0:node-2", "forged-node") })),
  (error: unknown) => error instanceof AmuxSecondAnalysisDraftError &&
    error.code === "invalid_result");
  assert.equal(await prisma.amuxIdeaDraftUnit.count({ where: {
    ideaId, chunkIndex: 1,
  } }), 0);
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxSecondIdeaAnalysisDraft(tx, input),
  { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }),
  (error: unknown) => error instanceof AmuxSecondAnalysisDraftError &&
    error.code === "not_ready");
  await assert.rejects(prisma.$transaction(async (tx) => {
    const partialOutput = JSON.stringify({ ...JSON.parse(secondOutput),
      coverageStatus: "more", continuationKind: "output",
      remainingScope: "A third page remains" });
    const partialSaved = await commitAmuxSecondIdeaAnalysisDraft(tx, {
      ...input, rawModelOutput: partialOutput,
    });
    assert.equal(partialSaved.coverageStatus, "more");
    assert.equal(partialSaved.nextChunkIndex, 2);
    const third = await tx.amuxIdeaAnalysisChunk.findUniqueOrThrow({
      where: { ideaId_chunkIndex: { ideaId, chunkIndex: 2 } },
    });
    assert.equal(third.state, "pending");
    const partialVisible = await readAmuxIdeaAnalysisResultInTransaction(
      tx, session, ideaId, keys);
    assert.equal(partialVisible.state, "continued_partial");
    if (partialVisible.state !== "continued_partial") {
      throw new Error("second partial page unavailable");
    }
    assert.deepEqual(partialVisible.pages.map((page) => page.units.length), [4, 1]);
    throw new Error("rollback synthetic second partial page");
  }), /rollback synthetic second partial page/);
  const saved = await prisma.$transaction((tx) =>
    commitAmuxSecondIdeaAnalysisDraft(tx, input));
  assert.equal(saved.coverageStatus, "complete");
  assert.equal(saved.unitCount, 1);
  assert.equal(saved.nextChunkIndex, null);
  const [idea, second, units, first, audit] = await Promise.all([
    prisma.amuxIdeaSubmission.findUniqueOrThrow({ where: { id: ideaId } }),
    prisma.amuxIdeaAnalysisChunk.findUniqueOrThrow({
      where: { ideaId_chunkIndex: { ideaId, chunkIndex: 1 } },
    }),
    prisma.amuxIdeaDraftUnit.findMany({ where: { ideaId, chunkIndex: 1 } }),
    prisma.amuxIdeaAnalysisChunk.findUniqueOrThrow({
      where: { ideaId_chunkIndex: { ideaId, chunkIndex: 0 } },
    }),
    prisma.adminAuditLog.findUniqueOrThrow({ where: { id: saved.auditId } }),
  ]);
  assert.equal(idea.state, "awaiting_owner");
  assert.ok(idea.analysisCompletedAt);
  assert.equal(second.state, "draft_ready");
  assert.equal(second.outputPartIndex, 1);
  assert.equal(second.outputPending, false);
  assert.equal(units[0]?.localRef, "c1:card-0");
  assert.equal(units[0]?.expiresAt.getTime(),
    firstCompletedAt.getTime() + 30 * 24 * 60 * 60_000);
  assert.ok(first.freeformPurgeAfter!.getTime() <=
    idea.analysisCompletedAt!.getTime() + 24 * 60 * 60_000);
  assert.equal(audit.action, AMUX_V4_SECOND_DRAFT_SAVED_ACTION);
  assert.equal((audit.metadata as Record<string, unknown>).actorScope,
    AMUX_V4_SECOND_DRAFT_SAVED_SCOPE);
  const visible = await readAmuxIdeaAnalysisResult(session, ideaId, keys);
  assert.equal(visible.state, "continued_ready");
  if (visible.state !== "continued_ready") throw new Error("two pages unavailable");
  assert.deepEqual(visible.pages.map((page) => page.chunkIndex), [0, 1]);
  assert.deepEqual(visible.pages.map((page) => page.units.length), [4, 1]);
  assert.equal(visible.pages[0].units[3]?.proposal?.kind, "card");
  assert.equal(visible.pages[1].units[0]?.proposal?.kind, "card");
  await assert.rejects(prisma.$transaction(async (tx) => {
    const choice = { ideaId, draftUnitId: units[0]!.id,
      decisionId: randomUUID(), prepareRequestId: randomUUID(),
      reason: "The second-page proposal is outside this release." };
    const prepared = await commitAmuxUnitRejectPrepare(tx,
      { session, request, choice, keys });
    const decision = await tx.amuxIdeaUnitDecision.findUniqueOrThrow({
      where: { id: prepared.decisionId },
    });
    assert.equal(decision.chunkIndex, 1);
    const consumed = await commitAmuxUnitRejectConsume(tx, {
      session, request, choice: { ...choice, consumeRequestId: randomUUID(),
        confirmationDigest: prepared.confirmationDigest }, keys,
    });
    assert.equal(consumed.state, "rejected");
    assert.equal((await tx.amuxIdeaDraftUnit.findUniqueOrThrow({
      where: { id: units[0]!.id },
    })).state, "rejected");
    assert.equal(await tx.amuxWorkItem.count({
      where: { sourceSystem: "admin-idea-v4" },
    }), workItemsBefore, "rejecting a later page cannot register a card");
    throw new Error("rollback synthetic second-page rejection");
  }, { maxWait: 5_000, timeout: 30_000 }),
  /rollback synthetic second-page rejection/);
  assert.equal(await prisma.amuxWorkItem.count({
    where: { sourceSystem: "admin-idea-v4" },
  }), workItemsBefore);
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxSecondIdeaAnalysisDraft(tx, input)),
  (error: unknown) => error instanceof AmuxSecondAnalysisDraftError &&
    error.code === "not_ready");
});
