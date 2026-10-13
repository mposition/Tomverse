import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_SYSTEM_AUDIT_ACTOR } from "@/lib/amux/auditContract";
import { inspectV4TaskCostCatalog, type V4TaskCostCatalog } from
  "@/lib/amux/v4TaskCostCatalogCore";
import { amuxCliUsageReceiptDigest, amuxCliUsageReceiptSchema,
  amuxUsageLedgerReceiptSchema,
  estimateAmuxCliApiCost, v22ReceiptModelMatchesAssignment,
  type AmuxCliApiPrice, type AmuxUsageLedgerReceipt } from
  "@/lib/amux/cliUsageLedgerCore";
import { AMUX_V22_READ_ONLY_API_EXECUTOR_KIND,
  amuxV22ReadOnlyApiExecutionFrameDigest,
  parseAmuxV22ReadOnlyApiExecutionReceipt,
  type AmuxV22ReadOnlyApiExecutionFrame,
  type AmuxV22ReadOnlyApiExecutionReceipt } from
  "@/lib/amux/v22ReadOnlyApiProtocol.mjs";
import { AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID } from
  "@/lib/amux/v22TaskRecoveryCore";
import { readAmuxV22RecoveryAuthority } from
  "@/lib/amux/v22TaskRecoveryService";

export class AmuxCliUsageLedgerError extends Error {
  constructor(readonly code: "binding_mismatch" | "receipt_conflict" |
    "catalog_unavailable") { super(code); }
}

type Receipt = AmuxUsageLedgerReceipt;
type ApiAuditBinding = {
  launchScopeDigest: string;
  apiExecutionFrameDigest: string;
  apiExecutionFrame: AmuxV22ReadOnlyApiExecutionFrame;
  apiExecutionReceipt: AmuxV22ReadOnlyApiExecutionReceipt;
};

function apiExecutionFramePrice(
  frame: AmuxV22ReadOnlyApiExecutionFrame,
): AmuxCliApiPrice {
  return {
    provider: frame.provider,
    modelId: frame.modelId,
    version: frame.pricingVersion,
    uncachedInputMicroUsdPerMillion: frame.uncachedInputMicroUsdPerMillion,
    cacheReadMicroUsdPerMillion: frame.cacheReadMicroUsdPerMillion,
    cacheWriteMicroUsdPerMillion: frame.cacheWriteMicroUsdPerMillion,
    outputMicroUsdPerMillion: frame.outputMicroUsdPerMillion,
    reasoningOutputMicroUsdPerMillion: null,
  };
}

async function authoritativeApiExecutionFrame(
  tx: Prisma.TransactionClient,
  attemptId: string,
): Promise<{ frame: AmuxV22ReadOnlyApiExecutionFrame;
  launchScopeDigest: string } | null> {
  const attempt = await tx.amuxExecutionAttempt.findUnique({
    where: { id: attemptId },
    select: {
      taskId: true,
      v22Assignment: { select: {
        recoveryApprovalId: true,
        taskRevision: true,
      } },
    },
  });
  const assignment = attempt?.v22Assignment;
  const approvalId = assignment?.recoveryApprovalId;
  if (!attempt || !assignment || !approvalId) return null;
  const authority = await readAmuxV22RecoveryAuthority(
    tx, attempt.taskId, assignment.taskRevision, approvalId);
  return authority?.readOnlyExecutorKind ===
      AMUX_V22_READ_ONLY_API_EXECUTOR_KIND && authority.apiExecutionFrame &&
      authority.launchScopeDigest ? {
        frame: authority.apiExecutionFrame,
        launchScopeDigest: authority.launchScopeDigest,
      } : null;
}

