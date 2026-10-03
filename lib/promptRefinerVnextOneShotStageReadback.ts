import "server-only";

import type { Prisma } from "@prisma/client";

import { promptRefinerVnextOneShotApprovalAuditsAreValid } from
  "@/lib/promptRefinerVnextOneShotAuditReadback";

const STAGE_ID = "prompt-refiner-vnext-one-shot-v1";
const SLOT_COST_MICRO_USD = BigInt(29_918);

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

/** Content-free diagnostic only; never grants stage, run, or dispatch authority. */
export async function readPromptRefinerVnextOneShotStage(
  tx: Prisma.TransactionClient
): Promise<PromptRefinerVnextOneShotStageReadback> {
  const stage = await tx.promptRefinerVnextOneShotStage.findUnique({
    where: { id: STAGE_ID },
  });
  if (!stage) {
    return Object.freeze({
      stagePresent: false,
      stageStatus: null,
      slotCount: 0,
      reservedSlots: 0,
      consumedSlots: 0,
      reservationShapeValid: false,
      approvalAuditsValid: false,
      dispatchAuthorized: false,
    });
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
      slot.slotIndex >= 80 || indices.has(slot.slotIndex) ||
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
    reservationShapeValid: slotsValid && stageStatus !== null && stage.slotCount === 80 &&
      slots.length === 80 && indices.size === 80 && reservedSlots + consumedSlots === 80,
    approvalAuditsValid: stageStatus !== null &&
      await promptRefinerVnextOneShotApprovalAuditsAreValid(tx, stage),
    dispatchAuthorized: false,
  });
}
