import "server-only";

import type { Session } from "next-auth";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import type { PromptRefinerVnextOneShotAuditBinding } from
  "@/lib/promptRefinerVnextOneShotAuditReadback";
import { PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST } from
  "@/lib/promptRefinerVnextOneShotPriceBinding";
import { readPromptRefinerVnextOneShotStage } from
  "@/lib/promptRefinerVnextOneShotStageReadback";
import { readPromptRefinerVnextOneShotTerminalReceipts } from
  "@/lib/promptRefinerVnextOneShotTerminalReceipt";
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
import { promptRefinerVnextV5RecoveryMetadata,
  V4_COMMIT_SHA, V4_DEPLOYMENT_ID, V4_HELD_COST_MICRO_USD,
  V4_OBSERVED_COST_MICRO_USD, V4_STAGE_ID, V5_RECOVERY_ACTION,
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
    const predecessor = await tx.promptRefinerVnextOneShotStage.findUnique({
      where: { id: V4 },
    });
    const v4Stage = await readPromptRefinerVnextOneShotStage(tx, V4);
    const v4Terminals = await readPromptRefinerVnextOneShotTerminalReceipts(tx);
    const stop = v4Terminals.slots[33];
    if (!predecessor || predecessor.status !== "closed" ||
        predecessor.runtimeDeploymentId !== V4_DEPLOYMENT_ID ||
        predecessor.runtimeCommitSha !== V4_COMMIT_SHA ||
        predecessor.approvedBy !== approvedBy ||
        !predecessor.runApprovalAuditLogId ||
        !v4Stage.reservationShapeValid || !v4Stage.approvalAuditsValid ||
        v4Stage.stageStatus !== "closed" ||
        !v4Terminals.valid || v4Terminals.stageStatus !== "closed" ||
        v4Terminals.terminalReceipts !== 33 ||
        v4Terminals.unknownReceipts !== 1 ||
        v4Terminals.consumedWithoutReceipt !== 0 ||
        v4Terminals.observedCostMicroUsd !== V4_OBSERVED_COST_MICRO_USD ||
        v4Terminals.unresolvedCostUpperBoundMicroUsd !== V4_HELD_COST_MICRO_USD ||
        v4Terminals.slots.length !== PROMPT_REFINER_VNEXT_SLOT_COUNT ||
        v4Terminals.slots.slice(0, 33).some((slot) => slot.state !== "terminal") ||
        stop?.state !== "outcome_unknown" || !stop.terminalAuditLogId ||
        v4Terminals.slots.slice(34).some((slot) => slot.state !== "not_attempted") ||
        predecessor.sourceCommitSha !== input.binding.sourceCommitSha ||
        predecessor.sourceManifestDigest !== input.binding.sourceManifestDigest ||
        predecessor.manifestRoot === input.binding.manifestRoot ||
        predecessor.runnerDigest === input.binding.runnerDigest ||
        predecessor.pricePinDigest !== input.binding.pricePinDigest ||
        predecessor.perRequestCostMicroUsd !== SLOT_COST ||
        predecessor.costCeilingMicroUsd !== RUN_COST ||
        predecessor.slotCount !== PROMPT_REFINER_VNEXT_SLOT_COUNT ||
        predecessor.runtimeDeploymentId === input.binding.runtimeDeploymentId ||
        predecessor.runtimeCommitSha === input.binding.runtimeCommitSha ||
        await tx.promptRefinerVnextOneShotStage.count({ where: { id: V5 } }) !== 0) {
      throw new Error("vnext_one_shot_v5_predecessor_invalid");
    }
    const recoveryAuditLogId = await writeAdminAuditLog({
      tx, session: input.session, request: input.request,
      action: V5_RECOVERY_ACTION,
      targetType: "PromptRefinerVnextOneShotStage", targetId: V4,
      summary: V5_RECOVERY_SUMMARY,
      metadata: promptRefinerVnextV5RecoveryMetadata({
        stopAuditLogId: stop.terminalAuditLogId,
        v4StageApprovalAuditLogId: predecessor.stageApprovalAuditLogId,
        v4RunApprovalAuditLogId: predecessor.runApprovalAuditLogId,
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
