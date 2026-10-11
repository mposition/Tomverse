import "server-only";

import type { Prisma, PromptRefinerVnextOneShotStage } from "@prisma/client";

import type { PromptRefinerRunnableStageId } from
  "@/lib/promptRefinerVnextOneShotV5Recovery";

export type PromptRefinerProductStageSnapshot = Readonly<Pick<
  PromptRefinerVnextOneShotStage,
  "id" | "status" | "sourceCommitSha" | "sourceManifestDigest" |
  "runnerDigest" | "manifestRoot" | "runtimeDeploymentId" |
  "runtimeCommitSha" | "pricePinDigest" | "perRequestCostMicroUsd" |
  "slotCount" | "costCeilingMicroUsd" | "approvedBy" | "approvedAt" |
  "stageApprovalAuditLogId" | "runApprovalAuditLogId"
>>;

/** Exact content-free Stage fields required by the frozen product readers. */
export async function readPromptRefinerProductStageSnapshot(
  tx: Prisma.TransactionClient,
  stageId: PromptRefinerRunnableStageId,
): Promise<PromptRefinerProductStageSnapshot | null> {
  const stage = await tx.promptRefinerVnextOneShotStage.findUnique({
    where: { id: stageId },
    select: {
      id: true,
      status: true,
      sourceCommitSha: true,
      sourceManifestDigest: true,
      runnerDigest: true,
      manifestRoot: true,
      runtimeDeploymentId: true,
      runtimeCommitSha: true,
      pricePinDigest: true,
      perRequestCostMicroUsd: true,
      slotCount: true,
      costCeilingMicroUsd: true,
      approvedBy: true,
      approvedAt: true,
      stageApprovalAuditLogId: true,
      runApprovalAuditLogId: true,
    },
  });
  return stage ? Object.freeze(stage) : null;
}
