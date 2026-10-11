import "server-only";

import type { Prisma, PromptRefinerVnextOneShotStage } from "@prisma/client";

import { promptRefinerVnextOneShotApprovalAuditsAreValid,
  promptRefinerVnextOneShotAuditReceiptIsValid } from
  "@/lib/promptRefinerVnextOneShotAuditReadback";
import { assertPromptRefinerVnextOneShotActiveDeploymentForAdmission } from
  "@/lib/promptRefinerVnextOneShotDeploymentBinding";
import { assertPromptRefinerVnextOneShotPriceForAdmission } from
  "@/lib/promptRefinerVnextOneShotPriceBinding";
import {
  PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD,
  PROMPT_REFINER_VNEXT_SLOT_COUNT,
} from "@/lib/promptRefinerQualityEvaluationVnextExecutionContract";
import { promptRefinerVnextV5RecoveryMetadata,
  type PromptRefinerRunnableStageId,
  V4_COMMIT_SHA, V4_DEPLOYMENT_ID, V4_STAGE_ID, V5_RECOVERY_ACTION,
  V5_RECOVERY_SUMMARY, V5_STAGE_ID } from
  "@/lib/promptRefinerVnextOneShotV5Recovery";

const STAGE_ID = "prompt-refiner-vnext-one-shot-v4";
const THIRD_STAGE_ID = "prompt-refiner-vnext-one-shot-v3";
const LEGACY_STAGE_ID = "prompt-refiner-vnext-one-shot-v2";
const FIRST_STAGE_ID = "prompt-refiner-vnext-one-shot-v1";
const SLOT_COST_MICRO_USD = BigInt(PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD);

type StageStatus = "staged" | "run_approved" | "closed";

export type PromptRefinerVnextOneShotStageReadback = Readonly<{
  stagePresent: boolean;
  stageId: string | null;
  stageStatus: StageStatus | null;
  runtimeDeploymentId: string | null;
  runtimeCommitSha: string | null;
  stageApprovalAuditLogId: string | null;
  runApprovalAuditLogId: string | null;
  slotCount: number;
  reservedSlots: number;
  consumedSlots: number;
  reservationShapeValid: boolean;
  approvalAuditsValid: boolean;
  dispatchAuthorized: false;
}>;

const ABSENT_STAGE: PromptRefinerVnextOneShotStageReadback = Object.freeze({
  stagePresent: false,
  stageId: null,
  stageStatus: null,
  runtimeDeploymentId: null,
  runtimeCommitSha: null,
  stageApprovalAuditLogId: null,
  runApprovalAuditLogId: null,
  slotCount: 0,
  reservedSlots: 0,
  consumedSlots: 0,
  reservationShapeValid: false,
  approvalAuditsValid: false,
  dispatchAuthorized: false,
});

