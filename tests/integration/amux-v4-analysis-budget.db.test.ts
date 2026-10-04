import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";

import type { Session } from "next-auth";
import { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeAdminAuditLog,
  writeSystemAuditLog } from "@/lib/adminAudit";
import { auditRowActorKind,
  AMUX_V4_ANALYSIS_CLAIM_ACTION,
  AMUX_V4_ANALYSIS_CLAIM_TARGET,
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
import { commitFrontierCatalogDecision } from "@/lib/amux/ideaFrontierCatalogWrite";
import { inspectFrontierCatalogWrite } from "@/lib/amux/ideaFrontierCatalogWriteCore";
import { inspectAmuxIdeaSubmission } from "@/lib/amux/ideaSubmissionCore";
import { commitIdeaSubmission } from "@/lib/amux/ideaSubmissionService";
import { commitInitialIdeaSourcePlan } from "@/lib/amux/ideaInitialSourcePlanAccess";
import { commitFirstOutputContinuationTransferPreview,
  commitIdeaOnlyTransferPreview } from
  "@/lib/amux/ideaTransferPreviewService";
import { commitIdeaTransferConfirmation, readIdeaTransferConfirmation } from
  "@/lib/amux/ideaTransferConfirmationService";
import { commitAmuxIdeaAnalysisBudgetReservation,
  AmuxIdeaAnalysisReservationError } from "@/lib/amux/ideaAnalysisBudgetReservationService";
import { listAmuxV4AnalysisCandidates } from "@/lib/amux/ideaAnalysisQueueService";
import { commitAmuxIdeaOnlyAnalysisClaim,
  enforceAmuxV4DailyClaimLimit,
  readAmuxIdeaAnalysisClaimReceipt,
  AmuxIdeaAnalysisClaimError } from "@/lib/amux/ideaAnalysisClaimService";
import { commitAmuxIdeaAnalysisResult,
  readAmuxIdeaAnalysisResultReceipt,
  AmuxIdeaAnalysisResultError } from "@/lib/amux/ideaAnalysisResultService";
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
import { commitAmuxIdeaAnalysisUnknownResolution,
  AmuxIdeaAnalysisUnknownResolutionError } from
  "@/lib/amux/ideaAnalysisUnknownResolutionService";
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
  commitAmuxEpicNodePrepare, commitAmuxEpicNodeConsume,
  commitAmuxFeatureNodePrepare, commitAmuxFeatureNodeConsume,
  commitAmuxRootNodeUnknown, commitAmuxRootNodeNoCommitConfirmed,
  AmuxNodeCreateError } from "@/lib/amux/ideaNodeCreateService";
import { readAmuxRootNodeDecision,
  readAmuxRootNodeDecisionInTransaction } from
  "@/lib/amux/ideaNodeDecisionReadService";
import { resolveApprovedAmuxRootParent, resolveApprovedAmuxEpicParent,
  AmuxNodeParentResolutionError } from
  "@/lib/amux/ideaNodeParentResolutionService";
import { sealAmuxNodeText } from "@/lib/amux/ideaNodeContentCore";
import { openAmuxContent } from "@/lib/amux/ideaCrypto";
import { commitAmuxIdeaAnalysisPriceApproval,
  commitAmuxIdeaAnalysisPriceRevocation,
  AmuxIdeaAnalysisPriceApprovalError } from "@/lib/amux/ideaAnalysisPriceVersionWrite";
import { readApprovedAmuxIdeaAnalysisPriceVersion } from "@/lib/amux/ideaAnalysisPriceVersionRead";
import { prisma } from "@/lib/prisma";
import { AMUX_V4_ANALYSIS_DAILY_CLAIM_LIMIT,
  amuxV4AnalysisUtcDayKey } from "@/lib/amux/ideaAnalysisInvocationLimitsCore";

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