async function approvedTaskPrice(tx: Prisma.TransactionClient,
  receipt: Receipt): Promise<AmuxCliApiPrice | null> {
  if (receipt.binding.kind !== "task_attempt" || !receipt.actualModelId ||
      receipt.actualModelId === "multi_model") return null;
  const row = await tx.amuxV4TaskCostCatalogApproval.findFirst({
    orderBy: { version: "desc" },
  });
  if (!row || row.status !== "approved" || row.revokedAt !== null) return null;
  const inspection = inspectV4TaskCostCatalog(row.catalog);
  if (!inspection.ok || inspection.catalogDigest !== row.catalogDigest) return null;
  const audit = await tx.adminAuditLog.findUnique({
    where: { id: row.approvalAuditLogId },
    select: { action: true, actorUserId: true, targetId: true,
      targetType: true, entryHash: true },
  });
  if (!audit?.entryHash || audit.action !== "amux.v4.task_catalog.approve" ||
      audit.actorUserId !== row.approvedByUserId || audit.targetId !== row.id ||
      audit.targetType !== "AmuxV4TaskCostCatalogApproval") return null;
  const catalog = row.catalog as unknown as V4TaskCostCatalog;
  const candidates = catalog.routes.filter((route) => route.enabled &&
    route.workerName === receipt.worker && route.provider === receipt.provider &&
    route.modelId === receipt.actualModelId &&
    route.pricingVerifiedAt <= receipt.endedAt &&
    route.pricingExpiresAt > receipt.endedAt);
  if (candidates.length !== 1) return null;
  const route = candidates[0];
  return { provider: receipt.provider, modelId: receipt.actualModelId,
    version: row.pricingVersion,
    uncachedInputMicroUsdPerMillion: route.uncachedInputMicroUsdPerMillion,
    cacheReadMicroUsdPerMillion: route.cacheReadMicroUsdPerMillion,
    cacheWriteMicroUsdPerMillion: route.cacheWriteMicroUsdPerMillion,
    outputMicroUsdPerMillion: route.outputMicroUsdPerMillion,
    reasoningOutputMicroUsdPerMillion: null };
}

/** Sole app writer. A repeated invocation ID is a read-back, never a second
 * charge or a replacement of the first observation. */