async function replacementAuditIsValid(
  tx: Prisma.TransactionClient,
  stage: PromptRefinerVnextOneShotStage,
): Promise<boolean> {
  if (stage.id === FIRST_STAGE_ID) return true;
  if (stage.id === V5_STAGE_ID) {
    const previous = await tx.promptRefinerVnextOneShotStage.findUnique({
      where: { id: V4_STAGE_ID },
    });
    if (!previous || previous.status !== "closed" ||
        previous.runtimeDeploymentId !== V4_DEPLOYMENT_ID ||
        previous.runtimeCommitSha !== V4_COMMIT_SHA ||
        previous.approvedBy !== stage.approvedBy ||
        previous.sourceCommitSha !== stage.sourceCommitSha ||
        previous.sourceManifestDigest !== stage.sourceManifestDigest ||
        previous.manifestRoot === stage.manifestRoot ||
        previous.runnerDigest === stage.runnerDigest ||
        previous.pricePinDigest !== stage.pricePinDigest ||
        previous.runtimeDeploymentId === stage.runtimeDeploymentId ||
        previous.runtimeCommitSha === stage.runtimeCommitSha ||
        !previous.runApprovalAuditLogId ||
        !(await readPromptRefinerVnextOneShotStage(tx, V4_STAGE_ID)).approvalAuditsValid) {
      return false;
    }
    const recovery = await tx.adminAuditLog.findMany({ where: {
      action: V5_RECOVERY_ACTION,
      targetType: "PromptRefinerVnextOneShotStage", targetId: V4_STAGE_ID,
    } });
    if (recovery.length !== 1 ||
        recovery[0].actorUserId !== stage.approvedBy ||
        recovery[0].summary !== V5_RECOVERY_SUMMARY ||
        !await promptRefinerVnextOneShotAuditReceiptIsValid(tx, recovery[0])) {
      return false;
    }
    const metadata = recovery[0].metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
        typeof metadata.predecessorStopAuditLogId !== "string") return false;
    const stop = await tx.adminAuditLog.findUnique({
      where: { id: metadata.predecessorStopAuditLogId },
    });
    if (!stop || stop.action !== "prompt_refiner.vnext_one_shot.outcome_unknown" ||
        stop.targetType !== "PromptRefinerVnextOneShotStage" ||
        stop.targetId !== V4_STAGE_ID ||
        !await promptRefinerVnextOneShotAuditReceiptIsValid(tx, stop)) return false;
    const expected = promptRefinerVnextV5RecoveryMetadata({
      stopAuditLogId: stop.id,
      v4StageApprovalAuditLogId: previous.stageApprovalAuditLogId,
      v4RunApprovalAuditLogId: previous.runApprovalAuditLogId,
      v5StageApprovalAuditLogId: stage.stageApprovalAuditLogId,
    });
    return Object.keys(metadata).length === Object.keys(expected).length &&
      Object.entries(expected).every(([key, value]) => metadata[key] === value);
  }
  const previousId = stage.id === STAGE_ID ? THIRD_STAGE_ID :
    stage.id === THIRD_STAGE_ID ? LEGACY_STAGE_ID :
    stage.id === LEGACY_STAGE_ID ? FIRST_STAGE_ID : null;
  if (!previousId) return false;
  const legacy = await tx.promptRefinerVnextOneShotStage.findUnique({
    where: { id: previousId },
  });
  if (!legacy || legacy.status !== "closed" ||
      (previousId === FIRST_STAGE_ID && legacy.runApprovalAuditLogId !== null) ||
      ((previousId === LEGACY_STAGE_ID || previousId === THIRD_STAGE_ID) &&
        !legacy.runApprovalAuditLogId) ||
      !legacy.supersededAuditLogId || legacy.approvedBy !== stage.approvedBy ||
      legacy.sourceCommitSha !== stage.sourceCommitSha ||
      legacy.sourceManifestDigest !== stage.sourceManifestDigest ||
      (previousId === THIRD_STAGE_ID ?
        legacy.runnerDigest === stage.runnerDigest :
        legacy.runnerDigest !== stage.runnerDigest) ||
      legacy.manifestRoot !== stage.manifestRoot ||
      legacy.pricePinDigest !== stage.pricePinDigest ||
      legacy.runtimeDeploymentId === stage.runtimeDeploymentId) return false;
  const audit = await tx.adminAuditLog.findUnique({
    where: { id: legacy.supersededAuditLogId },
  });
  if (!audit || audit.actorUserId !== stage.approvedBy ||
      audit.action !== "prompt_refiner.vnext_one_shot.stage_superseded" ||
      audit.targetType !== "PromptRefinerVnextOneShotStage" ||
      audit.targetId !== previousId ||
      !await promptRefinerVnextOneShotAuditReceiptIsValid(tx, audit)) return false;
  const metadata = audit.metadata;
  const shadowId = metadata && typeof metadata === "object" &&
    !Array.isArray(metadata) && typeof metadata.previousShadowAuditLogId === "string"
    ? metadata.previousShadowAuditLogId : null;
  const shadow = previousId === THIRD_STAGE_ID && shadowId ?
    await tx.adminAuditLog.findUnique({ where: { id: shadowId } }) : null;
  const shadowValid = previousId !== THIRD_STAGE_ID || Boolean(shadow &&
    shadow.action === "prompt_refiner.vnext_one_shot.operational_shadow_completed" &&
    shadow.targetType === "PromptRefinerVnextOneShotStage" &&
    shadow.targetId === THIRD_STAGE_ID &&
    await promptRefinerVnextOneShotAuditReceiptIsValid(tx, shadow));
  return Boolean(shadowValid && metadata && typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    metadata.replacementStageId === stage.id &&
    metadata.previousStageApprovalAuditLogId === legacy.stageApprovalAuditLogId &&
    (previousId === FIRST_STAGE_ID ||
      metadata.previousRunApprovalAuditLogId === legacy.runApprovalAuditLogId) &&
    (previousId !== THIRD_STAGE_ID || metadata.previousShadowAuditLogId === shadowId) &&
    metadata.replacementStageApprovalAuditLogId === stage.stageApprovalAuditLogId);
}

