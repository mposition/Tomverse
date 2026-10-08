import "server-only";

import type { Session } from "next-auth";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import type { PromptRefinerVnextOneShotAuditBinding } from
  "@/lib/promptRefinerVnextOneShotAuditReadback";
import { PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST } from
  "@/lib/promptRefinerVnextOneShotPriceBinding";
import { writePromptRefinerVnextOneShotStageApprovalAudit } from
  "@/lib/promptRefinerVnextOneShotStageApprovalAudit";
import { readPromptRefinerVnextOneShotPrice } from
  "@/lib/promptRefinerQualityEvaluationVnextOneShotPriceReadback";
import {
  PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD,
  PROMPT_REFINER_VNEXT_RUN_CEILING_MICRO_USD,
  PROMPT_REFINER_VNEXT_SLOT_COUNT,
} from "@/lib/promptRefinerQualityEvaluationVnextExecutionContract";
import { prisma } from "@/lib/prisma";
import { inspectPromptRefinerVnextOneShotV5Predecessor } from
  "@/lib/promptRefinerVnextOneShotV5PredecessorReadback";
import { promptRefinerVnextV5RecoveryMetadata,
  V4_STAGE_ID, V5_RECOVERY_ACTION,
  V5_RECOVERY_SUMMARY, V5_STAGE_ID } from
  "@/lib/promptRefinerVnextOneShotV5Recovery";

const V4 = V4_STAGE_ID;
const V5 = V5_STAGE_ID;
const SLOT_COST = BigInt(PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD);
const RUN_COST = BigInt(PROMPT_REFINER_VNEXT_RUN_CEILING_MICRO_USD);

/** One independent v5 stage; never updates or retries any v4 row. */
export async function createPromptRefinerVnextOneShotV5Stage(input: {
  session: Session;
  request: Request;
  binding: PromptRefinerVnextOneShotAuditBinding;
}) {
  if (input.binding.id !== V5 ||
      SLOT_COST * BigInt(PROMPT_REFINER_VNEXT_SLOT_COUNT) !== RUN_COST) {
    throw new Error("vnext_one_shot_v5_contract_invalid");
  }
  return prisma.$transaction(async (tx) => {
    // The approval writer acquires the shared audit-chain lock first.
    const { auditLogId, approvedBy } =
      await writePromptRefinerVnextOneShotStageApprovalAudit({ ...input, tx });
    const price = await readPromptRefinerVnextOneShotPrice(tx);
    if (input.binding.pricePinDigest !== PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST ||
        !price.pricePinMatchesRegistry || price.problems.length !== 0) {
      throw new Error("vnext_one_shot_v5_price_mismatch");
    }
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "PromptRefinerVnextOneShotStage"
      WHERE "id" = ${V4} FOR NO KEY UPDATE NOWAIT
    `;
    if (locked.length !== 1 || locked[0]?.id !== V4) {
      throw new Error("vnext_one_shot_v5_predecessor_unavailable");
    }
    const inspected = await inspectPromptRefinerVnextOneShotV5Predecessor(
      tx, input.binding, approvedBy);
    if (!inspected) {
      throw new Error("vnext_one_shot_v5_predecessor_invalid");
    }
    const { predecessor, stopAuditLogId, runApprovalAuditLogId } = inspected;
    const recoveryAuditLogId = await writeAdminAuditLog({
      tx, session: input.session, request: input.request,
      action: V5_RECOVERY_ACTION,
      targetType: "PromptRefinerVnextOneShotStage", targetId: V4,
      summary: V5_RECOVERY_SUMMARY,
      metadata: promptRefinerVnextV5RecoveryMetadata({
        stopAuditLogId,
        v4StageApprovalAuditLogId: predecessor.stageApprovalAuditLogId,
        v4RunApprovalAuditLogId: runApprovalAuditLogId,
        v5StageApprovalAuditLogId: auditLogId,
      }),
    });
    await tx.promptRefinerVnextOneShotStage.create({ data: {
      id: V5, status: "staged",
      sourceCommitSha: input.binding.sourceCommitSha,
      sourceManifestDigest: input.binding.sourceManifestDigest,
      runnerDigest: input.binding.runnerDigest,
      manifestRoot: input.binding.manifestRoot,
      runtimeDeploymentId: input.binding.runtimeDeploymentId,
      runtimeCommitSha: input.binding.runtimeCommitSha,
      pricePinDigest: input.binding.pricePinDigest,
      perRequestCostMicroUsd: SLOT_COST,
      slotCount: PROMPT_REFINER_VNEXT_SLOT_COUNT,
      costCeilingMicroUsd: RUN_COST,
      approvedBy, approvedAt: new Date(0), stageApprovalAuditLogId: auditLogId,
    } });
    const created = await tx.promptRefinerVnextOneShotSlot.createMany({
      data: Array.from({ length: PROMPT_REFINER_VNEXT_SLOT_COUNT }, (_, slotIndex) => ({
        id: `one-shot-v5-${slotIndex}`, stageId: V5, slotIndex,
        reservedCostMicroUsd: SLOT_COST,
      })),
    });
    if (created.count !== PROMPT_REFINER_VNEXT_SLOT_COUNT) {
      throw new Error("vnext_one_shot_v5_reservations_incomplete");
    }
    return Object.freeze({ stageId: V5, stageApprovalAuditLogId: auditLogId,
      recoveryAuditLogId, slotCount: created.count,
      dispatchAuthorized: false as const });
  }, { maxWait: 5_000, timeout: 15_000 });
}
