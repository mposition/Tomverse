import "server-only";

import type { Session } from "next-auth";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import type { PromptRefinerVnextOneShotAuditBinding } from
  "@/lib/promptRefinerVnextOneShotAuditReadback";
import { readPromptRefinerVnextOneShotOperationalShadow } from
  "@/lib/promptRefinerVnextOneShotOperationalShadow";
import { PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST } from
  "@/lib/promptRefinerVnextOneShotPriceBinding";
import { assertPromptRefinerVnextOneShotPreregistrationForStage } from
  "@/lib/promptRefinerVnextOneShotPreregistration";
import { readPromptRefinerVnextOneShotStage } from
  "@/lib/promptRefinerVnextOneShotStageReadback";
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

const V1 = "prompt-refiner-vnext-one-shot-v1";
const V2 = "prompt-refiner-vnext-one-shot-v2";
const V3 = "prompt-refiner-vnext-one-shot-v3";
const V4 = "prompt-refiner-vnext-one-shot-v4";
const V3_DEPLOYMENT = "5e2245d9-17a8-46fe-b967-1ebd86806649";
const V3_COMMIT = "73e60ebd79869f16d82d914103122a0c3eaf0ad7";
const SLOT_COST = BigInt(PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD);
const RUN_COST = BigInt(PROMPT_REFINER_VNEXT_RUN_CEILING_MICRO_USD);