/**
 * A future admission caller must take this lock before registry-price and
 * slot reads. Slot writes take a SHARE lock on the same stage row in the DB
 * trigger, so a present stage and its reservations remain stable for this
 * transaction. The active deployment is also rechecked directly before this
 * readback returns. No dispatch caller is wired yet; this grants no authority.
 */
export async function lockAndReadPromptRefinerVnextOneShotStage(
  tx: Prisma.TransactionClient,
  deploymentOptions: Parameters<
    typeof assertPromptRefinerVnextOneShotActiveDeploymentForAdmission
  >[1] = {},
  stageId: PromptRefinerRunnableStageId = STAGE_ID,
): Promise<PromptRefinerVnextOneShotStageReadback> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "PromptRefinerVnextOneShotStage"
    WHERE "id" = ${stageId} FOR NO KEY UPDATE NOWAIT
  `;
  if (rows.length === 0) return ABSENT_STAGE;
  if (rows.length !== 1 || rows[0]?.id !== stageId) {
    throw new Error("vnext_one_shot_stage_lock_mismatch");
  }
  const snapshot = await readPromptRefinerVnextOneShotStage(tx, stageId);
  if (!snapshot.stagePresent) {
    throw new Error("vnext_one_shot_stage_changed_after_lock");
  }
  await assertPromptRefinerVnextOneShotActiveDeploymentForAdmission(
    tx, deploymentOptions, stageId
  );
  await assertPromptRefinerVnextOneShotPriceForAdmission(tx, stageId);
  return snapshot;
}

/** Content-free diagnostic only; never grants stage, run, or dispatch authority. */
export async function readPromptRefinerVnextOneShotStage(
  tx: Prisma.TransactionClient,
  stageId: string = STAGE_ID
): Promise<PromptRefinerVnextOneShotStageReadback> {
  const stage = await tx.promptRefinerVnextOneShotStage.findUnique({
    where: { id: stageId },
  });
  if (!stage) {
    return ABSENT_STAGE;
  }

  const slots = await tx.promptRefinerVnextOneShotSlot.findMany({
    where: { stageId },
    select: {
      slotIndex: true,
      status: true,
      reservedCostMicroUsd: true,
      requestId: true,
      consumedAt: true,
    },
  });
  const indices = new Set<number>();
  let reservedSlots = 0;
  let consumedSlots = 0;
  let slotsValid = true;
  for (const slot of slots) {
    if (!Number.isInteger(slot.slotIndex) || slot.slotIndex < 0 ||
      slot.slotIndex >= PROMPT_REFINER_VNEXT_SLOT_COUNT || indices.has(slot.slotIndex) ||
      slot.reservedCostMicroUsd !== SLOT_COST_MICRO_USD) {
      slotsValid = false;
    }
    indices.add(slot.slotIndex);
    if (slot.status === "reserved" && slot.requestId === null && slot.consumedAt === null) {
      reservedSlots++;
    } else if (slot.status === "consumed" && slot.requestId && slot.consumedAt) {
      consumedSlots++;
    } else {
      slotsValid = false;
    }
  }
  const stageStatus = stage.status === "staged" || stage.status === "run_approved" ||
    stage.status === "closed" ? stage.status : null;
  return Object.freeze({
    stagePresent: true,
    stageId: stage.id,
    stageStatus,
    runtimeDeploymentId: stage.runtimeDeploymentId,
    runtimeCommitSha: stage.runtimeCommitSha,
    stageApprovalAuditLogId: stage.stageApprovalAuditLogId,
    runApprovalAuditLogId: stage.runApprovalAuditLogId,
    slotCount: slots.length,
    reservedSlots,
    consumedSlots,
    reservationShapeValid: slotsValid && stageStatus !== null &&
      stage.slotCount === PROMPT_REFINER_VNEXT_SLOT_COUNT &&
      slots.length === PROMPT_REFINER_VNEXT_SLOT_COUNT &&
      indices.size === PROMPT_REFINER_VNEXT_SLOT_COUNT &&
      reservedSlots + consumedSlots === PROMPT_REFINER_VNEXT_SLOT_COUNT,
    approvalAuditsValid: stageStatus !== null &&
      await promptRefinerVnextOneShotApprovalAuditsAreValid(tx, stage) &&
      await replacementAuditIsValid(tx, stage),
    dispatchAuthorized: false,
  });
}
