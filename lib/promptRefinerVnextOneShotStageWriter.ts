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
import { readPromptRefinerVnextOneShotOperationalShadow } from
  "@/lib/promptRefinerVnextOneShotOperationalShadow";
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
const FIRST_STAGE_ID = "prompt-refiner-vnext-one-shot-v1";
const LEGACY_STAGE_ID = "prompt-refiner-vnext-one-shot-v2";
const REPLACEMENT_STAGE_ID = "prompt-refiner-vnext-one-shot-v3";
const LEGACY_DEPLOYMENT_ID = "3565f671-c168-4d3d-8573-8e79126e1c63";
const LEGACY_COMMIT_SHA = "291e6d07f284e6333c34a3061dd94da77752aad9";
const LEGACY_STAGE_AUDIT_ID = "cmuuyx04a001d02qt3ald6khq";
const LEGACY_RUN_AUDIT_ID = "cmuuz1ltu002002qtnct9lojp";

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
    // B01 remains a separate signed gate. V3 copies the same source, runner
    // and price pins from V2; it cannot introduce a new preregistration.
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
    const firstReadback = await readPromptRefinerVnextOneShotStage(tx, FIRST_STAGE_ID);
    const legacy = await tx.promptRefinerVnextOneShotStage.findUnique({
      where: { id: LEGACY_STAGE_ID },
    });
    if (!legacy || legacyReadback.stageStatus !== "run_approved" ||
        !legacyReadback.reservationShapeValid ||
        !legacyReadback.approvalAuditsValid ||
        legacyReadback.reservedSlots !== PROMPT_REFINER_VNEXT_SLOT_COUNT ||
        legacyReadback.consumedSlots !== 0 ||
        !firstReadback.stagePresent || firstReadback.stageStatus !== "closed" ||
        !firstReadback.approvalAuditsValid ||
        firstReadback.reservedSlots !== PROMPT_REFINER_VNEXT_SLOT_COUNT ||
        firstReadback.consumedSlots !== 0 ||
        legacy.runtimeDeploymentId !== LEGACY_DEPLOYMENT_ID ||
        legacy.runtimeCommitSha !== LEGACY_COMMIT_SHA ||
        legacy.stageApprovalAuditLogId !== LEGACY_STAGE_AUDIT_ID ||
        legacy.runApprovalAuditLogId !== LEGACY_RUN_AUDIT_ID ||
        legacy.approvedBy !== approvedBy ||
        legacy.sourceCommitSha !== input.binding.sourceCommitSha ||
        legacy.sourceManifestDigest !== input.binding.sourceManifestDigest ||
        legacy.runnerDigest !== input.binding.runnerDigest ||
        legacy.manifestRoot !== input.binding.manifestRoot ||
        legacy.pricePinDigest !== input.binding.pricePinDigest ||
        legacy.runtimeDeploymentId === input.binding.runtimeDeploymentId ||
        legacy.runtimeCommitSha === input.binding.runtimeCommitSha) {
      throw new Error("vnext_one_shot_legacy_stage_not_replaceable");
    }
    const legacySlots = await tx.promptRefinerVnextOneShotSlot.findMany({
      where: { stageId: LEGACY_STAGE_ID },
      select: { id: true, slotIndex: true },
    });
    if (legacySlots.length !== PROMPT_REFINER_VNEXT_SLOT_COUNT ||
        legacySlots.some((slot) => slot.id !== `one-shot-v2-${slot.slotIndex}`)) {
      throw new Error("vnext_one_shot_legacy_stage_not_replaceable");
    }
    const shadow = await readPromptRefinerVnextOneShotOperationalShadow(tx, legacy);
    const forbiddenAudits = await tx.adminAuditLog.count({
      where: { OR: [
        { targetType: "PromptRefinerVnextOneShotStage", targetId: LEGACY_STAGE_ID,
          action: { in: ["prompt_refiner.vnext_one_shot.outcome_unknown",
            "prompt_refiner.vnext_one_shot.gate_evaluated",
            "prompt_refiner.vnext_one_shot.disposition_recorded",
            "prompt_refiner.vnext_one_shot.paid_dispatch_authorized"] } },
        { targetType: "PromptRefinerVnextOneShotSlot",
          action: "prompt_refiner.vnext_one_shot.slot_consumed",
          targetId: { startsWith: "one-shot-v2-" } },
      ] },
    });
    if (shadow.present || forbiddenAudits !== 0) {
      throw new Error("vnext_one_shot_legacy_stage_not_replaceable");
    }
    const supersededAuditLogId = await writeAdminAuditLog({
      tx, session: input.session, request: input.request,
      action: "prompt_refiner.vnext_one_shot.stage_superseded",
      targetType: "PromptRefinerVnextOneShotStage",
      targetId: LEGACY_STAGE_ID,
      summary: "Closed the zero-consumption run-approved one-shot stage for B06 recovery.",
      metadata: {
        replacementStageId: REPLACEMENT_STAGE_ID,
        previousStageApprovalAuditLogId: legacy.stageApprovalAuditLogId,
        previousRunApprovalAuditLogId: legacy.runApprovalAuditLogId,
        replacementStageApprovalAuditLogId: auditLogId,
      },
    });
    const closed = await tx.promptRefinerVnextOneShotStage.updateMany({
      where: {
        id: LEGACY_STAGE_ID, status: "run_approved",
        runApprovalAuditLogId: LEGACY_RUN_AUDIT_ID,
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
        id: `one-shot-v3-${slotIndex}`,
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
