import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_SYSTEM_AUDIT_ACTOR } from "@/lib/amux/auditContract";
import { inspectV4TaskCostCatalog, type V4TaskCostCatalog } from
  "@/lib/amux/v4TaskCostCatalogCore";
import { amuxCliUsageReceiptDigest, amuxCliUsageReceiptSchema,
  estimateAmuxCliApiCost, v22ReceiptModelMatchesAssignment,
  type AmuxCliApiPrice } from
  "@/lib/amux/cliUsageLedgerCore";

export class AmuxCliUsageLedgerError extends Error {
  constructor(readonly code: "binding_mismatch" | "receipt_conflict" |
    "catalog_unavailable") { super(code); }
}

type Receipt = ReturnType<typeof amuxCliUsageReceiptSchema.parse>;

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
export async function recordAmuxCliUsage(tx: Prisma.TransactionClient,
  raw: unknown): Promise<{ invocationId: string; duplicate: boolean;
    receiptDigest: string; auditId: string | null }> {
  const receipt = amuxCliUsageReceiptSchema.parse(raw);
  const digest = amuxCliUsageReceiptDigest(receipt);
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
  const price = await approvedTaskPrice(tx, receipt);
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
    summary: "Recorded one content-free AMUX CLI usage observation.",
    metadata: { bindingKind: receipt.binding.kind,
      receiptDigest: digest, completeness: receipt.completeness,
      status: receipt.status, projectedApiCostKnown: projected !== null },
  });
  return { invocationId: receipt.invocationId, duplicate: false,
    receiptDigest: digest, auditId };
}
