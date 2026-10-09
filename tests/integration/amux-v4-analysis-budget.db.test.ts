import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";

import type { Session } from "next-auth";
import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { auditRowActorKind,
  AMUX_V4_ANALYSIS_BUDGET_EXPIRE_SCOPE,
  AMUX_V4_ANALYSIS_BUDGET_SETTLE_SCOPE,
  AMUX_V4_ANALYSIS_CLAIM_ACTION,
  AMUX_V4_ANALYSIS_OUTCOME_UNKNOWN_SCOPE,
  AMUX_V4_FIRST_DRAFT_SAVED_ACTION,
  AMUX_V4_FIRST_DRAFT_SAVED_SCOPE,
  AMUX_V4_FIRST_DRAFT_SAVED_TARGET,
  AMUX_V4_IDEA_AUTO_CANCEL_ACTION,
  AMUX_V4_IDEA_AUTO_CANCEL_TARGET,
  AMUX_V4_IDEA_SYSTEM_ACTOR } from "@/lib/adminAuditSystemActors";
import { isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { commitFrontierCatalogDecision } from "@/lib/amux/ideaFrontierCatalogWrite";
import { inspectFrontierCatalogWrite } from "@/lib/amux/ideaFrontierCatalogWriteCore";
import { inspectAmuxIdeaSubmission } from "@/lib/amux/ideaSubmissionCore";
import { commitIdeaSubmission } from "@/lib/amux/ideaSubmissionService";
import { commitInitialIdeaSourcePlan } from "@/lib/amux/ideaInitialSourcePlanAccess";
import { commitIdeaOnlyTransferPreview } from "@/lib/amux/ideaTransferPreviewService";
import { commitIdeaTransferConfirmation } from "@/lib/amux/ideaTransferConfirmationService";
import { commitAmuxIdeaAnalysisBudgetReservation as commitReservationWithOwnerAudit,
  AmuxIdeaAnalysisReservationError } from "@/lib/amux/ideaAnalysisBudgetReservationService";
import { listAmuxV4AnalysisCandidates } from "@/lib/amux/ideaAnalysisQueueService";
import { commitAmuxIdeaOnlyAnalysisClaim,
  enforceAmuxV4DailyClaimLimit,
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
import { commitAmuxIdeaAnalysisClaimResolution,
  readAmuxIdeaAnalysisClaimResolution,
  readAmuxIdeaAnalysisClaimResolutionReceipt,
  AmuxIdeaAnalysisClaimResolutionError } from
  "@/lib/amux/ideaAnalysisClaimResolutionService";
import { commitAmuxFirstIdeaAnalysisDraft,
  AmuxFirstAnalysisDraftError } from "@/lib/amux/ideaFirstAnalysisDraftService";
import { readAmuxFirstIdeaAnalysisResult,
  AmuxIdeaAnalysisResultReadError } from "@/lib/amux/ideaAnalysisResultReadService";
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
// This lane shares one database with the Frontier catalog suite. Both must
// verify the same append-only approval evidence with the same synthetic key.
process.env.ADMIN_AUDIT_INTEGRITY_KEY =
  "synthetic-amux-v4-frontier-catalog-audit-key-2026";
const session = { user: { id: actorUserId, email: actorEmail,
  authenticatedAt: new Date().toISOString() },
expires: new Date(Date.now() + 60 * 60_000).toISOString() } as Session;
const request = new Request("https://tomverse.test/api/admin/amux/ideas/submissions",
  { method: "POST" });
const commitAmuxIdeaAnalysisBudgetReservation = (
  tx: Prisma.TransactionClient,
  input: Omit<Parameters<typeof commitReservationWithOwnerAudit>[1],
    "session" | "request">,
) => commitReservationWithOwnerAudit(tx, { ...input, session, request });
const keys = { masterKeyId: "synthetic-master", masterKeyVersion: 1,
  masterKey: randomBytes(32), digestKeyId: "synthetic-digest", digestKey: randomBytes(32) };
const browserNonce = randomBytes(32).toString("base64url");
process.env.AMUX_V4_CONTENT_MASTER_KEY_ID = keys.masterKeyId;
process.env.AMUX_V4_CONTENT_MASTER_KEY_VERSION = String(keys.masterKeyVersion);
process.env.AMUX_V4_CONTENT_MASTER_KEY_B64 = keys.masterKey.toString("base64");
process.env.AMUX_V4_CONTENT_DIGEST_KEY_ID = keys.digestKeyId;
process.env.AMUX_V4_CONTENT_DIGEST_KEY_B64 = keys.digestKey.toString("base64");

after(async () => { await prisma.$disconnect(); });

test("daily claim key is the database UTC date regardless of process or session timezone", async () => {
  const priorTz = process.env.TZ;
  try {
    process.env.TZ = "Pacific/Auckland";
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL TIME ZONE 'Pacific/Auckland'`;
      const expected = await tx.$queryRaw<Array<{ dayUtc: string }>>`
        SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD')
          AS "dayUtc"
      `;
      assert.equal(await enforceAmuxV4DailyClaimLimit(tx), expected[0]?.dayUtc);
    });
  } finally {
    if (priorTz === undefined) delete process.env.TZ;
    else process.env.TZ = priorTz;
  }
});

async function confirmedPreviewId(modelId: string,
  frontierApprovalId = randomUUID()): Promise<string> {
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
    approvalId: frontierApprovalId, approvalVersion: 1 };
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
  const ownerAudit = await prisma.adminAuditLog.findFirstOrThrow({ where: {
    action: "amux.v4.analysis_budget.reserved",
    targetType: "AmuxIdeaAnalysisBudgetHold", targetId: holdId,
    actorUserId,
  } });
  assert.equal((ownerAudit.metadata as Record<string, unknown>).systemAuditId,
    result.auditId);
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
  const claim = await prisma.$transaction((tx) =>
    commitAmuxIdeaOnlyAnalysisClaim(tx, { requestId: randomUUID(), previewId, keys }));
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

async function syntheticFirstClaim() {
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
  const claim = await prisma.$transaction((tx) =>
    commitAmuxIdeaOnlyAnalysisClaim(tx, { requestId: randomUUID(), previewId, keys }));
  return { claim, previewId, holdId, selectedModelId, frontierApprovalId };
}

async function syntheticFirstClaimInTransaction(tx: Prisma.TransactionClient) {
  const selectedModelId = modelId();
  const frontierApprovalId = randomUUID();
  const frontier = inspectFrontierCatalogWrite(JSON.stringify({ schemaVersion: 1,
    action: "approve", approvalId: frontierApprovalId, provider: "openai",
    modelId: selectedModelId, allowedEfforts: ["high"],
    expectedPreviousVersion: 0, ownerConfirmedFrontierEligibility: true }));
  assert.equal(frontier.ok, true);
  if (!frontier.ok) throw new Error("synthetic frontier request invalid");
  await commitFrontierCatalogDecision(tx,
    { session, request, decision: frontier.request });

  const ideaId = randomUUID();
  const inspected = inspectAmuxIdeaSubmission(JSON.stringify({
    version: 1, requestId: randomUUID(), input: { version: 1,
      idea: `SYNTHETIC_BUDGET_${randomUUID()}`, repositories: [], pullRequests: [] },
  }));
  if (!inspected.ok) throw new Error(inspected.code);
  await commitIdeaSubmission(tx, { session, request, inspected, ideaId, keys });
  await commitInitialIdeaSourcePlan(tx, { session, request, ideaId, keys });
  const choice = { previewId: randomUUID(), ideaId, provider: "openai" as const,
    modelId: selectedModelId, reasoningEffort: "high" as const,
    approvalId: frontierApprovalId, approvalVersion: 1 };
  const prepared = await commitIdeaOnlyTransferPreview(tx,
    { session, request, choice, keys, browserNonce });
  await commitIdeaTransferConfirmation(tx,
    { session, request, choice: { previewId: choice.previewId, ideaId,
      payloadDigest: prepared.payloadDigest,
      payloadDigestKeyId: prepared.payloadDigestKeyId }, browserNonce, keys });

  const priceVersionId = randomUUID();
  const priceApproval = { id: priceVersionId, provider: "openai" as const,
    modelId: selectedModelId, mode: "subscription_cli" as const,
    expectedPreviousVersion: 0, inputTokensCap: 1_000, outputTokensCap: 2_000,
    inputMicroUsdPerMillion: 1_000_000,
    outputMicroUsdPerMillion: 2_000_000,
    evidenceDigest: randomBytes(32).toString("hex"),
    ownerConfirmedWorstTier: true as const,
    verifiedAt: new Date(Date.now() - 24 * 60 * 60_000),
    expiresAt: new Date(Date.now() + 24 * 60 * 60_000) };
  await commitAmuxIdeaAnalysisPriceApproval(tx,
    { session, request, approval: priceApproval });
  await tx.amuxIdeaAnalysisBudgetWindow.upsert({
    where: { namespace_monthStart: { namespace, monthStart } },
    create: { namespace, monthStart, limitMicroUsd: BigInt(50_000_000) },
    update: {},
  });
  const holdId = randomUUID();
  await commitAmuxIdeaAnalysisBudgetReservation(tx,
    { holdId, previewId: choice.previewId, priceVersionId, runner, keys });
  const claim = await commitAmuxIdeaOnlyAnalysisClaim(tx,
    { requestId: randomUUID(), previewId: choice.previewId, keys });
  return { claim, previewId: choice.previewId, holdId };
}

async function simulateClaimedIdeaDeadlineCancellation(
  tx: Prisma.TransactionClient, ideaId: string,
) {
  await takeAuditChainLock(tx);
  const idea = await tx.amuxIdeaSubmission.findUniqueOrThrow({
    where: { id: ideaId },
  });
  if (idea.state !== "analyzing" || idea.cancelledAt !== null ||
      idea.analysisCompletedAt !== null || !(idea.rawPurgeAfter instanceof Date)) {
    throw new Error("invalid synthetic claimed cancellation fixture");
  }
  // Exercise the real post-canceller database shape without waiting seven days.
  // The immutable deadline remains the cancellation anchor.
  const cancelledAt = idea.analysisDeadlineAt;
  const auditId = await writeSystemAuditLog({ tx,
    systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
    action: AMUX_V4_IDEA_AUTO_CANCEL_ACTION,
    targetType: AMUX_V4_IDEA_AUTO_CANCEL_TARGET,
    targetId: idea.id,
    summary: "Stopped an unfinished AMUX v4 idea analysis at its seven-day deadline.",
    metadata: { submittedAt: idea.submittedAt.toISOString(),
      analysisDeadlineAt: idea.analysisDeadlineAt.toISOString(),
      rawPurgeAfter: idea.rawPurgeAfter.toISOString() },
  });
  const updated = await tx.amuxIdeaSubmission.updateMany({ where: {
    id: idea.id, state: "analyzing", analysisCompletedAt: null, cancelledAt: null,
  }, data: { state: "cancelled", cancelledAt } });
  if (updated.count !== 1) {
    throw new Error("synthetic claimed cancellation fixture raced");
  }
  return { auditId, cancelledAt, analysisDeadlineAt: idea.analysisDeadlineAt,
    rawPurgeAfter: idea.rawPurgeAfter };
}

test("owner proof of non-execution releases a claimed hold as zero and fences late results", async () => {
  const { claim, previewId, holdId, selectedModelId,
    frontierApprovalId } = await syntheticFirstClaim();
  const before = await prisma.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
    where: { namespace_monthStart: { namespace, monthStart } },
  });
  const readback = await prisma.$transaction((tx) =>
    readAmuxIdeaAnalysisClaimResolution(tx, { session, holdId }));
  assert.equal(readback.holdStatus, "in_flight");
  assert.equal(readback.claimRequestId.length > 0, true);
  const resolutionRequestId = randomUUID();
  const input = { session, request, resolutionRequestId, holdId,
    readbackDigest: readback.readbackDigest,
    evidenceDigest: randomBytes(32).toString("hex"),
    disposition: "not_started_proven" as const };
  const closed = await prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisClaimResolution(tx, input));
  assert.deepEqual([closed.settledMicroUsd, closed.releasedMicroUsd, closed.duplicate],
    ["0", readback.reservedMicroUsd, false]);
  const [hold, preview, chunk, idea, after, receipt] = await Promise.all([
    prisma.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({ where: { id: holdId } }),
    prisma.amuxIdeaTransferPreview.findUniqueOrThrow({ where: { id: previewId } }),
    prisma.amuxIdeaAnalysisChunk.findUniqueOrThrow({ where: {
      ideaId_chunkIndex: { ideaId: claim.ideaId, chunkIndex: 0 } } }),
    prisma.amuxIdeaSubmission.findUniqueOrThrow({ where: { id: claim.ideaId } }),
    prisma.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
      where: { namespace_monthStart: { namespace, monthStart } } }),
    prisma.$transaction((tx) => readAmuxIdeaAnalysisClaimResolutionReceipt(tx,
      { session, resolutionRequestId })),
  ]);
  assert.deepEqual([hold.status, hold.settledMicroUsd, preview.state,
    chunk.state, chunk.leaseGeneration, idea.state],
  ["owner_released_unstarted", BigInt(0), "owner_resolved",
    "awaiting_preview", 0, "submitted"]);
  assert.deepEqual(await readAmuxFirstIdeaAnalysisResult(session, claim.ideaId, keys),
    { state: "needs_new_preview" });
  assert.equal(after.reservedMicroUsd,
    before.reservedMicroUsd - BigInt(readback.reservedMicroUsd));
  assert.equal(after.spentMicroUsd, before.spentMicroUsd);
  assert.equal(receipt.status, "committed");
  assert.equal((await prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisClaimResolution(tx, input))).duplicate, true);
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisClaimResolution(tx, { ...input,
      evidenceDigest: randomBytes(32).toString("hex") })),
  (error: unknown) => error instanceof AmuxIdeaAnalysisClaimResolutionError &&
    error.code === "conflict");
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisResult(tx, { requestId: randomUUID(),
      ideaId: claim.ideaId, previewId, holdId, leaseGeneration: 1,
      outcome: "invocation_failed", rawModelOutput: null,
      inputTokens: 0, outputTokens: 0, keys })),
  (error: unknown) => error instanceof AmuxIdeaAnalysisResultError &&
    error.code === "not_ready");
  const nextPreviewId = randomUUID();
  const prepared = await prisma.$transaction((tx) => commitIdeaOnlyTransferPreview(tx,
    { session, request, choice: { previewId: nextPreviewId, ideaId: claim.ideaId,
      provider: "openai", modelId: selectedModelId, reasoningEffort: "high",
      approvalId: frontierApprovalId, approvalVersion: 1 }, keys, browserNonce }));
  assert.equal(prepared.previewId, nextPreviewId,
    "resolution returns only to the owner preview boundary, never blind dispatch");
});

test("insufficient evidence consumes the full reported-unknown reservation", async () => {
  const { claim, previewId, holdId } = await syntheticFirstClaim();
  await prisma.$transaction((tx) => commitAmuxIdeaAnalysisResult(tx, {
    requestId: randomUUID(), ideaId: claim.ideaId, previewId, holdId,
    leaseGeneration: 1, outcome: "outcome_unknown", rawModelOutput: null,
    inputTokens: null, outputTokens: null, keys,
  }));
  const before = await prisma.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
    where: { namespace_monthStart: { namespace, monthStart } },
  });
  const readback = await prisma.$transaction((tx) =>
    readAmuxIdeaAnalysisClaimResolution(tx, { session, holdId }));
  assert.equal(readback.holdStatus, "outcome_unknown");
  assert.ok(readback.resultRequestId);
  assert.deepEqual([readback.resultOutcome, readback.resultEffectiveOutcome,
    readback.resultFailureReason, readback.zeroReleaseEligible],
  ["outcome_unknown", "outcome_unknown", null, false]);
  const evidenceDigest = randomBytes(32).toString("hex");
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisClaimResolution(tx, { session, request,
      resolutionRequestId: randomUUID(), holdId,
      readbackDigest: readback.readbackDigest, evidenceDigest,
      disposition: "not_started_proven" })),
  (error: unknown) => error instanceof AmuxIdeaAnalysisClaimResolutionError &&
    error.code === "not_resolvable");
  const closed = await prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisClaimResolution(tx, { session, request,
      resolutionRequestId: randomUUID(), holdId,
      readbackDigest: readback.readbackDigest,
      evidenceDigest,
      disposition: "evidence_insufficient" }));
  assert.deepEqual([closed.settledMicroUsd, closed.releasedMicroUsd],
    [readback.reservedMicroUsd, "0"]);
  const [hold, window] = await Promise.all([
    prisma.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({ where: { id: holdId } }),
    prisma.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
      where: { namespace_monthStart: { namespace, monthStart } } }),
  ]);
  assert.equal(hold.status, "owner_consumed");
  assert.equal(window.reservedMicroUsd,
    before.reservedMicroUsd - BigInt(readback.reservedMicroUsd));
  assert.equal(window.spentMicroUsd,
    before.spentMicroUsd + BigInt(readback.reservedMicroUsd));
});

test("a usage-unverified receipt forbids zero release and consumes the full reservation", async () => {
  const { claim, previewId, holdId } = await syntheticFirstClaim();
  const rawModelOutput = JSON.stringify({ schemaVersion: 2, previewId,
    chunkIndex: 0, outcome: "reject", coverageStatus: "complete",
    continuationKind: null, ownerQuestion: null,
    coveredScope: "The synthetic idea was reviewed.", remainingScope: null,
    units: [] });
  await prisma.$transaction((tx) => commitAmuxIdeaAnalysisResult(tx, {
    requestId: randomUUID(), ideaId: claim.ideaId, previewId, holdId,
    leaseGeneration: 1, outcome: "verified_success", rawModelOutput,
    inputTokens: 1_000_001, outputTokens: 0, keys,
  }));
  const before = await prisma.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
    where: { namespace_monthStart: { namespace, monthStart } },
  });
  const readback = await prisma.$transaction((tx) =>
    readAmuxIdeaAnalysisClaimResolution(tx, { session, holdId }));
  assert.equal(readback.holdStatus, "outcome_unknown");
  assert.ok(readback.resultRequestId);
  assert.deepEqual([readback.resultOutcome, readback.resultEffectiveOutcome,
    readback.resultFailureReason, readback.zeroReleaseEligible],
  ["verified_success", "outcome_unknown", "usage_unverified", false]);
  const evidenceDigest = randomBytes(32).toString("hex");
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisClaimResolution(tx, { session, request,
      resolutionRequestId: randomUUID(), holdId,
      readbackDigest: readback.readbackDigest, evidenceDigest,
      disposition: "not_started_proven" })),
  (error: unknown) => error instanceof AmuxIdeaAnalysisClaimResolutionError &&
    error.code === "not_resolvable");
  const afterRefusal = await prisma.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
    where: { namespace_monthStart: { namespace, monthStart } },
  });
  assert.deepEqual([afterRefusal.reservedMicroUsd, afterRefusal.spentMicroUsd],
    [before.reservedMicroUsd, before.spentMicroUsd]);
  assert.equal(await prisma.adminAuditLog.count({ where: {
    action: "amux.v4.analysis_claim.owner_resolved", targetId: holdId,
  } }), 0);
  const closed = await prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisClaimResolution(tx, { session, request,
      resolutionRequestId: randomUUID(), holdId,
      readbackDigest: readback.readbackDigest,
      evidenceDigest,
      disposition: "evidence_insufficient" }));
  assert.deepEqual([closed.settledMicroUsd, closed.releasedMicroUsd],
    [readback.reservedMicroUsd, "0"]);
  const [hold, window] = await Promise.all([
    prisma.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({ where: { id: holdId } }),
    prisma.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
      where: { namespace_monthStart: { namespace, monthStart } } }),
  ]);
  assert.equal(hold.status, "owner_consumed");
  assert.equal(window.reservedMicroUsd,
    before.reservedMicroUsd - BigInt(readback.reservedMicroUsd));
  assert.equal(window.spentMicroUsd,
    before.spentMicroUsd + BigInt(readback.reservedMicroUsd));
});

test("a cancelled in-flight claim can release zero without reopening analysis", async () => {
  const claimCountBefore = await prisma.adminAuditLog.count({
    where: { action: AMUX_V4_ANALYSIS_CLAIM_ACTION },
  });
  const rollback = new Error("rollback cancelled in-flight claim fixture");
  await assert.rejects(prisma.$transaction(async (tx) => {
    const { claim, previewId, holdId } = await syntheticFirstClaimInTransaction(tx);
    const previewCount = await tx.amuxIdeaTransferPreview.count({
      where: { ideaId: claim.ideaId },
    });
    const cancellation = await simulateClaimedIdeaDeadlineCancellation(tx, claim.ideaId);
    const readback = await readAmuxIdeaAnalysisClaimResolution(tx, { session, holdId });
    assert.deepEqual([readback.ideaState, readback.ideaCancelledAt,
      readback.zeroReleaseEligible],
    ["cancelled", cancellation.cancelledAt.toISOString(), true]);
    const closed = await commitAmuxIdeaAnalysisClaimResolution(tx, { session, request,
      resolutionRequestId: randomUUID(), holdId,
      readbackDigest: readback.readbackDigest,
      evidenceDigest: randomBytes(32).toString("hex"),
      disposition: "not_started_proven" });
    assert.deepEqual([closed.settledMicroUsd, closed.releasedMicroUsd],
      ["0", readback.reservedMicroUsd]);
    const [idea, preview, chunk, hold, previewCountAfter] = await Promise.all([
      tx.amuxIdeaSubmission.findUniqueOrThrow({ where: { id: claim.ideaId } }),
      tx.amuxIdeaTransferPreview.findUniqueOrThrow({ where: { id: previewId } }),
      tx.amuxIdeaAnalysisChunk.findUniqueOrThrow({ where: {
        ideaId_chunkIndex: { ideaId: claim.ideaId, chunkIndex: 0 } } }),
      tx.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({ where: { id: holdId } }),
      tx.amuxIdeaTransferPreview.count({ where: { ideaId: claim.ideaId } }),
    ]);
    assert.deepEqual([idea.state, idea.cancelledAt?.toISOString(),
      idea.analysisDeadlineAt.toISOString(), idea.rawPurgeAfter?.toISOString()],
    ["cancelled", cancellation.cancelledAt.toISOString(),
      cancellation.analysisDeadlineAt.toISOString(),
      cancellation.rawPurgeAfter.toISOString()]);
    assert.deepEqual([preview.state, chunk.state, chunk.leaseGeneration,
      chunk.currentPreviewId, hold.status, previewCountAfter],
    ["in_flight", "in_flight", 1, previewId,
      "owner_released_unstarted", previewCount]);
    throw rollback;
  }, { timeout: 30_000 }), (error: unknown) => error === rollback);
  assert.equal(await prisma.adminAuditLog.count({
    where: { action: AMUX_V4_ANALYSIS_CLAIM_ACTION },
  }), claimCountBefore);
});

test("a cancelled unknown claim consumes the full reservation without reopening analysis", async () => {
  const claimCountBefore = await prisma.adminAuditLog.count({
    where: { action: AMUX_V4_ANALYSIS_CLAIM_ACTION },
  });
  const rollback = new Error("rollback cancelled unknown claim fixture");
  await assert.rejects(prisma.$transaction(async (tx) => {
    const { claim, previewId, holdId } = await syntheticFirstClaimInTransaction(tx);
    await commitAmuxIdeaAnalysisResult(tx, {
      requestId: randomUUID(), ideaId: claim.ideaId, previewId, holdId,
      leaseGeneration: 1, outcome: "outcome_unknown", rawModelOutput: null,
      inputTokens: null, outputTokens: null, keys,
    });
    const previewCount = await tx.amuxIdeaTransferPreview.count({
      where: { ideaId: claim.ideaId },
    });
    const cancellation = await simulateClaimedIdeaDeadlineCancellation(tx, claim.ideaId);
    const readback = await readAmuxIdeaAnalysisClaimResolution(tx, { session, holdId });
    assert.deepEqual([readback.ideaState, readback.ideaCancelledAt,
      readback.resultOutcome, readback.resultFailureReason,
      readback.zeroReleaseEligible],
    ["cancelled", cancellation.cancelledAt.toISOString(),
      "outcome_unknown", null, false]);
    const evidenceDigest = randomBytes(32).toString("hex");
    await assert.rejects(commitAmuxIdeaAnalysisClaimResolution(tx, { session, request,
      resolutionRequestId: randomUUID(), holdId,
      readbackDigest: readback.readbackDigest, evidenceDigest,
      disposition: "not_started_proven" }),
    (error: unknown) => error instanceof AmuxIdeaAnalysisClaimResolutionError &&
      error.code === "not_resolvable");
    const closed = await commitAmuxIdeaAnalysisClaimResolution(tx, { session, request,
      resolutionRequestId: randomUUID(), holdId,
      readbackDigest: readback.readbackDigest, evidenceDigest,
      disposition: "evidence_insufficient" });
    assert.deepEqual([closed.settledMicroUsd, closed.releasedMicroUsd],
      [readback.reservedMicroUsd, "0"]);
    const [idea, preview, chunk, hold, previewCountAfter] = await Promise.all([
      tx.amuxIdeaSubmission.findUniqueOrThrow({ where: { id: claim.ideaId } }),
      tx.amuxIdeaTransferPreview.findUniqueOrThrow({ where: { id: previewId } }),
      tx.amuxIdeaAnalysisChunk.findUniqueOrThrow({ where: {
        ideaId_chunkIndex: { ideaId: claim.ideaId, chunkIndex: 0 } } }),
      tx.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({ where: { id: holdId } }),
      tx.amuxIdeaTransferPreview.count({ where: { ideaId: claim.ideaId } }),
    ]);
    assert.deepEqual([idea.state, idea.cancelledAt?.toISOString(),
      idea.analysisDeadlineAt.toISOString(), idea.rawPurgeAfter?.toISOString()],
    ["cancelled", cancellation.cancelledAt.toISOString(),
      cancellation.analysisDeadlineAt.toISOString(),
      cancellation.rawPurgeAfter.toISOString()]);
    assert.deepEqual([preview.state, chunk.state, chunk.leaseGeneration,
      chunk.currentPreviewId, hold.status, previewCountAfter],
    ["outcome_unknown", "outcome_unknown", 1, previewId,
      "owner_consumed", previewCount]);
    throw rollback;
  }, { timeout: 30_000 }), (error: unknown) => error === rollback);
  assert.equal(await prisma.adminAuditLog.count({
    where: { action: AMUX_V4_ANALYSIS_CLAIM_ACTION },
  }), claimCountBefore);
});

test("seventeen idea-only cards remain three bounded pages without an idea-wide cap", async () => {
  const { claim, previewId, holdId, selectedModelId,
    frontierApprovalId } = await syntheticFirstClaim();
  const nodes = [
    { level: "initiative", parentRef: null },
    { level: "epic", parentRef: "c0:node-0" },
    { level: "feature", parentRef: "c0:node-1" },
  ].map((node, index) => ({ kind: "node", localId: `c0:node-${index}`,
    title: `Synthetic node ${index}`, description: "A bounded source proposal.",
    sourceRefIds: ["operator_idea"], ...node }));
  const cards = Array.from({ length: 8 }, (_, index) => ({
    kind: "card", localId: `c0:card-${index}`, cardType: "story",
    storyKind: "general", title: `Story ${index}`,
    problem: "The idea includes more than eight independent stories.",
    scopeIn: ["Review this story"], scopeOut: ["Do not execute"],
    completionCriteria: ["The owner can review the result"],
    featureRef: "c0:node-2", parentStoryRef: null, dependencyRefs: [],
    duplicateCandidateRefs: [], taskRole: null, executionGrade: null,
    executionBrief: null, sourceRefIds: ["operator_idea"],
  }));
  const rawModelOutput = JSON.stringify({ schemaVersion: 2, previewId,
    chunkIndex: 0, outcome: "propose", coverageStatus: "more",
    continuationKind: "output", ownerQuestion: null,
    coveredScope: "Eight independently reviewable stories were proposed.",
    remainingScope: "At least one further story remains from the same idea.",
    units: [...nodes, ...cards] });
  const saved = await prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisResult(tx, { requestId: randomUUID(),
      ideaId: claim.ideaId, previewId, holdId, leaseGeneration: 1,
      outcome: "verified_success", rawModelOutput,
      inputTokens: 100, outputTokens: 50, keys }));
  assert.equal(saved.state, "draft_ready");
  const [idea, first, next, preview, units] = await Promise.all([
    prisma.amuxIdeaSubmission.findUniqueOrThrow({ where: { id: claim.ideaId } }),
    prisma.amuxIdeaAnalysisChunk.findUniqueOrThrow({
      where: { ideaId_chunkIndex: { ideaId: claim.ideaId, chunkIndex: 0 } },
    }),
    prisma.amuxIdeaAnalysisChunk.findUniqueOrThrow({
      where: { ideaId_chunkIndex: { ideaId: claim.ideaId, chunkIndex: 1 } },
    }),
    prisma.amuxIdeaTransferPreview.findUniqueOrThrow({ where: { id: previewId } }),
    prisma.amuxIdeaDraftUnit.findMany({ where: { ideaId: claim.ideaId } }),
  ]);
  assert.equal(idea.state, "analyzing");
  assert.equal(idea.analysisCompletedAt, null);
  assert.deepEqual([first.coverageStatus, first.continuationKind,
    first.outputPending, first.remainingStartOrdinal],
  ["more", "output", true, 0]);
  assert.deepEqual([next.state, next.attempt, next.leaseGeneration,
    next.chunkIndex, next.revisionChunkIndex, next.currentPreviewId],
  ["pending", 0, 0, 1, 1, null]);
  assert.equal(next.sourcePlanRevisionId, first.sourcePlanRevisionId);
  assert.equal(preview.state, "completed");
  assert.equal(first.freeformPurgeAfter?.getTime(),
    idea.analysisDeadlineAt.getTime() + 24 * 60 * 60_000);
  assert.equal(preview.payloadPurgeAfter?.getTime(),
    idea.analysisDeadlineAt.getTime() + 24 * 60 * 60_000);
  assert.equal(units.length, 11);
  assert.equal(await prisma.amuxWorkItem.count({ where: {
    sourceSystem: "admin-idea-v4", sourceKey: claim.ideaId,
  } }), 0);
  const partial = await readAmuxFirstIdeaAnalysisResult(session, claim.ideaId, keys);
  assert.equal(partial.state, "partial");
  if (partial.state !== "partial") throw new Error("first page was not visible");
  assert.equal(partial.nextChunkIndex, 1);
  assert.match(partial.remainingScope ?? "", /further story/);

  const secondPreviewId = randomUUID();
  const continuation = await prisma.$transaction((tx) =>
    commitIdeaOnlyTransferPreview(tx, { session, request,
      choice: { previewId: secondPreviewId, ideaId: claim.ideaId,
        chunkIndex: 1, provider: "openai", modelId: selectedModelId,
        reasoningEffort: "high", approvalId: frontierApprovalId,
        approvalVersion: 1 }, keys, browserNonce }));
  assert.equal(continuation.payload.version, 2);
  assert.equal(continuation.payload.chunkIndex, 1);
  assert.match(continuation.payload.prompt, /At least one further story/);
  await prisma.$transaction((tx) => commitIdeaTransferConfirmation(tx,
    { session, request, choice: { previewId: secondPreviewId,
      ideaId: claim.ideaId, payloadDigest: continuation.payloadDigest,
      payloadDigestKeyId: continuation.payloadDigestKeyId }, browserNonce, keys }));
  const priorHold = await prisma.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({
    where: { id: holdId }, select: { priceVersionId: true },
  });
  await prisma.$transaction((tx) => commitAmuxIdeaAnalysisBudgetReservation(tx,
    { holdId: randomUUID(), previewId: secondPreviewId,
      priceVersionId: priorHold.priceVersionId!, runner, keys }));
  const nextClaim = await prisma.$transaction((tx) =>
    commitAmuxIdeaOnlyAnalysisClaim(tx,
      { requestId: randomUUID(), previewId: secondPreviewId, keys }));
  const nextEight = Array.from({ length: 8 }, (_, index) => ({
    kind: "card", localId: `c1:card-${index}`, cardType: "story",
    storyKind: "general", title: `Story ${index + 9}`,
    problem: "Another independently reviewable story remains.",
    scopeIn: ["Review this story"], scopeOut: ["Do not execute"],
    completionCriteria: ["The owner can review the result"],
    featureRef: "c0:node-2", parentStoryRef: null, dependencyRefs: [],
    duplicateCandidateRefs: [], taskRole: null, executionGrade: null,
    executionBrief: null, sourceRefIds: ["operator_idea"],
  }));
  const secondOutput = JSON.stringify({ schemaVersion: 2, previewId: secondPreviewId,
    chunkIndex: 1, outcome: "propose", coverageStatus: "more",
    continuationKind: "output", ownerQuestion: null,
    coveredScope: "Eight more independent stories were proposed.",
    remainingScope: "A seventeenth story remains from the same idea.",
    units: nextEight });
  const secondResult = await prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisResult(tx, { requestId: randomUUID(),
      ideaId: claim.ideaId, previewId: secondPreviewId,
      holdId: nextClaim.holdId, leaseGeneration: 1,
      outcome: "verified_success", rawModelOutput: secondOutput,
      inputTokens: 100, outputTokens: 50, keys }));
  assert.equal(secondResult.state, "draft_ready");
  const secondPage = await readAmuxFirstIdeaAnalysisResult(session, claim.ideaId,
    keys, 1);
  assert.equal(secondPage.state, "partial");
  if (secondPage.state !== "partial") throw new Error("second page was not visible");
  assert.equal(secondPage.nextChunkIndex, 2);

  const thirdPreviewId = randomUUID();
  const third = await prisma.$transaction((tx) =>
    commitIdeaOnlyTransferPreview(tx, { session, request,
      choice: { previewId: thirdPreviewId, ideaId: claim.ideaId,
        chunkIndex: 2, provider: "openai", modelId: selectedModelId,
        reasoningEffort: "high", approvalId: frontierApprovalId,
        approvalVersion: 1 }, keys, browserNonce }));
  assert.match(third.payload.prompt, /c0:node-2/);
  await prisma.$transaction((tx) => commitIdeaTransferConfirmation(tx,
    { session, request, choice: { previewId: thirdPreviewId,
      ideaId: claim.ideaId, payloadDigest: third.payloadDigest,
      payloadDigestKeyId: third.payloadDigestKeyId }, browserNonce, keys }));
  await prisma.$transaction((tx) => commitAmuxIdeaAnalysisBudgetReservation(tx,
    { holdId: randomUUID(), previewId: thirdPreviewId,
      priceVersionId: priorHold.priceVersionId!, runner, keys }));
  const thirdClaim = await prisma.$transaction((tx) =>
    commitAmuxIdeaOnlyAnalysisClaim(tx,
      { requestId: randomUUID(), previewId: thirdPreviewId, keys }));
  const finalOutput = JSON.stringify({ schemaVersion: 2, previewId: thirdPreviewId,
    chunkIndex: 2, outcome: "propose", coverageStatus: "complete",
    continuationKind: null, ownerQuestion: null,
    coveredScope: "The seventeenth story was proposed.",
    remainingScope: null, units: [{ ...nextEight[0], localId: "c2:card-0",
      title: "Story 17" }] });
  const finished = await prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisResult(tx, { requestId: randomUUID(),
      ideaId: claim.ideaId, previewId: thirdPreviewId,
      holdId: thirdClaim.holdId, leaseGeneration: 1,
      outcome: "verified_success", rawModelOutput: finalOutput,
      inputTokens: 100, outputTokens: 50, keys }));
  assert.equal(finished.state, "draft_ready");
  assert.equal((await prisma.amuxIdeaSubmission.findUniqueOrThrow({
    where: { id: claim.ideaId }, select: { state: true },
  })).state, "awaiting_owner");
  const finalPage = await readAmuxFirstIdeaAnalysisResult(session, claim.ideaId,
    keys, 2);
  assert.equal(finalPage.state, "ready");
  if (finalPage.state !== "ready") throw new Error("final page was not visible");
  assert.equal(finalPage.units.length, 1);
  assert.equal(await prisma.amuxIdeaDraftUnit.count({ where: {
    ideaId: claim.ideaId,
  } }), 20);
  const finishedIdea = await prisma.amuxIdeaSubmission.findUniqueOrThrow({
    where: { id: claim.ideaId }, select: { analysisCompletedAt: true },
  });
  assert.ok(finishedIdea.analysisCompletedAt);
  const finalPurgeDeadline = finishedIdea.analysisCompletedAt.getTime() +
    24 * 60 * 60_000;
  const retainedPages = await prisma.amuxIdeaAnalysisChunk.findMany({
    where: { ideaId: claim.ideaId }, select: { freeformPurgeAfter: true },
  });
  const retainedPayloads = await prisma.amuxIdeaTransferPreview.findMany({
    where: { ideaId: claim.ideaId }, select: { payloadPurgeAfter: true },
  });
  assert.equal(retainedPages.length, 3);
  assert.equal(retainedPayloads.length, 3);
  assert.ok(retainedPages.every((row) => row.freeformPurgeAfter &&
    row.freeformPurgeAfter.getTime() <= finalPurgeDeadline));
  assert.ok(retainedPayloads.every((row) => row.payloadPurgeAfter &&
    row.payloadPurgeAfter.getTime() <= finalPurgeDeadline));
});

test("a bounded owner question is saved as a pause, not a provider failure", async () => {
  const { claim, previewId, holdId } = await syntheticFirstClaim();
  const question = "Which existing Feature should this story belong to?";
  const rawModelOutput = JSON.stringify({ schemaVersion: 2, previewId,
    chunkIndex: 0, outcome: "needs_information",
    coverageStatus: "needs_owner_input", continuationKind: "input",
    ownerQuestion: question, coveredScope: "The idea was read; hierarchy is unresolved.",
    remainingScope: "Story and Task proposals need the owner's Feature choice.",
    units: [] });
  const result = await prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisResult(tx, { requestId: randomUUID(),
      ideaId: claim.ideaId, previewId, holdId, leaseGeneration: 1,
      outcome: "verified_success", rawModelOutput,
      inputTokens: 100, outputTokens: 50, keys }));
  assert.equal(result.state, "draft_ready");
  const [idea, chunk, next] = await Promise.all([
    prisma.amuxIdeaSubmission.findUniqueOrThrow({ where: { id: claim.ideaId } }),
    prisma.amuxIdeaAnalysisChunk.findUniqueOrThrow({ where: {
      ideaId_chunkIndex: { ideaId: claim.ideaId, chunkIndex: 0 },
    } }),
    prisma.amuxIdeaAnalysisChunk.findUnique({ where: {
      ideaId_chunkIndex: { ideaId: claim.ideaId, chunkIndex: 1 },
    } }),
  ]);
  assert.equal(idea.state, "analyzing");
  assert.equal(chunk.coverageStatus, "needs_owner_input");
  assert.equal(chunk.freeformPurgeAfter?.getTime(),
    idea.analysisDeadlineAt.getTime() + 24 * 60 * 60_000);
  assert.equal(next, null);
  const visible = await readAmuxFirstIdeaAnalysisResult(session, claim.ideaId, keys);
  assert.equal(visible.state, "needs_owner_input");
  if (visible.state !== "needs_owner_input") throw new Error("owner question missing");
  assert.equal(visible.ownerQuestion, question);
});

test("known provider failure is visible and permits a new owner preview only", async () => {
  const { claim, previewId, holdId, selectedModelId,
    frontierApprovalId } = await syntheticFirstClaim();
  const failure = await prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisResult(tx, { requestId: randomUUID(),
      ideaId: claim.ideaId, previewId, holdId, leaseGeneration: 1,
      outcome: "invocation_failed", rawModelOutput: null,
      inputTokens: 12, outputTokens: 0, keys }));
  assert.equal(failure.state, "provider_failed");
  assert.deepEqual(await readAmuxFirstIdeaAnalysisResult(session, claim.ideaId, keys),
    { state: "provider_failed" });
  const nextPreviewId = randomUUID();
  const choice = { previewId: nextPreviewId, ideaId: claim.ideaId,
    provider: "openai" as const, modelId: selectedModelId,
    reasoningEffort: "high" as const,
    approvalId: frontierApprovalId, approvalVersion: 1 };
  const prepared = await prisma.$transaction((tx) =>
    commitIdeaOnlyTransferPreview(tx,
      { session, request, choice, keys, browserNonce }));
  assert.equal(prepared.previewId, nextPreviewId);
  const [oldPreview, nextPreview, chunk] = await Promise.all([
    prisma.amuxIdeaTransferPreview.findUniqueOrThrow({ where: { id: previewId } }),
    prisma.amuxIdeaTransferPreview.findUniqueOrThrow({ where: { id: nextPreviewId } }),
    prisma.amuxIdeaAnalysisChunk.findUniqueOrThrow({ where: {
      ideaId_chunkIndex: { ideaId: claim.ideaId, chunkIndex: 0 },
    } }),
  ]);
  assert.equal(oldPreview.state, "provider_failed");
  assert.deepEqual([nextPreview.state, nextPreview.attempt,
    chunk.state, chunk.attempt, chunk.currentPreviewId],
  ["prepared", 2, "awaiting_preview", 2, nextPreviewId]);
  await prisma.$transaction((tx) => commitIdeaTransferConfirmation(tx,
    { session, request, choice: { previewId: nextPreviewId, ideaId: claim.ideaId,
      payloadDigest: prepared.payloadDigest,
      payloadDigestKeyId: prepared.payloadDigestKeyId }, browserNonce, keys }));
  const priorHold = await prisma.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({
    where: { id: holdId }, select: { priceVersionId: true },
  });
  assert.ok(priorHold.priceVersionId);
  await prisma.$transaction((tx) => commitAmuxIdeaAnalysisBudgetReservation(tx,
    { holdId: randomUUID(), previewId: nextPreviewId,
      priceVersionId: priorHold.priceVersionId!, runner, keys }));
  const nextClaim = await prisma.$transaction((tx) =>
    commitAmuxIdeaOnlyAnalysisClaim(tx,
      { requestId: randomUUID(), previewId: nextPreviewId, keys }));
  assert.equal(nextClaim.previewId, nextPreviewId);
  assert.equal(nextClaim.ideaId, claim.ideaId);
  const closed = await prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisResult(tx, { requestId: randomUUID(),
      ideaId: claim.ideaId, previewId: nextPreviewId,
      holdId: nextClaim.holdId, leaseGeneration: 1,
      outcome: "invocation_failed", rawModelOutput: null,
      inputTokens: 12, outputTokens: 0, keys }));
  assert.equal(closed.state, "provider_failed");
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

  // A claim made before preview expiry may finish after the original purge
  // eligibility time. The in-flight body remains protected until settlement.
  await prisma.amuxIdeaTransferPreview.update({ where: { id: previewId },
    data: { payloadPurgeAfter: new Date(Date.now() - 1_000) } });
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
  assert.ok(completedPreview.payloadPurgeAfter &&
    completedPreview.payloadPurgeAfter <= idea.analysisCompletedAt!,
  "completed transfer text is eligible for the next purge tick");
  assert.ok(chunk.freeformPurgeAfter &&
    chunk.freeformPurgeAfter <= idea.analysisCompletedAt!,
  "completed freeform text is eligible for the next purge tick");
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
  await prisma.amuxIdeaAnalysisBudgetWindow.upsert({
    where: { namespace_monthStart: { namespace, monthStart } },
    create: { namespace, monthStart, limitMicroUsd: BigInt(50_000_000),
      spentMicroUsd: BigInt(49_995_000) },
    update: { spentMicroUsd: BigInt(49_995_000), reservedMicroUsd: BigInt(0) },
  });
  const holds = previews.map(() => randomUUID());
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
  })).reservedMicroUsd, BigInt(5_000));
  assert.equal(await prisma.amuxIdeaAnalysisBudgetHold.count({
    where: { id: { in: holds } },
  }), 1);
  assert.equal(await prisma.adminAuditLog.count({
    where: { action: "AMUX_V4_ANALYSIS_BUDGET_RESERVED", targetId: { in: holds } },
  }), 1);
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
