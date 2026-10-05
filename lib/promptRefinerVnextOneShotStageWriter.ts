import "server-only";

import type { Session } from "next-auth";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";
import { type PromptRefinerVnextOneShotAuditBinding } from
  "@/lib/promptRefinerVnextOneShotAuditReadback";
import { writePromptRefinerVnextOneShotStageApprovalAudit } from
  "@/lib/promptRefinerVnextOneShotStageApprovalAudit";
import { readPromptRefinerVnextOneShotPrice } from
  "@/lib/promptRefinerQualityEvaluationVnextOneShotPriceReadback";
import { assertPromptRefinerVnextOneShotPreregistrationForStage } from
  "@/lib/promptRefinerVnextOneShotPreregistration";
import { readPromptRefinerVnextOneShotStage } from
  "@/lib/promptRefinerVnextOneShotStageReadback";
import { PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST } from
  "@/lib/promptRefinerVnextOneShotPriceBinding";
import {
  PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD,
  PROMPT_REFINER_VNEXT_RUN_CEILING_MICRO_USD,
  PROMPT_REFINER_VNEXT_SLOT_COUNT,
} from "@/lib/promptRefinerQualityEvaluationVnextExecutionContract";

const SLOT_COST = BigInt(PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD);
const RUN_CEILING = BigInt(PROMPT_REFINER_VNEXT_RUN_CEILING_MICRO_USD);
const LEGACY_STAGE_ID = "prompt-refiner-vnext-one-shot-v1";
const REPLACEMENT_STAGE_ID = "prompt-refiner-vnext-one-shot-v2";

/**
 * A07 storage primitive. The owner-only route must reobserve source and
 * deployment before supplying the binding. Price is checked under a registry
 * SHARE lock in this transaction. This is not run approval or dispatch.
 */
export async function createPromptRefinerVnextOneShotStageWithSlots(input: {
  session: Session;
  request: Request;
  binding: PromptRefinerVnextOneShotAuditBinding;
}): Promise<Readonly<{
  stageId: string;
  stageApprovalAuditLogId: string;
  slotCount: number;
  dispatchAuthorized: false;
}>> {
  if (SLOT_COST * BigInt(PROMPT_REFINER_VNEXT_SLOT_COUNT) !== RUN_CEILING) {
    throw new Error("vnext_one_shot_reservation_contract_invalid");
  }
  return prisma.$transaction(async (tx) => {
    // The shared audit-chain lock is acquired before stage or slot row locks.
    const { auditLogId, approvedBy } =
      await writePromptRefinerVnextOneShotStageApprovalAudit({ ...input, tx });
    const price = await readPromptRefinerVnextOneShotPrice(tx);
    if (input.binding.pricePinDigest !== PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST ||
        !price.pricePinMatchesRegistry || price.problems.length !== 0) {
      throw new Error("vnext_one_shot_stage_price_mismatch");
    }
    await assertPromptRefinerVnextOneShotPreregistrationForStage(
      tx, input.binding, input.session.user?.id ?? "",
    );
    if (input.binding.id !== REPLACEMENT_STAGE_ID) {
      throw new Error("vnext_one_shot_replacement_id_invalid");
    }
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "PromptRefinerVnextOneShotStage"
      WHERE "id" = ${LEGACY_STAGE_ID} FOR NO KEY UPDATE NOWAIT
    `;
    if (locked.length !== 1 || locked[0]?.id !== LEGACY_STAGE_ID) {
      throw new Error("vnext_one_shot_legacy_stage_unavailable");
    }
    const legacyReadback = await readPromptRefinerVnextOneShotStage(
      tx, LEGACY_STAGE_ID
    );
    const legacy = await tx.promptRefinerVnextOneShotStage.findUnique({
      where: { id: LEGACY_STAGE_ID },
    });
    if (!legacy || legacyReadback.stageStatus !== "staged" ||
        !legacyReadback.reservationShapeValid ||
        !legacyReadback.approvalAuditsValid ||
        legacyReadback.reservedSlots !== PROMPT_REFINER_VNEXT_SLOT_COUNT ||
        legacyReadback.consumedSlots !== 0 ||
        legacy.runApprovalAuditLogId !== null ||
        legacy.approvedBy !== approvedBy ||
        legacy.sourceCommitSha !== input.binding.sourceCommitSha ||
        legacy.sourceManifestDigest !== input.binding.sourceManifestDigest ||
        legacy.runnerDigest !== input.binding.runnerDigest ||
        legacy.manifestRoot !== input.binding.manifestRoot ||
        legacy.pricePinDigest !== input.binding.pricePinDigest ||
        legacy.runtimeDeploymentId === input.binding.runtimeDeploymentId) {
      throw new Error("vnext_one_shot_legacy_stage_not_replaceable");
    }
    const supersededAuditLogId = await writeAdminAuditLog({
      tx, session: input.session, request: input.request,
      action: "prompt_refiner.vnext_one_shot.stage_superseded",
      targetType: "PromptRefinerVnextOneShotStage",
      targetId: LEGACY_STAGE_ID,
      summary: "Closed an unrun one-shot stage for exact-deployment replacement.",
      metadata: {
        replacementStageId: REPLACEMENT_STAGE_ID,
        previousStageApprovalAuditLogId: legacy.stageApprovalAuditLogId,
        replacementStageApprovalAuditLogId: auditLogId,
      },
    });
    const closed = await tx.promptRefinerVnextOneShotStage.updateMany({
      where: {
        id: LEGACY_STAGE_ID, status: "staged",
        runApprovalAuditLogId: null,
      },
      data: { status: "closed", supersededAuditLogId },
    });
    if (closed.count !== 1) {
      throw new Error("vnext_one_shot_legacy_stage_close_conflict");
    }
    await tx.promptRefinerVnextOneShotStage.create({
      data: {
        id: input.binding.id,
        status: "staged",
        sourceCommitSha: input.binding.sourceCommitSha,
        sourceManifestDigest: input.binding.sourceManifestDigest,
        runnerDigest: input.binding.runnerDigest,
        manifestRoot: input.binding.manifestRoot,
        runtimeDeploymentId: input.binding.runtimeDeploymentId,
        runtimeCommitSha: input.binding.runtimeCommitSha,
        pricePinDigest: input.binding.pricePinDigest,
        perRequestCostMicroUsd: SLOT_COST,
        slotCount: PROMPT_REFINER_VNEXT_SLOT_COUNT,
        costCeilingMicroUsd: RUN_CEILING,
        approvedBy,
        // The database trigger replaces this with the audit row's DB timestamp.
        approvedAt: new Date(0),
        stageApprovalAuditLogId: auditLogId,
      },
    });
    const created = await tx.promptRefinerVnextOneShotSlot.createMany({
      data: Array.from({ length: PROMPT_REFINER_VNEXT_SLOT_COUNT }, (_, slotIndex) => ({
          id: `one-shot-v2-${slotIndex}`,
        stageId: input.binding.id,
        slotIndex,
        reservedCostMicroUsd: SLOT_COST,
      })),
    });
    if (created.count !== PROMPT_REFINER_VNEXT_SLOT_COUNT) {
      throw new Error("vnext_one_shot_reservation_incomplete");
    }
    return Object.freeze({
      stageId: input.binding.id,
      stageApprovalAuditLogId: auditLogId,
      slotCount: created.count,
      dispatchAuthorized: false as const,
    });
  }, { maxWait: 5_000, timeout: 15_000 });
}
