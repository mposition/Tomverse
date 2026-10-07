import "server-only";

import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import { prisma } from "@/lib/prisma";
import { promptRefinerVnextOneShotAuditReceiptIsValid } from
  "@/lib/promptRefinerVnextOneShotAuditReadback";
import {
  PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD,
  PROMPT_REFINER_VNEXT_SLOT_COUNT,
} from
  "@/lib/promptRefinerQualityEvaluationVnextExecutionContract";
import { V4_STAGE_ID, V5_STAGE_ID,
  type PromptRefinerRunnableStageId } from
  "@/lib/promptRefinerVnextOneShotV5Recovery";

const STAGE_ID = V4_STAGE_ID;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const STOP_ACTION = "prompt_refiner.vnext_one_shot.outcome_unknown";
const STOP_SUMMARY = "Stopped the one-shot run after an uncertain request outcome.";
type Reason = "timeout" | "provider_error" | "response_unverified";

type UnknownInput = Readonly<{
  stageId?: PromptRefinerRunnableStageId;
  requestId: string;
  slotIndex: number;
  runApprovalAuditLogId: string;
  slotConsumptionAuditLogId: string;
  reason: Reason;
}>;

const validInput = (input: UnknownInput): boolean =>
  (input.stageId === undefined || input.stageId === STAGE_ID ||
    input.stageId === V5_STAGE_ID) &&
  UUID.test(input.requestId) && Number.isInteger(input.slotIndex) &&
  input.slotIndex >= 0 && input.slotIndex < PROMPT_REFINER_VNEXT_SLOT_COUNT &&
  typeof input.runApprovalAuditLogId === "string" &&
  input.runApprovalAuditLogId.length > 0 && input.runApprovalAuditLogId.length <= 128 &&
  typeof input.slotConsumptionAuditLogId === "string" &&
  input.slotConsumptionAuditLogId.length > 0 &&
  input.slotConsumptionAuditLogId.length <= 128 &&
  (input.reason === "timeout" || input.reason === "provider_error" ||
    input.reason === "response_unverified");

const metadata = (input: UnknownInput) => ({
  requestId: input.requestId,
  slotIndex: input.slotIndex,
  runApprovalAuditLogId: input.runApprovalAuditLogId,
  slotConsumptionAuditLogId: input.slotConsumptionAuditLogId,
  reason: input.reason,
  reservedCostMicroUsd: PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD,
});

export async function verifyPromptRefinerVnextOneShotConsumedRequest(
  tx: Prisma.TransactionClient, input: UnknownInput,
): Promise<{ slotId: string }> {
  const stageId = input.stageId ?? STAGE_ID;
  const stage = await tx.promptRefinerVnextOneShotStage.findUnique({
    where: { id: stageId },
  });
  if (!stage || stage.runApprovalAuditLogId !== input.runApprovalAuditLogId) {
    throw new Error("vnext_one_shot_unknown_stage_mismatch");
  }
  const slot = await tx.promptRefinerVnextOneShotSlot.findUnique({
    where: { stageId_slotIndex: { stageId, slotIndex: input.slotIndex } },
  });
  if (!slot || slot.status !== "consumed" || slot.requestId !== input.requestId ||
      slot.consumedAt === null ||
      slot.reservedCostMicroUsd !== BigInt(PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD)) {
    throw new Error("vnext_one_shot_unknown_slot_mismatch");
  }
  const consumption = await tx.adminAuditLog.findUnique({
    where: { id: input.slotConsumptionAuditLogId },
  });
  if (!consumption || consumption.action !== "prompt_refiner.vnext_one_shot.slot_consumed" ||
      consumption.targetType !== "PromptRefinerVnextOneShotSlot" ||
      consumption.targetId !== slot.id ||
      consumption.summary !== "One-shot reservation consumed for one request" ||
      !await promptRefinerVnextOneShotAuditReceiptIsValid(tx, consumption)) {
    throw new Error("vnext_one_shot_unknown_consumption_audit_invalid");
  }
  const details = consumption.metadata;
  if (!details || typeof details !== "object" || Array.isArray(details) ||
      details.requestId !== input.requestId || details.slotIndex !== input.slotIndex ||
      details.runApprovalAuditLogId !== input.runApprovalAuditLogId ||
      details.reservedCostMicroUsd !== PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD ||
      details.systemActor !== "prompt-refiner-vnext-one-shot-runner") {
    throw new Error("vnext_one_shot_unknown_consumption_audit_mismatch");
  }
  return { slotId: slot.id };
}