/** One audited replacement. All historical stages and slots remain intact. */
export async function createPromptRefinerVnextOneShotV4Stage(input: {
  session: Session;
  request: Request;
  binding: PromptRefinerVnextOneShotAuditBinding;
}) {
  if (input.binding.id !== V4 ||
      SLOT_COST * BigInt(PROMPT_REFINER_VNEXT_SLOT_COUNT) !== RUN_COST) {
    throw new Error("vnext_one_shot_v4_contract_invalid");
  }
  return prisma.$transaction(async (tx) => {
    // The stage-audit writer takes the shared chain lock before row locks.
    const { auditLogId, approvedBy } =
      await writePromptRefinerVnextOneShotStageApprovalAudit({ ...input, tx });
    const price = await readPromptRefinerVnextOneShotPrice(tx);
    if (input.binding.pricePinDigest !== PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST ||
        !price.pricePinMatchesRegistry || price.problems.length !== 0) {
      throw new Error("vnext_one_shot_v4_price_mismatch");
    }
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "PromptRefinerVnextOneShotStage"
      WHERE "id" = ${V3} FOR NO KEY UPDATE NOWAIT
    `;
    if (locked.length !== 1 || locked[0]?.id !== V3) {
      throw new Error("vnext_one_shot_v4_source_unavailable");
    }
    const previous = await tx.promptRefinerVnextOneShotStage.findUnique({
      where: { id: V3 },
    });
    const [first, second, third] = await Promise.all([
      readPromptRefinerVnextOneShotStage(tx, V1),
      readPromptRefinerVnextOneShotStage(tx, V2),
      readPromptRefinerVnextOneShotStage(tx, V3),
    ]);
    if (!previous || previous.status !== "run_approved" ||
        previous.runtimeDeploymentId !== V3_DEPLOYMENT ||
        previous.runtimeCommitSha !== V3_COMMIT ||
        previous.approvedBy !== approvedBy ||
        !first.approvalAuditsValid || first.stageStatus !== "closed" ||
        first.reservedSlots !== PROMPT_REFINER_VNEXT_SLOT_COUNT ||
        first.consumedSlots !== 0 ||
        !second.approvalAuditsValid || second.stageStatus !== "closed" ||
        second.reservedSlots !== PROMPT_REFINER_VNEXT_SLOT_COUNT ||
        second.consumedSlots !== 0 ||
        !third.approvalAuditsValid || !third.reservationShapeValid ||
        third.stageStatus !== "run_approved" ||
        third.reservedSlots !== PROMPT_REFINER_VNEXT_SLOT_COUNT ||
        third.consumedSlots !== 0 ||
        previous.sourceCommitSha !== input.binding.sourceCommitSha ||
        previous.sourceManifestDigest !== input.binding.sourceManifestDigest ||
        previous.manifestRoot !== input.binding.manifestRoot ||
        previous.pricePinDigest !== input.binding.pricePinDigest ||
        previous.perRequestCostMicroUsd !== SLOT_COST ||
        previous.costCeilingMicroUsd !== RUN_COST ||
        previous.slotCount !== PROMPT_REFINER_VNEXT_SLOT_COUNT ||
        previous.runnerDigest === input.binding.runnerDigest ||
        previous.runtimeDeploymentId === input.binding.runtimeDeploymentId ||
        previous.runtimeCommitSha === input.binding.runtimeCommitSha) {
      throw new Error("vnext_one_shot_v4_source_not_replaceable");
    }
    // B01 remains the immutable preregistration for the candidate and the
    // historical runner. V4's new runner is separately bound by stage audit.
    await assertPromptRefinerVnextOneShotPreregistrationForStage(tx, previous,
      input.session.user?.id ?? "");
    const slots = await tx.promptRefinerVnextOneShotSlot.findMany({
      where: { stageId: V3 }, select: { id: true, slotIndex: true },
    });
    if (slots.length !== PROMPT_REFINER_VNEXT_SLOT_COUNT ||
        slots.some((slot) => slot.id !== `one-shot-v3-${slot.slotIndex}`)) {
      throw new Error("vnext_one_shot_v4_source_not_replaceable");
    }
    const shadow = await readPromptRefinerVnextOneShotOperationalShadow(tx, previous);
    if (!shadow.valid || shadow.cacheWriteInputTokens !== 0 ||
        !shadow.shadowAuditLogId) {
      throw new Error("vnext_one_shot_v4_shadow_unavailable");
    }
    const forbidden = await tx.adminAuditLog.count({ where: { OR: [
      { targetType: "PromptRefinerVnextOneShotStage", targetId: V3,
        action: { in: ["prompt_refiner.vnext_one_shot.outcome_unknown",
          "prompt_refiner.vnext_one_shot.gate_evaluated",
          "prompt_refiner.vnext_one_shot.disposition_recorded",
          "prompt_refiner.vnext_one_shot.paid_dispatch_authorized"] } },
      { targetType: "PromptRefinerVnextOneShotSlot",
        targetId: { startsWith: "one-shot-v3-" },
        action: { in: ["prompt_refiner.vnext_one_shot.slot_consumed",
          "prompt_refiner.vnext_one_shot.terminal_recorded"] } },
    ] } });
    if (forbidden !== 0 || await tx.promptRefinerVnextOneShotStage.count({
      where: { id: V4 },
    }) !== 0) {
      throw new Error("vnext_one_shot_v4_historical_evidence_conflict");
    }
    const supersededAuditLogId = await writeAdminAuditLog({
      tx, session: input.session, request: input.request,
      action: "prompt_refiner.vnext_one_shot.stage_superseded",
      targetType: "PromptRefinerVnextOneShotStage", targetId: V3,
      summary: "Closed the zero-consumption B06 stage for B03O terminal recovery.",
      metadata: {
        replacementStageId: V4,
        previousStageApprovalAuditLogId: previous.stageApprovalAuditLogId,
        previousRunApprovalAuditLogId: previous.runApprovalAuditLogId,
        previousShadowAuditLogId: shadow.shadowAuditLogId,
        replacementStageApprovalAuditLogId: auditLogId,
      },
    });
    const closed = await tx.promptRefinerVnextOneShotStage.updateMany({
      where: { id: V3, status: "run_approved", supersededAuditLogId: null,
        runApprovalAuditLogId: previous.runApprovalAuditLogId },
      data: { status: "closed", supersededAuditLogId },
    });
    if (closed.count !== 1) throw new Error("vnext_one_shot_v4_close_conflict");
    await tx.promptRefinerVnextOneShotStage.create({ data: {
      id: V4, status: "staged",
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
        id: `one-shot-v4-${slotIndex}`, stageId: V4, slotIndex,
        reservedCostMicroUsd: SLOT_COST,
      })),
    });
    if (created.count !== PROMPT_REFINER_VNEXT_SLOT_COUNT) {
      throw new Error("vnext_one_shot_v4_reservations_incomplete");
    }
    return Object.freeze({ stageId: V4, stageApprovalAuditLogId: auditLogId,
      slotCount: created.count, dispatchAuthorized: false as const });
  }, { maxWait: 5_000, timeout: 15_000 });
}
