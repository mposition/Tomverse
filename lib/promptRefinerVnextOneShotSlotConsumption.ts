import "server-only";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import { prisma } from "@/lib/prisma";
import { readPromptRefinerVnextOneShotCandidateSource } from
  "@/lib/promptRefinerVnextOneShotCandidateSourceReadback";
import { assertPromptRefinerVnextOneShotCurrentPrice } from
  "@/lib/promptRefinerVnextOneShotPriceGuard";
import { lockAndReadPromptRefinerVnextOneShotStage } from
  "@/lib/promptRefinerVnextOneShotStageReadback";
import { readPromptRefinerVnextOneShotOperationalShadow } from
  "@/lib/promptRefinerVnextOneShotOperationalShadow";
import { readPromptRefinerVnextOneShotPaidAuthorization } from
  "@/lib/promptRefinerVnextOneShotPaidAuthorization";
import { assertPromptRefinerVnextOneShotTerminalsComplete } from
  "@/lib/promptRefinerVnextOneShotTerminalReceipt";
import {
  PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD,
  PROMPT_REFINER_VNEXT_RUN_CEILING_MICRO_USD,
  PROMPT_REFINER_VNEXT_SLOT_COUNT,
} from "@/lib/promptRefinerQualityEvaluationVnextExecutionContract";
import { V4_STAGE_ID, V5_STAGE_ID,
  type PromptRefinerRunnableStageId } from
  "@/lib/promptRefinerVnextOneShotV5Recovery";

const STAGE_ID = V4_STAGE_ID;
export const PROMPT_REFINER_VNEXT_PAID_GUARD_CAPABILITY =
  "v4-paid-terminal-guard-v1" as const;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const COST = BigInt(PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD);
const TOTAL = BigInt(PROMPT_REFINER_VNEXT_RUN_CEILING_MICRO_USD);

/**
 * A10: permanently bind one approved reservation to one request immediately
 * before a future dispatch. This does not call a provider or authorize one.
 * An uncertain result must be inspected by the owner, never blindly retried.
 */
