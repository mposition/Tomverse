import "server-only";

import type { Prisma } from "@prisma/client";

import { promptRefinerVnextOneShotApprovalAuditsAreValid } from
  "@/lib/promptRefinerVnextOneShotAuditReadback";
import { assertPromptRefinerVnextOneShotActiveDeploymentForAdmission } from
  "@/lib/promptRefinerVnextOneShotDeploymentBinding";
import { assertPromptRefinerVnextOneShotPriceForAdmission } from
  "@/lib/promptRefinerVnextOneShotPriceBinding";
import {
  PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD,
  PROMPT_REFINER_VNEXT_SLOT_COUNT,
} from "@/lib/promptRefinerQualityEvaluationVnextExecutionContract";

const STAGE_ID = "prompt-refiner-vnext-one-shot-v1";
const SLOT_COST_MICRO_USD = BigInt(PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD);

type StageStatus = "staged" | "run_approved" | "closed";

export type PromptRefinerVnextOneShotStageReadback = Readonly<{
  stagePresent: boolean;
  stageStatus: StageStatus | null;
  slotCount: number;
  reservedSlots: number;
  consumedSlots: number;
  reservationShapeValid: boolean;
  approvalAuditsValid: boolean;
  dispatchAuthorized: false;
}>;

const ABSENT_STAGE: PromptRefinerVnextOneShotStageReadback = Object.freeze({
  stagePresent: false,
  stageStatus: null,
  slotCount: 0,
  reservedSlots: 0,
  consumedSlots: 0,
  reservationShapeValid: false,
  approvalAuditsValid: false,
  dispatchAuthorized: false,
});

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
  >[1] = {}
): Promise<PromptRefinerVnextOneShotStageReadback> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "PromptRefinerVnextOneShotStage"
    WHERE "id" = ${STAGE_ID} FOR NO KEY UPDATE NOWAIT
  `;
  if (rows.length === 0) return ABSENT_STAGE;
  if (rows.length !== 1 || rows[0]?.id !== STAGE_ID) {
    throw new Error("vnext_one_shot_stage_lock_mismatch");
  }
  const snapshot = await readPromptRefinerVnextOneShotStage(tx);
  if (!snapshot.stagePresent) {
    throw new Error("vnext_one_shot_stage_changed_after_lock");
  }
  await assertPromptRefinerVnextOneShotActiveDeploymentForAdmission(
    tx, deploymentOptions
  );
  await assertPromptRefinerVnextOneShotPriceForAdmission(tx);
  return snapshot;
}

/** Content-free diagnostic only; never grants stage, run, or dispatch authority. */
export async function readPromptRefinerVnextOneShotStage(
  tx: Prisma.TransactionClient
): Promise<PromptRefinerVnextOneShotStageReadback> {
  const stage = await tx.promptRefinerVnextOneShotStage.findUnique({
    where: { id: STAGE_ID },
  });
  if (!stage) {
    return ABSENT_STAGE;
  }

  const slots = await tx.promptRefinerVnextOneShotSlot.findMany({
    where: { stageId: STAGE_ID },
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
    stageStatus,
    slotCount: slots.length,
    reservedSlots,
    consumedSlots,
    reservationShapeValid: slotsValid && stageStatus !== null &&
      stage.slotCount === PROMPT_REFINER_VNEXT_SLOT_COUNT &&
      slots.length === PROMPT_REFINER_VNEXT_SLOT_COUNT &&
      indices.size === PROMPT_REFINER_VNEXT_SLOT_COUNT &&
      reservedSlots + consumedSlots === PROMPT_REFINER_VNEXT_SLOT_COUNT,
    approvalAuditsValid: stageStatus !== null &&
      await promptRefinerVnextOneShotApprovalAuditsAreValid(tx, stage),
    dispatchAuthorized: false,
  });
}