/**
 * A12: stop the entire one-shot after an uncertain post-dispatch result.
 * The consumed reservation remains a tombstone. Recovery deliberately does
 * not recheck live deployment/price: drift must not prevent an emergency stop.
 * The receipt is a content-free entry in the existing hash-chained audit log.
 */
export async function stopPromptRefinerVnextOneShotUnknown(input: UnknownInput) {
  if (!validInput(input) || adminAuditIntegrityKeys(process.env).length === 0) {
    throw new Error("vnext_one_shot_unknown_input_invalid");
  }
  const stageId = input.stageId ?? STAGE_ID;
  return prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "PromptRefinerVnextOneShotStage"
      WHERE "id" = ${stageId} FOR NO KEY UPDATE NOWAIT
    `;
    if (rows.length !== 1 || rows[0]?.id !== stageId) {
      throw new Error("vnext_one_shot_unknown_stage_lock_unavailable");
    }
    const stage = await tx.promptRefinerVnextOneShotStage.findUnique({
      where: { id: stageId },
    });
    if (!stage || stage.status !== "run_approved") {
      throw new Error("vnext_one_shot_unknown_stage_not_running");
    }
    const consumed = await verifyPromptRefinerVnextOneShotConsumedRequest(tx, input);
    if (await tx.adminAuditLog.count({ where: {
      action: "prompt_refiner.vnext_one_shot.terminal_recorded",
      targetType: "PromptRefinerVnextOneShotSlot", targetId: consumed.slotId,
    } }) !== 0) {
      throw new Error("vnext_one_shot_unknown_terminal_already_recorded");
    }
    const stopAuditLogId = await writeSystemAuditLog({
      tx,
      systemActor: "prompt-refiner-vnext-one-shot-runner",
      action: STOP_ACTION,
      targetType: "PromptRefinerVnextOneShotStage",
      targetId: stageId,
      summary: STOP_SUMMARY,
      metadata: metadata(input),
    });
    const closed = await tx.promptRefinerVnextOneShotStage.updateMany({
      where: { id: stageId, status: "run_approved",
        runApprovalAuditLogId: input.runApprovalAuditLogId },
      data: { status: "closed" },
    });
    if (closed.count !== 1) throw new Error("vnext_one_shot_unknown_close_conflict");
    return Object.freeze({ stopAuditLogId, reservationHeld: true as const,
      humanReviewRequired: true as const, retryAuthorized: false as const,
      dispatchAuthorized: false as const });
  }, { maxWait: 5_000, timeout: 15_000 });
}

/** Read back the durable stop and its signed receipt before human disposition. */
export async function readPromptRefinerVnextOneShotUnknownStop(
  input: UnknownInput & { stopAuditLogId: string },
) {
  if (!validInput(input) || !input.stopAuditLogId ||
      adminAuditIntegrityKeys(process.env).length === 0) {
    throw new Error("vnext_one_shot_unknown_readback_invalid");
  }
  const stageId = input.stageId ?? STAGE_ID;
  return prisma.$transaction(async (tx) => {
    const stage = await tx.promptRefinerVnextOneShotStage.findUnique({
      where: { id: stageId },
    });
    if (stage?.status !== "closed") {
      throw new Error("vnext_one_shot_unknown_not_closed");
    }
    await verifyPromptRefinerVnextOneShotConsumedRequest(tx, input);
    const receipt = await tx.adminAuditLog.findUnique({
      where: { id: input.stopAuditLogId },
    });
    if (!receipt || receipt.action !== STOP_ACTION ||
        receipt.targetType !== "PromptRefinerVnextOneShotStage" ||
        receipt.targetId !== stageId || receipt.summary !== STOP_SUMMARY ||
        !await promptRefinerVnextOneShotAuditReceiptIsValid(tx, receipt)) {
      throw new Error("vnext_one_shot_unknown_receipt_invalid");
    }
    const actual = receipt.metadata;
    const expected = { ...metadata(input),
      systemActor: "prompt-refiner-vnext-one-shot-runner" };
    if (!actual || typeof actual !== "object" || Array.isArray(actual) ||
        Object.keys(actual).length !== Object.keys(expected).length ||
        Object.entries(expected).some(([key, value]) => actual[key] !== value)) {
      throw new Error("vnext_one_shot_unknown_receipt_mismatch");
    }
    return Object.freeze({ stopAuditLogId: receipt.id, reservationHeld: true as const,
      humanReviewRequired: true as const, retryAuthorized: false as const,
      dispatchAuthorized: false as const });
  }, { maxWait: 5_000, timeout: 15_000 });
}