test("route admission allows claim 12 but holds claim 13 under the DB UTC day", async () => {
  const rollback = `ROLLBACK_${randomUUID()}`;
  await assert.rejects(prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    const rows = await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
    `;
    const today = amuxV4AnalysisUtcDayKey(rows[0]?.now);
    const yesterday = amuxV4AnalysisUtcDayKey(new Date(rows[0]!.now.getTime() - 86_400_000));
    assert.ok(today && yesterday && today !== yesterday);
    const record = async (claimDayUtc: string) => writeSystemAuditLog({ tx,
      systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
      action: AMUX_V4_ANALYSIS_CLAIM_ACTION,
      targetType: AMUX_V4_ANALYSIS_CLAIM_TARGET,
      targetId: randomUUID(), summary: "Synthetic daily admission boundary.",
      metadata: { requestId: randomUUID(), claimDayUtc },
    });
    await record(yesterday);
    for (let count = 1; count < AMUX_V4_ANALYSIS_DAILY_CLAIM_LIMIT; count += 1) {
      assert.equal(await enforceAmuxV4DailyClaimLimit(tx), today);
      await record(today);
    }
    assert.equal(await enforceAmuxV4DailyClaimLimit(tx), today,
      "the twelfth invocation is admitted");
    await record(today);
    await assert.rejects(enforceAmuxV4DailyClaimLimit(tx),
      (error: unknown) => error instanceof AmuxIdeaAnalysisClaimError &&
        error.code === "not_ready");
    throw new Error(rollback);
  }, { maxWait: 5_000, timeout: 30_000 }), new RegExp(rollback));
});

async function confirmedPreviewId(modelId: string,
  frontierApprovalId = randomUUID(),
  ideaText = `SYNTHETIC_BUDGET_${randomUUID()}`): Promise<string> {
  const ideaId = randomUUID();
  const inspected = inspectAmuxIdeaSubmission(JSON.stringify({
    version: 1, requestId: randomUUID(), input: { version: 1,
      idea: ideaText, repositories: [], pullRequests: [] },
  }));
  if (!inspected.ok) throw new Error(inspected.code);
  await prisma.$transaction((tx) => commitIdeaSubmission(tx,
    { session, request, inspected, ideaId, keys }));
  await prisma.$transaction((tx) => commitInitialIdeaSourcePlan(tx,
    { session, request, ideaId, keys }));
  const choice = { previewId: randomUUID(), ideaId, provider: "openai" as const,
    modelId, reasoningEffort: "high" as const,
    approvalId: frontierApprovalId, approvalVersion: 1 };
  const prepared = await prisma.$transaction((tx) => commitIdeaOnlyTransferPreview(tx,
    { session, request, choice, keys, browserNonce }));
  await prisma.$transaction((tx) => commitIdeaTransferConfirmation(tx,
    { session, request, choice: { previewId: choice.previewId, ideaId,
      payloadDigest: prepared.payloadDigest,
      payloadDigestKeyId: prepared.payloadDigestKeyId }, browserNonce, keys }));
  return choice.previewId;
}

test("an expired prepared preview keeps its body until audited key retirement", async () => {
  const ideaId = randomUUID();
  const selectedModelId = `gpt-frontier-synthetic-${randomUUID()}`;
  const inspected = inspectAmuxIdeaSubmission(JSON.stringify({
    version: 1, requestId: randomUUID(), input: { version: 1,
      idea: `SYNTHETIC_RETENTION_${randomUUID()}`,
      repositories: [], pullRequests: [] },
  }));
  if (!inspected.ok) throw new Error(inspected.code);
  await prisma.$transaction((tx) => commitIdeaSubmission(tx,
    { session, request, inspected, ideaId, keys }));
  await prisma.$transaction((tx) => commitInitialIdeaSourcePlan(tx,
    { session, request, ideaId, keys }));
  const priorId = randomUUID();
  const choice = { previewId: priorId, ideaId, provider: "openai" as const,
    modelId: selectedModelId, reasoningEffort: "high" as const,
    approvalId: randomUUID(), approvalVersion: 1 };
  await prisma.$transaction((tx) => commitIdeaOnlyTransferPreview(tx,
    { session, request, choice, keys, browserNonce }));
  await prisma.amuxIdeaTransferPreview.update({ where: { id: priorId },
    data: { expiresAt: new Date(Date.now() - 60_000) } });
  await prisma.$transaction((tx) => commitIdeaOnlyTransferPreview(tx,
    { session, request, choice: { ...choice, previewId: randomUUID(),
      replacesPreviewId: priorId }, keys, browserNonce }));
  const expired = await prisma.amuxIdeaTransferPreview.findUniqueOrThrow({
    where: { id: priorId }, select: { state: true,
      payloadCiphertext: true, payloadKeyId: true,
      payloadPurgeAfter: true, payloadPurgedAt: true },
  });
  assert.equal(expired.state, "expired");
  assert.ok(expired.payloadCiphertext);
  assert.ok(expired.payloadKeyId);
  assert.ok(expired.payloadPurgeAfter);
  assert.equal(expired.payloadPurgedAt, null);
});

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
  await assert.rejects(prisma.$transaction(async (tx) => {
    await commitAmuxIdeaAnalysisBudgetReservation(tx,
      { holdId, previewId, priceVersionId, runner, keys });
    await tx.amuxIdeaAnalysisBudgetHold.update({
      where: { id: holdId },
      data: { status: "in_flight", dispatchedAt: new Date() },
    });
    await assert.rejects(
      commitAmuxIdeaAnalysisUnusedReservationCancellation(tx,
        { session, request, holdId }),
      (error: unknown) => error instanceof AmuxIdeaAnalysisCancellationError &&
        error.code === "not_cancellable");
    await tx.amuxIdeaAnalysisBudgetHold.update({
      where: { id: holdId }, data: { status: "outcome_unknown" },
    });
    await assert.rejects(
      commitAmuxIdeaAnalysisUnusedReservationCancellation(tx,
        { session, request, holdId }),
      (error: unknown) => error instanceof AmuxIdeaAnalysisCancellationError &&
        error.code === "not_cancellable");
    assert.equal((await tx.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
      where: { namespace_monthStart: { namespace, monthStart } },
    })).reservedMicroUsd, reservedBefore + BigInt(5_000));
    throw new Error("rollback synthetic in-flight cancellation fixture");
  }), /rollback synthetic in-flight cancellation fixture/);
  assert.equal((await prisma.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
    where: { namespace_monthStart: { namespace, monthStart } },
  })).reservedMicroUsd, reservedBefore);
  assert.equal(await prisma.amuxIdeaAnalysisBudgetHold.count({ where: { id: holdId } }), 0);
  assert.equal(await prisma.adminAuditLog.count({ where: {
    action: "amux.v4.analysis_budget.unused_reservation_cancelled",
    targetId: holdId,
  } }), 0);
});

test("one confirmed first analysis is claimed, locally simulated, saved and read back once", async () => {
  const selectedModelId = modelId();
  const frontierApprovalId = randomUUID();
  const frontier = inspectFrontierCatalogWrite(JSON.stringify({ schemaVersion: 1,
    action: "approve", approvalId: frontierApprovalId, provider: "openai",
    modelId: selectedModelId, allowedEfforts: ["high"],
    expectedPreviousVersion: 0, ownerConfirmedFrontierEligibility: true }));
  assert.equal(frontier.ok, true);
  if (!frontier.ok) throw new Error("synthetic frontier request invalid");
  await prisma.$transaction((tx) => commitFrontierCatalogDecision(tx,
    { session, request, decision: frontier.request }));
  const previewId = await confirmedPreviewId(selectedModelId, frontierApprovalId);
  const priceVersionId = await approvedPriceVersionId("openai", selectedModelId);
  await prisma.amuxIdeaAnalysisBudgetWindow.upsert({
    where: { namespace_monthStart: { namespace, monthStart } },
    create: { namespace, monthStart, limitMicroUsd: BigInt(50_000_000) },
    update: {},
  });
  const holdId = randomUUID();
  await prisma.$transaction((tx) => commitAmuxIdeaAnalysisBudgetReservation(tx,
    { holdId, previewId, priceVersionId, runner, keys }));
  const claimRequestId = randomUUID();
  assert.deepEqual(await prisma.$transaction((tx) =>
    readAmuxIdeaAnalysisClaimReceipt(tx, { requestId: claimRequestId, previewId })),
  { status: "absent", requestId: claimRequestId, previewId });
  const claim = await prisma.$transaction((tx) =>
    commitAmuxIdeaOnlyAnalysisClaim(tx, { requestId: claimRequestId, previewId, keys }));
  assert.equal(claim.holdId, holdId);
  assert.equal(claim.modelId, selectedModelId);
  assert.equal(claim.leaseGeneration, 1);
  assert.match(claim.prompt, /"previewId":"[a-f0-9-]+"/);
  const [idea, chunk, preview, hold, audit] = await Promise.all([
    prisma.amuxIdeaSubmission.findUniqueOrThrow({ where: { id: claim.ideaId } }),
    prisma.amuxIdeaAnalysisChunk.findUniqueOrThrow({
      where: { ideaId_chunkIndex: { ideaId: claim.ideaId, chunkIndex: 0 } },
    }),
    prisma.amuxIdeaTransferPreview.findUniqueOrThrow({ where: { id: previewId } }),
    prisma.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({ where: { id: holdId } }),
    prisma.adminAuditLog.findUniqueOrThrow({ where: { id: claim.auditId } }),
  ]);
  assert.deepEqual([idea.state, chunk.state, chunk.leaseGeneration,
    preview.state, hold.status], ["analyzing", "in_flight", 1,
    "in_flight", "in_flight"]);
  assert.equal((audit.metadata as Record<string, unknown>).modelCallStarted, false);
  assert.equal((audit.metadata as Record<string, unknown>).requestId, claimRequestId);
  assert.deepEqual(await prisma.$transaction((tx) =>
    readAmuxIdeaAnalysisClaimReceipt(tx, { requestId: claimRequestId, previewId })),
  { status: "committed", requestId: claimRequestId,
    previewId, ideaId: claim.ideaId });
  const wrongClaimRequestId = randomUUID();
  assert.deepEqual(await prisma.$transaction((tx) =>
    readAmuxIdeaAnalysisClaimReceipt(tx,
      { requestId: wrongClaimRequestId, previewId })),
  { status: "partial", requestId: wrongClaimRequestId, previewId });
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxIdeaOnlyAnalysisClaim(tx, { requestId: randomUUID(), previewId, keys })),
  (error: unknown) => error instanceof AmuxIdeaAnalysisClaimError &&
    error.code === "not_ready");
  // Fake local result: no provider CLI or external request occurs in this test.
  const rawModelOutput = JSON.stringify({ schemaVersion: 2, previewId,
    chunkIndex: 0, outcome: "propose", coverageStatus: "complete",
    continuationKind: null, ownerQuestion: null,
    coveredScope: "One synthetic operator idea was analyzed.",
    remainingScope: null,
    units: [{ kind: "node", localId: "c0:node-0", level: "initiative",
      parentRef: null, title: "Synthetic initiative",
      description: "One bounded scope.", sourceRefIds: ["operator_idea"] }],
  });
  const resultInput = { requestId: randomUUID(), ideaId: claim.ideaId,
    previewId, holdId, leaseGeneration: 1 as const,
    outcome: "verified_success" as const, rawModelOutput,
    inputTokens: 100, outputTokens: 50, keys };
  const saved = await prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisResult(tx, resultInput));
  assert.equal(saved.state, "draft_ready");
  assert.equal(saved.duplicate, false);
  const readBack = await prisma.$transaction((tx) =>
    readAmuxIdeaAnalysisResultReceipt(tx, { requestId: resultInput.requestId,
      previewId }));
  assert.equal(readBack.status, "committed");
  assert.equal(readBack.status === "committed" && readBack.auditId, saved.auditId);
  const replay = await prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisResult(tx, resultInput));
  assert.equal(replay.duplicate, true);
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisResult(tx, { ...resultInput,
      requestId: randomUUID() })),
  (error: unknown) => error instanceof AmuxIdeaAnalysisResultError &&
    error.code === "not_ready");
  assert.equal(await prisma.amuxIdeaDraftUnit.count({ where: {
    ideaId: claim.ideaId, chunkIndex: 0,
  } }), 1);
  const visible = await readAmuxFirstIdeaAnalysisResult(session, claim.ideaId, keys);
  assert.equal(visible.state, "ready");
  if (visible.state === "ready") assert.equal(visible.units.length, 1);
  assert.equal(await prisma.amuxWorkItem.count({ where: {
    sourceSystem: "admin-idea-v4", sourceKey: claim.ideaId,
  } }), 0);
});

async function syntheticFirstClaim(ideaText?: string) {
  const selectedModelId = modelId();
  const frontierApprovalId = randomUUID();
  const frontier = inspectFrontierCatalogWrite(JSON.stringify({ schemaVersion: 1,
    action: "approve", approvalId: frontierApprovalId, provider: "openai",
    modelId: selectedModelId, allowedEfforts: ["high"],
    expectedPreviousVersion: 0, ownerConfirmedFrontierEligibility: true }));
  assert.equal(frontier.ok, true);
  if (!frontier.ok) throw new Error("synthetic frontier request invalid");
  await prisma.$transaction((tx) => commitFrontierCatalogDecision(tx,
    { session, request, decision: frontier.request }));
  const previewId = await confirmedPreviewId(selectedModelId, frontierApprovalId,
    ideaText);
  const priceVersionId = await approvedPriceVersionId("openai", selectedModelId);
  await prisma.amuxIdeaAnalysisBudgetWindow.upsert({
    where: { namespace_monthStart: { namespace, monthStart } },
    create: { namespace, monthStart, limitMicroUsd: BigInt(50_000_000) },
    update: {},
  });
  const holdId = randomUUID();
  await prisma.$transaction((tx) => commitAmuxIdeaAnalysisBudgetReservation(tx,
    { holdId, previewId, priceVersionId, runner, keys }));
  const claim = await prisma.$transaction((tx) =>
    commitAmuxIdeaOnlyAnalysisClaim(tx, { requestId: randomUUID(), previewId, keys }));
  return { claim, previewId, holdId, selectedModelId, frontierApprovalId };
}

test("a verified owner question settles measured usage and remains a distinct owner hold", async () => {
  const { claim, previewId, holdId } = await syntheticFirstClaim();
  const requestId = randomUUID();
  const rawModelOutput = JSON.stringify({ schemaVersion: 2, previewId,
    chunkIndex: 0, outcome: "needs_information",
    coverageStatus: "needs_owner_input", continuationKind: null,
    ownerQuestion: "Which feature should own this proposal?",
    coveredScope: "The requested hierarchy is ambiguous.",
    remainingScope: null, units: [] });
  const input = { requestId, ideaId: claim.ideaId, previewId, holdId,
    leaseGeneration: 1, outcome: "verified_success" as const,
    rawModelOutput, inputTokens: 100, outputTokens: 50, keys };
  const result = await prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisResult(tx, input));
  assert.equal(result.state, "owner_input");
  assert.equal((await prisma.$transaction((tx) =>
    readAmuxIdeaAnalysisResultReceipt(tx, { requestId, previewId }))).status,
  "committed");
  const visible = await readAmuxIdeaAnalysisResult(session, claim.ideaId, keys);
  assert.deepEqual(visible, { state: "owner_input", ideaId: claim.ideaId,
    chunkIndex: 0, ownerQuestion: "Which feature should own this proposal?",
    remainingScope: null });
  const [preview, chunk, hold] = await Promise.all([
    prisma.amuxIdeaTransferPreview.findUniqueOrThrow({ where: { id: previewId } }),
    prisma.amuxIdeaAnalysisChunk.findUniqueOrThrow({ where: {
      ideaId_chunkIndex: { ideaId: claim.ideaId, chunkIndex: 0 } } }),
    prisma.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({ where: { id: holdId } }),
  ]);
  assert.deepEqual([preview.state, chunk.state, hold.status],
    ["owner_input", "owner_input", "succeeded"]);
  assert.ok(hold.settledMicroUsd && hold.settledMicroUsd > BigInt(0));
  assert.ok(chunk.freeformCiphertext && chunk.freeformPurgeAfter);
  assert.equal(await prisma.amuxIdeaDraftUnit.count({ where: { ideaId: claim.ideaId } }), 0);
  assert.equal((await prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisResult(tx, input))).duplicate, true);
  await prisma.amuxIdeaAnalysisChunk.update({ where: {
    ideaId_chunkIndex: { ideaId: claim.ideaId, chunkIndex: 0 },
  }, data: { freeformPurgeAfter: new Date(Date.now() - 60_000) } });
  assert.deepEqual(await readAmuxIdeaAnalysisResult(session, claim.ideaId, keys),
    { state: "owner_input", ideaId: claim.ideaId, chunkIndex: 0,
      ownerQuestion: null, remainingScope: null },
  "a delayed purge job cannot expose an expired owner question");
});

async function verifyEighteenChunkIdea(ideaText?: string) {
  const { claim, previewId, holdId, selectedModelId,
    frontierApprovalId } = await syntheticFirstClaim(ideaText);
  const initialOutput = JSON.stringify({ schemaVersion: 2, previewId,
    chunkIndex: 0, outcome: "propose", coverageStatus: "more",
    continuationKind: "output", ownerQuestion: null,
    coveredScope: "The first bounded part is proposed.",
    remainingScope: "Seventeen more bounded parts remain.",
    units: [
      { kind: "node", localId: "c0:node-0", level: "initiative",
        parentRef: null, title: "Synthetic initiative",
        description: "The whole synthetic idea.", sourceRefIds: ["operator_idea"] },
      { kind: "node", localId: "c0:node-1", level: "epic",
        parentRef: "c0:node-0", title: "Synthetic epic",
        description: "A bounded epic.", sourceRefIds: ["operator_idea"] },
      { kind: "node", localId: "c0:node-2", level: "feature",
        parentRef: "c0:node-1", title: "Synthetic feature",
        description: "A bounded feature.", sourceRefIds: ["operator_idea"] },
      { kind: "card", localId: "c0:card-0", cardType: "story",
        storyKind: "general", title: "First synthetic story",
        problem: "The idea has more than eight cards.",
        scopeIn: ["Propose the first part"], scopeOut: ["Do not register it"],
        completionCriteria: ["The first part is separately reviewable"],
        featureRef: "c0:node-2", parentStoryRef: null,
        dependencyRefs: [], duplicateCandidateRefs: [],
        taskRole: null, executionGrade: null, executionBrief: null,
        sourceRefIds: ["operator_idea"] },
    ] });
  const firstReceipt = await prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisResult(tx, { requestId: randomUUID(),
      ideaId: claim.ideaId, previewId, holdId, leaseGeneration: 1,
      outcome: "verified_success", rawModelOutput: initialOutput,
      inputTokens: 100, outputTokens: 50, keys }),
  { maxWait: 5_000, timeout: 30_000 });
  assert.equal(firstReceipt.state, "draft_ready");
  const initialPrice = await prisma.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({
    where: { id: holdId }, select: { priceVersionId: true },
  });
  assert.ok(initialPrice.priceVersionId);
  const previewIds = [previewId];
  const holdIds = [holdId];
  for (let index = 1; index <= 17; index += 1) {
    const nextPreviewId = randomUUID();
    const choice = { previewId: nextPreviewId, ideaId: claim.ideaId,
      chunkIndex: index, provider: "openai" as const,
      modelId: selectedModelId, reasoningEffort: "high" as const,
      approvalId: frontierApprovalId, approvalVersion: 1,
      ...((index === 16 || index === 17) && ideaText
        ? { pinnedTargetRefs: ["c4:card-0"] } : {}) };
    if (index === 17) {
      await assert.rejects(prisma.$transaction((tx) =>
        commitFirstOutputContinuationTransferPreview(tx, {
          session, request, choice: { ...choice, previewId: randomUUID(),
            pinnedTargetRefs: ["c999:card-0"] }, keys, browserNonce,
        })), (error: unknown) => error instanceof Error &&
          error.message === "reference_selection_required");
    }
    const prepared = await prisma.$transaction((tx) =>
      commitFirstOutputContinuationTransferPreview(tx, {
        session, request, choice, keys, browserNonce,
      }), { maxWait: 5_000, timeout: 30_000 });
    if (index === 1) {
      await assert.rejects(prisma.$transaction((tx) =>
        commitFirstOutputContinuationTransferPreview(tx, {
          session, request, choice: { ...choice, chunkIndex: 2,
            previewId: randomUUID() }, keys, browserNonce,
        })), (error: unknown) => error instanceof Error &&
          error.message === "not_ready",
      "an uncreated later chunk cannot skip the previous page");
    }
    await assert.rejects(prisma.$transaction((tx) =>
      commitAmuxIdeaAnalysisBudgetReservation(tx, {
        holdId: randomUUID(), previewId: nextPreviewId,
        priceVersionId: initialPrice.priceVersionId!, runner, keys,
      })), (error: unknown) => error instanceof AmuxIdeaAnalysisReservationError &&
        error.code === "not_ready",
    "a prepared but unconfirmed page cannot spend Agent budget");
    await assert.rejects(prisma.$transaction((tx) =>
      commitIdeaTransferConfirmation(tx, { session, request,
        choice: { previewId: nextPreviewId, ideaId: claim.ideaId,
          payloadDigest: randomBytes(32).toString("hex"),
          payloadDigestKeyId: prepared.payloadDigestKeyId },
        browserNonce, keys,
      })), (error: unknown) => error instanceof Error &&
        error.message === "digest_changed",
    "the owner cannot confirm a different transfer digest");
    await prisma.$transaction((tx) => commitIdeaTransferConfirmation(tx, {
      session, request, choice: { previewId: nextPreviewId,
        ideaId: claim.ideaId, payloadDigest: prepared.payloadDigest,
        payloadDigestKeyId: prepared.payloadDigestKeyId }, browserNonce, keys,
    }), { maxWait: 5_000, timeout: 30_000 });
    const nextHoldId = randomUUID();
    if (index === 2) {
      await assert.rejects(prisma.$transaction(async (tx) => {
        const window = await tx.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
          where: { namespace_monthStart: { namespace, monthStart } },
        });
        await tx.amuxIdeaAnalysisBudgetWindow.update({
          where: { namespace_monthStart: { namespace, monthStart } },
          data: { spentMicroUsd: window.limitMicroUsd - window.reservedMicroUsd },
        });
        await assert.rejects(commitAmuxIdeaAnalysisBudgetReservation(tx, {
          holdId: nextHoldId, previewId: nextPreviewId,
          priceVersionId: initialPrice.priceVersionId!, runner, keys,
        }), (error: unknown) =>
          error instanceof AmuxIdeaAnalysisReservationError &&
          error.code === "budget_hold");
        const visible = await readAmuxIdeaAnalysisResultInTransaction(
          tx, session, claim.ideaId, keys);
        assert.equal(visible.state, "continued_partial");
        throw new Error("rollback synthetic exhausted monthly budget");
      }, { maxWait: 5_000, timeout: 30_000 }),
      /rollback synthetic exhausted monthly budget/);
    }
    await prisma.$transaction((tx) => commitAmuxIdeaAnalysisBudgetReservation(tx, {
      holdId: nextHoldId, previewId: nextPreviewId,
      priceVersionId: initialPrice.priceVersionId!, runner, keys,
    }), { maxWait: 5_000, timeout: 30_000 });
    const nextClaim = await prisma.$transaction((tx) =>
      commitAmuxIdeaOnlyAnalysisClaim(tx, { requestId: randomUUID(), previewId: nextPreviewId, keys }),
    { maxWait: 5_000, timeout: 30_000 });
    assert.equal(nextClaim.holdId, nextHoldId);
    assert.match(nextClaim.prompt, new RegExp(`"chunkIndex":${index}`));
    assert.equal(prepared.payload.prompt, nextClaim.prompt,
      "the owner-reviewed preview is the exact synthetic runner payload");
    const unit = index === 1
      ? { kind: "card", localId: "c1:card-0", cardType: "story",
        storyKind: "general", title: "Second synthetic story",
        problem: "One story does not cover the remaining scope.",
        scopeIn: ["Propose another story"], scopeOut: ["Do not register it"],
        completionCriteria: ["The second part is separately reviewable"],
        featureRef: "c0:node-2", parentStoryRef: null,
        dependencyRefs: [], duplicateCandidateRefs: [],
        taskRole: null, executionGrade: null, executionBrief: null,
        sourceRefIds: ["operator_idea"] }
      : { kind: "card", localId: `c${index}:card-0`, cardType: "task",
        storyKind: null, title: `Synthetic task ${index}`,
        problem: "The idea needs a separately testable task.",
        scopeIn: [`Verify part ${index}`], scopeOut: ["Do not execute it"],
        completionCriteria: [`Part ${index} is separately testable`],
        featureRef: "c0:node-2", parentStoryRef: "c1:card-0",
        dependencyRefs: index === 3 ? ["c2:card-0"] :
          (index === 16 || index === 17) && ideaText ? ["c4:card-0"] : [],
        duplicateCandidateRefs: [], taskRole: "verify",
        executionGrade: "routine", executionBrief: "Use a synthetic test only.",
        sourceRefIds: ["operator_idea"] };
    const complete = index === 17;
    const units = index >= 4 ? Array.from({ length: 8 }, (_, ordinal) => ({
      ...unit, localId: `c${index}:card-${ordinal}`,
      title: `Synthetic task ${index}.${ordinal}`,
    })) : [unit];
    const output = JSON.stringify({ schemaVersion: 2,
      previewId: nextPreviewId, chunkIndex: index, outcome: "propose",
      coverageStatus: complete ? "complete" : "more",
      continuationKind: complete ? null : "output", ownerQuestion: null,
      coveredScope: `Part ${index} is proposed.`,
      remainingScope: complete ? null : `Part ${index + 1} remains.`,
      units });
    if (index === 2) {
      await assert.rejects(prisma.$transaction(async (tx) => {
        const unknown = await commitAmuxIdeaAnalysisResult(tx, {
          requestId: randomUUID(), ideaId: claim.ideaId,
          previewId: nextPreviewId, holdId: nextHoldId,
          leaseGeneration: nextClaim.leaseGeneration,
          outcome: "outcome_unknown", rawModelOutput: null,
          inputTokens: null, outputTokens: null, keys,
        });
        assert.equal(unknown.state, "outcome_unknown");
        assert.equal((await tx.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({
          where: { id: nextHoldId }, select: { status: true },
        })).status, "outcome_unknown");
        const visible = await readAmuxIdeaAnalysisResultInTransaction(
          tx, session, claim.ideaId, keys);
        assert.equal(visible.state, "continued_partial");
        throw new Error("rollback synthetic continuation unknown outcome");
      }, { maxWait: 5_000, timeout: 30_000 }),
      /rollback synthetic continuation unknown outcome/);
      await assert.rejects(prisma.$transaction(async (tx) => {
        const failed = await commitAmuxIdeaAnalysisResult(tx, {
          requestId: randomUUID(), ideaId: claim.ideaId,
          previewId: nextPreviewId, holdId: nextHoldId,
          leaseGeneration: nextClaim.leaseGeneration,
          outcome: "verified_success",
          rawModelOutput: output.replaceAll("c0:node-2", "forged-node"),
          inputTokens: 100, outputTokens: 50, keys,
        });
        assert.equal(failed.state, "provider_failed");
        assert.equal((await readAmuxIdeaAnalysisResultInTransaction(
          tx, session, claim.ideaId, keys)).state, "continued_partial");
        throw new Error("rollback synthetic malformed second continuation");
      }, { maxWait: 5_000, timeout: 30_000 }),
      /rollback synthetic malformed second continuation/);
    }
    if (index === 17) {
      const transferData = nextClaim.prompt.split(
        "BEGIN_CONFIRMED_DATA_JSON\n")[1]!.split(
        "\nEND_CONFIRMED_DATA_JSON")[0]!;
      const transferred = JSON.parse(transferData) as {
        omittedTargetSummary: { count: number; firstChunkIndex: number;
          lastChunkIndex: number } | null;
        permittedTargetRefs: Array<{ ref: string }>;
      };
      assert.ok(transferred.omittedTargetSummary?.count);
      assert.ok(Buffer.byteLength(transferData, "utf8") <= 16 * 1024);
      if (ideaText) assert.ok(transferred.permittedTargetRefs.length < 96,
        "the long source forces exact JSON-byte-based reference trimming");
      assert.ok(transferred.omittedTargetSummary!.firstChunkIndex <= 4);
      assert.ok(transferred.omittedTargetSummary!.lastChunkIndex >= 4);
      assert.equal(transferred.permittedTargetRefs.some((target) =>
        target.ref === "c4:card-0"), Boolean(ideaText));
      const forged = JSON.parse(output) as { units: Array<{
        dependencyRefs: string[] }> };
      forged.units[0]!.dependencyRefs = [ideaText ? "c4:card-1" : "c4:card-0"];
      await assert.rejects(prisma.$transaction(async (tx) => {
        const failed = await commitAmuxIdeaAnalysisResult(tx, {
          requestId: randomUUID(), ideaId: claim.ideaId,
          previewId: nextPreviewId, holdId: nextHoldId,
          leaseGeneration: nextClaim.leaseGeneration,
          outcome: "verified_success", rawModelOutput: JSON.stringify(forged),
          inputTokens: 100, outputTokens: 50, keys,
        });
        assert.equal(failed.state, "provider_failed");
        throw new Error("rollback synthetic omitted reference");
      }, { maxWait: 5_000, timeout: 30_000 }),
      /rollback synthetic omitted reference/);
    }
    const requestId = randomUUID();
    const result = await prisma.$transaction((tx) =>
      commitAmuxIdeaAnalysisResult(tx, { requestId,
        ideaId: claim.ideaId, previewId: nextPreviewId,
        holdId: nextHoldId, leaseGeneration: nextClaim.leaseGeneration,
        outcome: "verified_success", rawModelOutput: output,
        inputTokens: 100, outputTokens: 50, keys }),
    { maxWait: 5_000, timeout: 30_000 });
    assert.equal(result.state, "draft_ready");
    if (index === 16 && ideaText) {
      const retained = await prisma.amuxIdeaTransferPreview.findUniqueOrThrow({
        where: { id: nextPreviewId },
      });
      await prisma.amuxIdeaTransferPreview.update({ where: { id: nextPreviewId },
        data: { payloadCiphertext: null, payloadKeyId: null,
          payloadKeyVersion: null, payloadPurgedAt: new Date(),
          payloadPurgeAfter: new Date(Date.now() - 1_000) } });
      assert.ok(retained.payloadDigest,
        "the prior sealed payload has a keyed digest even after its body is purged");
    }
    assert.equal((await prisma.$transaction((tx) =>
      readAmuxIdeaAnalysisResultReceipt(tx, { requestId,
        previewId: nextPreviewId }))).status, "committed");
    previewIds.push(nextPreviewId);
    holdIds.push(nextHoldId);
    const visible = await readAmuxIdeaAnalysisResult(session, claim.ideaId, keys);
    if (index >= 16) {
      assert.equal(visible.state, "continued_window");
      if (visible.state !== "continued_window") throw new Error("missing first window");
      assert.equal(visible.nextChunkIndex, 16);
      assert.deepEqual(visible.pages.map((page) => page.chunkIndex),
        Array.from({ length: 16 }, (_, ordinal) => ordinal));
    } else {
      assert.equal(visible.state, "continued_partial");
    }
    const latest = index >= 16
      ? await readAmuxIdeaAnalysisResult(session, claim.ideaId, keys, 16)
      : visible;
    if (latest.state !== "continued_ready" &&
        latest.state !== "continued_partial" &&
        latest.state !== "continued_window") throw new Error("missing pages");
    assert.deepEqual(latest.pages.map((page) => page.chunkIndex),
      Array.from({ length: index >= 16 ? index - 15 : index + 1 },
        (_, ordinal) => ordinal + (index >= 16 ? 16 : 0)));
    if (latest.state === "continued_window") {
      assert.equal(latest.complete, complete);
      assert.equal(latest.nextChunkIndex, null);
    }
    assert.equal(latest.pages.at(-1)?.remainingScope,
      complete ? null : `Part ${index + 1} remains.`);
  }
  for (const [index, candidate] of previewIds.entries()) {
    const [preview, hold, chunk] = await Promise.all([
      prisma.amuxIdeaTransferPreview.findUniqueOrThrow({ where: { id: candidate } }),
      prisma.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({ where: { id: holdIds[index] } }),
      prisma.amuxIdeaAnalysisChunk.findUniqueOrThrow({ where: {
        ideaId_chunkIndex: { ideaId: claim.ideaId, chunkIndex: index },
      } }),
    ]);
    assert.deepEqual([preview.state, hold.status, chunk.state],
      ["completed", "succeeded", "draft_ready"]);
    assert.equal(preview.chunkIndex, index);
    assert.equal(hold.previewId, candidate);
  }
  const finalIdea = await prisma.amuxIdeaSubmission.findUniqueOrThrow({
    where: { id: claim.ideaId }, select: { analysisCompletedAt: true },
  });
  assert.ok(finalIdea.analysisCompletedAt);
  const deadline = finalIdea.analysisCompletedAt.getTime() + 24 * 60 * 60_000;
  const earlierChunks = await prisma.amuxIdeaAnalysisChunk.findMany({
    where: { ideaId: claim.ideaId, chunkIndex: { lt: 17 } },
    orderBy: { chunkIndex: "asc" },
  });
  assert.equal(earlierChunks.length, 17);
  for (const chunk of earlierChunks) {
    assert.ok(chunk.freeformPurgeAfter);
    assert.ok(Math.abs(chunk.freeformPurgeAfter.getTime() - deadline) < 5_000,
      `the prior partial chunk ${chunk.chunkIndex} purges 24h after completion`);
  }
  for (const chunkIndex of [1, 17]) {
    const unit = await prisma.amuxIdeaDraftUnit.findFirstOrThrow({
      where: { ideaId: claim.ideaId, chunkIndex, unitKind: "card" },
      orderBy: { unitIndex: "asc" },
    });
    await assert.rejects(prisma.$transaction(async (tx) => {
      const choice = { ideaId: claim.ideaId, draftUnitId: unit.id,
        decisionId: randomUUID(), prepareRequestId: randomUUID(),
        reason: "Synthetic owner rejection in a paged completed idea." };
      const prepared = await commitAmuxUnitRejectPrepare(tx,
        { session, request, choice, keys });
      const consumed = await commitAmuxUnitRejectConsume(tx, {
        session, request, choice: { ...choice,
          consumeRequestId: randomUUID(),
          confirmationDigest: prepared.confirmationDigest }, keys,
      });
      assert.equal(consumed.state, "rejected");
      throw new Error(`rollback synthetic rejection page ${chunkIndex}`);
    }, { maxWait: 5_000, timeout: 30_000 }),
    new RegExp(`rollback synthetic rejection page ${chunkIndex}`));
  }
  assert.equal(await prisma.amuxWorkItem.count({ where: {
    sourceSystem: "admin-idea-v4", sourceKey: claim.ideaId,
  } }), 0, "analysis must not register backlog cards");
}

test("one idea continues through eighteen separately approved and settled chunks", async () => {
  await verifyEighteenChunkIdea();
});

test("an eight KiB idea still continues after reference and JSON byte trimming", async () => {
  await verifyEighteenChunkIdea(`SYNTHETIC_LONG_${"A".repeat(7_600)}`);
});

test("an unresolved in-flight result blocks a second Agent claim", async () => {
  const { claim, previewId, holdId, selectedModelId,
    frontierApprovalId } = await syntheticFirstClaim();
  const nextPreviewId = await confirmedPreviewId(selectedModelId, frontierApprovalId);
  const hold = await prisma.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({
    where: { id: holdId }, select: { priceVersionId: true },
  });
  assert.ok(hold.priceVersionId);
  await prisma.$transaction((tx) => commitAmuxIdeaAnalysisBudgetReservation(tx,
    { holdId: randomUUID(), previewId: nextPreviewId,
      priceVersionId: hold.priceVersionId!, runner, keys }));
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxIdeaOnlyAnalysisClaim(tx, { requestId: randomUUID(), previewId: nextPreviewId, keys })),
  (error: unknown) => error instanceof AmuxIdeaAnalysisClaimError &&
    error.code === "not_ready");
  const rawModelOutput = JSON.stringify({ schemaVersion: 2, previewId,
    chunkIndex: 0, outcome: "propose", coverageStatus: "complete",
    continuationKind: null, ownerQuestion: null,
    coveredScope: "One synthetic idea was analyzed.", remainingScope: null,
    units: [{ kind: "node", localId: "c0:node-0", level: "initiative",
      parentRef: null, title: "Synthetic initiative",
      description: "A bounded result.", sourceRefIds: ["operator_idea"] }],
  });
  const settled = await prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisResult(tx, { requestId: randomUUID(),
      ideaId: claim.ideaId, previewId, holdId, leaseGeneration: 1,
      outcome: "verified_success", rawModelOutput,
      inputTokens: 100, outputTokens: 50, keys }));
  assert.equal(settled.state, "draft_ready");
  await assert.rejects(prisma.$transaction(async (tx) => {
    const second = await commitAmuxIdeaOnlyAnalysisClaim(tx,
      { requestId: randomUUID(), previewId: nextPreviewId, keys });
    assert.equal(second.previewId, nextPreviewId);
    throw new Error("rollback synthetic second claim");
  }), /rollback synthetic second claim/);
});

test("malformed known output settles cost and requires a fresh owner preview", async () => {
  const { claim, previewId, holdId, selectedModelId,
    frontierApprovalId } = await syntheticFirstClaim();
  const requestId = randomUUID();
  const resultInput = { requestId, ideaId: claim.ideaId, previewId,
    holdId, leaseGeneration: 1 as const,
    outcome: "verified_success" as const,
    rawModelOutput: "not a valid analysis response",
    inputTokens: 100, outputTokens: 50, keys };
  const result = await prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisResult(tx, resultInput));
  assert.equal(result.state, "provider_failed");
  const lostResponseReadBack = await prisma.$transaction((tx) =>
    readAmuxIdeaAnalysisResultReceipt(tx, { requestId, previewId }));
  assert.equal(lostResponseReadBack.status, "committed");
  assert.equal(lostResponseReadBack.status === "committed" &&
    lostResponseReadBack.state, "provider_failed");
  assert.equal((await prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisResult(tx, resultInput))).duplicate, true);
  const [hold, preview, idea, chunk, audit] = await Promise.all([
    prisma.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({ where: { id: holdId } }),
    prisma.amuxIdeaTransferPreview.findUniqueOrThrow({ where: { id: previewId } }),
    prisma.amuxIdeaSubmission.findUniqueOrThrow({ where: { id: claim.ideaId } }),
    prisma.amuxIdeaAnalysisChunk.findUniqueOrThrow({
      where: { ideaId_chunkIndex: { ideaId: claim.ideaId, chunkIndex: 0 } },
    }),
    prisma.adminAuditLog.findUniqueOrThrow({ where: { id: result.auditId } }),
  ]);
  assert.equal(hold.status, "failed");
  assert.ok(hold.settledMicroUsd && hold.settledMicroUsd > BigInt(0));
  assert.equal(preview.state, "provider_failed");
  assert.equal(idea.state, "submitted");
  assert.equal(chunk.state, "awaiting_preview");
  assert.equal(chunk.leaseGeneration, 0);
  assert.equal((audit.metadata as Record<string, unknown>).failureReason,
    "invalid_result");
  assert.deepEqual(await readAmuxFirstIdeaAnalysisResult(session, claim.ideaId, keys),
    { state: "provider_failed" });
  const nextPreviewId = randomUUID();
  const nextPreview = await prisma.$transaction((tx) =>
    commitIdeaOnlyTransferPreview(tx, { session, request, keys, browserNonce,
      choice: { previewId: nextPreviewId, ideaId: claim.ideaId,
        replacesPreviewId: previewId, provider: "openai",
        modelId: selectedModelId, reasoningEffort: "high",
        approvalId: frontierApprovalId, approvalVersion: 1 } }));
  assert.equal((await prisma.amuxIdeaTransferPreview.findUniqueOrThrow({
    where: { id: nextPreviewId }, select: { attempt: true },
  })).attempt, 2);
  assert.equal((await prisma.amuxIdeaTransferPreview.findUniqueOrThrow({
    where: { id: previewId }, select: { state: true },
  })).state, "provider_failed");
  await prisma.$transaction((tx) => commitIdeaTransferConfirmation(tx, {
    session, request, choice: { previewId: nextPreviewId,
      ideaId: claim.ideaId, payloadDigest: nextPreview.payloadDigest,
      payloadDigestKeyId: nextPreview.payloadDigestKeyId }, browserNonce, keys,
  }));
  assert.equal((await prisma.amuxIdeaTransferPreview.findUniqueOrThrow({
    where: { id: nextPreviewId }, select: { state: true },
  })).state, "confirmed");
  assert.equal((await prisma.$transaction((tx) =>
    readAmuxIdeaAnalysisResultReceipt(tx, { requestId, previewId }))).status,
  "committed", "the old receipt remains readable after owner re-preview");
  assert.ok(hold.priceVersionId);
  const nextHoldId = randomUUID();
  await prisma.$transaction((tx) => commitAmuxIdeaAnalysisBudgetReservation(tx,
    { holdId: nextHoldId, previewId: nextPreviewId,
      priceVersionId: hold.priceVersionId!, runner, keys }));
  const nextClaim = await prisma.$transaction((tx) =>
    commitAmuxIdeaOnlyAnalysisClaim(tx, { requestId: randomUUID(), previewId: nextPreviewId, keys }));
  assert.equal(nextClaim.leaseGeneration, 1);
  const knownFailure = await prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisResult(tx, { requestId: randomUUID(),
      ideaId: claim.ideaId, previewId: nextPreviewId,
      holdId: nextHoldId, leaseGeneration: 1,
      outcome: "invocation_failed", rawModelOutput: null,
      inputTokens: 25, outputTokens: 10, keys }));
  assert.equal(knownFailure.state, "provider_failed");
  assert.equal((await prisma.amuxIdeaAnalysisChunk.findUniqueOrThrow({
    where: { ideaId_chunkIndex: { ideaId: claim.ideaId, chunkIndex: 0 } },
  })).state, "awaiting_preview");
});

test("unknown usage marks the whole Agent stopped without a blind retry", async () => {
  const { claim, previewId, holdId, selectedModelId,
    frontierApprovalId } = await syntheticFirstClaim();
  const nextPreviewId = await confirmedPreviewId(selectedModelId, frontierApprovalId);
  const price = await prisma.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({
    where: { id: holdId }, select: { priceVersionId: true },
  });
  assert.ok(price.priceVersionId);
  await prisma.$transaction((tx) => commitAmuxIdeaAnalysisBudgetReservation(tx,
    { holdId: randomUUID(), previewId: nextPreviewId,
      priceVersionId: price.priceVersionId!, runner, keys }));
  await assert.rejects(prisma.$transaction(async (tx) => {
    const unknown = await commitAmuxIdeaAnalysisResult(tx, {
      requestId: randomUUID(), ideaId: claim.ideaId, previewId, holdId,
      leaseGeneration: 1, outcome: "outcome_unknown",
      rawModelOutput: null, inputTokens: null, outputTokens: null, keys,
    });
    assert.equal(unknown.state, "outcome_unknown");
    const [hold, chunk] = await Promise.all([
      tx.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({ where: { id: holdId } }),
      tx.amuxIdeaAnalysisChunk.findUniqueOrThrow({
        where: { ideaId_chunkIndex: { ideaId: claim.ideaId, chunkIndex: 0 } },
      }),
    ]);
    assert.equal(hold.status, "outcome_unknown");
    assert.equal(chunk.state, "outcome_unknown");
    await assert.rejects(commitAmuxIdeaOnlyAnalysisClaim(tx,
      { requestId: randomUUID(), previewId: nextPreviewId, keys }),
    (error: unknown) => error instanceof AmuxIdeaAnalysisClaimError &&
      error.code === "not_ready");
    throw new Error("rollback synthetic unknown halt");
  }, { maxWait: 5_000, timeout: 30_000 }), /rollback synthetic unknown halt/);
  await assert.rejects(prisma.$transaction(async (tx) => {
    const overCap = await commitAmuxIdeaAnalysisResult(tx, {
      requestId: randomUUID(), ideaId: claim.ideaId, previewId, holdId,
      leaseGeneration: 1, outcome: "invocation_failed",
      rawModelOutput: null, inputTokens: 1_000_000_000,
      outputTokens: 1, keys,
    });
    assert.equal(overCap.state, "outcome_unknown");
    assert.equal((await tx.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({
      where: { id: holdId }, select: { status: true },
    })).status, "outcome_unknown");
    throw new Error("rollback synthetic over-cap halt");
  }, { maxWait: 5_000, timeout: 30_000 }), /rollback synthetic over-cap halt/);
  const completed = await prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisResult(tx, {
      requestId: randomUUID(), ideaId: claim.ideaId, previewId, holdId,
      leaseGeneration: 1, outcome: "verified_success",
      rawModelOutput: JSON.stringify({ schemaVersion: 2, previewId,
        chunkIndex: 0, outcome: "reject", coverageStatus: "complete",
        continuationKind: null, ownerQuestion: null,
        coveredScope: "Synthetic unknown-outcome rollback check.",
        remainingScope: null, units: [] }),
      inputTokens: 100, outputTokens: 50, keys,
    }));
  assert.equal(completed.state, "draft_ready");
});

test("the Agent-wide third consecutive failed settlement blocks a new claim", async () => {
  const selectedModelId = modelId();
  const frontierApprovalId = randomUUID();
  const frontier = inspectFrontierCatalogWrite(JSON.stringify({ schemaVersion: 1,
    action: "approve", approvalId: frontierApprovalId, provider: "openai",
    modelId: selectedModelId, allowedEfforts: ["high"],
    expectedPreviousVersion: 0, ownerConfirmedFrontierEligibility: true }));
  assert.equal(frontier.ok, true);
  if (!frontier.ok) throw new Error("synthetic frontier request invalid");
  await prisma.$transaction((tx) => commitFrontierCatalogDecision(tx,
    { session, request, decision: frontier.request }));
  const previewId = await confirmedPreviewId(selectedModelId, frontierApprovalId);
  const priceVersionId = await approvedPriceVersionId("openai", selectedModelId);
  await prisma.amuxIdeaAnalysisBudgetWindow.upsert({
    where: { namespace_monthStart: { namespace, monthStart } },
    create: { namespace, monthStart, limitMicroUsd: BigInt(50_000_000) },
    update: {},
  });
  await prisma.$transaction((tx) => commitAmuxIdeaAnalysisBudgetReservation(tx,
    { holdId: randomUUID(), previewId, priceVersionId, runner, keys }));
  await assert.rejects(prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    for (let index = 0; index < 3; index += 1) {
      await writeSystemAuditLog({ tx, systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
        action: "AMUX_V4_ANALYSIS_BUDGET_SETTLED",
        targetType: "AmuxIdeaAnalysisBudgetHold",
        targetId: `synthetic-failure-${index}-${previewId}`,
        summary: "Synthetic failed invocation for claim admission test.",
        metadata: { namespace, status: "failed", inputTokens: 1,
          outputTokens: 0 },
      });
    }
    await commitAmuxIdeaOnlyAnalysisClaim(tx, { requestId: randomUUID(), previewId, keys });
  }, { maxWait: 5_000, timeout: 30_000 }),
  (error: unknown) => error instanceof AmuxIdeaAnalysisClaimError &&
    error.code === "not_ready");
  assert.equal((await prisma.amuxIdeaTransferPreview.findUniqueOrThrow({
    where: { id: previewId }, select: { state: true },
  })).state, "confirmed");
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
  const settled = await prisma.$transaction((tx) =>
    commitAmuxKnownIdeaAnalysisSettlement(tx,
      { holdId, outcome: "invocation_failed", inputTokens: 12,
        outputTokens: 0 }));
  assert.equal(settled.status, "failed");
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
  // This synthetic transaction fixture seals with an in-memory key. The
  // public read-back now requires the external per-unit store, so verify the
  // stored envelope here with the fixture key instead of bypassing that gate.
  assert.equal(nextPreview.payloadDigest, continued.payloadDigest);
  const readbackPayload = openAmuxContent({
    ciphertext: Buffer.from(nextPreview.payloadCiphertext!),
    keyId: nextPreview.payloadKeyId!,
    keyVersion: nextPreview.payloadKeyVersion!,
  }, "transfer_payload", nextPreviewId, keys);
  assert.match(JSON.parse(readbackPayload.toString("utf8")).prompt, /"chunkIndex":1/);
  readbackPayload.fill(0);
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
  const expiredAt = new Date(Date.now() - 60_000);
  await prisma.amuxIdeaTransferPreview.update({
    where: { id: nextPreviewId },
    data: { confirmedAt: new Date(expiredAt.getTime() - 60_000),
      expiresAt: expiredAt, confirmExpiresAt: expiredAt },
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
  const expiredPrepared = await prisma.amuxIdeaTransferPreview.findUniqueOrThrow({
    where: { id: replacementId },
    select: { payloadCiphertext: true, payloadKeyId: true,
      payloadPurgeAfter: true, payloadPurgedAt: true },
  });
  assert.ok(expiredPrepared.payloadCiphertext,
    "replacement must leave the body for audited retention/key retirement");
  assert.ok(expiredPrepared.payloadKeyId);
  assert.ok(expiredPrepared.payloadPurgeAfter);
  assert.equal(expiredPrepared.payloadPurgedAt, null);
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
  await assert.rejects(prisma.$transaction((tx) =>
    resolveApprovedAmuxRootParent(tx, session,
      { ideaId, parentRef: units[0]!.localRef! })),
  (error: unknown) => error instanceof AmuxNodeParentResolutionError &&
    error.code === "integrity_unavailable",
  "a weaker transaction must not resolve an approval parent");
  await assert.rejects(prisma.$transaction((tx) =>
    resolveApprovedAmuxEpicParent(tx, session,
      { ideaId, parentRef: units[1]!.localRef! })),
  (error: unknown) => error instanceof AmuxNodeParentResolutionError &&
    error.code === "integrity_unavailable");
  await assert.rejects(prisma.$transaction(async (tx) => {
    await assert.rejects(resolveApprovedAmuxRootParent(tx, session,
      { ideaId, parentRef: "not-a-node-ref" }),
    (error: unknown) => error instanceof AmuxNodeParentResolutionError &&
      error.code === "not_ready");
    await assert.rejects(resolveApprovedAmuxRootParent(tx, session,
      { ideaId, parentRef: units[0]!.localRef! }),
    (error: unknown) => error instanceof AmuxNodeParentResolutionError &&
      error.code === "not_ready");
    await assert.rejects(commitAmuxEpicNodePrepare(tx, { session, request,
      choice: { ideaId, draftUnitId: units[1]!.id,
        decisionId: randomUUID(), prepareRequestId: randomUUID(),
        nodeId: randomUUID(), reason: "" }, keys }),
    (error: unknown) => error instanceof AmuxNodeCreateError &&
      error.code === "not_ready", "Epic cannot precede its Initiative approval");
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
    await assert.rejects(resolveApprovedAmuxEpicParent(tx, session,
      { ideaId, parentRef: units[0]!.localRef! }),
    (error: unknown) => error instanceof AmuxNodeParentResolutionError &&
      error.code === "not_ready", "an Initiative is not an Epic parent");
    await assert.rejects(resolveApprovedAmuxRootParent(tx, session,
      { ideaId, parentRef: units[1]!.localRef! }),
    (error: unknown) => error instanceof AmuxNodeParentResolutionError &&
      error.code === "not_ready");
    await assert.rejects(resolveApprovedAmuxEpicParent(tx, session,
      { ideaId, parentRef: units[1]!.localRef! }),
    (error: unknown) => error instanceof AmuxNodeParentResolutionError &&
      error.code === "not_ready");
    await assert.rejects(commitAmuxFeatureNodePrepare(tx,
      { session, request, choice: { ideaId, draftUnitId: units[2]!.id,
        decisionId: randomUUID(), prepareRequestId: randomUUID(),
        nodeId: randomUUID(), reason: "" }, keys }),
    (error: unknown) => error instanceof AmuxNodeCreateError &&
      error.code === "not_ready", "Feature cannot precede Epic approval");
    const epicChoice = { ideaId, draftUnitId: units[1]!.id,
      decisionId: randomUUID(), prepareRequestId: randomUUID(),
      nodeId: randomUUID(), reason: "" };
    await assert.rejects(commitAmuxRootNodePrepare(tx,
      { session, request, choice: epicChoice, keys }),
    (error: unknown) => error instanceof AmuxNodeCreateError &&
      error.code === "not_ready", "root writer refuses Epic units");
    const epicPrepared = await commitAmuxEpicNodePrepare(tx,
      { session, request, choice: epicChoice, keys });
    const epicDecision = await tx.amuxIdeaUnitDecision.findUniqueOrThrow({
      where: { id: epicChoice.decisionId },
    });
    assert.equal(epicDecision.baseNodeId, rootChoice.nodeId);
    assert.equal(epicDecision.baseNodeRevision, 0);
    assert.equal(epicDecision.baseNodeDigest, node.contentDigest);
    assert.equal((await readAmuxRootNodeDecisionInTransaction(tx, session,
      epicChoice.decisionId, epicChoice.prepareRequestId)).state,
    "not_visible", "the Initiative route cannot inspect an Epic decision");
    assert.equal((await readAmuxRootNodeDecisionInTransaction(tx, session,
      epicChoice.decisionId, epicChoice.prepareRequestId, "epic")).state, "prepared");
    await assert.rejects(commitAmuxEpicNodeConsume(tx, { session, request,
      choice: { ...epicChoice, consumeRequestId: randomUUID(),
        confirmationDigest: randomBytes(32).toString("hex") }, keys }),
    (error: unknown) => error instanceof AmuxNodeCreateError &&
      error.code === "reconfirm");
    const epicCreated = await commitAmuxEpicNodeConsume(tx,
      { session, request, choice: { ...epicChoice,
        consumeRequestId: randomUUID(),
        confirmationDigest: epicPrepared.confirmationDigest }, keys });
    assert.equal(epicCreated.state, "created");
    const epicNode = await tx.amuxPortfolioNode.findUniqueOrThrow({
      where: { id: epicChoice.nodeId },
    });
    const epicRevision = await tx.amuxPortfolioNodeRevision.findFirstOrThrow({
      where: { nodeId: epicChoice.nodeId },
    });
    assert.equal(epicNode.level, "epic");
    assert.equal(epicNode.parentId, rootChoice.nodeId);
    assert.equal(epicRevision.parentIdAtApproval, rootChoice.nodeId);
    await assert.rejects(resolveApprovedAmuxRootParent(tx, session,
      { ideaId, parentRef: units[1]!.localRef! }),
    (error: unknown) => error instanceof AmuxNodeParentResolutionError &&
      error.code === "not_ready", "an Epic is not an Initiative parent");
    assert.equal((await readAmuxRootNodeDecisionInTransaction(tx, session,
      epicChoice.decisionId, epicChoice.prepareRequestId, "epic")).state, "created");
    const featureParents = await resolveApprovedAmuxEpicParent(tx, session,
      { ideaId, parentRef: units[1]!.localRef! });
    assert.deepEqual(featureParents.hierarchy.map((entry) => entry.id),
      [rootChoice.nodeId, epicChoice.nodeId]);
    assert.equal(featureParents.parent.content.digest, epicNode.contentDigest);
    const featureChoice = { ideaId, draftUnitId: units[2]!.id,
      decisionId: randomUUID(), prepareRequestId: randomUUID(),
      nodeId: randomUUID(), reason: "" };
    await assert.rejects(commitAmuxEpicNodePrepare(tx,
      { session, request, choice: featureChoice, keys }),
    (error: unknown) => error instanceof AmuxNodeCreateError &&
      error.code === "not_ready", "Epic writer refuses Feature units");
    const featurePrepared = await commitAmuxFeatureNodePrepare(tx,
      { session, request, choice: featureChoice, keys });
    const featureDecision = await tx.amuxIdeaUnitDecision.findUniqueOrThrow({
      where: { id: featureChoice.decisionId },
    });
    assert.equal(featureDecision.baseNodeId, epicChoice.nodeId);
    assert.equal(featureDecision.baseNodeDigest, epicNode.contentDigest);
    assert.equal((await readAmuxRootNodeDecisionInTransaction(tx, session,
      featureChoice.decisionId, featureChoice.prepareRequestId, "feature")).state,
    "prepared");
    const featureCreated = await commitAmuxFeatureNodeConsume(tx,
      { session, request, choice: { ...featureChoice,
        consumeRequestId: randomUUID(),
        confirmationDigest: featurePrepared.confirmationDigest }, keys });
    assert.equal(featureCreated.state, "created");
    const featureNode = await tx.amuxPortfolioNode.findUniqueOrThrow({
      where: { id: featureChoice.nodeId },
    });
    assert.equal(featureNode.level, "feature");
    assert.equal(featureNode.parentId, epicChoice.nodeId);
    assert.equal((await readAmuxRootNodeDecisionInTransaction(tx, session,
      featureChoice.decisionId, featureChoice.prepareRequestId, "feature")).state,
    "created");
    await assert.rejects(resolveApprovedAmuxEpicParent(tx,
      { ...session, user: { ...session.user, id: randomUUID() } } as Session,
      { ideaId, parentRef: units[1]!.localRef! }),
    (error: unknown) => error instanceof AmuxNodeParentResolutionError &&
      error.code === "not_found");
    await assert.rejects(resolveApprovedAmuxRootParent(tx,
      { ...session, user: { ...session.user, id: randomUUID() } } as Session,
      { ideaId, parentRef: unit.localRef! }),
    (error: unknown) => error instanceof AmuxNodeParentResolutionError &&
      error.code === "not_found");
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

for (const level of ["epic", "feature"] as const) {
test(`an uncertain ${level} consume freezes until owner-confirmed no-commit`, async () => {
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
    { holdId, outcome: "verified_success", inputTokens: 100, outputTokens: 50 }));
  await prisma.$transaction((tx) => commitAmuxFirstIdeaAnalysisDraft(tx, {
    ideaId, previewId, holdId, leaseGeneration: 1, keys,
    rawModelOutput: JSON.stringify({ schemaVersion: 2, previewId,
      chunkIndex: 0, outcome: "propose", coverageStatus: "complete",
      continuationKind: null, ownerQuestion: null,
      coveredScope: "Synthetic hierarchy recovery.", remainingScope: null,
      units: [
        { kind: "node", localId: "c0:node-0", level: "initiative",
          parentRef: null, title: "Recovery Initiative",
          description: "Synthetic root.", sourceRefIds: ["operator_idea"] },
        { kind: "node", localId: "c0:node-1", level: "epic",
          parentRef: "c0:node-0", title: "Recovery Epic",
          description: "Synthetic child.", sourceRefIds: ["operator_idea"] },
        { kind: "node", localId: "c0:node-2", level: "feature",
          parentRef: "c0:node-1", title: "Recovery Feature",
          description: "Synthetic leaf.", sourceRefIds: ["operator_idea"] },
      ],
    }),
  }));
  const units = await prisma.amuxIdeaDraftUnit.findMany({
    where: { ideaId }, orderBy: { unitIndex: "asc" },
  });
  const rootChoice = { ideaId, draftUnitId: units[0]!.id,
    decisionId: randomUUID(), prepareRequestId: randomUUID(),
    nodeId: randomUUID(), reason: "" };
  const epicChoice = { ideaId, draftUnitId: units[1]!.id,
    decisionId: randomUUID(), prepareRequestId: randomUUID(),
    nodeId: randomUUID(), reason: "" };
  const featureChoice = { ideaId, draftUnitId: units[2]!.id,
    decisionId: randomUUID(), prepareRequestId: randomUUID(),
    nodeId: randomUUID(), reason: "" };
  await assert.rejects(prisma.$transaction(async (tx) => {
    const rootPrepared = await commitAmuxRootNodePrepare(tx,
      { session, request, choice: rootChoice, keys });
    await commitAmuxRootNodeConsume(tx, { session, request,
      choice: { ...rootChoice, consumeRequestId: randomUUID(),
        confirmationDigest: rootPrepared.confirmationDigest }, keys });
    const epicPrepared = await commitAmuxEpicNodePrepare(tx,
      { session, request, choice: epicChoice, keys });
    if (level === "feature") {
      await commitAmuxEpicNodeConsume(tx, { session, request,
        choice: { ...epicChoice, consumeRequestId: randomUUID(),
          confirmationDigest: epicPrepared.confirmationDigest }, keys });
      await commitAmuxFeatureNodePrepare(tx,
        { session, request, choice: featureChoice, keys });
    }
    const target = level === "epic" ? epicChoice : featureChoice;
    const consumeRequestId = randomUUID();
    assert.equal(await commitAmuxRootNodeUnknown(tx, { actorUserId,
      decisionId: target.decisionId,
      prepareRequestId: target.prepareRequestId,
      consumeRequestId }), true);
    assert.equal((await readAmuxRootNodeDecisionInTransaction(tx, session,
      target.decisionId, target.prepareRequestId, level)).state,
    "outcome_unknown");
    const confirmed = await commitAmuxRootNodeNoCommitConfirmed(tx,
      { session, request, decisionId: target.decisionId,
        prepareRequestId: target.prepareRequestId }, level);
    assert.equal(confirmed.state, "no_commit_confirmed");
    assert.equal((await readAmuxRootNodeDecisionInTransaction(tx, session,
      target.decisionId, target.prepareRequestId, level)).state,
    "no_commit_confirmed");
    assert.equal(await tx.amuxPortfolioNode.count({
      where: { id: target.nodeId } }), 0);
    throw new Error("rollback synthetic node no-commit recovery");
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 5_000, timeout: 30_000 }),
  /rollback synthetic node no-commit recovery/);
  assert.equal(await prisma.amuxPortfolioNode.count({
    where: { id: rootChoice.nodeId } }), 0);
});
}

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

test("unknown result blocks claims until owner consumes full reservation", async () => {
  const { claim, previewId, holdId, selectedModelId,
    frontierApprovalId } = await syntheticFirstClaim();
  const nextPreviewId = await confirmedPreviewId(selectedModelId, frontierApprovalId);
  const firstHold = await prisma.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({
    where: { id: holdId }, select: { priceVersionId: true },
  });
  assert.ok(firstHold.priceVersionId);
  await prisma.$transaction((tx) => commitAmuxIdeaAnalysisBudgetReservation(tx,
    { holdId: randomUUID(), previewId: nextPreviewId,
      priceVersionId: firstHold.priceVersionId!, runner, keys }));
  const requestId = randomUUID();
  const unknown = await prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisResult(tx, { requestId, ideaId: claim.ideaId,
      previewId, holdId, leaseGeneration: 1,
      outcome: "outcome_unknown", rawModelOutput: null,
      inputTokens: null, outputTokens: null, keys }));
  assert.equal(unknown.state, "outcome_unknown");
  assert.equal((await prisma.$transaction((tx) =>
    readAmuxIdeaAnalysisResultReceipt(tx, { requestId, previewId }))).status,
  "committed");
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxIdeaOnlyAnalysisClaim(tx, { requestId: randomUUID(), previewId: nextPreviewId, keys })),
  (error: unknown) => error instanceof AmuxIdeaAnalysisClaimError &&
    error.code === "not_ready");
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisUnknownResolution(tx, { session, request,
      holdId, previewId, runnerStopped: true, readBackChecked: true })),
  (error: unknown) => error instanceof AmuxIdeaAnalysisUnknownResolutionError &&
    error.code === "not_resolvable", "the runner deadline must pass first");
  await prisma.amuxIdeaAnalysisBudgetHold.update({ where: { id: holdId },
    data: { dispatchedAt: new Date(Date.now() - 12 * 60_000) } });
  const before = await prisma.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
    where: { namespace_monthStart: { namespace, monthStart } },
  });
  const resolution = await prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisUnknownResolution(tx, { session, request,
      holdId, previewId, runnerStopped: true, readBackChecked: true }));
  assert.equal(resolution.holdId, holdId);
  const after = await prisma.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
    where: { namespace_monthStart: { namespace, monthStart } },
  });
  const closed = await prisma.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({
    where: { id: holdId },
  });
  assert.equal(closed.status, "owner_consumed");
  assert.equal(closed.settledMicroUsd, closed.reservedMicroUsd);
  assert.equal(closed.inputTokens, null);
  assert.equal(after.reservedMicroUsd,
    before.reservedMicroUsd - closed.reservedMicroUsd);
  assert.equal(after.spentMicroUsd,
    before.spentMicroUsd + closed.reservedMicroUsd);
  assert.equal(await prisma.amuxIdeaAnalysisBudgetHold.count({
    where: { namespace, status: "outcome_unknown" } }), 0);
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisUnknownResolution(tx, { session, request,
      holdId, previewId, runnerStopped: true, readBackChecked: true })),
  (error: unknown) => error instanceof AmuxIdeaAnalysisUnknownResolutionError &&
    error.code === "not_resolvable", "owner resolution is one-time");
});

test("a lost result POST can be conservatively closed after its hard deadline", async () => {
  const { previewId, holdId } = await syntheticFirstClaim();
  await prisma.amuxIdeaAnalysisBudgetHold.update({ where: { id: holdId },
    data: { dispatchedAt: new Date(Date.now() - 12 * 60_000) } });
  const result = await prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisUnknownResolution(tx, { session, request,
      holdId, previewId, runnerStopped: true, readBackChecked: true }));
  assert.equal(result.holdId, holdId);
  const [hold, preview] = await Promise.all([
    prisma.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({ where: { id: holdId } }),
    prisma.amuxIdeaTransferPreview.findUniqueOrThrow({ where: { id: previewId } }),
  ]);
  assert.equal(hold.status, "owner_consumed");
  assert.equal(hold.settledMicroUsd, hold.reservedMicroUsd);
  assert.equal(preview.state, "owner_rejected");
  assert.ok(preview.outcomeUnknownAt);
});