export async function consumePromptRefinerVnextOneShotSlot(input: {
  stageId?: PromptRefinerRunnableStageId;
  requestId: string;
  slotIndex: number;
  runApprovalAuditLogId: string;
}): Promise<Readonly<{
  requestId: string;
  slotIndex: number;
  slotConsumptionAuditLogId: string;
  reservationConsumed: true;
  dispatchAuthorized: false;
}>> {
  const stageId = input.stageId ?? STAGE_ID;
  if (!UUID.test(input.requestId) ||
      (stageId !== STAGE_ID && stageId !== V5_STAGE_ID) ||
      !Number.isInteger(input.slotIndex) || input.slotIndex < 0 ||
      input.slotIndex >= PROMPT_REFINER_VNEXT_SLOT_COUNT ||
      typeof input.runApprovalAuditLogId !== "string" ||
      input.runApprovalAuditLogId.length < 1 ||
      input.runApprovalAuditLogId.length > 128 ||
      adminAuditIntegrityKeys(process.env).length === 0 ||
      COST * BigInt(PROMPT_REFINER_VNEXT_SLOT_COUNT) !== TOTAL) {
    throw new Error("vnext_one_shot_slot_request_invalid");
  }
  const root = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_ROOT;
  const runner = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST;
  if (!SHA256.test(root ?? "") || !SHA256.test(runner ?? "")) {
    throw new Error("vnext_one_shot_slot_custody_pin_unavailable");
  }

  return prisma.$transaction(async (tx) => {
    // Match the established audit -> stage -> registry -> slot lock order.
    await takeAuditChainLock(tx);
    const snapshot = await lockAndReadPromptRefinerVnextOneShotStage(tx, {}, stageId);
    if (!snapshot.stagePresent || snapshot.stageStatus !== "run_approved" ||
        !snapshot.reservationShapeValid || !snapshot.approvalAuditsValid ||
        snapshot.slotCount !== PROMPT_REFINER_VNEXT_SLOT_COUNT ||
        snapshot.reservedSlots < 1 ||
        snapshot.consumedSlots >= PROMPT_REFINER_VNEXT_SLOT_COUNT ||
        (stageId === V5_STAGE_ID && input.slotIndex !== snapshot.consumedSlots) ||
        snapshot.reservedSlots + snapshot.consumedSlots !== PROMPT_REFINER_VNEXT_SLOT_COUNT ||
        BigInt(snapshot.consumedSlots + 1) * COST > TOTAL) {
      throw new Error("vnext_one_shot_slot_reservation_unavailable");
    }
    await readPromptRefinerVnextOneShotCandidateSource(tx, stageId);
    await assertPromptRefinerVnextOneShotCurrentPrice(tx);
    const stage = await tx.promptRefinerVnextOneShotStage.findUnique({
      where: { id: stageId },
    });
    if (!stage || stage.status !== "run_approved" ||
        stage.runApprovalAuditLogId !== input.runApprovalAuditLogId ||
        stage.manifestRoot !== root || stage.runnerDigest !== runner ||
        stage.perRequestCostMicroUsd !== COST ||
        stage.costCeilingMicroUsd !== TOTAL ||
        stage.slotCount !== PROMPT_REFINER_VNEXT_SLOT_COUNT) {
      throw new Error("vnext_one_shot_slot_binding_mismatch");
    }
    const shadow = await readPromptRefinerVnextOneShotOperationalShadow(tx, stage);
    if (!shadow.valid) {
      throw new Error("vnext_one_shot_shadow_evidence_unavailable");
    }
    if (!shadow.shadowAuditLogId) {
      throw new Error("vnext_one_shot_shadow_evidence_unavailable");
    }
    const paid = await readPromptRefinerVnextOneShotPaidAuthorization(
      tx, stage, shadow.shadowAuditLogId,
    );
    if (!paid.valid) {
      throw new Error("vnext_one_shot_paid_authorization_unavailable");
    }
    await assertPromptRefinerVnextOneShotTerminalsComplete(tx, stageId);
    const slot = await tx.promptRefinerVnextOneShotSlot.findUnique({
      where: { stageId_slotIndex: { stageId, slotIndex: input.slotIndex } },
    });
    if (!slot || slot.status !== "reserved" || slot.requestId !== null ||
        slot.consumedAt !== null || slot.reservedCostMicroUsd !== COST) {
      throw new Error("vnext_one_shot_slot_already_consumed");
    }
    const slotConsumptionAuditLogId = await writeSystemAuditLog({
      tx,
      systemActor: "prompt-refiner-vnext-one-shot-runner",
      action: "prompt_refiner.vnext_one_shot.slot_consumed",
      targetType: "PromptRefinerVnextOneShotSlot",
      targetId: slot.id,
      summary: "One-shot reservation consumed for one request",
      metadata: {
        requestId: input.requestId,
        slotIndex: input.slotIndex,
        reservedCostMicroUsd: PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD,
        cumulativeReservedCostMicroUsd:
          (snapshot.consumedSlots + 1) * PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD,
        runApprovalAuditLogId: input.runApprovalAuditLogId,
      },
    });
    const updated = await tx.promptRefinerVnextOneShotSlot.updateMany({
      where: { id: slot.id, stageId, slotIndex: input.slotIndex,
        status: "reserved", requestId: null, consumedAt: null },
      data: { status: "consumed", requestId: input.requestId },
    });
    if (updated.count !== 1) {
      throw new Error("vnext_one_shot_slot_transition_conflict");
    }
    return Object.freeze({
      requestId: input.requestId,
      slotIndex: input.slotIndex,
      slotConsumptionAuditLogId,
      reservationConsumed: true as const,
      dispatchAuthorized: false as const,
    });
  }, { maxWait: 5_000, timeout: 15_000 });
}