async function recordUsage(tx: Prisma.TransactionClient,
  raw: unknown, apiAuditBinding: ApiAuditBinding | null): Promise<{
    invocationId: string; duplicate: boolean;
    receiptDigest: string; auditId: string | null }> {
  const receipt = amuxUsageLedgerReceiptSchema.parse(raw);
  if ((receipt.cli === "anthropic_api") !== (apiAuditBinding !== null))
    throw new AmuxCliUsageLedgerError("binding_mismatch");
  const digest = apiAuditBinding?.apiExecutionReceipt.digest ??
    amuxCliUsageReceiptDigest(receipt);
  const existing = await tx.amuxCliUsageEvent.findUnique({
    where: { invocationId: receipt.invocationId },
    select: { receiptDigest: true },
  });
  if (existing) {
    if (existing.receiptDigest !== digest) throw new AmuxCliUsageLedgerError("receipt_conflict");
    return { invocationId: receipt.invocationId, duplicate: true,
      receiptDigest: digest, auditId: null };
  }
  let taskId: string | null = null;
  if (receipt.binding.kind === "task_attempt") {
    const attempt = await tx.amuxExecutionAttempt.findUnique({
      where: { id: receipt.binding.attemptId },
      select: { taskId: true, worker: true, startedAt: true,
        endedAt: true, v22AssignmentId: true,
        task: { select: { sourceSystem: true,
          v22AssignmentId: true,
          v22AcceptedAssignment: { select: {
            workerName: true, provider: true, modelId: true,
          } },
        } },
      },
    });
    if (!attempt || attempt.worker !== receipt.worker) {
      throw new AmuxCliUsageLedgerError("binding_mismatch");
    }
    if (apiAuditBinding &&
        attempt.taskId !== AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID) {
      throw new AmuxCliUsageLedgerError("binding_mismatch");
    }
    if (receipt.binding.kind === "task_attempt" &&
        attempt.task.sourceSystem === "admin-idea-v4" &&
        (attempt.endedAt !== null || !attempt.v22AssignmentId ||
          attempt.task.v22AssignmentId !== attempt.v22AssignmentId ||
          !v22ReceiptModelMatchesAssignment(receipt) ||
          Date.parse(receipt.startedAt) < attempt.startedAt.getTime() - 120_000 ||
          !attempt.task.v22AcceptedAssignment ||
          attempt.task.v22AcceptedAssignment.workerName !== receipt.worker ||
          attempt.task.v22AcceptedAssignment.provider !== receipt.provider ||
          attempt.task.v22AcceptedAssignment.modelId !== receipt.selectedModelId)) {
      throw new AmuxCliUsageLedgerError("binding_mismatch");
    }
    taskId = attempt.taskId;
  } else {
    const hold = await tx.amuxIdeaAnalysisBudgetHold.findUnique({
      where: { id: receipt.binding.holdId },
      select: { provider: true, modelId: true, dispatchedAt: true },
    });
    if (!hold || hold.provider !== receipt.provider ||
        hold.modelId !== receipt.selectedModelId ||
        hold.dispatchedAt === null ||
        receipt.worker !== "amux-intake") {
      throw new AmuxCliUsageLedgerError("binding_mismatch");
    }
  }
  const price = apiAuditBinding ?
    apiExecutionFramePrice(apiAuditBinding.apiExecutionFrame) :
    await approvedTaskPrice(tx, receipt);
  const projected = estimateAmuxCliApiCost(receipt, price);
  const usage = receipt.observed;
  const id = randomUUID();
  const created = await tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO "AmuxCliUsageEvent" (
      "id", "invocationId", "receiptDigest", "bindingKind", "attemptId",
      "analysisHoldId", "taskId", "worker", "cli", "provider",
      "selectedModelId", "actualModelId", "cliVersion", "authentication",
      "startedAt", "endedAt", "status", "completeness", "source",
      "inputTokens", "outputTokens", "cacheReadInputTokens",
      "cacheCreationInputTokens", "reasoningOutputTokens",
      "inputTokensIncludeCacheRead", "inputTokensIncludeCacheWrite",
      "reasoningOutputIncludedInOutput", "completedTurns", "pricingVersion",
      "projectedApiCostMicrousd", "actualApiCostMicrousd",
      "createdAt", "retentionUntil"
    ) VALUES (
      ${id}, ${receipt.invocationId}, ${digest}, ${receipt.binding.kind},
      ${receipt.binding.kind === "task_attempt" ? receipt.binding.attemptId : null},
      ${receipt.binding.kind === "idea_analysis" ? receipt.binding.holdId : null},
      ${taskId}, ${receipt.worker}, ${receipt.cli}, ${receipt.provider},
      ${receipt.selectedModelId}, ${receipt.actualModelId}, ${receipt.cliVersion},
      ${receipt.authentication}, ${new Date(receipt.startedAt)},
      ${new Date(receipt.endedAt)}, ${receipt.status}, ${receipt.completeness},
      ${receipt.source}, ${usage === null ? null : BigInt(usage.inputTokens)},
      ${usage === null ? null : BigInt(usage.outputTokens)},
      ${usage === null ? null : BigInt(usage.cacheReadInputTokens)},
      ${usage?.cacheCreationInputTokens === null || usage === null ? null :
        BigInt(usage.cacheCreationInputTokens)},
      ${usage?.reasoningOutputTokens === null || usage === null ? null :
        BigInt(usage.reasoningOutputTokens)},
      ${receipt.inputTokensIncludeCacheRead},
      ${receipt.inputTokensIncludeCacheWrite},
      ${receipt.reasoningOutputIncludedInOutput}, ${receipt.completedTurns},
      ${projected === null ? null : price?.version ?? null}, ${projected}, NULL,
      CURRENT_TIMESTAMP::timestamp(3),
      CURRENT_TIMESTAMP::timestamp(3) + interval '13 months'
    ) RETURNING "id"
  `;
  if (created.length !== 1) throw new AmuxCliUsageLedgerError("binding_mismatch");
  const auditId = await writeSystemAuditLog({ tx,
    systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
    action: "amux.cli_usage.recorded",
    targetType: "AmuxCliUsageEvent", targetId: id,
    summary: apiAuditBinding ?
      "Recorded one content-free AMUX API usage observation." :
      "Recorded one content-free AMUX CLI usage observation.",
    metadata: { bindingKind: receipt.binding.kind,
      receiptDigest: digest, completeness: receipt.completeness,
      status: receipt.status, projectedApiCostKnown: projected !== null,
      ...(apiAuditBinding ? {
        executorKind: AMUX_V22_READ_ONLY_API_EXECUTOR_KIND,
        authenticationMode: "api_key",
        launchScopeDigest: apiAuditBinding.launchScopeDigest,
        apiExecutionFrameDigest: apiAuditBinding.apiExecutionFrameDigest,
        apiExecutionReceiptDigest: apiAuditBinding.apiExecutionReceipt.digest,
        apiExecutionReceipt: apiAuditBinding.apiExecutionReceipt,
      } : {}),
    },
  });
  return { invocationId: receipt.invocationId, duplicate: false,
    receiptDigest: digest, auditId };
}

export async function recordAmuxCliUsage(tx: Prisma.TransactionClient,
  raw: unknown): Promise<{ invocationId: string; duplicate: boolean;
    receiptDigest: string; auditId: string | null }> {
  return recordUsage(tx, amuxCliUsageReceiptSchema.parse(raw), null);
}

export function amuxV22ReadOnlyApiUsageProjection(input: {
  frame: AmuxV22ReadOnlyApiExecutionFrame;
  receipt: AmuxV22ReadOnlyApiExecutionReceipt;
}) {
  const receipt = parseAmuxV22ReadOnlyApiExecutionReceipt(
    input.receipt, input.frame);
  return {
    invocationId: receipt.invocationId,
    receiptDigest: receipt.digest,
    status: receipt.terminalStatus,
    completeness: "reported_complete" as const,
    projectedApiCostMicrousd: BigInt(receipt.projectedCostMicroUsd),
    cli: "anthropic_api" as const,
    source: "anthropic_messages_api" as const,
    actualModelId: receipt.actualModelId,
    selectedModelId: receipt.selectedModelId,
    provider: "anthropic" as const,
    authentication: "api_key" as const,
    inputTokens: BigInt(receipt.uncachedInputTokens),
    outputTokens: BigInt(receipt.outputTokens),
    cacheReadInputTokens: BigInt(receipt.cacheReadTokens),
    cacheCreationInputTokens: BigInt(receipt.cacheWriteTokens),
    inputTokensIncludeCacheRead: false,
    inputTokensIncludeCacheWrite: false,
    completedTurns: receipt.providerTurnCount,
    pricingVersion: input.frame.pricingVersion,
  };
}

/** Convert one complete native Anthropic API receipt into the existing
 * immutable usage ledger. Settlement re-reads the server-approved immutable
 * launch frame; a later catalogue version never retroactively reprices it. */
export async function recordAmuxV22ReadOnlyApiUsage(
  tx: Prisma.TransactionClient,
  input: {
    worker: string;
    attemptId: string;
    attemptStartedAt: Date;
    endedAt: Date;
    launchScopeDigest: string;
    frame: AmuxV22ReadOnlyApiExecutionFrame;
    receipt: AmuxV22ReadOnlyApiExecutionReceipt;
  },
) {
  const echoedFrameDigest = amuxV22ReadOnlyApiExecutionFrameDigest(input.frame);
  const authority = await authoritativeApiExecutionFrame(tx, input.attemptId);
  if (!authority || input.launchScopeDigest !== authority.launchScopeDigest ||
      amuxV22ReadOnlyApiExecutionFrameDigest(authority.frame) !==
        echoedFrameDigest) {
    throw new AmuxCliUsageLedgerError("binding_mismatch");
  }
  const approvedFrame = authority.frame;
  const parsed = parseAmuxV22ReadOnlyApiExecutionReceipt(
    input.receipt, approvedFrame);
  const frameDigest = amuxV22ReadOnlyApiExecutionFrameDigest(approvedFrame);
  if (parsed.attemptId !== input.attemptId ||
      parsed.invocationId !== input.attemptId ||
      !/^[a-f0-9]{64}$/.test(input.launchScopeDigest) ||
      parsed.apiExecutionFrameDigest !== frameDigest ||
      input.endedAt.getTime() < input.attemptStartedAt.getTime()) {
    throw new AmuxCliUsageLedgerError("binding_mismatch");
  }
  const usageReceipt = amuxUsageLedgerReceiptSchema.parse({
    version: 1,
    invocationId: parsed.invocationId,
    binding: { kind: "task_attempt", attemptId: input.attemptId },
    worker: input.worker,
    cli: "anthropic_api",
    provider: "anthropic",
    selectedModelId: parsed.selectedModelId,
    actualModelId: parsed.actualModelId,
    cliVersion: null,
    authentication: "api_key",
    startedAt: input.attemptStartedAt.toISOString(),
    endedAt: input.endedAt.toISOString(),
    status: parsed.terminalStatus,
    completeness: "reported_complete",
    source: "anthropic_messages_api",
    observed: {
      inputTokens: parsed.uncachedInputTokens,
      outputTokens: parsed.outputTokens,
      cacheReadInputTokens: parsed.cacheReadTokens,
      cacheCreationInputTokens: parsed.cacheWriteTokens,
      reasoningOutputTokens: null,
    },
    inputTokensIncludeCacheRead: false,
    inputTokensIncludeCacheWrite: false,
    reasoningOutputIncludedInOutput: null,
    completedTurns: parsed.providerTurnCount,
  });
  const price = apiExecutionFramePrice(approvedFrame);
  const projected = estimateAmuxCliApiCost(usageReceipt, price);
  if (projected !== BigInt(parsed.projectedCostMicroUsd)) {
    throw new AmuxCliUsageLedgerError("catalog_unavailable");
  }
  return recordUsage(tx, usageReceipt, {
    launchScopeDigest: input.launchScopeDigest,
    apiExecutionFrameDigest: frameDigest,
    apiExecutionFrame: approvedFrame,
    apiExecutionReceipt: parsed,
  });
}
